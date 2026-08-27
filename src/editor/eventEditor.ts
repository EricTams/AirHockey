import type { EditorServer } from './server'
import type { GameMap } from '../world/map'
import type { GameState } from '../world/gameState'
import type { Facing } from '../world/character'
import {
  blankPage, TRIGGERS,
  type Command, type Condition, type EventPage, type MapEvent, type Trigger,
} from '../world/event'
import type { MapDoc, Touched } from './mapDoc'
import type { Cell } from './tools'
import {
  flatten, insertAfter, removeAt, moveAt, commandAt, describe, problems,
  COMMAND_KINDS, type Path, type Row,
} from './commandList'
import { el, checkbox } from './dom'

/**
 * Authoring events: the list on the map, the pages of the selected one, and the
 * command list of the selected page.
 *
 * Everything is edited in place on the map document, through `editMap`, so
 * events undo alongside tiles and NPCs in the order the designer did them.
 * The tree work — paths, inserts, reordering — lives in commandList.ts and is
 * tested there; this file is the chrome around it.
 *
 * The flags-and-variables panel at the bottom is not a debug extra. Events are
 * gated on state, state is not persisted, and without a way to set a flag by
 * hand every test of a second page means walking the whole world again.
 */

const FACINGS: Facing[] = ['down', 'up', 'left', 'right']
const OPS = ['=', '!=', '<', '<=', '>', '>='] as const

export interface EventHost {
  server: EditorServer
  doc(): MapDoc
  state: GameState
  applyTouched(touched: Touched): void
  /** Show where the events are, and which one is selected. */
  paintMarks(marks: Cell[], selected: Cell | undefined): void
  message(text: string, tone: 'ok' | 'err'): void
}

export class EventEditor {
  readonly root = el('div', { class: 'ed-pane' })

  private selected?: string
  private page = 0
  private selectedPath?: Path
  private placing = false
  private dragging = false

  private ui!: {
    list: HTMLElement
    add: HTMLButtonElement
    del: HTMLButtonElement
    hint: HTMLElement
    pageRow: HTMLElement
    pageBody: HTMLElement
    commands: HTMLElement
    inspector: HTMLElement
    stateBody: HTMLElement
  }

  constructor(private host: EventHost) {
    this.build()
  }

  // --- Session -------------------------------------------------------------

  activate(): void { this.refresh() }

  deactivate(): void {
    this.placing = false
    this.dragging = false
    this.host.paintMarks([], undefined)
  }

  refresh(): void {
    const map = this.host.doc().map
    if (this.selected && !this.find(map)) this.selected = undefined
    this.renderAll()
  }

  // --- Canvas --------------------------------------------------------------

  pointerDown(cell: Cell): void {
    const doc = this.host.doc()
    if (this.placing) {
      this.placing = false
      const id = uniqueId(doc.map.events.map((e) => e.id), 'event')
      const touched = doc.editMap('place event', (map) => {
        map.events.push({ id, x: cell.x, y: cell.y, pages: [blankPage()] })
      })
      this.selected = id
      this.page = 0
      this.selectedPath = undefined
      this.after(touched)
      return
    }
    const hit = doc.map.events.find((e) => e.x === cell.x && e.y === cell.y)
    this.selected = hit?.id
    this.page = 0
    this.selectedPath = undefined
    this.dragging = hit !== undefined
    this.renderAll()
  }

  pointerDrag(cell: Cell): void {
    if (!this.dragging || !this.selected) return
    const doc = this.host.doc()
    const current = this.find(doc.map)
    if (!current || (current.x === cell.x && current.y === cell.y)) return
    if (!doc.inBounds(cell.x, cell.y)) return
    const id = this.selected
    this.after(doc.editMap('move event', (map) => {
      const ev = map.events.find((e) => e.id === id)
      if (ev) { ev.x = cell.x; ev.y = cell.y }
    }))
  }

  pointerUp(): void { this.dragging = false }

  // --- Editing -------------------------------------------------------------

