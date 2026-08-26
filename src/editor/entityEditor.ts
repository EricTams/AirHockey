import type { EditorServer } from './server'
import type { GameMap, MapNpc, MapProp } from '../world/map'
import type { Tileset } from '../world/tileset'
import type { Facing } from '../world/character'
import type { MapDoc, Touched } from './mapDoc'
import type { Cell } from './tools'
import { el } from './dom'

/**
 * Placing and configuring what stands on the map: NPCs and tileset props.
 *
 * Both live in the map file and undo through the same MapDoc as the tiles, so a
 * designer who paints a path, drops an NPC on it and changes their mind can
 * Ctrl-Z back through all of it in the order they did it.
 *
 * NPCs are placed by tile, not by pixel. A sprite is drawn a tile tall and
 * anchored at its feet, so the tile it occupies is not where it appears to be —
 * and the occupied tile is the one that matters, both for walking into it and
 * for standing in front of it to talk.
 */

const FACINGS: Facing[] = ['down', 'up', 'left', 'right']
const DEFAULT_CHARACTER = 'data/characters/character-2.json'

export type Selection =
  | { kind: 'npc'; id: string }
  | { kind: 'prop'; id: string }

export interface EntityHost {
  doc(): MapDoc
  tileset(): Tileset
  server: EditorServer
  /** Push a document change into the scene and the chrome. */
  applyTouched(touched: Touched): void
  /** Draw the selection highlight and every entity's tile. */
  paintMarks(marks: Cell[], selected: Cell | undefined): void
  message(text: string, tone: 'ok' | 'err'): void
}

export class EntityEditor {
  readonly root = el('div', { class: 'ed-pane' })

  private selected?: Selection
  /** Set while a "place" button is armed and the next click drops an entity. */
  private placing?: 'npc' | 'prop'
  private dragging = false

  private ui!: {
    list: HTMLElement
    addNpc: HTMLButtonElement
    addProp: HTMLButtonElement
    del: HTMLButtonElement
    inspector: HTMLElement
    empty: HTMLElement
    hint: HTMLElement
  }

  constructor(private host: EntityHost) {
    this.build()
  }

  // --- Session -------------------------------------------------------------

  activate(): void {
    this.refresh()
  }

  deactivate(): void {
    this.placing = undefined
    this.dragging = false
    this.host.paintMarks([], undefined)
  }

  /** Redraw from the document, e.g. after an undo changed it underneath us. */
  refresh(): void {
    const map = this.host.doc().map
    // A selection can be undone out of existence.
    if (this.selected && !this.find(map, this.selected)) this.selected = undefined
    this.renderList()
    this.renderInspector()
    this.paintMarks()
  }

  // --- Canvas ---------------------------------------------------------------

  /** True if the pointer press was consumed, so the map pane does not paint. */
  pointerDown(cell: Cell): boolean {
    const map = this.host.doc().map
    if (this.placing) {
      this.place(this.placing, cell)
      this.placing = undefined
      this.updateHint()
      return true
    }
    const hit = this.at(map, cell)
    if (hit) {
      this.selected = hit
      this.dragging = true
      this.renderList()
      this.renderInspector()
      this.paintMarks()
      return true
    }
    // Clicking bare ground clears the selection rather than doing nothing:
    // otherwise the highlight lingers over something you have stopped editing.
    this.selected = undefined
    this.renderList()
    this.renderInspector()
    this.paintMarks()
    return true
  }

  pointerDrag(cell: Cell): void {
    if (!this.dragging || !this.selected) return
    const current = this.position(this.host.doc().map, this.selected)
    if (current && current.x === cell.x && current.y === cell.y) return
    this.moveTo(cell)
  }

  pointerUp(): void { this.dragging = false }

  // --- Edits ---------------------------------------------------------------

