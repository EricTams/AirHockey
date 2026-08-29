import * as THREE from 'three'
import type { Mode } from '../core/mode'
import type { Renderer } from '../core/renderer'
import type { Input } from '../core/input'
import type { Assets } from '../core/assets'
import { Projection } from '../world/projection'
import { CharacterSprite, walkFrame, type CharacterDef, type Facing } from '../world/character'
import { frameAtTime } from '../world/aseprite'
import { buildTileLayer } from '../world/tileLayer'
import {
  LAYER_NAMES, loadMap, blockedAt, warpAt, eventAt,
  type GameMap, type LayerName, type MapNpc, type MapProp, type MapWarp,
} from '../world/map'
import type { MapEvent } from '../world/event'
import type { GameState } from '../world/gameState'
import { EventRunner, type Request } from '../world/eventRunner'
import { describeTileset, propById, type PropDef, type Tileset } from '../world/tileset'
import { buildProp, placeProp, propOrigin } from '../world/prop'
import { DEFAULT_SHADOW_STYLE, Shadow, SHADOW_LABELS, type ShadowStyle } from '../world/shadow'
import { measurePropTrims, NO_TRIM, type ArtTrim } from '../world/artBounds'
import { Backdrop } from '../world/backdrop'
import { fetchJson } from '../core/paths'
import { parseDialogue, type DialogueScript } from './dialogue'
import type { BattleConfig } from './battle/physics'

/** Doc §6.2: a step tweens over 12 frames at 60Hz. */
const STEP_FRAMES = 12
/** Frames a direction must be held facing before the step commits. */
const TURN_GRACE = 4

/** The map the game boots into (doc §10: "the entry map"). */
export const ENTRY_MAP = 'data/maps/overworld.json'
/** The player's own sprite is a game constant, not map data. */
const PLAYER_CHARACTER = 'data/characters/sleuth.json'

const DIRS: Record<Facing, [number, number]> = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
}

/**
 * An event as the world sees it: which of its pages is live, the sprite that
 * page asks for, and whatever walking it has been told to do.
 */
interface EventSlot {
  def: MapEvent
  /** Index of the live page, or -1 when no page's conditions hold. */
  page: number
  /** The page a trigger has already fired for, so auto and parallel run once. */
  firedPage: number
  sprite?: CharacterSprite
  facing: Facing
  tile: [number, number]
  stepFrom: [number, number]
  stepFrames: number
  walking: Facing[]
  /** A walk was asked for and its runner is owed an answer when it lands. */
  pendingWalk?: boolean
  /** A parallel page's own runner. The foreground one is held by the mode. */
  runner?: EventRunner
}

interface PropSlot {
  def: MapProp
  shape: PropDef
  mesh: THREE.Mesh
  /** Absent while the shadow style is 'none'. */
  shadow?: Shadow
}

interface NpcSlot {
  def: MapNpc
  tile: [number, number]
  sprite?: CharacterSprite
  facing: Facing
  script?: DialogueScript
  battle?: BattleConfig
}

export class OverworldMode implements Mode {
  readonly name = 'overworld'
  private scene = new THREE.Scene()
  private proj = new Projection()
  private backdrop = new Backdrop()
  private sprites = new THREE.Group()
  /**
   * Shadows sit in their own group so one group order puts every one of them
   * above the tile layers and below every sprite and prop. Sorting them
   * against each other would be wrong anyway: a shadow always runs north, so
   * it only ever falls on ground the props behind it have already been drawn
   * on.
   */
  private shadowGroup = new THREE.Group()
  /**
   * The style the world boots into. Soft is the one that reads as light on the
   * ground rather than as a decal under a sprite; the toggle is there to argue
   * with that against real art, not because the choice is still open.
   */
  private shadowStyle: ShadowStyle = DEFAULT_SHADOW_STYLE
  private player?: CharacterSprite

  private map!: GameMap
  private mapPath = ENTRY_MAP
  private tileset!: Tileset
  private sheet!: THREE.Texture
  private layers = new Map<LayerName, THREE.Mesh>()
  /**
   * Empty margin measured inside each prop's region on the sheet, by prop id.
   * Empty when the sheet could not be read, which puts every prop back on its
   * declared region.
   */
  private propTrims = new Map<string, ArtTrim>()
  private npcs: NpcSlot[] = []
  private props: PropSlot[] = []
  private events: EventSlot[] = []
  /**
   * The event holding the player still. Talk, touch and auto pages run here,
   * one at a time; parallel pages run in their own runners alongside.
   */
  private foreground?: EventRunner
  private foregroundSlot?: EventSlot
  private lastStateRevision = -1

