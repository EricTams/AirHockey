import type { EditorServer } from './server'
import type { Assets } from '../core/assets'
import { parseTileset, type CellKind, type PropDef, type Tileset } from '../world/tileset'
import { TILE } from '../core/config'
import { proposeSheet, gridRows, editableFrom, type Rgba } from './sheetAnalysis'
import { serializeTileset, toFile } from './tilesetFile'
import { el } from './dom'

/**
 * Importing a sheet, and reviewing what the importer guessed about it.
 *
 * The review screen is not a nicety bolted onto the importer — it is half of
 * it. Handoff decision 5: a proposal a designer cannot correct is worse than no
 * proposal, because it presents guesses as settled. So the two ship together,
 * and `reviewed` only becomes true from here.
 *
 * The sheet is decoded in the browser. The helper has no image decoder and
 * should not grow one; it takes bytes and writes them.
 */

const TILESET_DIR = 'data/tilesets/'
const SHEET_DIR = 'assets/'

type ReviewTool = 'cell' | 'prop' | 'anchor'

export interface TilesetHost {
  server: EditorServer
  assets: Assets
  /** The tileset the open map is using. */
  current(): Tileset
  /** The rider path the open map points at. */
  currentPath(): string
  /** Reload the world with the saved tileset, so the map redraws with it. */
  reloadWorld(): Promise<void>
  /** Point the open map at a different rider. Destructive; see the warning. */
  useForMap(path: string): void
  message(text: string, tone: 'ok' | 'err'): void
}

interface Draft {
  path: string
  file: ReturnType<typeof toFile>
  cells: CellKind[]
  solid: boolean[]
  props: PropDef[]
  cols: number
  rows: number
  image: CanvasImageSource
  dirty: boolean
}

export class TilesetEditor {
  readonly root = el('div', { class: 'ed-pane' })

  private draft?: Draft
  private tool: ReviewTool = 'cell'
  private selectedProp?: string
  private saving = false
  private drag?: { from: { col: number; row: number }; to: { col: number; row: number } }
  private scale = 1

  private ui!: {
    header: HTMLElement
    file: HTMLInputElement
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    tools: Map<ReviewTool, HTMLButtonElement>
    propList: HTMLElement
    save: HTMLButtonElement
    hint: HTMLElement
    zoomOut: HTMLButtonElement
    zoomIn: HTMLButtonElement
    use: HTMLButtonElement
  }

  constructor(private host: TilesetHost) {
    this.build()
  }

  get dirty(): boolean { return this.draft?.dirty ?? false }

  // --- Session -------------------------------------------------------------

  async activate(): Promise<void> {
    if (!this.draft) await this.loadCurrent()
    // The pane was hidden when the draft was first laid out, so the scroller
    // had no width to fit against.
    this.fitScale()
    this.syncButtons()
    this.redraw()
  }

  deactivate(): void { this.drag = undefined }

  /** Open the tileset the map is already using, so review needs no import. */
  private async loadCurrent(): Promise<void> {
    const tileset = this.host.current()
    const texture = await this.host.assets.texture(tileset.image)
    this.setDraft(tileset, texture.image as CanvasImageSource, {
      ...editableFrom(tileset),
      props: [...tileset.props],
    })
  }

  private setDraft(
    tileset: Tileset,
    image: CanvasImageSource,
    parts: { cells: CellKind[]; solid: boolean[]; props: PropDef[] },
    dirty = false,
  ): void {
    this.draft = {
      path: `${TILESET_DIR}${tileset.id}.json`,
      file: toFile(tileset),
      cells: parts.cells,
      solid: parts.solid,
      props: parts.props,
      cols: tileset.cols,
      rows: tileset.rows,
      image,
      dirty,
    }
    this.selectedProp = this.draft.props[0]?.id
    this.fitScale()
    this.renderHeader()
    this.renderPropList()
    this.syncButtons()
    this.redraw()
  }

  // --- Import --------------------------------------------------------------

