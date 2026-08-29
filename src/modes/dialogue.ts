import * as THREE from 'three'
import type { Mode } from '../core/mode'
import type { Renderer } from '../core/renderer'
import type { Input } from '../core/input'
import type { Assets } from '../core/assets'
import { ScreenLayer } from '../ui/screen'
import { getFont } from '../ui/bitmapFont'
import { makeTextMesh } from '../ui/text'
import { screenRect } from '../core/screenScene'
import { VIRTUAL_W, VIRTUAL_H } from '../core/config'
import type { GameState } from '../world/gameState'
import type { BitmapFont } from '../ui/bitmapFont'

/**
 * Something the player can say back.
 *
 * The answer has to be able to outlive the box, or a choice is only a way of
 * choosing which sentence to read: `setFlag` is how the world hears it, and it
 * is the same flag an event page or an `if` command tests.
 */
export interface DialogueChoice {
  text: string
  /** Where the conversation goes. See `continuation`. */
  goto?: string
  /** A flag set when the player picks this. */
  setFlag?: string
  /** What that flag becomes. Absent means true. */
  to?: boolean
}

export interface DialogueLine {
  name?: string
  face?: string
  text: string
  /** A name that `goto` can aim at. Unique within the script. */
  label?: string
  /** Where the conversation goes after this line, instead of the next one. */
  goto?: string
  /** What the player can say back, offered once the line has finished typing. */
  choices?: DialogueChoice[]
}

export interface DialogueScript { id: string; lines: DialogueLine[] }

/**
 * The two `goto` destinations that are not lines.
 *
 * `end` finishes the conversation and lets whatever it was leading to happen:
 * the NPC's battle starts, the event that ran the script carries on. `stop`
 * calls the whole thing off — no battle, and a running event is cancelled.
 *
 * Both are needed because declining is not the same as agreeing quietly.
 * "First to three?" / "Not now." has to be able to mean no.
 */
export const END = 'end'
export const STOP = 'stop'
const RESERVED = [END, STOP]

export type Continuation =
  | { kind: 'line'; index: number }
  | { kind: 'end' }
  | { kind: 'stop' }

/**
 * Where the conversation goes after line `from`, following `goto` if it has
 * one. The only place the reserved destinations are interpreted, and pure, so
 * the branching is testable without a font or a screen.
 */
export function continuation(
  lines: readonly DialogueLine[], from: number, goto?: string,
): Continuation {
  if (goto === STOP) return { kind: 'stop' }
  if (goto === END) return { kind: 'end' }
  if (goto !== undefined) {
    const index = lines.findIndex((l) => l.label === goto)
    // `parseLines` refuses a goto with no matching label, so reaching this is a
    // script nothing validated. Ending is the answer that cannot strand the
    // player in a box with no way out.
    return index < 0 ? { kind: 'end' } : { kind: 'line', index }
  }
  const next = from + 1
  return next < lines.length ? { kind: 'line', index: next } : { kind: 'end' }
}

/**
 * Validate a dialogue file. Strict and loud, like `parseMap`: the editor writes
 * these, and a bad save must surface at load rather than as a silently empty
 * conversation that leaves the player stuck facing an NPC.
 */
export function parseDialogue(raw: unknown, path = 'dialogue'): DialogueScript {
  const d = raw as Partial<DialogueScript>
  if (!d || typeof d !== 'object') throw new Error(`${path}: not an object`)
  if (typeof d.id !== 'string' || !d.id) throw new Error(`${path}: missing "id"`)
  if (!Array.isArray(d.lines)) throw new Error(`${path}: missing "lines" as an array`)
  // An empty script would open a box the player cannot advance past: the mode
  // only leaves on `interact`, and with no line there is nothing to advance.
  if (d.lines.length === 0) throw new Error(`${path}: has no lines`)
  return { id: d.id, lines: parseLines(d.lines, path) }
}

/**
 * Validate a run of lines — a whole file, or an event's inline `say`, which is
 * the same shape and gets the same branching for free.
 *
 * Labels resolve within the run and nowhere else. A `goto` in a `say` block
 * reaches that block's own lines; there is no jumping between files, which
 * would need a loader here and would make a script's meaning depend on who
 * called it.
 */
