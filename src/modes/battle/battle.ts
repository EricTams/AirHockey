import * as THREE from 'three'
import type { Mode } from '../../core/mode'
import type { Renderer } from '../../core/renderer'
import type { Input } from '../../core/input'
import type { Assets } from '../../core/assets'
import { ScreenLayer } from '../../ui/screen'
import { getFont } from '../../ui/bitmapFont'
import { makeTextMesh, textWidth } from '../../ui/text'
import { screenRect } from '../../core/screenScene'
import { VIRTUAL_W, VIRTUAL_H, TICK_HZ } from '../../core/config'
import { BattleSim, opponentTarget, type BattleConfig } from './physics'
import { makePlaceholderTexture } from '../../world/placeholder'
import { findMissing } from '../../world/missingArt'
import { loadAseprite } from '../../world/aseprite'

type Phase = 'countdown' | 'play' | 'scored' | 'over'

const COUNTDOWN_TICKS = 30   // doc §8.3
const SCORED_TICKS = 45
/** Doc §8.3 stuck-puck rule: below this speed for this long forces a faceoff. */
const STUCK_SPEED = 0.2
const STUCK_TICKS = 3 * TICK_HZ

export interface BattlePayload { config: BattleConfig; returnTo: string }

export class BattleMode implements Mode {
  readonly name = 'battle'
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(50, VIRTUAL_W / VIRTUAL_H, 0.1, 100)
  private screen = new ScreenLayer()

  private sim!: BattleSim
  private phase: Phase = 'countdown'
  private timer = 0
  private stuck = 0
  private score: [number, number] = [0, 0]
  private returnTo = 'overworld'
  private won = false

  private puckMesh?: THREE.Mesh
  private playerMesh?: THREE.Mesh
  private opponentMesh?: THREE.Mesh
  private wingMesh?: THREE.Mesh
  private pipeMeshes = new Map<string, THREE.Mesh>()
  /** Everything built for the current layout, freed when the battle is left. */
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []

  constructor(private gfx: Renderer, private input: Input, private assets: Assets) {}

  private onSwitch?: (mode: string, payload?: unknown) => void
  bindSwitch(fn: (mode: string, payload?: unknown) => void): void { this.onSwitch = fn }

  enter(payload?: unknown): void {
    const p = payload as BattlePayload | undefined
    if (!p) throw new Error('battle requires a config payload')
    this.returnTo = p.returnTo
    this.sim = new BattleSim(p.config)
    this.score = [0, 0]
    this.phase = 'countdown'
    this.timer = COUNTDOWN_TICKS
    this.stuck = 0
    void this.build(p)
  }

  exit(): void {
    this.screen.clear()
    // Each opponent has its own layout, so the scene cannot be reused between
    // battles. Tear it down rather than accumulating one arena per fight.
    this.scene.clear()
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.pipeMeshes.clear()
    this.wingMesh = undefined
  }

  /** Track anything that needs freeing when the layout is torn down. */
  private own<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T {
    this.disposables.push(x)
    return x
  }

