import type { Command, Condition } from '../world/event'

/**
 * Editing a command tree as if it were a list.
 *
 * Commands nest: an `if` holds a `then` and an `else`, a `while` holds a `do`, a
 * `battle` holds `won` and `lost`. A designer wants to see that as one indented
 * list they can insert into, delete from and reorder — the way a command list
 * reads in every editor of this kind — not as a tree of collapsible boxes.
 *
 * So the tree is flattened for display and addressed by path. A path is a walk
 * from the root: numbers index the list you are in, strings step into a named
 * sublist. `[0, 'then', 1]` is the second command inside the first command's
 * `then`. Every operation here works on a path, which is what lets the UI stay
 * a flat list of rows.
 *
 * Pure, and the part of the events editor most worth testing: an off-by-one in
 * an insert puts a designer's command in the wrong branch of their own logic.
 */

export type Seg = number | string
export type Path = readonly Seg[]

/** The sublists a command can hold, in the order they should be shown. */
export const SUBLISTS: Record<string, readonly string[]> = {
  if: ['then', 'else'],
  while: ['do'],
  repeat: ['do'],
  battle: ['won', 'lost'],
}

/** Which sublists this particular command has. */
export function sublistsOf(command: Command): readonly string[] {
  for (const [key, lists] of Object.entries(SUBLISTS)) {
    if (key in command) return lists
  }
  return []
}

export interface Row {
  /** A command, a sublist heading, or the placeholder inside an empty sublist. */
  kind: 'command' | 'heading' | 'empty'
  depth: number
  text: string
  /** For a command row, the path to it; otherwise the path of the sublist. */
  path: Path
  command?: Command
}

/**
 * The list that contains whatever `path` addresses, creating nothing.
 *
 * A path ending in a string names a sublist itself; one ending in a number
 * names an item, and the list wanted is the one it sits in.
 */
export function listAt(root: Command[], path: Path): Command[] | undefined {
  let list: Command[] = root
  let i = 0
  while (i < path.length) {
    const seg = path[i]
    // A string only ever follows the index of the command that owns it.
    if (typeof seg !== 'number') return undefined
    const next = path[i + 1]
    if (next === undefined) return list
    if (typeof next !== 'string') return undefined
    const owner = list[seg] as unknown as Record<string, unknown> | undefined
    const sub = owner?.[next]
    if (!Array.isArray(sub)) return undefined
    list = sub as Command[]
    i += 2
  }
  return list
}

export function commandAt(root: Command[], path: Path): Command | undefined {
  const list = listAt(root, path)
  const last = path.at(-1)
  return typeof last === 'number' ? list?.[last] : undefined
}

/** The list a sublist path names, e.g. `[0, 'then']`. */
export function sublistAt(root: Command[], path: Path): Command[] | undefined {
  const last = path.at(-1)
  if (typeof last !== 'string') return undefined
  const owner = commandAt(root, path.slice(0, -1))
  if (!owner) return undefined
  const sub = (owner as unknown as Record<string, unknown>)[last]
  return Array.isArray(sub) ? sub as Command[] : undefined
}

/**
 * Make a sublist exist so something can be put in it. `else`, `won` and `lost`
 * are optional in the format and absent until the designer adds to them.
 */
function ensureSublist(root: Command[], path: Path): Command[] | undefined {
  const existing = sublistAt(root, path)
  if (existing) return existing
  const key = path.at(-1)
  const owner = commandAt(root, path.slice(0, -1))
  if (!owner || typeof key !== 'string') return undefined
  const created: Command[] = [];
  (owner as unknown as Record<string, unknown>)[key] = created
  return created
}

/** Insert after the command at `path`, or at the end of the sublist it names. */
export function insertAfter(root: Command[], path: Path, command: Command): boolean {
  const last = path.at(-1)
  if (typeof last === 'string') {
    const list = ensureSublist(root, path)
    if (!list) return false
    list.push(command)
    return true
  }
  const list = listAt(root, path)
  if (!list || typeof last !== 'number') return false
  list.splice(last + 1, 0, command)
  return true
}

export function removeAt(root: Command[], path: Path): boolean {
  const list = listAt(root, path)
  const last = path.at(-1)
  if (!list || typeof last !== 'number' || !list[last]) return false
  list.splice(last, 1)
  return true
}

/** Move within the list it is already in. Never moves between branches. */
export function moveAt(root: Command[], path: Path, delta: number): boolean {
  const list = listAt(root, path)
  const last = path.at(-1)
  if (!list || typeof last !== 'number') return false
  const to = last + delta
  if (to < 0 || to >= list.length) return false
  const [item] = list.splice(last, 1)
  list.splice(to, 0, item!)
  return true
}

/** Every row the editor should draw, in order, with its indent. */
export function flatten(root: readonly Command[], base: Path = [], depth = 0): Row[] {
  const rows: Row[] = []
  root.forEach((command, i) => {
    const path = [...base, i]
    rows.push({ kind: 'command', depth, text: summarize(command), path, command })
    for (const key of sublistsOf(command)) {
      const sub = (command as unknown as Record<string, unknown>)[key]
      const listPath = [...path, key]
      if (!Array.isArray(sub) || sub.length === 0) {
        // `else`, `won` and `lost` are optional, so an absent one is offered
        // rather than hidden: adding to it is how it comes into existence.
        rows.push({ kind: 'heading', depth: depth + 1, text: key, path: listPath })
        rows.push({ kind: 'empty', depth: depth + 2, text: '(nothing)', path: listPath })
        continue
      }
      rows.push({ kind: 'heading', depth: depth + 1, text: key, path: listPath })
      rows.push(...flatten(sub as Command[], listPath, depth + 2))
    }
  })
  return rows
}

