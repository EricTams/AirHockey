/**
 * The battle sim is entirely 2D (doc §8.2): x across the table, y along it,
 * origin at centre, player at negative y. The 3D scene maps sim (x, y) onto
 * the table's (x, z).
 *
 * Written by hand rather than driven by a physics engine. The puck covers
 * roughly two radii per tick at top speed, so tunnelling is a live risk, and
 * the paddle-to-puck impulse — the interaction the whole game rests on — needs
 * direct control that engines make awkward for kinematic bodies.
 */

export interface Vec { x: number; y: number }
/**
 * Where a paddle wants to be, and optionally how fast it is willing to travel
 * to get there. Without the speed, movePaddle always closes at full tilt, so a
 * caller cannot express an intent weaker than maximum — which is exactly what
 * splitting a speed budget between behaviours requires.
 */
export interface Target extends Vec { speed?: number }
export interface Body extends Vec { vx: number; vy: number }

/** Static deflector. Doc §8.1 calls for convex polygons; boxes cover v1's layouts. */
export interface BlockObstacle {
  kind: 'block'
  x: number; y: number
  halfW: number; halfH: number
}

/**
 * Paired portal. A puck entering one mouth leaves the other still moving, but
 * turned by `turn` degrees — the bend in the pipe.
 */
export interface PipeObstacle {
  kind: 'pipe'
  id: string
  x: number; y: number
  radius: number
  /** id of the pipe this one empties into. */
  exit: string
  /** Degrees to rotate the exit velocity by. */
  turn: number
}

/** Something jammed in a goal mouth. Blocks it until knocked loose. */
export interface WingObstacle {
  kind: 'wing'
  x: number; y: number
  radius: number
  /** Hits needed to dislodge it. */
  hits: number
}

export type Obstacle = BlockObstacle | PipeObstacle | WingObstacle

export interface TableConfig {
  width: number; length: number; goalWidth: number
  obstacles?: Obstacle[]
}
export interface PuckConfig { radius: number; maxSpeed: number; friction: number; restitution: number }
export interface PaddleConfig { radius: number; maxSpeed: number }
export interface OpponentConfig {
  name: string
  sheet?: string
  /** `inert` parks the paddle: some opponents do not contest the puck at all. */
  ai: 'standard' | 'inert'
  /** Colour multiplier matching the NPC's overworld tint. */
  tint?: number
  roamDepth?: number
  aggression?: number
}
export interface BattleConfig {
  id: string
  opponent: OpponentConfig
  table: TableConfig
  puck: PuckConfig
  paddle: PaddleConfig
  /** `score` is first-to-target; `dislodge` is won by knocking the wing loose. */
  rules: { mode: 'score' | 'dislodge'; targetScore: number }
}

export type StepResult = 'none' | 'playerScored' | 'opponentScored' | 'dislodged'

/** Sub-steps per tick. Cheaper than full CCD and enough at these speeds. */
const SUBSTEPS = 4
/** Sub-steps a puck is immune to pipes after using one, so it cannot ping-pong. */
const PIPE_COOLDOWN = 8
/** Sub-steps between wing hits, so one contact cannot burn every hit. */
const WING_COOLDOWN = 12
/**
 * Fake elasticity. A puck squeezed between a paddle and a wall has nowhere to
 * go, so the sim just holds it there — pull the paddle off and it sits inert,
 * which feels dead. Instead the squeeze is stored as compression and returned
 * as velocity when the pinch releases, so a trapped puck springs out.
 */
const COMPRESS_PER_SUBSTEP = 0.09
/** Ceiling on stored compression, in the same units as puck speed. */
const MAX_COMPRESSION = 3.2
/** Fraction of stored compression handed back as velocity on release. */
const RELEASE_EFFICIENCY = 0.85
/** Release direction wanders this far either side of the wall normal, in radians. */
const RELEASE_SPREAD = 0.55
/** Release strength varies between this and full, so no two springs match. */
const RELEASE_MIN_SCALE = 0.65
const DEG = Math.PI / 180

export class BattleSim {
  readonly puck: Body = { x: 0, y: 0, vx: 0, vy: 0 }
  readonly player: Body = { x: 0, y: 0, vx: 0, vy: 0 }
  readonly opponent: Body = { x: 0, y: 0, vx: 0, vy: 0 }