  private tx = 0
  private ty = 0
  private facing: Facing = 'down'
  private stepFrom: [number, number] = [0, 0]
  private stepFrames = 0
  private stepsTaken = 0
  private turnGrace = 0
  /** Wall-clock milliseconds the player has been standing still, driving the idle. */
  private standingMs = 0
  /** Set while a map is loading, which suspends the sim. */
  private traveling = false

  constructor(
    private gfx: Renderer,
    private input: Input,
    private assets: Assets,
    private state: GameState,
  ) {
    this.sprites.renderOrder = 10
    this.shadowGroup.renderOrder = 5
    this.scene.add(this.shadowGroup)
    this.scene.add(this.sprites)
  }

  async init(): Promise<void> {
    await this.reload(ENTRY_MAP)
  }

  /**
   * Reload the current map from wherever content is being read from now.
   *
   * The editor calls this after a save, and on entering edit mode once reads
   * have been pointed at the designer's own content folder. Loading is the only
   * way an edit becomes visible: the scene is built once from the file.
   */
  async reload(path = this.mapPath): Promise<void> {
    const { map, tileset } = await loadMap(path)
    this.mapPath = path
    await this.applyMap(map, tileset)
  }

  /** Where the loaded map came from, which is where the editor saves it. */
  get currentMapPath(): string { return this.mapPath }

  /**
   * Follow a warp. Loading is asynchronous, so the sim is held still until the
   * new map is standing — otherwise a held direction would keep walking the
   * player across a world that is halfway replaced.
   */
  private async travel(warp: MapWarp): Promise<void> {
    this.traveling = true
    try {
      const { map, tileset } = await loadMap(warp.to)
      this.mapPath = warp.to
      await this.applyMap(map, tileset, {
        x: warp.toX, y: warp.toY, facing: warp.facing ?? this.facing,
      })
    } catch (err) {
      // A broken warp must not strand the player in a frozen world.
      console.error(`[overworld] warp "${warp.id}" to ${warp.to} failed:`, err)
    } finally {
      this.traveling = false
    }
  }

  /**
   * Build the scene for a map, replacing whatever was there.
   *
   * The player keeps its tile across a rebuild of the same map, so an edit does
   * not walk them back to the start every stroke; a different map, or a tile
   * that the edit put out of bounds, falls back to `playerStart`.
   */
  async applyMap(
    map: GameMap, tileset: Tileset, arriveAt?: { x: number; y: number; facing: Facing },
  ): Promise<void> {
    const sameMap = this.map?.id === map.id
    const keepX = this.tx
    const keepY = this.ty
    const keepFacing = this.facing

    this.disposeScene()
    this.map = map
    this.tileset = tileset

    this.sheet = await this.assets.texture(tileset.image, {
      label: 'TILESET', kind: 'tile', width: tileset.sheetW, height: tileset.sheetH,
    })
    // Measured once per sheet: props are placed by their region, and several
    // regions in the drop are taller than the drawing inside them.
    this.propTrims = measurePropTrims(this.sheet, this.tileset)

    // One merged mesh per layer. Indices come from the file, so the grid is
    // unaffected if the sheet fell back to a placeholder.
    this.rebuildLayers()

    // A warp names where to arrive; otherwise the player keeps their tile
    // across a rebuild of the same map, and falls back to playerStart on a
    // different one — or on one an edit made too small to hold them.
    const arriving = arriveAt && arriveAt.x < map.width && arriveAt.y < map.height
    const inMap = !arriveAt && sameMap && keepX < map.width && keepY < map.height
    this.tx = arriving ? arriveAt.x : inMap ? keepX : map.playerStart.x
    this.ty = arriving ? arriveAt.y : inMap ? keepY : map.playerStart.y
    this.facing = arriving ? arriveAt.facing : inMap ? keepFacing : map.playerStart.facing
    this.stepFrom = [this.tx, this.ty]
    this.stepFrames = 0
    this.turnGrace = 0

    try {
      const def = await fetchJson<CharacterDef>(PLAYER_CHARACTER)
      this.player = await CharacterSprite.load(def, this.assets)
    } catch (err) {
      // Losing the player is the one gap that would otherwise leave nothing to
      // move, so it degrades too rather than aborting the map.
      this.noteBroken(PLAYER_CHARACTER, err)
      this.player = CharacterSprite.broken({ id: 'player' }, 'PLAYER?')
    }
    this.player.setFrame(this.facing, this.player.def.idleFrame)
    this.addSprite(this.player)

    await this.rebuildEntities()

    // Nothing calls lookAt() while the loop is paused, so leave the camera on
    // the player rather than wherever the previous map left it.
    this.proj.lookAt(this.tx, this.ty)
  }

