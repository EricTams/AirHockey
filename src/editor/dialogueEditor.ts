import type { EditorServer } from './server'
import type { ModeManager } from '../core/mode'
import {
  parseDialogue, END, MAX_CHOICE_ROWS, MAX_TEXT_ROWS, STOP,
  type DialogueMode, type DialogueScript,
} from '../modes/dialogue'
import type { GameMap } from '../world/map'
import { DialogueDoc, blankDialogue } from './dialogueDoc'
import { serializeDialogue } from './dialogueFile'
import { checkbox, el } from './dom'

/**
 * The dialogue editor: a list of lines, fields for the selected one, and a live
 * preview through the game's own box.
 *
 * The preview is the point. Dialogue is the one kind of content whose problems
 * are invisible in the data — a name that overruns, a portrait that is not the
 * one you meant, a line that wraps past the bottom of the box — and all of them
 * are obvious the moment you see it drawn. So it draws through `DialogueMode`
 * itself rather than a mock-up of it: a mock-up would drift, and the drift
 * would be exactly in the details being checked.
 */

const DIALOGUE_DIR = 'data/dialogue/'

export interface DialogueHost {
  server: EditorServer
  modes: ModeManager
  dialogue: DialogueMode
  /** For finding scripts the map already refers to. */
  currentMap(): GameMap
  /** Told when something is saved or goes wrong, for the shared status bar. */
  message(text: string, tone: 'ok' | 'err'): void
  /** Told when dirtiness changes, so the shared chrome can follow. */
  onDirtyChange(): void
}

export class DialogueEditor {
  readonly root = el('div', { class: 'ed-pane' })

  private doc?: DialogueDoc
  private saving = false
  /** Bumped per preview request so a slow face load cannot overwrite a newer one. */
  private previewToken = 0

  private ui!: {
    picker: HTMLSelectElement
    newRow: HTMLElement
    newId: HTMLInputElement
    list: HTMLElement
    name: HTMLInputElement
    face: HTMLInputElement
    faces: HTMLDataListElement
    text: HTMLTextAreaElement
    label: HTMLInputElement
    lineGoto: HTMLElement
    choices: HTMLElement
    addChoice: HTMLButtonElement
    warn: HTMLElement
    undo: HTMLButtonElement
    redo: HTMLButtonElement
    save: HTMLButtonElement
    del: HTMLButtonElement
    up: HTMLButtonElement
    down: HTMLButtonElement
  }

  constructor(private host: DialogueHost) {
    this.build()
  }

  get dirty(): boolean { return this.doc?.dirty ?? false }
  get path(): string | undefined { return this.doc?.path }

  // --- Session -------------------------------------------------------------

  /**
   * Called when the dialogue tab is opened, optionally on a named script — the
   * jump the entity and event inspectors make from the thing that speaks it,
   * which otherwise means opening this tab and finding the script by name.
   */
  async activate(path?: string): Promise<void> {
    if (path && path !== this.doc?.path) { await this.load(path); return }
    await this.refreshPicker()
    if (!this.doc) {
      const first = this.ui.picker.value
      if (first) await this.load(first)
      else this.showPreview()
    } else {
      this.showPreview()
    }
  }

  /** Called when the tab is left. The caller restores the overworld render. */
  deactivate(): void {
    this.previewToken++
  }

  // --- Files ---------------------------------------------------------------

  /**
   * Offer every script this designer could plausibly want: the ones the map's
   * NPCs point at, plus anything already in their content folder. There is no
   * way to list the site's own files, so a script that is neither referenced
   * nor edited stays reachable only by making it.
   */
  private async refreshPicker(): Promise<void> {
    const referenced = this.host.currentMap().npcs
      .map((n) => n.dialogue)
      .filter((p): p is string => !!p)
    const edited = [...(this.host.server.editedPaths ?? [])]
      .filter((p) => p.startsWith(DIALOGUE_DIR) && p.endsWith('.json'))
    // The open script is always offered, even when nothing on this map points
    // at it: an event's `script` command can name one no NPC refers to, and
    // being jumped to a script the picker then reads blank for is worse than
    // not jumping.
    const open = this.doc ? [this.doc.path] : []
    const paths = [...new Set([...referenced, ...edited, ...open])].sort()

    const keep = this.doc?.path ?? this.ui.picker.value
    this.ui.picker.replaceChildren(...paths.map((p) =>
      el('option', { value: p }, p.replace(DIALOGUE_DIR, '').replace(/\.json$/, ''))))
    if (paths.includes(keep)) this.ui.picker.value = keep

    // Portraits already in use, so the face field can offer them.
    const faces = new Set<string>()
    for (const line of this.doc?.lines ?? []) if (line.face) faces.add(line.face)
    this.ui.faces.replaceChildren(...[...faces].sort().map((f) => el('option', { value: f })))
  }

