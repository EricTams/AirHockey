import type { DialogueChoice, DialogueLine, DialogueScript } from '../modes/dialogue'

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
  // The choices are copied too, not shared: a snapshot that pointed at the
  // live array would be edited along with it, and undo would restore nothing.
  return {
    id: script.id,
    lines: script.lines.map((l) => ({
      ...l,
      ...(l.choices ? { choices: l.choices.map((c) => ({ ...c })) } : {}),
    })),
  }
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

  /**
   * Name the selected line, so other lines can jump to it.
   *
   * Renaming repoints every goto that named the old label. The alternative is
   * a script that fails to save with "no line is labelled x" and a designer
   * hunting for which option they broke by renaming something else.
   */
  setLabel(value: string): void {
    const line = this.line
    if (!line) return
    const was = line.label
    const now = value.trim()
    if (was === (now || undefined)) return
    if (now) line.label = now
    else delete line.label

    if (was) this.dropGoto(was, now)
  }

  /** Repoint every goto that named `label`, or drop it if there is no new name. */
  private dropGoto(label: string, now = ''): void {
    const retarget = (holder: { goto?: string }) => {
      if (holder.goto !== label) return
      if (now) holder.goto = now
      else delete holder.goto
    }
    for (const line of this.script.lines) {
      retarget(line)
      for (const choice of line.choices ?? []) retarget(choice)
    }
  }

  /** Where the conversation goes after the selected line. '' is the next one. */
  setGoto(value: string): void {
    const line = this.line
    if (!line) return
    if ((line.goto ?? '') === value) return
    this.snapshot('line target')
    if (value) line.goto = value
    else delete line.goto
  }

  /**
   * Add an option to the selected line.
   *
   * "Yes" and "No" rather than an empty option, because empty text fails
   * validation: a new option has to be a valid one, or the designer's next
   * save is refused by something they did not do on purpose.
   */
  addChoice(): void {
    const line = this.line
    if (!line) return
    this.snapshot('add option')
    const choices = line.choices ?? (line.choices = [])
    choices.push({ text: choices.length === 0 ? 'Yes' : choices.length === 1 ? 'No' : 'Option' })
  }

  /** Remove one. The last one takes `choices` with it, so the line is plain again. */
  removeChoice(index: number): void {
    const line = this.line
    if (!line?.choices?.[index]) return
    this.snapshot('delete option')
    line.choices.splice(index, 1)
    if (line.choices.length === 0) delete line.choices
  }

  moveChoice(index: number, delta: number): boolean {
    const choices = this.line?.choices
    const to = index + delta
    if (!choices || to < 0 || to >= choices.length) return false
    this.snapshot('reorder options')
    const [choice] = choices.splice(index, 1)
    choices.splice(to, 0, choice!)
    return true
  }

  /**
   * Edit one field of one option. Text and flag names are typed, so they are
   * not snapshotted — the same rule as the line fields above. A target picked
   * from a list is one deliberate act, and undo should have it.
   */
  setChoice(index: number, patch: Partial<DialogueChoice>): void {
    const choice = this.line?.choices?.[index]
    if (!choice) return
    if ('goto' in patch || 'to' in patch) this.snapshot('option target')
    if (patch.text !== undefined) choice.text = patch.text
    if ('goto' in patch) {
      if (patch.goto) choice.goto = patch.goto
      else delete choice.goto
    }
    if ('setFlag' in patch) {
      if (patch.setFlag) choice.setFlag = patch.setFlag
      else delete choice.setFlag
    }
    if (patch.to !== undefined) {
      // True is the default, so the file only carries the interesting case.
      if (patch.to) delete choice.to
      else choice.to = false
    }
  }

  /** Every label in the script bar the selected line's own — a jump to itself. */
  labels(): string[] {
    const own = this.line?.label
    return this.script.lines
      .map((l) => l.label)
      .filter((l): l is string => !!l && l !== own)
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
    // Without the copy the two lines would share one choices array and editing
    // either would edit both; without dropping the label the script would have
    // two lines by the same name, which fails validation on the next save.
    const copy: DialogueLine = { ...line }
    delete copy.label
    if (line.choices) copy.choices = line.choices.map((c) => ({ ...c }))
    this.script.lines.splice(index + 1, 0, copy)
    this.selected = index + 1
  }

  /**
   * Remove a line. Refuses to remove the last one: a script with no lines fails
   * validation, and would leave the player facing an NPC with nothing to say
   * and no way to close the box.
   */
  removeLine(index = this.selected): boolean {
    if (this.script.lines.length <= 1) return false
    const going = this.script.lines[index]
    if (!going) return false
    this.snapshot('delete line')
    this.script.lines.splice(index, 1)
    // Anything that jumped here now falls through to the next line instead.
    // Leaving the goto behind would make the script unsaveable, and the error
    // would name a label rather than the line the designer just deleted.
    if (going.label) this.dropGoto(going.label)
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