  /**
   * Load one NPC, containing any failure to that NPC.
   *
   * Every path here is one a designer types into the entity editor, so a typo
   * is a normal occurrence rather than a corrupt file. Loading them together
   * under one `Promise.all` meant a single bad path rejected the whole rebuild
   * and the map vanished — the worst possible answer, because it hides which
   * field was wrong and takes the other nineteen entities with it.
   *
   * Each reference is caught on its own: a broken sprite still stands on its
   * tile as a labelled box, and a broken dialogue or battle leaves the NPC
   * there to be fixed rather than removing them. `brokenRefs` is what makes the
   * count visible in the debug readout.
   */
  private async loadNpc(slot: NpcSlot): Promise<void> {
    try {
      const npcDef = await fetchJson<CharacterDef>(slot.def.character)
      slot.sprite = await CharacterSprite.load(npcDef, this.assets)
      if (slot.def.tint !== undefined) slot.sprite.setTint(slot.def.tint)
      slot.sprite.setFrame(slot.facing, 0)
    } catch (err) {
      this.noteBroken(slot.def.character, err)
      slot.sprite = CharacterSprite.broken(slot.def, `NPC? ${slot.def.id}`)
    }
    this.addSprite(slot.sprite)

    if (slot.def.dialogue) {
      try {
        slot.script = parseDialogue(await fetchJson(slot.def.dialogue), slot.def.dialogue)
      } catch (err) { this.noteBroken(slot.def.dialogue, err) }
    }
    if (slot.def.battle) {
      try {
        slot.battle = await fetchJson<BattleConfig>(slot.def.battle)
      } catch (err) { this.noteBroken(slot.def.battle, err) }
    }
  }

  /** Content paths that failed to load, reported in the debug readout. */
  private brokenRefs = new Set<string>()

  private noteBroken(path: string, err: unknown): void {
    if (!this.brokenRefs.has(path)) {
      console.warn(`[world] broken reference ${path} — ${(err as Error).message}`)
    }
    this.brokenRefs.add(path)
  }

  /**
   * Rebuild the NPCs and props from the map's arrays, which the editor edits in
   * place. Everything is loaded again rather than diffed: an NPC's sprite,
   * dialogue and battle all hang off fields the editor can change, and a
   * handful of small fetches is not worth the reconciliation.
   */
  async rebuildEntities(): Promise<void> {
    this.disposeEntities()
    this.brokenRefs.clear()
    const map = this.map

    this.npcs = map.npcs.map((n) => ({ def: n, tile: [n.x, n.y], facing: n.facing }))
    const npcs = Promise.all(this.npcs.map((slot) => this.loadNpc(slot)))

    this.events = map.events.map((def): EventSlot => ({
      def,
      page: -1,
      firedPage: -1,
      facing: 'down',
      tile: [def.x, def.y],
      stepFrom: [def.x, def.y],
      stepFrames: 0,
      walking: [],
    }))
    const events = this.refreshEventPages(true)

    // Props share the tileset sheet, which applyMap has already loaded.
    for (const p of map.props) {
      const shape = propById(this.tileset, p.prop)
      if (!shape) continue   // parseMap rejects this; belt and braces
      const mesh = buildProp(this.sheet, this.tileset, shape, this.trimOf(shape))
      placeProp(this.proj, mesh, shape, p.x, p.y)
      this.sprites.add(mesh)
      const slot: PropSlot = { def: p, shape, mesh }
      this.dressPropShadow(slot)
      this.props.push(slot)
    }

    await Promise.all([npcs, events])
    this.placeEntities()
  }

  // --- Events --------------------------------------------------------------

  /**
   * Work out which page of each event is live, and load the sprite it asks for.
   *
   * Pages are an if/else chain read top to bottom: the first whose conditions
   * all hold wins. Re-evaluated whenever the game state changes, which is what
   * makes a guard step aside the moment the flag that moved them is set.
   */
  private refreshEventPages(force = false): Promise<void> {
    this.lastStateRevision = this.state.revision
    const work: Promise<void>[] = []

    for (const slot of this.events) {
      const next = slot.def.pages.findIndex((p) => this.state.testAll(p.when))
      if (next === slot.page && !force) continue
      slot.page = next
      // A page change re-arms auto and parallel: becoming live is the trigger.
      slot.firedPage = -1
      slot.runner?.cancel()
      slot.runner = undefined
      work.push(this.dressEvent(slot))
    }
    return Promise.all(work).then(() => undefined)
  }

