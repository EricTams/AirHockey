import { cellOf, indexOf, isPaintable, tileCount, type Tileset } from '../world/tileset'

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
 */

/** Ring drawn around the selected cell, in device pixels. */
const RING = 2

export class TilePalette {
  readonly canvas = document.createElement('canvas')

  private ctx: CanvasRenderingContext2D
  private scale = 1
  private selected = 0

  constructor(
    private tileset: Tileset,
    private image: CanvasImageSource,
    private readonly onPick: (index: number) => void,
  ) {
    this.canvas.className = 'ed-palette'
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('editor palette: no 2d context')
    this.ctx = ctx
    this.canvas.addEventListener('pointerdown', (e) => this.pick(e))
  }

  get selectedIndex(): number { return this.selected }

  /** Point the palette at a different sheet, e.g. after an import. */
  setTileset(tileset: Tileset, image: CanvasImageSource): void {
    this.tileset = tileset
    this.image = image
    if (this.selected >= tileCount(tileset)) this.selected = 0
    this.layout()
  }

  select(index: number): void {
    if (index < 0 || index >= tileCount(this.tileset)) return
    this.selected = index
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

    const { col, row } = cellOf(this.tileset, this.selected)
    ctx.strokeStyle = '#ffd465'
    ctx.lineWidth = RING
    ctx.strokeRect(
      col * cell + RING / 2, row * cell + RING / 2, cell - RING, cell - RING,
    )
  }

  private pick(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const col = Math.floor((e.clientX - rect.left) / this.cellPx)
    const row = Math.floor((e.clientY - rect.top) / this.cellPx)
    if (col < 0 || row < 0 || col >= this.tileset.cols || row >= this.tileset.rows) return
    this.selected = indexOf(this.tileset, col, row)
    this.draw()
    this.onPick(this.selected)
  }
}
