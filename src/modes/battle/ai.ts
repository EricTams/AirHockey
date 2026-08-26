import type { BattleSim, Vec } from './physics'
import { TICK_HZ } from '../../core/config'

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
/** Orbit radius, in world units, at full heat. */
const MAX_RADIUS = 0.85
/** Sweep rate in radians per tick at the moment heat first appears. */
const FREQ_MIN = 0.02
/** Sweep rate in radians per tick at full heat. */
const FREQ_MAX = 0.09
/**
 * Ceiling on how fast the orbit may sweep, as a fraction of the paddle's own
 * top speed. The paddle has to actually trace the path: if the target circles
 * faster than the paddle can travel, it never catches up and the orbit collapses
 * back into the noise it was meant to replace.
 */
const MAX_TANGENTIAL = 0.8
/**
 * Rate of the third oscillator, in radians per tick — fixed, independent of
 * heat, so it reads as an underlying rhythm rather than agitation.
 */
const RATIO_FREQ = 0.011
/** How far that oscillator swings the sin/cos frequency ratio either side of 1. */
const RATIO_SWING = 0.6
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
  /** Orbit radius at full heat. */
  maxRadius: number
  /** Exponent on heat for the radius. >1 keeps mild heat nearly harmless. */
  radiusCurve: number
  freqMin: number
  freqMax: number
  /**
   * Exponent on heat for the sweep rate. Deliberately separate from
   * radiusCurve: radius and frequency are what shape the motion's character,
   * and moving them in lockstep just makes a hot AI uniformly "more", rather
   * than differently, agitated.
   */
  freqCurve: number
  ratioFreq: number
  ratioSwing: number
}

export const DEFAULT_HEAT: HeatTuning = {
  samePlace: SAME_PLACE,
  sameBeatTicks: SAME_BEAT_TICKS,
  heatPerRepeat: HEAT_PER_REPEAT,
  coolPerTick: COOL_PER_TICK,
  maxRadius: MAX_RADIUS,
  radiusCurve: 2,
  freqMin: FREQ_MIN,
  freqMax: FREQ_MAX,
  freqCurve: 1,
  ratioFreq: RATIO_FREQ,
  ratioSwing: RATIO_SWING,
}

export class OpponentAI {
  /** 0 when composed, 1 when thoroughly stuck. Drives how much aim scatters. */
  heat = 0
  /** Strikes that landed in the same place as the one before, this match. */
  repeats = 0

  private lastStrike?: Vec & { tick: number }
  private tick = 0
  /**
   * Phases are integrated rather than computed as tick × frequency. Frequency
   * changes with heat, and multiplying elapsed ticks by a changing rate makes
   * the offset jump every time heat moves. Accumulating keeps the path
   * continuous however the rate drifts.
   */
  private phaseX = 0
  private phaseY = 0

  private t: HeatTuning
  /** Cached from the sim so the sweep cap can reference the paddle's top speed. */
  private cfg = { paddleSpeed: 9 }

  /** `seed` only sets the starting phase, so two opponents weave out of step. */
  constructor(seed = 0, tuning: Partial<HeatTuning> = {}) {
    this.phaseX = seed
    this.phaseY = seed * 1.7
    this.t = { ...DEFAULT_HEAT, ...tuning }
  }

  /** Clear per-rally state. Called on every faceoff, since the situation is new. */
  reset(): void {
    this.heat = 0
    this.repeats = 0
    this.lastStrike = undefined
  }


  /** Advance one tick and return where the opponent's paddle should go. */
  update(sim: BattleSim): Vec {
    this.tick++
    // Snap to exactly zero: repeated subtraction leaves a float residue that
    // would otherwise keep scattering aim, faintly, forever.
    const cooled = this.heat - this.t.coolPerTick
    this.heat = cooled < 1e-6 ? 0 : cooled

    // Leaning on a stationary puck heats up on its own, with no strike needed.
    if (sim.opponentContact && sim.speed < PIN_SPEED) {
      this.heat = Math.min(1, this.heat + HEAT_PER_PRESS_TICK)
    }

    const hit = sim.lastOpponentHit
    if (hit) {
      const last = this.lastStrike
      const samePlace = last && Math.hypot(hit.x - last.x, hit.y - last.y) < this.t.samePlace
      const sameBeat = last && this.tick - last.tick <= this.t.sameBeatTicks
      if (samePlace && sameBeat) {
        this.heat = Math.min(1, this.heat + this.t.heatPerRepeat)
        this.repeats++
      }
      this.lastStrike = { x: hit.x, y: hit.y, tick: this.tick }
    }

    const target = baseTarget(sim)
    if (this.heat <= 0) return target

    /*
     * Heat weaves the aim around where it would otherwise go, on a Lissajous
     * orbit rather than random jitter — a continuous path the paddle can
     * actually follow, instead of a fresh random point every tick that mostly
     * averages back out.
     *
     * Radius and sweep rate both grow with heat but on separate curves, and a
     * third fixed-rate oscillator drifts the ratio between the x and y sweep
     * rates. That keeps the figure open rather than retracing one closed loop,
     * so the AI keeps arriving from somewhere new instead of settling into
     * another repeatable line.
     *
     * Clamping to the paddle's own half happens in the sim, so an aim that
     * strays off-table simply presses at the boundary.
     */
    const heat = this.heat
    this.cfg.paddleSpeed = sim.cfg.paddle.maxSpeed
    const radius = Math.pow(heat, this.t.radiusCurve) * this.t.maxRadius
    let freq =
      this.t.freqMin + (this.t.freqMax - this.t.freqMin) * Math.pow(heat, this.t.freqCurve)
    // Keep the orbit followable: tangential speed is radius × freq × tick rate.
    if (radius > 1e-6) {
      const cap = (this.cfg.paddleSpeed * MAX_TANGENTIAL) / (radius * TICK_HZ)
      freq = Math.min(freq, cap)
    }
    const ratio = 1 + this.t.ratioSwing * Math.sin(this.tick * this.t.ratioFreq)

    this.phaseX += freq
    this.phaseY += freq * ratio

    return {
      x: target.x + radius * Math.cos(this.phaseX),
      y: target.y + radius * Math.sin(this.phaseY),
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
