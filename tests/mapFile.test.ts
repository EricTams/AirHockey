import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { serializeMap } from '../src/editor/mapFile'
import { parseMap } from '../src/world/map'
import { parseTileset } from '../src/world/tileset'
import { blankMap } from '../src/editor/mapDoc'

const tileset = parseTileset(
  JSON.parse(readFileSync('public/data/tilesets/city.json', 'utf8')),
  'data/tilesets/city.json',
)
const shippedText = readFileSync('public/data/maps/overworld.json', 'utf8')
const shipped = parseMap(JSON.parse(shippedText), tileset, 'overworld')

describe('serializeMap', () => {
  it('reproduces the hand-authored map byte for byte', () => {
    // So the designer's first save is not a whole-file rewrite that buries the
    // one tile they actually changed.
    expect(serializeMap(shipped)).toBe(shippedText)
  })

  it('keeps one grid row per line', () => {
    const lines = serializeMap(shipped).split('\n')
    const groundStart = lines.indexOf('    "ground": [')
    const groundEnd = lines.indexOf('    ],', groundStart)
    expect(groundEnd - groundStart - 1).toBe(shipped.height)
  })

  /**
   * A map authored before there were hours has no hour, and must serialise
   * exactly as it did — which is what keeps the byte-for-byte test above
   * meaningful once the designer starts using the slider.
   */
  it('omits the hour a map has never been given', () => {
    expect(serializeMap(shipped)).not.toContain('"hour"')
  })

  it('round-trips an hour once one is set', () => {
    const dusk = { ...shipped, hour: 18 }
    expect(serializeMap(dusk)).toContain('  "hour": 18,')
    expect(parseMap(JSON.parse(serializeMap(dusk)), tileset, 'dusk').hour).toBe(18)
  })

  it("round-trips through the game's own validation", () => {
    const again = parseMap(JSON.parse(serializeMap(shipped)), tileset, 'again')
    expect(again).toEqual(shipped)
  })

  it('survives a tile edit without reflowing the file', () => {
    const edited = structuredClone(shipped)
    edited.layers.ground[0] = 7
    const before = serializeMap(shipped).split('\n')
    const after = serializeMap(edited).split('\n')
    expect(after).toHaveLength(before.length)
    const changed = after.filter((line, i) => line !== before[i])
    expect(changed).toHaveLength(1)
  })

  it('aligns columns so a changed cell is visible in a diff', () => {
    const map = blankMap('pad', 3, 1, 't', 100)
    map.layers.ground = [1, 100, 7]
    const ground = serializeMap(map).split('\n').find((l) => l.includes('100'))
    expect(ground).toBe('        1, 100,   7')
  })

  it('emits an empty npcs array rather than omitting it', () => {
    const text = serializeMap(blankMap('empty', 2, 2, 't', 0))
    expect(text).toContain('"npcs": []')
  })

  it('omits props entirely when there are none, as the format allows', () => {
    expect(serializeMap(blankMap('empty', 2, 2, 't', 0))).not.toContain('"props"')
  })

  it('writes props when there are some', () => {
    const map = blankMap('withprops', 2, 2, 't', 0)
    map.props = [{ id: 'tree-1', prop: 'tree', x: 1, y: 1 }]
    const text = serializeMap(map)
    expect(text).toContain('"props": [')
    expect(text).toContain('"x": 1, "y": 1')
  })

  it('ends with a newline, like every other file in the project', () => {
    expect(serializeMap(shipped).endsWith('}\n')).toBe(true)
  })
})
