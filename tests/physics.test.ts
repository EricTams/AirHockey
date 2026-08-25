import { describe, it, expect } from 'vitest'
import { BattleSim, opponentTarget, type BattleConfig } from '../src/modes/battle/physics'

const CFG: BattleConfig = {
  table: { width: 4.0, length: 7.0, goalWidth: 1.2 },
  puck: { radius: 0.12, maxSpeed: 14.0, friction: 0.995, restitution: 0.98 },
  paddle: { radius: 0.22, maxSpeed: 9.0 },
  rules: { targetScore: 1 },
}
const DT = 1 / 60
/** Park a paddle far from the action so it cannot interfere with a test. */
const AWAY = { x: 10, y: -10 }
const AWAY_OPP = { x: 10, y: 10 }

describe('BattleSim walls', () => {
  it('reflects off a side wall and reverses only the crossing axis', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 1.7, y: 0, vx: 6, vy: 2 })
    for (let i = 0; i < 12; i++) sim.step(DT, AWAY, AWAY_OPP)
    expect(sim.puck.vx).toBeLessThan(0)      // bounced back
    expect(sim.puck.vy).toBeGreaterThan(0)   // along-table motion preserved
    expect(sim.puck.x).toBeLessThanOrEqual(CFG.table.width / 2 - CFG.puck.radius + 1e-6)
  })

  it('reflects off an end wall outside the goal mouth', () => {
    const sim = new BattleSim(CFG)
    // Well outside the 1.2-wide mouth.
    Object.assign(sim.puck, { x: 1.5, y: 3.0, vx: 0, vy: 8 })
    let scored = false
    for (let i = 0; i < 20; i++) if (sim.step(DT, AWAY, AWAY_OPP) !== 'none') scored = true
    expect(scored).toBe(false)
    expect(sim.puck.vy).toBeLessThan(0)
  })

  it('keeps the puck in bounds at full speed rather than tunnelling', () => {
    // The puck covers ~2 radii per tick at maxSpeed, which is exactly the case
    // a non-CCD engine tunnels through a thin wall.
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: 0, vx: 14, vy: 0 })
    for (let i = 0; i < 600; i++) {
      sim.step(DT, AWAY, AWAY_OPP)
      const limit = CFG.table.width / 2 - CFG.puck.radius + 1e-6
      expect(Math.abs(sim.puck.x)).toBeLessThanOrEqual(limit)
    }
  })

  it('never exceeds maxSpeed after a step', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: 0, vx: 500, vy: 500 })
    sim.step(DT, AWAY, AWAY_OPP)
    expect(sim.speed).toBeLessThanOrEqual(CFG.puck.maxSpeed + 1e-6)
  })
})

describe('BattleSim goals', () => {
  it('scores for the player when the puck passes the far mouth', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: 3.0, vx: 0, vy: 10 })
    let result: string = 'none'
    for (let i = 0; i < 30 && result === 'none'; i++) result = sim.step(DT, AWAY, AWAY_OPP)
    expect(result).toBe('playerScored')
  })

  it('scores for the opponent when the puck passes the near mouth', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: -3.0, vx: 0, vy: -10 })
    let result: string = 'none'
    for (let i = 0; i < 30 && result === 'none'; i++) result = sim.step(DT, AWAY, AWAY_OPP)
    expect(result).toBe('opponentScored')
  })
})

describe('BattleSim paddles', () => {
  it('confines each paddle to its own half', () => {
    const sim = new BattleSim(CFG)
    for (let i = 0; i < 120; i++) sim.step(DT, { x: 0, y: 5 }, { x: 0, y: -5 })
    expect(sim.player.y).toBeLessThanOrEqual(-CFG.paddle.radius + 1e-6)
    expect(sim.opponent.y).toBeGreaterThanOrEqual(CFG.paddle.radius - 1e-6)
  })

  it('imparts the paddle\'s motion to a resting puck', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: -1.0, vx: 0, vy: 0 })
    Object.assign(sim.player, { x: 0, y: -1.6, vx: 0, vy: 0 })
    for (let i = 0; i < 20; i++) sim.step(DT, { x: 0, y: -0.5 }, AWAY_OPP)
    expect(sim.puck.vy).toBeGreaterThan(0)   // driven up-table
  })

  it('bounces a puck off a stationary paddle without adding energy', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: -1.0, vx: 0, vy: -5 })
    Object.assign(sim.player, { x: 0, y: -1.6, vx: 0, vy: 0 })
    const before = sim.speed
    for (let i = 0; i < 10; i++) sim.step(DT, { x: 0, y: -1.6 }, AWAY_OPP)
    expect(sim.puck.vy).toBeGreaterThan(0)
    expect(sim.speed).toBeLessThanOrEqual(before)
  })
})

describe('opponentTarget', () => {
  it('contests a puck resting at centre', () => {
    // Regression: an earlier version only ever held its home line, so a centre
    // puck was never touched and the stuck-puck rule re-faceoffed forever.
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 0, y: 0, vx: 0, vy: 0 })
    const t = opponentTarget(sim)
    expect(t.y).toBeLessThan((CFG.table.length / 2) * 0.45)
  })

  it('actually moves a resting centre puck within a few seconds', () => {
    const sim = new BattleSim(CFG)
    sim.faceoff(0)
    for (let i = 0; i < 180; i++) sim.step(DT, AWAY, opponentTarget(sim))
    expect(sim.speed).toBeGreaterThan(0.2)
  })

  it('falls back to the home line when the puck is deep in the player half', () => {
    const sim = new BattleSim(CFG)
    Object.assign(sim.puck, { x: 1.0, y: -3.0, vx: 0, vy: 0 })
    const t = opponentTarget(sim)
    expect(t.y).toBeCloseTo((CFG.table.length / 2) * 0.45, 5)
  })
})
