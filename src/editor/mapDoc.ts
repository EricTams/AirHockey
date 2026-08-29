import { LAYER_NAMES, type GameMap, type LayerName, type MapNpc, type MapProp, type MapWarp } from '../world/map'
import type { MapEvent } from '../world/event'
import { EMPTY_TILE } from '../world/tileset'

/**
 * A map being edited, with undo.
 *
 * The map object is mutated in place rather than copied per edit: the scene is
 * built from it, and the layer meshes are rebuilt from the same arrays, so a
 * copy-on-write document would mean reconciling two versions of the world on
 * every brush cell. What makes that safe is that every mutation goes through
 * `set`, which records the old value.
 *
 * Undo is grouped by stroke, not by cell. Dragging a brush across forty tiles
 * is one thing the designer did and one thing Ctrl-Z should take back.
 *
 * Deliberately free of DOM and of Three: this is where the rules live, and it
 * is the part worth testing.
 */

/** The collision grid edits alongside the tile layers and undoes with them. */
export const COLLISION = 'collision'
export type EditTarget = LayerName | typeof COLLISION

export interface CellEdit {
  kind: 'cell'
  target: EditTarget
  index: number
  from: number
  to: number
}

/**
 * Everything about a map that is not a grid, snapshotted whole: its entities,
 * its player start, its id and which tileset it uses.
 *
 * Cells are recorded as before/after values because a stroke touches hundreds
 * of them. This is a handful of small objects, edited structurally — adding an
 * NPC, moving one, retargeting its dialogue — which a per-field diff would
 * model badly for no saving.
 */
export interface MapState {
  id: string
  tileset: string
  hour: GameMap['hour']
  playerStart: GameMap['playerStart']
  npcs: MapNpc[]
  props: MapProp[]
  warps: MapWarp[]
  events: MapEvent[]
}

export interface StateEdit {
  kind: 'state'
  from: MapState
  to: MapState
}

/** One undoable action. */
/**
 * The whole map, before and after.
 *
 * Resizing is not a state change and not a cell change: it moves every cell in
 * every grid at once, because they are row-major and the row length changed.
 * Recording it as anything smaller would either miss it — a resize that leaves
 * the entities alone looks like a no-op to a state snapshot — or record
 * hundreds of cell edits that are really one action.
 */
export interface ShapeEdit {
  kind: 'shape'
  from: GameMap
  to: GameMap
}

export type Edit = CellEdit | StateEdit | ShapeEdit

export interface Stroke {
  label: string
  edits: Edit[]
}

/** What a stroke touched, so only the affected meshes are rebuilt. */
export interface Touched {
  layers: LayerName[]
  collision: boolean
  entities: boolean
  /** The hour changed, so the light and every shadow have to be cast again. */
  light: boolean
  /**
   * The map now points at a different tileset, so every tile index in it means
   * something else and the whole world has to be built again. Rebuilding the
   * entities is not enough.
   */
  world: boolean
}

const NOTHING: Touched =
  { layers: [], collision: false, entities: false, light: false, world: false }

export class MapDoc {
  private undoStack: Stroke[] = []
  private redoStack: Stroke[] = []
  private open?: Stroke
  /** Undo depth at the last save; compared rather than a boolean flag, so that
   *  undoing back to the saved state correctly reports clean. */
  private savedDepth = 0

  constructor(readonly path: string, public map: GameMap) {}

