import { GRID_LEGEND, type CellKind, type PropDef, type Tileset } from '../world/tileset'

/**
 * Guessing what is on a freshly imported sheet.
 *
 * Read the handoff's decision 5 before touching this. Measured per-cell alpha
 * coverage on the shipped terrain sheet climbs from 0.13% to 11.8% with no gap
 * anywhere in the range, so no threshold cleanly separates real art from
 * outline bleed; and 8-connected clustering merges its terrace and its plateau
 * into a single blob. That is not a bug to be tuned out — it is what real art
 * looks like, and it is why the rider file carries `reviewed`.
 *
 * So this is written to be a starting point a designer corrects, not an answer.
 * It is deliberately simple and legible rather than clever: an elaborate
 * heuristic would be wrong in ways that are harder to see and harder to fix.
 */

/** Alpha at or above this counts as covered. Below it is antialiasing. */
const OPAQUE = 250
/** A cell this covered is treated as solid art rather than a sprite on space. */
const FULL_COVERAGE = 0.995
/** Below this a cell is treated as empty sheet rather than art. */
const EMPTY_COVERAGE = 0.02

export interface CellStats {
  /** Fraction of the cell's pixels with any alpha at all. */
  coverage: number
  /** Fraction that are fully opaque. */
  opaque: number
}

export interface SheetProposal {
  cols: number
  rows: number
  cells: CellKind[]
  solid: boolean[]
  props: PropDef[]
  stats: CellStats[]
}

export interface Rgba {
  width: number
  height: number
  /** RGBA bytes, four per pixel, as a canvas gives them. */
  data: Uint8ClampedArray
}

/** Per-cell coverage over the usable grid. The partial right/bottom margin is
 *  not addressable and is not measured. */
export function measureCells(image: Rgba, tilePx: number): {
  cols: number; rows: number; stats: CellStats[]
} {
  const cols = Math.floor(image.width / tilePx)
  const rows = Math.floor(image.height / tilePx)
  const stats: CellStats[] = []
  const area = tilePx * tilePx

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let any = 0
      let full = 0
      for (let y = 0; y < tilePx; y++) {
        const line = ((row * tilePx + y) * image.width + col * tilePx) * 4
        for (let x = 0; x < tilePx; x++) {
          const alpha = image.data[line + x * 4 + 3]!
          if (alpha > 0) any++
          if (alpha >= OPAQUE) full++
        }
      }
      stats.push({ coverage: any / area, opaque: full / area })
    }
  }
  return { cols, rows, stats }
}

/**
 * Propose a classification from the measurements.
 *
 * Fully covered cells become paintable tiles; empty ones become unused; and
 * everything in between is treated as a candidate for a prop, because a sprite
 * standing on transparency is what a partially covered cell usually is.
 */
export function proposeSheet(image: Rgba, tilePx: number): SheetProposal {
  const { cols, rows, stats } = measureCells(image, tilePx)
  const cells: CellKind[] = []
  const partial: boolean[] = []

  for (const s of stats) {
    if (s.coverage >= FULL_COVERAGE) { cells.push('tile'); partial.push(false) }
    else if (s.coverage <= EMPTY_COVERAGE) { cells.push('unused'); partial.push(false) }
    else { cells.push('unused'); partial.push(true) }
  }

  return {
    cols,
    rows,
    cells,
    solid: new Array<boolean>(cols * rows).fill(false),
    props: clusterProps(partial, cols, rows),
    stats,
  }
}

/**
 * Bounding boxes around 8-connected runs of partially covered cells.
 *
 * Eight-connected rather than four, because a tree's canopy overhanging its
 * trunk touches diagonally; the cost is that two objects a diagonal apart merge,
 * which on the shipped sheet they do. The review screen is how that gets fixed.
 */
export function clusterProps(partial: readonly boolean[], cols: number, rows: number): PropDef[] {
  const seen = new Uint8Array(cols * rows)
  const props: PropDef[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const start = row * cols + col
      if (!partial[start] || seen[start]) continue

      let minCol = col, maxCol = col, minRow = row, maxRow = row
      const queue = [start]
      seen[start] = 1
      while (queue.length > 0) {
        const at = queue.pop()!
        const cx = at % cols
        const cy = Math.floor(at / cols)
        minCol = Math.min(minCol, cx); maxCol = Math.max(maxCol, cx)
        minRow = Math.min(minRow, cy); maxRow = Math.max(maxRow, cy)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
            const index = ny * cols + nx
            if (seen[index] || !partial[index]) continue
            seen[index] = 1
            queue.push(index)
          }
        }
      }

      const w = maxCol - minCol + 1
      const h = maxRow - minRow + 1
      props.push({
        id: `prop-${props.length + 1}`,
        name: `Prop ${props.length + 1}`,
        col: minCol,
        row: minRow,
        w,
        h,
        // Bottom-centre, matching where sprites anchor.
        anchor: [Math.floor(w / 2), h - 1],
        solid: true,
      })
    }
  }
  return props
}

/** The rider's grid rows, one character per cell, per GRID_LEGEND. */
export function gridRows(
  cells: readonly CellKind[], solid: readonly boolean[], cols: number, rows: number,
): string[] {
  const letter = (kind: CellKind, isSolid: boolean): string => {
    for (const [ch, entry] of Object.entries(GRID_LEGEND)) {
      if (entry.kind === kind && entry.solid === isSolid) return ch
    }
    // 'unused' has no solid form; fall back to the plain one rather than
    // writing a character the parser would reject.
    return kind === 'tile' ? 'T' : '.'
  }
  const out: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      line += letter(cells[i] ?? 'unused', solid[i] ?? false)
    }
    out.push(line)
  }
  return out
}

/** A tileset's grid as editable arrays, for the review screen to work on. */
export function editableFrom(tileset: Tileset): { cells: CellKind[]; solid: boolean[] } {
  return { cells: [...tileset.cells], solid: [...tileset.solid] }
}
