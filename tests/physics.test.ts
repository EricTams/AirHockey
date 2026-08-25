import { describe, it, expect } from 'vitest'
import { BattleSim, opponentTarget, type BattleConfig } from '../src/modes/battle/physics'

const CFG: BattleConfig = {
  id: 'test',
  opponent: { name: 'Test', ai: 'standard', roamDepth: 0.45, aggression: 0.5 },
  table: { width: 4.0, length: 7.0, goalWidth: 1.2 },
  puck: { radius: 0.12, maxSpeed: 14.0, friction: 0.995, restitution: 0.98 },
  paddle: { radius: 0.22, maxSpeed: 9.0 },
  rules: { mode: 'score', targetScore: 1 },
}
/** Build a variant config with extra obstacles or overrides. */
const withObstacles = (obstacles: BattleConfig['table']['obstacles']): BattleConfig =>
  ({ ...CFG, table: { ...CFG.table, obstacles } })
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

describe('pipe obstacles', () => {
  const PIPES = withObstacles([
    { kind: 'pipe', id: 'a', x: -1.4, y: -1.0, radius: 0.34, exit: 'b', turn: 90 },
    { kind: 'pipe', id: 'b', x: 1.4, y: 1.0, radius: 0.34, exit: 'a', turn: -90 },
  ])

  it('moves the puck to the paired mouth', () => {
    const sim = new BattleSim(PIPES)
    Object.assign(sim.puck, { x: -1.4, y: -1.6, vx: 0, vy: 6 })
    // Check on the tick it emerges: afterwards it travels on, away from the mouth.
    let hopped = false
    for (let i = 0; i < 40 && !hopped; i++) {
      sim.step(DT, AWAY, AWAY_OPP)
      hopped = sim.lastPipeUsed === 'b'
    }
    expect(hopped).toBe(true)
    expect(Math.hypot(sim.puck.x - 1.4, sim.puck.y - 1.0)).toBeLessThan(0.6)
  })

  it('rotates the exit velocity by the bend angle', () => {
    const sim = new BattleSim(PIPES)
    // Travelling +y into pipe a, whose bend is +90 degrees: +y turns to -x.
    Object.assign(sim.puck, { x: -1.4, y: -1.6, vx: 0, vy: 6 })
    for (let i = 0; i < 20; i++) sim.step(DT, AWAY, AWAY_OPP)
    expect(sim.puck.vx).toBeLessThan(-1)
    expect(Math.abs(sim.puck.vy)).toBeLessThan(Math.abs(sim.puck.vx))
  })

  it('preserves speed through the bend, give or take friction', () => {
    // Also pins friction to a per-tick coefficient: applying it per sub-step
    // compounded it 4x and bled the puck dry far too quickly.
    const sim = new BattleSim(PIPES)
    Object.assign(sim.puck, { x: -1.4, y: -1.6, vx: 0, vy: 6 })
    for (let i = 0; i < 20; i++) sim.step(DT, AWAY, AWAY_OPP)
    expect(sim.speed).toBeGreaterThan(6 * Math.pow(0.995, 20) - 0.15)
    expect(sim.speed).toBeLessThanOrEqual(6.0)
  })

  it('does not ping-pong between the two mouths', () => {
    // The exit sits inside the partner's radius conceptually, so without an
    // ejection offset and a cooldown the puck would teleport every substep.
    const sim = new BattleSim(PIPES)
    Object.assign(sim.puck, { x: -1.4, y: -1.6, vx: 0, vy: 6 })
    let hops = 0
    for (let i = 0; i < 120; i++) {
      sim.step(DT, AWAY, AWAY_OPP)
      if (sim.lastPipeUsed) hops++
    }
    expect(hops).toBeLessThanOrEqual(4)
  })
})

