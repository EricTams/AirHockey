import { describe, it, expect } from 'vitest'
import { MapDoc, COLLISION, blankMap, isNothing } from '../src/editor/mapDoc'
import { lineCells, rectCells, fillCells, toolCells } from '../src/editor/tools'
import { parseMap } from '../src/world/map'
import { makeTileset } from '../src/world/tileset'

const terrain = makeTileset('assets/terrain/tileset-tiles.png', 512, 464, 48)

function doc(width = 4, height = 3): MapDoc {
  return new MapDoc('data/maps/test.json', blankMap('test', width, height, 'data/tilesets/terrain.json', 14))
}

describe('MapDoc editing', () => {
  it('writes a cell and reports the change', () => {
    const d = doc()
    d.beginStroke('brush')
    expect(d.set('ground', 1, 1, 7)).toBe(true)
    expect(d.get('ground', 1, 1)).toBe(7)
    expect(d.endStroke()).toEqual({ layers: ['ground'], collision: false })
  })

  it('drops writes that change nothing, so undo does not fill with no-ops', () => {
    const d = doc()
    d.beginStroke('brush')
    expect(d.set('ground', 0, 0, 14)).toBe(false)   // already 14
    expect(isNothing(d.endStroke())).toBe(true)
    expect(d.canUndo).toBe(false)
  })

  it('drops writes outside the map', () => {
    const d = doc()
    d.beginStroke('brush')
    expect(d.set('ground', -1, 0, 7)).toBe(false)
    expect(d.set('ground', 4, 0, 7)).toBe(false)
    expect(d.set('ground', 0, 3, 7)).toBe(false)
    expect(isNothing(d.endStroke())).toBe(true)
  })

  it('groups a whole stroke into one undo', () => {
    const d = doc()
    d.beginStroke('brush')
    for (let x = 0; x < 4; x++) d.set('ground', x, 0, 7)
    d.endStroke()

    d.undo()
    for (let x = 0; x < 4; x++) expect(d.get('ground', x, 0)).toBe(14)
    expect(d.canUndo).toBe(false)
  })

  it('unwinds repeated writes to one cell in the right order', () => {
    // Painting over the same cell twice within a stroke has to undo to the
    // value it had before the stroke, not to the intermediate one.
    const d = doc()
    d.beginStroke('brush')
    d.set('ground', 0, 0, 7)
    d.set('ground', 0, 0, 9)
    d.endStroke()
    expect(d.get('ground', 0, 0)).toBe(9)
    d.undo()
    expect(d.get('ground', 0, 0)).toBe(14)
  })

  it('redoes what it undid, and loses the branch on a new edit', () => {
    const d = doc()
    d.beginStroke('a'); d.set('ground', 0, 0, 7); d.endStroke()
    d.undo()
    expect(d.canRedo).toBe(true)
    d.redo()
    expect(d.get('ground', 0, 0)).toBe(7)

    d.undo()
    d.beginStroke('b'); d.set('ground', 1, 1, 8); d.endStroke()
    expect(d.canRedo).toBe(false)
  })

  it('cancels an open stroke back to where it started', () => {
    const d = doc()
    d.beginStroke('rect')
    d.set('ground', 0, 0, 7)
    d.set('ground', 1, 0, 7)
    const touched = d.cancelStroke()
    expect(d.get('ground', 0, 0)).toBe(14)
    expect(d.get('ground', 1, 0)).toBe(14)
    expect(touched.layers).toEqual(['ground'])
    expect(d.canUndo).toBe(false)
  })

  it('reports collision separately from the tile layers', () => {
    const d = doc()
    d.beginStroke('collision')
    d.set(COLLISION, 0, 0, 1)
    expect(d.endStroke()).toEqual({ layers: [], collision: true })
    expect(d.map.collision[0]).toBe(1)
  })

  it('lists touched layers in draw order, not the order they were painted', () => {
    const d = doc()
    d.beginStroke('mixed')
    d.set('overhead', 0, 0, 7)
    d.set('ground', 0, 0, 7)
    expect(d.endStroke().layers).toEqual(['ground', 'overhead'])
  })
})

