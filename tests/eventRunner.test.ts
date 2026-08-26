import { describe, it, expect } from 'vitest'
import { EventRunner, type Request } from '../src/world/eventRunner'
import { GameState } from '../src/world/gameState'
import type { Command } from '../src/world/event'

/**
 * The interpreter runs across ticks of a fixed-timestep loop, so what these
 * check is mostly suspension and resumption: that an event which waits gives
 * the frame back, and picks up exactly where it left off.
 */

/** Drive a runner to completion, collecting every request it makes. */
function run(commands: Command[], state = new GameState(), answers: boolean[] = []) {
  const runner = new EventRunner('e', commands, state)
  const requests: Request[] = []
  let ticks = 0
  while (!runner.isDone && ticks++ < 5000) {
    const step = runner.step()
    if (step.kind === 'suspend') {
      requests.push(step.request)
      runner.resume({ won: answers.shift() })
    }
  }
  return { requests, ticks, state, runner }
}

describe('EventRunner', () => {
  it('runs a flat list and finishes', () => {
    const { state, requests } = run([
      { setFlag: 'a', to: true },
      { setVar: 'n', to: 5 },
      { addVar: 'n', by: 2 },
    ])
    expect(state.flag('a')).toBe(true)
    expect(state.variable('n')).toBe(7)
    expect(requests).toEqual([])
  })

  it('suspends on dialogue and carries on afterwards', () => {
    const { requests, state } = run([
      { say: [{ text: 'hello' }] },
      { setFlag: 'spoke', to: true },
    ])
    expect(requests).toEqual([{ kind: 'say', lines: [{ text: 'hello' }] }])
    expect(state.flag('spoke')).toBe(true)
  })

  it('does nothing while suspended until it is resumed', () => {
    const state = new GameState()
    const runner = new EventRunner('e', [
      { say: [{ text: 'hi' }] },
      { setFlag: 'after', to: true },
    ], state)

    expect(runner.step()).toEqual({ kind: 'suspend', request: { kind: 'say', lines: [{ text: 'hi' }] } })
    // Ticking while the dialogue is on screen must not run the rest.
    runner.step()
    runner.step()
    expect(state.flag('after')).toBe(false)
    runner.resume()
    runner.step()
    expect(state.flag('after')).toBe(true)
  })

  it('counts a wait down in frames, one per tick', () => {
    const state = new GameState()
    const runner = new EventRunner('e', [{ wait: 3 }, { setFlag: 'done', to: true }], state)
    runner.step()                       // consumes the wait command
    expect(state.flag('done')).toBe(false)
    runner.step(); runner.step()
    expect(state.flag('done')).toBe(false)
    runner.step()
    expect(state.flag('done')).toBe(true)
  })

  it('takes the then branch when the conditions hold', () => {
    const state = new GameState()
    state.setFlag('open', true)
    run([{ if: [{ flag: 'open', is: true }], then: [{ setVar: 'x', to: 1 }], else: [{ setVar: 'x', to: 2 }] }], state)
    expect(state.variable('x')).toBe(1)
  })

  it('takes the else branch when they do not', () => {
    const state = new GameState()
    run([{ if: [{ flag: 'open', is: true }], then: [{ setVar: 'x', to: 1 }], else: [{ setVar: 'x', to: 2 }] }], state)
    expect(state.variable('x')).toBe(2)
  })

  it('carries on past an if with no else', () => {
    const state = new GameState()
    run([
      { if: [{ flag: 'never', is: true }], then: [{ setVar: 'x', to: 1 }] },
      { setVar: 'after', to: 9 },
    ], state)
    expect(state.variable('x')).toBe(0)
    expect(state.variable('after')).toBe(9)
  })

  it('repeats a body a fixed number of times', () => {
    const { state } = run([{ repeat: 4, do: [{ addVar: 'n', by: 1 }] }])
    expect(state.variable('n')).toBe(4)
  })

  it('runs a repeat of zero not at all', () => {
    const { state } = run([{ repeat: 0, do: [{ addVar: 'n', by: 1 }] }])
    expect(state.variable('n')).toBe(0)
  })

  it('tests a while before the first pass, not after', () => {
    const { state } = run([{ while: [{ var: 'n', op: '>', value: 0 }], do: [{ addVar: 'n', by: -1 }] }])
    expect(state.variable('n')).toBe(0)
  })

  it('loops a while until its condition stops holding', () => {
    const state = new GameState()
    state.setVariable('n', 5)
    run([{ while: [{ var: 'n', op: '>', value: 0 }], do: [{ addVar: 'n', by: -1 }] }], state)
    expect(state.variable('n')).toBe(0)
  })

  it('breaks out of the innermost loop only', () => {
    const state = new GameState()
    run([{
      repeat: 3,
      do: [
        { addVar: 'outer', by: 1 },
        { repeat: 10, do: [{ addVar: 'inner', by: 1 }, { break: true }] },
      ],
    }], state)
    expect(state.variable('outer')).toBe(3)
    expect(state.variable('inner')).toBe(3)
  })

  it('stops the whole event, not just the current list', () => {
    const state = new GameState()
    run([
      { repeat: 5, do: [{ addVar: 'n', by: 1 }, { stop: true }] },
      { setFlag: 'never', to: true },
    ], state)
    expect(state.variable('n')).toBe(1)
    expect(state.flag('never')).toBe(false)
  })

  it('runs the won branch of a battle', () => {
    const { state, requests } = run(
      [{ battle: 'b.json', won: [{ setFlag: 'beat', to: true }], lost: [{ setFlag: 'lost', to: true }] }],
      new GameState(), [true],
    )
    expect(requests).toEqual([{ kind: 'battle', path: 'b.json' }])
    expect(state.flag('beat')).toBe(true)
    expect(state.flag('lost')).toBe(false)
  })

  it('runs the lost branch, and carries on afterwards either way', () => {
    const { state } = run(
      [
        { battle: 'b.json', won: [{ setFlag: 'beat', to: true }], lost: [{ setFlag: 'lost', to: true }] },
        { setFlag: 'after', to: true },
      ],
      new GameState(), [false],
    )
    expect(state.flag('lost')).toBe(true)
    expect(state.flag('after')).toBe(true)
  })

  it('accepts a battle with no branches at all', () => {
    const { state } = run([{ battle: 'b.json' }, { setFlag: 'after', to: true }], new GameState(), [true])
    expect(state.flag('after')).toBe(true)
  })

  it('yields rather than hanging on a loop that never ends', () => {
    // A designer's bug must not lock the tab. It keeps running, visibly.
    const state = new GameState()
    state.setFlag('spin', true)
    const runner = new EventRunner('e', [
      { while: [{ flag: 'spin', is: true }], do: [{ addVar: 'n', by: 1 }] },
    ], state)
    expect(runner.step()).toEqual({ kind: 'running' })
    expect(runner.isDone).toBe(false)
    expect(state.variable('n')).toBeGreaterThan(0)
  })

  it('can be cancelled mid-run', () => {
    const state = new GameState()
    const runner = new EventRunner('e', [{ say: [{ text: 'x' }] }, { setFlag: 'after', to: true }], state)
    runner.step()
    runner.cancel()
    expect(runner.isDone).toBe(true)
    runner.step()
    expect(state.flag('after')).toBe(false)
  })

  it('reports movement as a request for the host to carry out', () => {
    const { requests } = run([{ face: 'left' }, { walk: ['up', 'up'] }])
    expect(requests).toEqual([
      { kind: 'face', facing: 'left' },
      { kind: 'walk', steps: ['up', 'up'] },
    ])
  })
})

