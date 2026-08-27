import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { measureCells, proposeSheet, gridRows, type Rgba } from '../src/editor/sheetAnalysis'
import { serializeTileset, toFile } from '../src/editor/tilesetFile'
import { parseTileset } from '../src/world/tileset'

/**
 * The importer measures; the designer decides (handoff decision 5). These tests
 * pin down what it measures. It deliberately makes no attempt to find props:
 * see the note at the top of sheetAnalysis.ts for why that was removed rather
 * than tuned.
 */

/** A sheet of `cols`x`rows` cells, painted by a per-cell alpha function. */
function sheet(cols: number, rows: number, tilePx: number, alpha: (c: number, r: number, x: number, y: number) => number): Rgba {
  const width = cols * tilePx
  const height = rows * tilePx
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i + 3] = alpha(Math.floor(x / tilePx), Math.floor(y / tilePx), x % tilePx, y % tilePx)
    }
  }
  return { width, height, data }
}

describe('measureCells', () => {
  it('floors the grid, leaving the partial margin unaddressed', () => {
    // The shipped sheet is 512x464 at 48px: 10.67 x 9.67 cells.
    const image = sheet(1, 1, 48, () => 255)
    const wide: Rgba = { ...image, width: 48 }
    const { cols, rows } = measureCells({ ...wide, width: 512, height: 464, data: new Uint8ClampedArray(512 * 464 * 4) }, 48)
    expect({ cols, rows }).toEqual({ cols: 10, rows: 9 })
  })

  it('reports full coverage for a solid cell and none for an empty one', () => {
    const image = sheet(2, 1, 4, (c) => (c === 0 ? 255 : 0))
    const { stats } = measureCells(image, 4)
    expect(stats[0]).toEqual({ coverage: 1, opaque: 1 })
    expect(stats[1]).toEqual({ coverage: 0, opaque: 0 })
  })

  it('separates any-alpha coverage from fully-opaque coverage', () => {
    // Half the cell at alpha 100: covered, but not opaque. This is the
    // distinction that makes outline bleed measurable.
    const image = sheet(1, 1, 4, (_c, _r, _x, y) => (y < 2 ? 100 : 0))
    const { stats } = measureCells(image, 4)
    expect(stats[0]!.coverage).toBeCloseTo(0.5)
    expect(stats[0]!.opaque).toBe(0)
  })
})

describe('proposeSheet', () => {
  it('calls a fully covered cell a paintable tile', () => {
    const p = proposeSheet(sheet(1, 1, 4, () => 255), 4)
    expect(p.cells).toEqual(['tile'])
  })

  it('calls an empty cell unused', () => {
    const p = proposeSheet(sheet(1, 1, 4, () => 0), 4)
    expect(p.cells).toEqual(['unused'])
  })

  it('leaves a partly covered cell unused rather than paintable', () => {
    // A sprite standing on transparency is what a partial cell usually is, and
    // painting it into a tile layer would tile the transparency with it.
    const p = proposeSheet(sheet(1, 1, 4, (_c, _r, _x, y) => (y < 2 ? 255 : 0)), 4)
    expect(p.cells).toEqual(['unused'])
  })

  it('proposes no props at all, on any input', () => {
    // Not an oversight: an automatic prop finder was removed because its
    // answers read as decisions. The empty list is honest, and describeTileset
    // tags it DEFAULT so nobody reads it as "this sheet has no props".
    const p = proposeSheet(sheet(3, 3, 4, (c, r) => (c === r ? 128 : 0)), 4)
    expect(p).not.toHaveProperty('props')
  })
})

describe('gridRows', () => {
  it('writes one character per cell, per the legend', () => {
    expect(gridRows(
      ['tile', 'tile', 'unused', 'tile'],
      [false, true, false, false],
      2, 2,
    )).toEqual(['TS', '.T'])
  })
})

describe('serializeTileset', () => {
  it('reproduces the shipped rider byte for byte', () => {
    // Round-tripped the way the review screen writes it: `toFile` carries the
    // props and names off the parsed tileset, but the grid is an override,
    // because the grid is the thing the review screen is editing.
    const text = readFileSync('public/data/tilesets/city.json', 'utf8')
    const tileset = parseTileset(JSON.parse(text), 'city')
    const grid = gridRows(tileset.cells, tileset.solid, tileset.cols, tileset.rows)
    expect(serializeTileset(toFile(tileset, { grid }))).toBe(text)
  })

  it("round-trips a reviewed sheet through the game's own parser", () => {
    const file = {
      id: 'test',
      image: 'assets/test.png',
      tilePx: 48,
      size: [96, 96] as [number, number],
      reviewed: true,
      grid: ['TS', '.T'],
      props: [{ id: 'tree', name: 'Tree', col: 0, row: 0, w: 1, h: 2, anchor: [0, 1] as [number, number], solid: true }],
      names: { 0: 'grass' },
    }
    const parsed = parseTileset(JSON.parse(serializeTileset(file)), 'test')
    expect(parsed.reviewed).toBe(true)
    expect(parsed.cells).toEqual(['tile', 'tile', 'unused', 'tile'])
    expect(parsed.solid).toEqual([false, true, false, false])
    expect(parsed.props[0]).toMatchObject({ id: 'tree', w: 1, h: 2 })
    expect(parsed.names[0]).toBe('grass')
  })

  it('keeps one grid row per line', () => {
    const text = serializeTileset({
      id: 'a', image: 'a.png', tilePx: 48, size: [96, 96], reviewed: false,
      grid: ['TT', 'TT'],
    })
    expect(text.split('\n').filter((l) => l.includes('"T'))).toHaveLength(2)
  })
})
