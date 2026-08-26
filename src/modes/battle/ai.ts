import type { BattleSim, Vec } from './physics'

/**
 * Opponent AI (doc §8.4), plus a heat mechanic that stops it grinding.
 *
 * The base behaviour is two states — hold a home line, or drive at a reachable
 * puck. On its own that can deadlock: a puck pinned against a wall gets struck,
 * rebounds, and comes back to almost the same spot, so the AI makes the same
 * play forever. Doc §8.3's stuck-puck rule cannot catch it, because the puck
 * never stops moving.
 *
 * So the AI notices when it keeps striking the puck in nearly the same place
 * and builds *heat*. Heat scatters where it aims, by an amount proportional to
 * how hot it is, and bleeds away once play moves on. A grind therefore breaks
 * itself: the longer one runs the less precisely the AI plays, until something
 * knocks the pattern loose and the heat cools off.
 *
 * A scalar that feeds back into aim beats a ladder of scripted escape moves.
 * There is no geometry to special-case, no escalation to sequence, and no state
 * machine to get stuck in — and a little scatter reads as an opponent losing
 * patience rather than a bug.
 */

/** Strikes within this distance of the last one count as the same place. */
const SAME_PLACE = 0.45
/**
 * And they must land within this many ticks of each other. Proximity alone is
 * not enough: in an ordinary rally the AI naturally strikes around the same
 * area, just seconds apart. What marks a grind is contact that is both close
 * *and* rapid. Without this the AI ran hot permanently and played worse.
 */
const SAME_BEAT_TICKS = 50
/**
 * Heat added per repeat. Must clearly outpace what cools off between strikes:
 * a grind lands contact every 20-40 ticks, so at 0.15 gain against 0.12 decay
 * heat crept to only ~0.3 even under deliberate provocation, which is barely
 * any scatter at all. This nets roughly +0.17 per strike during a real grind.
 */
const HEAT_PER_REPEAT = 0.25
/** Heat shed per tick: full heat cools over about seven seconds of clean play. */
const COOL_PER_TICK = 0.0025
/**
 * Most the acted-on heat may move per tick, chasing the target heat.
 *
 * Detection is inherently steppy — a repeat lands a chunk of heat in a single
 * tick — and feeding that straight into position makes the paddle lurch. So
 * detection writes a *target*, and what actually drives the sway follows it at
 * a bounded rate. At this rate a full swing takes about a second.
 */
const HEAT_SLEW = 0.017
/**
 * One sway curve. Every value is a constant, so the curve is a smooth function
 * of time for as long as the match runs. Variety comes from blending two of
 * them, not from modulating one — modulating a rate feeds a moving value into
 * an accumulated phase, and that is what makes position lurch.
 *
 * Rates are per axis and deliberately not equal: at a 1:1 ratio a Lissajous
 * figure degenerates to a circle or a straight line. The two curves also use
 * different ratios, so their blend never settles into a repeating path.
 */
interface Sway {
  /** Radians per tick, across the table. */
  rateX: number
  /** Radians per tick, along the table. */
  rateY: number
  /** Amplitude across the table, in world units. */
  ampX: number
  /** Amplitude along the table, in world units. */
  ampY: number
}

/** At rest: flat, because a cold opponent should not sway at all. */
const CALM: Sway = { rateX: 0.010, rateY: 0.015, ampX: 0, ampY: 0 }

/**
 * Thoroughly cooked. 3:4 rates, and half as much sway along the table as
 * across it: the AI's half is only 3.5 deep and the paddle is clamped out of
 * the player's half, so longitudinal room is much tighter than lateral.
 *
 * Lateral amplitude is one paddle diameter, which is the natural unit here —
 * the sway should read as the paddle wandering about its own width, not
 * roaming a quarter of the table.
 */
const AGITATED: Sway = { rateX: 0.018, rateY: 0.024, ampX: 0.44, ampY: 0.22 }

/**
 * How far ahead the returned point sits when the target is further off than
 * this. Never further than the target itself: a point permanently beyond the
 * paddle can never be reached, so the paddle overshoots and reverses every
 * tick instead of settling.
 */
