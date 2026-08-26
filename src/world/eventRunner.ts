import type { Command, Condition, WarpTarget } from './event'
import type { GameState } from './gameState'
import type { Facing } from './character'
import type { DialogueLine } from '../modes/dialogue'

/**
 * The event interpreter.
 *
 * The game is a 60Hz fixed-timestep loop, so an event that waits — for a line
 * of dialogue, for a battle, for thirty frames — cannot block. It suspends and
 * resumes instead: `step()` runs commands until something needs the outside
 * world, hands that back as a request, and picks up where it left off when the
 * host calls `resume`.
 *
 * A stack of frames rather than recursion, because a frame is exactly what has
 * to survive a suspension: which list is running, how far through it is, and
 * whether it is a loop that should go round again.
 *
 * No DOM, no Three, no modes — it is handed a GameState and returns requests.
 * That is what makes it testable, and the interpreter is the part of the event
 * system most worth testing.
 */

export type Request =
  | { kind: 'say'; lines: DialogueLine[] }
  | { kind: 'script'; path: string }
  | { kind: 'battle'; path: string }
  | { kind: 'warp'; target: WarpTarget }
  | { kind: 'face'; facing: Facing }
  | { kind: 'walk'; steps: Facing[] }

export type Step =
  | { kind: 'done' }
  /** Still going; call step() again next tick. */
  | { kind: 'running' }
  | { kind: 'suspend'; request: Request }

/** What a resumed request reports back. Only `battle` has anything to say. */
export interface Resumption { won?: boolean }

interface Frame {
  commands: readonly Command[]
  index: number
  loop?: { kind: 'while'; when: readonly Condition[] } | { kind: 'repeat'; left: number }
}

/**
 * Commands executed in one tick before yielding.
 *
 * A `while` whose body suspends nothing and whose condition never changes is a
 * designer's bug, but it must not be one that hangs the browser. This cap turns
 * it into a game that keeps running while the loop spins, which is visible and
 * recoverable rather than a locked tab.
 */
const MAX_STEPS_PER_TICK = 2000

export class EventRunner {
  private stack: Frame[] = []
  private waitFrames = 0
  private suspended = false
  private finished = false

  constructor(
    readonly eventId: string,
    commands: readonly Command[],
    private state: GameState,
  ) {
    this.stack.push({ commands, index: 0 })
  }

  get isDone(): boolean { return this.finished }
  get isSuspended(): boolean { return this.suspended }

  /**
   * Run until something suspends, the list ends, or the per-tick cap is hit.
   * Calling this while suspended does nothing: the host owes a `resume` first.
   */
  step(): Step {
    if (this.finished) return { kind: 'done' }
    if (this.suspended) return { kind: 'running' }

    if (this.waitFrames > 0) {
      // The tick that ran the wait command counts as the first of them, so
      // `{ wait: 3 }` holds the event for exactly three ticks and the next
      // command runs on the fourth.
      this.waitFrames--
      if (this.waitFrames > 0) return { kind: 'running' }
    }

    for (let n = 0; n < MAX_STEPS_PER_TICK; n++) {
      const frame = this.stack.at(-1)
      if (!frame) return this.finish()

      if (frame.index >= frame.commands.length) {
        this.endOfFrame(frame)
        continue
      }

      const command = frame.commands[frame.index++]!
      const outcome = this.run(command)
      if (outcome) {
        this.suspended = true
        return { kind: 'suspend', request: outcome }
      }
      if (this.finished) return { kind: 'done' }
      if (this.waitFrames > 0) return { kind: 'running' }
    }
    return { kind: 'running' }
  }

  /** Hand back the result of whatever the last request needed. */
  resume(result: Resumption = {}): void {
    if (!this.suspended) return
    this.suspended = false
    if (this.pendingBattle) {
      const branch = result.won ? this.pendingBattle.won : this.pendingBattle.lost
      this.pendingBattle = undefined
      if (branch && branch.length > 0) this.stack.push({ commands: branch, index: 0 })
    }
  }

  /** Abandon the event, e.g. because the map it was running on has gone. */
  cancel(): void {
    this.stack = []
    this.suspended = false
    this.finished = true
  }

  private pendingBattle?: { won?: Command[]; lost?: Command[] }

  private finish(): Step {
    this.finished = true
    return { kind: 'done' }
  }

  /** A frame ran out: go round again if it is a loop, otherwise pop it. */
  private endOfFrame(frame: Frame): void {
    const loop = frame.loop
    if (loop?.kind === 'while' && this.state.testAll(loop.when)) {
      frame.index = 0
      return
    }
    if (loop?.kind === 'repeat' && loop.left > 1) {
      loop.left--
      frame.index = 0
      return
    }
    this.stack.pop()
  }

  /** Execute one command. Returns a request if it needs the outside world. */
  private run(command: Command): Request | undefined {
    if ('say' in command) return { kind: 'say', lines: command.say }
    if ('script' in command) return { kind: 'script', path: command.script }
    if ('warp' in command) return { kind: 'warp', target: command.warp }
    if ('face' in command) return { kind: 'face', facing: command.face }
    if ('walk' in command) return { kind: 'walk', steps: command.walk }

    if ('battle' in command) {
      // The branches are stashed rather than pushed, because which one runs
      // depends on a result that does not exist yet.
      this.pendingBattle = { won: command.won, lost: command.lost }
      return { kind: 'battle', path: command.battle }
    }

    if ('setFlag' in command) { this.state.setFlag(command.setFlag, command.to); return undefined }
    if ('setVar' in command) { this.state.setVariable(command.setVar, command.to); return undefined }
    if ('addVar' in command) { this.state.addVariable(command.addVar, command.by); return undefined }

    if ('wait' in command) { this.waitFrames = command.wait; return undefined }
    if ('stop' in command) { this.finished = true; this.stack = []; return undefined }

    if ('if' in command) {
      const branch = this.state.testAll(command.if) ? command.then : command.else
      if (branch && branch.length > 0) this.stack.push({ commands: branch, index: 0 })
      return undefined
    }

    if ('while' in command) {
      // Tested before the first pass, so a condition that never held runs the
      // body zero times rather than once.
      if (this.state.testAll(command.while) && command.do.length > 0) {
        this.stack.push({ commands: command.do, index: 0, loop: { kind: 'while', when: command.while } })
      }
      return undefined
    }

    if ('repeat' in command) {
      if (command.repeat > 0 && command.do.length > 0) {
        this.stack.push({ commands: command.do, index: 0, loop: { kind: 'repeat', left: command.repeat } })
      }
      return undefined
    }

    if ('break' in command) {
      // Unwind to and including the innermost loop. A break outside any loop
      // ends the event, which is the only reading that is not silently nothing.
      while (this.stack.length > 0) {
        const frame = this.stack.pop()!
        if (frame.loop) return undefined
      }
      this.finished = true
      return undefined
    }

    return undefined
  }
}
