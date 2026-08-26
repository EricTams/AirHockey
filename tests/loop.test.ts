import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Loop } from '../src/core/loop'
import { TICK_DT } from '../src/core/config'

/**
 * The editor suspends the game rather than drawing over a running one, so
 * "paused" has to mean no logic advances at all — while frames keep being
 * presented, because the editor still needs a picture.
 *
 * Driven through a hand-cranked requestAnimationFrame so the assertions are
 * about tick counts rather than wall-clock.
 */
describe('Loop pausing', () => {
  let frame: ((now: number) => void) | undefined
  let now = 0
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, perf: g.performance }

  beforeEach(() => {
    now = 0
    frame = undefined
    g.requestAnimationFrame = (cb: (n: number) => void) => { frame = cb; return 1 }
    g.cancelAnimationFrame = () => { frame = undefined }
    g.performance = { now: () => now }
  })
  afterEach(() => {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
    g.performance = saved.perf
  })

  /** Advance wall-clock by `seconds` and run one animation frame. */
  function advance(seconds: number): void {
    now += seconds * 1000
    frame?.(now)
  }

  function makeLoop() {
    const counts = { ticks: 0, renders: 0 }
    const loop = new Loop(() => { counts.ticks++ }, () => { counts.renders++ })
    loop.start()
    return { loop, counts }
  }

  it('ticks at the fixed rate while running', () => {
    const { counts } = makeLoop()
    advance(TICK_DT * 10)
    expect(counts.ticks).toBe(10)
    expect(counts.renders).toBe(1)
  })

  it('runs no logic at all while paused, but keeps rendering', () => {
    const { loop, counts } = makeLoop()
    advance(TICK_DT * 3)
    const ticked = counts.ticks

    loop.setPaused(true)
    for (let i = 0; i < 5; i++) advance(TICK_DT * 4)

    expect(counts.ticks).toBe(ticked)        // not one further tick
    expect(loop.ticksLastFrame).toBe(0)
    expect(counts.renders).toBe(6)           // frames still presented
  })

  it('does not fast-forward through the time spent paused', () => {
    const { loop, counts } = makeLoop()
    loop.setPaused(true)
    advance(10)                              // ten seconds inside the editor
    const ticked = counts.ticks

    loop.setPaused(false)
    for (let i = 0; i < 60; i++) advance(TICK_DT)   // a second of normal frames
    // Roughly a second of ticks. Had the paused time been banked, the
    // accumulator would still be draining it 11 seconds later.
    const after = counts.ticks - ticked
    expect(after).toBeGreaterThan(50)
    expect(after).toBeLessThan(70)
  })

  it('reports its state and ignores a repeated request', () => {
    const { loop } = makeLoop()
    expect(loop.isPaused).toBe(false)
    loop.setPaused(true)
    loop.setPaused(true)
    expect(loop.isPaused).toBe(true)
    loop.setPaused(false)
    expect(loop.isPaused).toBe(false)
  })
})
