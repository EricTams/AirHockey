import type { Renderer } from '../core/renderer'
import type { Assets } from '../core/assets'
import type { OverworldMode } from '../modes/overworld'
import type { EditorServer } from './server'
import { parseMap, type LayerName } from '../world/map'
import { EMPTY_TILE, isPaintable } from '../world/tileset'
import { MIN_ZOOM, MAX_ZOOM } from '../world/projection'
import { MapDoc, COLLISION, isNothing, type EditTarget, type Touched } from './mapDoc'
import { TOOLS, toolCells, rectCells, isPreviewTool, type Cell, type Tool } from './tools'
import { TilePalette } from './palette'
import { EditorOverlay } from './overlay'
import { serializeMap } from './mapFile'
import { EDITOR_CSS, DOCK_PX } from './editorCss'
import { TILE, VIRTUAL_W, VIRTUAL_H } from '../core/config'

/**
 * The editing session: everything that exists only while the designer is
 * editing, and nothing that outlives it.
 *
 * The rules live elsewhere — MapDoc owns the undo stack, tools.ts owns the
 * grid geometry, mapFile.ts owns the file format — and all three are testable
 * without a browser. What is here is the wiring: pointers to cells, cells to
 * the document, the document back to the meshes, and the chrome around it.
 *
 * The game is paused throughout (handoff decision 4), which has one consequence
 * worth stating: nothing calls `Projection.lookAt` any more, because that ran
 * from the player's update. The camera is this class's to drive.
 */

type PanState = { clientX: number; clientY: number; camX: number; camY: number }

interface Painting {
  target: EditTarget
  tool: Tool
  from: Cell
  last: Cell
  /** A rect only shows where it would land until the button comes up. */
  preview: boolean
}

export interface EditorHost {
  gfx: Renderer
  assets: Assets
  overworld: OverworldMode
}

const TOOL_KEYS: Record<Tool, string> = {
  brush: 'B', rect: 'R', fill: 'F', eyedropper: 'I',
}

const TARGET_LABELS: { target: EditTarget; label: string; key: string }[] = [
  { target: 'ground', label: 'Ground', key: '1' },
  { target: 'decoration', label: 'Decor', key: '2' },
  { target: 'overhead', label: 'Over', key: '3' },
  { target: COLLISION, label: 'Collision', key: '4' },
]

export class Editor {
  private doc?: MapDoc
  private overlay?: EditorOverlay
  private palette?: TilePalette
  private server?: EditorServer

  private target: EditTarget = 'ground'
  private tool: Tool = 'brush'
  private erasing = false

  private camX = 0
  private camY = 0
  private zoom = 1

  private painting?: Painting
  private pan?: PanState
  private hover?: Cell
  private saving = false

  private dom?: {
    style: HTMLStyleElement
    dock: HTMLElement
    bar: HTMLElement
    tools: Map<Tool, HTMLButtonElement>
    targets: Map<EditTarget, HTMLButtonElement>
    erase: HTMLButtonElement
    save: HTMLButtonElement
    undo: HTMLButtonElement
    redo: HTMLButtonElement
    dot: HTMLElement
    gridCheck: HTMLInputElement
    collisionCheck: HTMLInputElement
    cellText: HTMLElement
    tileText: HTMLElement
    zoomText: HTMLElement
    message: HTMLElement
  }

  private readonly bound = {
    down: (e: PointerEvent) => this.onPointerDown(e),
    move: (e: PointerEvent) => this.onPointerMove(e),
    up: (e: PointerEvent) => this.onPointerUp(e),
    leave: () => this.onPointerLeave(),
    wheel: (e: WheelEvent) => this.onWheel(e),
    key: (e: KeyboardEvent) => this.onKey(e),
    keyUp: (e: KeyboardEvent) => { if (e.code === 'Space') this.spaceHeld = false },
    context: (e: Event) => e.preventDefault(),
  }

  constructor(private host: EditorHost, private root: HTMLElement) {}

  get isOpen(): boolean { return this.doc !== undefined }
  /** Unsaved work, for a caller that wants to warn before throwing it away. */
  get dirty(): boolean { return this.doc?.dirty ?? false }

