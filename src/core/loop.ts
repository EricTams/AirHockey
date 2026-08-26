import { TICK_DT } from './config'

/** Longest real time a single frame may advance, to avoid a death spiral after a stall. */
const MAX_FRAME_S = 0.25

/**
 * One requestAnimationFrame loop driving a fixed-timestep logic tick with a
 * variable render (doc §3).
 */
export class Loop {
  private accumulator = 0
  private last = 0
  private raf = 0
  private running = false
  private paused = false

  /** Smoothed frames-per-second, for the debug overlay. */
  fps = 0
  /** Logic ticks executed during the most recent frame. */
  ticksLastFrame = 0

  constructor(
    private readonly tick: (dt: number) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame)
      const elapsed = Math.min((now - this.last) / 1000, MAX_FRAME_S)
      this.last = now
      this.fps += ((elapsed > 0 ? 1 / elapsed : 0) - this.fps) * 0.1

      let ticks = 0
      if (!this.paused) {
        this.accumulator += elapsed
        while (this.accumulator >= TICK_DT) {
          this.tick(TICK_DT)
          this.accumulator -= TICK_DT
          ticks++
        }
      }
      this.ticksLastFrame = ticks
      // Rendering continues while paused: the editor still needs a picture,
      // and a frozen frame is what "the game is not running" should look like.
      this.render()
    }
    this.raf = requestAnimationFrame(frame)
  }

  /**
   * Stop advancing logic while still presenting frames. Time accrued while
   * paused is discarded, so resuming does not fast-forward the sim through
   * however long the editor was open.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    this.accumulator = 0
    this.ticksLastFrame = 0
  }

  get isPaused(): boolean { return this.paused }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }
}
