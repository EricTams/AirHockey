import { describe, it, expect } from 'vitest'
import { MapDoc, blankMap, resizeMap, isNothing } from '../src/editor/mapDoc'
import { parseMap, warpAt, type GameMap } from '../src/world/map'
import { makeTileset } from '../src/world/tileset'

const tileset = makeTileset('assets/terrain/tileset-tiles.png', 512, 464, 48)

/** A 3x2 map whose ground cells are numbered by position, so a re-index shows. */
function numbered(): GameMap {
  const map = blankMap('n', 3, 2, 'data/tilesets/terrain.json', 0)
  map.layers.ground = [0, 1, 2, 3, 4, 5]
  map.collision = [0, 1, 0, 1, 0, 1]
  return map
}

describe('resizeMap', () => {
  it('re-indexes rather than truncating when narrowing', () => {
    // Every grid is row-major, so a width change moves every cell after the
    // first row. Truncating would scramble the map into something that still
    // validates, which is the worst kind of wrong.
    const out = resizeMap(numbered(), 2, 2, -1)
    expect(out.layers.ground).toEqual([0, 1, 3, 4])
    expect(out.collision).toEqual([0, 1, 1, 0])
  })

  it('re-indexes when widening, filling the new cells', () => {
    const out = resizeMap(numbered(), 4, 2, 9)
    expect(out.layers.ground).toEqual([0, 1, 2, 9, 3, 4, 5, 9])
  })

  it('anchors the top-left corner when growing downward', () => {
    const out = resizeMap(numbered(), 3, 3, 9)
    expect(out.layers.ground.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5])
    expect(out.layers.ground.slice(6)).toEqual([9, 9, 9])
  })

  it('fills new decoration and overhead cells with empty, not the ground fill', () => {
    const out = resizeMap(numbered(), 4, 2, 9)
    expect(out.layers.decoration.filter((t) => t === 9)).toHaveLength(0)
    expect(out.layers.overhead.every((t) => t === -1)).toBe(true)
  })

  it('leaves new collision cells passable', () => {
    const out = resizeMap(numbered(), 4, 2, 9)
    expect(out.collision).toEqual([0, 1, 0, 0, 1, 0, 1, 0])
  })

  it('drops entities that fall outside the new bounds', () => {
    const map = numbered()
    map.npcs = [
      { id: 'in', character: 'c.json', x: 0, y: 0, facing: 'down' },
      { id: 'out', character: 'c.json', x: 2, y: 1, facing: 'down' },
    ]
    map.warps = [{ id: 'w', x: 2, y: 0, to: 'other.json', toX: 0, toY: 0 }]
    const out = resizeMap(map, 2, 1, 0)
    expect(out.npcs.map((n) => n.id)).toEqual(['in'])
    expect(out.warps).toEqual([])
  })

  it('pulls the player start inside rather than dropping it', () => {
    // A map without a player start does not load at all.
    const map = numbered()
    map.playerStart = { x: 2, y: 1, facing: 'up' }
    const out = resizeMap(map, 1, 1, 0)
    expect(out.playerStart).toEqual({ x: 0, y: 0, facing: 'up' })
  })

  it('produces a map the game will load', () => {
    const map = blankMap('r', 5, 4, 'data/tilesets/terrain.json', 14)
    const out = resizeMap(map, 8, 3, 14)
    expect(() => parseMap(out, tileset, 'resized')).not.toThrow()
  })

  it('refuses a size that is not a positive integer', () => {
    expect(() => resizeMap(numbered(), 0, 2, 0)).toThrow(/width/)
    expect(() => resizeMap(numbered(), 2, 1.5, 0)).toThrow(/height/)
  })

  it('does not alias the original map', () => {
    const map = numbered()
    const out = resizeMap(map, 3, 2, 0)
    out.layers.ground[0] = 99
    expect(map.layers.ground[0]).toBe(0)
  })
})