describe('wing obstacle', () => {
  const WING = withObstacles([{ kind: 'wing', x: 0, y: 3.15, radius: 0.42, hits: 3 }])

  it('starts lodged with its full hit count', () => {
    const sim = new BattleSim(WING)
    expect(sim.wingHits).toBe(3)
    expect(sim.wingDislodged).toBe(false)
  })

  it('blocks the goal while it is still lodged', () => {
    const sim = new BattleSim(WING)
    Object.assign(sim.puck, { x: 0, y: 2.0, vx: 0, vy: 9 })
    let scored = false
    for (let i = 0; i < 40; i++) if (sim.step(DT, AWAY, AWAY_OPP) === 'playerScored') scored = true
    expect(scored).toBe(false)
  })

  it('takes one hit per contact rather than draining on a single pass', () => {
    const sim = new BattleSim(WING)
    Object.assign(sim.puck, { x: 0, y: 2.0, vx: 0, vy: 9 })
    sim.step(DT, AWAY, AWAY_OPP)
    sim.step(DT, AWAY, AWAY_OPP)
    expect(sim.wingHits).toBeGreaterThanOrEqual(2)
  })

  /** Fire the puck at the wing once and report what the sim returned. */
  const strike = (sim: BattleSim): string => {
    // The faceoff parks the opponent paddle at (0, 2.45), overlapping the
    // puck's spawn, so shove it into the corner or it bats the puck away
    // before it ever reaches the wing.
    Object.assign(sim.opponent, { x: 1.78, y: 3.28, vx: 0, vy: 0 })
    // Far enough out that the flight exceeds the wing's hit cooldown, which is
    // what real play does; firing from point blank re-strikes inside it.
    Object.assign(sim.puck, { x: 0, y: 1.5, vx: 0, vy: 9 })
    const before = sim.wingHits
    for (let i = 0; i < 60; i++) {
      const r = sim.step(DT, AWAY, { x: 1.78, y: 3.28 })
      if (r === 'dislodged') return 'dislodged'
      if (sim.wingHits < before) return 'hit'
      // Nothing defends the near goal, so a rebound eventually scores against
      // the player. Only report it once the wing is out of the way.
      if (r === 'playerScored') return 'playerScored'
    }
    return 'none'
  }

  it('reports dislodged exactly once, on the final hit', () => {
    const sim = new BattleSim(WING)
    expect(strike(sim)).toBe('hit')
    expect(sim.wingHits).toBe(2)
    expect(strike(sim)).toBe('hit')
    expect(sim.wingHits).toBe(1)
    expect(strike(sim)).toBe('dislodged')
    expect(sim.wingHits).toBe(0)
    expect(sim.wingDislodged).toBe(true)
    // Already loose: further strikes pass through and score, never re-dislodge.
    expect(strike(sim)).toBe('playerScored')
  })

  it('opens the goal once dislodged', () => {
    const sim = new BattleSim(WING)
    while (!sim.wingDislodged) strike(sim)
    expect(strike(sim)).toBe('playerScored')
  })
})

describe('block obstacles', () => {
  const BLOCKS = withObstacles([{ kind: 'block', x: 0, y: 0, halfW: 0.45, halfH: 0.16 }])

  it('deflects a puck driven straight into a face', () => {
    const sim = new BattleSim(BLOCKS)
    Object.assign(sim.puck, { x: 0, y: -1.0, vx: 0, vy: 8 })
    for (let i = 0; i < 20; i++) sim.step(DT, AWAY, AWAY_OPP)
    expect(sim.puck.vy).toBeLessThan(0)
    expect(sim.puck.y).toBeLessThan(0)
  })

  it('never leaves the puck stuck inside the block', () => {
    const sim = new BattleSim(BLOCKS)
    Object.assign(sim.puck, { x: 0, y: 0, vx: 3, vy: 2 })
    for (let i = 0; i < 300; i++) {
      sim.step(DT, AWAY, AWAY_OPP)
      const inside = Math.abs(sim.puck.x) < 0.45 && Math.abs(sim.puck.y) < 0.16
      expect(inside).toBe(false)
    }
  })
})

describe('inert opponents', () => {
  it('stands aside instead of defending', () => {
    const sim = new BattleSim({ ...CFG, opponent: { name: 'Gravy', ai: 'inert' } })
    Object.assign(sim.puck, { x: 0, y: 1.0, vx: 0, vy: 0 })
    const t = opponentTarget(sim)
    expect(Math.abs(t.x)).toBeGreaterThan(CFG.table.width * 0.3)
  })
})