  private async build(p: BattlePayload): Promise<void> {
    const { width, length, goalWidth } = p.config.table

    const surface = new THREE.Mesh(
      this.own(new THREE.PlaneGeometry(width, length)),
      this.own(new THREE.MeshLambertMaterial({ color: 0x2b4a63 })),
    )
    surface.rotation.x = -Math.PI / 2
    this.scene.add(surface)

    // Centre line and the two goal mouths, so the table reads at a glance.
    const paint = (w: number, l: number, x: number, z: number, color: number) => {
      const m = new THREE.Mesh(
        this.own(new THREE.PlaneGeometry(w, l)), this.own(new THREE.MeshBasicMaterial({ color })))
      m.rotation.x = -Math.PI / 2
      m.position.set(x, 0.01, z)
      this.scene.add(m)
    }
    paint(width, 0.06, 0, 0, 0x5f86a8)
    paint(goalWidth, 0.3, 0, -length / 2 + 0.15, 0x7fd0a0)
    paint(goalWidth, 0.3, 0, length / 2 - 0.15, 0xd07f8a)

    // Side walls full length; end walls split around the goal mouth.
    const wall = (w: number, l: number, x: number, z: number) => {
      const m = new THREE.Mesh(
        this.own(new THREE.BoxGeometry(w, 0.3, l)),
        this.own(new THREE.MeshLambertMaterial({ color: 0x16283a })),
      )
      m.position.set(x, 0.15, z)
      this.scene.add(m)
    }
    const t = 0.16
    wall(t, length + t * 2, -width / 2 - t / 2, 0)
    wall(t, length + t * 2, width / 2 + t / 2, 0)
    const side = (width - goalWidth) / 2
    for (const z of [-length / 2 - t / 2, length / 2 + t / 2]) {
      wall(side, t, -(goalWidth / 2 + side / 2), z)
      wall(side, t, goalWidth / 2 + side / 2, z)
    }

    const disc = (r: number, h: number, color: number) => {
      const m = new THREE.Mesh(
        this.own(new THREE.CylinderGeometry(r, r, h, 24)),
        this.own(new THREE.MeshLambertMaterial({ color })),
      )
      m.position.y = h / 2
      this.scene.add(m)
      return m
    }
    this.puckMesh = disc(p.config.puck.radius, 0.07, 0x1b1b1f)
    this.playerMesh = disc(p.config.paddle.radius, 0.13, 0x7fd0a0)
    this.opponentMesh = disc(p.config.paddle.radius, 0.13, 0xd07f8a)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(2, 6, 3)
    this.scene.add(key)

    // Doc §4.3: fixed camera behind and above the player's end, ~35 degrees.
    const elev = 35 * (Math.PI / 180)
    const dist = length * 0.92
    this.camera.position.set(0, Math.sin(elev) * dist, -length / 2 - Math.cos(elev) * dist * 0.55)
    this.camera.lookAt(0, 0, length * 0.06)

    this.buildObstacles()

    const sheetPath = p.config.opponent.sheet
    if (sheetPath) {
      const sheet = await loadAseprite(sheetPath, this.assets)
      const f = sheet.frames[0]!
      const geo = this.own(new THREE.PlaneGeometry(1.5, 1.5))
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      const a = uv.array as Float32Array
      a[0] = f.u0; a[1] = f.v1; a[2] = f.u1; a[3] = f.v1
      a[4] = f.u0; a[5] = f.v0; a[6] = f.u1; a[7] = f.v0
      uv.needsUpdate = true
      const sprite = new THREE.Mesh(
        geo,
        this.own(new THREE.MeshBasicMaterial({ map: sheet.texture, transparent: true, alphaTest: 0.5 })),
      )
      sprite.position.set(0, 0.75, length / 2 + 1.0)
      // Doc §4.3: the opponent billboards about Y to face the camera. The
      // camera sits at -Z and a plane's normal is +Z, so without this it is
      // backface-culled and silently invisible.
      sprite.rotation.y = Math.PI
      this.scene.add(sprite)
    }
  }

