/** A top-level game mode (doc §3). Only the active mode ticks. */
export interface Mode {
  readonly name: string
  enter(payload?: unknown): void
  exit(): void
  update(dt: number): void
  render(): void
}

/**
 * Single top-level state machine. Transitions are deferred to a tick boundary so
 * a mode can request one from inside its own update() without re-entrancy.
 */
export class ModeManager {
  private modes = new Map<string, Mode>()
  private current?: Mode
  private pending?: { name: string; payload?: unknown }

  register(mode: Mode): void { this.modes.set(mode.name, mode) }

  /** Request a switch; applied before the next update. */
  switchTo(name: string, payload?: unknown): void {
    if (!this.modes.has(name)) throw new Error(`unknown mode: ${name}`)
    this.pending = { name, payload }
  }

  get activeName(): string { return this.current?.name ?? '<none>' }
  get names(): string[] { return [...this.modes.keys()] }

  private applyPending(): void {
    if (!this.pending) return
    const { name, payload } = this.pending
    this.pending = undefined
    this.current?.exit()
    this.current = this.modes.get(name)!
    this.current.enter(payload)
  }

  update(dt: number): void {
    this.applyPending()
    this.current?.update(dt)
  }

  render(): void { this.current?.render() }
}