describe('GameState', () => {
  it('answers for names nobody has set', () => {
    // So a page can be written before the page that sets its flag.
    const state = new GameState()
    expect(state.flag('unheard-of')).toBe(false)
    expect(state.variable('unheard-of')).toBe(0)
  })

  it('compares variables with every operator', () => {
    const state = new GameState()
    state.setVariable('n', 5)
    expect(state.test({ var: 'n', op: '=', value: 5 })).toBe(true)
    expect(state.test({ var: 'n', op: '!=', value: 5 })).toBe(false)
    expect(state.test({ var: 'n', op: '<', value: 6 })).toBe(true)
    expect(state.test({ var: 'n', op: '<=', value: 5 })).toBe(true)
    expect(state.test({ var: 'n', op: '>', value: 5 })).toBe(false)
    expect(state.test({ var: 'n', op: '>=', value: 5 })).toBe(true)
  })

  it('treats an empty condition list as satisfied', () => {
    // That is what a page with no conditions means: the fallback.
    expect(new GameState().testAll([])).toBe(true)
  })

  it('bumps its revision only when something actually changes', () => {
    const state = new GameState()
    const before = state.revision
    state.setFlag('a', false)
    expect(state.revision).toBe(before)
    state.setFlag('a', true)
    expect(state.revision).toBeGreaterThan(before)
  })
})
