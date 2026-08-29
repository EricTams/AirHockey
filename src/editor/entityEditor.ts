import type { EditorServer } from './server'
import type { GameMap, MapNpc, MapProp, MapWarp } from '../world/map'
import type { Tileset } from '../world/tileset'
import type { Facing } from '../world/character'
import type { MapDoc, Touched } from './mapDoc'
import type { Cell } from './tools'
import { blankPage, type Command, type MapEvent } from '../world/event'
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

type PlaceKind = 'npc' | 'prop' | 'warp'
const DEFAULT_CHARACTER = 'data/characters/civilian-1.json'

/**
 * The player's start is edited like an entity even though it is a field rather
 * than a list item. It is a thing standing on a tile that the designer moves,
 * and giving it its own unrelated control would be the odd one out.
 */
export const PLAYER_START = '__player-start__'

export type Selection =
  | { kind: 'npc'; id: string }
  | { kind: 'prop'; id: string }
  | { kind: 'warp'; id: string }
  | { kind: 'start' }

export interface EntityHost {
  doc(): MapDoc
  tileset(): Tileset
  server: EditorServer
  /** Push a document change into the scene and the chrome. */
  applyTouched(touched: Touched): void
  /** Draw the selection highlight and every entity's tile. */
  paintMarks(marks: Cell[], selected: Cell | undefined): void
  /** Show a script in the dialogue pane. */
  openDialogue(path: string): void
  message(text: string, tone: 'ok' | 'err'): void
}

export class EntityEditor {
  readonly root = el('div', { class: 'ed-pane' })

  private selected?: Selection
  /** Set while a "place" button is armed and the next click drops an entity. */
  private placing?: PlaceKind
  private dragging = false

  private ui!: {
    list: HTMLElement
    addNpc: HTMLButtonElement
    addProp: HTMLButtonElement
    addWarp: HTMLButtonElement
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

  private place(kind: PlaceKind, cell: Cell): void {
    const doc = this.host.doc()
    if (!doc.inBounds(cell.x, cell.y)) return

    if (kind === 'prop') {
      const shape = this.host.tileset().props[0]
      if (!shape) {
        this.host.message('This tileset has no props. Import a sheet first.', 'err')
        return
      }
      const id = uniqueId(doc.map.props.map((p) => p.id), 'prop')
      const touched = doc.editMap('place prop', (map) => {
        map.props.push({ id, prop: shape.id, x: cell.x, y: cell.y })
      })
      this.selected = { kind: 'prop', id }
      this.after(touched)
      return
    }

    if (kind === 'warp') {
      const id = uniqueId(doc.map.warps.map((w) => w.id), 'warp')
      const touched = doc.editMap('place warp', (map) => {
        // Points at this map by default, which is visibly wrong rather than
        // quietly broken: a warp with no destination would fail validation.
        map.warps.push({ id, x: cell.x, y: cell.y, to: doc.path, toX: 0, toY: 0 })
      })
      this.selected = { kind: 'warp', id }
      this.after(touched)
      return
    }

    const id = uniqueId(doc.map.npcs.map((n) => n.id), 'npc')
    // Copy the character from an NPC already on the map: whatever the designer
    // is populating this world with is almost certainly what they want again.
    const character = doc.map.npcs.at(-1)?.character ?? DEFAULT_CHARACTER
    const touched = doc.editMap('place npc', (map) => {
      map.npcs.push({ id, character, x: cell.x, y: cell.y, facing: 'down' })
    })
    this.selected = { kind: 'npc', id }
    this.after(touched)
  }

  private moveTo(cell: Cell): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (!sel || !doc.inBounds(cell.x, cell.y)) return
    const touched = doc.editMap('move', (map) => {
      if (sel.kind === 'start') {
        map.playerStart = { ...map.playerStart, x: cell.x, y: cell.y }
        return
      }
      const entity = this.find(map, sel)
      if (entity) { entity.x = cell.x; entity.y = cell.y }
    })
    this.after(touched)
  }