  /** Give an event the sprite its live page asks for, or none. */
  private async dressEvent(slot: EventSlot): Promise<void> {
    const look = slot.def.pages[slot.page]?.look
    if (!look) {
      slot.sprite?.mesh.removeFromParent()
      slot.sprite?.dispose()
      slot.sprite = undefined
      return
    }
    if (slot.sprite) {
      slot.sprite.mesh.removeFromParent()
      slot.sprite.dispose()
    }
    const def = await fetchJson<CharacterDef>(look.character)
    const sprite = await CharacterSprite.load(def, this.assets)
    if (look.tint !== undefined) sprite.setTint(look.tint)
    slot.facing = look.facing
    sprite.setFrame(slot.facing, def.idleFrame)
    slot.sprite = sprite
    this.addSprite(sprite)
  }

  private page(slot: EventSlot) {
    return slot.def.pages[slot.page]
  }

  /** Start an event's live page in the foreground, holding the player still. */
  private startForeground(slot: EventSlot): boolean {
    const page = this.page(slot)
    if (!page || this.foreground) return false
    slot.firedPage = slot.page
    if (page.do.length === 0) return false
    this.foreground = new EventRunner(slot.def.id, page.do, this.state)
    this.foregroundSlot = slot
    return true
  }

  /**
   * Advance the foreground event and every parallel one.
   *
   * Returns true while the foreground event is running, which is what suspends
   * the player: an event that is talking should not also be walked away from.
   */
  private tickEvents(): boolean {
    if (this.state.revision !== this.lastStateRevision) void this.refreshEventPages()

    for (const slot of this.events) {
      const page = this.page(slot)
      if (!page) continue
      if (page.trigger === 'parallel' && slot.firedPage !== slot.page) {
        slot.firedPage = slot.page
        if (page.do.length > 0) slot.runner = new EventRunner(slot.def.id, page.do, this.state)
      }
      if (slot.runner) {
        const step = slot.runner.step()
        if (step.kind === 'suspend') this.serveParallel(slot, step.request)
        if (slot.runner.isDone) slot.runner = undefined
      }
    }

    // Auto pages run as soon as they become live, but only when nothing else
    // has the floor.
    if (!this.foreground) {
      for (const slot of this.events) {
        const page = this.page(slot)
        if (page?.trigger === 'auto' && slot.firedPage !== slot.page) {
          if (this.startForeground(slot)) break
          slot.firedPage = slot.page
        }
      }
    }

    const runner = this.foreground
    if (!runner) return false
    if (runner.isSuspended) return true

    const step = runner.step()
    if (step.kind === 'suspend') {
      this.serve(step.request)
      return true
    }
    if (runner.isDone) {
      this.foreground = undefined
      this.foregroundSlot = undefined
      return false
    }
    return true
  }

  /**
   * Carry out a foreground request. Anything that changes mode leaves the
   * runner suspended; `enter` resumes it when the game comes back.
   */
  private serve(request: Request): void {
    const slot = this.foregroundSlot
    switch (request.kind) {
      case 'say':
        this.onSwitch?.('dialogue', {
          script: { id: `${slot?.def.id ?? 'event'}:inline`, lines: request.lines },
          next: { mode: 'overworld' },
        })
        return
      case 'script':
        void fetchJson(request.path).then((raw) => {
          this.onSwitch?.('dialogue', {
            script: parseDialogue(raw, request.path),
            next: { mode: 'overworld' },
          })
        }).catch((err: Error) => this.abortEvent(request.path, err))
        return
      case 'battle':
        void fetchJson<BattleConfig>(request.path).then((config) => {
          this.onSwitch?.('battle', { config, returnTo: 'overworld' })
        }).catch((err: Error) => this.abortEvent(request.path, err))
        return
      case 'warp':
        void this.travel({
          id: `${slot?.def.id ?? 'event'}:warp`,
          x: 0, y: 0,
          to: request.target.to,
          toX: request.target.x,
          toY: request.target.y,
          facing: request.target.facing,
        })
        return
      case 'face':
        if (slot) {
          slot.facing = request.facing
          slot.sprite?.setFrame(slot.facing, slot.sprite.def.idleFrame)
        }
        this.foreground?.resume()
        return
      case 'walk':
        if (slot) slot.walking = [...request.steps]
        else this.foreground?.resume()
        return
    }
  }

