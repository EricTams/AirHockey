import { GRID_LEGEND, type CellKind, type Tileset } from '../world/tileset'

/**
 * Measuring a freshly imported sheet.
 *
 * This measures; it does not guess. A cell that is covered edge to edge can be
 * painted into a tile layer without dragging transparency along with it, and
 * that is the only claim made here. Everything else — which cells are ground
 * and which are the face of a building, where one object ends and the next
 * begins — is a designer's call, made in the review screen.
 *
 * There used to be an automatic prop finder here that boxed 8-connected runs of
 * partly covered cells. It was removed rather than tuned. On the city sheet it
 * returned seven boxes for sixty-odd objects, one of them 41x10 cells, because
 * a canopy overhanging its neighbour's trunk is indistinguishable from one
 * object at cell resolution. A proposal that wrong is worse than none: it reads
 * as an answer, and the designer's job becomes deleting it before starting.
 *
 * So an unclassified sheet reports no props, and says so — `describeTileset`
 * tags it DEFAULT precisely so "no props" is not mistaken for "no props here".
 */

/** Alpha at or above this counts as covered. Below it is antialiasing. */
const OPAQUE = 250
/** A cell this covered is treated as solid art rather than a sprite on space. */
const FULL_COVERAGE = 0.995

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
 * Classify from the measurements: covered edge to edge means paintable, and
 * anything else means unused until a designer says otherwise.
 *
 * A partly covered cell is usually a sprite standing on transparency, so it is
 * left unused rather than made paintable — painting it into a tile layer would
 * tile the transparency with it. Marking which of those cells form an object is
 * the review screen's work, not this function's.
 */
export function proposeSheet(image: Rgba, tilePx: number): SheetProposal {
  const { cols, rows, stats } = measureCells(image, tilePx)
  const cells: CellKind[] = stats.map((s) => (s.coverage >= FULL_COVERAGE ? 'tile' : 'unused'))

  return {
    cols,
    rows,
    cells,
    solid: new Array<boolean>(cols * rows).fill(false),
    stats,
  }
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
