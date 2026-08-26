import type { EditorServer } from './server'
import type { GameMap } from '../world/map'
import { el } from './dom'

/**
 * Choosing, creating and resizing maps.
 *
 * The list is assembled rather than listed: there is no way to enumerate the
 * site's own files, so it is whatever the designer has edited, plus the entry
 * map, plus anything a warp on the open map points at. A map that is none of
 * those is reachable only by making it — which is the same bargain the dialogue
 * picker makes, for the same reason.
 */

const MAP_DIR = 'data/maps/'

export interface MapPickerHost {
  server: EditorServer
  /** The map on screen, for its warps and for marking the current entry. */
  currentMap(): GameMap
  currentPath(): string
  /** Unsaved work anywhere, so switching can refuse to throw it away. */
  dirty(): boolean
  openMap(path: string): Promise<void>
  createMap(id: string, width: number, height: number): Promise<void>
  resizeMap(width: number, height: number): void
  message(text: string, tone: 'ok' | 'err'): void
}

/** The map the game boots into. Always offered, edited or not. */
export const ENTRY_MAP = 'data/maps/overworld.json'

export class MapPicker {
  readonly root = el('div', { class: 'ed-sec' })

  private ui!: {
    picker: HTMLSelectElement
    newRow: HTMLElement
    newId: HTMLInputElement
    newW: HTMLInputElement
    newH: HTMLInputElement
    sizeW: HTMLInputElement
    sizeH: HTMLInputElement
    resize: HTMLButtonElement
  }

  constructor(private host: MapPickerHost) {
    this.build()
  }

  /** Rebuild the list and the size fields from whatever map is open. */
  refresh(): void {
    const map = this.host.currentMap()
    const current = this.host.currentPath()

    const paths = new Set<string>([ENTRY_MAP, current])
    for (const p of this.host.server.editedPaths ?? []) {
      if (p.startsWith(MAP_DIR) && p.endsWith('.json')) paths.add(p)
    }
    // A map you can walk to is a map you will want to edit.
    for (const warp of map.warps) paths.add(warp.to)

    this.ui.picker.replaceChildren(...[...paths].sort().map((p) =>
      el('option', { value: p }, p.replace(MAP_DIR, '').replace(/\.json$/, ''))))
    this.ui.picker.value = current

    this.ui.sizeW.value = String(map.width)
    this.ui.sizeH.value = String(map.height)
    this.syncResize()
  }

  private syncResize(): void {
    const map = this.host.currentMap()
    const w = Number(this.ui.sizeW.value)
    const h = Number(this.ui.sizeH.value)
    const changed = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0
      && (w !== map.width || h !== map.height)
    this.ui.resize.disabled = !changed
  }

  private async switchTo(path: string): Promise<void> {
    if (path === this.host.currentPath()) return
    if (this.host.dirty()) {
      this.host.message('Save first — switching maps would lose your changes', 'err')
      this.ui.picker.value = this.host.currentPath()
      return
    }
    await this.host.openMap(path)
  }

  private build(): void {
    const picker = el('select', { class: 'ed-select' })
    picker.onchange = () => { void this.switchTo(picker.value) }

    const newBtn = el('button', { class: 'ed-icon', type: 'button', title: 'New map' }, '+')
    const newId = el('input', { class: 'ed-input2', type: 'text', placeholder: 'map name' })
    const newW = numberField('20')
    const newH = numberField('12')
    const create = el('button', { class: 'ed-icon', type: 'button' }, 'Create')
    const newRow = el('div', { class: 'ed-row2' }, newId, newW, el('span', { class: 'ed-x' }, '×'), newH, create)
    newRow.hidden = true
    newBtn.onclick = () => {
      newRow.hidden = !newRow.hidden
      if (!newRow.hidden) newId.focus()
    }
    create.onclick = () => {
      const id = newId.value.trim().replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
      const w = Number(newW.value)
      const h = Number(newH.value)
      if (!id) { this.host.message('A map needs a name', 'err'); return }
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
        this.host.message('A map needs a whole-number size of at least 1×1', 'err')
        return
      }
      newRow.hidden = true
      newId.value = ''
      void this.host.createMap(id, w, h)
    }

    const sizeW = numberField('20')
    const sizeH = numberField('12')
    const resize = el('button', { class: 'ed-icon', type: 'button' }, 'Resize')
    for (const input of [sizeW, sizeH]) input.oninput = () => this.syncResize()
    resize.onclick = () => {
      resize.blur()
      this.host.resizeMap(Number(sizeW.value), Number(sizeH.value))
      this.refresh()
    }

    this.root.append(
      el('label', {}, 'Map'),
      el('div', { class: 'ed-row2' }, picker, newBtn),
      newRow,
      el('div', { class: 'ed-row2' },
        sizeW, el('span', { class: 'ed-x' }, '×'), sizeH, resize),
    )
    this.ui = { picker, newRow, newId, newW, newH, sizeW, sizeH, resize }
  }
}

function numberField(value: string): HTMLInputElement {
  const input = el('input', { class: 'ed-input2 ed-num', type: 'number', min: '1', step: '1' })
  input.value = value
  return input
}
