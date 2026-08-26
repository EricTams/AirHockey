import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { measureCells, proposeSheet, clusterProps, gridRows, type Rgba } from '../src/editor/sheetAnalysis'
import { serializeTileset, toFile } from '../src/editor/tilesetFile'
import { parseTileset } from '../src/world/tileset'

/**
 * The importer proposes; the designer decides (handoff decision 5). These tests
 * pin down what it proposes so the review screen has something predictable to
 * correct — not that the proposals are right, which on real art they are not.
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
    expect(p.props).toEqual([])
  })

  it('calls an empty cell unused', () => {
    const p = proposeSheet(sheet(1, 1, 4, () => 0), 4)
    expect(p.cells).toEqual(['unused'])
  })

  it('treats a partly covered cell as a prop candidate, not a tile', () => {
    // A sprite standing on transparency is what a partial cell usually is, and
    // painting it into a tile layer would tile the transparency with it.
    const p = proposeSheet(sheet(1, 1, 4, (_c, _r, _x, y) => (y < 2 ? 255 : 0)), 4)
    expect(p.cells).toEqual(['unused'])
    expect(p.props).toHaveLength(1)
    expect(p.props[0]).toMatchObject({ col: 0, row: 0, w: 1, h: 1 })
  })
})

describe('clusterProps', () => {
  const P = true, _ = false

  it('boxes one connected run', () => {
    const props = clusterProps([
      _, _, _,
      _, P, P,
      _, P, _,
    ], 3, 3)
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ col: 1, row: 1, w: 2, h: 2 })
  })

  it('keeps two separated runs apart', () => {
    const props = clusterProps([
      P, _, P,
      _, _, _,
      _, _, _,
    ], 3, 3)
    expect(props).toHaveLength(2)
  })

  it('merges runs that touch only diagonally', () => {
    // Eight-connected on purpose: a canopy overhanging a trunk touches this
    // way. The cost is documented — on the shipped sheet the terrace and the
    // plateau merge, and the review screen is how that gets split.
    const props = clusterProps([
      P, _, _,
      _, P, _,
      _, _, _,
    ], 3, 3)
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ col: 0, row: 0, w: 2, h: 2 })
  })

  it('anchors a proposal at bottom-centre, where sprites anchor', () => {
    const props = clusterProps([
      P, P, P,
      P, P, P,
      _, _, _,
    ], 3, 3)
    expect(props[0]).toMatchObject({ w: 3, h: 2, anchor: [1, 1] })
  })

  it('gives every proposal a distinct id', () => {
    const props = clusterProps([P, _, P, _, _, _, P, _, P], 3, 3)
    expect(new Set(props.map((p) => p.id)).size).toBe(props.length)
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
    const text = readFileSync('public/data/tilesets/terrain.json', 'utf8')
    const tileset = parseTileset(JSON.parse(text), 'terrain')
    expect(serializeTileset(toFile(tileset))).toBe(text)
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