  private place(kind: 'npc' | 'prop', cell: Cell): void {
    const doc = this.host.doc()
    if (!doc.inBounds(cell.x, cell.y)) return

    if (kind === 'prop') {
      const shape = this.host.tileset().props[0]
      if (!shape) {
        this.host.message('This tileset has no props. Import a sheet first.', 'err')
        return
      }
      const id = uniqueId(doc.map.props.map((p) => p.id), 'prop')
      const touched = doc.editEntities('place prop', (map) => {
        map.props.push({ id, prop: shape.id, x: cell.x, y: cell.y })
      })
      this.selected = { kind: 'prop', id }
      this.after(touched)
      return
    }

    const id = uniqueId(doc.map.npcs.map((n) => n.id), 'npc')
    // Copy the character from an NPC already on the map: whatever the designer
    // is populating this world with is almost certainly what they want again.
    const character = doc.map.npcs.at(-1)?.character ?? DEFAULT_CHARACTER
    const touched = doc.editEntities('place npc', (map) => {
      map.npcs.push({ id, character, x: cell.x, y: cell.y, facing: 'down' })
    })
    this.selected = { kind: 'npc', id }
    this.after(touched)
  }

  private moveTo(cell: Cell): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (!sel || !doc.inBounds(cell.x, cell.y)) return
    const touched = doc.editEntities('move', (map) => {
      const entity = this.find(map, sel)
      if (entity) { entity.x = cell.x; entity.y = cell.y }
    })
    this.after(touched)
  }

  private remove(): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (!sel) return
    const touched = doc.editEntities('delete', (map) => {
      if (sel.kind === 'npc') {
        const i = map.npcs.findIndex((n) => n.id === sel.id)
        if (i >= 0) map.npcs.splice(i, 1)
      } else {
        const i = map.props.findIndex((p) => p.id === sel.id)
        if (i >= 0) map.props.splice(i, 1)
      }
    })
    this.selected = undefined
    this.after(touched)
  }

  /** Change one field of the selected NPC. */
  private setNpc(mutate: (npc: MapNpc) => void, label: string): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (sel?.kind !== 'npc') return
    const touched = doc.editEntities(label, (map) => {
      const npc = map.npcs.find((n) => n.id === sel.id)
      if (npc) mutate(npc)
    })
    this.after(touched, false)
  }

  private setProp(mutate: (prop: MapProp) => void, label: string): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (sel?.kind !== 'prop') return
    const touched = doc.editEntities(label, (map) => {
      const prop = map.props.find((p) => p.id === sel.id)
      if (prop) mutate(prop)
    })
    this.after(touched, false)
  }

  private after(touched: Touched, rebuildInspector = true): void {
    this.host.applyTouched(touched)
    this.renderList()
    if (rebuildInspector) this.renderInspector()
    this.paintMarks()
  }

  // --- Lookups -------------------------------------------------------------

  private find(map: GameMap, sel: Selection): MapNpc | MapProp | undefined {
    return sel.kind === 'npc'
      ? map.npcs.find((n) => n.id === sel.id)
      : map.props.find((p) => p.id === sel.id)
  }

  private position(map: GameMap, sel: Selection): Cell | undefined {
    const entity = this.find(map, sel)
    return entity ? { x: entity.x, y: entity.y } : undefined
  }

  /** What is standing on a tile. NPCs win: they are the ones you talk to. */
  private at(map: GameMap, cell: Cell): Selection | undefined {
    const npc = map.npcs.find((n) => n.x === cell.x && n.y === cell.y)
    if (npc) return { kind: 'npc', id: npc.id }
    const prop = map.props.find((p) => p.x === cell.x && p.y === cell.y)
    return prop ? { kind: 'prop', id: prop.id } : undefined
  }

  private paintMarks(): void {
    const map = this.host.doc().map
    const marks: Cell[] = [
      ...map.npcs.map((n) => ({ x: n.x, y: n.y })),
      ...map.props.map((p) => ({ x: p.x, y: p.y })),
    ]
    const sel = this.selected ? this.position(map, this.selected) : undefined
    this.host.paintMarks(marks, sel)
  }

  // --- DOM -----------------------------------------------------------------

  private build(): void {
    const list = el('div', { class: 'ed-lines' })

    const addNpc = el('button', { class: 'ed-icon', type: 'button' }, '+ NPC')
    addNpc.onclick = () => { addNpc.blur(); this.arm('npc') }
    const addProp = el('button', { class: 'ed-icon', type: 'button' }, '+ Prop')
    addProp.onclick = () => { addProp.blur(); this.arm('prop') }
    const del = el('button', { class: 'ed-icon', type: 'button', title: 'Delete' }, '✕')
    del.onclick = () => { del.blur(); this.remove() }

    const hint = el('div', { class: 'ed-hint' })
    const inspector = el('div', { class: 'ed-sec ed-fields' })
    const empty = el('div', { class: 'ed-sec ed-hint' },
      'Click something on the map to edit it, or add one above.')

    this.root.append(
      list,
      el('div', { class: 'ed-sec' }, el('div', { class: 'ed-seg' }, addNpc, addProp, del), hint),
      inspector,
      empty,
    )
    this.ui = { list, addNpc, addProp, del, inspector, empty, hint }
    this.updateHint()
  }

  private arm(kind: 'npc' | 'prop'): void {
    this.placing = this.placing === kind ? undefined : kind
    this.updateHint()
  }

  private updateHint(): void {
    this.ui.hint.textContent = this.placing
      ? `Click a tile to place the ${this.placing}.`
      : ''
    this.ui.hint.hidden = !this.placing
    this.ui.addNpc.setAttribute('aria-pressed', String(this.placing === 'npc'))
    this.ui.addProp.setAttribute('aria-pressed', String(this.placing === 'prop'))
    // Nothing to place until a sheet has been imported and its props marked
    // out, so say that on the button rather than on the click that fails.
    const hasProps = this.host.tileset().props.length > 0
    this.ui.addProp.disabled = !hasProps
    this.ui.addProp.title = hasProps
      ? 'Place a prop'
      : 'This tileset has no props yet — mark some out when importing a sheet'
    this.ui.del.disabled = !this.selected
  }

  private renderList(): void {
    const map = this.host.doc().map
    const rows: HTMLElement[] = []
    const add = (sel: Selection, label: string, where: string) => {
      const on = this.selected?.kind === sel.kind && this.selected.id === sel.id
      const row = el('div', {
        class: 'ed-line', 'aria-selected': String(on), role: 'button',
      },
        el('span', { class: 'ed-linekind' }, sel.kind === 'npc' ? 'NPC' : 'prop'),
        el('span', { class: 'ed-linewho' }, label),
        el('span', { class: 'ed-linetext' }, where))
      row.onclick = () => {
        this.selected = sel
        this.renderList()
        this.renderInspector()
        this.paintMarks()
      }
      rows.push(row)
    }
    for (const n of map.npcs) add({ kind: 'npc', id: n.id }, n.id, `${n.x},${n.y}`)
    for (const p of map.props) add({ kind: 'prop', id: p.id }, p.id, `${p.x},${p.y}`)
    if (rows.length === 0) {
      rows.push(el('div', { class: 'ed-hint ed-sec' }, 'Nothing placed on this map yet.'))
    }
    this.ui.list.replaceChildren(...rows)
    this.updateHint()
  }

  private renderInspector(): void {
    const map = this.host.doc().map
    const sel = this.selected
    const entity = sel ? this.find(map, sel) : undefined
    this.ui.inspector.hidden = !entity
    this.ui.empty.hidden = !!entity
    if (!sel || !entity) { this.ui.inspector.replaceChildren(); return }

    this.ui.inspector.replaceChildren(
      ...(sel.kind === 'npc'
        ? this.npcFields(map, entity as MapNpc)
        : this.propFields(entity as MapProp)),
    )
  }

  private npcFields(map: GameMap, npc: MapNpc): HTMLElement[] {
    const out: HTMLElement[] = []

    out.push(el('label', {}, 'Id'))
    const id = textField(npc.id, (v) => {
      const clean = v.trim()
      if (!clean) return
      if (clean !== npc.id && map.npcs.some((n) => n.id === clean)) {
        this.host.message(`There is already an NPC called "${clean}"`, 'err')
        return
      }
      const was = npc.id
      this.setNpc((n) => { n.id = clean }, 'rename')
      if (this.selected?.kind === 'npc' && this.selected.id === was) {
        this.selected = { kind: 'npc', id: clean }
      }
    })
    out.push(id)

    out.push(el('label', {}, 'Character'))
    out.push(this.pathField(npc.character, 'data/characters/', (v) =>
      this.setNpc((n) => { n.character = v }, 'character')))

    out.push(el('label', {}, 'Facing'))
    const facing = el('select', { class: 'ed-select' })
    facing.replaceChildren(...FACINGS.map((f) => el('option', { value: f }, f)))
    facing.value = npc.facing
    facing.onchange = () => this.setNpc((n) => { n.facing = facing.value as Facing }, 'facing')
    out.push(facing)

    out.push(el('label', {}, 'Dialogue'))
    out.push(this.pathField(npc.dialogue ?? '', 'data/dialogue/', (v) =>
      this.setNpc((n) => { if (v) n.dialogue = v; else delete n.dialogue }, 'dialogue')))

    out.push(el('label', {}, 'Battle'))
    out.push(this.pathField(npc.battle ?? '', 'data/battles/', (v) =>
      this.setNpc((n) => { if (v) n.battle = v; else delete n.battle }, 'battle')))

    out.push(el('label', {}, 'Tint'))
    const swatch = el('input', { type: 'color', class: 'ed-color' })
    swatch.value = '#' + (npc.tint ?? 0xffffff).toString(16).padStart(6, '0')
    swatch.oninput = () =>
      this.setNpc((n) => { n.tint = parseInt(swatch.value.slice(1), 16) }, 'tint')
    const clear = el('button', { class: 'ed-icon', type: 'button', title: 'No tint' }, 'clear')
    clear.onclick = () => {
      this.setNpc((n) => { delete n.tint }, 'tint')
      this.renderInspector()
    }
    out.push(el('div', { class: 'ed-row2' }, swatch, clear))

    out.push(el('div', { class: 'ed-hint' }, `Standing on ${npc.x},${npc.y} — drag it on the map to move.`))
    return out
  }

  private propFields(prop: MapProp): HTMLElement[] {
    const out: HTMLElement[] = []
    const tileset = this.host.tileset()

    out.push(el('label', {}, 'Id'))
    out.push(textField(prop.id, (v) => {
      const clean = v.trim()
      if (!clean) return
      const was = prop.id
      this.setProp((p) => { p.id = clean }, 'rename')
      if (this.selected?.kind === 'prop' && this.selected.id === was) {
        this.selected = { kind: 'prop', id: clean }
      }
    }))

    out.push(el('label', {}, 'Shape'))
    const shape = el('select', { class: 'ed-select' })
    shape.replaceChildren(...tileset.props.map((p) => el('option', { value: p.id }, p.name || p.id)))
    shape.value = prop.prop
    shape.onchange = () => this.setProp((p) => { p.prop = shape.value }, 'prop shape')
    out.push(shape)

    out.push(el('div', { class: 'ed-hint' }, `Standing on ${prop.x},${prop.y} — drag it on the map to move.`))
    return out
  }

  /**
   * A path field with suggestions gathered from the content folder, so the
   * common case is picking rather than typing a project-relative path exactly.
   */
  private pathField(value: string, prefix: string, onChange: (v: string) => void): HTMLElement {
    const listId = `ed-paths-${prefix.replace(/\W+/g, '-')}`
    const input = el('input', {
      class: 'ed-input2', type: 'text', list: listId, placeholder: prefix + '…',
    })
    input.value = value
    input.onchange = () => onChange(input.value.trim())

    const known = new Set<string>()
    const map = this.host.doc().map
    for (const n of map.npcs) {
      for (const p of [n.character, n.dialogue, n.battle]) {
        if (p?.startsWith(prefix)) known.add(p)
      }
    }
    for (const p of this.host.server.editedPaths ?? []) {
      if (p.startsWith(prefix)) known.add(p)
    }
    const datalist = el('datalist', { id: listId },
      ...[...known].sort().map((p) => el('option', { value: p })))
    return el('div', {}, input, datalist)
  }
}

function textField(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = el('input', { class: 'ed-input2', type: 'text' })
  input.value = value
  input.onchange = () => onChange(input.value)
  return input
}

/** `npc-1`, `npc-2`, … skipping anything already taken. */
function uniqueId(taken: readonly string[], stem: string): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const id = `${stem}-${n}`
    if (!used.has(id)) return id
  }
}