  /**
   * Take a PNG, write it into the content folder, decode it, and propose a
   * classification. Nothing is saved as a rider until the designer reviews it.
   */
  private async importSheet(input: File): Promise<void> {
    try {
      const id = input.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
      if (!id) { this.host.message('That file needs a usable name', 'err'); return }
      const imagePath = `${SHEET_DIR}${id}/${id}.png`

      const bytes = new Uint8Array(await input.arrayBuffer())
      await this.host.server.write(imagePath, bytes as BodyInit, 'image/png')

      const bitmap = await createImageBitmap(input)
      const rgba = toRgba(bitmap)
      const proposal = proposeSheet(rgba, TILE)

      // Round-trip through the game's own parser rather than hand-building a
      // Tileset: geometry, legend and prop validation all live there, and the
      // importer must not be able to produce something the game would reject.
      const tileset = parseTileset({
        id,
        image: imagePath,
        tilePx: TILE,
        size: [bitmap.width, bitmap.height],
        reviewed: false,
      }, imagePath)

      // The sheet is not on the site, so drop any cached placeholder for it.
      this.host.assets.invalidate(imagePath)
      this.setDraft(tileset, bitmap, {
        cells: proposal.cells,
        solid: proposal.solid,
        props: proposal.props,
      }, true)

      this.host.message(
        `Imported ${id}: ${proposal.cols}x${proposal.rows} cells, ` +
        `${proposal.props.length} prop(s) proposed. Check them before saving.`,
        'ok',
      )
    } catch (err) {
      this.host.message(`Could not import: ${(err as Error).message}`, 'err')
    }
  }

  // --- Saving --------------------------------------------------------------

  async save(): Promise<void> {
    const draft = this.draft
    if (!draft || this.saving) return
    this.saving = true
    this.syncButtons()
    try {
      const text = serializeTileset({
        ...draft.file,
        // Saving from here is what "a person has looked at this" means.
        reviewed: true,
        grid: gridRows(draft.cells, draft.solid, draft.cols, draft.rows),
        props: draft.props,
      })
      parseTileset(JSON.parse(text), draft.path)
      await this.host.server.write(draft.path, text, 'application/json')
      draft.dirty = false
      // Saving from here is the act that reviews the sheet, so the header has
      // to stop calling these the importer's guesses.
      draft.file = { ...draft.file, reviewed: true }
      this.host.message(`Saved ${draft.path}`, 'ok')
      // The map's tiles and props are drawn from this, so show the result.
      await this.host.reloadWorld()
    } catch (err) {
      this.host.message(`Could not save: ${(err as Error).message}`, 'err')
    } finally {
      this.saving = false
      this.syncButtons()
      this.renderHeader()
    }
  }

  /**
   * Point the open map at this sheet.
   *
   * Destructive by nature: a tile index is a position in a sheet, so the same
   * numbers name different art afterwards. It goes through MapDoc, so it is one
   * Ctrl-Z away from being undone, and it refuses to run against an unsaved
   * draft — the map would name a rider file that does not exist yet.
   */
  private useForMap(): void {
    const draft = this.draft
    if (!draft) return
    if (draft.dirty) {
      this.host.message('Save the sheet first, or the map would point at nothing', 'err')
      return
    }
    if (draft.path === this.host.currentPath()) {
      this.host.message('The map already uses this sheet', 'ok')
      return
    }
    this.host.useForMap(draft.path)
  }

  // --- Review edits --------------------------------------------------------

  /** Cycle a cell: unused → tile → solid tile → unused. */
  private cycleCell(col: number, row: number): void {
    const draft = this.draft
    if (!draft) return
    const i = row * draft.cols + col
    const kind = draft.cells[i]
    const solid = draft.solid[i]
    if (kind !== 'tile') { draft.cells[i] = 'tile'; draft.solid[i] = false }
    else if (!solid) { draft.solid[i] = true }
    else { draft.cells[i] = 'unused'; draft.solid[i] = false }
    this.touch()
  }

  private addProp(from: { col: number; row: number }, to: { col: number; row: number }): void {
    const draft = this.draft
    if (!draft) return
    const col = Math.min(from.col, to.col)
    const row = Math.min(from.row, to.row)
    const w = Math.abs(to.col - from.col) + 1
    const h = Math.abs(to.row - from.row) + 1
    const id = uniqueId(draft.props.map((p) => p.id), 'prop')
    draft.props.push({
      id, name: id, col, row, w, h,
      anchor: [Math.floor(w / 2), h - 1],
      solid: true,
    })
    this.selectedProp = id
    this.touch()
    this.renderPropList()
  }

