import type { Renderer } from '../core/renderer'
import type { Assets } from '../core/assets'
import type { OverworldMode } from '../modes/overworld'
import type { EditorServer } from './server'
import { parseMap, type LayerName } from '../world/map'
import { EMPTY_TILE, isPaintable, parseTileset } from '../world/tileset'
import { stampWrites, type Write } from './stamp'
import { fetchJson } from '../core/paths'
import { MIN_ZOOM, MAX_ZOOM } from '../world/projection'
import { MapDoc, COLLISION, isNothing, blankMap, resizeMap, type EditTarget, type Touched } from './mapDoc'
import { TOOLS, toolCells, rectCells, isPreviewTool, type Cell, type Tool } from './tools'
import { TilePalette } from './palette'
import { EditorOverlay } from './overlay'
import { serializeMap } from './mapFile'
import { bundleChanges, saveBundle } from './handoff'
import { EDITOR_CSS, DOCK_PX } from './editorCss'
import { el, checkbox, slider } from './dom'
import { DialogueEditor } from './dialogueEditor'
import { EntityEditor } from './entityEditor'
import { TilesetEditor } from './tilesetEditor'
import { MapPicker } from './mapPicker'
import { EventEditor } from './eventEditor'
import type { ModeManager } from '../core/mode'
import type { DialogueMode } from '../modes/dialogue'
import type { GameState } from '../world/gameState'
import { TILE, VIRTUAL_W, VIRTUAL_H } from '../core/config'
import { DEFAULT_HOUR, HOURS, hourLabel } from '../world/daylight'
import type { Tileset } from '../world/tileset'

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
  modes: ModeManager
  dialogue: DialogueMode
  state: GameState
}

