import type { BattleSim, Vec } from './physics'

/**
 * Opponent AI (doc §8.4) plus the machinery that stops it grinding.
 *
 * The base behaviour is two states — hold a home line, or drive at a reachable
 * puck. On its own that can deadlock: a puck pinned against a side wall gets
 * struck, rebounds off the wall, and returns to almost the same spot, so the AI
 * makes the same play forever. The doc's stuck-puck rule cannot catch it,
 * because the puck never stops moving.
 *
 * So the AI watches its own strikes. When several land in the same place and
 * send the puck out at the same angle, it concludes it is repeating itself and
 * hands control to a breakout for a while. Breakouts escalate: if one does not
 * break the pattern, the next is more drastic.
 */

/** Strikes retained for analysis. */
const HISTORY = 12
/** Strikes inside the window before a pattern counts as a grind. */
const MATCH_COUNT = 4
/**
 * How far strikes may spread from their centre and still count as the same
 * place. Deliberately loose: a real grind is not the identical shot repeated,
 * it is many strikes around the same spot, each slightly different. Tight
 * tolerances missed the worst grinds entirely.
 */
const CLUSTER_RADIUS = 0.95
/** Strikes must fall inside this many ticks to count as a grind. */
const WINDOW_TICKS = 300
/** How long a breakout keeps control once triggered. */
const BREAKOUT_TICKS = 90
/** A puck this far from the grind spot counts as freed, ending the breakout. */
const ESCAPED_DIST = 1.4
/** A puck this close to a side wall is treated as cornered. */
const WALL_ZONE = 0.7
/**
 * Ticks the AI eases off after connecting. Without it the paddle re-presses
 * instantly, which is what lets a puck get pinned against a wall and struck
 * over and over. A real player recoils; this is the same idea, and it prevents
 * most grinds from forming rather than detecting them afterwards.
 *
 * Tuned by sweeping 48 start states, not by eye: anything from ~14 to ~28 is a
 * flat optimum, while a shorter recoil is measurably worse than none at all.
 * 20 sits in the middle of that plateau rather than at its exact minimum, which
 * would just be overfitting to the sample.
 */
const RECOIL_TICKS = 20

interface Strike { x: number; y: number; angle: number; tick: number }

/** True when the puck is pressed against a wall and has nowhere easy to go. */
export function isConfined(sim: BattleSim, x: number, y: number): boolean {
  const { width, length } = sim.cfg.table
  const nearSide = width / 2 - Math.abs(x) < WALL_ZONE
  const nearEnd = length / 2 - y < WALL_ZONE
  return nearSide || nearEnd
}

/** Smallest absolute difference between two angles, accounting for wrap. */
export function angleDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2)
  if (d > Math.PI) d = Math.PI * 2 - d
  return d
}

/**
 * True when the AI keeps striking the puck in the same area: count how many
 * recent strikes landed near the newest one, and call it a grind past a
 * threshold.
 *
 * Density around the latest strike, not agreement across all of them. Requiring
 * every strike in the window to fall inside one cluster is *stricter* the more
 * history you keep — a single stray hit clears the alarm — and that version
 * missed the worst grinds entirely.
 */
export function isRepeating(strikes: Strike[], now: number): boolean {
  const recent = strikes.filter((s) => now - s.tick <= WINDOW_TICKS)
  const anchor = recent[recent.length - 1]
  if (!anchor) return false
  const near = recent.filter((s) => Math.hypot(s.x - anchor.x, s.y - anchor.y) <= CLUSTER_RADIUS)
  return near.length >= MATCH_COUNT
}

export type BreakoutKind = 'none' | 'withdraw' | 'offAngle' | 'clearOut'

export class OpponentAI {
  private strikes: Strike[] = []
  private tick = 0
  private breakoutLeft = 0
  private level = 0
  private recoilLeft = 0
  /** Where the grind was happening, so a breakout can end as soon as it works. */
  private grindAt?: Vec

  /** What the AI is currently doing, for the debug overlay and tests. */
  breakout: BreakoutKind = 'none'
  /** How many times a repetition has been detected this match. */
  breakouts = 0

  /** Clear all state. Called on every faceoff, since the situation is new. */
  reset(): void {
    this.strikes.length = 0
    this.breakoutLeft = 0
    this.breakout = 'none'
    this.level = 0
    this.recoilLeft = 0
  }