  /** Blocks, pipes and the wing, drawn from the layout's obstacle list. */
  private buildObstacles(): void {
    for (const b of this.sim.blocks) {
      const m = new THREE.Mesh(
        this.own(new THREE.BoxGeometry(b.halfW * 2, 0.22, b.halfH * 2)),
        this.own(new THREE.MeshLambertMaterial({ color: 0x3d6d8c })),
      )
      m.position.set(b.x, 0.11, b.y)
      this.scene.add(m)
    }

    // Paired pipes share a hue so the route between them reads at a glance.
    const PIPE_COLORS = [0xd9a441, 0x8fbf5f, 0xc06fd0]
    this.sim.pipes.forEach((pipe, i) => {
      const color = PIPE_COLORS[Math.floor(i / 2) % PIPE_COLORS.length]!
      const ring = new THREE.Mesh(
        this.own(new THREE.TorusGeometry(pipe.radius, 0.09, 10, 24)),
        this.own(new THREE.MeshLambertMaterial({ color })),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(pipe.x, 0.09, pipe.y)
      this.scene.add(ring)

      const mouth = new THREE.Mesh(
        this.own(new THREE.CircleGeometry(pipe.radius, 24)),
        this.own(new THREE.MeshBasicMaterial({ color: 0x0b1119 })),
      )
      mouth.rotation.x = -Math.PI / 2
      mouth.position.set(pipe.x, 0.02, pipe.y)
      this.scene.add(mouth)
      this.pipeMeshes.set(pipe.id, ring)
    })

    const wing = this.sim.wing
    if (wing) {
      // No prop art exists, so this is a labelled placeholder standing upright
      // in the goal mouth — visibly a stand-in rather than silently absent.
      const known = findMissing('assets/props/chicken-wing.png')
      const tex = this.own(makePlaceholderTexture({
        width: known?.width ?? 64, height: known?.height ?? 64,
        label: known?.label ?? 'WING', kind: 'generic',
      }))
      const m = new THREE.Mesh(
        this.own(new THREE.PlaneGeometry(wing.radius * 2.2, wing.radius * 2.2)),
        this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })),
      )
      m.position.set(wing.x, wing.radius * 1.1, wing.y)
      m.rotation.y = Math.PI
      this.scene.add(m)
      this.wingMesh = m
    }
  }

  /** Player paddle target: nudge from its current spot by held direction. */
  private playerTarget(): { x: number; y: number } {
    const speed = this.sim.cfg.paddle.maxSpeed / TICK_HZ
    let dx = 0
    let dy = 0
    if (this.input.held('left')) dx -= 1
    if (this.input.held('right')) dx += 1
    if (this.input.held('up')) dy += 1
    if (this.input.held('down')) dy -= 1
    const len = Math.hypot(dx, dy) || 1
    return {
      x: this.sim.player.x + (dx / len) * speed * 3,
      y: this.sim.player.y + (dy / len) * speed * 3,
    }
  }

  update(dt: number): void {
    if (!this.sim) return

    if (this.phase === 'countdown') {
      if (--this.timer <= 0) this.phase = 'play'
    } else if (this.phase === 'play') {
      const result = this.sim.step(dt, this.playerTarget(), opponentTarget(this.sim))
      if (result === 'dislodged') {
        // Knocking the wing loose is the whole win condition in this mode.
        if (this.wingMesh) this.wingMesh.visible = false
        this.won = true
        this.phase = 'over'
        this.stuck = 0
      } else if (result !== 'none') {
        if (result === 'playerScored') this.score[0]++
        else this.score[1]++
        const target = this.sim.cfg.rules.targetScore
        this.won = this.score[0] >= target
        this.phase = this.score[0] >= target || this.score[1] >= target ? 'over' : 'scored'
        this.timer = SCORED_TICKS
        this.stuck = 0
      } else {
        this.stuck = this.sim.speed < STUCK_SPEED ? this.stuck + 1 : 0
        if (this.stuck >= STUCK_TICKS) { this.sim.faceoff(0); this.stuck = 0 }
      }
    } else if (this.phase === 'scored') {
      if (--this.timer <= 0) {
        // Nudge the faceoff toward whoever just conceded.
        this.sim.faceoff(this.score[0] > this.score[1] ? 0.5 : -0.5)
        this.phase = 'countdown'
        this.timer = COUNTDOWN_TICKS
      }
    } else if (this.phase === 'over') {
      if (this.input.pressed('interact')) {
        this.onSwitch?.(this.returnTo)
        return
      }
    }

    if (this.puckMesh) this.puckMesh.position.set(this.sim.puck.x, this.puckMesh.position.y, this.sim.puck.y)
    if (this.playerMesh) this.playerMesh.position.set(this.sim.player.x, this.playerMesh.position.y, this.sim.player.y)
    if (this.opponentMesh) this.opponentMesh.position.set(this.sim.opponent.x, this.opponentMesh.position.y, this.sim.opponent.y)
    this.buildUi()
  }

  private buildUi(): void {
    const font = getFont()
    const objects: THREE.Object3D[] = []
    const dislodge = this.sim.cfg.rules.mode === 'dislodge'
    // In dislodge mode there is no score to show, so the readout is the hits
    // left on the wing instead.
    const readout = dislodge
      ? `WING x${this.sim.wingHits}`
      : `P ${this.score[0]} - ${this.score[1]} O`
    objects.push(screenRect(VIRTUAL_W / 2 - 90, 10, 180, 30, 0x0d1420))
    objects.push(makeTextMesh(font, readout, VIRTUAL_W / 2 - textWidth(font, readout) / 2, 16, 0xffffff))

    const who = this.sim.cfg.opponent.name.toUpperCase()
    objects.push(makeTextMesh(font, who, 16, 16, 0x8ea0bd))

    const banner = (text: string, color: number) => {
      const w = textWidth(font, text, 2)
      objects.push(screenRect(0, VIRTUAL_H / 2 - 34, VIRTUAL_W, 68, 0x0d1420))
      objects.push(makeTextMesh(font, text, VIRTUAL_W / 2 - w / 2, VIRTUAL_H / 2 - 18, color, 2))
    }
    if (this.phase === 'countdown') {
      banner(String(Math.ceil(this.timer / (COUNTDOWN_TICKS / 3))), 0xffd76b)
    } else if (this.phase === 'scored') {
      banner('GOAL', 0xffd76b)
    } else if (this.phase === 'over') {
      const text = this.won ? (dislodge ? 'DISLODGED' : 'WIN') : 'LOSE'
      banner(text, this.won ? 0x7fd0a0 : 0xd07f8a)
      const hint = 'PRESS Z'
      objects.push(makeTextMesh(font, hint, VIRTUAL_W / 2 - textWidth(font, hint) / 2, VIRTUAL_H / 2 + 26, 0x8ea0bd))
    }
    this.screen.set(objects)
  }

  render(): void {
    this.gfx.beginFrame(0x070b12)
    this.gfx.gl.render(this.scene, this.camera)
    this.screen.render(this.gfx.gl)
  }
}