/** The panels the dock can show. Entities and events join this later. */
const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'entities', label: 'Entities' },
  { id: 'events', label: 'Events' },
  { id: 'dialogue', label: 'Dialogue' },
  { id: 'tileset', label: 'Sheet' },
] as const
type Tab = (typeof TABS)[number]['id']

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

  private tab: Tab = 'map'
  private dialogueEditor?: DialogueEditor
  private entityEditor?: EntityEditor
  private tilesetEditor?: TilesetEditor
  private mapPicker?: MapPicker
  private eventEditor?: EventEditor
  private target: EditTarget = 'ground'
  private tool: Tool = 'brush'
  private erasing = false

  private camX = 0
  private camY = 0
  private zoom = 1

  private painting?: Painting
  /** Where the current stroke began: the lattice a multi-tile stamp snaps to. */
  private strokeOrigin: Cell = { x: 0, y: 0 }
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
    download: HTMLButtonElement
    dot: HTMLElement
    tabs: Map<Tab, HTMLButtonElement>
    mapPane: HTMLElement
    docFoot: HTMLElement
    gridCheck: HTMLInputElement
    collisionCheck: HTMLInputElement
    hour: { input: HTMLInputElement; set: (v: number) => void }
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
  /** Unsaved work in any pane, for a caller that wants to warn before losing it. */
  get dirty(): boolean {
    return (this.doc?.dirty ?? false)
      || (this.dialogueEditor?.dirty ?? false)
      || (this.tilesetEditor?.dirty ?? false)
  }

  // --- Session -------------------------------------------------------------

  async open(server: EditorServer): Promise<void> {
    if (this.doc) return
    this.server = server
    const { overworld, assets, gfx } = this.host
    const map = overworld.currentMap
    const tileset = overworld.currentTileset

    this.doc = new MapDoc(overworld.currentMapPath, map)

    this.overlay = new EditorOverlay()
    overworld.overlayScene.add(this.overlay.group)
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

    this.entityEditor = new EntityEditor({
      doc: () => this.doc!,
      tileset: () => this.host.overworld.currentTileset,
      server,
      applyTouched: (touched) => {
        if (!isNothing(touched)) this.refresh(touched)
        this.syncButtons()
      },
      paintMarks: (marks, selected) => {
        this.overlay?.setMarks(marks)
        this.overlay?.setCursor(selected ? [selected] : [])
      },
      openDialogue: (path) => this.openDialogue(path),
      message: (text, tone) => this.message(text, tone),
    })

    this.eventEditor = new EventEditor({
      server,
      doc: () => this.doc!,
      state: this.host.state,
      applyTouched: (touched) => {
        if (!isNothing(touched)) this.refresh(touched)
        this.syncButtons()
      },
      paintMarks: (marks, selected) => {
        this.overlay?.setMarks(marks)
        this.overlay?.setCursor(selected ? [selected] : [])
      },
      openDialogue: (path) => this.openDialogue(path),
      message: (text, tone) => this.message(text, tone),
    })

    this.mapPicker = new MapPicker({
      server,
      currentMap: () => this.doc!.map,
      currentPath: () => this.doc!.path,
      dirty: () => this.dirty,
      openMap: (path) => this.openMap(path),
      createMap: (id, width, height) => this.createMap(id, width, height),
      resizeMap: (width, height) => this.resize(width, height),
      message: (text, tone) => this.message(text, tone),
    })

    this.tilesetEditor = new TilesetEditor({
      server,
      assets: this.host.assets,
      current: () => this.host.overworld.currentTileset,
      currentPath: () => this.doc?.map.tileset ?? '',
      useForMap: (path) => {
        const touched = this.doc?.editMap('use sheet', (map) => { map.tileset = path })
        if (touched && !isNothing(touched)) {
          this.refresh(touched)
          this.syncButtons()
          this.message(`The map now uses ${path}`, 'ok')
        }
      },
      reloadWorld: async () => {
        // The map's tiles and props are drawn through the tileset, so a saved
        // rider only shows once the world is rebuilt from it.
        await this.host.overworld.reload()
        this.doc = new MapDoc(this.host.overworld.currentMapPath, this.host.overworld.currentMap)
        this.overlay?.setMap(this.doc.map)
        this.syncButtons()
      },
      message: (text, tone) => this.message(text, tone),
    })

    this.dialogueEditor = new DialogueEditor({
      server,
      modes: this.host.modes,
      dialogue: this.host.dialogue,
      currentMap: () => this.host.overworld.currentMap,
      message: (text, tone) => this.message(text, tone),
      onDirtyChange: () => this.syncButtons(),
    })

    // Move the presented frame clear of the dock before framing anything
    // against it.
    gfx.setViewportInset(DOCK_PX)
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

    gfx.setViewportInset(0)
    this.overlay?.dispose()
    this.dom?.dock.remove()
    this.dom?.bar.remove()
    this.dom?.style.remove()

    // Whatever pane was showing, the game goes back to rendering the world.
    this.dialogueEditor?.deactivate()
    this.entityEditor?.deactivate()
    this.tilesetEditor?.deactivate()
    this.eventEditor?.deactivate()
    this.host.modes.switchNow('overworld')
    this.host.overworld.projection.setZoom(1)
    this.dialogueEditor = undefined
    this.entityEditor = undefined
    this.tilesetEditor = undefined
    this.mapPicker = undefined
    this.eventEditor = undefined
    this.tab = 'map'
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
   * Frame the whole map, with half a tile of margin so its border is not flush
   * against the edge of the screen.
   *
   * The dock does not enter into this: the renderer insets the whole presented
   * frame past it, so the visible area and the frame are the same thing.
   */
  private fitMap(): void {
    const map = this.doc!.map
    const fitW = (VIRTUAL_W / TILE) / (map.width + 1)
    const fitH = (VIRTUAL_H / TILE) / (map.height + 1)
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(fitW, fitH)))
    this.camX = (map.width - 1) / 2
    this.camY = (map.height - 1) / 2
    this.applyCamera()
  }

  private applyCamera(): void {
    const proj = this.host.overworld.projection
    proj.setZoom(this.zoom)
    proj.lookAt(this.camX, this.camY)
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
    if (!this.doc || !this.paintsOnCanvas) return
    // Middle button, or space held, pans. Anything else paints.
    if (e.button === 1 || e.button === 2 || this.spaceHeld) {
      this.pan = { clientX: e.clientX, clientY: e.clientY, camX: this.camX, camY: this.camY }
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const cell = this.cellAt(e.clientX, e.clientY)
    if (!cell) return

    if (this.tab === 'entities') { this.entityEditor?.pointerDown(cell); return }
    if (this.tab === 'events') { this.eventEditor?.pointerDown(cell); return }

    if (this.tool === 'eyedropper') { this.eyedrop(cell); return }

    this.doc.beginStroke(`${this.tool} ${this.target}`)
    this.strokeOrigin = cell
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
      // A fill covers a region, so it tiles the stamp inside it rather than
      // stamping past its edge.
      this.applyCells(
        toolCells(this.doc, this.target, this.tool, cell, cell),
        this.tool === 'fill',
      )
      // A fill is one click and done; there is nothing to drag.
      if (this.tool === 'fill') this.finishStroke()
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.doc || !this.paintsOnCanvas) return

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

    if (this.tab === 'entities') { this.entityEditor?.pointerDrag(cell); return }
    if (this.tab === 'events') { this.eventEditor?.pointerDrag(cell); return }

    const p = this.painting
    if (!p) { this.overlay?.setCursor(this.footprint(cell)); return }

    if (p.preview) {
      p.last = cell
      this.overlay?.setCursor(rectCells(p.from, cell))
      return
    }
    if (cell.x === p.last.x && cell.y === p.last.y) return
    // Brush: fill in the cells the pointer skipped over between frames.
    this.applyCells(toolCells(this.doc, p.target, p.tool, p.last, cell))
    p.last = cell
    this.overlay?.setCursor(this.footprint(cell))
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.pan) { this.pan = undefined; return }
    if (this.tab === 'entities') { this.entityEditor?.pointerUp(); return }
    if (this.tab === 'events') { this.eventEditor?.pointerUp(); return }
    if (!this.painting || e.button !== 0) return
    const p = this.painting
    if (p.preview) this.applyCells(rectCells(p.from, p.last), true)
    this.finishStroke()
  }

  private onPointerLeave(): void {
    this.hover = undefined
    if (!this.painting) this.overlay?.setCursor([])
    this.updateStatus()
  }

  private onWheel(e: WheelEvent): void {
    if (!this.doc || !this.paintsOnCanvas) return
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

  /** Tabs that act on the world: they pick, pan and zoom against the canvas. */
  private get paintsOnCanvas(): boolean {
    return this.tab === 'map' || this.tab === 'entities' || this.tab === 'events'
  }


  /** World tiles covered by one client pixel, for panning. */
  private tilesPerPixel(): number {
    const { h } = this.host.overworld.projection.framedTiles
    return h / (VIRTUAL_H * this.host.gfx.integerScale)
  }

  // --- Editing -------------------------------------------------------------

  /** The block of cells one brush position lays down, and what goes in each. */
  private get stamp(): { w: number; h: number } {
    // Collision and erase have no art, but they keep the selection's footprint:
    // a 2x3 grab should block or clear a 2x3 area, not one tile.
    const region = this.palette?.selectedRegion
    return { w: region?.w ?? 1, h: region?.h ?? 1 }
  }

  /**
   * Expand a tool's cells through the palette selection. See stamp.ts for the
   * rule; this just supplies the pieces it needs from the editor's state.
   */
  private writesFor(cells: readonly Cell[], clip: boolean): Write[] {
    const tileset = this.host.overworld.currentTileset
    const region = this.palette?.selectedRegion ?? { col: 0, row: 0, w: 1, h: 1 }
    const collision = this.target === COLLISION
    const flat = collision ? (this.erasing ? 0 : 1) : this.erasing ? EMPTY_TILE : undefined
    return stampWrites(cells, region, this.strokeOrigin, tileset.cols, clip, flat)
  }

  private applyCells(cells: readonly Cell[], clip = false): void {
    const doc = this.doc
    if (!doc) return
    let changed = false
    for (const w of this.writesFor(cells, clip)) {
      changed = doc.set(this.target, w.x, w.y, w.value) || changed
    }
    if (changed) {
      this.refresh({
        layers: layersOf(this.target),
        collision: this.target === COLLISION,
        entities: false,
        light: false,
        world: false,
      })
    }
  }

  private finishStroke(): void {
    const doc = this.doc
    if (!doc) return
    this.painting = undefined
    const touched = doc.endStroke()
    if (!isNothing(touched)) this.refresh(touched)
    // Drop a rect's preview back to the single hovered cell, or the region it
    // just painted stays washed out under the highlight.
    this.overlay?.setCursor(this.hover ? this.footprint(this.hover) : [])
    this.updateStatus()
    this.syncButtons()
  }

  /** Push document changes into the meshes and the overlay. */
  private refresh(touched: Touched): void {
    if (touched.world) {
      // A different tileset re-reads every index in the map; nothing short of
      // building the world again is correct.
      void this.rebuildWorld()
      return
    }
    if (touched.layers.length > 0) this.host.overworld.rebuildLayers(touched.layers)
    if (touched.collision) this.overlay?.setCollision(this.doc!.map)
    if (touched.light) this.host.overworld.setHour(this.doc!.map.hour ?? DEFAULT_HOUR)
    if (touched.entities) {
      // Reloads character definitions and dialogue, so it cannot be awaited
      // from a pointer handler. Failures land in the status bar.
      void this.host.overworld.rebuildEntities()
        .then(() => { this.entityEditor?.refresh(); this.eventEditor?.refresh() })
        .catch((err: Error) => this.message(`Could not rebuild: ${err.message}`, 'err'))
    }
  }

  // --- Maps ----------------------------------------------------------------

  /** Open a different map, replacing the document and everything built from it. */
  private async openMap(path: string): Promise<void> {
    try {
      await this.host.overworld.reload(path)
      const map = this.host.overworld.currentMap
      this.adoptMap(new MapDoc(path, map), this.host.overworld.currentTileset)
      this.message(`Opened ${map.id}`, 'ok')
    } catch (err) {
      this.message(`Could not open ${path}: ${(err as Error).message}`, 'err')
    }
  }

  /**
   * Make a map and save it straight away, so it exists to be warped to and to
   * be zipped up. It borrows the open map's tileset and its most-used ground
   * tile: a blank map filled with nothing renders as the void.
   */
  private async createMap(id: string, width: number, height: number): Promise<void> {
    const doc = this.doc
    const server = this.server
    if (!doc || !server) return
    const path = `data/maps/${id}.json`
    try {
      const fill = commonest(doc.map.layers.ground)
      const map = blankMap(id, width, height, doc.map.tileset, fill)
      const text = serializeMap(map)
      parseMap(JSON.parse(text), this.host.overworld.currentTileset, path)
      await server.write(path, text, 'application/json')
      await this.openMap(path)
      this.message(`Made ${path}`, 'ok')
    } catch (err) {
      this.message(`Could not make the map: ${(err as Error).message}`, 'err')
    }
  }

  /** Resize in place, as one undoable action. */
  private resize(width: number, height: number): void {
    const doc = this.doc
    if (!doc) return
    try {
      const fill = commonest(doc.map.layers.ground)
      const touched = doc.replaceMap(
        `resize to ${width}x${height}`,
        resizeMap(doc.map, width, height, fill),
      )
      if (isNothing(touched)) return
      // Every grid changed shape, so every mesh and the overlay have to go.
      // Re-frame afterwards: a map that just grew is mostly off screen.
      void this.rebuildWorld().then(() => this.fitMap())
      this.message(`Resized to ${width}×${height}`, 'ok')
    } catch (err) {
      this.message(`Could not resize: ${(err as Error).message}`, 'err')
    }
  }

  /** Point every pane at a newly loaded document. */
  private adoptMap(doc: MapDoc, tileset: Tileset): void {
    this.doc = doc
    this.overlay?.setMap(doc.map)
    void this.host.assets.texture(tileset.image).then((sheet) => {
      this.palette?.setTileset(tileset, sheet.image as CanvasImageSource)
    })
    this.mapPicker?.refresh()
    this.entityEditor?.refresh()
    this.eventEditor?.refresh()
    this.fitMap()
    this.syncButtons()
    if (this.dom) this.dom.dock.querySelector('h4')!.firstChild!.textContent = doc.map.id
  }

  /**
   * Rebuild the scene from the document's map, keeping the same MapDoc so the
   * undo stack survives. Used when a change invalidates the tile meshes
   * wholesale, such as pointing the map at another sheet.
   */
  private async rebuildWorld(): Promise<void> {
    const doc = this.doc
    if (!doc) return
    try {
      const tileset = await loadTileset(doc.map.tileset)
      await this.host.overworld.applyMap(doc.map, tileset)
      this.overlay?.setMap(doc.map)
      const sheet = await this.host.assets.texture(tileset.image)
      this.palette?.setTileset(tileset, sheet.image as CanvasImageSource)
      this.entityEditor?.refresh()
      this.eventEditor?.refresh()
      this.mapPicker?.refresh()
      this.syncButtons()
      this.applyCamera()
    } catch (err) {
      this.message(`Could not rebuild: ${(err as Error).message}`, 'err')
    }
  }

  /** The block the cursor would lay down, for the highlight. */
  private footprint(cell: Cell): Cell[] {
    const { w, h } = this.stamp
    if (w === 1 && h === 1) return [cell]
    const cells: Cell[] = []
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) cells.push({ x: cell.x + i, y: cell.y + j })
    }
    return cells
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
      this.mapPicker?.refresh()
      this.message(`Saved ${doc.path}`, 'ok')
    } catch (err) {
      this.message(`Could not save: ${(err as Error).message}`, 'err')
    } finally {
      this.saving = false
      this.syncButtons()
    }
  }

  /**
   * Pack the whole content folder into a zip and hand it to the browser.
   *
   * This is the only route the designer's work has back to the repo (handoff
   * decision 8), so it sends everything in the folder rather than only the map
   * on screen — the point is that nothing they made gets left behind.
   */
  async downloadChanges(): Promise<void> {
    const server = this.server
    if (!server || !this.dom) return
    const button = this.dom.download
    button.disabled = true
    button.textContent = 'Packing…'
    try {
      if (this.doc?.dirty) {
        // Saying so beats silently exporting the version on disk.
        this.message('Unsaved edits are not in the zip — save first', 'err')
        return
      }
      const bundle = await bundleChanges(server)
      if (bundle.paths.length === 0) {
        this.message('Nothing edited yet, so nothing to send', 'err')
        return
      }
      saveBundle(bundle)
      this.message(`${bundle.paths.length} file(s) in ${bundle.filename}`, 'ok')
    } catch (err) {
      this.message(`Could not pack your changes: ${(err as Error).message}`, 'err')
    } finally {
      button.disabled = false
      button.textContent = 'Download my changes'
    }
  }

  /** Ctrl-S saves whatever pane is showing. */
  private async saveActive(): Promise<void> {
    if (this.tab === 'dialogue') await this.dialogueEditor?.save()
    else if (this.tab === 'tileset') await this.tilesetEditor?.save()
    else await this.save()
  }

  // --- Keyboard ------------------------------------------------------------

  private spaceHeld = false

  private onKey(e: KeyboardEvent): void {
    if (!this.doc) return
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    const mod = e.metaKey || e.ctrlKey
    if (mod && e.code === 'KeyS') { e.preventDefault(); void this.saveActive(); return }
    // Undo belongs to the pane that is showing. The dialogue pane's own fields
    // handle text undo natively, and stealing the shortcut would break that.
    if (mod && this.tab !== 'dialogue' && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      e.preventDefault()
      if (e.code === 'KeyY' || e.shiftKey) this.redo(); else this.undo()
      return
    }
    if (mod) return
    if (!this.paintsOnCanvas) return
    // Camera keys work wherever the world is on screen; the tool and layer
    // shortcuts belong to the map pane.
    if (this.tab !== 'map' && !CAMERA_KEYS.has(e.code)) return

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

  /**
   * Show one pane. Leaving the map pane hides the editing overlay and hands the
   * screen to whatever the new pane wants to draw — for dialogue, the game's own
   * box over the frozen world. `script` opens that pane on one named file.
   */
  private async setTab(tab: Tab, script?: string): Promise<void> {
    this.tab = tab
    const dom = this.dom
    if (dom) {
      for (const [id, b] of dom.tabs) b.setAttribute('aria-pressed', String(id === tab))
      dom.mapPane.hidden = tab !== 'map'
      // Undo and Save act on the map document, which both of these panes edit.
      dom.docFoot.hidden = tab === 'dialogue' || tab === 'tileset'
    }
    if (this.dialogueEditor) this.dialogueEditor.root.hidden = tab !== 'dialogue'
    if (this.entityEditor) this.entityEditor.root.hidden = tab !== 'entities'
    if (this.tilesetEditor) this.tilesetEditor.root.hidden = tab !== 'tileset'
    if (this.eventEditor) this.eventEditor.root.hidden = tab !== 'events'

    if (tab !== 'dialogue') this.dialogueEditor?.deactivate()
    if (tab !== 'entities') this.entityEditor?.deactivate()
    if (tab !== 'tileset') this.tilesetEditor?.deactivate()
    if (tab !== 'events') this.eventEditor?.deactivate()

    if (tab === 'dialogue') {
      // The grid over a world that is only a backdrop for the box is noise.
      if (this.overlay) this.overlay.group.visible = false
      await this.dialogueEditor?.activate(script)
    } else {
      this.host.modes.switchNow('overworld')
      if (this.overlay) this.overlay.group.visible = true
      this.applyCamera()
      if (tab === 'map') this.overlay?.setMarks([])
      if (tab === 'entities') this.entityEditor?.activate()
      if (tab === 'tileset') await this.tilesetEditor?.activate()
      if (tab === 'events') this.eventEditor?.activate()
    }
    this.syncButtons()
  }

  /**
   * Show one script in the dialogue pane. Wired to the Edit button beside every
   * dialogue path, so the way from an NPC to the words they say is one click
   * rather than a tab and a name to recognise in a list.
   */
  private openDialogue(path: string): void {
    void this.setTab('dialogue', path)
  }

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

    const tabs = new Map<Tab, HTMLButtonElement>()
    const tabRow = el('div', { class: 'ed-tabrow' })
    for (const { id, label } of TABS) {
      const b = el('button', { type: 'button' }, label)
      b.onclick = () => { b.blur(); void this.setTab(id) }
      tabs.set(id, b)
      tabRow.append(b)
    }
    dock.append(tabRow)

    const mapPane = el('div', { class: 'ed-pane' })
    mapPane.append(this.mapPicker!.root)

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
    mapPane.append(el('div', { class: 'ed-sec' }, el('label', {}, 'Tool'), toolRow, eraseRow))

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
    mapPane.append(el('div', { class: 'ed-sec' }, el('label', {}, 'Layer'), targetRow, grid.row, coll.row))

    // Time of day is a property of the map rather than of the brush, but this
    // is where the designer is standing when they look at the world, so this is
    // where the dial goes.
    const hour = slider(
      0, HOURS - 1, this.doc!.map.hour ?? DEFAULT_HOUR, hourLabel,
      // Scrubbing shows the hour without writing it down: the world is a
      // rebuild away, the document is not touched, and letting go is what
      // commits. Nothing ticks while the editor is open, so this has to reach
      // the world itself.
      (h) => this.host.overworld.setHour(h),
      (h) => this.commitHour(h),
    )
    mapPane.append(el('div', { class: 'ed-sec' }, el('label', {}, 'Time of day'), hour.row))

    const palWrap = el('div', { class: 'ed-pal-wrap' }, this.palette!.canvas)
    mapPane.append(palWrap)

    const undo = el('button', { class: 'ed-icon', type: 'button', title: 'Undo' }, '↶')
    undo.onclick = () => { undo.blur(); this.undo() }
    const redo = el('button', { class: 'ed-icon', type: 'button', title: 'Redo' }, '↷')
    redo.onclick = () => { redo.blur(); this.redo() }
    const save = el('button', { class: 'ed-save', type: 'button' }, 'Save')
    save.onclick = () => { save.blur(); void this.save() }
    const docFoot = el('div', { class: 'ed-foot2' }, undo, redo, save)

    const download = el('button', { class: 'ed-second', type: 'button' },
      'Download my changes')
    download.onclick = () => { download.blur(); void this.downloadChanges() }

    const cellText = el('span', {}, '–')
    const tileText = el('span', {}, '–')
    const zoomText = el('span', {}, '1.00x')
    const message = el('span', { class: 'ed-msg' })
    const bar = el('div', { class: 'ed-bar' },
      el('span', {}, el('b', {}, 'cell '), cellText),
      el('span', {}, el('b', {}, 'paint '), tileText),
      el('span', {}, el('b', {}, 'zoom '), zoomText),
      message)

    dock.append(mapPane, this.entityEditor!.root, this.eventEditor!.root,
      this.dialogueEditor!.root, this.tilesetEditor!.root, docFoot)
    // The download packs the whole content folder, so it belongs to the session
    // rather than to whichever pane happens to be showing.
    dock.append(el('div', { class: 'ed-foot3' }, download))

    this.root.append(dock, bar)
    this.dom = {
      style, dock, bar, tabs, mapPane, docFoot,
      tools, targets, erase, save, undo, redo, download, dot,
      gridCheck: grid.input, collisionCheck: coll.input,
      hour,
      cellText, tileText, zoomText, message,
    }

    // The sheet is 512px wide and the dock is 300; fit it rather than making
    // the designer scroll sideways to reach half the palette.
    this.palette!.fitWidth(palWrap.clientWidth - 26)
    this.mapPicker!.refresh()
    void this.setTab('map')
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
    const anyDirty = doc.dirty
      || (this.dialogueEditor?.dirty ?? false)
      || (this.tilesetEditor?.dirty ?? false)
    dom.dot.dataset.dirty = anyDirty ? '1' : '0'
    // Selecting the collision layer turns its overlay on; the checkbox has to
    // follow, or it claims the thing on screen is off.
    dom.gridCheck.checked = this.overlay?.isGridVisible ?? true
    dom.collisionCheck.checked = this.overlay?.isCollisionVisible ?? false
    // Undo, redo and opening another map all move the hour without touching the
    // slider, so the slider follows the document rather than the other way.
    dom.hour.set(doc.map.hour ?? DEFAULT_HOUR)
  }

  /**
   * Write the scrubbed hour into the map, as one undoable action.
   *
   * The world is already showing it — `onScrub` put it there — so this is the
   * document catching up, which is also what makes the map dirty and the hour
   * something that survives a save.
   */
  private commitHour(hour: number): void {
    const doc = this.doc
    if (!doc) return
    const touched = doc.editMap('time of day', (map) => { map.hour = hour })
    if (!isNothing(touched)) this.refresh(touched)
    this.syncButtons()
  }

  private updateStatus(): void {
    const dom = this.dom
    if (!dom) return
    dom.cellText.textContent = this.hover ? `${this.hover.x},${this.hover.y}` : '–'
    const { w: sw, h: sh } = this.stamp
    const size = sw * sh > 1 ? ` ${sw}×${sh}` : ''
    if (this.erasing) {
      dom.tileText.textContent = (this.target === COLLISION ? 'clear' : 'erase') + size
    } else if (this.target === COLLISION) {
      dom.tileText.textContent = 'block' + size
    } else {
      dom.tileText.textContent = `#${this.palette?.selectedIndex ?? 0}${size}`
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

/** The value that appears most often, for filling new ground with what is there. */
function commonest(cells: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const c of cells) counts.set(c, (counts.get(c) ?? 0) + 1)
  let best = cells[0] ?? EMPTY_TILE
  let most = 0
  for (const [value, n] of counts) if (n > most) { most = n; best = value }
  return best
}

/** Load a tileset rider by content path, through whatever source is installed. */
async function loadTileset(path: string) {
  return parseTileset(await fetchJson(path), path)
}

/** Keys that only move the view, so they work on any world-facing pane. */
const CAMERA_KEYS = new Set([
  'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
])

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

