/** A top-level game mode (doc §3). Only the active mode ticks. */
export interface Mode {
  readonly name: string
  enter(payload?: unknown): void
  exit(): void
  update(dt: number): void
  render(): void
}

/**
 * Modes the debug key may cycle into, in order.
 *
 * Deliberately not every registered mode. `dialogue` and `battle` are entered
 * *with* something — a script, a battle config — and cycling into them cold is
 * not a harmless detour: `battle` throws, and `dialogue` opens a conversation
 * with no lines, which draws nothing at all and cannot be advanced past,
 * because advancing past the last line is what leaves it. The player gets a
 * frozen-looking world and no way back.
 */
export const DEBUG_CYCLE: readonly string[] = ['overworld', 'gallery']

/**
 * The next mode for the debug cycle key.
 *
 * A current mode outside the cycle — a real conversation or a real battle —
 * lands on the first entry rather than nowhere, so the key doubles as a way
 * back out to the world.
 */
export function nextDebugMode(current: string, cycle: readonly string[] = DEBUG_CYCLE): string {
  const i = cycle.indexOf(current)
  return cycle[(i + 1) % cycle.length]!
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

  /**
   * Apply a pending switch now rather than at the next tick.
   *
   * Transitions are normally deferred so a mode can request one from inside its
   * own update() without re-entrancy. The editor has the opposite problem: it
   * runs while the loop is paused, so no update() is ever coming, and a
   * deferred switch would simply never happen.
   */
  switchNow(name: string, payload?: unknown): void {
    this.switchTo(name, payload)
    this.applyPending()
  }

  render(): void { this.current?.render() }
}
