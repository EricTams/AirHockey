import type { DialogueLine, DialogueScript } from '../modes/dialogue'

/**
 * A dialogue script being edited, with undo.
 *
 * Undo here is a stack of whole-script snapshots rather than the per-cell edits
 * MapDoc records. A script is a handful of short strings, so a copy costs
 * nothing, and the operations are structural — moving a line, deleting one —
 * which a per-field diff would model badly.
 *
 * Text typed into a field is not snapshotted per keystroke: the field's own
 * undo handles that, and snapshotting it would bury the structural edits under
 * hundreds of one-character steps.
 */

export interface DialogueSnapshot {
  label: string
  script: DialogueScript
}

const MAX_UNDO = 100

function clone(script: DialogueScript): DialogueScript {
  return { id: script.id, lines: script.lines.map((l) => ({ ...l })) }
}

export class DialogueDoc {
  private undoStack: DialogueSnapshot[] = []
  private redoStack: DialogueSnapshot[] = []
  private savedScript: string

  /** Index of the line being edited, clamped to the script. */
  selected = 0

  constructor(readonly path: string, private script: DialogueScript) {
    this.savedScript = JSON.stringify(script)
  }

  get value(): DialogueScript { return this.script }
  get lines(): readonly DialogueLine[] { return this.script.lines }
  get id(): string { return this.script.id }
  get dirty(): boolean { return JSON.stringify(this.script) !== this.savedScript }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  markSaved(): void { this.savedScript = JSON.stringify(this.script) }

  get line(): DialogueLine | undefined { return this.script.lines[this.selected] }

  select(index: number): void {
    this.selected = Math.max(0, Math.min(index, this.script.lines.length - 1))
  }

  private snapshot(label: string): void {
    this.undoStack.push({ label, script: clone(this.script) })
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
  }

  setId(id: string): void {
    if (id === this.script.id) return
    this.snapshot('rename')
    this.script.id = id
  }

  /**
   * Update a field of the selected line. Not snapshotted — see the note above.
   * An empty name or face is dropped rather than written as "", because the
   * format treats both as optional and the renderer keys off their absence.
   */
  setField(field: 'name' | 'face' | 'text', value: string): void {
    const line = this.line
    if (!line) return
    if (field === 'text') {
      line.text = value
      return
    }
    if (value) line[field] = value
    else delete line[field]
  }

  /** Insert a line after the selection and select it. */
  addLine(after = this.selected): number {
    this.snapshot('add line')
    const previous = this.script.lines[after]
    // Carry the speaker forward: consecutive lines are usually the same person,
    // and retyping the name and face for every one is the tedious part.
    const line: DialogueLine = { text: '' }
    if (previous?.name) line.name = previous.name
    if (previous?.face) line.face = previous.face
    const at = Math.min(after + 1, this.script.lines.length)
    this.script.lines.splice(at, 0, line)
    this.selected = at
    return at
  }

  duplicateLine(index = this.selected): void {
    const line = this.script.lines[index]
    if (!line) return
    this.snapshot('duplicate line')
    this.script.lines.splice(index + 1, 0, { ...line })
    this.selected = index + 1
  }

  /**
   * Remove a line. Refuses to remove the last one: a script with no lines fails
   * validation, and would leave the player facing an NPC with nothing to say
   * and no way to close the box.
   */
  removeLine(index = this.selected): boolean {
    if (this.script.lines.length <= 1) return false
    if (!this.script.lines[index]) return false
    this.snapshot('delete line')
    this.script.lines.splice(index, 1)
    this.select(Math.min(index, this.script.lines.length - 1))
    return true
  }

  moveLine(index: number, delta: number): boolean {
    const to = index + delta
    if (to < 0 || to >= this.script.lines.length) return false
    this.snapshot('reorder')
    const [line] = this.script.lines.splice(index, 1)
    this.script.lines.splice(to, 0, line!)
    this.selected = to
    return true
  }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.redoStack.push({ label: previous.label, script: clone(this.script) })
    this.script = previous.script
    this.select(this.selected)
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push({ label: next.label, script: clone(this.script) })
    this.script = next.script
    this.select(this.selected)
    return true
  }
}

/** A new script with one empty line, which is the smallest valid one. */
export function blankDialogue(id: string): DialogueScript {
  return { id, lines: [{ text: '' }] }
}
