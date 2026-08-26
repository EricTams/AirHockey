import { fetchJson } from '../core/paths'
import { parseEvent, type MapEvent } from './event'
import { parseTileset, isTileIndex, EMPTY_TILE, type Tileset } from './tileset'
import type { Facing } from './character'

/**
 * Map data, per doc §6.1. Two deliberate divergences from the doc's sketch:
 *
 * - `tileset` points at a tileset descriptor (see TilesetDef), not straight at
 *   a PNG. The grid depends on the sheet's pixel dimensions, and reading those
 *   off a loaded image makes every tile index in the file depend on whether the
 *   image loaded — a placeholder substitution would silently re-index the map.
 *   The descriptor states the size, so indices mean the same thing offline.
 * - An NPC names a character definition (frame size, per-direction sheets)
 *   rather than a bare sprite PNG, because that is what the runtime actually
 *   consumes. `tint` is carried because the three shipped NPCs share one sheet.
 */

export const LAYER_NAMES = ['ground', 'decoration', 'overhead'] as const
export type LayerName = (typeof LAYER_NAMES)[number]

/** An instance of a tileset prop placed on the map. */
export interface MapProp {
  /** Unique within the map, so the editor can address one instance. */
  id: string
  /** PropDef id within the map's tileset. */
  prop: string
  x: number
  y: number
}

/**
 * A tile that moves the player to another map (doc §10: the first post-v1
 * addition, and the format was written to tolerate it).
 *
 * The destination tile cannot be validated here: it lives in a file this map
 * does not load. A warp pointing off the edge of its destination lands the
 * player at that map's playerStart instead of nowhere.
 */
export interface MapWarp {
  id: string
  x: number
  y: number
  /** Project-relative path to the destination map. */
  to: string
  toX: number
  toY: number
  /** Facing on arrival. Omitted keeps whichever way the player was walking. */
  facing?: Facing
}

export interface MapNpc {
  id: string
  /** Project-relative path to a character definition JSON. */
  character: string
  x: number
  y: number
  facing: Facing
  dialogue?: string
  battle?: string
  /** Multiplied into the sprite; lets one sheet serve several NPCs. */
  tint?: number
}

export interface GameMap {
  id: string
  width: number
  height: number
  /** Project-relative path to the tileset descriptor JSON. */
  tileset: string
  layers: Record<LayerName, number[]>
  /** Row-major, 1 = impassable. Separate from tiles by design (doc §6.1). */
  collision: number[]
  playerStart: { x: number; y: number; facing: Facing }
  npcs: MapNpc[]
  /** Multi-cell props placed as billboards. Optional; absent means none. */
  props: MapProp[]
  /** Tiles that lead to other maps. Optional; absent means none. */
  warps: MapWarp[]
  /** Events standing on the map. Optional; absent means none. */
  events: MapEvent[]
}

/** A map paired with the resolved tileset its indices refer to. */
export interface LoadedMap {
  map: GameMap
  tileset: Tileset
}

const FACINGS: readonly string[] = ['up', 'down', 'left', 'right']

function fail(where: string, msg: string): never {
  throw new Error(`${where}: ${msg}`)
}

/**
 * Validate raw map JSON against a tileset and return it typed.
 *
 * Deliberately strict and loud. The editor writes these files, so a malformed
 * save must surface at load rather than degrade into a half-drawn world.
 */
