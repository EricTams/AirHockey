import * as THREE from 'three'
import type { Mode } from '../../core/mode'
import type { Renderer } from '../../core/renderer'
import type { Input } from '../../core/input'
import type { Assets } from '../../core/assets'
import { ScreenLayer } from '../../ui/screen'
import { getFont } from '../../ui/bitmapFont'
import { makeTextMesh, textWidth } from '../../ui/text'
import { screenLine, screenPoly } from '../../core/screenScene'
import { VIRTUAL_W, VIRTUAL_H, TICK_HZ } from '../../core/config'
import { BattleSim, type BattleConfig } from './physics'
import { OpponentAI } from './ai'
import { makePlaceholderTexture } from '../../world/placeholder'
import { findMissing } from '../../world/missingArt'
import { loadAseprite } from '../../world/aseprite'

type Phase = 'ready' | 'countdown' | 'play' | 'scored' | 'over'

const COUNTDOWN_TICKS = 30   // doc §8.3
/**
 * Ticks a ready prompt ignores input. Without it a press carried in from the
 * dialogue, or a click during the goal pause, starts play instantly and the
 * prompt is never seen.
 */
const READY_LOCK_TICKS = 20
const SCORED_TICKS = 45
/**
 * Camera elevation. Steeper than doc §4.3's 35 degrees: the table is framed to
 * fill the frame height, and a steeper angle foreshortens it less, so it ends
 * up narrower on screen and leaves wider side margins for the UI.
 */
const ELEVATION_DEG = 58
/** Fraction of the frame height the table is fitted to. */
const TABLE_FILL = 0.96
/** Gap between the table's projected edge and a side panel. */
const PANEL_GAP = 14
/** Wall thickness; also the margin the camera fit must leave around the table. */
const WALL_T = 0.16

/**
 * Sim x to scene x. The camera sits behind the player's end at -z looking up
 * the table, which puts world +x on the *left* of the screen. Negating here
 * makes positive sim x read as screen right, so paddle controls and obstacle
 * coordinates in the layout JSON both match what the player sees.
 */