  /** A parallel event gets the same treatment, minus anything that takes over
   *  the screen: it is running while the player walks, so it must not. */
  private serveParallel(slot: EventSlot, request: Request): void {
    switch (request.kind) {
      case 'face':
        slot.facing = request.facing
        slot.sprite?.setFrame(slot.facing, slot.sprite.def.idleFrame)
        slot.runner?.resume()
        return
      case 'walk':
        slot.walking = [...request.steps]
        return
      default:
        // Dialogue, battles and warps all take the screen. Refusing them here
        // is clearer than letting one interrupt the player mid-step.
        console.warn(
          `[overworld] event "${slot.def.id}" is a parallel page and cannot "${request.kind}"`,
        )
        slot.runner?.resume()
    }
  }

  private abortEvent(what: string, err: Error): void {
    console.error(`[overworld] event stopped: ${what}:`, err)
    this.foreground?.cancel()
    this.foreground = undefined
    this.foregroundSlot = undefined
  }

  /** Move events that are walking, resuming their runner when they arrive. */
  private stepEventWalks(): void {
    for (const slot of this.events) {
      if (slot.stepFrames > 0) {
        slot.stepFrames--
        if (slot.stepFrames > 0) continue
      }
      if (slot.walking.length === 0) {
        // Arrived, and the runner that asked for it is owed an answer.
        const runner = slot.runner ?? (this.foregroundSlot === slot ? this.foreground : undefined)
        if (runner?.isSuspended && slot.stepFrames === 0 && slot.pendingWalk) {
          slot.pendingWalk = false
          runner.resume()
        }
        continue
      }
      const dir = slot.walking.shift()!
      const [dx, dy] = DIRS[dir]
      const nx = slot.tile[0] + dx
      const ny = slot.tile[1] + dy
      slot.facing = dir
      slot.pendingWalk = true
      if (!blockedAt(this.map, nx, ny)) {
        slot.stepFrom = [...slot.tile] as [number, number]
        slot.tile = [nx, ny]
        slot.stepFrames = STEP_FRAMES
      }
    }
  }

  /** Fire a talk trigger on the tile the player faces. Returns true if one ran. */
  private tryTalkEvent(fx: number, fy: number): boolean {
    const found = eventAt(this.map, fx, fy)
    const slot = found && this.events.find((s) => s.def.id === found.id)
    const page = slot && this.page(slot)
    if (!slot || !page || page.trigger !== 'talk') return false

    // Turn to face the player before speaking, as NPCs do.
    const opposite: Record<Facing, Facing> = { up: 'down', down: 'up', left: 'right', right: 'left' }
    slot.facing = opposite[this.facing]
    slot.sprite?.setFrame(slot.facing, slot.sprite.def.idleFrame)
    return this.startForeground(slot)
  }

  /**
   * Put every sprite and prop on its tile.
   *
   * Split out of `update` because `update` is the only thing that used to do
   * it, and the editor pauses the loop — which left every sprite a rebuild
   * created sitting at the world origin, stacked on top of each other in the
   * map's top-left corner.
   *
   * The player's position is passed in because it interpolates mid-step;
   * everything else stands still on its own tile.
   */
  private placeEntities(px = this.tx, py = this.ty): void {
    if (this.player) {
      this.proj.placeBillboard(this.player.mesh, px, py)
      this.player.mesh.renderOrder = this.proj.sortKey(py)
      this.player.shadow?.place(px, py)
    }
    for (const npc of this.npcs) {
      if (!npc.sprite) continue
      this.proj.placeBillboard(npc.sprite.mesh, npc.tile[0], npc.tile[1])
      npc.sprite.mesh.renderOrder = this.proj.sortKey(npc.tile[1])
      npc.sprite.shadow?.place(npc.tile[0], npc.tile[1])
    }
    for (const slot of this.events) {
      if (!slot.sprite) continue
      // Interpolated like the player, so a walking event tweens rather than
      // jumping a whole tile at a time.
      const t = slot.stepFrames > 0 ? 1 - slot.stepFrames / STEP_FRAMES : 1
      const ex = slot.stepFrom[0] + (slot.tile[0] - slot.stepFrom[0]) * t
      const ey = slot.stepFrom[1] + (slot.tile[1] - slot.stepFrom[1]) * t
      this.proj.placeBillboard(slot.sprite.mesh, ex, ey)
      slot.sprite.mesh.renderOrder = this.proj.sortKey(ey)
      slot.sprite.shadow?.place(ex, ey)
    }
    for (const prop of this.props) {
      placeProp(this.proj, prop.mesh, prop.shape, prop.def.x, prop.def.y)
      if (!prop.shadow) continue
      const { tx, ty } = propOrigin(prop.shape, prop.def.x, prop.def.y)
      prop.shadow.place(tx, ty)
    }
  }