/** One line describing a command, for the list. */
export function summarize(command: Command): string {
  if ('say' in command) {
    const first = command.say[0]
    const who = first?.name ? `${first.name}: ` : ''
    return `Say — ${who}${clip(first?.text ?? '')}`
  }
  if ('script' in command) return `Play dialogue — ${command.script}`
  if ('setFlag' in command) return `Set flag ${command.setFlag} = ${command.to}`
  if ('setVar' in command) return `Set ${command.setVar} = ${command.to}`
  if ('addVar' in command) return `Add ${command.by} to ${command.addVar}`
  if ('if' in command) return `If ${describeAll(command.if)}`
  if ('while' in command) return `While ${describeAll(command.while)}`
  if ('repeat' in command) return `Repeat ${command.repeat} times`
  if ('break' in command) return 'Break out of the loop'
  if ('wait' in command) return `Wait ${command.wait} frames`
  if ('battle' in command) return `Battle — ${command.battle}`
  if ('warp' in command) {
    return `Go to ${command.warp.to} at ${command.warp.x},${command.warp.y}`
  }
  if ('face' in command) return `Turn to face ${command.face}`
  if ('walk' in command) return `Walk ${command.walk.join(', ') || '(nowhere)'}`
  if ('stop' in command) return 'Stop the event'
  return 'Unknown command'
}

export function describe(condition: Condition): string {
  return 'flag' in condition
    ? `${condition.flag} is ${condition.is}`
    : `${condition.var} ${condition.op} ${condition.value}`
}

export function describeAll(conditions: readonly Condition[]): string {
  return conditions.length === 0 ? '(always)' : conditions.map(describe).join(' and ')
}

/**
 * Commands that are not finished being written: a path never chosen, a line
 * never typed. They validate as shapes but would fail at load or do nothing at
 * runtime, so the editor names them rather than letting a save go quiet.
 */
export function problems(root: readonly Command[], base: Path = []): { path: Path; message: string }[] {
  const found: { path: Path; message: string }[] = []
  root.forEach((command, i) => {
    const path = [...base, i]
    if ('script' in command && !command.script) found.push({ path, message: 'no dialogue file chosen' })
    if ('battle' in command && !command.battle) found.push({ path, message: 'no battle file chosen' })
    if ('warp' in command && !command.warp.to) found.push({ path, message: 'no destination map chosen' })
    if ('say' in command && command.say.every((l) => !l.text.trim())) {
      found.push({ path, message: 'nothing to say' })
    }
    if ('walk' in command && command.walk.length === 0) {
      found.push({ path, message: 'no directions to walk' })
    }
    for (const key of sublistsOf(command)) {
      const sub = (command as unknown as Record<string, unknown>)[key]
      if (Array.isArray(sub)) found.push(...problems(sub as Command[], [...path, key]))
    }
  })
  return found
}

function clip(text: string, max = 34): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/**
 * The commands offered when adding, with a blank of each.
 *
 * Names get a usable default, because any non-empty string is a valid flag or
 * variable name and typing one is the designer's job, not a precondition. Paths
 * are left empty on purpose: there is no sensible default dialogue file, and a
 * made-up one would validate and then fail at runtime. `problems` reports those
 * so the editor can say what is unfinished before a save tries to write it.
 */
export const COMMAND_KINDS: { id: string; label: string; make: () => Command }[] = [
  { id: 'say', label: 'Say', make: () => ({ say: [{ text: '' }] }) },
  { id: 'script', label: 'Play dialogue file', make: () => ({ script: '' }) },
  { id: 'setFlag', label: 'Set flag', make: () => ({ setFlag: 'flag', to: true }) },
  { id: 'setVar', label: 'Set variable', make: () => ({ setVar: 'count', to: 0 }) },
  { id: 'addVar', label: 'Add to variable', make: () => ({ addVar: 'count', by: 1 }) },
  { id: 'if', label: 'If…', make: () => ({ if: [], then: [] }) },
  { id: 'while', label: 'While…', make: () => ({ while: [], do: [] }) },
  { id: 'repeat', label: 'Repeat…', make: () => ({ repeat: 2, do: [] }) },
  { id: 'break', label: 'Break', make: () => ({ break: true }) },
  { id: 'wait', label: 'Wait', make: () => ({ wait: 30 }) },
  { id: 'battle', label: 'Battle', make: () => ({ battle: '' }) },
  { id: 'warp', label: 'Go to another map', make: () => ({ warp: { to: '', x: 0, y: 0 } }) },
  { id: 'face', label: 'Turn', make: () => ({ face: 'down' }) },
  { id: 'walk', label: 'Walk', make: () => ({ walk: [] }) },
  { id: 'stop', label: 'Stop', make: () => ({ stop: true }) },
]
