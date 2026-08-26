import { describe, it, expect } from 'vitest'
import { BattleSim, type BattleConfig } from '../src/modes/battle/physics'
import { OpponentAI, baseTarget, isRepeating, isConfined, angleDelta } from '../src/modes/battle/ai'

const CFG: BattleConfig = {
  id: 'ai',
  opponent: { name: 'Test', ai: 'standard', roamDepth: 0.45, aggression: 0.5 },
  table: { width: 4.0, length: 7.0, goalWidth: 1.2 },
  puck: { radius: 0.12, maxSpeed: 7.0, friction: 0.995, restitution: 0.98 },
  paddle: { radius: 0.22, maxSpeed: 4.5 },
  rules: { mode: 'score', targetScore: 3 },
}
const DT = 1 / 60

const strike = (x: number, y: number, angle: number, tick: number) => ({ x, y, angle, tick })

describe('angleDelta', () => {
  it('measures the short way round', () => {
    expect(angleDelta(0.1, 0.2)).toBeCloseTo(0.1, 6)
    expect(angleDelta(-3.0, 3.0)).toBeCloseTo(Math.PI * 2 - 6, 6)
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 6)
  })
})

describe('isConfined', () => {
  const sim = new BattleSim(CFG)
  it('is true against a side wall', () => expect(isConfined(sim, 1.8, 1.0)).toBe(true))
  it('is true against the far end', () => expect(isConfined(sim, 0, 3.2)).toBe(true))
  it('is false in open play', () => expect(isConfined(sim, 0.2, 1.0)).toBe(false))
})

describe('isRepeating', () => {
  it('fires when enough recent strikes cluster near the latest one', () => {
    const s = [
      strike(1.7, 2.0, 1.0, 10), strike(1.75, 2.1, 1.2, 40),
      strike(1.72, 2.15, 0.9, 70), strike(1.78, 2.05, 1.1, 100),
    ]
    expect(isRepeating(s, 110)).toBe(true)
  })

  it('does not fire on strikes spread across the table', () => {
    const s = [
      strike(-1.5, 1.0, 1.0, 10), strike(0.4, 2.5, 2.0, 40),
      strike(1.6, 0.6, -1.0, 70), strike(-0.2, 3.0, 0.4, 100),
    ]
    expect(isRepeating(s, 110)).toBe(false)
  })

  it('does not fire when clustered strikes are spread far apart in time', () => {
    const s = [
      strike(1.7, 2.0, 1.0, 10), strike(1.75, 2.1, 1.2, 400),
      strike(1.72, 2.15, 0.9, 800), strike(1.78, 2.05, 1.1, 1200),
    ]
    expect(isRepeating(s, 1210)).toBe(false)
  })

  it('needs more than a couple of strikes', () => {
    expect(isRepeating([strike(1.7, 2, 1, 10), strike(1.7, 2, 1, 20)], 30)).toBe(false)
  })

  it('is false with no history', () => expect(isRepeating([], 100)).toBe(false))

  it('tolerates a stray hit without clearing the alarm', () => {
    // Density around the newest strike, so one outlier does not reset it.
    const s = [
      strike(1.7, 2.0, 1.0, 10), strike(-1.0, 0.2, 2.0, 30),
      strike(1.75, 2.1, 1.2, 50), strike(1.72, 2.15, 0.9, 70), strike(1.78, 2.05, 1.1, 90),
    ]
    expect(isRepeating(s, 100)).toBe(true)
  })
})