  private setAnchor(col: number, row: number): void {
    const prop = this.selected
    if (!prop) return
    if (col < prop.col || row < prop.row || col >= prop.col + prop.w || row >= prop.row + prop.h) {
      this.host.message('An anchor has to be a cell inside the prop', 'err')
      return
    }
    prop.anchor = [col - prop.col, row - prop.row]
    this.touch()
    this.renderPropList()
  }

  private get selected(): PropDef | undefined {
    return this.draft?.props.find((p) => p.id === this.selectedProp)
  }

  private removeProp(id: string): void {
    const draft = this.draft
    if (!draft) return
    const i = draft.props.findIndex((p) => p.id === id)
    if (i < 0) return
    draft.props.splice(i, 1)
    if (this.selectedProp === id) this.selectedProp = draft.props[0]?.id
    this.touch()
    this.renderPropList()
  }

  private touch(): void {
    if (this.draft) this.draft.dirty = true
    this.redraw()
    this.syncButtons()
    this.renderHeader()
  }

  // --- Canvas --------------------------------------------------------------

  private cellFromEvent(e: PointerEvent): { col: number; row: number } | undefined {
    const draft = this.draft
    if (!draft) return undefined
    const rect = this.ui.canvas.getBoundingClientRect()
    const cell = TILE * this.scale
    const col = Math.floor((e.clientX - rect.left) / cell)
    const row = Math.floor((e.clientY - rect.top) / cell)
    if (col < 0 || row < 0 || col >= draft.cols || row >= draft.rows) return undefined
    return { col, row }
  }

  private onDown(e: PointerEvent): void {
    const at = this.cellFromEvent(e)
    if (!at) return
    if (this.tool === 'cell') { this.cycleCell(at.col, at.row); return }
    if (this.tool === 'anchor') { this.setAnchor(at.col, at.row); return }

    // Prop tool: a click selects whatever is under it, a drag makes a new one.
    const hit = this.draft?.props.find((p) =>
      at.col >= p.col && at.col < p.col + p.w && at.row >= p.row && at.row < p.row + p.h)
    if (hit) {
      this.selectedProp = hit.id
      this.renderPropList()
      this.redraw()
      return
    }
    this.drag = { from: at, to: at }
    this.redraw()
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return
    const at = this.cellFromEvent(e)
    if (!at) return
    this.drag.to = at
    this.redraw()
  }

  private onUp(): void {
    const drag = this.drag
    this.drag = undefined
    if (drag) this.addProp(drag.from, drag.to)
    else this.redraw()
  }

  private fitScale(): void {
    const draft = this.draft
    if (!draft) return
    // clientWidth includes the scroller's padding; leave room for it and for
    // the canvas border, or the sheet overflows by a few pixels every time.
    const available = (this.ui.canvas.parentElement?.clientWidth ?? 300) - 26
    const raw = available / (draft.cols * TILE)
    this.scale = Math.max(0.2, Math.min(1, raw))
  }

  private redraw(): void {
    const draft = this.draft
    const ctx = this.ui.ctx
    if (!draft) { this.ui.canvas.width = 0; return }

    const cell = TILE * this.scale
    this.ui.canvas.width = Math.round(draft.cols * cell)
    this.ui.canvas.height = Math.round(draft.rows * cell)
    this.ui.canvas.style.width = `${this.ui.canvas.width}px`
    this.ui.canvas.style.height = `${this.ui.canvas.height}px`

    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, this.ui.canvas.width, this.ui.canvas.height)
    // A checker behind the sheet, so transparent cells read as transparent
    // rather than as black art.
    for (let row = 0; row < draft.rows; row++) {
      for (let col = 0; col < draft.cols; col++) {
        ctx.fillStyle = (col + row) % 2 ? '#171d27' : '#1d2531'
        ctx.fillRect(col * cell, row * cell, cell, cell)
      }
    }

