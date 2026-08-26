import { describe, it, expect } from 'vitest'
import { stampWrites } from '../src/editor/stamp'

/**
 * Laying a multi-tile grab down. The interesting case is a drag: stamping a
 * fresh copy at every cell the cursor passes through would overlap them a tile
 * apart and produce mush, so positions snap to a lattice anchored at the cell
 * the stroke started on.
 */
const region = (col: number, row: number, w: number, h: number) => ({ col, row, w, h })
const cols = 10

describe('stampWrites', () => {
  it('is the identity for a single-cell selection', () => {
    expect(stampWrites([{ x: 3, y: 4 }], region(2, 1, 1, 1), { x: 3, y: 4 }, cols, false))
      .toEqual([{ x: 3, y: 4, value: 12 }])
  })

  it('lays the whole block down from one cursor cell', () => {
    // A 2x3 grab puts six tiles down, reading across then down the sheet.
    const out = stampWrites([{ x: 5, y: 5 }], region(0, 0, 2, 3), { x: 5, y: 5 }, cols, false)
    expect(out).toHaveLength(6)
    expect(out.map((w) => `${w.x},${w.y}:${w.value}`)).toEqual([
      '5,5:0', '6,5:1',
      '5,6:10', '6,6:11',
      '5,7:20', '6,7:21',
    ])
  })

  it('tiles a drag instead of overlapping copies', () => {
    // Four cells dragged rightwards with a 2x1 grab covers exactly four tiles,
    // alternating the pattern — not four two-wide stamps a tile apart.
    const cells = [0, 1, 2, 3].map((i) => ({ x: i, y: 0 }))
    const out = stampWrites(cells, region(0, 0, 2, 1), { x: 0, y: 0 }, cols, false)
    expect(out).toHaveLength(4)
    expect(out.map((w) => w.value)).toEqual([0, 1, 0, 1])
  })

  it('keeps the lattice anchored when the drag runs backwards', () => {
    // The cell the stroke began on always takes the block's top-left tile,
    // whichever way the drag then goes — that is what makes a plain click put
    // the block exactly where it was clicked. Dragging left from there extends
    // the same lattice backwards rather than mirroring it.
    const cells = [3, 2, 1, 0].map((i) => ({ x: i, y: 0 }))
    const out = stampWrites(cells, region(0, 0, 2, 1), { x: 3, y: 0 }, cols, false)
    const byX = new Map(out.map((w) => [w.x, w.value]))
    expect(byX.get(3)).toBe(0)
    expect(byX.get(4)).toBe(1)
    expect(byX.get(1)).toBe(0)
    expect(byX.get(2)).toBe(1)
  })

  it('lets an off-map write through for the document to drop', () => {
    // Clipping here would need the map's size, which is not this rule's
    // business; MapDoc.set already refuses anything outside the map.
    const out = stampWrites([{ x: 0, y: 0 }], region(0, 0, 2, 1), { x: 1, y: 0 }, cols, false)
    expect(out.map((w) => w.x)).toEqual([-1, 0])
  })

  it('writes past the cells it was given, because a stamp is a block', () => {
    const out = stampWrites([{ x: 0, y: 0 }], region(0, 0, 3, 1), { x: 0, y: 0 }, cols, false)
    expect(out.map((w) => w.x)).toEqual([0, 1, 2])
  })

  it('clips to the region when asked, for rect and fill', () => {
    // Those are regions rather than stamps: the pattern tiles inside them and
    // does not spill over the edge the designer drew.
    const out = stampWrites([{ x: 0, y: 0 }], region(0, 0, 3, 1), { x: 0, y: 0 }, cols, true)
    expect(out.map((w) => w.x)).toEqual([0])
  })

  it('never writes the same cell twice', () => {
    const cells = [0, 1, 2, 3, 4].map((i) => ({ x: i, y: 0 }))
    const out = stampWrites(cells, region(0, 0, 2, 1), { x: 0, y: 0 }, cols, false)
    expect(new Set(out.map((w) => `${w.x},${w.y}`)).size).toBe(out.length)
  })

  it('uses a flat value for collision and erase, whatever the art', () => {
    const out = stampWrites([{ x: 2, y: 2 }], region(4, 4, 2, 2), { x: 2, y: 2 }, cols, false, 1)
    expect(out).toHaveLength(4)
    expect(out.every((w) => w.value === 1)).toBe(true)
  })

  it('treats a flat value of zero as a value, not as absent', () => {
    // Clearing collision writes 0, which a truthiness check would drop.
    const out = stampWrites([{ x: 0, y: 0 }], region(3, 3, 1, 1), { x: 0, y: 0 }, cols, false, 0)
    expect(out).toEqual([{ x: 0, y: 0, value: 0 }])
  })
})
