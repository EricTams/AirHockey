import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeTileset, parseTileset } from '../src/world/tileset'
import { parseMap, blockedAt, tileAt, inBounds, LAYER_NAMES } from '../src/world/map'
import { layerQuadCount } from '../src/world/tileLayer'

const terrain = makeTileset('assets/terrain/tileset-tiles.png', 512, 464, 48)

/** A minimal 2x2 valid map, cloned per test so mutations do not leak. */
function tinyMap(): Record<string, unknown> {
  return {
    id: 'tiny',
    width: 2,
    height: 2,
    tileset: 'data/tilesets/terrain.json',
    layers: {
      ground: [14, 14, 14, 14],
      decoration: [-1, 65, -1, -1],
      overhead: [-1, -1, -1, -1],
    },
    collision: [0, 1, 0, 0],
    playerStart: { x: 0, y: 0, facing: 'down' },
    npcs: [{ id: 'a', character: 'data/characters/character-2.json', x: 1, y: 1, facing: 'left' }],
  }
}

describe('parseMap', () => {
  it('accepts a well-formed map', () => {
    const m = parseMap(tinyMap(), terrain)
    expect(m.id).toBe('tiny')
    expect(m.npcs).toHaveLength(1)
  })

  it('reads tiles row-major and reports empty outside the map', () => {
    const m = parseMap(tinyMap(), terrain)
    expect(tileAt(m, 'decoration', 1, 0)).toBe(65)
    expect(tileAt(m, 'decoration', 0, 0)).toBe(-1)
    expect(tileAt(m, 'ground', 5, 5)).toBe(-1)
    expect(inBounds(m, 1, 1)).toBe(true)
    expect(inBounds(m, 2, 0)).toBe(false)
  })

  it('keeps collision independent of tiles, and blocks off-map', () => {
    const m = parseMap(tinyMap(), terrain)
    expect(blockedAt(m, 1, 0)).toBe(true)
    // Same ground tile as its blocked neighbour: passability is its own grid.
    expect(tileAt(m, 'ground', 1, 0)).toBe(tileAt(m, 'ground', 0, 0))
    expect(blockedAt(m, 0, 0)).toBe(false)
    expect(blockedAt(m, -1, 0)).toBe(true)
    expect(blockedAt(m, 0, 2)).toBe(true)
  })

  it('counts only non-empty cells as quads', () => {
    const m = parseMap(tinyMap(), terrain)
    expect(layerQuadCount(m, 'ground')).toBe(4)
    expect(layerQuadCount(m, 'decoration')).toBe(1)
    expect(layerQuadCount(m, 'overhead')).toBe(0)
  })

  // The editor writes these files. A bad save must fail at load rather than
  // half-draw a world, so every structural guarantee gets a named error.
  const bad: [string, (m: Record<string, any>) => void, RegExp][] = [
    ['a layer of the wrong length', (m) => { m.layers.ground = [14, 14, 14] }, /3 cells, expected 2x2 = 4/],
    ['a missing layer', (m) => { delete m.layers.overhead }, /layer "overhead" missing/],
    ['a tile index past the tileset', (m) => { m.layers.ground[0] = 90 }, /has tile 90/],
    ['a collision grid of the wrong length', (m) => { m.collision = [0] }, /collision has 1 cells/],
    ['a non-boolean collision value', (m) => { m.collision[0] = 2 }, /expected 0 or 1/],
    ['a player start off the map', (m) => { m.playerStart.x = 2 }, /outside 2x2/],
    ['an invalid facing', (m) => { m.playerStart.facing = 'north' }, /facing "north" invalid/],
    ['an NPC off the map', (m) => { m.npcs[0].y = 9 }, /outside 2x2/],
    ['duplicate NPC ids', (m) => { m.npcs.push({ ...m.npcs[0] }) }, /duplicate id "a"/],
    ['an NPC with no character', (m) => { delete m.npcs[0].character }, /missing "character"/],
    ['a missing id', (m) => { delete m.id }, /missing "id"/],
  ]
  for (const [what, mutate, message] of bad) {
    it(`rejects ${what}`, () => {
      const m = tinyMap()
      mutate(m as Record<string, any>)
      expect(() => parseMap(m, terrain)).toThrow(message)
    })
  }

  it('names the failing cell so an editor bug is locatable', () => {
    const m = tinyMap()
    ;(m.layers as any).ground[3] = 999
    expect(() => parseMap(m, terrain)).toThrow(/cell 3 \(1,1\)/)
  })

  it('allows -1 in every layer, including ground', () => {
    const m = tinyMap()
    ;(m.layers as any).ground = [-1, -1, -1, -1]
    expect(() => parseMap(m, terrain)).not.toThrow()
  })
})

describe('shipped data files', () => {
  const tsDef = JSON.parse(readFileSync('public/data/tilesets/city.json', 'utf8'))
  const raw = JSON.parse(readFileSync('public/data/maps/overworld.json', 'utf8'))

  it('the city rider states the sheet the art actually is', () => {
    const ts = parseTileset(tsDef, 'city.json')
    expect(ts.cols).toBe(88)
    expect(ts.rows).toBe(10)
  })

  it('the entry map parses against it', () => {
    const ts = parseTileset(tsDef, 'city.json')
    const m = parseMap(raw, ts, 'overworld.json')
    expect(m.width).toBe(20)
    expect(m.height).toBe(14)
    for (const name of LAYER_NAMES) expect(m.layers[name]).toHaveLength(280)
  })

  it('carries the three opponents with their dialogue and battles', () => {
    const ts = parseTileset(tsDef, 'city.json')
    const m = parseMap(raw, ts, 'overworld.json')
    const opponents = m.npcs.filter((n) => n.battle)
    expect(opponents.map((n) => n.id)).toEqual(['blorb', 'wing', 'plumber'])
    for (const n of opponents) {
      expect(n.dialogue).toMatch(/^data\/dialogue\/.+\.json$/)
      expect(n.battle).toMatch(/^data\/battles\/.+\.json$/)
    }
  })

  it('starts the player on a passable tile that no NPC occupies', () => {
    const ts = parseTileset(tsDef, 'city.json')
    const m = parseMap(raw, ts, 'overworld.json')
    const { x, y } = m.playerStart
    expect(blockedAt(m, x, y)).toBe(false)
    expect(m.npcs.some((n) => n.x === x && n.y === y)).toBe(false)
  })
})
