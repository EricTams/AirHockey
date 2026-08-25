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

      this.accumulator += elapsed
      let ticks = 0
      while (this.accumulator >= TICK_DT) {
        this.tick(TICK_DT)
        this.accumulator -= TICK_DT
        ticks++
      }
      this.ticksLastFrame = ticks
      this.render()
    }
    this.raf = requestAnimationFrame(frame)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }
}