  private remove(): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (!sel) return
    if (sel.kind === 'start') {
      this.host.message('Every map needs a player start; move it instead.', 'err')
      return
    }
    const touched = doc.editMap('delete', (map) => {
      if (sel.kind === 'npc') {
        const i = map.npcs.findIndex((n) => n.id === sel.id)
        if (i >= 0) map.npcs.splice(i, 1)
      } else if (sel.kind === 'prop') {
        const i = map.props.findIndex((p) => p.id === sel.id)
        if (i >= 0) map.props.splice(i, 1)
      } else if (sel.kind === 'warp') {
        const i = map.warps.findIndex((w) => w.id === sel.id)
        if (i >= 0) map.warps.splice(i, 1)
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
    const touched = doc.editMap(label, (map) => {
      const npc = map.npcs.find((n) => n.id === sel.id)
      if (npc) mutate(npc)
    })
    this.after(touched, false)
  }

  private setProp(mutate: (prop: MapProp) => void, label: string): void {
    const doc = this.host.doc()
    const sel = this.selected
    if (sel?.kind !== 'prop') return
    const touched = doc.editMap(label, (map) => {
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

  private find(
    map: GameMap, sel: Selection,
  ): MapNpc | MapProp | MapWarp | GameMap['playerStart'] | undefined {
    switch (sel.kind) {
      case 'start': return map.playerStart
      case 'npc': return map.npcs.find((n) => n.id === sel.id)
      case 'prop': return map.props.find((p) => p.id === sel.id)
      case 'warp': return map.warps.find((w) => w.id === sel.id)
    }
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
    if (prop) return { kind: 'prop', id: prop.id }
    const warp = map.warps.find((w) => w.x === cell.x && w.y === cell.y)
    if (warp) return { kind: 'warp', id: warp.id }
    const start = map.playerStart
    return start.x === cell.x && start.y === cell.y ? { kind: 'start' } : undefined
  }

  private paintMarks(): void {
    const map = this.host.doc().map
    const marks: Cell[] = [
      ...map.npcs.map((n) => ({ x: n.x, y: n.y })),
      ...map.props.map((p) => ({ x: p.x, y: p.y })),
      ...map.warps.map((w) => ({ x: w.x, y: w.y })),
      { x: map.playerStart.x, y: map.playerStart.y },
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
    const addWarp = el('button', { class: 'ed-icon', type: 'button', title: 'Place a warp' }, '+ Warp')
    addWarp.onclick = () => { addWarp.blur(); this.arm('warp') }
    const del = el('button', { class: 'ed-icon', type: 'button', title: 'Delete' }, '✕')
    del.onclick = () => { del.blur(); this.remove() }

    const hint = el('div', { class: 'ed-hint' })
    const inspector = el('div', { class: 'ed-sec ed-fields' })
    const empty = el('div', { class: 'ed-sec ed-hint' },
      'Click something on the map to edit it, or add one above.')

    this.root.append(
      list,
      el('div', { class: 'ed-sec' }, el('div', { class: 'ed-seg' }, addNpc, addProp, addWarp, del), hint),
      inspector,
      empty,
    )
    this.ui = { list, addNpc, addProp, addWarp, del, inspector, empty, hint }
    this.updateHint()
  }

  private arm(kind: PlaceKind): void {
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
    this.ui.addWarp.setAttribute('aria-pressed', String(this.placing === 'warp'))
    // Nothing to place until a sheet has been imported and its props marked
    // out, so say that on the button rather than on the click that fails.
    const hasProps = this.host.tileset().props.length > 0
    this.ui.addProp.disabled = !hasProps
    this.ui.addProp.title = hasProps
      ? 'Place a prop'
      : 'This tileset has no props yet — mark some out when importing a sheet'
    this.ui.del.disabled = !this.selected || this.selected.kind === 'start'
  }

  private renderList(): void {
    const map = this.host.doc().map
    const rows: HTMLElement[] = []
    const add = (sel: Selection, label: string, where: string) => {
      const on = this.selected?.kind === sel.kind
        && (sel.kind === 'start' || (this.selected as { id: string }).id === sel.id)
      const row = el('div', {
        class: 'ed-line', 'aria-selected': String(on), role: 'button',
      },
        el('span', { class: 'ed-linekind' },
          { npc: 'NPC', prop: 'prop', warp: 'warp', start: 'start' }[sel.kind]),
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
    add({ kind: 'start' }, 'Player', `${map.playerStart.x},${map.playerStart.y}`)
    for (const n of map.npcs) add({ kind: 'npc', id: n.id }, n.id, `${n.x},${n.y}`)
    for (const p of map.props) add({ kind: 'prop', id: p.id }, p.id, `${p.x},${p.y}`)
    for (const w of map.warps) add({ kind: 'warp', id: w.id }, w.id, `${w.x},${w.y}`)
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

    this.ui.inspector.replaceChildren(...(
      sel.kind === 'start' ? this.startFields(map)
        : sel.kind === 'npc' ? this.npcFields(map, entity as MapNpc)
          : sel.kind === 'warp' ? this.warpFields(entity as MapWarp)
            : this.propFields(entity as MapProp)
    ))
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

    // The path is the least interesting thing about an NPC's conversation, so
    // sitting beside it is the way into the conversation itself: click the one
    // who talks, then edit what they say, without going through a list of file
    // names in another tab.
    out.push(el('label', {}, 'Dialogue'))
    const jump = el('button', {
      class: 'ed-icon', type: 'button', title: 'Edit this script',
    }, 'Edit')
    jump.disabled = !npc.dialogue
    jump.onclick = () => {
      jump.blur()
      if (npc.dialogue) this.host.openDialogue(npc.dialogue)
    }
    out.push(el('div', { class: 'ed-row2' },
      this.pathField(npc.dialogue ?? '', 'data/dialogue/', (v) => {
        this.setNpc((n) => { if (v) n.dialogue = v; else delete n.dialogue }, 'dialogue')
        // The inspector is not rebuilt for a field edit, so the button that
        // depends on this field follows it here.
        jump.disabled = !v
      }),
      jump))

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

    // Events subsume NPCs: the `npcs` array still loads so maps written before
    // events do not break, but anything that needs a condition needs to be an
    // event, and retyping it by hand is the sort of chore that stops people.
    const convert = el('button', { class: 'ed-second', type: 'button' }, 'Turn into an event')
    convert.onclick = () => { convert.blur(); this.convert(npc) }
    out.push(el('div', { class: 'ed-row2' }, convert))
    out.push(el('div', { class: 'ed-hint' },
      'Same position, sprite and conversation, as one event page you can then ' +
      'add conditions and more pages to.'))
    return out
  }

  /**
   * Rewrite an NPC as the event that does the same thing.
   *
   * The hardcoded rule an NPC runs — say your piece, then fight if you have a
   * battle file — becomes two commands, which is exactly what the runtime used
   * to do in `tryInteract` and what doc §158 called a stand-in for events.
   */
  private convert(npc: MapNpc): void {
    const doc = this.host.doc()
    // The NPC is about to be removed, so only the other names are taken.
    const taken = [
      ...doc.map.events.map((e) => e.id),
      ...doc.map.npcs.filter((n) => n.id !== npc.id).map((n) => n.id),
    ]
    const id = keepOrUnique(taken, npc.id)
    const commands: Command[] = []
    if (npc.dialogue) commands.push({ script: npc.dialogue })
    if (npc.battle) commands.push({ battle: npc.battle })

    const event: MapEvent = {
      id,
      x: npc.x,
      y: npc.y,
      pages: [{
        ...blankPage(),
        look: { character: npc.character, facing: npc.facing, tint: npc.tint },
        do: commands,
      }],
    }
    const touched = doc.editMap('turn NPC into an event', (map) => {
      map.events.push(event)
      const i = map.npcs.findIndex((n) => n.id === npc.id)
      if (i >= 0) map.npcs.splice(i, 1)
    })
    this.selected = undefined
    this.after(touched)
    this.host.message(`"${npc.id}" is now the event "${id}" — see the Events tab`, 'ok')
  }

  private startFields(map: GameMap): HTMLElement[] {
    const facing = el('select', { class: 'ed-select' })
    facing.replaceChildren(...FACINGS.map((f) => el('option', { value: f }, f)))
    facing.value = map.playerStart.facing
    facing.onchange = () => {
      const touched = this.host.doc().editMap('start facing', (m) => {
        m.playerStart = { ...m.playerStart, facing: facing.value as Facing }
      })
      this.after(touched, false)
    }
    return [
      el('label', {}, 'Facing'),
      facing,
      el('div', { class: 'ed-hint' },
        `The player begins on ${map.playerStart.x},${map.playerStart.y} — drag it on the map to move.`),
    ]
  }

  /**
   * A warp's destination tile is on a map this one does not load, so nothing
   * here can check it. The runtime falls back to the destination's own
   * playerStart rather than putting the player nowhere, and the field says so.
   */
  private warpFields(warp: MapWarp): HTMLElement[] {
    const out: HTMLElement[] = []
    const set = (mutate: (w: MapWarp) => void, label: string) => {
      const sel = this.selected
      if (sel?.kind !== 'warp') return
      const touched = this.host.doc().editMap(label, (map) => {
        const found = map.warps.find((w) => w.id === sel.id)
        if (found) mutate(found)
      })
      this.after(touched, false)
    }

    out.push(el('label', {}, 'Id'))
    out.push(textField(warp.id, (v) => {
      const clean = v.trim()
      if (!clean) return
      const was = warp.id
      set((w) => { w.id = clean }, 'rename')
      if (this.selected?.kind === 'warp' && this.selected.id === was) {
        this.selected = { kind: 'warp', id: clean }
      }
    }))

    out.push(el('label', {}, 'Goes to'))
    out.push(this.pathField(warp.to, 'data/maps/', (v) => set((w) => { w.to = v }, 'warp target')))

    out.push(el('label', {}, 'Arrives at'))
    const x = numberField(warp.toX, (v) => set((w) => { w.toX = v }, 'warp tile'))
    const y = numberField(warp.toY, (v) => set((w) => { w.toY = v }, 'warp tile'))
    out.push(el('div', { class: 'ed-row2' }, x, el('span', { class: 'ed-x' }, ','), y))

    out.push(el('label', {}, 'Facing on arrival'))
    const facing = el('select', { class: 'ed-select' })
    facing.replaceChildren(el('option', { value: '' }, 'keep walking'),
      ...FACINGS.map((f) => el('option', { value: f }, f)))
    facing.value = warp.facing ?? ''
    facing.onchange = () => set((w) => {
      if (facing.value) w.facing = facing.value as Facing
      else delete w.facing
    }, 'warp facing')
    out.push(facing)

    out.push(el('div', { class: 'ed-hint' },
      `On ${warp.x},${warp.y}. The destination tile is in another file and is not ` +
      'checked here; if it is off that map, the player arrives at its own start.'))
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

function numberField(value: number, onChange: (v: number) => void): HTMLInputElement {
  const input = el('input', { class: 'ed-input2 ed-num', type: 'number', min: '0', step: '1' })
  input.value = String(value)
  input.onchange = () => {
    const n = Number(input.value)
    if (Number.isInteger(n) && n >= 0) onChange(n)
    else input.value = String(value)
  }
  return input
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

/** Keep the name if it is free — a converted "blorb" should still be "blorb". */
function keepOrUnique(taken: readonly string[], name: string): string {
  return taken.includes(name) ? uniqueId(taken, name) : name
}