    for (let row = 0; row < draft.rows; row++) {
      for (let col = 0; col < draft.cols; col++) {
        ctx.drawImage(draft.image, col * TILE, row * TILE, TILE, TILE,
          col * cell, row * cell, cell, cell)
        const i = row * draft.cols + col
        if (draft.cells[i] !== 'tile') {
          ctx.fillStyle = 'rgba(10, 14, 20, .66)'
          ctx.fillRect(col * cell, row * cell, cell, cell)
        } else if (draft.solid[i]) {
          // A solid tile is a passability suggestion, marked as a corner flag
          // rather than a wash so the art underneath stays readable.
          ctx.fillStyle = 'rgba(210, 69, 63, .85)'
          ctx.beginPath()
          ctx.moveTo(col * cell, row * cell)
          ctx.lineTo(col * cell + cell * 0.32, row * cell)
          ctx.lineTo(col * cell, row * cell + cell * 0.32)
          ctx.fill()
        }
      }
    }

    ctx.strokeStyle = 'rgba(150, 170, 195, .2)'
    ctx.lineWidth = 1
    for (let col = 1; col < draft.cols; col++) line(ctx, col * cell, 0, col * cell, this.ui.canvas.height)
    for (let row = 1; row < draft.rows; row++) line(ctx, 0, row * cell, this.ui.canvas.width, row * cell)

    for (const prop of draft.props) {
      const on = prop.id === this.selectedProp
      ctx.strokeStyle = on ? '#ffd465' : '#59c9f0'
      ctx.lineWidth = on ? 2 : 1
      ctx.strokeRect(prop.col * cell + 1, prop.row * cell + 1, prop.w * cell - 2, prop.h * cell - 2)
      // The anchor: the cell that lands on the tile the prop is placed on.
      const [ax, ay] = prop.anchor
      ctx.fillStyle = on ? 'rgba(255, 212, 101, .5)' : 'rgba(89, 201, 240, .3)'
      ctx.fillRect((prop.col + ax) * cell + 2, (prop.row + ay) * cell + 2, cell - 4, cell - 4)
    }

