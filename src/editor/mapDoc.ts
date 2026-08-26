import { LAYER_NAMES, type GameMap, type LayerName, type MapNpc, type MapProp } from '../world/map'
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
  playerStart: GameMap['playerStart']
  npcs: MapNpc[]
  props: MapProp[]
}

export interface StateEdit {
  kind: 'state'
  from: MapState
  to: MapState
}

/** One undoable action. */
export type Edit = CellEdit | StateEdit

export interface Stroke {
  label: string
  edits: Edit[]
}

/** What a stroke touched, so only the affected meshes are rebuilt. */
export interface Touched {
  layers: LayerName[]
  collision: boolean
  entities: boolean
  /**
   * The map now points at a different tileset, so every tile index in it means
   * something else and the whole world has to be built again. Rebuilding the
   * entities is not enough.
   */
  world: boolean
}

const NOTHING: Touched = { layers: [], collision: false, entities: false, world: false }

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
    return { layers: [], collision: false, entities: true, world: from.tileset !== to.tileset }
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
      if (edit.kind === 'state') restoreState(this.map, edit.to)
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
    if (edit.kind === 'state') restoreState(doc.map, edit.from)
    else doc.cells(edit.target)[edit.index] = edit.from
  }
}

function snapshotState(map: GameMap): MapState {
  return {
    id: map.id,
    tileset: map.tileset,
    playerStart: { ...map.playerStart },
    npcs: map.npcs.map((n) => ({ ...n })),
    props: map.props.map((p) => ({ ...p })),
  }
}

/** Replace in place: the scene and the document share these array objects. */
function restoreState(map: GameMap, state: MapState): void {
  map.id = state.id
  map.tileset = state.tileset
  map.playerStart = { ...state.playerStart }
  map.npcs.splice(0, map.npcs.length, ...state.npcs.map((n) => ({ ...n })))
  map.props.splice(0, map.props.length, ...state.props.map((p) => ({ ...p })))
}

function touchedBy(stroke: Stroke): Touched {
  const layers = new Set<LayerName>()
  let collision = false
  let entities = false
  let world = false
  for (const edit of stroke.edits) {
    if (edit.kind === 'state') {
      entities = true
      world ||= edit.from.tileset !== edit.to.tileset
    } else if (edit.target === COLLISION) collision = true
    else layers.add(edit.target)
  }
  return { layers: LAYER_NAMES.filter((n) => layers.has(n)), collision, entities, world }
}

/** Merge two touched sets, for callers applying several actions at once. */
export function mergeTouched(a: Touched, b: Touched): Touched {
  const layers = new Set([...a.layers, ...b.layers])
  return {
    layers: LAYER_NAMES.filter((n) => layers.has(n)),
    collision: a.collision || b.collision,
    entities: a.entities || b.entities,
    world: a.world || b.world,
  }
}

/** True if a stroke changed nothing worth rebuilding for. */
export function isNothing(t: Touched): boolean {
  return t.layers.length === 0 && !t.collision && !t.entities && !t.world
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
  }
}
