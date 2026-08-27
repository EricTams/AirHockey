import { describe, it, expect } from 'vitest'
import {
  makeTileset, parseTileset, cellOf, indexOf, isTileIndex, isPaintable,
  cellUv, propUv, propById, tileCount, describeTileset,
} from '../src/world/tileset'

/**
 * The shipped terrain sheet is 512x464 on a 48px grid, which divides evenly in
 * neither axis. `.artlog/decisions.json` ("grid-origin") settled that the grid
 * anchors top-left and the remainder is unused margin, and every tile index in
 * every map file depends on that. If this drifts, every map re-indexes.
 */
describe('tileset grid', () => {
  const terrain = makeTileset('assets/terrain/tileset-tiles.png', 512, 464, 48)

  it('floors the partial margin out of the usable grid', () => {
    expect(terrain.cols).toBe(10)   // 512/48 = 10.67
    expect(terrain.rows).toBe(9)    // 464/48 = 9.67
    expect(tileCount(terrain)).toBe(90)
  })

  it('indexes row-major from the top-left', () => {
    expect(indexOf(terrain, 0, 0)).toBe(0)
    expect(indexOf(terrain, 9, 0)).toBe(9)
    expect(indexOf(terrain, 0, 1)).toBe(10)
    // The two cells the map data actually uses.
    expect(indexOf(terrain, 4, 1)).toBe(14)   // pure grass
    expect(indexOf(terrain, 5, 6)).toBe(65)   // solid dirt
  })

  it('round-trips index to cell', () => {
    for (const i of [0, 9, 10, 14, 65, 89]) {
      const { col, row } = cellOf(terrain, i)
      expect(indexOf(terrain, col, row)).toBe(i)
    }
  })

  it('rejects cells in the unused margin', () => {
    expect(() => indexOf(terrain, 10, 0)).toThrow(/out of range/)
    expect(() => indexOf(terrain, 0, 9)).toThrow(/out of range/)
  })

  it('treats -1 and out-of-range as not a tile', () => {
    expect(isTileIndex(terrain, -1)).toBe(false)
    expect(isTileIndex(terrain, 90)).toBe(false)
    expect(isTileIndex(terrain, 1.5)).toBe(false)
    expect(isTileIndex(terrain, 89)).toBe(true)
  })

  it('insets UVs inside the cell so neighbours cannot bleed', () => {
    const { u0, u1, v0, v1 } = cellUv(terrain, 14)
    // Cell (4,1): x 192..240, y 48..96 of a 512x464 sheet.
    expect(u0).toBeGreaterThan(192 / 512)
    expect(u1).toBeLessThan(240 / 512)
    expect(v1).toBeLessThan(1 - 48 / 464)
    expect(v0).toBeGreaterThan(1 - 96 / 464)
  })

  it('refuses a sheet smaller than one cell', () => {
    expect(() => makeTileset('tiny.png', 32, 32, 48)).toThrow(/smaller than one/)
  })
})

/**
 * The rider file is what the tile/prop split lives in. The importer writes it
 * from a pixel-coverage guess, which on real art is a proposal rather than an
 * answer, so `reviewed` distinguishes "a machine guessed this" from "a
 * designer confirmed it" and nothing downstream should treat them alike.
 */