export function parseLines(raw: unknown, path: string): DialogueLine[] {
  if (!Array.isArray(raw)) throw new Error(`${path}: must be an array of lines`)

  const labels = new Set<string>()
  raw.forEach((line: Partial<DialogueLine>, i) => {
    const at = `${path}: line[${i}]`
    if (!line || typeof line !== 'object') throw new Error(`${at}: not an object`)
    if (line.label === undefined) return
    if (typeof line.label !== 'string' || !line.label) throw new Error(`${at}: "label" must be a name`)
    if (RESERVED.includes(line.label)) {
      throw new Error(`${at}: "${line.label}" is a reserved goto and cannot be a label`)
    }
    if (labels.has(line.label)) throw new Error(`${at}: duplicate label "${line.label}"`)
    labels.add(line.label)
  })

  const target = (goto: unknown, at: string): void => {
    if (typeof goto !== 'string' || !goto) throw new Error(`${at}: "goto" must be a label`)
    if (!RESERVED.includes(goto) && !labels.has(goto)) {
      throw new Error(`${at}: "goto" names "${goto}", which no line is labelled`)
    }
  }

  raw.forEach((line: Partial<DialogueLine>, i) => {
    const at = `${path}: line[${i}]`
    if (typeof line.text !== 'string') throw new Error(`${at}: missing "text"`)
    if (line.name !== undefined && typeof line.name !== 'string') {
      throw new Error(`${at}: "name" must be a string`)
    }
    if (line.face !== undefined && typeof line.face !== 'string') {
      throw new Error(`${at}: "face" must be a string`)
    }
    if (line.goto !== undefined) target(line.goto, at)
    if (line.choices === undefined) return

    if (!Array.isArray(line.choices) || line.choices.length === 0) {
      throw new Error(`${at}: "choices" needs at least one option`)
    }
    line.choices.forEach((choice: Partial<DialogueChoice>, j) => {
      const where = `${at}: choices[${j}]`
      if (!choice || typeof choice !== 'object') throw new Error(`${where}: not an object`)
      // An option with no words is a row the player can highlight and pick
      // without ever knowing what they agreed to.
      if (typeof choice.text !== 'string' || !choice.text) throw new Error(`${where}: missing "text"`)
      if (choice.goto !== undefined) target(choice.goto, where)
      if (choice.setFlag !== undefined && (typeof choice.setFlag !== 'string' || !choice.setFlag)) {
        throw new Error(`${where}: "setFlag" must be a name`)
      }
      if (choice.to !== undefined && typeof choice.to !== 'boolean') {
        throw new Error(`${where}: "to" must be true or false`)
      }
    })
  })

  return raw as DialogueLine[]
}

export interface DialoguePayload {
  script: DialogueScript
  /** Where to go when the script ends, and what to hand it. */
  next: { mode: string; payload?: unknown }
}

/** Doc §7.2: one character per frame at 60Hz. */
const CPS_PER_FRAME = 1

const BOX_H = 170
const BOX_Y = VIRTUAL_H - BOX_H
const PAD = 13
const FACE = 144
const TEXT_X = PAD + FACE + 14
const TEXT_W = VIRTUAL_W - TEXT_X - PAD
/** Top of the first wrapped row, and the pitch between rows. */
const TEXT_TOP = BOX_Y + 44
const TEXT_ROW_H = 22

/**
 * Wrapped rows the box can show. A line longer than this is not truncated — it
 * draws past the bottom of the box — so the editor warns about it rather than
 * letting a designer discover it in play.
 */
export const MAX_TEXT_ROWS = Math.floor((VIRTUAL_H - PAD - TEXT_TOP) / TEXT_ROW_H)

/**
 * The choice panel sits above the box rather than inside it.
 *
 * Every one of the box's text rows belongs to the line that asked the question,
 * and a list of options that pushed the question off the top would be a strange
 * way to ask it. Above and to the right is also where the eye already is when
 * the line finishes typing.
 */
const CHOICE_ROW_H = 22
const CHOICE_PAD = 12
/** Between the panel and the top of the box. */
const CHOICE_GAP = 10
/** Room at the left of each row for the cursor. */
const CHOICE_CURSOR_W = 16

/** Options the panel can show before it runs off the top of the screen. */
export const MAX_CHOICE_ROWS =
  Math.floor((BOX_Y - CHOICE_GAP - PAD - CHOICE_PAD * 2) / CHOICE_ROW_H)

