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
/** How far aim scatters, in world units, at full heat. */
const MAX_SCATTER = 0.85
/** A puck this close to a side wall is treated as cornered. */
const WALL_ZONE = 0.7

/** Small deterministic PRNG, so a match replays identically and tests are stable. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface HeatTuning {
  samePlace: number
  sameBeatTicks: number
  heatPerRepeat: number
  coolPerTick: number
  maxScatter: number
  /** Exponent on heat before it scatters aim. >1 keeps mild heat harmless. */
  curve: number
}

export const DEFAULT_HEAT: HeatTuning = {
  samePlace: SAME_PLACE,
  sameBeatTicks: SAME_BEAT_TICKS,
  heatPerRepeat: HEAT_PER_REPEAT,
  coolPerTick: COOL_PER_TICK,
  maxScatter: MAX_SCATTER,
  // Quadratic: mild heat is nearly harmless, only a real grind makes the AI
  // visibly wild. Chosen with the mean rally length held at baseline.
  curve: 2,
}

export class OpponentAI {
  /** 0 when composed, 1 when thoroughly stuck. Drives how much aim scatters. */
  heat = 0
  /** Strikes that landed in the same place as the one before, this match. */
  repeats = 0

  private lastStrike?: Vec & { tick: number }
  private tick = 0
  private rng: () => number

  private t: HeatTuning

  constructor(seed = 0x9e3779b9, tuning: Partial<HeatTuning> = {}) {
    this.rng = makeRng(seed)
    this.t = { ...DEFAULT_HEAT, ...tuning }
  }

  /** Clear per-rally state. Called on every faceoff, since the situation is new. */
  reset(): void {
    this.heat = 0
    this.lastStrike = undefined
  }


  /** Advance one tick and return where the opponent's paddle should go. */
  update(sim: BattleSim): Vec {
    this.tick++
    // Snap to exactly zero: repeated subtraction leaves a float residue that
    // would otherwise keep scattering aim, faintly, forever.
    const cooled = this.heat - this.t.coolPerTick
    this.heat = cooled < 1e-6 ? 0 : cooled

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

    // Scatter grows with heat. Clamping to the paddle's own half happens in the
    // sim, so an aim that strays off-table simply presses at the boundary.
    // Curved, so a touch of heat barely shifts aim and only a real grind makes
    // the AI visibly wild.
    const spread = Math.pow(this.heat, this.t.curve) * this.t.maxScatter
    return {
      x: target.x + (this.rng() * 2 - 1) * spread,
      y: target.y + (this.rng() * 2 - 1) * spread,
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