  get dirty(): boolean { return this.undoStack.length !== this.savedDepth }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }
  /** Label of what Ctrl-Z would take back, for the UI. */
  get undoLabel(): string | undefined { return this.undoStack.at(-1)?.label }

  markSaved(): void { this.savedDepth = this.undoStack.length }

  // --- Reading -------------------------------------------------------------

  cells(target: EditTarget): number[] {
    return target === COLLISION ? this.map.collision : this.map.layers[target]
  }

  indexOf(x: number, y: number): number { return y * this.map.width + x }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.map.width && y < this.map.height
  }

  get(target: EditTarget, x: number, y: number): number | undefined {
    if (!this.inBounds(x, y)) return undefined
    return this.cells(target)[this.indexOf(x, y)]
  }

  // --- Writing -------------------------------------------------------------

  /**
   * Open a stroke. Every `set` until `endStroke` undoes as one action.
   * Re-opening without ending is a no-op, so a pointerdown that arrives while a
   * stroke is somehow still open does not split it.
   */
  beginStroke(label: string): void {
    if (!this.open) this.open = { label, edits: [] }
  }

  /**
   * Write one cell. Returns true if it changed anything.
   *
   * Out-of-bounds and no-op writes are dropped rather than recorded: a brush
   * dragged off the map edge and back would otherwise fill the undo stack with
   * edits that undo to themselves.
   */
  set(target: EditTarget, x: number, y: number, value: number): boolean {
    if (!this.inBounds(x, y)) return false
    const index = this.indexOf(x, y)
    const cells = this.cells(target)
    const from = cells[index]!
    if (from === value) return false
    cells[index] = value
    this.open?.edits.push({ kind: 'cell', target, index, from, to: value })
    return true
  }

  /**
   * Run a change to the map's entities, player start, id or tileset as one
   * undoable action.
   *
   * Self-contained rather than part of an open stroke: these come from buttons
   * and drags in the inspector, never from the middle of a brush stroke, and
   * mixing the two would let an undo take back half of each.
   */
  editMap(label: string, mutate: (map: GameMap) => void): Touched {
    const from = snapshotState(this.map)
    mutate(this.map)
    const to = snapshotState(this.map)
    if (JSON.stringify(from) === JSON.stringify(to)) return NOTHING
    this.undoStack.push({ label, edits: [{ kind: 'state', from, to }] })
    this.redoStack = []
    return stateTouched(from, to)
  }

  /**
   * Replace the whole map with a reshaped copy, as one undoable action.
   *
   * The document and the scene share the map object and its arrays, so the new
   * contents are copied into the existing ones rather than swapped in.
   */
  replaceMap(label: string, next: GameMap): Touched {
    const from = cloneMap(this.map)
    if (JSON.stringify(from) === JSON.stringify(next)) return NOTHING
    restoreShape(this.map, next)
    this.undoStack.push({ label, edits: [{ kind: 'shape', from, to: cloneMap(next) }] })
    this.redoStack = []
    return { layers: [...LAYER_NAMES], collision: true, entities: true, light: true, world: true }
  }

  /** Close the stroke and report what it touched. An empty stroke is dropped. */
  endStroke(): Touched {
    const stroke = this.open
    this.open = undefined
    if (!stroke || stroke.edits.length === 0) return NOTHING
    this.undoStack.push(stroke)
    // A new edit makes the redo branch unreachable.
    this.redoStack = []
    return touchedBy(stroke)
  }

  /** Abandon the open stroke, restoring every cell it wrote. */
  cancelStroke(): Touched {
    const stroke = this.open
    this.open = undefined
    if (!stroke || stroke.edits.length === 0) return NOTHING
    revert(this, stroke)
    return touchedBy(stroke)
  }

  undo(): Touched {
    const stroke = this.undoStack.pop()
    if (!stroke) return NOTHING
    revert(this, stroke)
    this.redoStack.push(stroke)
    return touchedBy(stroke)
  }

  redo(): Touched {
    const stroke = this.redoStack.pop()
    if (!stroke) return NOTHING
    for (const edit of stroke.edits) {
      if (edit.kind === 'shape') restoreShape(this.map, edit.to)
      else if (edit.kind === 'state') restoreState(this.map, edit.to)
      else this.cells(edit.target)[edit.index] = edit.to
    }
    this.undoStack.push(stroke)
    return touchedBy(stroke)
  }
}

/** Walk a stroke backwards: later edits to a cell have to unwind first. */
function revert(doc: MapDoc, stroke: Stroke): void {
  for (let i = stroke.edits.length - 1; i >= 0; i--) {
    const edit = stroke.edits[i]!
    if (edit.kind === 'shape') restoreShape(doc.map, edit.from)
    else if (edit.kind === 'state') restoreState(doc.map, edit.from)
    else doc.cells(edit.target)[edit.index] = edit.from
  }
}

function cloneMap(map: GameMap): GameMap {
  return {
    ...map,
    layers: {
      ground: [...map.layers.ground],
      decoration: [...map.layers.decoration],
      overhead: [...map.layers.overhead],
    },
    collision: [...map.collision],
    playerStart: { ...map.playerStart },
    npcs: map.npcs.map((n) => ({ ...n })),
    props: map.props.map((p) => ({ ...p })),
    warps: map.warps.map((w) => ({ ...w })),
    events: structuredClone(map.events),
  }
}

/** Copy `next` into `map` without replacing any array the scene holds. */
function restoreShape(map: GameMap, next: GameMap): void {
  map.id = next.id
  map.width = next.width
  map.height = next.height
  map.tileset = next.tileset
  for (const name of LAYER_NAMES) {
    map.layers[name].splice(0, map.layers[name].length, ...next.layers[name])
  }
  map.collision.splice(0, map.collision.length, ...next.collision)
  restoreState(map, {
    id: next.id,
    tileset: next.tileset,
    hour: next.hour,
    playerStart: next.playerStart,
    npcs: next.npcs,
    props: next.props,
    warps: next.warps,
    events: next.events,
  })
}

function snapshotState(map: GameMap): MapState {
  return {
    id: map.id,
    tileset: map.tileset,
    hour: map.hour,
    playerStart: { ...map.playerStart },
    npcs: map.npcs.map((n) => ({ ...n })),
    props: map.props.map((p) => ({ ...p })),
    warps: map.warps.map((w) => ({ ...w })),
    // Events nest arbitrarily deep, so a shallow copy per entry would leave the
    // undo stack sharing command lists with the live map.
    events: structuredClone(map.events),
  }
}

