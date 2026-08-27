import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Loop, type LoopFailure } from '../src/core/loop'
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

/**
 * Containing an exception that escapes a mode.
 *
 * The loop is the last place one can be caught, so it catches them. Not a
 * softening of strict-and-loud: the throw is still reported, and reported the
 * first time rather than the ten-thousandth. It is the difference between loud
 * and fatal — a designer whose editor dies has lost the thing that would have
 * told them what went wrong, along with everything they had not saved.
 */
describe('Loop containing failures', () => {
  let frame: ((now: number) => void) | undefined
  let now = 0
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, perf: g.performance, err: console.error }

  beforeEach(() => {
    now = 0
    frame = undefined
    g.requestAnimationFrame = (cb: (n: number) => void) => { frame = cb; return 1 }
    g.cancelAnimationFrame = () => { frame = undefined }
    g.performance = { now: () => now }
    console.error = () => {}
  })
  afterEach(() => {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
    g.performance = saved.perf
    console.error = saved.err
  })

  const advance = (seconds: number) => { now += seconds * 1000; frame?.(now) }

  function makeLoop(opts: { tickThrows?: () => boolean; renderThrows?: () => boolean } = {}) {
    const counts = { ticks: 0, renders: 0 }
    const failures: LoopFailure[] = []
    const loop = new Loop(
      () => { counts.ticks++; if (opts.tickThrows?.()) throw new Error('tick boom') },
      () => { counts.renders++; if (opts.renderThrows?.()) throw new Error('render boom') },
      (f) => failures.push(f),
    )
    loop.start()
    return { loop, counts, failures }
  }

  it('keeps running after a tick throws', () => {
    let boom = true
    const { loop, counts, failures } = makeLoop({ tickThrows: () => boom })
    advance(TICK_DT * 2)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.phase).toBe('tick')

    boom = false
    const before = counts.ticks
    advance(TICK_DT * 2)
    expect(counts.ticks).toBeGreaterThan(before)
    expect(loop.failureCount).toBe(1)
  })

  it('still renders the frame whose tick failed, because that is how it is seen', () => {
    const { counts } = makeLoop({ tickThrows: () => true })
    advance(TICK_DT)
    expect(counts.renders).toBe(1)
  })

  it('abandons the rest of a failed frame instead of re-running what just threw', () => {
    // Ten ticks' worth of time, one throw: the frame gives up rather than
    // failing ten times over.
    const { counts, failures } = makeLoop({ tickThrows: () => true })
    advance(TICK_DT * 10)
    expect(counts.ticks).toBe(1)
    expect(failures).toHaveLength(1)
  })

  it('drops the accumulated debt, so recovery does not fast-forward the sim', () => {
    let boom = true
    const { counts } = makeLoop({ tickThrows: () => boom })
    advance(TICK_DT * 10)      // fails on the first tick, owing nine more
    boom = false
    counts.ticks = 0
    advance(TICK_DT * 2)
    // Two ticks of time buys about two ticks. Had the debt survived it would
    // buy eleven, and the sim would jump through everything the game missed
    // while it was broken. Bounded rather than exact: the harness round-trips
    // the timestamp through milliseconds, which can land a hair under a tick.
    expect(counts.ticks).toBeGreaterThan(0)
    expect(counts.ticks).toBeLessThan(4)
  })

  it('keeps running after render throws', () => {
    let boom = true
    const { counts, failures } = makeLoop({ renderThrows: () => boom })
    advance(TICK_DT)
    expect(failures[0]!.phase).toBe('render')
    boom = false
    advance(TICK_DT)
    expect(counts.renders).toBe(2)
  })

  it('counts repeats of the same failure rather than treating them as new', () => {
    const { loop, failures } = makeLoop({ renderThrows: () => true })
    advance(TICK_DT)
    advance(TICK_DT)
    advance(TICK_DT)
    expect(failures.map((f) => f.count)).toEqual([1, 2, 3])
    expect(loop.failureCount).toBe(3)
  })

  it('logs a given failure once, however many frames it spans', () => {
    const logged: unknown[] = []
    console.error = (...args: unknown[]) => { logged.push(args) }
    makeLoop({ renderThrows: () => true })
    for (let i = 0; i < 5; i++) advance(TICK_DT)
    expect(logged).toHaveLength(1)
  })

  it('does not fire while paused, because nothing is ticking to fail', () => {
    const { loop, failures } = makeLoop({ tickThrows: () => true })
    loop.setPaused(true)
    advance(TICK_DT * 5)
    expect(failures.every((f) => f.phase !== 'tick')).toBe(true)
  })
})
