/**
 * The battle sim is entirely 2D (doc §8.2): x across the table, y along it,
 * origin at centre. The 3D scene maps sim (x, y) onto the table's (x, z).
 *
 * Written by hand rather than driven by a physics engine. The puck covers
 * roughly two radii per tick at top speed, so tunnelling is a live risk, and
 * the paddle-to-puck impulse — the interaction the whole game rests on — needs
 * direct control that engines make awkward for kinematic bodies.
 */

export interface TableConfig { width: number; length: number; goalWidth: number }
export interface PuckConfig { radius: number; maxSpeed: number; friction: number; restitution: number }
export interface PaddleConfig { radius: number; maxSpeed: number }
export interface BattleConfig {
  table: TableConfig
  puck: PuckConfig
  paddle: PaddleConfig
  rules: { targetScore: number }
}

export interface Vec { x: number; y: number }
export interface Body extends Vec { vx: number; vy: number }

export type StepResult = 'none' | 'playerScored' | 'opponentScored'

/** Sub-steps per tick. Cheaper than full CCD and enough at these speeds. */
const SUBSTEPS = 4

export class BattleSim {
  readonly puck: Body = { x: 0, y: 0, vx: 0, vy: 0 }
  readonly player: Body = { x: 0, y: 0, vx: 0, vy: 0 }
  readonly opponent: Body = { x: 0, y: 0, vx: 0, vy: 0 }

  constructor(readonly cfg: BattleConfig) {
    this.faceoff(0)
  }

  /** Reset for a faceoff, nudged toward whoever conceded (doc §8.3). */
  faceoff(offsetY = 0): void {
    const { length } = this.cfg.table
    Object.assign(this.puck, { x: 0, y: offsetY, vx: 0, vy: 0 })
    Object.assign(this.player, { x: 0, y: -length * 0.35, vx: 0, vy: 0 })
    Object.assign(this.opponent, { x: 0, y: length * 0.35, vx: 0, vy: 0 })
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

  private movePaddle(p: Body, target: Vec, dt: number, isPlayer: boolean): void {
    const goal = this.clampToHalf(target, isPlayer)
    let dx = goal.x - p.x
    let dy = goal.y - p.y
    const dist = Math.hypot(dx, dy)
    const max = this.cfg.paddle.maxSpeed * dt
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

  private collidePaddle(p: Body): void {
    const sum = this.cfg.paddle.radius + this.cfg.puck.radius
    let dx = this.puck.x - p.x
    let dy = this.puck.y - p.y
    let d = Math.hypot(dx, dy)
    if (d >= sum) return
    if (d === 0) { dx = 0; dy = 1; d = 1 }        // exactly concentric
    const nx = dx / d
    const ny = dy / d

    this.puck.x = p.x + nx * sum
    this.puck.y = p.y + ny * sum

    // Reflect the puck's velocity *relative to the paddle*, so a moving paddle
    // transfers its speed and a stationary one merely bounces the puck.
    const rvx = this.puck.vx - p.vx
    const rvy = this.puck.vy - p.vy
    const vn = rvx * nx + rvy * ny
    if (vn >= 0) return
    const j = -(1 + this.cfg.puck.restitution) * vn
    this.puck.vx += j * nx
    this.puck.vy += j * ny
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

  step(dt: number, playerTarget: Vec, opponentTarget: Vec): StepResult {
    const { width, length, goalWidth } = this.cfg.table
    const r = this.cfg.puck.radius
    const xLimit = width / 2 - r
    const yLimit = length / 2 - r
    const sub = dt / SUBSTEPS
    let result: StepResult = 'none'

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

      this.collidePaddle(this.player)
      this.collidePaddle(this.opponent)

      this.puck.vx *= this.cfg.puck.friction
      this.puck.vy *= this.cfg.puck.friction
      this.clampSpeed()
    }
    return result
  }
}

/**
 * Doc §8.4, thin-slice form. Two states:
 *
 *   Attack  the puck is on the opponent's side and within reach, so drive at a
 *           point just past it toward the player's goal.
 *   Defend  otherwise, hold a home line and track the puck's x.
 *
 * Deterministic rather than probability-gated, so it is testable and cannot
 * deadlock. An earlier version only ever held the home line, which meant a puck
 * resting at centre was never contested and the stuck-puck rule re-faceoffed
 * forever.
 */
export function opponentTarget(sim: BattleSim, roamDepth = 0.45, aggression = 0.5): Vec {
  const { length } = sim.cfg.table
  const home = (length / 2) * roamDepth
  const reach = length * (0.25 + aggression * 0.35)

  // The paddle is clamped out of the player's half anyway, so targeting just
  // past a centre puck presses right up to the line and connects.
  if (sim.puck.y > -sim.cfg.puck.radius && sim.puck.y < reach) {
    const behind = (sim.cfg.paddle.radius + sim.cfg.puck.radius) * 0.9
    return { x: sim.puck.x, y: sim.puck.y - behind }
  }
  return { x: sim.puck.x * 0.6, y: home }
}