/** Wrap to the box's inner width. The font is monospace, so this is by count. */
export function wrapMono(text: string, cols: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= cols) line += ` ${word}`
      else { lines.push(line); line = word }
    }
    lines.push(line)
  }
  return lines
}

export class DialogueMode implements Mode {
  readonly name = 'dialogue'
  private screen = new ScreenLayer()
  private script: DialogueScript = { id: 'empty', lines: [] }
  private next: DialoguePayload['next'] = { mode: 'overworld' }
  private index = 0
  private revealed = 0
  /** Highlighted option, while a line with choices is showing one. */
  private choice = 0
  private wrapped: string[] = []
  private faceTex?: THREE.Texture
  private dirty = true

  constructor(
    private gfx: Renderer,
    private input: Input,
    private assets: Assets,
    /** Rendered underneath, frozen: doc §7.2 keeps the world visible behind the box. */
    private under: Mode,
    /** Where a picked choice's flag goes, which is how the world hears the answer. */
    private state: GameState,
  ) {}

  enter(payload?: unknown): void {
    const p = payload as DialoguePayload | undefined
    this.script = p?.script ?? { id: 'empty', lines: [] }
    this.next = p?.next ?? { mode: 'overworld' }
    this.index = 0
    void this.loadLine()
  }

  exit(): void {
    this.screen.clear()
  }

  private get line(): DialogueLine | undefined { return this.script.lines[this.index] }

  private async loadLine(): Promise<void> {
    const line = this.line
    this.revealed = 0
    this.choice = 0
    this.dirty = true
    if (!line) return
    const cols = Math.floor(TEXT_W / getFont().glyphW)
    this.wrapped = wrapMono(line.text, cols)
    this.faceTex = line.face
      ? await this.assets.texture(line.face, { label: 'FACE', kind: 'face', width: FACE, height: FACE })
      : undefined
    this.dirty = true
  }

  /** Columns of text the box fits, which depends on the runtime-built font. */
  static columns(): number {
    return Math.floor(TEXT_W / getFont().glyphW)
  }

  /**
   * Show one line of a script fully revealed, for the editor's preview.
   *
   * Not `enter`: this leaves `next` alone and skips the typewriter, because
   * what a designer authoring text needs to see is the finished box — whether
   * the name fits, whether the face is the right one, and above all whether the
   * text has run off the bottom.
   */
  async previewLine(script: DialogueScript, index: number): Promise<{ rows: number }> {
    this.script = script
    this.index = index
    await this.loadLine()
    this.revealed = this.fullLength
    this.rebuild()
    return { rows: this.wrapped.length }
  }

  private get fullLength(): number {
    return this.wrapped.reduce((n, l) => n + l.length, 0)
  }

  update(_dt: number): void {
    // Nothing to say: leave rather than sit here invisibly. A mode whose only
    // exit is "advance past the last line" has no exit at all when there are
    // no lines, and `rebuild` never runs, so there is not even a box on screen
    // to explain why the world has stopped responding. `parseDialogue` refuses
    // an empty script from a file; this covers being entered without one.
    if (!this.line) { this.gfxSwitch(); return }

    const complete = this.revealed >= this.fullLength
    // Options appear only once the line has finished typing: until then the
    // player has not read the question they are being asked to answer.
    const choices = complete ? this.choices : undefined
    if (choices) this.moveCursor(choices.length)

    if (this.input.pressed('interact')) {
      if (!complete) {
        this.revealed = this.fullLength      // doc §7.2: skip to full line
        this.dirty = true
      } else if (choices) {
        const picked = choices[this.choice]!
        if (picked.setFlag) this.state.setFlag(picked.setFlag, picked.to ?? true)
        if (this.go(continuation(this.script.lines, this.index, picked.goto))) return
      } else if (this.go(continuation(this.script.lines, this.index, this.line.goto))) {
        return
      }
    } else if (!complete) {
      this.revealed += CPS_PER_FRAME
      this.dirty = true
    }

    if (this.dirty) this.rebuild()
  }

  private get choices(): DialogueChoice[] | undefined {
    const choices = this.line?.choices
    return choices && choices.length > 0 ? choices : undefined
  }

  /** Up and down move the highlight, wrapping, while options are showing. */
  private moveCursor(count: number): void {
    const delta = this.input.pressed('up') ? -1 : this.input.pressed('down') ? 1 : 0
    if (delta === 0) return
    this.choice = (this.choice + delta + count) % count
    this.dirty = true
  }

