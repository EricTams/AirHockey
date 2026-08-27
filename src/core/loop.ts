import { TICK_DT } from './config'

/** Longest real time a single frame may advance, to avoid a death spiral after a stall. */
const MAX_FRAME_S = 0.25

/** An exception that escaped a mode, with how many times this one has now. */
export interface LoopFailure {
  phase: 'tick' | 'render'
  error: unknown
  /** Occurrences of this same phase-and-message, starting at 1. */
  count: number
}

/**
 * One requestAnimationFrame loop driving a fixed-timestep logic tick with a
 * variable render (doc §3).
 *
 * The loop is the last place a thrown error can be contained, so it contains
 * them: a mode that throws costs its frame, not the session. This is not a
 * softening of the project's strict-and-loud rule — an escaped exception is
 * still reported, and reported the first time rather than the ten-thousandth.
 * It is the difference between loud and fatal. A designer whose editor dies has
 * lost the thing that would have told them what went wrong, and everything they
 * had not saved.
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

  /** Distinct failures seen, keyed by phase and message, to their count. */
  private failures = new Map<string, number>()

  /** Total exceptions contained, for the debug readout. */
  get failureCount(): number {
    let n = 0
    for (const c of this.failures.values()) n += c
    return n
  }

  constructor(
    private readonly tick: (dt: number) => void,
    private readonly render: () => void,
    private readonly onFailure?: (failure: LoopFailure) => void,
  ) {}

  private contain(phase: LoopFailure['phase'], error: unknown): void {
    const key = `${phase}:${(error as Error)?.message ?? String(error)}`
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    // Once per distinct failure. A throw in render repeats every frame, and a
    // console with sixty copies a second of one stack is a console with nothing
    // in it.
    if (count === 1) console.error(`[loop] ${phase} threw and was contained:`, error)
    this.onFailure?.({ phase, error, count })
  }

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
        try {
          while (this.accumulator >= TICK_DT) {
            this.tick(TICK_DT)
            this.accumulator -= TICK_DT
            ticks++
          }
        } catch (err) {
          // Abandon the rest of this frame's ticks rather than re-running the
          // work that just failed up to MAX_FRAME_S/TICK_DT times over. The
          // accumulator goes with them: keeping the debt would fast-forward the
          // sim through every frame the game spent broken, the moment it
          // recovered.
          this.accumulator = 0
          this.contain('tick', err)
        }
      }
      this.ticksLastFrame = ticks
      // Rendering continues while paused: the editor still needs a picture,
      // and a frozen frame is what "the game is not running" should look like.
      // It also continues after a failed tick, because the picture is how the
      // failure gets seen.
      try {
        this.render()
      } catch (err) {
        this.contain('render', err)
      }
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
