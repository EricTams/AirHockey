import { describe, it, expect } from 'vitest'
import { castOffset, blobSize, SHADOW_STYLES, SHADOW_LABELS } from '../src/world/shadow'

/**
 * The sun is a pair of constants, and every cast shadow in the world is the
 * vector they produce. Getting the sign of Z wrong points every shadow at the
 * camera instead of away from it, which reads as light coming from behind the
 * player — plausible enough on one prop to miss.
 */
describe('castOffset', () => {
  it('runs north-east, so shadows fall up and to the right', () => {
    const { dx, dz } = castOffset(1)
    expect(dx).toBeGreaterThan(0)   // east
    expect(dz).toBeLessThan(0)      // north; Z runs south
  })

  it('is a little over half the height, at a 30 degree lean', () => {
    const { dx, dz } = castOffset(4)
    expect(Math.hypot(dx, dz)).toBeCloseTo(4 * Math.tan(30 * Math.PI / 180), 6)
  })

  it('scales with height, so a tall prop throws a long shadow', () => {
    const one = castOffset(1)
    const three = castOffset(3)
    expect(three.dx).toBeCloseTo(one.dx * 3, 6)
    expect(three.dz).toBeCloseTo(one.dz * 3, 6)
  })

  it('casts nothing from something with no height', () => {
    expect(castOffset(0)).toEqual({ dx: 0, dz: -0 })
  })
})

describe('blobSize', () => {
  it('is wider than it is deep, so it reads as ground seen at a slant', () => {
    const { w, d } = blobSize(2)
    expect(w).toBeGreaterThan(d)
  })

  it('scales with the width it is given', () => {
    expect(blobSize(4).w).toBeCloseTo(blobSize(1).w * 4, 6)
  })
})

describe('the style cycle', () => {
  it('starts at off and names every style', () => {
    expect(SHADOW_STYLES[0]).toBe('none')
    for (const style of SHADOW_STYLES) expect(SHADOW_LABELS[style]).toBeTruthy()
    expect(Object.keys(SHADOW_LABELS)).toHaveLength(SHADOW_STYLES.length)
  })
})
