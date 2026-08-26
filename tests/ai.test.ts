import { describe, it, expect } from 'vitest'
import { BattleSim, type BattleConfig } from '../src/modes/battle/physics'
import { OpponentAI, baseTarget } from '../src/modes/battle/ai'

/**
 * The AI returns a heading and a speed, not a destination: unit direction from
 * where the paddle is now toward the target it handed back.
 */
function heading(ai: OpponentAI, sim: BattleSim) {
  const t = ai.update(sim)
  const dx = t.x - sim.opponent.x
  const dy = t.y - sim.opponent.y
  const d = Math.hypot(dx, dy) || 1
  return { x: dx / d, y: dy / d, speed: t.speed ?? 0 }
}

/** Unit direction from the paddle toward an arbitrary point. */
function toward(sim: BattleSim, p: { x: number; y: number }) {
  const dx = p.x - sim.opponent.x
  const dy = p.y - sim.opponent.y
  const d = Math.hypot(dx, dy) || 1
  return { x: dx / d, y: dy / d }
}

const CFG: BattleConfig = {
  id: 'ai',
  opponent: { name: 'Test', ai: 'standard', roamDepth: 0.45, aggression: 0.5 },
  table: { width: 4.0, length: 7.0, goalWidth: 1.2 },
  puck: { radius: 0.12, maxSpeed: 7.0, friction: 0.995, restitution: 0.98 },
  paddle: { radius: 0.22, maxSpeed: 4.5 },
  rules: { mode: 'score', targetScore: 3 },
}

/** Drive update() directly, standing in for what step() would report. */
function strike(ai: OpponentAI, sim: BattleSim, x: number, y: number, gap = 1) {
  for (let i = 1; i < gap; i++) {
    sim.lastOpponentHit = undefined
    ai.update(sim)
  }
  sim.lastOpponentHit = { x, y, vx: 1, vy: 1 }
  const t = ai.update(sim)
  sim.lastOpponentHit = undefined
  return t
}