    if (this.drag) {
      const c0 = Math.min(this.drag.from.col, this.drag.to.col)
      const r0 = Math.min(this.drag.from.row, this.drag.to.row)
      const w = Math.abs(this.drag.to.col - this.drag.from.col) + 1
      const h = Math.abs(this.drag.to.row - this.drag.from.row) + 1
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.strokeRect(c0 * cell + 1, r0 * cell + 1, w * cell - 2, h * cell - 2)
    }
  }

  // --- DOM -----------------------------------------------------------------

  private build(): void {
    const header = el('div', { class: 'ed-hint' })

    const file = el('input', { type: 'file', accept: 'image/png', class: 'ed-file' })
    file.onchange = () => {
      const chosen = file.files?.[0]
      file.value = ''   // so re-importing the same file fires again
      if (chosen) void this.importSheet(chosen)
    }

    const canvas = el('canvas', { class: 'ed-sheet' })
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('tileset review: no 2d context')
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); this.onDown(e) })
    canvas.addEventListener('pointermove', (e) => this.onMove(e))
    canvas.addEventListener('pointerup', () => this.onUp())

    const tools = new Map<ReviewTool, HTMLButtonElement>()
    const toolRow = el('div', { class: 'ed-seg' })
    for (const [id, label] of [
      ['cell', 'Cells'], ['prop', 'Props'], ['anchor', 'Anchor'],
    ] as [ReviewTool, string][]) {
      const b = el('button', { type: 'button' }, label)
      b.onclick = () => { b.blur(); this.tool = id; this.syncButtons(); this.updateHint() }
      tools.set(id, b)
      toolRow.append(b)
    }

    const hint = el('div', { class: 'ed-hint' })
    const propList = el('div', { class: 'ed-lines' })

    const zoomOut = el('button', { class: 'ed-icon', type: 'button', title: 'Smaller' }, '−')
    zoomOut.onclick = () => { this.scale = Math.max(0.2, this.scale / 1.25); this.redraw() }
    const zoomIn = el('button', { class: 'ed-icon', type: 'button', title: 'Bigger' }, '+')
    zoomIn.onclick = () => { this.scale = Math.min(2, this.scale * 1.25); this.redraw() }

    const save = el('button', { class: 'ed-save', type: 'button' }, 'Save & mark reviewed')
    save.onclick = () => { save.blur(); void this.save() }

    const use = el('button', { class: 'ed-second', type: 'button' }, 'Use this sheet for the map')
    use.onclick = () => { use.blur(); this.useForMap() }
    const useWarn = el('div', { class: 'ed-warn' },
      'Tile indices are positions in a sheet, so pointing the map at a different ' +
      'one re-reads every tile it has. Expect to repaint. Ctrl-Z undoes it.')
    useWarn.hidden = true
    use.addEventListener('pointerenter', () => { useWarn.hidden = false })
    use.addEventListener('pointerleave', () => { useWarn.hidden = true })

    this.root.append(
      el('div', { class: 'ed-sec' }, el('label', {}, 'Sheet'), header,
        el('div', { class: 'ed-row2' }, file)),
      el('div', { class: 'ed-sec' }, el('label', {}, 'Review'), toolRow, hint,
        el('div', { class: 'ed-row2' }, zoomOut, zoomIn)),
      el('div', { class: 'ed-pal-wrap' }, canvas),
      propList,
      el('div', { class: 'ed-sec' }, use, useWarn),
      el('div', { class: 'ed-foot2' }, save),
    )

    this.ui = { header, file, canvas, ctx, tools, propList, save, hint, zoomOut, zoomIn, use }
    this.updateHint()
    this.syncButtons()
  }

  private updateHint(): void {
    this.ui.hint.textContent = {
      cell: 'Click a cell to cycle it: unused → paintable → paintable and solid.',
      prop: 'Drag a box around one object. Click an existing box to select it.',
      anchor: 'Click the cell of the selected prop that should stand on the tile.',
    }[this.tool]
  }

  private renderHeader(): void {
    const draft = this.draft
    if (!draft) { this.ui.header.textContent = 'No sheet loaded.'; return }
    const painted = draft.cells.filter((c) => c === 'tile').length
    this.ui.header.replaceChildren(
      el('div', {}, `${draft.file.id} — ${draft.cols}×${draft.rows} cells of ${TILE}px`),
      el('div', {}, `${painted} paintable, ${draft.props.length} prop(s)`),
      el('div', {},
        draft.dirty
          ? 'Unreviewed changes — saving marks this sheet reviewed.'
          : draft.file.reviewed
            ? 'Reviewed.'
            : 'Never reviewed: these are the importer’s guesses.'),
    )
  }

  private renderPropList(): void {
    const draft = this.draft
    if (!draft) { this.ui.propList.replaceChildren(); return }
    if (draft.props.length === 0) {
      this.ui.propList.replaceChildren(
        el('div', { class: 'ed-hint ed-sec' }, 'No props. Drag a box on the sheet to mark one.'))
      return
    }
    this.ui.propList.replaceChildren(...draft.props.map((p) => {
      const name = el('input', { class: 'ed-input2', type: 'text' })
      name.value = p.name
      name.onchange = () => { p.name = name.value || p.id; this.touch() }

      const solid = el('input', { type: 'checkbox', title: 'Suggest collision when placed' })
      solid.checked = p.solid
      solid.onchange = () => { p.solid = solid.checked; this.touch() }

      const del = el('button', { class: 'ed-icon', type: 'button', title: 'Remove' }, '✕')
      del.onclick = (e) => { e.stopPropagation(); this.removeProp(p.id) }

      const row = el('div', {
        class: 'ed-line ed-propline', 'aria-selected': String(p.id === this.selectedProp),
      }, name, el('span', { class: 'ed-linetext' }, `${p.w}×${p.h}`), solid, del)
      row.onclick = () => { this.selectedProp = p.id; this.renderPropList(); this.redraw() }
      return row
    }))
  }

  private syncButtons(): void {
    for (const [id, b] of this.ui.tools) b.setAttribute('aria-pressed', String(id === this.tool))
    this.ui.save.disabled = this.saving || !this.draft
    this.ui.save.textContent = this.saving ? 'Saving…' : 'Save & mark reviewed'
    this.ui.use.disabled = !this.draft || this.draft.dirty
      || this.draft.path === this.host.currentPath()
  }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath()
  ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5)
  ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5)
  ctx.stroke()
}

/** Decode an image into raw RGBA, which is what the analysis measures. */
function toRgba(bitmap: ImageBitmap): Rgba {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context to decode the sheet with')
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  return { width: bitmap.width, height: bitmap.height, data }
}

function uniqueId(taken: readonly string[], stem: string): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const id = `${stem}-${n}`
    if (!used.has(id)) return id
  }
}
