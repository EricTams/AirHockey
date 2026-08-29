import { LAYER_NAMES, type GameMap, type MapNpc, type MapProp, type MapWarp } from '../world/map'
import type { MapEvent } from '../world/event'

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
  // Omitted when the map has never been given one, so a map authored before
  // there were hours still serialises byte for byte.
  if (map.hour !== undefined) out.push(`  "hour": ${map.hour},`)

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

  // Optional blocks are omitted entirely when empty, so a map with no props and
  // no warps still looks like the hand-authored one.
  const hasProps = map.props.length > 0
  const hasWarps = map.warps.length > 0
  const hasEvents = map.events.length > 0
  out.push(...block('npcs', map.npcs.map(npcLines), hasProps || hasWarps || hasEvents))
  if (hasProps) out.push(...block('props', map.props.map(propLines), hasWarps || hasEvents))
  if (hasWarps) out.push(...block('warps', map.warps.map(warpLines), hasEvents))
  if (hasEvents) out.push(...eventBlock(map.events))

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

function warpLines(warp: MapWarp): string[] {
  const lines = [
    `"id": ${JSON.stringify(warp.id)},`,
    `"x": ${warp.x}, "y": ${warp.y},`,
    `"to": ${JSON.stringify(warp.to)},`,
    `"toX": ${warp.toX}, "toY": ${warp.toY}`,
  ]
  if (warp.facing !== undefined) lines.push(`"facing": ${JSON.stringify(warp.facing)}`)
  return commas(lines)
}

/**
 * Events are the one part of a map that is a tree rather than a row of fields,
 * so they are rendered by ordinary JSON pretty-printing and then re-indented.
 * Hand-laying out nested conditionals would be a small pretty-printer with its
 * own bugs, and the payoff — a slightly narrower diff — is not worth it. The
 * grids, which are what a tile diff is read for, keep their own layout.
 */
function eventBlock(events: readonly MapEvent[]): string[] {
  const body = JSON.stringify(events, null, 2).split('\n')
  return ['  "events": ' + body[0], ...body.slice(1).map((l) => '  ' + l)]
}

/** Put a comma after every line but the last, whatever was appended. */
function commas(lines: string[]): string[] {
  return lines.map((line, i) => {
    const bare = line.endsWith(',') ? line.slice(0, -1) : line
    return i === lines.length - 1 ? bare : bare + ','
  })
}