  /**
   * Follow a continuation. True when the mode is leaving, so the caller stops.
   *
   * Doc §7.3 hands off to the battle when a script ends; a `stop` is the player
   * declining it, so it goes to the world instead and says why. An event that
   * was running the script is owed that answer too — resuming it would start
   * the battle the player just turned down.
   */
  private go(next: Continuation): boolean {
    if (next.kind === 'line') {
      this.index = next.index
      void this.loadLine()
      return false
    }
    if (next.kind === 'stop') this.onSwitch?.('overworld', { dialogueStopped: true })
    else this.gfxSwitch()
    return true
  }

  private onSwitch?: (mode: string, payload?: unknown) => void
  /** Injected by main so the mode can request its own exit transition. */
  bindSwitch(fn: (mode: string, payload?: unknown) => void): void { this.onSwitch = fn }
  private gfxSwitch(): void { this.onSwitch?.(this.next.mode, this.next.payload) }

  private rebuild(): void {
    this.dirty = false
    const font = getFont()
    const objects: THREE.Object3D[] = [
      screenRect(0, BOX_Y, VIRTUAL_W, BOX_H, 0x101826),
      screenRect(0, BOX_Y, VIRTUAL_W, 2, 0x6f86ad),
      screenRect(0, VIRTUAL_H - 2, VIRTUAL_W, 2, 0x6f86ad),
    ]

    if (this.faceTex) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(FACE, FACE),
        new THREE.MeshBasicMaterial({ map: this.faceTex, transparent: true, depthTest: false }),
      )
      mesh.position.set(PAD + FACE / 2, VIRTUAL_H - (BOX_Y + PAD + FACE / 2), 0)
      mesh.frustumCulled = false
      objects.push(mesh)
    }

    const line = this.line
    if (line?.name) objects.push(makeTextMesh(font, line.name, TEXT_X, BOX_Y + 14, 0xffd76b))

    // Reveal across wrapped lines, so a mid-word break still types through.
    let left = this.revealed
    this.wrapped.forEach((text, i) => {
      const shown = text.slice(0, Math.max(0, Math.min(text.length, left)))
      left -= text.length
      if (shown) objects.push(makeTextMesh(font, shown, TEXT_X, TEXT_TOP + i * TEXT_ROW_H, 0xe8eefb))
    })

    const choices = this.revealed >= this.fullLength ? this.choices : undefined
    if (choices) objects.push(...this.choicePanel(choices, font))
    // The advance marker means "press to carry on", which is not what a press
    // does while there is something to answer.
    else if (this.revealed >= this.fullLength) {
      objects.push(screenRect(VIRTUAL_W - 26, VIRTUAL_H - 22, 10, 6, 0x6f86ad))
    }
    this.screen.set(objects)
  }

  /** The options, right-aligned in their own panel above the box. */
  private choicePanel(choices: readonly DialogueChoice[], font: BitmapFont): THREE.Object3D[] {
    const widest = choices.reduce((n, c) => Math.max(n, c.text.length), 0)
    const w = CHOICE_PAD * 2 + CHOICE_CURSOR_W + widest * font.glyphW
    const h = CHOICE_PAD * 2 + choices.length * CHOICE_ROW_H
    // Clamped rather than trusted: a script can ask for more options than fit,
    // and a panel drawn off the top of the screen is not a legible complaint.
    const x = Math.max(PAD, VIRTUAL_W - PAD - w)
    const y = Math.max(PAD, BOX_Y - CHOICE_GAP - h)

    const objects: THREE.Object3D[] = [
      screenRect(x - 2, y - 2, w + 4, h + 4, 0x6f86ad),
      screenRect(x, y, w, h, 0x101826),
    ]
    choices.forEach((choice, i) => {
      const rowY = y + CHOICE_PAD + i * CHOICE_ROW_H
      const on = i === this.choice
      if (on) objects.push(screenRect(x + CHOICE_PAD, rowY + 5, 8, 8, 0xffd76b))
      objects.push(makeTextMesh(
        font, choice.text, x + CHOICE_PAD + CHOICE_CURSOR_W, rowY, on ? 0xffd76b : 0x8fa2c4,
      ))
    })
    return objects
  }

  render(): void {
    this.under.render()
    this.screen.render(this.gfx.gl)
  }
}