  private disposeEntities(): void {
    this.player?.mesh.removeFromParent()
    for (const npc of this.npcs) {
      npc.sprite?.mesh.removeFromParent()
      npc.sprite?.dispose()
    }
    for (const slot of this.events) {
      slot.runner?.cancel()
      slot.sprite?.mesh.removeFromParent()
      slot.sprite?.dispose()
    }
    this.events = []
    this.foreground?.cancel()
    this.foreground = undefined
    this.foregroundSlot = undefined
    for (const prop of this.props) {
      prop.mesh.removeFromParent()
      prop.mesh.geometry.dispose()
      ;(prop.mesh.material as THREE.Material).dispose()
      prop.shadow?.dispose()
    }
    this.npcs = []
    this.props = []
    // The player lives in the same group and must go back in after the clear.
    if (this.player) this.sprites.add(this.player.mesh)
  }

  /**
   * Rebuild layer meshes from the map's tile arrays, which the editor mutates
   * in place. Naming layers rebuilds only those, so a brush stroke does not
   * rebuild the two layers it did not touch.
   *
   * This is O(cells) per layer. Fine at 20x12; it will want chunking well
   * before a map is large enough for that to show.
   */
  rebuildLayers(only: readonly LayerName[] = LAYER_NAMES): void {
    for (const name of only) {
      this.dropLayer(name)
      const mesh = buildTileLayer(this.sheet, this.map, name, this.tileset)
      this.layers.set(name, mesh)
      this.scene.add(mesh)
    }
  }

  private dropLayer(name: LayerName): void {
    const old = this.layers.get(name)
    if (!old) return
    this.scene.remove(old)
    old.geometry.dispose()
    ;(old.material as THREE.Material).dispose()
    this.layers.delete(name)
  }

  /** Drop the meshes and sprites of the map being replaced. */
  private disposeScene(): void {
    for (const name of [...this.layers.keys()]) this.dropLayer(name)
    // Textures belong to Assets and are shared; CharacterSprite.dispose drops
    // only the geometry and material it owns.
    this.disposeEntities()
    this.player?.dispose()
    this.sprites.clear()
    this.shadowGroup.clear()
    this.player = undefined
  }

  /** The map currently in the scene. The editor edits this object in place. */
  get currentMap(): GameMap { return this.map }
  /** The tileset its indices refer to. */
  get currentTileset(): Tileset { return this.tileset }
  /** For the editor's own overlay geometry. */
  get worldScene(): THREE.Scene { return this.scene }
  /** For the editor's camera control; nothing drives it while paused. */
  get projection(): Projection { return this.proj }

  /**
   * Coming back from dialogue or a battle. A suspended foreground event is owed
   * an answer, and for a battle that answer is who won — which is what makes
   * `won:`/`lost:` branches work. Dialogue answers only when it was stopped.
   */
  enter(payload?: unknown): void {
    const p = payload as { battleWon?: boolean; dialogueStopped?: boolean } | undefined
    if (!this.foreground?.isSuspended) return
    // A choice that called the conversation off calls off the event it was
    // part of: resuming would run the battle the player just declined.
    if (p?.dialogueStopped) {
      this.foreground.cancel()
      this.foreground = undefined
      this.foregroundSlot = undefined
      return
    }
    this.foreground.resume({ won: p?.battleWon })
  }

  exit(): void {}

  private blocked(tx: number, ty: number): boolean {
    // Terrain passability is its own grid (doc §6.1); NPCs occupy their tile
    // on top of it (doc §6.2).
    if (blockedAt(this.map, tx, ty)) return true
    if (this.npcs.some((n) => n.tile[0] === tx && n.tile[1] === ty)) return true
    // An event blocks only while a page that says so is the live one, which is
    // how a door opens without the collision grid changing.
    return this.events.some((s) =>
      s.tile[0] === tx && s.tile[1] === ty && this.page(s)?.blocks === true)
  }

  /** Fire a touch page under the player, if there is one. */
  private tryTouchEvent(): void {
    const slot = this.events.find((s) => s.tile[0] === this.tx && s.tile[1] === this.ty)
    if (slot && this.page(slot)?.trigger === 'touch') this.startForeground(slot)
  }

