import { TILE } from '../core/config'

/**
 * A tileset is a sheet sliced on a fixed grid anchored at the top-left, plus a
 * rider file saying what each cell in that grid actually is.
 *
 * The grid origin is not a free choice: `.artlog/decisions.json` ("grid-origin")
 * settled it against the art, and every tile index in every map file depends on
 * it. A sheet whose dimensions are not exact multiples of the tile size — the
 * shipped terrain sheet is 512x464, or 10.67 x 9.67 cells — has the remainder
 * as unused margin, so the usable grid floors rather than rounds.
 *
 * The rider carries the tile/prop split, which is a real distinction in this
 * engine rather than an editor convenience:
 *
 *   tile — a flat quad in the XZ plane, merged into one of the three layer
 *          meshes. Stays flat when the camera tilts.
 *   prop — a multi-cell region placed as a billboard, y-sorted against
 *          sprites. Stands upright when the camera tilts (see Projection).
 *
 * The rider also states the sheet's pixel size rather than measuring it from
 * the loaded image, so a placeholder substitution cannot silently re-index
 * every map that references the sheet.
 */

/** What a grid cell may be used for. */
export type CellKind = 'unused' | 'tile'

/** Grid legend, one character per cell in the rider's `grid` rows. */
export const GRID_LEGEND: Record<string, { kind: CellKind; solid: boolean }> = {
  '.': { kind: 'unused', solid: false },
  T: { kind: 'tile', solid: false },
  S: { kind: 'tile', solid: true },
}

/**
 * A multi-cell region of the sheet placed as a single object.
 *
 * `anchor` is the cell within the region that lands on the target tile, so a
 * tree placed at (5,5) stands on (5,5) rather than hanging its bounding box
 * from there. It defaults to bottom-centre, which is where sprites anchor.
 */
export interface PropDef {
  id: string
  name: string
  col: number
  row: number
  w: number
  h: number
  anchor: [number, number]
  /** Suggested collision when placed. The map's grid stays authoritative. */
  solid: boolean
}

export interface Tileset {
  readonly id: string
  /** Project-relative path to the sheet image. */
  readonly image: string
  /** Cell edge in source pixels. */
  readonly tilePx: number
  readonly sheetW: number
  readonly sheetH: number
  /** Usable cells across and down, excluding the partial margin. */
  readonly cols: number
  readonly rows: number
  /**
   * False until a designer has confirmed the importer's guesses. The importer
   * classifies from pixel coverage, which on real art is a proposal, not an
   * answer — the shipped terrain sheet's outline bleed makes its terrace and
   * plateau look like one connected object.
   */
  readonly reviewed: boolean
  /** Per-index kind, length cols*rows. */
  readonly cells: readonly CellKind[]
  /**
   * Per-index collision suggestion, applied when the editor paints a cell.
   * Doc §6.1 keeps the map's collision grid separate and authoritative; this
   * only seeds it.
   */
  readonly solid: readonly boolean[]
  readonly props: readonly PropDef[]
  /** Optional human labels for individual cells, by index. */
  readonly names: Readonly<Record<number, string>>
}

/** Index used in a map layer for "no tile here". */
export const EMPTY_TILE = -1

function fail(where: string, msg: string): never {
  throw new Error(`${where}: ${msg}`)
}

/**
 * Build a tileset from geometry alone, treating every cell as a paintable
 * tile. This is the shape a freshly imported sheet takes before anyone has
 * classified it.
 */
export function makeTileset(
  image: string, sheetW: number, sheetH: number, tilePx: number = TILE, id = image,
): Tileset {
  if (tilePx <= 0) throw new Error(`tileset ${image}: tilePx must be positive, got ${tilePx}`)
  const cols = Math.floor(sheetW / tilePx)
  const rows = Math.floor(sheetH / tilePx)
  if (cols < 1 || rows < 1) {
    throw new Error(`tileset ${image}: ${sheetW}x${sheetH} is smaller than one ${tilePx}px cell`)
  }
  const n = cols * rows
  return {
    id, image, tilePx, sheetW, sheetH, cols, rows,
    reviewed: false,
    cells: new Array<CellKind>(n).fill('tile'),
    solid: new Array<boolean>(n).fill(false),
    props: [],
    names: {},
  }
}

