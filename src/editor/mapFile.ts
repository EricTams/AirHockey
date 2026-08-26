import { LAYER_NAMES, type GameMap, type MapNpc, type MapProp } from '../world/map'

/**
 * Serialise a map the way a person would have written it.
 *
 * `JSON.stringify(map, null, 2)` puts every one of a 20x12 map's 720 tile
 * indices on its own line, which turns a one-tile edit into a 700-line diff and
 * makes the file unreadable to anyone checking what changed. The handoff's
 * invariant is one grid row per line, and this is what keeps it.
 *
 * It is also written to reproduce the hand-authored `overworld.json` byte for
 * byte, so the first save the editor makes is not a whole-file rewrite. There
 * is a test that holds it to that.
 */

/** Width of `-1`, the narrowest value that means anything in a grid. */
const MIN_FIELD = 2

export function serializeMap(map: GameMap): string {
  const out: string[] = ['{']
  out.push(`  "id": ${JSON.stringify(map.id)},`)
  out.push(`  "width": ${map.width},`)
  out.push(`  "height": ${map.height},`)
  out.push(`  "tileset": ${JSON.stringify(map.tileset)},`)

  out.push('  "layers": {')
  LAYER_NAMES.forEach((name, i) => {
    out.push(`    ${JSON.stringify(name)}: [`)
    out.push(...gridRows(map.layers[name], map.width, 6))
    out.push(`    ]${i === LAYER_NAMES.length - 1 ? '' : ','}`)
  })
  out.push('  },')

  out.push('  "collision": [')
  out.push(...gridRows(map.collision, map.width, 4))
  out.push('  ],')

  const start = map.playerStart
  out.push(`  "playerStart": { "x": ${start.x}, "y": ${start.y}, ` +
    `"facing": ${JSON.stringify(start.facing)} },`)

  const hasProps = map.props.length > 0
  out.push(...block('npcs', map.npcs.map(npcLines), hasProps))
  if (hasProps) out.push(...block('props', map.props.map(propLines), false))

  out.push('}')
  return out.join('\n') + '\n'
}

/**
 * One line per grid row, every number right-aligned to the widest in the grid
 * so the columns line up and a changed cell is visible in a diff.
 *
 * The field is never narrower than two characters, which is what `-1` — the
 * empty tile, and the narrowest meaningful value the format has — occupies. It
 * keeps an all-zero collision grid in the same columns as the layers above it.
 */
function gridRows(cells: readonly number[], width: number, indent: number): string[] {
  const pad = cells.reduce((n, v) => Math.max(n, String(v).length), MIN_FIELD)
  const margin = ' '.repeat(indent)
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += width) {
    const row = cells.slice(i, i + width).map((v) => String(v).padStart(pad)).join(', ')
    const last = i + width >= cells.length
    rows.push(margin + row + (last ? '' : ','))
  }
  return rows
}

/**
 * An array of objects, each rendered as its own lines. An empty array collapses
 * to `[]` rather than leaving a gap, and is omitted entirely for props, which
 * the format treats as optional.
 */
function block(key: string, entries: string[][], trailingComma: boolean): string[] {
  const comma = trailingComma ? ',' : ''
  if (entries.length === 0) return [`  ${JSON.stringify(key)}: []${comma}`]
  const out = [`  ${JSON.stringify(key)}: [`]
  entries.forEach((lines, i) => {
    out.push('    {')
    out.push(...lines.map((l) => '      ' + l))
    out.push(`    }${i === entries.length - 1 ? '' : ','}`)
  })
  out.push(`  ]${comma}`)
  return out
}

function npcLines(npc: MapNpc): string[] {
  const lines = [
    `"id": ${JSON.stringify(npc.id)},`,
    `"character": ${JSON.stringify(npc.character)},`,
    // x and y share a line: they are one fact about the NPC, not two.
    `"x": ${npc.x}, "y": ${npc.y},`,
    `"facing": ${JSON.stringify(npc.facing)}`,
  ]
  if (npc.dialogue !== undefined) lines.push(`"dialogue": ${JSON.stringify(npc.dialogue)}`)
  if (npc.battle !== undefined) lines.push(`"battle": ${JSON.stringify(npc.battle)}`)
  if (npc.tint !== undefined) lines.push(`"tint": ${npc.tint}`)
  return commas(lines)
}

function propLines(prop: MapProp): string[] {
  return commas([
    `"id": ${JSON.stringify(prop.id)},`,
    `"prop": ${JSON.stringify(prop.prop)},`,
    `"x": ${prop.x}, "y": ${prop.y}`,
  ])
}

/** Put a comma after every line but the last, whatever was appended. */
function commas(lines: string[]): string[] {
  return lines.map((line, i) => {
    const bare = line.endsWith(',') ? line.slice(0, -1) : line
    return i === lines.length - 1 ? bare : bare + ','
  })
}