describe('heat', () => {
  it('starts cold and heads straight for the base target', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    expect(ai.heat).toBe(0)
    const h = heading(ai, sim)
    const want = toward(sim, baseTarget(sim))
    expect(h.x).toBeCloseTo(want.x, 6)
    expect(h.y).toBeCloseTo(want.y, 6)
  })

  it('moves at full speed whether cold or hot', () => {
    // The 60/40 weights blend the heading only. Heat redirects the paddle; it
    // must never slow it down, or a hot opponent is simply a worse one.
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    expect(heading(ai, sim).speed).toBeCloseTo(CFG.paddle.maxSpeed, 6)

    for (let i = 0; i < 40; i++) strike(ai, sim, 1.75, 2.1, 5)
    expect(ai.heat).toBeGreaterThan(0.5)
    for (let i = 0; i < 60; i++) {
      expect(ai.update(sim).speed!).toBeCloseTo(CFG.paddle.maxSpeed, 6)
    }
  })

  it('heat bends the heading away from straight pursuit', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 1.0, y: 1.5, vx: 0, vy: 0 })

    const cold = new OpponentAI(1)
    const want = toward(sim, baseTarget(sim))
    const c = heading(cold, sim)
    expect(c.x).toBeCloseTo(want.x, 6)

    const hot = new OpponentAI(1)
    for (let i = 0; i < 40; i++) strike(hot, sim, 1.75, 2.1, 5)
    let maxBend = 0
    for (let i = 0; i < 60; i++) {
      const h = heading(hot, sim)
      maxBend = Math.max(maxBend, Math.hypot(h.x - want.x, h.y - want.y))
    }
    expect(maxBend).toBeGreaterThan(0.2)
  })

  it('builds when strikes land in the same place in quick succession', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    for (let i = 0; i < 4; i++) strike(ai, sim, 1.75, 2.1, 10)
    expect(ai.heat).toBeGreaterThan(0)
    expect(ai.repeats).toBeGreaterThan(0)
  })

  it('stays cold when strikes are spread across the table', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    const spots: [number, number][] = [[-1.6, 1.0], [0.5, 2.6], [1.7, 0.9], [-0.3, 3.0]]
    for (const [x, y] of spots) strike(ai, sim, x, y, 10)
    expect(ai.heat).toBe(0)
  })

  it('stays cold when strikes are in the same place but far apart in time', () => {
    // An ordinary rally returns to the same area every few seconds. Only
    // contact that is close *and* rapid is a grind.
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    for (let i = 0; i < 4; i++) strike(ai, sim, 1.75, 2.1, 200)
    expect(ai.heat).toBe(0)
  })

  it('cools back down over clean play', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    for (let i = 0; i < 6; i++) strike(ai, sim, 1.75, 2.1, 10)
    const hot = ai.heat
    expect(hot).toBeGreaterThan(0)
    for (let i = 0; i < 400; i++) ai.update(sim)
    expect(ai.heat).toBe(0)
  })

  it('never exceeds full heat however long the grind runs', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    for (let i = 0; i < 60; i++) strike(ai, sim, 1.75, 2.1, 5)
    expect(ai.heat).toBeLessThanOrEqual(1)
  })

  it('scatters aim once hot, and more the hotter it gets', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 1.75, y: 2.1, vx: 0, vy: 0 })

    const spreadAfter = (grinds: number) => {
      const ai = new OpponentAI(42)
      for (let i = 0; i < grinds; i++) strike(ai, sim, 1.75, 2.1, 5)
      const base = baseTarget(sim)
      let worst = 0
      for (let i = 0; i < 40; i++) {
        const t = ai.update(sim)
        worst = Math.max(worst, Math.hypot(t.x - base.x, t.y - base.y))
      }
      return worst
    }

    const mild = spreadAfter(3)
    const cooked = spreadAfter(12)
    expect(cooked).toBeGreaterThan(mild)
  })

  it('reset returns it to cold, base behaviour', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    for (let i = 0; i < 8; i++) strike(ai, sim, 1.75, 2.1, 5)
    expect(ai.heat).toBeGreaterThan(0)
    ai.reset()
    expect(ai.heat).toBe(0)
    sim.lastOpponentHit = undefined
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    const h = heading(ai, sim)
    const want = toward(sim, baseTarget(sim))
    expect(h.x).toBeCloseTo(want.x, 6)
    expect(h.y).toBeCloseTo(want.y, 6)
  })

  it('is deterministic for a given seed, so matches replay identically', () => {
    const run = () => {
      const sim = new BattleSim(CFG)
      const ai = new OpponentAI(7)
      Object.assign(sim.puck, { x: 1.75, y: 2.1, vx: 0, vy: 0 })
      for (let i = 0; i < 10; i++) strike(ai, sim, 1.75, 2.1, 5)
      return [ai.update(sim), ai.update(sim), ai.update(sim)]
    }
    expect(run()).toEqual(run())
  })

  it('different seeds scatter differently', () => {
    const run = (seed: number) => {
      const sim = new BattleSim(CFG)
      const ai = new OpponentAI(seed)
      Object.assign(sim.puck, { x: 1.75, y: 2.1, vx: 0, vy: 0 })
      for (let i = 0; i < 10; i++) strike(ai, sim, 1.75, 2.1, 5)
      return ai.update(sim)
    }
    expect(run(1)).not.toEqual(run(2))
  })
})

describe('inert opponents', () => {
  it('stand aside and never heat up', () => {
    const sim = new BattleSim({ ...CFG, opponent: { name: 'Gravy', ai: 'inert' } })
    const ai = new OpponentAI(1)
    const want = toward(sim, baseTarget(sim))
    const h = heading(ai, sim)
    expect(h.x).toBeCloseTo(want.x, 6)
    expect(h.y).toBeCloseTo(want.y, 6)
    expect(ai.heat).toBe(0)
  })
})