/** Replace in place: the scene and the document share these array objects. */
function restoreState(map: GameMap, state: MapState): void {
  map.id = state.id
  map.tileset = state.tileset
  map.hour = state.hour
  map.playerStart = { ...state.playerStart }
  map.npcs.splice(0, map.npcs.length, ...state.npcs.map((n) => ({ ...n })))
  map.props.splice(0, map.props.length, ...state.props.map((p) => ({ ...p })))
  map.warps.splice(0, map.warps.length, ...state.warps.map((w) => ({ ...w })))
  map.events.splice(0, map.events.length, ...structuredClone(state.events))
}

/**
 * What a change to the map's state means for the scene.
 *
 * The hour is called out on its own rather than folded into `entities`: it is
 * the only state field that touches no entity at all, and rebuilding every
 * sprite in the world to move the sun would re-fetch their sheets to draw the
 * same characters back in the same places.
 */
function stateTouched(from: MapState, to: MapState): Touched {
  const bar = (state: MapState) => JSON.stringify({ ...state, hour: 0 })
  return {
    layers: [],
    collision: false,
    entities: bar(from) !== bar(to),
    light: from.hour !== to.hour,
    world: from.tileset !== to.tileset,
  }
}

function touchedBy(stroke: Stroke): Touched {
  const layers = new Set<LayerName>()
  let collision = false
  let entities = false
  let light = false
  let world = false
  for (const edit of stroke.edits) {
    if (edit.kind === 'shape') {
      for (const name of LAYER_NAMES) layers.add(name)
      collision = true
      entities = true
      light = true
      world = true
    } else if (edit.kind === 'state') {
      const t = stateTouched(edit.from, edit.to)
      entities ||= t.entities
      light ||= t.light
      world ||= t.world
    } else if (edit.target === COLLISION) collision = true
    else layers.add(edit.target)
  }
  return { layers: LAYER_NAMES.filter((n) => layers.has(n)), collision, entities, light, world }
}

/** Merge two touched sets, for callers applying several actions at once. */
export function mergeTouched(a: Touched, b: Touched): Touched {
  const layers = new Set([...a.layers, ...b.layers])
  return {
    layers: LAYER_NAMES.filter((n) => layers.has(n)),
    collision: a.collision || b.collision,
    entities: a.entities || b.entities,
    light: a.light || b.light,
    world: a.world || b.world,
  }
}

/** True if a stroke changed nothing worth rebuilding for. */
export function isNothing(t: Touched): boolean {
  return t.layers.length === 0 && !t.collision && !t.entities && !t.light && !t.world
}

/**
 * A blank map, for "new map".
 *
 * Ground is filled with the given tile rather than left empty, because an
 * all-empty ground layer renders as the void the backdrop shows through, which
 * reads as broken rather than as blank.
 */
export function blankMap(
  id: string, width: number, height: number, tileset: string, ground: number,
): GameMap {
  const area = width * height
  return {
    id,
    width,
    height,
    tileset,
    layers: {
      ground: new Array<number>(area).fill(ground),
      decoration: new Array<number>(area).fill(EMPTY_TILE),
      overhead: new Array<number>(area).fill(EMPTY_TILE),
    },
    collision: new Array<number>(area).fill(0),
    playerStart: { x: Math.floor(width / 2), y: Math.floor(height / 2), facing: 'down' },
    npcs: [],
    props: [],
    warps: [],
    events: [],
  }
}

/**
 * Resize a map, keeping the top-left corner anchored.
 *
 * Every grid is row-major, so this is not a length change — it is a re-index of
 * every cell after the first row. Getting it wrong scrambles a whole map into
 * something that still validates, which is the worst kind of wrong, so it has
 * tests.
 *
 * Anything that ends up outside the new bounds is dropped, and the player start
 * is pulled back inside rather than dropped, because a map without one does not
 * load.
 */
export function resizeMap(map: GameMap, width: number, height: number, fill: number): GameMap {
  if (!Number.isInteger(width) || width < 1) throw new Error(`invalid width ${width}`)
  if (!Number.isInteger(height) || height < 1) throw new Error(`invalid height ${height}`)

  const regrid = (cells: readonly number[], empty: number): number[] => {
    const out = new Array<number>(width * height).fill(empty)
    const rows = Math.min(height, map.height)
    const cols = Math.min(width, map.width)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) out[y * width + x] = cells[y * map.width + x]!
    }
    return out
  }

  const inside = (e: { x: number; y: number }) => e.x < width && e.y < height
  return {
    ...map,
    width,
    height,
    layers: {
      ground: regrid(map.layers.ground, fill),
      decoration: regrid(map.layers.decoration, EMPTY_TILE),
      overhead: regrid(map.layers.overhead, EMPTY_TILE),
    },
    collision: regrid(map.collision, 0),
    playerStart: {
      ...map.playerStart,
      x: Math.min(map.playerStart.x, width - 1),
      y: Math.min(map.playerStart.y, height - 1),
    },
    npcs: map.npcs.filter(inside).map((n) => ({ ...n })),
    props: map.props.filter(inside).map((p) => ({ ...p })),
    warps: map.warps.filter(inside).map((w) => ({ ...w })),
    events: structuredClone(map.events.filter(inside)),
  }
}
