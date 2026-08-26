export type Button =
  | 'up' | 'down' | 'left' | 'right' | 'interact'
  | 'debugMode' | 'debugOverlay' | 'pitchDown' | 'pitchUp'
  | 'debugTrap' | 'debugAutoPlay'

const BINDINGS: Record<string, Button> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  KeyZ: 'interact', Enter: 'interact', Space: 'interact',
  KeyM: 'debugMode',
  F1: 'debugOverlay',
  BracketLeft: 'pitchDown',
  BracketRight: 'pitchUp',
  KeyT: 'debugTrap',
  KeyY: 'debugAutoPlay',
}

/**
 * Polls keyboard into a per-tick snapshot (doc §5). `held` is current state;
 * `pressed` is the rising edge since the previous tick.
 */
export type InputSource = 'keyboard' | 'pointer'

export class Input {
  private down = new Set<Button>()
  private prev = new Set<Button>()

  /** Latest pointer position in client coordinates, or undefined if never seen. */
  pointer?: { x: number; y: number }
  private pointerIsDown = false
  private pointerWasDown = false
  /** Which device the player used most recently, so the two can coexist. */
  source: InputSource = 'keyboard'

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => {
      const b = BINDINGS[(e as KeyboardEvent).code]
      if (!b) return
      e.preventDefault()
      this.source = 'keyboard'
      this.down.add(b)
    })
    target.addEventListener('keyup', (e) => {
      const b = BINDINGS[(e as KeyboardEvent).code]
      if (!b) return
      e.preventDefault()
      this.down.delete(b)
    })
    // Held keys would otherwise stick if focus is lost mid-press.
    target.addEventListener('blur', () => {
      this.down.clear()
      this.pointerIsDown = false
    })

    target.addEventListener('pointermove', (e) => {
      const p = e as PointerEvent
      this.pointer = { x: p.clientX, y: p.clientY }
      this.source = 'pointer'
    })
    target.addEventListener('pointerdown', (e) => {
      const p = e as PointerEvent
      this.pointer = { x: p.clientX, y: p.clientY }
      this.source = 'pointer'
      this.pointerIsDown = true
    })
    target.addEventListener('pointerup', () => { this.pointerIsDown = false })
    // A release outside the window would otherwise leave the button stuck down.
    target.addEventListener('pointercancel', () => { this.pointerIsDown = false })
  }

  get pointerHeld(): boolean { return this.pointerIsDown }
  /** Rising edge of the primary pointer button, same contract as `pressed`. */
  get pointerPressed(): boolean { return this.pointerIsDown && !this.pointerWasDown }

  held(b: Button): boolean { return this.down.has(b) }
  pressed(b: Button): boolean { return this.down.has(b) && !this.prev.has(b) }

  /** Call once per fixed tick, after the active mode has consumed input. */
  endTick(): void {
    this.prev.clear()
    for (const b of this.down) this.prev.add(b)
    this.pointerWasDown = this.pointerIsDown
  }
}