describe('OpponentAI', () => {
  it('matches the base behaviour until something repeats', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI()
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    expect(ai.update(sim)).toEqual(baseTarget(sim))
    expect(ai.breakout).toBe('none')
  })

  it('reset clears a breakout in progress', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI()
    for (let i = 0; i < 6; i++) {
      sim.lastOpponentHit = { x: 1.75, y: 2.1, vx: 1, vy: 1 }
      ai.update(sim)
    }
    expect(ai.breakouts).toBeGreaterThan(0)
    ai.reset()
    expect(ai.breakout).toBe('none')
    // `breakouts` is a match-level tally and deliberately survives a faceoff;
    // only the in-progress state is cleared. step() normally clears the hit
    // flag, so clear it by hand when driving update() directly.
    sim.lastOpponentHit = undefined
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    expect(ai.update(sim)).toEqual(baseTarget(sim))
  })

  it('does not trigger on repeated strikes in open play', () => {
    // Only a confined puck can be trapped; a rally in the middle is just a rally.
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI()
    for (let i = 0; i < 10; i++) {
      sim.lastOpponentHit = { x: 0.1, y: 1.5, vx: 1, vy: -1 }
      ai.update(sim)
    }
    expect(ai.breakouts).toBe(0)
  })

  it('never targets past the far end wall, where there is no room to get above the puck', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI()
    // Jam the puck into the far corner and force a breakout.
    Object.assign(sim.puck, { x: 1.8, y: 3.3, vx: 0, vy: 0 })
    for (let i = 0; i < 6; i++) {
      sim.lastOpponentHit = { x: 1.8, y: 3.3, vx: 0.3, vy: 0.1 }
      ai.update(sim)
    }
    const t = ai.update(sim)
    // Pressing from the sliver of space above only pins it harder, so the AI
    // must back off instead.
    expect(t.y).toBeLessThan(sim.puck.y)
  })
})

/**
 * The behaviour that actually matters: a puck worked into a corner must not
 * stay stuck there. Measured as the longest unbroken stretch spent pinned,
 * which is what reads as a trap — total time in the area does not.
 */
describe('corner grinds', () => {
  function longestPin(useAI: boolean, start: { x: number; y: number; vx: number; vy: number }): number {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI()
    Object.assign(sim.puck, start)
    Object.assign(sim.opponent, { x: start.x, y: start.y + 0.5 })
    let streak = 0
    let worst = 0
    for (let t = 0; t < 1200; t++) {
      // Stand-in player that returns everything, so the rally sustains and the
      // AI keeps getting the puck back — the condition a grind needs.
      sim.step(DT, { x: sim.puck.x, y: -2.6 }, useAI ? ai.update(sim) : baseTarget(sim))
      if (Math.abs(sim.puck.x) > 1.25 && sim.puck.y > 0.8) {
        streak++
        worst = Math.max(worst, streak)
      } else streak = 0
    }
    return worst
  }

  /** The same grid the recoil was tuned against, so the claim is not cherry-picked. */
  const STARTS = (() => {
    const out: { x: number; y: number; vx: number; vy: number }[] = []
    for (const x of [-1.8, -1.6, -1.3, 1.3, 1.6, 1.8]) {
      for (const y of [0.9, 1.6, 2.3, 3.0]) {
        for (const vx of [0.2, -0.6]) out.push({ x, y, vx, vy: 0.3 })
      }
    }
    return out
  })()

  it('markedly shortens the worst grind across a sweep of start states', () => {
    // Individual starts can go either way — this is a chaotic sim and the AI
    // trades a little average aggression for a much better worst case. The
    // claim worth holding is about the worst case, over the whole sweep.
    const base = Math.max(...STARTS.map((s) => longestPin(false, s)))
    const withAi = Math.max(...STARTS.map((s) => longestPin(true, s)))
    expect(base).toBeGreaterThan(120)          // the base really does trap
    expect(withAi).toBeLessThan(base * 0.75)   // and the AI cuts it substantially
  })

  it('keeps the average exchange roughly as it was', () => {
    const mean = (f: (s: typeof STARTS[number]) => number) =>
      STARTS.reduce((n, s) => n + f(s), 0) / STARTS.length
    const base = mean((s) => longestPin(false, s))
    const withAi = mean((s) => longestPin(true, s))
    // Breaking out costs a little tempo; it must not cost much.
    expect(withAi).toBeLessThan(base * 1.15)
  })
})
