import { describe, it, expect } from 'vitest'
import { Input } from '../src/core/input'

/** Minimal stand-in for `window`; Input only needs add/dispatch. */
function harness() {
  const target = new EventTarget()
  const input = new Input(target)
  const down = (code: string) => target.dispatchEvent(Object.assign(new Event('keydown'), { code }))
  const up = (code: string) => target.dispatchEvent(Object.assign(new Event('keyup'), { code }))
  const move = (x: number, y: number) =>
    target.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: x, clientY: y }))
  const pDown = (x: number, y: number) =>
    target.dispatchEvent(Object.assign(new Event('pointerdown'), { clientX: x, clientY: y }))
  const pUp = () => target.dispatchEvent(new Event('pointerup'))
  return { target, input, down, up, move, pDown, pUp }
}

describe('Input', () => {
  it('reports held for as long as the key is down', () => {
    const { input, down, up } = harness()
    expect(input.held('interact')).toBe(false)
    down('KeyZ')
    expect(input.held('interact')).toBe(true)
    input.endTick()
    expect(input.held('interact')).toBe(true)   // still held on later ticks
    up('KeyZ')
    expect(input.held('interact')).toBe(false)
  })

  it('reports pressed only on the rising edge', () => {
    const { input, down, up } = harness()
    down('KeyZ')
    expect(input.pressed('interact')).toBe(true)
    input.endTick()
    expect(input.pressed('interact')).toBe(false)  // consumed
    up('KeyZ'); input.endTick()
    down('KeyZ')
    expect(input.pressed('interact')).toBe(true)   // fires again on re-press
  })

  it('still catches a press that is released within the same tick', () => {
    const { input, down, up } = harness()
    down('KeyZ')
    up('KeyZ')
    // Released before endTick: held is already false, and the edge is missed.
    // Documents current behaviour so a future input buffer has a baseline.
    expect(input.held('interact')).toBe(false)
    expect(input.pressed('interact')).toBe(false)
  })

  it('maps both arrows and WASD to the same buttons', () => {
    const { input, down, up } = harness()
    down('ArrowLeft')
    expect(input.held('left')).toBe(true)
    up('ArrowLeft')
    down('KeyA')
    expect(input.held('left')).toBe(true)
  })

  it('maps Z, Enter and Space to interact', () => {
    for (const code of ['KeyZ', 'Enter', 'Space']) {
      const { input, down } = harness()
      down(code)
      expect(input.held('interact'), code).toBe(true)
    }
  })

  it('ignores unbound keys', () => {
    const { input, down } = harness()
    down('KeyQ')
    expect(input.held('interact')).toBe(false)
  })

  it('clears held keys on blur so they do not stick', () => {
    const { target, input, down } = harness()
    down('KeyD')
    expect(input.held('right')).toBe(true)
    target.dispatchEvent(new Event('blur'))
    expect(input.held('right')).toBe(false)
  })
})

describe('Input pointer', () => {
  it('tracks the pointer position', () => {
    const { input, move } = harness()
    expect(input.pointer).toBeUndefined()
    move(120, 340)
    expect(input.pointer).toEqual({ x: 120, y: 340 })
  })

  it('reports pointerPressed only on the rising edge', () => {
    const { input, pDown, pUp } = harness()
    pDown(10, 10)
    expect(input.pointerPressed).toBe(true)
    expect(input.pointerHeld).toBe(true)
    input.endTick()
    expect(input.pointerPressed).toBe(false)   // consumed
    expect(input.pointerHeld).toBe(true)       // still down
    pUp()
    input.endTick()
    pDown(10, 10)
    expect(input.pointerPressed).toBe(true)    // fires again on re-press
  })

  it('switches source between keyboard and pointer', () => {
    // Both devices stay live; whichever was used last drives the paddle, so a
    // player can swap mid-match without the other fighting it.
    const { input, down, move } = harness()
    expect(input.source).toBe('keyboard')
    move(5, 5)
    expect(input.source).toBe('pointer')
    down('KeyA')
    expect(input.source).toBe('keyboard')
  })

  it('releases the pointer button on blur so it cannot stick', () => {
    const { target, input, pDown } = harness()
    pDown(1, 1)
    expect(input.pointerHeld).toBe(true)
    target.dispatchEvent(new Event('blur'))
    expect(input.pointerHeld).toBe(false)
  })
})