  /** Doc §6.4: interact acts on the tile the player faces. */
  private tryInteract(): boolean {
    const [dx, dy] = DIRS[this.facing]
    const fx = this.tx + dx
    const fy = this.ty + dy
    // Events first: they are the general mechanism, and an NPC is the special
    // case kept working for maps written before events existed.
    if (this.tryTalkEvent(fx, fy)) return true

    const npc = this.npcs.find((n) => n.tile[0] === fx && n.tile[1] === fy)
    if (!npc) return false
    // An NPC whose dialogue file is broken still answers, and says so. Silence
    // is the one response a designer cannot act on: it looks identical to an
    // NPC that was never given dialogue, and to standing on the wrong tile.
    const script = npc.script ?? (npc.def.dialogue ? brokenScript(npc.def) : undefined)
    if (!script) return false

    // Turn the NPC to face the player before speaking.
    const opposite: Record<Facing, Facing> = { up: 'down', down: 'up', left: 'right', right: 'left' }
    npc.facing = opposite[this.facing]
    npc.sprite?.setFrame(npc.facing, 0)

    this.onSwitch?.('dialogue', {
      script,
      // Doc §7.3: a battle-flagged NPC starts its battle when dialogue ends.
      next: npc.battle
        ? { mode: 'battle', payload: { config: npc.battle, returnTo: 'overworld' } }
        : { mode: 'overworld' },
    })
    return true
  }

  private onSwitch?: (mode: string, payload?: unknown) => void
  bindSwitch(fn: (mode: string, payload?: unknown) => void): void { this.onSwitch = fn }

  private pressedDir(): Facing | undefined {
    // Last-pressed wins would need history; for v1 a fixed priority is enough.
    if (this.input.held('up')) return 'up'
    if (this.input.held('down')) return 'down'
    if (this.input.held('left')) return 'left'
    if (this.input.held('right')) return 'right'
    return undefined
  }

  update(dt: number): void {
    if (!this.player || this.traveling) return

    this.stepEventWalks()
    // An event with the floor holds the player still. Movement input is not
    // buffered through it: whatever was held during a conversation is let go of.
    const busy = this.tickEvents()

    if (!busy && this.stepFrames === 0 && this.input.pressed('interact') && this.tryInteract()) return

    if (this.stepFrames > 0) {
      // Mid-step: run out the tween. Input is buffered by being re-read on
      // arrival, so holding a direction chains steps seamlessly.
      this.stepFrames--
      if (this.stepFrames === 0) {
        this.stepsTaken++
        // Doc §10: warps fire on arrival, not on leaving, so the step that
        // steps onto one completes first.
        const warp = warpAt(this.map, this.tx, this.ty)
        if (warp) { void this.travel(warp); return }
        // Doc: a touch page fires on arrival, so the step that lands on it
        // completes first and the player is standing where the event is.
        this.tryTouchEvent()
      }
    } else if (busy) {
      this.turnGrace = 0
    } else {
      const want = this.pressedDir()
      if (!want) {
        this.turnGrace = 0
      } else if (want !== this.facing) {
        // Doc §6.2: a new direction turns in place first. The grace makes a tap
        // turn without stepping, while a hold walks.
        this.facing = want
        this.turnGrace = TURN_GRACE
      } else if (this.turnGrace > 0) {
        this.turnGrace--
      } else {
        const [dx, dy] = DIRS[want]
        const nx = this.tx + dx
        const ny = this.ty + dy
        if (!this.blocked(nx, ny)) {
          this.stepFrom = [this.tx, this.ty]
          this.tx = nx
          this.ty = ny
          this.stepFrames = STEP_FRAMES
        }
      }
    }

    // Interpolated position drives both the sprite and the camera.
    const t = this.stepFrames > 0 ? 1 - this.stepFrames / STEP_FRAMES : 1
    const x = this.stepFrom[0] + (this.tx - this.stepFrom[0]) * t
    const y = this.stepFrom[1] + (this.ty - this.stepFrom[1]) * t

    const moving = this.stepFrames > 0
    // Standing time is wall-clock, and resets the moment a step starts, so the
    // idle always restarts from its first frame rather than resuming mid-cycle.
    this.standingMs = moving ? 0 : this.standingMs + dt * 1000
    if (moving) {
      this.player.setFrame(this.facing, walkFrame(
        this.stepsTaken, t, this.player.def.framesPerStep, this.player.frameCount(this.facing)))
    } else if (this.player.hasPose('idle')) {
      const sheet = this.player.sheetFor(this.facing, 'idle')!
      this.player.setFrame(this.facing, frameAtTime(sheet, this.standingMs), 'idle')
    } else {
      // No idle art: hold one frame of the walk, as every character did before
      // idles existed.
      this.player.setFrame(this.facing, this.player.def.idleFrame)
    }

    this.placeEntities(x, y)
    this.proj.lookAt(x, y)
    this.backdrop.update(x, y, this.proj.pitchDeg)
  }