describe('MapDoc.replaceMap', () => {
  it('undoes a resize that changed only the grids', () => {
    // A resize that leaves every entity in place looks like a no-op to an
    // entity snapshot, which is why it gets a whole-map edit of its own.
    const doc = new MapDoc('p', blankMap('r', 3, 2, 't', 14))
    const touched = doc.replaceMap('resize', resizeMap(doc.map, 5, 2, 14))
    expect(isNothing(touched)).toBe(false)
    expect(touched.world).toBe(true)
    expect(doc.map.width).toBe(5)
    expect(doc.map.layers.ground).toHaveLength(10)

    doc.undo()
    expect(doc.map.width).toBe(3)
    expect(doc.map.layers.ground).toHaveLength(6)
    doc.redo()
    expect(doc.map.width).toBe(5)
  })

  it('keeps the array objects the scene is holding', () => {
    const doc = new MapDoc('p', blankMap('r', 3, 2, 't', 14))
    const ground = doc.map.layers.ground
    const npcs = doc.map.npcs
    doc.replaceMap('resize', resizeMap(doc.map, 5, 4, 14))
    expect(doc.map.layers.ground).toBe(ground)
    expect(doc.map.npcs).toBe(npcs)
    doc.undo()
    expect(doc.map.layers.ground).toBe(ground)
  })

  it('reports a resize as dirty and undoes back to clean', () => {
    const doc = new MapDoc('p', blankMap('r', 3, 2, 't', 14))
    doc.replaceMap('resize', resizeMap(doc.map, 4, 2, 14))
    expect(doc.dirty).toBe(true)
    doc.undo()
    expect(doc.dirty).toBe(false)
  })

  it('drops a replace that changes nothing', () => {
    const doc = new MapDoc('p', blankMap('r', 3, 2, 't', 14))
    expect(isNothing(doc.replaceMap('same', resizeMap(doc.map, 3, 2, 14)))).toBe(true)
    expect(doc.canUndo).toBe(false)
  })
})

describe('warps', () => {
  it('validates and finds a warp by tile', () => {
    const map = blankMap('w', 3, 3, 'data/tilesets/terrain.json', 14)
    map.warps = [{ id: 'north', x: 1, y: 0, to: 'data/maps/cave.json', toX: 4, toY: 9, facing: 'up' }]
    const parsed = parseMap(map, tileset, 'w')
    expect(warpAt(parsed, 1, 0)?.to).toBe('data/maps/cave.json')
    expect(warpAt(parsed, 0, 0)).toBeUndefined()
  })

  it('rejects a warp outside its own map', () => {
    const map = blankMap('w', 2, 2, 'data/tilesets/terrain.json', 14)
    map.warps = [{ id: 'a', x: 5, y: 0, to: 'x.json', toX: 0, toY: 0 }]
    expect(() => parseMap(map, tileset, 'w')).toThrow(/outside/)
  })

  it('rejects a warp with no destination', () => {
    const map = blankMap('w', 2, 2, 'data/tilesets/terrain.json', 14)
    map.warps = [{ id: 'a', x: 0, y: 0, to: '', toX: 0, toY: 0 }]
    expect(() => parseMap(map, tileset, 'w')).toThrow(/"to"/)
  })

  it('rejects duplicate warp ids', () => {
    const map = blankMap('w', 2, 2, 'data/tilesets/terrain.json', 14)
    map.warps = [
      { id: 'a', x: 0, y: 0, to: 'x.json', toX: 0, toY: 0 },
      { id: 'a', x: 1, y: 0, to: 'x.json', toX: 0, toY: 0 },
    ]
    expect(() => parseMap(map, tileset, 'w')).toThrow(/duplicate/)
  })

  it('accepts a destination tile it cannot check, since it is in another file', () => {
    const map = blankMap('w', 2, 2, 'data/tilesets/terrain.json', 14)
    map.warps = [{ id: 'a', x: 0, y: 0, to: 'x.json', toX: 999, toY: 999 }]
    expect(() => parseMap(map, tileset, 'w')).not.toThrow()
  })

  it('treats a map with no warps as having none', () => {
    const map = blankMap('w', 2, 2, 'data/tilesets/terrain.json', 14)
    delete (map as Partial<GameMap>).warps
    expect(parseMap(map, tileset, 'w').warps).toEqual([])
  })
})