export function parseMap(raw: unknown, tileset: Tileset, path = 'map'): GameMap {
  const m = raw as Partial<GameMap>
  if (!m || typeof m !== 'object') fail(path, 'not an object')
  if (typeof m.id !== 'string' || !m.id) fail(path, 'missing "id"')

  const { width, height } = m
  if (!Number.isInteger(width) || (width as number) < 1) fail(path, `invalid width ${width}`)
  if (!Number.isInteger(height) || (height as number) < 1) fail(path, `invalid height ${height}`)
  const w = width as number
  const h = height as number
  const area = w * h

  if (typeof m.tileset !== 'string' || !m.tileset) fail(path, 'missing "tileset"')

  const layers = m.layers
  if (!layers || typeof layers !== 'object') fail(path, 'missing "layers"')
  for (const name of LAYER_NAMES) {
    const cells = (layers as Record<string, unknown>)[name]
    if (!Array.isArray(cells)) fail(path, `layer "${name}" missing`)
    if (cells.length !== area) {
      fail(path, `layer "${name}" has ${cells.length} cells, expected ${w}x${h} = ${area}`)
    }
    for (let i = 0; i < cells.length; i++) {
      const t = cells[i]
      if (t !== EMPTY_TILE && !isTileIndex(tileset, t as number)) {
        fail(path, `layer "${name}" cell ${i} (${i % w},${Math.floor(i / w)}) has tile ${t}, ` +
          `not -1 or 0..${tileset.cols * tileset.rows - 1}`)
      }
    }
  }

  const collision = m.collision
  if (!Array.isArray(collision)) fail(path, 'missing "collision"')
  if (collision.length !== area) {
    fail(path, `collision has ${collision.length} cells, expected ${area}`)
  }
  for (let i = 0; i < collision.length; i++) {
    if (collision[i] !== 0 && collision[i] !== 1) {
      fail(path, `collision cell ${i} is ${collision[i]}, expected 0 or 1`)
    }
  }

  const start = m.playerStart
  if (!start || typeof start !== 'object') fail(path, 'missing "playerStart"')
  if (!inRange(start.x, w) || !inRange(start.y, h)) {
    fail(path, `playerStart ${start.x},${start.y} is outside ${w}x${h}`)
  }
  if (!FACINGS.includes(start.facing)) fail(path, `playerStart facing "${start.facing}" invalid`)

  const npcs = m.npcs ?? []
  if (!Array.isArray(npcs)) fail(path, '"npcs" must be an array')
  const seen = new Set<string>()
  npcs.forEach((n, i) => {
    const at = `${path}: npc[${i}]`
    if (typeof n.id !== 'string' || !n.id) fail(at, 'missing "id"')
    if (seen.has(n.id)) fail(at, `duplicate id "${n.id}"`)
    seen.add(n.id)
    if (typeof n.character !== 'string' || !n.character) fail(at, 'missing "character"')
    if (!inRange(n.x, w) || !inRange(n.y, h)) fail(at, `tile ${n.x},${n.y} is outside ${w}x${h}`)
    if (!FACINGS.includes(n.facing)) fail(at, `facing "${n.facing}" invalid`)
  })

  const props = m.props ?? []
  if (!Array.isArray(props)) fail(path, '"props" must be an array')
  const seenProps = new Set<string>()
  props.forEach((p, i) => {
    const at = `${path}: prop[${i}]`
    if (typeof p.id !== 'string' || !p.id) fail(at, 'missing "id"')
    if (seenProps.has(p.id)) fail(at, `duplicate id "${p.id}"`)
    seenProps.add(p.id)
    if (typeof p.prop !== 'string' || !p.prop) fail(at, 'missing "prop"')
    if (!tileset.props.some((d) => d.id === p.prop)) {
      fail(at, `no prop "${p.prop}" in tileset ${tileset.id}`)
    }
    if (!inRange(p.x, w) || !inRange(p.y, h)) fail(at, `tile ${p.x},${p.y} is outside ${w}x${h}`)
  })

  const warps = m.warps ?? []
  if (!Array.isArray(warps)) fail(path, '"warps" must be an array')
  const seenWarps = new Set<string>()
  warps.forEach((wp, i) => {
    const at = `${path}: warp[${i}]`
    if (typeof wp.id !== 'string' || !wp.id) fail(at, 'missing "id"')
    if (seenWarps.has(wp.id)) fail(at, `duplicate id "${wp.id}"`)
    seenWarps.add(wp.id)
    if (typeof wp.to !== 'string' || !wp.to) fail(at, 'missing "to"')
    if (!inRange(wp.x, w) || !inRange(wp.y, h)) fail(at, `tile ${wp.x},${wp.y} is outside ${w}x${h}`)
    // The destination is in another file, so only its shape can be checked
    // here. Arriving out of bounds falls back to that map's playerStart.
    if (!Number.isInteger(wp.toX) || (wp.toX as number) < 0) fail(at, `invalid "toX" ${wp.toX}`)
    if (!Number.isInteger(wp.toY) || (wp.toY as number) < 0) fail(at, `invalid "toY" ${wp.toY}`)
    if (wp.facing !== undefined && !FACINGS.includes(wp.facing)) {
      fail(at, `facing "${wp.facing}" invalid`)
    }
  })

  const rawEvents = (m as { events?: unknown }).events ?? []
  if (!Array.isArray(rawEvents)) fail(path, '"events" must be an array')
  const seenEvents = new Set<string>()
  const events = rawEvents.map((raw, i) => {
    const ev = parseEvent(raw, `${path}: event[${i}]`)
    if (seenEvents.has(ev.id)) fail(`${path}: event[${i}]`, `duplicate id "${ev.id}"`)
    seenEvents.add(ev.id)
    if (!inRange(ev.x, w) || !inRange(ev.y, h)) {
      fail(`${path}: event[${i}]`, `tile ${ev.x},${ev.y} is outside ${w}x${h}`)
    }
    return ev
  })

  return { ...(m as GameMap), width: w, height: h, npcs, props, warps, events }
}

/** The event standing on a tile, if any. */
export function eventAt(map: GameMap, x: number, y: number): MapEvent | undefined {
  return map.events.find((e) => e.x === x && e.y === y)
}

/** The warp on a tile, if any. */
export function warpAt(map: GameMap, x: number, y: number): MapWarp | undefined {
  return map.warps.find((wp) => wp.x === x && wp.y === y)
}

function inRange(v: unknown, limit: number): boolean {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < limit
}

export async function loadMap(path: string): Promise<LoadedMap> {
  const raw = await fetchJson<unknown>(path)
  const tilesetPath = (raw as Partial<GameMap>)?.tileset
  if (typeof tilesetPath !== 'string' || !tilesetPath) fail(path, 'missing "tileset"')
  const tileset = parseTileset(await fetchJson<unknown>(tilesetPath), tilesetPath)
  return { map: parseMap(raw, tileset, path), tileset }
}

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height
}

/** Tile index at a cell, or EMPTY_TILE outside the map. */
export function tileAt(map: GameMap, layer: LayerName, x: number, y: number): number {
  if (!inBounds(map, x, y)) return EMPTY_TILE
  return map.layers[layer][y * map.width + x]!
}

/** Terrain passability. Off-map counts as blocked; NPC occupancy is separate. */
export function blockedAt(map: GameMap, x: number, y: number): boolean {
  if (!inBounds(map, x, y)) return true
  return map.collision[y * map.width + x] === 1
}