  // --- Session -------------------------------------------------------------

  async open(server: EditorServer): Promise<void> {
    if (this.doc) return
    this.server = server
    const { overworld, assets, gfx } = this.host
    const map = overworld.currentMap
    const tileset = overworld.currentTileset

    this.doc = new MapDoc(overworld.currentMapPath, map)

    this.overlay = new EditorOverlay()
    overworld.worldScene.add(this.overlay.group)
    this.overlay.setMap(map)

    const sheet = await assets.texture(tileset.image)
    // A texture that fell back to a placeholder holds a canvas rather than an
    // image; both draw into a 2D context, which is all the palette needs.
    this.palette = new TilePalette(
      tileset, sheet.image as CanvasImageSource, (i) => this.onPalettePick(i),
    )
    // Default to a tile the map already uses rather than cell 0, which on a
    // typical sheet is a corner of empty space: the first stroke should lay
    // down something the designer can see.
    const inUse = map.layers.ground[map.playerStart.y * map.width + map.playerStart.x]
    this.palette.select(
      inUse !== undefined && isPaintable(tileset, inUse)
        ? inUse
        : firstPaintable(tileset.cells.length, (i) => isPaintable(tileset, i)),
    )

    this.mount()
    this.fitMap()

    gfx.canvas.addEventListener('pointerdown', this.bound.down)
    window.addEventListener('pointermove', this.bound.move)
    window.addEventListener('pointerup', this.bound.up)
    gfx.canvas.addEventListener('pointerleave', this.bound.leave)
    gfx.canvas.addEventListener('wheel', this.bound.wheel, { passive: false })
    gfx.canvas.addEventListener('contextmenu', this.bound.context)
    window.addEventListener('keydown', this.bound.key)
    window.addEventListener('keyup', this.bound.keyUp)
  }

  close(): void {
    if (!this.doc) return
    const { gfx } = this.host
    gfx.canvas.removeEventListener('pointerdown', this.bound.down)
    window.removeEventListener('pointermove', this.bound.move)
    window.removeEventListener('pointerup', this.bound.up)
    gfx.canvas.removeEventListener('pointerleave', this.bound.leave)
    gfx.canvas.removeEventListener('wheel', this.bound.wheel)
    gfx.canvas.removeEventListener('contextmenu', this.bound.context)
    window.removeEventListener('keydown', this.bound.key)
    window.removeEventListener('keyup', this.bound.keyUp)

    this.overlay?.dispose()
    this.dom?.dock.remove()
    this.dom?.bar.remove()
    this.dom?.style.remove()

    this.host.overworld.projection.setZoom(1)
    this.doc = undefined
    this.overlay = undefined
    this.palette = undefined
    this.dom = undefined
    this.painting = undefined
    this.pan = undefined
    this.server = undefined
  }

  // --- Camera --------------------------------------------------------------

