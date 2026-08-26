import { describe, it, expect } from 'vitest'
import { propOrigin } from '../src/world/prop'
import type { PropDef } from '../src/world/tileset'

/**
 * A prop's anchor is the cell that stands on the target tile, so that a tree
 * placed at (5,5) stands on (5,5) rather than hanging its bounding box from
 * there. Getting this wrong shifts every prop on every map by a fixed offset,
 * which looks plausible until it does not.
 */
function prop(w: number, h: number, anchor: [number, number]): PropDef {
  return { id: 'p', name: 'p', col: 0, row: 0, w, h, anchor, solid: false }
}

describe('propOrigin', () => {
  it('leaves a 1x1 prop on its own tile', () => {
    expect(propOrigin(prop(1, 1, [0, 0]), 5, 5)).toEqual({ tx: 5, ty: 5 })
  })

  it('centres an odd-width prop anchored at its middle-bottom cell', () => {
    // 3 wide, 2 tall, anchored bottom-centre: the middle of the bottom row
    // stands on the tile, so the billboard's own origin is the same tile.
    expect(propOrigin(prop(3, 2, [1, 1]), 5, 5)).toEqual({ tx: 5, ty: 5 })
  })

  it('offsets an even-width prop by half a tile', () => {
    // With no middle column the region straddles the tile boundary; anchoring
    // on the left cell puts the billboard centre half a tile east.
    expect(propOrigin(prop(2, 1, [0, 0]), 5, 5)).toEqual({ tx: 5.5, ty: 5 })
  })

  it('hangs a top-anchored prop south of its tile', () => {
    // Anchored on the top row, a 1x3 prop's remaining two rows fall below it,
    // so the bottom edge — which is what the billboard stands on — is two
    // tiles further south.
    expect(propOrigin(prop(1, 3, [0, 0]), 5, 5)).toEqual({ tx: 5, ty: 7 })
  })

  it('stands a tall bottom-anchored prop on its tile', () => {
    expect(propOrigin(prop(1, 3, [0, 2]), 5, 5)).toEqual({ tx: 5, ty: 5 })
  })

  it('moves with the tile it is placed on', () => {
    const def = prop(2, 3, [0, 2])
    const a = propOrigin(def, 0, 0)
    const b = propOrigin(def, 4, 7)
    expect({ tx: b.tx - a.tx, ty: b.ty - a.ty }).toEqual({ tx: 4, ty: 7 })
  })
})