describe('MapDoc dirty tracking', () => {
  it('is clean until something changes', () => {
    const d = doc()
    expect(d.dirty).toBe(false)
    d.beginStroke('a'); d.set('ground', 0, 0, 7); d.endStroke()
    expect(d.dirty).toBe(true)
  })

  it('is clean again after undoing back to the saved state', () => {
    // A boolean flag would say "dirty" here, and the designer would be nagged
    // to save a file identical to the one on disk.
    const d = doc()
    d.beginStroke('a'); d.set('ground', 0, 0, 7); d.endStroke()
    d.markSaved()
    d.beginStroke('b'); d.set('ground', 1, 0, 8); d.endStroke()
    expect(d.dirty).toBe(true)
    d.undo()
    expect(d.dirty).toBe(false)
  })
})

describe('tools', () => {
  it('fills the gap a fast drag leaves between two reported cells', () => {
    const cells = lineCells({ x: 0, y: 0 }, { x: 3, y: 2 })
    expect(cells).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 2 },
    ])
  })

  it('reports a single cell for a line that does not move', () => {
    expect(lineCells({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }])
  })

  it('spans a rectangle from either corner', () => {
    const a = rectCells({ x: 2, y: 2 }, { x: 0, y: 1 })
    const b = rectCells({ x: 0, y: 1 }, { x: 2, y: 2 })
    expect(a).toEqual(b)
    expect(a).toHaveLength(6)
  })

  it('floods only the connected matching region', () => {
    const d = doc(3, 3)
    // A wall down the middle column splits the ground layer in two.
    d.beginStroke('wall')
    for (let y = 0; y < 3; y++) d.set('ground', 1, y, 99)
    d.endStroke()

    const left = fillCells(d, 'ground', { x: 0, y: 0 })
    expect(left).toHaveLength(3)
    expect(left.every((c) => c.x === 0)).toBe(true)
  })

  it('floods the whole layer when it is uniform', () => {
    const d = doc(4, 3)
    expect(fillCells(d, 'ground', { x: 2, y: 1 })).toHaveLength(12)
  })

  it('floods nothing from outside the map', () => {
    const d = doc()
    expect(fillCells(d, 'ground', { x: -1, y: 0 })).toEqual([])
  })

  it('handles a fill large enough to have blown a recursive stack', () => {
    const d = new MapDoc('x', blankMap('big', 200, 200, 't', 14))
    expect(fillCells(d, 'ground', { x: 0, y: 0 })).toHaveLength(40_000)
  })

  it('routes each tool to its own geometry', () => {
    const d = doc()
    expect(toolCells(d, 'ground', 'brush', { x: 0, y: 0 }, { x: 2, y: 0 })).toHaveLength(3)
    expect(toolCells(d, 'ground', 'rect', { x: 0, y: 0 }, { x: 1, y: 1 })).toHaveLength(4)
    expect(toolCells(d, 'ground', 'eyedropper', { x: 0, y: 0 }, { x: 3, y: 2 }))
      .toEqual([{ x: 3, y: 2 }])
  })
})

describe('blankMap', () => {
  it('produces a map the game will actually load', () => {
    // The editor writes these files; strict validation is the contract.
    const map = blankMap('fresh', 6, 5, 'data/tilesets/terrain.json', 14)
    expect(() => parseMap(map, terrain, 'fresh')).not.toThrow()
  })

  it('fills ground rather than leaving the void showing', () => {
    const map = blankMap('fresh', 3, 3, 't', 14)
    expect(map.layers.ground.every((t) => t === 14)).toBe(true)
    expect(map.layers.decoration.every((t) => t === -1)).toBe(true)
  })

  it('puts the player inside the map it just made', () => {
    const map = blankMap('fresh', 7, 4, 't', 14)
    expect(map.playerStart.x).toBeLessThan(map.width)
    expect(map.playerStart.y).toBeLessThan(map.height)
  })
})