  private find(map: GameMap = this.host.doc().map): MapEvent | undefined {
    return map.events.find((e) => e.id === this.selected)
  }

  private get currentPage(): EventPage | undefined {
    return this.find()?.pages[this.page]
  }

  /** Run a change against the selected event, as one undoable action. */
  private edit(label: string, mutate: (ev: MapEvent) => void): void {
    const id = this.selected
    if (!id) return
    this.after(this.host.doc().editMap(label, (map) => {
      const ev = map.events.find((e) => e.id === id)
      if (ev) mutate(ev)
    }))
  }

  private editPage(label: string, mutate: (page: EventPage) => void): void {
    const index = this.page
    this.edit(label, (ev) => {
      const page = ev.pages[index]
      if (page) mutate(page)
    })
  }

  private after(touched: Touched): void {
    this.host.applyTouched(touched)
    this.renderAll()
  }

  private renderAll(): void {
    this.renderList()
    this.renderPages()
    this.renderCommands()
    this.renderInspector()
    this.renderState()
    this.paintMarks()
  }

  private paintMarks(): void {
    const map = this.host.doc().map
    const marks = map.events.map((e) => ({ x: e.x, y: e.y }))
    const current = this.find(map)
    this.host.paintMarks(marks, current ? { x: current.x, y: current.y } : undefined)
  }

  // --- Chrome --------------------------------------------------------------

  private build(): void {
    const list = el('div', { class: 'ed-lines' })

    const add = el('button', { class: 'ed-icon', type: 'button' }, '+ Event')
    add.onclick = () => { add.blur(); this.placing = !this.placing; this.renderAll() }
    const del = el('button', { class: 'ed-icon', type: 'button', title: 'Delete event' }, '✕')
    del.onclick = () => {
      del.blur()
      const id = this.selected
      if (!id) return
      this.selected = undefined
      this.after(this.host.doc().editMap('delete event', (map) => {
        const i = map.events.findIndex((e) => e.id === id)
        if (i >= 0) map.events.splice(i, 1)
      }))
    }
    const hint = el('div', { class: 'ed-hint' })

    const pageRow = el('div', { class: 'ed-seg' })
    const pageBody = el('div', { class: 'ed-sec ed-fields' })
    const commands = el('div', { class: 'ed-cmds' })
    const inspector = el('div', { class: 'ed-sec ed-fields' })
    const stateBody = el('div', { class: 'ed-sec' })

    this.root.append(
      list,
      el('div', { class: 'ed-sec' }, el('div', { class: 'ed-seg' }, add, del), hint),
      el('div', { class: 'ed-sec' }, el('label', {}, 'Pages'), pageRow),
      pageBody,
      el('div', { class: 'ed-sec' }, el('label', {}, 'Commands')),
      commands,
      inspector,
      stateBody,
    )
    this.ui = { list, add, del, hint, pageRow, pageBody, commands, inspector, stateBody }
  }

  private renderList(): void {
    const map = this.host.doc().map
    this.ui.add.setAttribute('aria-pressed', String(this.placing))
    this.ui.del.disabled = !this.selected
    this.ui.hint.textContent = this.placing ? 'Click a tile to place the event.' : ''
    this.ui.hint.hidden = !this.placing

    if (map.events.length === 0) {
      this.ui.list.replaceChildren(
        el('div', { class: 'ed-hint ed-sec' }, 'No events on this map yet.'))
      return
    }
    this.ui.list.replaceChildren(...map.events.map((ev) => {
      const live = ev.pages.findIndex((p) => this.host.state.testAll(p.when))
      const row = el('div', {
        class: 'ed-line', 'aria-selected': String(ev.id === this.selected), role: 'button',
      },
        el('span', { class: 'ed-linekind' }, `${ev.x},${ev.y}`),
        el('span', { class: 'ed-linewho' }, ev.id),
        // Which page is live right now, given the state the panel below can
        // change: the fastest way to see why an event is doing the wrong thing.
        el('span', { class: 'ed-linetext' },
          live < 0 ? 'no live page' : `page ${live + 1} of ${ev.pages.length}`))
      row.onclick = () => {
        this.selected = ev.id
        this.page = 0
        this.selectedPath = undefined
        this.renderAll()
      }
      return row
    }))
  }

