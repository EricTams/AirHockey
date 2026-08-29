/**
 * The one DOM helper the editor's panels share.
 *
 * Not a framework and not trying to become one: the editor's chrome is a few
 * hundred elements built once, and `document.createElement` with a spread of
 * attributes covers all of it.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const kid of kids) node.append(kid)
  return node
}

/** A labelled checkbox row, with its input exposed so state can be pushed in. */
export function checkbox(
  label: string, on: boolean, onChange: (on: boolean) => void,
): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox' })
  input.checked = on
  input.onchange = () => onChange(input.checked)
  return { row: el('label', { class: 'ed-check' }, input, label), input }
}

/**
 * A slider with a readout beside it.
 *
 * Two callbacks rather than one, because a drag is one action but fires a
 * hundred events. `onScrub` runs on every step and is for showing the designer
 * what they are choosing; `onCommit` runs once, when they let go, and is for
 * writing it down. Wiring both to the same handler would put a hundred entries
 * on the undo stack for one drag.
 */
export function slider(
  min: number, max: number, value: number,
  label: (v: number) => string,
  onScrub: (v: number) => void,
  onCommit: (v: number) => void,
): { row: HTMLElement; input: HTMLInputElement; set: (v: number) => void } {
  const input = el('input', {
    class: 'ed-slider', type: 'range',
    min: String(min), max: String(max), step: '1',
  })
  const out = el('span', { class: 'ed-slider-val' })
  const paint = (v: number) => { out.textContent = label(v) }

  input.value = String(value)
  paint(value)
  input.oninput = () => { const v = Number(input.value); paint(v); onScrub(v) }
  input.onchange = () => onCommit(Number(input.value))
  // A focused control eats the next Space or arrow key, which the editor binds
  // to panning — and on a range input the arrows would move the slider too.
  input.onmouseup = () => input.blur()

  return {
    row: el('div', { class: 'ed-row2' }, input, out),
    input,
    set: (v: number) => { input.value = String(v); paint(v) },
  }
}