  render(): void {
    this.gfx.beginFrame(0x0b0d0a)
    // Backdrop first, with depth writes off, so the world composites over it.
    this.backdrop.render(this.gfx.gl)
    this.gfx.gl.render(this.scene, this.proj.camera)
  }

  /** Debug readout for the overlay. */
  get status(): Record<string, string | number> {
    return {
      map: `${this.map?.id ?? '<none>'} ${this.map?.width ?? 0}x${this.map?.height ?? 0}`,
      // DEFAULT here means the sheet has never been classified, so the world is
      // being drawn from the importer's measurements. Worth seeing in-game.
      tileset: this.tileset
        ? `${this.tileset.id} ${this.tileset.cols}x${this.tileset.rows} — ${describeTileset(this.tileset)}`
        : '<none>',
      broken: this.brokenRefs.size,
      tile: `${this.tx},${this.ty}`,
      facing: this.facing,
      steps: this.stepsTaken,
      pitch: `${this.proj.pitchDeg.toFixed(0)}deg`,
      shadows: SHADOW_LABELS[this.shadowStyle],
      fov: `${this.proj.fovDeg.toFixed(1)}deg`,
    }
  }

  setPitch(deg: number): void { this.proj.setPitchDeg(deg) }
  get pitch(): number { return this.proj.pitchDeg }

  // --- Shadows -------------------------------------------------------------

  /** What the sheet says is empty inside a prop's region. */
  private trimOf(shape: PropDef): ArtTrim {
    return this.propTrims.get(shape.id) ?? NO_TRIM
  }

  /** Give a prop the shadow the current style asks for, replacing any it had. */
  private dressPropShadow(slot: PropSlot): void {
    slot.shadow?.dispose()
    slot.shadow = Shadow.forProp(
      this.sheet, this.tileset, slot.shape, this.trimOf(slot.shape), this.shadowStyle,
    )
    if (!slot.shadow) return
    this.shadowGroup.add(slot.shadow.object)
    const { tx, ty } = propOrigin(slot.shape, slot.def.x, slot.def.y)
    slot.shadow.place(tx, ty)
  }

  /**
   * Hang a character in the world, with the shadow the current style asks for.
   *
   * The sprite owns its shadow — it has to, because a cast shadow is the
   * current walk frame's silhouette — so all the world does is put the mesh in
   * the group that draws it under everything else.
   */
  private addSprite(sprite: CharacterSprite): void {
    this.sprites.add(sprite.mesh)
    sprite.setShadowStyle(this.shadowStyle)
    if (sprite.shadow) this.shadowGroup.add(sprite.shadow.object)
  }

  /** Every character in the world, whether or not it has art. */
  private *castingSprites(): Generator<CharacterSprite> {
    if (this.player) yield this.player
    for (const npc of this.npcs) if (npc.sprite) yield npc.sprite
    for (const slot of this.events) if (slot.sprite) yield slot.sprite
  }

  get shadows(): ShadowStyle { return this.shadowStyle }

  /**
   * Swap every shadow in the world for another style. Shadows are cheap to
   * rebuild — one quad each — so this throws them all away rather than trying
   * to mutate material uniforms that differ in kind between styles.
   */
  setShadowStyle(style: ShadowStyle): void {
    if (style === this.shadowStyle) return
    this.shadowStyle = style
    for (const slot of this.props) this.dressPropShadow(slot)
    for (const sprite of this.castingSprites()) {
      sprite.setShadowStyle(style)
      if (sprite.shadow) this.shadowGroup.add(sprite.shadow.object)
    }
    this.placeEntities()
  }

}

/**
 * What a broken NPC says. Shown in the ordinary dialogue box, in the same
 * spirit as the labelled art placeholders: the gap is visible where the
 * designer is already looking, rather than in a console they may not have open.
 */
export function brokenScript(npc: { id: string; dialogue?: string }): DialogueScript {
  return {
    id: `broken:${npc.id}`,
    lines: [{ name: npc.id, text: `Broken dialogue reference: ${npc.dialogue}` }],
  }
}
