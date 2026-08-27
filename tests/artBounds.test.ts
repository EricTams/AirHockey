import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { measurePropTrims, propArt, NO_TRIM } from '../src/world/artBounds'
import { makeTileset, type PropDef } from '../src/world/tileset'

/**
 * Measuring needs a canvas, and there is not one under the test runner, in a
 * worker, or when a sheet arrived without CORS headers. Every one of those is
 * a reason to place props on their declared regions — which is what the game
 * did before any of this existed — and not a reason to lose the map.
 */
describe('measurePropTrims without a canvas', () => {
  it('measures nothing rather than throwing', () => {
    const ts = {
      ...makeTileset('sheet.png', 480, 480, 48),
      props: [{ id: 'tree', name: 'Tree', col: 0, row: 0, w: 2, h: 3, anchor: [1, 2] as [number, number], solid: true }],
    }
    const trims = measurePropTrims(new THREE.Texture(), ts)
    expect(trims.size).toBe(0)
    // Which is what makes the caller's fallback the untrimmed region.
    expect(trims.get('tree') ?? NO_TRIM).toEqual({ top: 0, bottom: 0 })
  })
})

/**
 * The quad has to BE the drawing, not the region with the drawing shifted
 * inside it. Sliding a full-region quad south by the empty strip lines the art
 * up with the ground at pitch 90 and nowhere else: once the camera tilts the
 * billboard stands up, and a slide across the ground is no longer the same
 * screen distance as a slide up the billboard's face, so the prop floats again
 * by (1 - sin pitch) of the strip. Measured at 13px for the red house at 45
 * degrees, which is what sent this back for a second try.
 */
describe('propArt', () => {
  const ts = makeTileset('sheet.png', 480, 480, 48)
  const def: PropDef = {
    id: 'tree', name: 'Tree', col: 1, row: 2, w: 2, h: 3, anchor: [1, 2], solid: true,
  }

  it('is the whole region when the art fills it', () => {
    const art = propArt(ts, def, NO_TRIM, 0)
    expect(art.w).toBe(2)
    expect(art.h).toBe(3)
    expect(art.v0).toBeCloseTo(1 - (5 * 48) / 480, 6)   // bottom of row 4
    expect(art.v1).toBeCloseTo(1 - (2 * 48) / 480, 6)   // top of row 2
  })

  it('loses the empty strips, top and bottom', () => {
    const art = propArt(ts, def, { top: 24, bottom: 12 }, 0)
    expect(art.h).toBeCloseTo(3 - 0.75, 6)
    expect(art.v0).toBeCloseTo(1 - (5 * 48 - 12) / 480, 6)
    expect(art.v1).toBeCloseTo(1 - (2 * 48 + 24) / 480, 6)
  })

  it('leaves the horizontal alone', () => {
    // Standing on the ground is an invariant; being centred in your own region
    // is not, and street-lamp-arm is drawn off-centre on purpose.
    const full = propArt(ts, def, NO_TRIM, 0)
    const trimmed = propArt(ts, def, { top: 24, bottom: 12 }, 0)
    expect(trimmed.w).toBe(full.w)
    expect(trimmed.u0).toBe(full.u0)
    expect(trimmed.u1).toBe(full.u1)
  })
})
