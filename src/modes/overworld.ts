import * as THREE from 'three'
import type { Mode } from '../core/mode'
import type { Renderer } from '../core/renderer'
import type { Input } from '../core/input'
import type { Assets } from '../core/assets'
import { Projection } from '../world/projection'
import { CharacterSprite, walkFrame, type CharacterDef, type Facing } from '../world/character'
import { buildTileLayer } from '../world/tileLayer'
import { LAYER_NAMES, loadMap, blockedAt, type GameMap, type LayerName, type MapNpc } from '../world/map'
import type { Tileset } from '../world/tileset'
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
const PLAYER_CHARACTER = 'data/characters/character-1.json'

const DIRS: Record<Facing, [number, number]> = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
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
  private player?: CharacterSprite

  private map!: GameMap
  private mapPath = ENTRY_MAP
  private tileset!: Tileset
  private sheet!: THREE.Texture
  private layers = new Map<LayerName, THREE.Mesh>()
  private npcs: NpcSlot[] = []

  private tx = 0
  private ty = 0
  private facing: Facing = 'down'
  private stepFrom: [number, number] = [0, 0]
  private stepFrames = 0
  private stepsTaken = 0
  private turnGrace = 0

  constructor(private gfx: Renderer, private input: Input, private assets: Assets) {
    this.sprites.renderOrder = 10
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
   * Build the scene for a map, replacing whatever was there.
   *
   * The player keeps its tile across a rebuild of the same map, so an edit does
   * not walk them back to the start every stroke; a different map, or a tile
   * that the edit put out of bounds, falls back to `playerStart`.
   */
  async applyMap(map: GameMap, tileset: Tileset): Promise<void> {
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
    // One merged mesh per layer. Indices come from the file, so the grid is
    // unaffected if the sheet fell back to a placeholder.
    this.rebuildLayers()

    const inMap = sameMap && keepX < map.width && keepY < map.height
    this.tx = inMap ? keepX : map.playerStart.x
    this.ty = inMap ? keepY : map.playerStart.y
    this.facing = inMap ? keepFacing : map.playerStart.facing
    this.stepFrom = [this.tx, this.ty]
    this.stepFrames = 0
    this.turnGrace = 0

    const def = await fetchJson<CharacterDef>(PLAYER_CHARACTER)
    this.player = await CharacterSprite.load(def, this.assets)
    this.sprites.add(this.player.mesh)

    this.npcs = map.npcs.map((n) => ({ def: n, tile: [n.x, n.y], facing: n.facing }))
    await Promise.all(this.npcs.map(async (slot) => {
      const npcDef = await fetchJson<CharacterDef>(slot.def.character)
      slot.sprite = await CharacterSprite.load(npcDef, this.assets)
      if (slot.def.tint !== undefined) slot.sprite.setTint(slot.def.tint)
      slot.sprite.setFrame(slot.facing, 0)
      this.sprites.add(slot.sprite.mesh)
      if (slot.def.dialogue) {
        slot.script = parseDialogue(await fetchJson(slot.def.dialogue), slot.def.dialogue)
      }
      if (slot.def.battle) slot.battle = await fetchJson<BattleConfig>(slot.def.battle)
    }))

    // Nothing calls lookAt() while the loop is paused, so leave the camera on
    // the player rather than wherever the previous map left it.
    this.proj.lookAt(this.tx, this.ty)
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
    this.player?.dispose()
    for (const npc of this.npcs) npc.sprite?.dispose()
    this.sprites.clear()
    this.player = undefined
    this.npcs = []
  }

  /** The map currently in the scene. The editor edits this object in place. */
  get currentMap(): GameMap { return this.map }
  /** The tileset its indices refer to. */
  get currentTileset(): Tileset { return this.tileset }
  /** For the editor's own overlay geometry. */
  get worldScene(): THREE.Scene { return this.scene }
  /** For the editor's camera control; nothing drives it while paused. */
  get projection(): Projection { return this.proj }

  enter(): void {}
  exit(): void {}

  private blocked(tx: number, ty: number): boolean {
    // Terrain passability is its own grid (doc §6.1); NPCs occupy their tile
    // on top of it (doc §6.2).
    if (blockedAt(this.map, tx, ty)) return true
    return this.npcs.some((n) => n.tile[0] === tx && n.tile[1] === ty)
  }

  /** Doc §6.4: interact acts on the tile the player faces. */
  private tryInteract(): boolean {
    const [dx, dy] = DIRS[this.facing]
    const fx = this.tx + dx
    const fy = this.ty + dy
    const npc = this.npcs.find((n) => n.tile[0] === fx && n.tile[1] === fy)
    if (!npc?.script) return false

    // Turn the NPC to face the player before speaking.
    const opposite: Record<Facing, Facing> = { up: 'down', down: 'up', left: 'right', right: 'left' }
    npc.facing = opposite[this.facing]
    npc.sprite?.setFrame(npc.facing, 0)

    this.onSwitch?.('dialogue', {
      script: npc.script,
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

  update(_dt: number): void {
    if (!this.player) return

    if (this.stepFrames === 0 && this.input.pressed('interact') && this.tryInteract()) return

    if (this.stepFrames > 0) {
      // Mid-step: run out the tween. Input is buffered by being re-read on
      // arrival, so holding a direction chains steps seamlessly.
      this.stepFrames--
      if (this.stepFrames === 0) this.stepsTaken++
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
    const frame = moving
      ? walkFrame(this.stepsTaken, t, this.player.def.framesPerStep, this.player.frameCount(this.facing))
      : this.player.def.idleFrame
    this.player.setFrame(this.facing, frame)

    this.proj.placeBillboard(this.player.mesh, x, y)
    this.player.mesh.renderOrder = this.proj.sortKey(y)
    for (const npc of this.npcs) {
      if (!npc.sprite) continue
      this.proj.placeBillboard(npc.sprite.mesh, npc.tile[0], npc.tile[1])
      npc.sprite.mesh.renderOrder = this.proj.sortKey(npc.tile[1])
    }
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
      tile: `${this.tx},${this.ty}`,
      facing: this.facing,
      steps: this.stepsTaken,
      pitch: `${this.proj.pitchDeg.toFixed(0)}deg`,
      fov: `${this.proj.fovDeg.toFixed(1)}deg`,
    }
  }

  setPitch(deg: number): void { this.proj.setPitchDeg(deg) }
  get pitch(): number { return this.proj.pitchDeg }
}