  /**
   * Frame the whole map in the part of the canvas the dock is not covering.
   *
   * Fitting to the whole viewport would hide the map's left column behind the
   * dock, which is exactly the column a designer starting a map works in.
   */
  private fitMap(): void {
    const map = this.doc!.map
    const hidden = this.hiddenFraction()
    // framedTiles at zoom 1: the frame is VIRTUAL_W/TILE tiles across.
    const proj = this.host.overworld.projection
    const base = { w: proj.framedTiles.w * proj.zoom, h: proj.framedTiles.h * proj.zoom }

    const fitW = (base.w * (1 - hidden)) / (map.width + 1)
    const fitH = base.h / (map.height + 1)
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(fitW, fitH)))
    this.camX = (map.width - 1) / 2
    this.camY = (map.height - 1) / 2
    this.applyCamera()
  }

  /** How much of the frame's width the dock sits over, as a fraction. */
  private hiddenFraction(): number {
    const frameWidth = VIRTUAL_W * this.host.gfx.integerScale
    const rect = this.host.gfx.canvas.getBoundingClientRect()
    // The frame is centred in the canvas, so only the part of the dock that
    // actually overlaps it counts.
    const frameLeft = rect.left + (rect.width - frameWidth) / 2
    const overlap = Math.max(0, Math.min(DOCK_PX - frameLeft, frameWidth))
    return frameWidth > 0 ? overlap / frameWidth : 0
  }

  private applyCamera(): void {
    const proj = this.host.overworld.projection
    proj.setZoom(this.zoom)
    // Shift east by half of what the dock covers, so the map sits centred in
    // the visible strip rather than in the frame the dock is hiding part of.
    const framedW = (VIRTUAL_W / TILE) / this.zoom
    proj.lookAt(this.camX + (framedW * this.hiddenFraction()) / 2, this.camY)
    if (this.dom) this.dom.zoomText.textContent = `${this.zoom.toFixed(2)}x`
  }

  /** The tile under a client point, or undefined outside the framed image. */
  private cellAt(clientX: number, clientY: number): Cell | undefined {
    const ndc = this.host.gfx.clientToNdc(clientX, clientY)
    if (!ndc) return undefined
    const hit = this.host.overworld.projection.pickGround(ndc)
    if (!hit) return undefined
    // Tile quads span tx-0.5 to tx+0.5, so the tile under a point rounds.
    return { x: Math.round(hit.x), y: Math.round(hit.z) }
  }

  private worldAt(clientX: number, clientY: number): { x: number; z: number } | undefined {
    const ndc = this.host.gfx.clientToNdc(clientX, clientY)
    return ndc ? this.host.overworld.projection.pickGround(ndc) : undefined
  }

  // --- Pointer -------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (!this.doc) return
    // Middle button, or space held, pans. Anything else paints.
    if (e.button === 1 || e.button === 2 || this.spaceHeld) {
      this.pan = { clientX: e.clientX, clientY: e.clientY, camX: this.camX, camY: this.camY }
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const cell = this.cellAt(e.clientX, e.clientY)
    if (!cell) return

    if (this.tool === 'eyedropper') { this.eyedrop(cell); return }

    this.doc.beginStroke(`${this.tool} ${this.target}`)
    this.painting = {
      target: this.target,
      tool: this.tool,
      from: cell,
      last: cell,
      preview: isPreviewTool(this.tool),
    }

    if (this.painting.preview) {
      this.overlay?.setCursor(rectCells(cell, cell))
    } else {
      this.applyCells(toolCells(this.doc, this.target, this.tool, cell, cell))
      // A fill is one click and done; there is nothing to drag.
      if (this.tool === 'fill') this.finishStroke()
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.doc) return

    if (this.pan) {
      // Pan in world units so the drag tracks the cursor at any zoom.
      const scale = this.tilesPerPixel()
      this.camX = this.pan.camX - (e.clientX - this.pan.clientX) * scale
      this.camY = this.pan.camY - (e.clientY - this.pan.clientY) * scale
      this.applyCamera()
      return
    }

    const cell = this.cellAt(e.clientX, e.clientY)
    this.hover = cell
    this.updateStatus()
    if (!cell) return

    const p = this.painting
    if (!p) { this.overlay?.setCursor([cell]); return }

    if (p.preview) {
      p.last = cell
      this.overlay?.setCursor(rectCells(p.from, cell))
      return
    }
    if (cell.x === p.last.x && cell.y === p.last.y) return
    // Brush: fill in the cells the pointer skipped over between frames.
    this.applyCells(toolCells(this.doc, p.target, p.tool, p.last, cell))
    p.last = cell
    this.overlay?.setCursor([cell])
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.pan) { this.pan = undefined; return }
    if (!this.painting || e.button !== 0) return
    const p = this.painting
    if (p.preview) this.applyCells(rectCells(p.from, p.last))
    this.finishStroke()
  }

  private onPointerLeave(): void {
    this.hover = undefined
    if (!this.painting) this.overlay?.setCursor([])
    this.updateStatus()
  }

  private onWheel(e: WheelEvent): void {
    if (!this.doc) return
    e.preventDefault()
    // Zoom about the cursor: keep whatever tile is under it under it, or
    // zooming in on a corner of the map walks away from what you were looking at.
    const before = this.worldAt(e.clientX, e.clientY)
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
      this.zoom * Math.pow(ZOOM_PER_NOTCH, -Math.sign(e.deltaY))))
    this.applyCamera()
    const after = this.worldAt(e.clientX, e.clientY)
    if (before && after) {
      this.camX += before.x - after.x
      this.camY += before.z - after.z
      this.applyCamera()
    }
  }

  /** World tiles covered by one client pixel, for panning. */
  private tilesPerPixel(): number {
    const { h } = this.host.overworld.projection.framedTiles
    return h / (VIRTUAL_H * this.host.gfx.integerScale)
  }

  // --- Editing -------------------------------------------------------------

  private get paintValue(): number {
    if (this.target === COLLISION) return this.erasing ? 0 : 1
    return this.erasing ? EMPTY_TILE : (this.palette?.selectedIndex ?? EMPTY_TILE)
  }

  private applyCells(cells: readonly Cell[]): void {
    const doc = this.doc
    if (!doc) return
    const value = this.paintValue
    let changed = false
    for (const c of cells) changed = doc.set(this.target, c.x, c.y, value) || changed
    if (changed) this.refresh({ layers: layersOf(this.target), collision: this.target === COLLISION })
  }

  private finishStroke(): void {
    const doc = this.doc
    if (!doc) return
    this.painting = undefined
    const touched = doc.endStroke()
    if (!isNothing(touched)) this.refresh(touched)
    // Drop a rect's preview back to the single hovered cell, or the region it
    // just painted stays washed out under the highlight.
    this.overlay?.setCursor(this.hover ? [this.hover] : [])
    this.updateStatus()
    this.syncButtons()
  }

  /** Push document changes into the meshes and the overlay. */
  private refresh(touched: Touched): void {
    if (touched.layers.length > 0) this.host.overworld.rebuildLayers(touched.layers)
    if (touched.collision) this.overlay?.setCollision(this.doc!.map)
  }

  private eyedrop(cell: Cell): void {
    const value = this.doc?.get(this.target, cell.x, cell.y)
    if (value === undefined) return
    if (this.target === COLLISION) {
      this.setErasing(value === 0)
    } else if (value === EMPTY_TILE) {
      this.setErasing(true)
    } else {
      this.setErasing(false)
      this.palette?.select(value)
    }
    // A picked-up tile is nearly always about to be painted with.
    this.setTool('brush')
    this.updateStatus()
  }

  private undo(): void {
    const touched = this.doc?.undo()
    if (touched) this.refresh(touched)
    this.syncButtons()
    this.updateStatus()
  }

  private redo(): void {
    const touched = this.doc?.redo()
    if (touched) this.refresh(touched)
    this.syncButtons()
    this.updateStatus()
  }

  // --- Saving --------------------------------------------------------------

  async save(): Promise<void> {
    const doc = this.doc
    const server = this.server
    if (!doc || !server || this.saving) return
    this.saving = true
    this.syncButtons()
    try {
      const text = serializeMap(doc.map)
      // Validate what is about to be written, not what is in memory: this is
      // the last point at which a bad save can be caught before it becomes a
      // file the game refuses to load.
      parseMap(JSON.parse(text), this.host.overworld.currentTileset, doc.path)
      await server.write(doc.path, text, 'application/json')
      doc.markSaved()
      this.message(`Saved ${doc.path}`, 'ok')
    } catch (err) {
      this.message(`Could not save: ${(err as Error).message}`, 'err')
    } finally {
      this.saving = false
      this.syncButtons()
    }
  }

  // --- Keyboard ------------------------------------------------------------

  private spaceHeld = false

  private onKey(e: KeyboardEvent): void {
    if (!this.doc) return
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    const mod = e.metaKey || e.ctrlKey
    if (mod && e.code === 'KeyS') { e.preventDefault(); void this.save(); return }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault()
      if (e.shiftKey) this.redo(); else this.undo()
      return
    }
    if (mod && e.code === 'KeyY') { e.preventDefault(); this.redo(); return }
    if (mod) return

    switch (e.code) {
      case 'Space': this.spaceHeld = true; e.preventDefault(); break
      case 'KeyB': this.setTool('brush'); break
      case 'KeyR': this.setTool('rect'); break
      case 'KeyF': this.setTool('fill'); break
      case 'KeyI': this.setTool('eyedropper'); break
      case 'KeyE': this.setErasing(!this.erasing); break
      case 'Digit1': this.setTarget('ground'); break
      case 'Digit2': this.setTarget('decoration'); break
      case 'Digit3': this.setTarget('overhead'); break
      case 'Digit4': this.setTarget(COLLISION); break
      case 'KeyG': this.overlay?.setGridVisible(!this.overlay.isGridVisible); break
      case 'KeyV': this.overlay?.setCollisionVisible(!this.overlay.isCollisionVisible); break
      case 'Escape':
        if (this.painting) {
          const touched = this.doc.cancelStroke()
          this.painting = undefined
          this.overlay?.setCursor([])
          if (!isNothing(touched)) this.refresh(touched)
        }
        break
      case 'KeyW': case 'ArrowUp': this.nudge(0, -1); break
      case 'KeyS': case 'ArrowDown': this.nudge(0, 1); break
      case 'KeyA': case 'ArrowLeft': this.nudge(-1, 0); break
      case 'KeyD': case 'ArrowRight': this.nudge(1, 0); break
      default: return
    }
    this.syncButtons()
  }

  private nudge(dx: number, dy: number): void {
    this.camX += dx * NUDGE_TILES
    this.camY += dy * NUDGE_TILES
    this.applyCamera()
  }

  // --- Chrome --------------------------------------------------------------

  private setTool(tool: Tool): void {
    this.tool = tool
    this.syncButtons()
    this.updateStatus()
  }

  private setTarget(target: EditTarget): void {
    this.target = target
    // The collision grid is its own thing; showing it while editing it is the
    // only way to see what you are doing.
    if (target === COLLISION) this.overlay?.setCollisionVisible(true)
    this.syncButtons()
    this.updateStatus()
  }

  private setErasing(on: boolean): void {
    this.erasing = on
    this.syncButtons()
    this.updateStatus()
  }

  private onPalettePick(_index: number): void {
    // Picking a tile means you want to paint it, not keep erasing.
    this.erasing = false
    this.syncButtons()
    this.updateStatus()
  }

  private mount(): void {
    const style = el('style', {}, EDITOR_CSS)
    document.head.append(style)

    const dot = el('span', { class: 'ed-dot' })
    const dock = el('div', { class: 'ed-dock' })
    dock.append(el('h4', {}, this.doc!.map.id, dot))

    const tools = new Map<Tool, HTMLButtonElement>()
    const toolRow = el('div', { class: 'ed-seg' })
    for (const tool of TOOLS) {
      const b = el('button', { type: 'button' }, cap(tool), el('span', { class: 'ed-key' }, TOOL_KEYS[tool]))
      b.onclick = () => { b.blur(); this.setTool(tool) }
      tools.set(tool, b)
      toolRow.append(b)
    }
    const erase = el('button', { type: 'button' }, 'Erase', el('span', { class: 'ed-key' }, 'E'))
    erase.onclick = () => { erase.blur(); this.setErasing(!this.erasing) }
    const eraseRow = el('div', { class: 'ed-seg' }, erase)
    dock.append(el('div', { class: 'ed-sec' }, el('label', {}, 'Tool'), toolRow, eraseRow))

    const targets = new Map<EditTarget, HTMLButtonElement>()
    const targetRow = el('div', { class: 'ed-seg' })
    for (const { target, label, key } of TARGET_LABELS) {
      const b = el('button', { type: 'button' }, label, el('span', { class: 'ed-key' }, key))
      b.onclick = () => { b.blur(); this.setTarget(target) }
      targets.set(target, b)
      targetRow.append(b)
    }
    const grid = checkbox('Grid (G)', true, (on) => this.overlay?.setGridVisible(on))
    const coll = checkbox('Collision (V)', false, (on) => this.overlay?.setCollisionVisible(on))
    dock.append(el('div', { class: 'ed-sec' }, el('label', {}, 'Layer'), targetRow, grid.row, coll.row))

    const palWrap = el('div', { class: 'ed-pal-wrap' }, this.palette!.canvas)
    dock.append(palWrap)

    const undo = el('button', { class: 'ed-icon', type: 'button', title: 'Undo' }, '↶')
    undo.onclick = () => { undo.blur(); this.undo() }
    const redo = el('button', { class: 'ed-icon', type: 'button', title: 'Redo' }, '↷')
    redo.onclick = () => { redo.blur(); this.redo() }
    const save = el('button', { class: 'ed-save', type: 'button' }, 'Save')
    save.onclick = () => { save.blur(); void this.save() }
    dock.append(el('div', { class: 'ed-foot2' }, undo, redo, save))

    const cellText = el('span', {}, '–')
    const tileText = el('span', {}, '–')
    const zoomText = el('span', {}, '1.00x')
    const message = el('span', { class: 'ed-msg' })
    const bar = el('div', { class: 'ed-bar' },
      el('span', {}, el('b', {}, 'cell '), cellText),
      el('span', {}, el('b', {}, 'paint '), tileText),
      el('span', {}, el('b', {}, 'zoom '), zoomText),
      message)

    this.root.append(dock, bar)
    this.dom = {
      style, dock, bar, tools, targets, erase, save, undo, redo, dot,
      gridCheck: grid.input, collisionCheck: coll.input,
      cellText, tileText, zoomText, message,
    }

    // The sheet is 512px wide and the dock is 300; fit it rather than making
    // the designer scroll sideways to reach half the palette.
    this.palette!.fitWidth(palWrap.clientWidth - 26)
    this.syncButtons()
    this.updateStatus()
  }

  private syncButtons(): void {
    const dom = this.dom
    const doc = this.doc
    if (!dom || !doc) return
    for (const [tool, b] of dom.tools) b.setAttribute('aria-pressed', String(tool === this.tool))
    for (const [target, b] of dom.targets) b.setAttribute('aria-pressed', String(target === this.target))
    dom.erase.setAttribute('aria-pressed', String(this.erasing))
    dom.undo.disabled = !doc.canUndo
    dom.redo.disabled = !doc.canRedo
    dom.save.disabled = this.saving || !doc.dirty
    dom.save.textContent = this.saving ? 'Saving…' : doc.dirty ? 'Save' : 'Saved'
    dom.dot.dataset.dirty = doc.dirty ? '1' : '0'
    // Selecting the collision layer turns its overlay on; the checkbox has to
    // follow, or it claims the thing on screen is off.
    dom.gridCheck.checked = this.overlay?.isGridVisible ?? true
    dom.collisionCheck.checked = this.overlay?.isCollisionVisible ?? false
  }

  private updateStatus(): void {
    const dom = this.dom
    if (!dom) return
    dom.cellText.textContent = this.hover ? `${this.hover.x},${this.hover.y}` : '–'
    if (this.erasing) {
      dom.tileText.textContent = this.target === COLLISION ? 'clear' : 'erase'
    } else if (this.target === COLLISION) {
      dom.tileText.textContent = 'block'
    } else {
      dom.tileText.textContent = `#${this.palette?.selectedIndex ?? 0}`
    }
    this.syncButtons()
  }

  private message(text: string, tone: 'ok' | 'err'): void {
    const dom = this.dom
    if (!dom) return
    dom.message.textContent = text
    dom.message.dataset.tone = tone
    window.setTimeout(() => {
      if (this.dom?.message.textContent === text) {
        this.dom.message.textContent = ''
        delete this.dom.message.dataset.tone
      }
    }, MESSAGE_MS)
  }
}

/** Tiles the arrow keys move the camera per press. */
const NUDGE_TILES = 2
const ZOOM_PER_NOTCH = 1.15
const MESSAGE_MS = 4000

function layersOf(target: EditTarget): LayerName[] {
  return target === COLLISION ? [] : [target]
}

function firstPaintable(count: number, ok: (i: number) => boolean): number {
  for (let i = 0; i < count; i++) if (ok(i)) return i
  return 0
}

function cap(s: string): string { return s[0]!.toUpperCase() + s.slice(1) }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const kid of kids) node.append(kid)
  return node
}

function checkbox(label: string, on: boolean, onChange: (on: boolean) => void) {
  const input = el('input', { type: 'checkbox' })
  input.checked = on
  input.onchange = () => onChange(input.checked)
  const row = el('label', { class: 'ed-check' }, input, label)
  return { row, input }
}
