export type Button = 'up' | 'down' | 'left' | 'right' | 'interact' | 'debugMode' | 'debugOverlay'

const BINDINGS: Record<string, Button> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  KeyZ: 'interact', Enter: 'interact', Space: 'interact',
  KeyM: 'debugMode',
  F1: 'debugOverlay',
}

/**
 * Polls keyboard into a per-tick snapshot (doc §5). `held` is current state;
 * `pressed` is the rising edge since the previous tick.
 */
export class Input {
  private down = new Set<Button>()
  private prev = new Set<Button>()

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => {
      const b = BINDINGS[(e as KeyboardEvent).code]
      if (!b) return
      e.preventDefault()
      this.down.add(b)
    })
    target.addEventListener('keyup', (e) => {
      const b = BINDINGS[(e as KeyboardEvent).code]
      if (!b) return
      e.preventDefault()
      this.down.delete(b)
    })
    // Held keys would otherwise stick if focus is lost mid-press.
    target.addEventListener('blur', () => this.down.clear())
  }

  held(b: Button): boolean { return this.down.has(b) }
  pressed(b: Button): boolean { return this.down.has(b) && !this.prev.has(b) }

  /** Call once per fixed tick, after the active mode has consumed input. */
  endTick(): void {
    this.prev.clear()
    for (const b of this.down) this.prev.add(b)
  }
}
