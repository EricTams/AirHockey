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
