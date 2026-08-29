import { describe, it, expect } from 'vitest'
import { blobSize, SHADOW_STYLES, SHADOW_LABELS, DEFAULT_SHADOW_STYLE } from '../src/world/shadow'

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

  // The world starts on the default and the toggle cycles from wherever it is,
  // so a default outside the cycle would be a style you can leave but not reach.
  it('includes the default the world boots with', () => {
    expect(DEFAULT_SHADOW_STYLE).toBe('soft')
    expect(SHADOW_STYLES).toContain(DEFAULT_SHADOW_STYLE)
  })
})