  private async load(path: string): Promise<void> {
    try {
      const raw = await this.host.server.readJson<unknown>(path)
      this.doc = new DialogueDoc(path, parseDialogue(raw, path))
      await this.refreshPicker()
      this.renderAll()
      this.showPreview()
    } catch (err) {
      this.host.message(`Could not open ${path}: ${(err as Error).message}`, 'err')
    }
  }

  private async createScript(id: string): Promise<void> {
    const clean = id.trim().replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
    if (!clean) { this.host.message('A script needs a name', 'err'); return }
    const path = `${DIALOGUE_DIR}${clean}.json`
    this.doc = new DialogueDoc(path, blankDialogue(clean))
    this.ui.newRow.hidden = true
    this.ui.newId.value = ''
    // Written straight away, so it exists to be picked and to be zipped up.
    await this.save()
    await this.refreshPicker()
    this.ui.picker.value = path
    this.renderAll()
    this.showPreview()
  }

  async save(): Promise<void> {
    const doc = this.doc
    if (!doc || this.saving) return
    this.saving = true
    this.syncButtons()
    try {
      const text = serializeDialogue(doc.value)
      // Validate what is about to be written: this is the last point a bad save
      // can be caught before it becomes a file the game refuses to load.
      parseDialogue(JSON.parse(text), doc.path)
      await this.host.server.write(doc.path, text, 'application/json')
      doc.markSaved()
      this.host.message(`Saved ${doc.path}`, 'ok')
    } catch (err) {
      this.host.message(`Could not save: ${(err as Error).message}`, 'err')
    } finally {
      this.saving = false
      this.syncButtons()
      this.host.onDirtyChange()
    }
  }

  // --- Preview -------------------------------------------------------------

  private showPreview(): void {
    const doc = this.doc
    const token = ++this.previewToken
    if (!doc || doc.lines.length === 0) return

    // The mode renders the frozen overworld underneath, so switching to it is
    // what puts the box on screen; nothing ticks while the editor is open.
    this.host.modes.switchNow('dialogue', { script: doc.value, next: { mode: 'overworld' } })
    void this.host.dialogue.previewLine(doc.value, doc.selected).then(({ rows }) => {
      if (token !== this.previewToken) return
      const notes: string[] = []
      if (rows > MAX_TEXT_ROWS) {
        notes.push(`This line wraps to ${rows} rows; the box shows ${MAX_TEXT_ROWS}. ` +
          'The rest draws off the bottom.')
      }
      const options = doc.line?.choices?.length ?? 0
      if (options > MAX_CHOICE_ROWS) {
        notes.push(`${options} options is more than the ${MAX_CHOICE_ROWS} the panel ` +
          'can show above the box.')
      }
      this.ui.warn.hidden = notes.length === 0
      this.ui.warn.textContent = notes.join(' ')
    })
  }

  // --- DOM -----------------------------------------------------------------