const LOOKAHEAD = 0.5
/** A puck this close to a side wall is treated as cornered. */
const WALL_ZONE = 0.7
/**
 * Heat per tick while the AI is simply leaning on a near-motionless puck.
 *
 * A puck wedged into a corner never gets *struck* — it rests against the paddle
 * with no relative motion, so no impulse is applied and no repeat is recorded.
 * Heat would sit at zero while the puck stayed pinned for seconds. Pressing is
 * therefore its own source of heat, and about a second of it saturates.
 */
const HEAT_PER_PRESS_TICK = 0.017
/** Puck speed below which contact counts as pinning rather than play. */
const PIN_SPEED = 1.2

export interface HeatTuning {
  samePlace: number
  sameBeatTicks: number
  heatPerRepeat: number
  coolPerTick: number
  calm: Sway
  agitated: Sway
  heatSlew: number
}

export const DEFAULT_HEAT: HeatTuning = {
  samePlace: SAME_PLACE,
  sameBeatTicks: SAME_BEAT_TICKS,
  heatPerRepeat: HEAT_PER_REPEAT,
  coolPerTick: COOL_PER_TICK,
  calm: CALM,
  agitated: AGITATED,
  heatSlew: HEAT_SLEW,
}

export class OpponentAI {
  /**
   * What the detector currently thinks: 0 when composed, 1 when thoroughly
   * stuck. Steps around freely, and nothing reads it for motion.
   */
  targetHeat = 0
  /**
   * What actually drives the sway. Follows targetHeat at a bounded rate, so the
   * value position depends on is always continuous.
   */
  heat = 0
  /** Strikes that landed in the same place as the one before, this match. */
  repeats = 0

  private lastStrike?: Vec & { tick: number }
  private tick = 0
  /** Running phase of each curve, one pair per curve, advanced at fixed rates. */
  private calmX = 0
  private calmY = 0
  private hotX = 0
  private hotY = 0

  private t: HeatTuning

  /** `seed` only sets the starting phase, so two opponents weave out of step. */
  constructor(seed = 0, tuning: Partial<HeatTuning> = {}) {
    // Seed only offsets the starting phases, so two opponents weave out of step.
    this.calmX = seed
    this.calmY = seed * 1.7
    this.hotX = seed * 2.3
    this.hotY = seed * 3.1
    this.t = { ...DEFAULT_HEAT, ...tuning }
  }

  /** Clear per-rally state. Called on every faceoff, since the situation is new. */
  reset(): void {
    this.targetHeat = 0
    this.heat = 0
    this.repeats = 0
    this.lastStrike = undefined
  }