  /** Hits left before the wing comes loose; 0 once dislodged. */
  wingHits = 0
  wingDislodged = false
  /** Set for one step when the puck just used a pipe, for the scene to react to. */
  lastPipeUsed?: string
  /**
   * Set for the step in which the opponent's paddle struck the puck: where the
   * contact happened and where the puck went. The AI watches this to notice
   * when it is repeating itself.
   */
  lastOpponentHit?: { x: number; y: number; vx: number; vy: number }
  /**
   * True while the opponent's paddle overlaps the puck, struck or not. A puck
   * wedged in a corner rests against a motionless paddle: there is no impulse
   * and so no strike, but it is still pinned.
   */
  opponentContact = false
  /**
   * Energy stored in a puck currently pinched against a wall, and the direction
   * it will spring when released. Surfaced for the debug overlay.
   */
  compression = 0
  private releaseX = 0
  private releaseY = 0
  private rngState: number

  /** Deterministic PRNG, so a seeded match still replays identically. */
  private rand(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0
    let t = Math.imul(this.rngState ^ (this.rngState >>> 15), 1 | this.rngState)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private pipeCooldown = 0
  private wingCooldown = 0

  constructor(readonly cfg: BattleConfig, seed = 0x2545f491) {
    this.rngState = seed >>> 0
    const wing = this.wing
    this.wingHits = wing?.hits ?? 0
    this.wingDislodged = !wing
    this.faceoff(0)
  }

  private get obstacles(): Obstacle[] { return this.cfg.table.obstacles ?? [] }
  get wing(): WingObstacle | undefined {
    return this.obstacles.find((o): o is WingObstacle => o.kind === 'wing')
  }
  get pipes(): PipeObstacle[] {
    return this.obstacles.filter((o): o is PipeObstacle => o.kind === 'pipe')
  }
  get blocks(): BlockObstacle[] {
    return this.obstacles.filter((o): o is BlockObstacle => o.kind === 'block')
  }

  /**
   * Squeeze bookkeeping. `pinch` is the inward wall normal when the puck is
   * pressed against a wall by a paddle, or undefined when it is free.
   */
  private updateCompression(pinch: Vec | undefined): void {
    if (pinch) {
      this.compression = Math.min(MAX_COMPRESSION, this.compression + COMPRESS_PER_SUBSTEP)
      this.releaseX = pinch.x
      this.releaseY = pinch.y
      return
    }
    if (this.compression <= 0) return

    /*
     * Released. Hand the stored squeeze back as motion, directed off the wall
     * that was holding the puck in — but not on exactly the same line every
     * time. A deterministic spring would be one more repeatable pattern to
     * settle into, which is the thing this is all meant to avoid.
     */
    const angle = (this.rand() * 2 - 1) * RELEASE_SPREAD
    const scale = RELEASE_MIN_SCALE + this.rand() * (1 - RELEASE_MIN_SCALE)
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    const push = this.compression * RELEASE_EFFICIENCY * scale
    this.puck.vx += (this.releaseX * c - this.releaseY * sn) * push
    this.puck.vy += (this.releaseX * sn + this.releaseY * c) * push
    this.compression = 0
  }

  /**
   * The inward wall normal if the puck is currently pinched between a paddle
   * and a wall, otherwise undefined. In a corner both axes contribute, so it
   * springs out along the diagonal.
   */
  private pinchNormal(): Vec | undefined {
    const { width, length } = this.cfg.table
    const r = this.cfg.puck.radius
    // Contact resolution leaves the puck at *exactly* this separation, so the
    // test needs a hair of tolerance or resting contact never registers.
    const sum = this.cfg.paddle.radius + r + 0.02
    const touching =
      Math.hypot(this.puck.x - this.player.x, this.puck.y - this.player.y) < sum ||
      Math.hypot(this.puck.x - this.opponent.x, this.puck.y - this.opponent.y) < sum
    if (!touching) return undefined

    const slack = 0.02
    let nx = 0
    let ny = 0
    if (this.puck.x >= width / 2 - r - slack) nx = -1
    else if (this.puck.x <= -width / 2 + r + slack) nx = 1
    if (this.puck.y >= length / 2 - r - slack) ny = -1
    else if (this.puck.y <= -length / 2 + r + slack) ny = 1
    if (nx === 0 && ny === 0) return undefined

    const len = Math.hypot(nx, ny)
    return { x: nx / len, y: ny / len }
  }

  /** Reset for a faceoff, nudged toward whoever conceded (doc §8.3). */
  faceoff(offsetY = 0): void {
    const { length } = this.cfg.table
    Object.assign(this.puck, { x: 0, y: offsetY, vx: 0, vy: 0 })
    Object.assign(this.player, { x: 0, y: -length * 0.35, vx: 0, vy: 0 })
    Object.assign(this.opponent, { x: 0, y: length * 0.35, vx: 0, vy: 0 })
    this.pipeCooldown = 0
    this.wingCooldown = 0
    this.compression = 0
  }

  /** Clamp a paddle target into that paddle's own half, inset by its radius. */
  clampToHalf(target: Vec, isPlayer: boolean): Vec {
    const { width, length } = this.cfg.table
    const r = this.cfg.paddle.radius
    const xLimit = width / 2 - r
    const x = Math.max(-xLimit, Math.min(xLimit, target.x))
    const y = isPlayer
      ? Math.max(-length / 2 + r, Math.min(-r, target.y))
      : Math.max(r, Math.min(length / 2 - r, target.y))
    return { x, y }
  }

  private movePaddle(p: Body, target: Target, dt: number, isPlayer: boolean): void {
    const goal = this.clampToHalf(target, isPlayer)
    let dx = goal.x - p.x
    let dy = goal.y - p.y
    const dist = Math.hypot(dx, dy)
    const speed = Math.min(this.cfg.paddle.maxSpeed, target.speed ?? this.cfg.paddle.maxSpeed)
    const max = speed * dt
    if (dist > max && dist > 0) {
      dx = (dx / dist) * max
      dy = (dy / dist) * max
    }
    // Velocity is derived from actual displacement, so the impulse a paddle
    // imparts always matches the motion drawn on screen.
    p.vx = dt > 0 ? dx / dt : 0
    p.vy = dt > 0 ? dy / dt : 0
    p.x += dx
    p.y += dy
  }

  /** Reflect the puck off a circle at (cx, cy). Returns true on contact. */
  private collideCircle(cx: number, cy: number, radius: number, vx = 0, vy = 0): boolean {
    const sum = radius + this.cfg.puck.radius
    let dx = this.puck.x - cx
    let dy = this.puck.y - cy
    let d = Math.hypot(dx, dy)
    if (d >= sum) return false
    if (d === 0) { dx = 0; dy = 1; d = 1 }        // exactly concentric
    const nx = dx / d
    const ny = dy / d

    this.puck.x = cx + nx * sum
    this.puck.y = cy + ny * sum

    // Reflect relative to the surface's own velocity, so a moving paddle
    // transfers its speed and a stationary one merely bounces the puck.
    const vn = (this.puck.vx - vx) * nx + (this.puck.vy - vy) * ny
    if (vn >= 0) return false
    const j = -(1 + this.cfg.puck.restitution) * vn
    this.puck.vx += j * nx
    this.puck.vy += j * ny
    return true
  }

  /** Circle vs axis-aligned box, resolved along the axis of least penetration. */
  private collideBlock(b: BlockObstacle): void {
    const r = this.cfg.puck.radius
    const nearestX = Math.max(b.x - b.halfW, Math.min(this.puck.x, b.x + b.halfW))
    const nearestY = Math.max(b.y - b.halfH, Math.min(this.puck.y, b.y + b.halfH))
    const dx = this.puck.x - nearestX
    const dy = this.puck.y - nearestY
    const d2 = dx * dx + dy * dy

    if (d2 > r * r) return
    const e = this.cfg.puck.restitution

    if (d2 > 1e-12) {
      // Contact on a face or corner: push out along the contact normal.
      const d = Math.sqrt(d2)
      const nx = dx / d
      const ny = dy / d
      this.puck.x = nearestX + nx * r
      this.puck.y = nearestY + ny * r
      const vn = this.puck.vx * nx + this.puck.vy * ny
      if (vn < 0) {
        const j = -(1 + e) * vn
        this.puck.vx += j * nx
        this.puck.vy += j * ny
      }
      return
    }

    // Centre is inside the box: eject through the nearest face.
    const left = this.puck.x - (b.x - b.halfW)
    const right = (b.x + b.halfW) - this.puck.x
    const down = this.puck.y - (b.y - b.halfH)
    const up = (b.y + b.halfH) - this.puck.y
    const min = Math.min(left, right, down, up)
    if (min === left) { this.puck.x = b.x - b.halfW - r; this.puck.vx = -Math.abs(this.puck.vx) * e }
    else if (min === right) { this.puck.x = b.x + b.halfW + r; this.puck.vx = Math.abs(this.puck.vx) * e }
    else if (min === down) { this.puck.y = b.y - b.halfH - r; this.puck.vy = -Math.abs(this.puck.vy) * e }
    else { this.puck.y = b.y + b.halfH + r; this.puck.vy = Math.abs(this.puck.vy) * e }
  }

  /**
   * Pipes teleport the puck to their partner and rotate its velocity by the
   * bend angle. The puck is ejected along its *new* heading, past the exit
   * mouth, so it emerges travelling naturally rather than re-triggering.
   */
  private tryPipes(): void {
    if (this.pipeCooldown > 0) { this.pipeCooldown--; return }
    for (const pipe of this.pipes) {
      const d = Math.hypot(this.puck.x - pipe.x, this.puck.y - pipe.y)
      if (d > pipe.radius) continue
      const exit = this.pipes.find((p) => p.id === pipe.exit)
      if (!exit) continue

      const rad = pipe.turn * DEG
      const c = Math.cos(rad)
      const s = Math.sin(rad)
      const vx = this.puck.vx * c - this.puck.vy * s
      const vy = this.puck.vx * s + this.puck.vy * c
      this.puck.vx = vx
      this.puck.vy = vy

      const speed = Math.hypot(vx, vy)
      const clear = exit.radius + this.cfg.puck.radius + 0.02
      if (speed > 1e-6) {
        this.puck.x = exit.x + (vx / speed) * clear
        this.puck.y = exit.y + (vy / speed) * clear
      } else {
        this.puck.x = exit.x
        this.puck.y = exit.y + clear
      }
      this.pipeCooldown = PIPE_COOLDOWN
      this.lastPipeUsed = exit.id
      return
    }
  }

  private clampSpeed(): void {
    const s = Math.hypot(this.puck.vx, this.puck.vy)
    const max = this.cfg.puck.maxSpeed
    if (s > max) {
      this.puck.vx = (this.puck.vx / s) * max
      this.puck.vy = (this.puck.vy / s) * max
    }
  }

  get speed(): number { return Math.hypot(this.puck.vx, this.puck.vy) }

  step(dt: number, playerTarget: Target, opponentTarget: Target): StepResult {
    const { width, length, goalWidth } = this.cfg.table
    const r = this.cfg.puck.radius
    const xLimit = width / 2 - r
    const yLimit = length / 2 - r
    const sub = dt / SUBSTEPS
    const wing = this.wing
    let result: StepResult = 'none'
    this.lastPipeUsed = undefined
    this.lastOpponentHit = undefined
    this.opponentContact = false

    for (let i = 0; i < SUBSTEPS; i++) {
      this.movePaddle(this.player, playerTarget, sub, true)
      this.movePaddle(this.opponent, opponentTarget, sub, false)

      this.puck.x += this.puck.vx * sub
      this.puck.y += this.puck.vy * sub

      if (this.puck.x < -xLimit) { this.puck.x = -xLimit; this.puck.vx = Math.abs(this.puck.vx) * this.cfg.puck.restitution }
      if (this.puck.x > xLimit) { this.puck.x = xLimit; this.puck.vx = -Math.abs(this.puck.vx) * this.cfg.puck.restitution }

      const inMouth = Math.abs(this.puck.x) < goalWidth / 2
      if (this.puck.y < -yLimit) {
        if (inMouth && result === 'none') result = 'opponentScored'
        else { this.puck.y = -yLimit; this.puck.vy = Math.abs(this.puck.vy) * this.cfg.puck.restitution }
      }
      if (this.puck.y > yLimit) {
        if (inMouth && result === 'none') result = 'playerScored'
        else { this.puck.y = yLimit; this.puck.vy = -Math.abs(this.puck.vy) * this.cfg.puck.restitution }
      }

      this.collideCircle(this.player.x, this.player.y, this.cfg.paddle.radius, this.player.vx, this.player.vy)
      const sum = this.cfg.paddle.radius + this.cfg.puck.radius
      if (Math.hypot(this.puck.x - this.opponent.x, this.puck.y - this.opponent.y) < sum) {
        this.opponentContact = true
      }
      if (this.collideCircle(
        this.opponent.x, this.opponent.y, this.cfg.paddle.radius,
        this.opponent.vx, this.opponent.vy,
      )) {
        this.lastOpponentHit = {
          x: this.puck.x, y: this.puck.y, vx: this.puck.vx, vy: this.puck.vy,
        }
      }
      for (const b of this.blocks) this.collideBlock(b)

      if (wing && !this.wingDislodged) {
        const hit = this.collideCircle(wing.x, wing.y, wing.radius)
        if (this.wingCooldown > 0) this.wingCooldown--
        else if (hit) {
          this.wingCooldown = WING_COOLDOWN
          this.wingHits--
          if (this.wingHits <= 0) {
            this.wingHits = 0
            this.wingDislodged = true
            if (result === 'none') result = 'dislodged'
          }
        }
      }

      this.tryPipes()
      this.updateCompression(this.pinchNormal())
      this.clampSpeed()
    }

    // Friction is a per-tick coefficient (doc §8.2). Applying it inside the
    // sub-step loop compounded it SUBSTEPS times, decaying the puck four times
    // faster than the config asked for.
    this.puck.vx *= this.cfg.puck.friction
    this.puck.vy *= this.cfg.puck.friction
    return result
  }
}