  private renderPages(): void {
    const ev = this.find()
    this.ui.pageRow.replaceChildren()
    this.ui.pageBody.replaceChildren()
    if (!ev) return

    ev.pages.forEach((_, i) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(i === this.page) }, String(i + 1))
      b.onclick = () => { b.blur(); this.page = i; this.selectedPath = undefined; this.renderAll() }
      this.ui.pageRow.append(b)
    })
    const addPage = el('button', { class: 'ed-icon', type: 'button', title: 'Add page' }, '+')
    addPage.onclick = () => {
      addPage.blur()
      const at = ev.pages.length
      this.edit('add page', (e) => { e.pages.push(blankPage()) })
      this.page = at
      this.renderAll()
    }
    const delPage = el('button', { class: 'ed-icon', type: 'button', title: 'Remove page' }, '✕')
    delPage.disabled = ev.pages.length <= 1
    delPage.onclick = () => {
      delPage.blur()
      // An event with no pages cannot be validated or run; there is nothing it
      // could mean, so the last one stays.
      if (ev.pages.length <= 1) {
        this.host.message('An event needs at least one page', 'err')
        return
      }
      const index = this.page
      this.page = Math.max(0, index - 1)
      this.edit('remove page', (e) => { e.pages.splice(index, 1) })
    }
    this.ui.pageRow.append(addPage, delPage)

    const page = ev.pages[this.page]
    if (!page) return
    this.ui.pageBody.append(...this.pageFields(ev, page))
  }

  private pageFields(ev: MapEvent, page: EventPage): HTMLElement[] {
    const out: HTMLElement[] = []

    out.push(el('label', {}, 'Id'))
    const id = el('input', { class: 'ed-input2', type: 'text' })
    id.value = ev.id
    id.onchange = () => {
      const clean = id.value.trim()
      const map = this.host.doc().map
      if (!clean) { id.value = ev.id; return }
      if (clean !== ev.id && map.events.some((e) => e.id === clean)) {
        this.host.message(`There is already an event called "${clean}"`, 'err')
        id.value = ev.id
        return
      }
      this.edit('rename event', (e) => { e.id = clean })
      this.selected = clean
      this.renderAll()
    }
    out.push(id)

    out.push(el('label', {}, 'Runs when'))
    const conditions = el('div', { class: 'ed-conds' })
    page.when.forEach((cond, i) => conditions.append(this.conditionRow(cond, i)))
    if (page.when.length === 0) {
      conditions.append(el('div', { class: 'ed-hint' },
        'No conditions — this page is the fallback, so put it last.'))
    }
    const addFlag = el('button', { class: 'ed-icon', type: 'button' }, '+ flag')
    addFlag.onclick = () => this.editPage('add condition', (p) => {
      p.when.push({ flag: 'flag', is: true })
    })
    const addVar = el('button', { class: 'ed-icon', type: 'button' }, '+ variable')
    addVar.onclick = () => this.editPage('add condition', (p) => {
      p.when.push({ var: 'count', op: '>=', value: 1 })
    })
    out.push(conditions, el('div', { class: 'ed-seg' }, addFlag, addVar))

    out.push(el('label', {}, 'Starts on'))
    const trigger = el('select', { class: 'ed-select' })
    trigger.replaceChildren(...TRIGGERS.map((t) => el('option', { value: t }, TRIGGER_LABELS[t])))
    trigger.value = page.trigger
    trigger.onchange = () =>
      this.editPage('trigger', (p) => { p.trigger = trigger.value as Trigger })
    out.push(trigger)

    const blocks = checkbox('Blocks the way', page.blocks, (on) =>
      this.editPage('blocks', (p) => { p.blocks = on }))
    out.push(blocks.row)

    const shows = checkbox('Shows a character', page.look !== undefined, (on) =>
      this.editPage('look', (p) => {
        p.look = on
          ? { character: lastCharacter(this.host.doc().map), facing: 'down' }
          : undefined
      }))
    out.push(shows.row)

    if (page.look) {
      out.push(el('label', {}, 'Character'))
      const character = el('input', { class: 'ed-input2', type: 'text' })
      character.value = page.look.character
      character.onchange = () =>
        this.editPage('character', (p) => { if (p.look) p.look.character = character.value.trim() })
      out.push(character)

      out.push(el('label', {}, 'Facing'))
      const facing = el('select', { class: 'ed-select' })
      facing.replaceChildren(...FACINGS.map((f) => el('option', { value: f }, f)))
      facing.value = page.look.facing
      facing.onchange = () =>
        this.editPage('facing', (p) => { if (p.look) p.look.facing = facing.value as Facing })
      out.push(facing)

      out.push(el('label', {}, 'Tint'))
      const tint = el('input', { type: 'color', class: 'ed-color' })
      tint.value = '#' + (page.look.tint ?? 0xffffff).toString(16).padStart(6, '0')
      tint.oninput = () => this.editPage('tint', (p) => {
        if (p.look) p.look.tint = parseInt(tint.value.slice(1), 16)
      })
      out.push(el('div', { class: 'ed-row2' }, tint))
    }

    return out
  }

  private conditionRow(cond: Condition, index: number): HTMLElement {
    const name = el('input', { class: 'ed-input2', type: 'text' })
    name.value = 'flag' in cond ? cond.flag : cond.var
    name.onchange = () => this.editPage('condition', (p) => {
      const c = p.when[index]
      if (!c) return
      if ('flag' in c) c.flag = name.value.trim()
      else c.var = name.value.trim()
    })

    const middle = el('select', { class: 'ed-select ed-op' })
    if ('flag' in cond) {
      middle.replaceChildren(el('option', { value: 'true' }, 'is true'),
        el('option', { value: 'false' }, 'is false'))
      middle.value = String(cond.is)
      middle.onchange = () => this.editPage('condition', (p) => {
        const c = p.when[index]
        if (c && 'flag' in c) c.is = middle.value === 'true'
      })
    } else {
      middle.replaceChildren(...OPS.map((o) => el('option', { value: o }, o)))
      middle.value = cond.op
      middle.onchange = () => this.editPage('condition', (p) => {
        const c = p.when[index]
        if (c && 'var' in c) c.op = middle.value as Condition extends { op: infer O } ? O : never
      })
    }

    const kids: (Node | string)[] = [name, middle]
    if ('var' in cond) {
      const value = el('input', { class: 'ed-input2 ed-num', type: 'number', step: '1' })
      value.value = String(cond.value)
      value.onchange = () => this.editPage('condition', (p) => {
        const c = p.when[index]
        if (c && 'var' in c) c.value = Number(value.value) || 0
      })
      kids.push(value)
    }

    const del = el('button', { class: 'ed-icon', type: 'button', title: 'Remove' }, '✕')
    del.onclick = () => this.editPage('remove condition', (p) => { p.when.splice(index, 1) })
    kids.push(del)

    return el('div', { class: 'ed-row2' }, ...kids)
  }

  // --- Commands ------------------------------------------------------------

  private renderCommands(): void {
    const page = this.currentPage
    this.ui.commands.replaceChildren()
    if (!page) return

    const rows = flatten(page.do)
    const faults = new Map(problems(page.do).map((p) => [p.path.join('.'), p.message]))

    if (rows.length === 0) {
      this.ui.commands.append(el('div', { class: 'ed-hint ed-sec' }, 'Nothing yet.'))
    }
    for (const row of rows) {
      this.ui.commands.append(this.commandRow(row, faults))
    }
    // Always an add at the end of the top-level list.
    this.ui.commands.append(this.addRow([], 0, 'Add a command'))
  }

  private commandRow(row: Row, faults: Map<string, string>): HTMLElement {
    const indent = { style: `padding-left:${8 + row.depth * 12}px` }

    if (row.kind === 'heading') {
      return el('div', { class: 'ed-cmd-head', ...indent }, row.text)
    }
    if (row.kind === 'empty') {
      return this.addRow(row.path, row.depth, '+ add here')
    }

    const key = row.path.join('.')
    const fault = faults.get(key)
    const selected = this.selectedPath?.join('.') === key

    const label = el('span', { class: 'ed-cmd-text' }, row.text)
    const up = el('button', { class: 'ed-icon ed-tiny', type: 'button', title: 'Move up' }, '↑')
    up.onclick = (e) => { e.stopPropagation(); this.moveCommand(row.path, -1) }
    const down = el('button', { class: 'ed-icon ed-tiny', type: 'button', title: 'Move down' }, '↓')
    down.onclick = (e) => { e.stopPropagation(); this.moveCommand(row.path, 1) }
    const del = el('button', { class: 'ed-icon ed-tiny', type: 'button', title: 'Remove' }, '✕')
    del.onclick = (e) => {
      e.stopPropagation()
      this.selectedPath = undefined
      this.editPage('remove command', (p) => { removeAt(p.do, row.path) })
    }

    const node = el('div', {
      class: 'ed-cmd-row' + (fault ? ' ed-cmd-bad' : ''),
      'aria-selected': String(selected),
      ...indent,
    }, label, up, down, del)
    if (fault) node.title = fault
    node.onclick = () => {
      this.selectedPath = row.path
      this.renderCommands()
      this.renderInspector()
    }
    return node
  }

  private addRow(path: Path, depth: number, text: string): HTMLElement {
    const picker = el('select', { class: 'ed-select ed-add' })
    picker.replaceChildren(
      el('option', { value: '' }, text),
      ...COMMAND_KINDS.map((k) => el('option', { value: k.id }, k.label)))
    picker.onchange = () => {
      const kind = COMMAND_KINDS.find((k) => k.id === picker.value)
      picker.value = ''
      if (!kind) return
      this.editPage('add command', (p) => {
        // An empty top-level list has no item to insert after, so it appends.
        if (path.length === 0 && p.do.length === 0) p.do.push(kind.make())
        else if (path.length === 0) p.do.push(kind.make())
        else insertAfter(p.do, path, kind.make())
      })
    }
    return el('div', { class: 'ed-cmd-add', style: `padding-left:${8 + depth * 12}px` }, picker)
  }

  private moveCommand(path: Path, delta: number): void {
    const moved = path.slice(0, -1).concat((path.at(-1) as number) + delta)
    this.editPage('reorder command', (p) => { moveAt(p.do, path, delta) })
    this.selectedPath = moved
    this.renderCommands()
  }

  /** Fields for the selected command. */
  private renderInspector(): void {
    const page = this.currentPage
    const path = this.selectedPath
    this.ui.inspector.replaceChildren()
    const command = page && path ? commandAt(page.do, path) : undefined
    this.ui.inspector.hidden = !command
    if (!command || !path) return

    const set = (mutate: (c: Command) => void) => this.editPage('edit command', (p) => {
      const target = commandAt(p.do, path)
      if (target) mutate(target)
    })

    this.ui.inspector.append(...this.commandFields(command, set))
  }

  private commandFields(command: Command, set: (m: (c: Command) => void) => void): HTMLElement[] {
    const out: HTMLElement[] = []
    const text = (label: string, value: string, onChange: (v: string) => void) => {
      out.push(el('label', {}, label))
      const input = el('input', { class: 'ed-input2', type: 'text' })
      input.value = value
      input.onchange = () => onChange(input.value)
      out.push(input)
    }
    const number = (label: string, value: number, onChange: (v: number) => void) => {
      out.push(el('label', {}, label))
      const input = el('input', { class: 'ed-input2 ed-num', type: 'number', step: '1' })
      input.value = String(value)
      input.onchange = () => onChange(Number(input.value) || 0)
      out.push(input)
    }

    if ('say' in command) {
      command.say.forEach((line, i) => {
        text(i === 0 ? 'Speaker' : `Speaker ${i + 1}`, line.name ?? '', (v) =>
          set((c) => { if ('say' in c) { if (v) c.say[i]!.name = v; else delete c.say[i]!.name } }))
        out.push(el('label', {}, 'Text'))
        const area = el('textarea', { class: 'ed-textarea', rows: '3' })
        area.value = line.text
        area.onchange = () => set((c) => { if ('say' in c) c.say[i]!.text = area.value })
        out.push(area)
      })
      const addLine = el('button', { class: 'ed-icon', type: 'button' }, '+ another line')
      addLine.onclick = () => set((c) => {
        if ('say' in c) c.say.push({ text: '', name: c.say.at(-1)?.name })
      })
      out.push(addLine)
    } else if ('script' in command) {
      text('Dialogue file', command.script, (v) => set((c) => { if ('script' in c) c.script = v.trim() }))
    } else if ('setFlag' in command) {
      text('Flag', command.setFlag, (v) => set((c) => { if ('setFlag' in c) c.setFlag = v.trim() }))
      const to = checkbox('Set it to true', command.to, (on) =>
        set((c) => { if ('setFlag' in c) c.to = on }))
      out.push(to.row)
    } else if ('setVar' in command) {
      text('Variable', command.setVar, (v) => set((c) => { if ('setVar' in c) c.setVar = v.trim() }))
      number('Value', command.to, (v) => set((c) => { if ('setVar' in c) c.to = v }))
    } else if ('addVar' in command) {
      text('Variable', command.addVar, (v) => set((c) => { if ('addVar' in c) c.addVar = v.trim() }))
      number('Add', command.by, (v) => set((c) => { if ('addVar' in c) c.by = v }))
    } else if ('wait' in command) {
      number('Frames (60 = a second)', command.wait, (v) =>
        set((c) => { if ('wait' in c) c.wait = Math.max(0, v) }))
    } else if ('repeat' in command) {
      number('Times', command.repeat, (v) =>
        set((c) => { if ('repeat' in c) c.repeat = Math.max(0, v) }))
    } else if ('battle' in command) {
      text('Battle file', command.battle, (v) => set((c) => { if ('battle' in c) c.battle = v.trim() }))
    } else if ('warp' in command) {
      text('Map', command.warp.to, (v) => set((c) => { if ('warp' in c) c.warp.to = v.trim() }))
      number('Arrive x', command.warp.x, (v) => set((c) => { if ('warp' in c) c.warp.x = v }))
      number('Arrive y', command.warp.y, (v) => set((c) => { if ('warp' in c) c.warp.y = v }))
    } else if ('face' in command) {
      out.push(el('label', {}, 'Direction'))
      const facing = el('select', { class: 'ed-select' })
      facing.replaceChildren(...FACINGS.map((f) => el('option', { value: f }, f)))
      facing.value = command.face
      facing.onchange = () => set((c) => { if ('face' in c) c.face = facing.value as Facing })
      out.push(facing)
    } else if ('walk' in command) {
      text('Directions, comma separated', command.walk.join(', '), (v) => set((c) => {
        if (!('walk' in c)) return
        c.walk = v.split(',').map((d) => d.trim()).filter((d): d is Facing =>
          FACINGS.includes(d as Facing))
      }))
    } else if ('if' in command || 'while' in command) {
      const key = 'if' in command ? 'if' : 'while'
      const conditions = ('if' in command ? command.if : command.while) as Condition[]
      out.push(el('label', {}, 'Conditions'))
      conditions.forEach((cond, i) => {
        out.push(el('div', { class: 'ed-row2' },
          el('span', { class: 'ed-hint' }, describe(cond)),
          (() => {
            const del = el('button', { class: 'ed-icon ed-tiny', type: 'button' }, '✕')
            del.onclick = () => set((c) => {
              const list = (c as unknown as Record<string, Condition[]>)[key]
              list?.splice(i, 1)
            })
            return del
          })()))
      })
      const addFlag = el('button', { class: 'ed-icon', type: 'button' }, '+ flag')
      addFlag.onclick = () => set((c) => {
        (c as unknown as Record<string, Condition[]>)[key]?.push({ flag: 'flag', is: true })
      })
      const addVar = el('button', { class: 'ed-icon', type: 'button' }, '+ variable')
      addVar.onclick = () => set((c) => {
        (c as unknown as Record<string, Condition[]>)[key]?.push({ var: 'count', op: '>=', value: 1 })
      })
      out.push(el('div', { class: 'ed-seg' }, addFlag, addVar))
      out.push(el('div', { class: 'ed-hint' },
        'Edit a condition by removing it and adding it again, or set it here and ' +
        'rename it in the page conditions above.'))
    } else {
      out.push(el('div', { class: 'ed-hint' }, 'Nothing to configure.'))
    }
    return out
  }

  // --- Flags and variables -------------------------------------------------

  /**
   * The state panel. Events are gated on flags and variables, none of it is
   * persisted, and without a way to set one by hand every test of a second page
   * means walking the whole world again to earn it.
   */
  private renderState(): void {
    const { flags, vars } = this.host.state.snapshot()
    const rows: HTMLElement[] = [el('label', {}, 'Flags and variables')]

    for (const [name, value] of flags) {
      const box = checkbox(name, value, (on) => {
        this.host.state.setFlag(name, on)
        this.renderAll()
      })
      rows.push(box.row)
    }
    for (const [name, value] of vars) {
      const input = el('input', { class: 'ed-input2 ed-num', type: 'number', step: '1' })
      input.value = String(value)
      input.onchange = () => {
        this.host.state.setVariable(name, Number(input.value) || 0)
        this.renderAll()
      }
      rows.push(el('div', { class: 'ed-row2' }, el('span', { class: 'ed-hint' }, name), input))
    }
    if (flags.length === 0 && vars.length === 0) {
      rows.push(el('div', { class: 'ed-hint' },
        'Nothing set yet. A name appears here once an event sets it, or add one below.'))
    }

    const name = el('input', { class: 'ed-input2', type: 'text', placeholder: 'name' })
    const asFlag = el('button', { class: 'ed-icon', type: 'button' }, '+ flag')
    asFlag.onclick = () => {
      if (!name.value.trim()) return
      this.host.state.setFlag(name.value.trim(), true)
      name.value = ''
      this.renderAll()
    }
    const asVar = el('button', { class: 'ed-icon', type: 'button' }, '+ variable')
    asVar.onclick = () => {
      if (!name.value.trim()) return
      this.host.state.setVariable(name.value.trim(), 0)
      name.value = ''
      this.renderAll()
    }
    const clear = el('button', { class: 'ed-icon', type: 'button', title: 'Forget everything' }, 'reset')
    clear.onclick = () => { this.host.state.clear(); this.renderAll() }
    rows.push(el('div', { class: 'ed-row2' }, name, asFlag, asVar), el('div', { class: 'ed-row2' }, clear))

    this.ui.stateBody.replaceChildren(...rows)
  }
}

const TRIGGER_LABELS: Record<Trigger, string> = {
  talk: 'talk — the player presses Z facing it',
  touch: 'touch — the player steps onto it',
  auto: 'auto — by itself, holding the player still',
  parallel: 'parallel — by itself, alongside the player',
}

/** Whatever this map already dresses its people in. */
function lastCharacter(map: GameMap): string {
  for (let i = map.events.length - 1; i >= 0; i--) {
    const look = map.events[i]!.pages.find((p) => p.look)?.look
    if (look) return look.character
  }
  return map.npcs.at(-1)?.character ?? 'data/characters/civilian-1.json'
}

function uniqueId(taken: readonly string[], stem: string): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const id = `${stem}-${n}`
    if (!used.has(id)) return id
  }
}
