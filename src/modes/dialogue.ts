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

export interface DialogueLine { name?: string; face?: string; text: string }
export interface DialogueScript { id: string; lines: DialogueLine[] }

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
  d.lines.forEach((line, i) => {
    const at = `${path}: line[${i}]`
    if (!line || typeof line !== 'object') throw new Error(`${at}: not an object`)
    if (typeof line.text !== 'string') throw new Error(`${at}: missing "text"`)
    if (line.name !== undefined && typeof line.name !== 'string') {
      throw new Error(`${at}: "name" must be a string`)
    }
    if (line.face !== undefined && typeof line.face !== 'string') {
      throw new Error(`${at}: "face" must be a string`)
    }
  })
  // An empty script would open a box the player cannot advance past: the mode
  // only leaves on `interact`, and with no line there is nothing to advance.
  if (d.lines.length === 0) throw new Error(`${path}: has no lines`)
  return d as DialogueScript
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
  private wrapped: string[] = []
  private faceTex?: THREE.Texture
  private dirty = true

  constructor(
    private gfx: Renderer,
    private input: Input,
    private assets: Assets,
    /** Rendered underneath, frozen: doc §7.2 keeps the world visible behind the box. */
    private under: Mode,
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
    if (this.input.pressed('interact')) {
      if (!complete) {
        this.revealed = this.fullLength      // doc §7.2: skip to full line
        this.dirty = true
      } else {
        this.index++
        if (!this.line) {
          // Script finished. Doc §7.3: hand off to the battle if there is one.
          this.gfxSwitch()
          return
        }
        void this.loadLine()
      }
    } else if (!complete) {
      this.revealed += CPS_PER_FRAME
      this.dirty = true
    }

    if (this.dirty) this.rebuild()
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

    if (this.revealed >= this.fullLength) {
      objects.push(screenRect(VIRTUAL_W - 26, VIRTUAL_H - 22, 10, 6, 0x6f86ad))
    }
    this.screen.set(objects)
  }

  render(): void {
    this.under.render()
    this.screen.render(this.gfx.gl)
  }
}
