import { describe, it, expect } from 'vitest'
import { walkFrame, writeFrameUv } from '../src/world/character'

/**
 * The walk cycle is locked to distance, not wall-clock: 4 frames at 2 per tile
 * step, so one full cycle spans two tiles (left foot, right foot). If this
 * drifts, the feet slide.
 */
describe('walkFrame', () => {
  const F = 4, PER = 2

  it('plays frames 0 then 1 across the first step', () => {
    expect(walkFrame(0, 0.0, PER, F)).toBe(0)
    expect(walkFrame(0, 0.49, PER, F)).toBe(0)
    expect(walkFrame(0, 0.5, PER, F)).toBe(1)
    expect(walkFrame(0, 0.99, PER, F)).toBe(1)
  })

  it('plays frames 2 then 3 across the second step', () => {
    expect(walkFrame(1, 0.0, PER, F)).toBe(2)
    expect(walkFrame(1, 0.5, PER, F)).toBe(3)
  })

  it('wraps to the start on the third step, giving a two-tile cycle', () => {
    expect(walkFrame(2, 0.0, PER, F)).toBe(0)
    expect(walkFrame(3, 0.5, PER, F)).toBe(3)
  })

  it('never overruns the last frame of a step at progress 1', () => {
    expect(walkFrame(0, 1.0, PER, F)).toBe(1)
    expect(walkFrame(1, 1.0, PER, F)).toBe(3)
  })

  it('advances monotonically across many steps without gaps', () => {
    const seen: number[] = []
    for (let step = 0; step < 4; step++) {
      for (const p of [0, 0.5]) seen.push(walkFrame(step, p, PER, F))
    }
    expect(seen).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('handles a 2-frame sheet with 1 frame per step', () => {
    expect(walkFrame(0, 0.9, 1, 2)).toBe(0)
    expect(walkFrame(1, 0.0, 1, 2)).toBe(1)
    expect(walkFrame(2, 0.0, 1, 2)).toBe(0)
  })

  it('returns 0 rather than NaN for an empty sheet', () => {
    expect(walkFrame(3, 0.5, PER, 0)).toBe(0)
  })
})

/**
 * A side view is one drawing serving two facings. The flip is a UV swap rather
 * than a negative scale on the mesh, because a negative scale reverses the
 * winding order and the sprite disappears under back-face culling.
 */
describe('writeFrameUv', () => {
  // A frame occupying the left quarter of its sheet, upper half.
  const frame = { u0: 0, u1: 0.25, v0: 0.5, v1: 1 }
  const uv = () => new Array(8).fill(-1)

  it('writes TL, TR, BL, BR in PlaneGeometry order', () => {
    const a = uv()
    writeFrameUv(a, frame)
    expect(a).toEqual([
      0, 1,        // top-left
      0.25, 1,     // top-right
      0, 0.5,      // bottom-left
      0.25, 0.5,   // bottom-right
    ])
  })

  it('swaps the two u values when mirrored, and leaves v alone', () => {
    const a = uv()
    writeFrameUv(a, frame, true)
    expect(a).toEqual([
      0.25, 1,
      0, 1,
      0.25, 0.5,
      0, 0.5,
    ])
  })

  it('stays inside the same frame, so mirroring never samples its neighbour', () => {
    const a = uv()
    writeFrameUv(a, frame, true)
    const us = [a[0], a[2], a[4], a[6]] as number[]
    expect(Math.min(...us)).toBe(frame.u0)
    expect(Math.max(...us)).toBe(frame.u1)
  })

  it('is its own inverse', () => {
    const once = uv(); writeFrameUv(once, frame, true)
    const twice = uv(); writeFrameUv(twice, { ...frame, u0: frame.u1, u1: frame.u0 }, true)
    const plain = uv(); writeFrameUv(plain, frame)
    expect(twice).toEqual(plain)
    expect(once).not.toEqual(plain)
  })
})