describe('tileset rider file', () => {
  const base = { id: 't', image: 'a.png', tilePx: 48, size: [144, 96] }  // 3x2 cells

  it('treats an unclassified sheet as all-paintable and unreviewed', () => {
    const ts = parseTileset(base, 'a.json')
    expect(ts.cols).toBe(3)
    expect(ts.rows).toBe(2)
    expect(ts.reviewed).toBe(false)
    for (let i = 0; i < 6; i++) expect(isPaintable(ts, i)).toBe(true)
    expect(ts.props).toEqual([])
  })

  it('reads the grid legend into kinds and collision defaults', () => {
    const ts = parseTileset({ ...base, reviewed: true, grid: ['T.S', '.TT'] }, 'a.json')
    expect(ts.reviewed).toBe(true)
    expect(ts.cells).toEqual(['tile', 'unused', 'tile', 'unused', 'tile', 'tile'])
    expect(ts.solid).toEqual([false, false, true, false, false, false])
    expect(isPaintable(ts, 1)).toBe(false)
    expect(isPaintable(ts, 2)).toBe(true)
  })

  it('rejects a grid that does not match the usable cell count', () => {
    expect(() => parseTileset({ ...base, grid: ['T.S'] }, 'a.json')).toThrow(/1 rows, expected 2/)
    expect(() => parseTileset({ ...base, grid: ['T.', '..'] }, 'a.json')).toThrow(/2 chars, expected 3/)
    expect(() => parseTileset({ ...base, grid: ['T.X', '...'] }, 'a.json')).toThrow(/unknown character "X"/)
  })

  it('anchors a prop bottom-centre by default, where sprites anchor', () => {
    const ts = parseTileset({ ...base, props: [{ id: 'tree', col: 0, row: 0, w: 3, h: 2 }] }, 'a.json')
    const tree = propById(ts, 'tree')!
    expect(tree.anchor).toEqual([1, 1])
    expect(tree.name).toBe('tree')     // falls back to the id
    expect(tree.solid).toBe(false)
  })

  it('keeps an explicit anchor and name', () => {
    const ts = parseTileset({
      ...base,
      props: [{ id: 'arch', name: 'Stone arch', col: 1, row: 0, w: 2, h: 2, anchor: [0, 0], solid: true }],
    }, 'a.json')
    const arch = propById(ts, 'arch')!
    expect(arch.anchor).toEqual([0, 0])
    expect(arch.name).toBe('Stone arch')
    expect(arch.solid).toBe(true)
  })

  it('rejects props that leave the sheet or anchor outside themselves', () => {
    const p = (o: Record<string, unknown>) => () => parseTileset({ ...base, props: [o] }, 'a.json')
    expect(p({ id: 'x', col: 2, row: 0, w: 2, h: 1 })).toThrow(/does not fit the 3x2 grid/)
    expect(p({ id: 'x', col: 0, row: 0, w: 0, h: 1 })).toThrow(/at least 1x1/)
    expect(p({ id: 'x', col: 0, row: 0, w: 2, h: 2, anchor: [2, 0] })).toThrow(/outside the 2x2 region/)
    expect(() => parseTileset({
      ...base, props: [{ id: 'a', col: 0, row: 0, w: 1, h: 1 }, { id: 'a', col: 1, row: 0, w: 1, h: 1 }],
    }, 'a.json')).toThrow(/duplicate id "a"/)
  })

  it('spans a whole prop region in one UV rect', () => {
    const ts = parseTileset({ ...base, props: [{ id: 'wide', col: 0, row: 0, w: 3, h: 1 }] }, 'a.json')
    const uv = propUv(ts, propById(ts, 'wide')!)
    // The full 144px width of the sheet, inset at both edges.
    expect(uv.u0).toBeGreaterThan(0)
    expect(uv.u1).toBeLessThan(1)
    expect(uv.u1 - uv.u0).toBeGreaterThan(0.98)
  })

  it('carries optional per-cell labels', () => {
    const ts = parseTileset({ ...base, names: { 0: 'grass', 4: 'dirt' } }, 'a.json')
    expect(ts.names[0]).toBe('grass')
    expect(ts.names[4]).toBe('dirt')
    expect(() => parseTileset({ ...base, names: { 99: 'x' } }, 'a.json')).toThrow(/not a cell index/)
  })
})

/**
 * The classification readout. The counts are the easy half; DEFAULT is the
 * point. "0 props" from a sheet nobody has looked at is not the same claim as
 * "0 props" from one a designer has been through, and the file format cannot
 * tell them apart without saying so out loud.
 */
describe('describeTileset', () => {
  const base = { image: 'a.png', tilePx: 48, size: [96, 96] as [number, number] }

  it('tags an unclassified sheet DEFAULT', () => {
    const ts = parseTileset({ ...base, grid: ['T.', '..'] }, 'a.json')
    expect(describeTileset(ts)).toBe('1 tile, 0 props, DEFAULT')
  })

  it('drops DEFAULT once the sheet is classified', () => {
    const ts = parseTileset({ ...base, reviewed: true, grid: ['TS', '..'] }, 'a.json')
    expect(describeTileset(ts)).toBe('2 tiles, 0 props')
  })

  it('drops DEFAULT for edits in hand, before they reach the file', () => {
    const ts = parseTileset({ ...base, grid: ['T.', '..'] }, 'a.json')
    expect(describeTileset(ts, true)).toBe('1 tile, 0 props')
  })

  it('counts props', () => {
    const ts = parseTileset({
      ...base, reviewed: true, grid: ['T.', '..'],
      props: [{ id: 'tree', col: 0, row: 0, w: 1, h: 2 }],
    }, 'a.json')
    expect(describeTileset(ts)).toBe('1 tile, 1 prop')
  })
})