const sceneX = (simX: number): number => -simX

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
  private ai = new OpponentAI()
  /**
   * Harness switches, set from the dev console rather than bound to keys —
   * they were crowding out the real controls. See `__game.battle`.
   */
  autoPlay = false
  heatLock = false
  private phase: Phase = 'countdown'
  private timer = 0
  private stuck = 0
  private score: [number, number] = [0, 0]
  private returnTo = 'overworld'
  private won = false
  /** False until the first faceoff has been served, so the prompt can differ. */
  private started = false

  private puckMesh?: THREE.Mesh
  private playerMesh?: THREE.Mesh
  private opponentMesh?: THREE.Mesh
  private wingMesh?: THREE.Mesh
  private pipeMeshes = new Map<string, THREE.Mesh>()
  /**
   * The table's projected silhouette edges in virtual pixels, as x at the top
   * and bottom of the frame. The table is a trapezoid under perspective, so
   * these differ and the usable margin is a trapezoid too.
   */
  private edge = { leftTop: 320, leftBottom: 320, rightTop: 640, rightBottom: 640 }
  /** Everything built for the current layout, freed when the battle is left. */
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []
  private raycaster = new THREE.Raycaster()
  /** Table surface in sim space, for turning a pointer ray into a paddle target. */
  private tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

  constructor(private gfx: Renderer, private input: Input, private assets: Assets) {}

  private onSwitch?: (mode: string, payload?: unknown) => void
  bindSwitch(fn: (mode: string, payload?: unknown) => void): void { this.onSwitch = fn }

  enter(payload?: unknown): void {
    const p = payload as BattlePayload | undefined
    if (!p) throw new Error('battle requires a config payload')
    this.returnTo = p.returnTo
    this.sim = new BattleSim(p.config)
    this.ai.reset()
    this.score = [0, 0]
    // The match waits on the player: they grab their paddle to begin.
    this.phase = 'ready'
    this.timer = READY_LOCK_TICKS
    this.stuck = 0
    this.started = false
    // Debug flags must not leak between battles, or a harness run inherits
    // whatever the last one left switched on.
    this.autoPlay = false
    this.heatLock = false
    void this.build(p)
  }

  exit(): void {
    this.screen.clear()
    this.screen.unpinAll()
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
    const t = WALL_T
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

    this.fitCamera(width, length)

    this.buildObstacles()

    const sheetPath = p.config.opponent.sheet
    if (sheetPath) {
      // The opponent used to stand behind the far goal in 3D, which capped how
      // tall the table could be framed. It is now a portrait in the side panel.
      const sheet = await loadAseprite(sheetPath, this.assets)
      const f = sheet.frames[0]!
      const size = 144
      const geo = new THREE.PlaneGeometry(size, size)
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      const a = uv.array as Float32Array
      a[0] = f.u0; a[1] = f.v1; a[2] = f.u1; a[3] = f.v1
      a[4] = f.u0; a[5] = f.v0; a[6] = f.u1; a[7] = f.v0
      uv.needsUpdate = true
      const portrait = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: sheet.texture, transparent: true, alphaTest: 0.5,
        color: p.config.opponent.tint ?? 0xffffff,
        depthTest: false, depthWrite: false,
      }))
      const usable = this.edge.leftTop - PANEL_GAP - 8
      const px = Math.max(8, 8 + (usable - size) / 2)
      portrait.position.set(px + size / 2, VIRTUAL_H - (52 + size / 2), 0)
      portrait.frustumCulled = false
      this.screen.pin(portrait)
    }
  }

  /**
   * Frame the table to fill the frame height, then record where its projected
   * edges land so the UI can sit entirely outside them.
   *
   * Solved numerically rather than by hand: project the table's corners and
   * binary-search the camera distance. That stays correct when a layout changes
   * the table's dimensions, which the plumber's wider table already does.
   */
  private fitCamera(width: number, length: number): void {
    const e = ELEVATION_DEG * (Math.PI / 180)
    // Fit the walls, not the playing surface: they sit a wall-thickness beyond
    // it on every side and 0.3 above it, and fitting the surface alone clipped
    // them off the bottom of the frame.
    const hx = width / 2 + WALL_T
    const hz = length / 2 + WALL_T
    const corners: THREE.Vector3[] = []
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const y of [0, 0.3]) corners.push(new THREE.Vector3(sx * hx, y, sz * hz))
      }
    }

    const measure = (dist: number, targetZ: number) => {
      this.camera.position.set(0, Math.sin(e) * dist, targetZ - Math.cos(e) * dist)
      this.camera.lookAt(0, 0, targetZ)
      this.camera.near = Math.max(0.1, dist * 0.05)
      this.camera.far = dist * 4
      this.camera.updateProjectionMatrix()
      this.camera.updateMatrixWorld()
      let minY = Infinity, maxY = -Infinity
      for (const c of corners) {
        const v = c.clone().project(this.camera)
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
      }
      return { height: maxY - minY, midY: (minY + maxY) / 2 }
    }

    // Two interleaved solves. Distance sets how much of the frame height the
    // table fills; the look-at point centres it. They interact — under
    // perspective the near half projects larger than the far half, so a camera
    // aimed at the table's world centre produces an off-centre projection that
    // clips at the bottom — so alternate until both settle.
    let dist = 20
    let targetZ = 0
    for (let round = 0; round < 5; round++) {
      let lo = 1
      let hi = 200
      for (let i = 0; i < 34; i++) {
        const mid = (lo + hi) / 2
        // NDC spans 2, so a full-height fit is height === 2.
        if (measure(mid, targetZ).height > TABLE_FILL * 2) lo = mid
        else hi = mid
      }
      dist = hi

      // midY falls as the look-at point moves up-table, so bisect on its sign.
      let zlo = -length
      let zhi = length
      for (let i = 0; i < 34; i++) {
        const mid = (zlo + zhi) / 2
        if (measure(dist, mid).midY > 0) zlo = mid
        else zhi = mid
      }
      targetZ = (zlo + zhi) / 2
    }

    measure(dist, targetZ)

    // Take the actual silhouette rather than a bounding box: the side edges are
    // straight lines in 3D and perspective preserves straight lines, so each is
    // still a straight line on screen. Extrapolate each to the frame's top and
    // bottom to get the boundary the UI must stay clear of.
    const toScreen = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(this.camera)
      return { x: ((v.x + 1) / 2) * VIRTUAL_W, y: ((1 - v.y) / 2) * VIRTUAL_H }
    }
    const edgeAt = (sx: number) => {
      const far = toScreen(sx * hx, 0.3, hz)
      const near = toScreen(sx * hx, 0, -hz)
      const dy = near.y - far.y
      const at = (y: number) =>
        Math.abs(dy) < 1e-6 ? far.x : far.x + ((near.x - far.x) * (y - far.y)) / dy
      return { top: at(0), bottom: at(VIRTUAL_H) }
    }
    // Assign by measured position, not by the sign of world x: which side of
    // the screen a world x lands on depends on where the camera sits.
    const a = edgeAt(-1)
    const b = edgeAt(1)
    const [l, r] = a.top <= b.top ? [a, b] : [b, a]
    this.edge = { leftTop: l.top, leftBottom: l.bottom, rightTop: r.top, rightBottom: r.bottom }
  }

  /** Blocks, pipes and the wing, drawn from the layout's obstacle list. */
  private buildObstacles(): void {
    for (const b of this.sim.blocks) {
      const m = new THREE.Mesh(
        this.own(new THREE.BoxGeometry(b.halfW * 2, 0.22, b.halfH * 2)),
        this.own(new THREE.MeshLambertMaterial({ color: 0x3d6d8c })),
      )
      m.position.set(sceneX(b.x), 0.11, b.y)
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
      ring.position.set(sceneX(pipe.x), 0.09, pipe.y)
      this.scene.add(ring)

      const mouth = new THREE.Mesh(
        this.own(new THREE.CircleGeometry(pipe.radius, 24)),
        this.own(new THREE.MeshBasicMaterial({ color: 0x0b1119 })),
      )
      mouth.rotation.x = -Math.PI / 2
      mouth.position.set(sceneX(pipe.x), 0.02, pipe.y)
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
      m.position.set(sceneX(wing.x), wing.radius * 1.1, wing.y)
      m.rotation.y = Math.PI
      this.scene.add(m)
      this.wingMesh = m
    }
  }


  /**
   * Where the pointer is on the table, in sim coordinates, or undefined if it
   * is off the image. Casts the pointer ray at the table plane rather than
   * intersecting meshes, so the target is continuous even off the table edge
   * and the paddle keeps tracking rather than sticking.
   */
  private pointerOnTable(): { x: number; y: number } | undefined {
    const p = this.input.pointer
    if (!p) return undefined
    const ndc = this.gfx.clientToNdc(p.x, p.y)
    if (!ndc) return undefined
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(this.tablePlane, hit)) return undefined
    // Scene x is negated relative to sim x, so undo that coming back.
    return { x: sceneX(hit.x), y: hit.z }
  }

  /**
   * Throw the puck into a corner of the AI's half at low speed — the state a
   * grind starts from — alternating corners on repeat calls, and seat the
   * opponent alongside so it begins at once. Console-callable for testing.
   */
  trapPuck(): void {
    if (!this.sim) return
    const { width, length } = this.sim.cfg.table
    const r = this.sim.cfg.puck.radius
    const side = this.sim.puck.x >= 0 ? -1 : 1

    Object.assign(this.sim.puck, {
      x: side * (width / 2 - r - 0.01),
      y: length / 2 - r - 0.04,
      vx: side * 0.25,
      vy: 0.15,
    })
    Object.assign(this.sim.opponent, {
      x: side * (width / 2 - this.sim.cfg.paddle.radius),
      y: length / 2 - this.sim.cfg.paddle.radius,
      vx: 0,
      vy: 0,
    })
    if (this.phase === 'ready') {
      this.phase = 'play'
      this.timer = 0
    }
  }

  /** Player paddle target, from the pointer when it is in use, else the keys. */
  private playerTarget(): { x: number; y: number } {
    if (this.autoPlay) {
      // Track the puck's x at a fixed depth: enough to keep the rally alive.
      return { x: this.sim.puck.x, y: -this.sim.cfg.table.length * 0.37 }
    }
    if (this.input.source === 'pointer') {
      const at = this.pointerOnTable()
      if (at) return at
    }
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

  /** True when the pointer is grabbing the player's paddle. */
  private pointerOnPaddle(): boolean {
    const at = this.pointerOnTable()
    if (!at) return false
    const grab = this.sim.cfg.paddle.radius * 1.6   // forgiving, it is a small target
    return Math.hypot(at.x - this.sim.player.x, at.y - this.sim.player.y) <= grab
  }

  update(dt: number): void {
    if (!this.sim) return

    if (this.phase === 'ready') {
      // The bot harness serves itself, so a long observation run is not halted
      // by the click gate after every goal.
      if (this.autoPlay) {
        this.phase = 'countdown'
        this.timer = COUNTDOWN_TICKS
        this.started = true
        return
      }
      if (this.timer > 0) this.timer--
      // Play only ever begins by grabbing your own paddle with the pointer.
      // There is deliberately no key for this: the match must not start until
      // the player has actually taken hold of it.
      else if (this.input.pointerPressed && this.pointerOnPaddle()) {
        this.phase = 'countdown'
        this.timer = COUNTDOWN_TICKS
        this.started = true
      }
      // Highlight the paddle while it is the thing being asked for.
      if (this.playerMesh) {
        const mat = this.playerMesh.material as THREE.MeshLambertMaterial
        mat.color.setHex(this.pointerOnPaddle() ? 0xd6ffe4 : 0x7fd0a0)
      }
    } else if (this.phase === 'countdown') {
      if (this.playerMesh) {
        (this.playerMesh.material as THREE.MeshLambertMaterial).color.setHex(0x7fd0a0)
      }
      if (--this.timer <= 0) this.phase = 'play'
    } else if (this.phase === 'play') {
      // Held at full for inspection; purely a harness affordance, and it
      // overwrites rather than feeding the detector, so nothing else changes.
      if (this.heatLock) {
        this.ai.targetHeat = 1
        this.ai.heat = 1
      }
      const result = this.sim.step(dt, this.playerTarget(), this.ai.update(this.sim))
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
        if (this.stuck >= STUCK_TICKS) { this.sim.faceoff(0); this.ai.reset(); this.stuck = 0 }
      }
    } else if (this.phase === 'scored') {
      if (--this.timer <= 0) {
        // Nudge the faceoff toward whoever just conceded.
        this.sim.faceoff(this.score[0] > this.score[1] ? 0.5 : -0.5)
        this.ai.reset()
        // Every faceoff waits on the player, not just the first: play should
        // never resume while they are still reacting to the last goal.
        this.phase = 'ready'
        this.timer = READY_LOCK_TICKS
      }
    } else if (this.phase === 'over') {
      if (this.input.pointerPressed || this.input.pressed('interact')) {
        this.onSwitch?.(this.returnTo)
        return
      }
    }

    // Opponent paddle glows toward red as it heats up, so the mechanic is
    // visible in play rather than only in the overlay.
    if (this.opponentMesh && this.phase !== 'ready') {
      const mat = this.opponentMesh.material as THREE.MeshLambertMaterial
      const h = this.ai.heat
      mat.color.setRGB(0.816 + h * 0.184, 0.498 - h * 0.25, 0.541 - h * 0.35)
    }

    if (this.puckMesh) this.puckMesh.position.set(sceneX(this.sim.puck.x), this.puckMesh.position.y, this.sim.puck.y)
    if (this.playerMesh) this.playerMesh.position.set(sceneX(this.sim.player.x), this.playerMesh.position.y, this.sim.player.y)
    if (this.opponentMesh) this.opponentMesh.position.set(sceneX(this.sim.opponent.x), this.opponentMesh.position.y, this.sim.opponent.y)
    this.buildUi()
  }

  /**
   * All UI lives in the margins either side of the table, which is framed to
   * fill the frame height. Those margins are trapezoids, not rectangles — the
   * table narrows toward its far end, so there is markedly more room at the top
   * — and the panels are drawn to that true shape and outlined, so the space
   * actually available for information is visible while laying content out.
   */
  private buildUi(): void {
    const font = getFont()
    const o: THREE.Object3D[] = []
    const dislodge = this.sim.cfg.rules.mode === 'dislodge'
    const E = 8
    const top = E
    const bottom = VIRTUAL_H - E
    const G = PANEL_GAP

    const FILL = 0x0c1320
    const LINE = 0x35506e
    const DIM = 0x7d93b2
    const BRIGHT = 0xe8eefb

    // Left margin: outer edge is the frame, inner edge follows the table.
    const lTop = this.edge.leftTop - G
    const lBottom = this.edge.leftBottom - G
    const leftPoly: [number, number][] = [[E, top], [lTop, top], [lBottom, bottom], [E, bottom]]
    // Right margin mirrors it.
    const rTop = this.edge.rightTop + G
    const rBottom = this.edge.rightBottom + G
    const rightPoly: [number, number][] = [
      [rTop, top], [VIRTUAL_W - E, top], [VIRTUAL_W - E, bottom], [rBottom, bottom],
    ]

    for (const poly of [leftPoly, rightPoly]) {
      o.push(screenPoly(poly, FILL, 0.92))
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!
        const b = poly[(i + 1) % poly.length]!
        o.push(screenLine(a[0], a[1], b[0], b[1], 1, LINE))
      }
    }

    const lw = Math.round(lTop - E)
    const rw = Math.round(VIRTUAL_W - E - rTop)
    o.push(makeTextMesh(font, `${lw}>${Math.round(lBottom - E)}`, E + 6, bottom - 20, 0x415a78))
    const dimsR = `${Math.round(VIRTUAL_W - E - rBottom)}<${rw}`
    o.push(makeTextMesh(font, dimsR, VIRTUAL_W - E - 6 - textWidth(font, dimsR), bottom - 20, 0x415a78))

    // Left content hugs the frame's left edge, which is vertical, so it is
    // always clear of the sloping inner boundary.
    const lx = E + 12
    o.push(makeTextMesh(font, this.sim.cfg.opponent.name.toUpperCase(), lx, top + 14, DIM))
    if (dislodge) {
      o.push(makeTextMesh(font, 'WING', lx, top + 224, DIM))
      o.push(makeTextMesh(font, `x${this.sim.wingHits}`, lx, top + 244, BRIGHT, 2))
      o.push(makeTextMesh(font, 'KNOCK IT LOOSE', lx, top + 300, 0x415a78))
    } else {
      o.push(makeTextMesh(font, 'SCORE', lx, top + 224, DIM))
      o.push(makeTextMesh(font, String(this.score[1]), lx, top + 246, BRIGHT, 3))
    }

    // Right content is right-aligned to the frame edge for the same reason.
    const rEdge = VIRTUAL_W - E - 12
    const rt = (text: string, y: number, color: number, scale = 1) =>
      o.push(makeTextMesh(font, text, rEdge - textWidth(font, text, scale), y, color, scale))

    rt('YOU', top + 14, DIM)
    if (!dislodge) {
      rt('SCORE', top + 44, DIM)
      rt(String(this.score[0]), top + 66, BRIGHT, 3)
    }
    rt(`FIRST TO ${this.sim.cfg.rules.targetScore}`, top + 140, 0x415a78)

    if (this.phase === 'ready') {
      rt('CLICK YOUR', top + 244, 0xffd76b)
      rt('PADDLE', top + 264, 0xffd76b, 2)
      rt(this.started ? 'TO RESUME' : 'TO START', top + 302, DIM)
    } else if (this.phase === 'countdown') {
      rt(String(Math.max(1, Math.ceil(this.timer / (COUNTDOWN_TICKS / 3)))), top + 250, 0xffd76b, 3)
    } else if (this.phase === 'scored') {
      rt('GOAL', top + 250, 0xffd76b, 2)
    } else if (this.phase === 'over') {
      rt(this.won ? (dislodge ? 'LOOSE!' : 'WIN') : 'LOSE', top + 250, this.won ? 0x7fd0a0 : 0xd07f8a, 2)
      rt('CLICK TO GO ON', top + 300, DIM)
    }

    this.screen.set(o)
  }

  /** Live AI state, surfaced in the debug overlay. */
  get status(): Record<string, string | number> {
    return {
      phase: this.phase,
      heat: `${this.ai.heat.toFixed(2)} -> ${this.ai.targetHeat.toFixed(2)}${this.heatLock ? ' LOCKED' : ''}`,
      repeats: this.ai.repeats,
      ...(this.autoPlay ? { autoPlay: 'on' } : {}),
      ...(this.heatLock ? { heatLock: 'ON' } : {}),
      puck: `${this.sim?.puck.x.toFixed(1)},${this.sim?.puck.y.toFixed(1)}`,
      squeeze: this.sim?.compression.toFixed(2) ?? '-',
    }
  }

  render(): void {
    this.gfx.beginFrame(0x070b12)
    this.gfx.gl.render(this.scene, this.camera)
    this.screen.render(this.gfx.gl)
  }
}