/** Parse a rider file. `grid`, `props` and `names` are all optional. */
export function parseTileset(raw: unknown, path: string): Tileset {
  const d = raw as Record<string, unknown>
  if (!d || typeof d !== 'object') fail(path, 'not an object')
  if (typeof d.image !== 'string' || !d.image) fail(path, 'missing "image"')
  if (typeof d.tilePx !== 'number' || d.tilePx <= 0) fail(path, 'missing or invalid "tilePx"')
  const size = d.size
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => typeof n === 'number' && n > 0)) {
    fail(path, 'missing "size" as [width, height]')
  }
  const id = typeof d.id === 'string' && d.id ? d.id : d.image
  const base = makeTileset(d.image, size[0] as number, size[1] as number, d.tilePx, id)
  const { cols, rows } = base
  const n = cols * rows

  const cells = [...base.cells]
  const solid = [...base.solid]
  if (d.grid !== undefined) {
    const g = d.grid
    if (!Array.isArray(g)) fail(path, '"grid" must be an array of row strings')
    if (g.length !== rows) fail(path, `"grid" has ${g.length} rows, expected ${rows}`)
    g.forEach((line, y) => {
      if (typeof line !== 'string') fail(path, `grid row ${y} is not a string`)
      if (line.length !== cols) {
        fail(path, `grid row ${y} is ${line.length} chars, expected ${cols}`)
      }
      for (let x = 0; x < cols; x++) {
        const ch = line[x]!
        const entry = GRID_LEGEND[ch]
        if (!entry) {
          fail(path, `grid row ${y} col ${x}: unknown character "${ch}" ` +
            `(expected one of ${Object.keys(GRID_LEGEND).join('')})`)
        }
        cells[y * cols + x] = entry.kind
        solid[y * cols + x] = entry.solid
      }
    })
  }

  const props: PropDef[] = []
  if (d.props !== undefined) {
    if (!Array.isArray(d.props)) fail(path, '"props" must be an array')
    const seen = new Set<string>()
    d.props.forEach((p: Record<string, unknown>, i) => {
      const at = `${path}: prop[${i}]`
      if (typeof p?.id !== 'string' || !p.id) fail(at, 'missing "id"')
      if (seen.has(p.id)) fail(at, `duplicate id "${p.id}"`)
      seen.add(p.id)
      for (const k of ['col', 'row', 'w', 'h'] as const) {
        if (!Number.isInteger(p[k])) fail(at, `"${k}" must be an integer`)
      }
      const col = p.col as number, row = p.row as number
      const w = p.w as number, h = p.h as number
      if (w < 1 || h < 1) fail(at, `size ${w}x${h} must be at least 1x1`)
      if (col < 0 || row < 0 || col + w > cols || row + h > rows) {
        fail(at, `region ${col},${row} ${w}x${h} does not fit the ${cols}x${rows} grid`)
      }
      // Bottom-centre by default, matching where sprites anchor.
      const anchor = (p.anchor as [number, number] | undefined) ?? [Math.floor(w / 2), h - 1]
      if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every(Number.isInteger)) {
        fail(at, '"anchor" must be [col, row] within the region')
      }
      if (anchor[0] < 0 || anchor[0] >= w || anchor[1] < 0 || anchor[1] >= h) {
        fail(at, `anchor ${anchor[0]},${anchor[1]} is outside the ${w}x${h} region`)
      }
      props.push({
        id: p.id, name: typeof p.name === 'string' && p.name ? p.name : p.id,
        col, row, w, h, anchor, solid: p.solid === true,
      })
    })
  }

  const names: Record<number, string> = {}
  if (d.names !== undefined) {
    if (typeof d.names !== 'object' || d.names === null) fail(path, '"names" must be an object')
    for (const [k, v] of Object.entries(d.names as Record<string, unknown>)) {
      const idx = Number(k)
      if (!Number.isInteger(idx) || idx < 0 || idx >= n) fail(path, `names key "${k}" is not a cell index`)
      if (typeof v !== 'string') fail(path, `names["${k}"] must be a string`)
      names[idx] = v
    }
  }

  return {
    ...base,
    reviewed: d.reviewed === true,
    cells, solid, props, names,
  }
}

/** Total addressable cells. Valid indices are 0..count-1, plus EMPTY_TILE. */
export function tileCount(ts: Tileset): number {
  return ts.cols * ts.rows
}

export interface Cell {
  readonly col: number
  readonly row: number
}

/** Row-major: index 0 is the top-left cell, index `cols` starts the second row. */
export function cellOf(ts: Tileset, index: number): Cell {
  if (!isTileIndex(ts, index)) throw new Error(`tile index ${index} out of range for ${ts.image}`)
  return { col: index % ts.cols, row: Math.floor(index / ts.cols) }
}

export function indexOf(ts: Tileset, col: number, row: number): number {
  if (col < 0 || col >= ts.cols || row < 0 || row >= ts.rows) {
    throw new Error(`cell ${col},${row} out of range for ${ts.image} (${ts.cols}x${ts.rows})`)
  }
  return row * ts.cols + col
}

/** True for a real, in-range tile. EMPTY_TILE is deliberately not one. */
export function isTileIndex(ts: Tileset, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < tileCount(ts)
}

/**
 * True if the rider marks this cell as usable in a tile layer. The palette
 * offers these; a map referencing anything else still loads, because the
 * rider is a designer's classification and not a validity rule.
 */
export function isPaintable(ts: Tileset, index: number): boolean {
  return isTileIndex(ts, index) && ts.cells[index] === 'tile'
}

export function propById(ts: Tileset, id: string): PropDef | undefined {
  return ts.props.find((p) => p.id === id)
}

/**
 * UV rect for a rectangular region of cells, inset by a fraction of a texel so
 * neighbours never bleed across the seam under nearest filtering.
 */
export function regionUv(
  ts: Tileset, col: number, row: number, w = 1, h = 1, eps = 0.01,
): { u0: number; u1: number; v0: number; v1: number } {
  return {
    u0: (col * ts.tilePx + eps) / ts.sheetW,
    u1: ((col + w) * ts.tilePx - eps) / ts.sheetW,
    v0: 1 - ((row + h) * ts.tilePx - eps) / ts.sheetH,
    v1: 1 - (row * ts.tilePx + eps) / ts.sheetH,
  }
}

/** UV rect for a single cell by index. */
export function cellUv(ts: Tileset, index: number, eps = 0.01) {
  const { col, row } = cellOf(ts, index)
  return regionUv(ts, col, row, 1, 1, eps)
}

/** UV rect covering a whole prop region. */
export function propUv(ts: Tileset, prop: PropDef, eps = 0.01) {
  return regionUv(ts, prop.col, prop.row, prop.w, prop.h, eps)
}
