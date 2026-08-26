import { describe, it, expect } from 'vitest'
import { BattleSim, type BattleConfig } from '../src/modes/battle/physics'
import { OpponentAI, baseTarget } from '../src/modes/battle/ai'

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
  it('starts cold and plays exactly the base behaviour', () => {
    const sim = new BattleSim(CFG)
    const ai = new OpponentAI(1)
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    expect(ai.heat).toBe(0)
    expect(ai.update(sim)).toEqual(baseTarget(sim))
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
    Object.assign(sim.puck, { x: 0.3, y: 1.2, vx: 0, vy: 0 })
    expect(ai.update(sim)).toEqual(baseTarget(sim))
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
    const t = ai.update(sim)
    expect(Math.abs(t.x)).toBeGreaterThan(CFG.table.width * 0.3)
    expect(ai.heat).toBe(0)
  })
})
