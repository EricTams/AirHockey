import type { MapDoc, EditTarget } from './mapDoc'

/**
 * What each painting tool touches, as pure geometry over the grid.
 *
 * Separated from the pointer handling because the interesting cases are all
 * here — the line that stops a fast drag leaving gaps, the flood fill that has
 * to not recurse a thousand deep — and none of them need a browser to test.
 */

export const TOOLS = ['brush', 'rect', 'fill', 'eyedropper'] as const
export type Tool = (typeof TOOLS)[number]

export interface Cell { x: number; y: number }

/**
 * Cells along a line between two grid points, inclusive of both ends.
 *
 * Pointer events arrive per frame, so a quick drag reports (3,3) then (9,7)
 * with nothing in between. Painting only the reported cells leaves a dotted
 * trail; Bresenham fills it in.
 */
export function lineCells(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = []
  let { x, y } = from
  const dx = Math.abs(to.x - x)
  const dy = -Math.abs(to.y - y)
  const sx = x < to.x ? 1 : -1
  const sy = y < to.y ? 1 : -1
  let err = dx + dy

  for (;;) {
    cells.push({ x, y })
    if (x === to.x && y === to.y) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
  return cells
}

/** Every cell in the rectangle spanned by two corners, in either order. */
export function rectCells(a: Cell, b: Cell): Cell[] {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  const cells: Cell[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.push({ x, y })
  }
  return cells
}

/**
 * The connected region of cells matching the one under `start`, 4-connected.
 *
 * Iterative rather than recursive: a fill over a large open map is thousands of
 * cells deep, which is a stack overflow, and the failure would arrive on the
 * designer's biggest map rather than in testing.
 */
export function fillCells(doc: MapDoc, target: EditTarget, start: Cell): Cell[] {
  const match = doc.get(target, start.x, start.y)
  if (match === undefined) return []

  const { width, height } = doc.map
  const seen = new Uint8Array(width * height)
  const out: Cell[] = []
  const queue: Cell[] = [start]
  seen[doc.indexOf(start.x, start.y)] = 1

  while (queue.length > 0) {
    const cell = queue.pop()!
    out.push(cell)
    for (const [dx, dy] of NEIGHBOURS) {
      const x = cell.x + dx
      const y = cell.y + dy
      if (!doc.inBounds(x, y)) continue
      const index = doc.indexOf(x, y)
      if (seen[index]) continue
      if (doc.cells(target)[index] !== match) continue
      seen[index] = 1
      queue.push({ x, y })
    }
  }
  return out
}

const NEIGHBOURS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** Cells a tool would touch for a drag from `from` to `to`. */
export function toolCells(
  doc: MapDoc, target: EditTarget, tool: Tool, from: Cell, to: Cell,
): Cell[] {
  switch (tool) {
    case 'brush': return lineCells(from, to)
    case 'rect': return rectCells(from, to)
    case 'fill': return fillCells(doc, target, from)
    case 'eyedropper': return [to]
  }
}

/** True while a tool wants a live preview of the region rather than paint. */
export function isPreviewTool(tool: Tool): boolean {
  return tool === 'rect'
}