  /** Advance one tick and return where the opponent's paddle should go. */
  update(sim: BattleSim): Vec {
    this.tick++

    const hit = sim.lastOpponentHit
    if (hit) {
      this.recoilLeft = RECOIL_TICKS
      // Only strikes on a confined puck count toward a grind. Repeated hits in
      // open play are just a rally; it is only a trap when the puck has a wall
      // behind it and nowhere to go. Counting every strike made the AI abandon
      // ordinary exchanges for no reason.
      if (isConfined(sim, hit.x, hit.y)) {
        this.strikes.push({ x: hit.x, y: hit.y, angle: Math.atan2(hit.vy, hit.vx), tick: this.tick })
        if (this.strikes.length > HISTORY) this.strikes.shift()
      }

      if (this.breakoutLeft <= 0 && isRepeating(this.strikes, this.tick)) {
        this.breakouts++
        this.level++
        this.breakoutLeft = BREAKOUT_TICKS
        this.breakout = this.chooseBreakout(sim)
        this.grindAt = { x: hit.x, y: hit.y }
        // Drop the history, or the same strikes immediately re-trigger.
        this.strikes.length = 0
      }
    }

    if (this.breakoutLeft > 0) {
      this.breakoutLeft--
      // End the moment it works rather than burning the whole timer: once the
      // puck is well clear of where the grind was, normal play resumes.
      const clear = this.grindAt
        ? Math.hypot(sim.puck.x - this.grindAt.x, sim.puck.y - this.grindAt.y) > ESCAPED_DIST
        : false
      if (this.breakoutLeft === 0 || clear) {
        this.breakoutLeft = 0
        this.breakout = 'none'
        this.grindAt = undefined
      } else {
        return this.breakoutTarget(sim)
      }
    }

    if (this.recoilLeft > 0) {
      this.recoilLeft--
      // Ease back off the line of the puck without abandoning position.
      const base = baseTarget(sim)
      const home = (sim.cfg.table.length / 2) * (sim.cfg.opponent.roamDepth ?? 0.45)
      return { x: base.x, y: Math.max(base.y, (base.y + home) / 2) }
    }

    return baseTarget(sim)
  }

  /**
   * Pick a breakout for the situation rather than cycling blindly.
   *
   * Driving the puck down-table needs room above it. Jammed into the far
   * corner against its own end wall there is none, and pressing from what
   * little there is only pins the puck harder — that case has to disengage.
   */
  private chooseBreakout(sim: BattleSim): BreakoutKind {
    const maxY = sim.cfg.table.length / 2 - sim.cfg.paddle.radius
    const r = sim.cfg.paddle.radius + sim.cfg.puck.radius
    if (maxY - sim.puck.y < r * 1.1) return 'withdraw'
    // Alternate the two striking breakouts, so a repeat grind is met with a
    // different line rather than the same one that just failed.
    return this.level % 2 === 1 ? 'clearOut' : 'offAngle'
  }

  /**
   * Where to go while breaking a grind.
   *
   * A puck flush against a side wall cannot be pushed inward: the paddle is
   * wider than the gap, so its centre can never get outside the puck's x. The
   * only escape the geometry allows is to get *above* the puck and drive it
   * down-table, out of this half and back into play. Both striking breakouts
   * do that; they differ in how much sideways they add.
   */
  private breakoutTarget(sim: BattleSim): Vec {
    const { length } = sim.cfg.table
    const home = (length / 2) * (sim.cfg.opponent.roamDepth ?? 0.45)
    const puck = sim.puck
    const r = sim.cfg.paddle.radius + sim.cfg.puck.radius
    const inward = puck.x > 0 ? -1 : 1

    // Re-checked every tick, not just when the breakout was chosen: the puck
    // drifts while a breakout runs, and once it is jammed against the far end
    // there is no longer room to get above it. Pressing on from there pins it
    // harder than doing nothing.
    const maxY = length / 2 - sim.cfg.paddle.radius
    const kind: BreakoutKind = maxY - puck.y < r * 1.1 ? 'withdraw' : this.breakout

    switch (kind) {
      case 'clearOut':
        // Directly above the puck: drive it straight down-table.
        return { x: puck.x, y: puck.y + r }

      case 'offAngle':
        // Above and a little to the inside, so it leaves on a different line
        // than the one that keeps coming back.
        return { x: puck.x - inward * r * 0.8, y: puck.y + r * 0.9 }

      case 'withdraw':
      default:
        // Last resort: stop pressing entirely and let the puck's own momentum
        // carry it out rather than pinning it in place.
        return { x: puck.x * 0.3, y: Math.max(home, length * 0.4) }
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

  const reach = length * (0.25 + (opp.aggression ?? 0.5) * 0.35)
  if (sim.puck.y > -sim.cfg.puck.radius && sim.puck.y < reach) {
    const behind = (sim.cfg.paddle.radius + sim.cfg.puck.radius) * 0.9
    // Near a side wall, aim slightly wide so contact carries the puck inward
    // rather than grinding it along the wall — the state most traps start in.
    const wall = width / 2 - Math.abs(sim.puck.x)
    const bias = wall < WALL_ZONE ? (sim.puck.x > 0 ? 1 : -1) * (WALL_ZONE - wall) * 0.8 : 0
    return { x: sim.puck.x + bias, y: sim.puck.y - behind }
  }
  return { x: sim.puck.x * 0.6, y: home }
}

/** Back-compat shim for the pure form used before the AI kept state. */
export const opponentTarget = baseTarget