  private build(): void {
    const picker = el('select', { class: 'ed-select' })
    picker.onchange = () => { void this.load(picker.value) }

    const newBtn = el('button', { class: 'ed-icon', type: 'button', title: 'New script' }, '+')
    const newId = el('input', { class: 'ed-input2', type: 'text', placeholder: 'script name' })
    const createBtn = el('button', { class: 'ed-icon', type: 'button' }, 'Create')
    createBtn.onclick = () => { void this.createScript(newId.value) }
    newId.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.createScript(newId.value) }
      if (e.key === 'Escape') newRow.hidden = true
    }
    const newRow = el('div', { class: 'ed-row2' }, newId, createBtn)
    newRow.hidden = true
    newBtn.onclick = () => {
      newRow.hidden = !newRow.hidden
      if (!newRow.hidden) newId.focus()
    }

    const list = el('div', { class: 'ed-lines' })

    const add = el('button', { class: 'ed-icon', type: 'button', title: 'Add line' }, '+ Line')
    add.onclick = () => { this.doc?.addLine(); this.afterStructural() }
    const dup = el('button', { class: 'ed-icon', type: 'button', title: 'Duplicate' }, '⧉')
    dup.onclick = () => { this.doc?.duplicateLine(); this.afterStructural() }
    const del = el('button', { class: 'ed-icon', type: 'button', title: 'Delete line' }, '✕')
    del.onclick = () => {
      if (this.doc && !this.doc.removeLine()) {
        this.host.message('A script needs at least one line', 'err')
        return
      }
      this.afterStructural()
    }
    const up = el('button', { class: 'ed-icon', type: 'button', title: 'Move up' }, '↑')
    up.onclick = () => { this.doc?.moveLine(this.doc.selected, -1); this.afterStructural() }
    const down = el('button', { class: 'ed-icon', type: 'button', title: 'Move down' }, '↓')
    down.onclick = () => { this.doc?.moveLine(this.doc.selected, 1); this.afterStructural() }

    const name = el('input', { class: 'ed-input2', type: 'text', placeholder: 'Speaker' })
    const faces = el('datalist', { id: 'ed-faces' })
    const face = el('input', {
      class: 'ed-input2', type: 'text', placeholder: 'assets/faces/…png', list: 'ed-faces',
    })
    const text = el('textarea', { class: 'ed-textarea', rows: '4', placeholder: 'What they say' })
    for (const [field, input] of [['name', name], ['face', face], ['text', text]] as const) {
      input.oninput = () => {
        this.doc?.setField(field, input.value)
        this.renderList()
        this.showPreview()
        this.syncButtons()
        this.host.onDirtyChange()
        if (field === 'face') void this.refreshPicker()
      }
    }

    const label = el('input', { class: 'ed-input2', type: 'text', placeholder: 'a name to jump to' })
    label.oninput = () => {
      this.doc?.setLabel(label.value)
      // Every goto list in the pane names this label, so they all change.
      this.renderChoices()
      this.renderLineGoto()
      this.syncButtons()
      this.host.onDirtyChange()
    }
    const lineGoto = el('div')

    const choices = el('div')
    const addChoice = el('button', { class: 'ed-second', type: 'button' }, '+ Option')
    addChoice.onclick = () => {
      addChoice.blur()
      this.doc?.addChoice()
      this.afterStructural()
    }

    const warn = el('div', { class: 'ed-warn' })
    warn.hidden = true

    const undo = el('button', { class: 'ed-icon', type: 'button', title: 'Undo' }, '↶')
    undo.onclick = () => { this.doc?.undo(); this.afterStructural() }
    const redo = el('button', { class: 'ed-icon', type: 'button', title: 'Redo' }, '↷')
    redo.onclick = () => { this.doc?.redo(); this.afterStructural() }
    const save = el('button', { class: 'ed-save', type: 'button' }, 'Save')
    save.onclick = () => { save.blur(); void this.save() }

    this.root.append(
      el('div', { class: 'ed-sec' },
        el('label', {}, 'Script'),
        el('div', { class: 'ed-row2' }, picker, newBtn),
        newRow),
      list,
      el('div', { class: 'ed-sec' },
        el('div', { class: 'ed-seg' }, add, dup, del, up, down)),
      el('div', { class: 'ed-sec ed-fields' },
        el('label', {}, 'Speaker'), name,
        el('label', {}, 'Portrait'), face, faces,
        el('label', {}, 'Text'), text,
        warn,
        el('label', {}, 'Label'), label,
        el('div', { class: 'ed-hint' }, 'A name this line can be jumped to by.'),
        el('label', {}, 'Then go to'), lineGoto),
      el('div', { class: 'ed-sec' },
        el('label', {}, 'What the player can say back'),
        choices,
        el('div', { class: 'ed-row2' }, addChoice),
        el('div', { class: 'ed-hint' },
          'Options are offered once the line has finished typing. Ending the ' +
          'conversation still starts the battle the NPC was going to play; ' +
          'calling it off does not.')),
      el('div', { class: 'ed-foot2' }, undo, redo, save),
    )

    this.ui = {
      picker, newRow, newId, list, name, face, faces, text, label, lineGoto,
      choices, addChoice, warn, undo, redo, save, del, up, down,
    }
  }

  /** Redraw after anything that changed the shape of the script. */
  private afterStructural(): void {
    this.renderAll()
    this.showPreview()
    this.host.onDirtyChange()
  }

  private renderAll(): void {
    this.renderList()
    this.renderFields()
    this.syncButtons()
  }

  private renderList(): void {
    const doc = this.doc
    if (!doc) { this.ui.list.replaceChildren(); return }
    this.ui.list.replaceChildren(...doc.lines.map((line, i) => {
      const row = el('div', {
        class: 'ed-line', 'aria-selected': String(i === doc.selected), role: 'button',
      },
        el('span', { class: 'ed-lineno' }, String(i + 1)),
        el('span', { class: 'ed-linewho' }, line.name ?? '—'),
        el('span', { class: 'ed-linetext' }, line.text || '(empty)'))
      row.onclick = () => {
        doc.select(i)
        this.renderAll()
        this.showPreview()
      }
      return row
    }))
    this.ui.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  private renderFields(): void {
    const line = this.doc?.line
    this.ui.name.value = line?.name ?? ''
    this.ui.face.value = line?.face ?? ''
    this.ui.text.value = line?.text ?? ''
    this.ui.label.value = line?.label ?? ''
    const has = line !== undefined
    this.ui.name.disabled = !has
    this.ui.face.disabled = !has
    this.ui.text.disabled = !has
    this.ui.label.disabled = !has
    this.ui.addChoice.disabled = !has
    this.renderLineGoto()
    this.renderChoices()
  }

  private renderLineGoto(): void {
    const line = this.doc?.line
    this.ui.lineGoto.replaceChildren(this.gotoField(line?.goto, (v) => {
      this.doc?.setGoto(v)
      this.afterStructural()
    }, !line))
  }

  /**
   * One block per option: what the player says, where it goes, and the flag it
   * leaves behind. All three inline rather than behind a selected-option
   * inspector — there are two or three of them, and a conversation is read by
   * seeing the answers side by side.
   */
  private renderChoices(): void {
    const doc = this.doc
    const line = doc?.line
    const choices = line?.choices ?? []
    this.ui.choices.replaceChildren(...choices.map((choice, i) => {
      const head = el('div', { class: 'ed-choice-head' }, el('span', {}, `Option ${i + 1}`))
      const up = el('button', { class: 'ed-icon ed-tiny', type: 'button', title: 'Move up' }, '↑')
      up.disabled = i === 0
      up.onclick = () => { doc?.moveChoice(i, -1); this.afterStructural() }
      const down = el('button', { class: 'ed-icon ed-tiny', type: 'button', title: 'Move down' }, '↓')
      down.disabled = i === choices.length - 1
      down.onclick = () => { doc?.moveChoice(i, 1); this.afterStructural() }
      const del = el('button', { class: 'ed-icon ed-tiny', type: 'button', title: 'Delete' }, '✕')
      del.onclick = () => { doc?.removeChoice(i); this.afterStructural() }
      head.append(up, down, del)

      const text = el('input', {
        class: 'ed-input2', type: 'text', placeholder: 'what the player says',
      })
      text.value = choice.text
      // Typed fields redraw the preview but not this list: replacing the rows
      // under a field being typed into takes the focus and the caret with it.
      text.oninput = () => { doc?.setChoice(i, { text: text.value }); this.afterTyping() }

      const flag = el('input', {
        class: 'ed-input2', type: 'text', placeholder: 'remember it as a flag (optional)',
      })
      flag.value = choice.setFlag ?? ''
      flag.oninput = () => {
        doc?.setChoice(i, { setFlag: flag.value.trim() })
        this.afterTyping()
        to.row.hidden = !flag.value.trim()
      }

      const to = checkbox('sets it true', choice.to ?? true, (on) => {
        doc?.setChoice(i, { to: on })
        this.afterStructural()
      })
      to.row.hidden = !choice.setFlag

      return el('div', { class: 'ed-choice' },
        head,
        text,
        el('div', { class: 'ed-row2' },
          this.gotoField(choice.goto, (v) => {
            doc?.setChoice(i, { goto: v })
            this.afterStructural()
          }, false)),
        el('div', { class: 'ed-row2' }, flag),
        to.row)
    }))
  }

  /**
   * Where a jump can go: on to the next line, out of the conversation one of
   * two ways, or to a labelled line. Named in the designer's terms rather than
   * the file's — `end` and `stop` are two words apart in JSON and a battle
   * apart in play.
   */
  private gotoField(
    current: string | undefined, onChange: (value: string) => void, disabled: boolean,
  ): HTMLSelectElement {
    const select = el('select', { class: 'ed-select' })
    const options = [
      el('option', { value: '' }, 'the next line'),
      el('option', { value: END }, 'end the conversation'),
      el('option', { value: STOP }, 'call it off — no battle'),
      ...(this.doc?.labels() ?? []).map((l) => el('option', { value: l }, `the line "${l}"`)),
    ]
    // A jump whose label has gone reads as what it is. Showing it as "the next
    // line" would be the pane disagreeing with the file it is editing.
    if (current && !options.some((o) => o.value === current)) {
      options.push(el('option', { value: current }, `"${current}" — no such line`))
    }
    select.replaceChildren(...options)
    select.value = current ?? ''
    select.disabled = disabled
    select.onchange = () => onChange(select.value)
    return select
  }

  /** A typed edit: the preview and the chrome follow, the fields are left alone. */
  private afterTyping(): void {
    this.showPreview()
    this.syncButtons()
    this.host.onDirtyChange()
  }

  private syncButtons(): void {
    const doc = this.doc
    this.ui.undo.disabled = !doc?.canUndo
    this.ui.redo.disabled = !doc?.canRedo
    this.ui.save.disabled = this.saving || !doc?.dirty
    this.ui.save.textContent = this.saving ? 'Saving…' : doc?.dirty ? 'Save' : 'Saved'
    this.ui.del.disabled = !doc || doc.lines.length <= 1
    this.ui.up.disabled = !doc || doc.selected === 0
    this.ui.down.disabled = !doc || doc.selected >= doc.lines.length - 1
  }
}

export type { DialogueScript }
