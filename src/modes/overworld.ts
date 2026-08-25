import * as THREE from 'three'
import type { Mode } from '../core/mode'
import type { Renderer } from '../core/renderer'
import type { Input } from '../core/input'
import type { Assets } from '../core/assets'
import { Projection } from '../world/projection'
import { CharacterSprite, walkFrame, type CharacterDef, type Facing } from '../world/character'
import { buildGroundMesh } from '../world/groundMesh'
import { TILE } from '../core/config'

/** Doc §6.2: a step tweens over 12 frames at 60Hz. */
const STEP_FRAMES = 12
/** Frames a direction must be held facing before the step commits. */
const TURN_GRACE = 4

const MAP_COLS = 24
const MAP_ROWS = 18
/** Pure-grass fill cell in the tileset (cols 4-6 × rows 1-3 are all identical). */
const GRASS_CELL = { col: 4, row: 1 }
/** Solid dirt from the cliff face, used only to make the tile grid legible. */
const DIRT_CELL = { col: 5, row: 6 }

const DIRS: Record<Facing, [number, number]> = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
}

export class OverworldMode implements Mode {
  readonly name = 'overworld'
  private scene = new THREE.Scene()
  private proj = new Projection()
  private sprites = new THREE.Group()
  private player?: CharacterSprite

  // Player state
  private tx = 12
  private ty = 9
  private facing: Facing = 'down'
  private stepFrom: [number, number] = [12, 9]
  private stepFrames = 0
  private stepsTaken = 0
  private turnGrace = 0

  constructor(private gfx: Renderer, private input: Input, private assets: Assets) {
    this.sprites.renderOrder = 10
    this.scene.add(this.sprites)
  }

  async init(): Promise<void> {
    const sheet = await this.assets.texture('/assets/terrain/tileset-tiles.png', {
      label: 'TILESET', kind: 'tile', width: 512, height: 464,
    })
    const img = sheet.image as { width?: number; height?: number } | undefined
    // M1 scaffolding: a checker of two real cells so the tile grid is visible.
    // Without a depth cue on the ground, a pitch change is invisible — every
    // billboard is the same on-screen size at any pitch. M3 replaces this with
    // the real tile layers.
    this.scene.add(buildGroundMesh(
      sheet, MAP_COLS, MAP_ROWS,
      (tx, ty) => ((tx + ty) % 2 === 0 ? GRASS_CELL : DIRT_CELL),
      TILE, img?.width ?? 512, img?.height ?? 464))

    const def = (await (await fetch('/data/characters/character-1.json')).json()) as CharacterDef
    this.player = await CharacterSprite.load(def, this.assets)
    this.sprites.add(this.player.mesh)
  }

  enter(): void {}
  exit(): void {}

  private blocked(tx: number, ty: number): boolean {
    return tx < 0 || ty < 0 || tx >= MAP_COLS || ty >= MAP_ROWS
  }

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
    this.proj.lookAt(x, y)
  }

  render(): void {
    this.gfx.beginFrame(0x0b0d0a)
    this.gfx.gl.render(this.scene, this.proj.camera)
  }

  /** Debug readout for the overlay. */
  get status(): Record<string, string | number> {
    return {
      tile: `${this.tx},${this.ty}`,
      facing: this.facing,
      steps: this.stepsTaken,
      pitch: `${this.proj.pitchDeg.toFixed(0)}deg`,
    }
  }

  setPitch(deg: number): void { this.proj.setPitchDeg(deg) }
  get pitch(): number { return this.proj.pitchDeg }
}