  /** Advance one tick and return where the opponent's paddle should go. */
  update(sim: BattleSim): Vec {
    this.tick++
    // Snap to exactly zero: repeated subtraction leaves a float residue that
    // would otherwise keep swaying the aim, faintly, forever.
    const cooled = this.targetHeat - this.t.coolPerTick
    this.targetHeat = cooled < 1e-6 ? 0 : cooled

    // Leaning on a stationary puck heats up on its own, with no strike needed.
    if (sim.opponentContact && sim.speed < PIN_SPEED) {
      this.targetHeat = Math.min(1, this.targetHeat + HEAT_PER_PRESS_TICK)
    }

    const hit = sim.lastOpponentHit
    if (hit) {
      const last = this.lastStrike
      const samePlace = last && Math.hypot(hit.x - last.x, hit.y - last.y) < this.t.samePlace
      const sameBeat = last && this.tick - last.tick <= this.t.sameBeatTicks
      if (samePlace && sameBeat) {
        this.targetHeat = Math.min(1, this.targetHeat + this.t.heatPerRepeat)
        this.repeats++
      }
      this.lastStrike = { x: hit.x, y: hit.y, tick: this.tick }
    }

    const target = baseTarget(sim)
    const me = sim.opponent

    // Ease the acted-on heat toward the target. Everything downstream reads
    // this one, so smoothing here covers every consumer at once.
    const gap = this.targetHeat - this.heat
    this.heat += Math.abs(gap) <= this.t.heatSlew ? gap : Math.sign(gap) * this.t.heatSlew

    // Both curves run at their own fixed rates all the time, whether or not
    // heat is using them, so neither jumps when the blend picks it up.
    const { calm, agitated } = this.t
    this.calmX += calm.rateX
    this.calmY += calm.rateY
    this.hotX += agitated.rateX
    this.hotY += agitated.rateY

    /*
     * Displace the goal by the sway, then aim at that displaced point. Always:
     * the calm curve has no amplitude, so at zero heat the blend contributes
     * nothing and no separate gate is needed.
     *
     * Heat enters here once, through the blend, and nowhere else. It used to
     * scale the sway three times over — through the blend, through a share of
     * the heading, and quadratically as a result — so an amplitude of 0.9 in
     * the config reached the paddle as 0.36, and only at the very hottest.
     *
     * Blending the two curves' outputs keeps this smooth: each is a smooth
     * function of time for all time, so any weighting of them is smooth too.
     *
     * The displacement must happen before the arrival check below. Measuring
     * arrival against the *undisplaced* target means that once the paddle parks
     * on it there is no distance left to travel, so the sway gets multiplied by
     * zero — computed every tick and never once acted on.
     */
    const b = this.heat
    const goalX =
      target.x + (1 - b) * calm.ampX * Math.cos(this.calmX) + b * agitated.ampX * Math.cos(this.hotX)
    const goalY =
      target.y + (1 - b) * calm.ampY * Math.sin(this.calmY) + b * agitated.ampY * Math.sin(this.hotY)

    const dx = goalX - me.x
    const dy = goalY - me.y
    const dist = Math.hypot(dx, dy)
    if (dist < 1e-6) return { x: me.x, y: me.y }

    // Never aim past the goal: a point permanently beyond the paddle can never
    // be reached, so it overshoots and reverses every tick instead of settling.
    const reach = Math.min(LOOKAHEAD, dist)
    return {
      x: me.x + (dx / dist) * reach,
      y: me.y + (dy / dist) * reach,
    }
  }
}

/**
 * Doc §8.4 base behaviour:
 *
 *   Attack  the puck is on the opponent's side and within reach, so drive at a
 *           point just past it toward the player's goal.
 *   Defend  otherwise, hold a home line and track the puck's x.
 *
 * Deterministic rather than probability-gated, so it is testable and cannot
 * deadlock on its own. An earlier version only ever held the home line, which
 * meant a puck resting at centre was never contested at all.
 */
export function baseTarget(sim: BattleSim): Vec {
  const { width, length } = sim.cfg.table
  const opp = sim.cfg.opponent
  const home = (length / 2) * (opp.roamDepth ?? 0.45)

  // An inert opponent stands well aside rather than defending at all.
  if (opp.ai === 'inert') return { x: -width * 0.36, y: length * 0.42 }

  const puck = sim.puck
  const contact = sim.cfg.paddle.radius + sim.cfg.puck.radius

  // Puck is in the player's half: hold a line and track its x. A bolder
  // opponent waits further forward.
  if (puck.y <= -sim.cfg.puck.radius) {
    return { x: puck.x * 0.6, y: home * (1 - (opp.aggression ?? 0.5) * 0.35) }
  }

  const maxPaddleY = length / 2 - sim.cfg.paddle.radius
  const sideGap = width / 2 - Math.abs(puck.x)

  if (sideGap < WALL_ZONE) {
    /*
     * The puck is hugging a side wall, and the paddle is wider than the gap it
     * leaves: the paddle's centre stops a full paddle-radius from the wall,
     * which is *inside* the band the puck can occupy. So the paddle can never
     * get between puck and wall, and any attempt to push the puck inward
     * instead presses it against the wall and holds it there.
     *
     * The clearing move is therefore along the wall, not into it: sit directly
     * up-table of the puck and drive it back down toward open play.
     */
    const abeam = puck.y + contact
    if (abeam <= maxPaddleY) return { x: puck.x, y: abeam }

    /*
     * Jammed right into the corner, with the AI's own end wall behind it. No
     * reachable paddle position clears it now — every one of them pushes the
     * puck further into the angle — and pressing is what holds it there. So
     * disengage and let it come out on its own.
     */
    return { x: puck.x * 0.5, y: home }
  }

  // Open play: drive through the puck toward the player's goal.
  return { x: puck.x, y: puck.y - contact * 0.9 }
}

/** Back-compat shim for the pure form used before the AI kept state. */
export const opponentTarget = baseTarget
