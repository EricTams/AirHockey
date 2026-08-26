import { cellOf, indexOf, isPaintable, tileCount, type Tileset } from '../world/tileset'

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(max, v))
}

/**
 * The tile palette: the sheet drawn at a chosen scale with the grid over it,
 * and a click selecting a cell.
 *
 * Drawn into a 2D canvas rather than built from DOM elements. A 10x9 sheet is
 * 90 cells and a large one is thousands; one canvas and a bit of arithmetic
 * beats a few thousand absolutely-positioned divs, and the source image is
 * already exactly the picture we want.
 *
 * Cells the rider does not mark paintable are dimmed but still selectable.
 * Decision 5 in the handoff: the rider proposes and the designer decides, so a
 * wrong classification must not be able to lock art away.
 *
 * A drag selects a rectangle rather than a cell, because most art on a sheet is
 * bigger than one tile — a house, a cliff face, a three-tile tree — and placing
 * it a tile at a time means getting the neighbours right by hand every time.
 */

/** A rectangle of cells on the sheet. `w` and `h` are 1 for a single tile. */
export interface Region {
  col: number
  row: number
  w: number
  h: number
}

/** Ring drawn around the selected cell, in device pixels. */
const RING = 2

export class TilePalette {
  readonly canvas = document.createElement('canvas')

  private ctx: CanvasRenderingContext2D
  private scale = 1
  private region: Region = { col: 0, row: 0, w: 1, h: 1 }
  /** Where a drag started, so the rectangle can be spanned from either corner. */
  private anchor?: { col: number; row: number }

  constructor(
    private tileset: Tileset,
    private image: CanvasImageSource,
    private readonly onPick: (index: number) => void,
  ) {
    this.canvas.className = 'ed-palette'
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('editor palette: no 2d context')
    this.ctx = ctx
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e))
    this.canvas.addEventListener('pointerup', () => this.onUp())
    this.canvas.addEventListener('pointercancel', () => this.onUp())
  }

  /** Top-left of the selection. What a single-tile caller wants. */
  get selectedIndex(): number {
    return indexOf(this.tileset, this.region.col, this.region.row)
  }

  /** The whole selection, which may be more than one cell. */
  get selectedRegion(): Region { return { ...this.region } }

  /** Point the palette at a different sheet, e.g. after an import. */
  setTileset(tileset: Tileset, image: CanvasImageSource): void {
    this.tileset = tileset
    this.image = image
    // A selection on the old sheet means nothing on this one, and might not
    // even fit it.
    this.region = { col: 0, row: 0, w: 1, h: 1 }
    this.layout()
  }

  /** Select a single cell by index, e.g. from the eyedropper. */
  select(index: number): void {
    if (index < 0 || index >= tileCount(this.tileset)) return
    const { col, row } = cellOf(this.tileset, index)
    this.region = { col, row, w: 1, h: 1 }
    this.draw()
  }

  /** Scale the sheet so its full width fits `px`, within sane bounds. */
  fitWidth(px: number): void {
    const raw = px / this.tileset.sheetW
    this.setScale(Math.max(0.25, Math.min(2, raw)))
  }

  setScale(scale: number): void {
    this.scale = scale
    this.layout()
  }

  get currentScale(): number { return this.scale }

  private get cellPx(): number { return this.tileset.tilePx * this.scale }

  private layout(): void {
    const { cols, rows } = this.tileset
    this.canvas.width = Math.round(cols * this.cellPx)
    this.canvas.height = Math.round(rows * this.cellPx)
    this.canvas.style.width = `${this.canvas.width}px`
    this.canvas.style.height = `${this.canvas.height}px`
    this.draw()
  }

  draw(): void {
    const { cols, rows, tilePx } = this.tileset
    const cell = this.cellPx
    const ctx = this.ctx

    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    // Draw cell by cell rather than blitting the whole sheet: the usable grid
    // floors, so a sheet with a partial right/bottom margin would otherwise
    // show a sliver of unaddressable art that no click could ever select.
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const dx = col * cell
        const dy = row * cell
        ctx.drawImage(
          this.image,
          col * tilePx, row * tilePx, tilePx, tilePx,
          dx, dy, cell, cell,
        )
        if (!isPaintable(this.tileset, indexOf(this.tileset, col, row))) {
          ctx.fillStyle = 'rgba(12, 16, 24, .62)'
          ctx.fillRect(dx, dy, cell, cell)
        }
      }
    }

    ctx.strokeStyle = 'rgba(150, 170, 195, .22)'
    ctx.lineWidth = 1
    for (let col = 1; col < cols; col++) {
      ctx.beginPath()
      ctx.moveTo(Math.round(col * cell) + 0.5, 0)
      ctx.lineTo(Math.round(col * cell) + 0.5, this.canvas.height)
      ctx.stroke()
    }
    for (let row = 1; row < rows; row++) {
      ctx.beginPath()
      ctx.moveTo(0, Math.round(row * cell) + 0.5)
      ctx.lineTo(this.canvas.width, Math.round(row * cell) + 0.5)
      ctx.stroke()
    }

    const { col, row, w, h } = this.region
    ctx.strokeStyle = '#ffd465'
    ctx.lineWidth = RING
    ctx.strokeRect(
      col * cell + RING / 2, row * cell + RING / 2,
      w * cell - RING, h * cell - RING,
    )
  }

  /** The cell under a pointer, clamped to the sheet so a drag off the edge
   *  still spans to the edge rather than being dropped. */
  private cellAt(e: PointerEvent): { col: number; row: number } {
    const rect = this.canvas.getBoundingClientRect()
    return {
      col: clamp(Math.floor((e.clientX - rect.left) / this.cellPx), this.tileset.cols - 1),
      row: clamp(Math.floor((e.clientY - rect.top) / this.cellPx), this.tileset.rows - 1),
    }
  }

  private onDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId)
    this.anchor = this.cellAt(e)
    this.region = { ...this.anchor, w: 1, h: 1 }
    this.draw()
  }

  private onMove(e: PointerEvent): void {
    if (!this.anchor) return
    const to = this.cellAt(e)
    this.region = {
      col: Math.min(this.anchor.col, to.col),
      row: Math.min(this.anchor.row, to.row),
      w: Math.abs(to.col - this.anchor.col) + 1,
      h: Math.abs(to.row - this.anchor.row) + 1,
    }
    this.draw()
  }

  private onUp(): void {
    if (!this.anchor) return
    this.anchor = undefined
    // Reported on release rather than on press, so the caller sees the finished
    // rectangle rather than the single cell the drag started from.
    this.onPick(this.selectedIndex)
  }
}
