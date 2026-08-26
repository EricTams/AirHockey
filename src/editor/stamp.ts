import type { Region } from './palette'
import type { Cell } from './tools'

/**
 * Laying a multi-tile palette grab down on the map.
 *
 * Most art on a sheet is bigger than one tile — a house, a cliff face, a
 * three-tile tree — so the palette lets a designer drag out a rectangle. This is
 * what turns that rectangle into writes.
 *
 * The interesting case is a drag. Stamping a fresh copy of the block at every
 * cell the cursor passes through would overlap them a tile apart and produce
 * mush, so stamp positions snap to a lattice anchored at the cell the stroke
 * started on. Dragging a 2x3 grab across the map tiles it continuously, which
 * is what a designer painting a cliff expects.
 *
 * Pure, and separate from the editor for the usual reason: this is the rule,
 * and the rule is what is worth testing.
 */

export interface Write { x: number; y: number; value: number }

/**
 * @param cells   what the tool named — a brush line, a rectangle, a fill region
 * @param region  the palette selection
 * @param origin  the cell the stroke started on; the lattice is anchored here
 * @param cols    columns in the tileset, since a tile index is row * cols + col
 * @param clip    keep writes inside `cells`. Rect and fill are regions and do;
 *                a brush is a stamp and does not, because a block laid at the
 *                cursor is meant to extend past it.
 * @param flat    one value for every cell, for collision and erase, which have
 *                no art to read out of the region
 */
export function stampWrites(
  cells: readonly Cell[],
  region: Region,
  origin: Cell,
  cols: number,
  clip: boolean,
  flat?: number,
): Write[] {
  const allowed = clip ? new Set(cells.map((c) => `${c.x},${c.y}`)) : undefined
  const seen = new Set<string>()
  const out: Write[] = []

  for (const c of cells) {
    // Snap to the lattice the stroke established. Math.floor rather than a
    // remainder, so a stroke running back towards the origin lands on the same
    // lattice rather than a mirrored one.
    const sx = origin.x + Math.floor((c.x - origin.x) / region.w) * region.w
    const sy = origin.y + Math.floor((c.y - origin.y) / region.h) * region.h

    for (let j = 0; j < region.h; j++) {
      for (let i = 0; i < region.w; i++) {
        const x = sx + i
        const y = sy + j
        const key = `${x},${y}`
        if (seen.has(key)) continue
        if (allowed && !allowed.has(key)) continue
        seen.add(key)
        // `flat` may legitimately be 0 — clearing collision — so it is checked
        // for absence rather than for truth.
        out.push({
          x, y,
          value: flat === undefined ? (region.row + j) * cols + region.col + i : flat,
        })
      }
    }
  }
  return out
}
