import type { Facing } from './character'
import { parseLines, type DialogueLine } from '../modes/dialogue'

/**
 * Events: the thing that turns a map from scenery into a game.
 *
 * An event stands on a tile and has ordered pages. The first page whose
 * conditions all hold is the live one — an if/else chain, read top to bottom —
 * and that page decides what the event looks like, whether it blocks the way,
 * what starts it, and what it does. A guard who moves aside once you have beaten
 * them is one event with two pages, not two objects and a flag test in the
 * runtime.
 *
 * The vocabulary is ours rather than RPG Maker's, per the handoff: events,
 * pages, triggers, flags, variables. The capability bar is the reference; the
 * naming is not.
 *
 * The one import from `modes/dialogue` crosses layers, and only for the shape
 * of a spoken line and the validator that goes with it: a `say` block is a run
 * of dialogue lines, and validating it twice in two places is how the two
 * would drift apart.
 */

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>='

export interface FlagCondition { flag: string; is: boolean }
export interface VarCondition { var: string; op: CompareOp; value: number }
export type Condition = FlagCondition | VarCondition

/**
 * How a page starts.
 *
 *   talk      the player faces it and presses interact
 *   touch     the player's step finishes on its tile
 *   auto      it runs by itself as soon as this page becomes the live one,
 *             and holds the player still until it finishes
 *   parallel  it runs alongside the player, who keeps walking
 */
export const TRIGGERS = ['talk', 'touch', 'auto', 'parallel'] as const
export type Trigger = (typeof TRIGGERS)[number]

/** What the event looks like on this page. Absent means invisible. */
export interface EventLook {
  character: string
  facing: Facing
  tint?: number
}

export interface EventPage {
  when: Condition[]
  trigger: Trigger
  look?: EventLook
  /** Whether the player can walk through it. The map's collision grid is separate. */
  blocks: boolean
  do: Command[]
}

export interface MapEvent {
  id: string
  x: number
  y: number
  pages: EventPage[]
}

export interface WarpTarget {
  to: string
  x: number
  y: number
  facing?: Facing
}

/**
 * One instruction. A union discriminated by which key is present, which is what
 * makes the files readable — `{ "wait": 30 }` says what it is without a "kind".
 */
export type Command =
  | { say: DialogueLine[] }
  | { script: string }
  | { setFlag: string; to: boolean }
  | { setVar: string; to: number }
  | { addVar: string; by: number }
  | { if: Condition[]; then: Command[]; else?: Command[] }
  | { while: Condition[]; do: Command[] }
  | { repeat: number; do: Command[] }
  | { break: true }
  | { wait: number }
  | { battle: string; won?: Command[]; lost?: Command[] }
  | { warp: WarpTarget }
  | { face: Facing }
  | { walk: Facing[] }
  | { stop: true }

const OPS: readonly string[] = ['=', '!=', '<', '<=', '>', '>=']
const FACINGS: readonly string[] = ['up', 'down', 'left', 'right']

function fail(where: string, msg: string): never {
  throw new Error(`${where}: ${msg}`)
}

/**
 * Validate an event. Strict and loud like the rest of the format: the editor
 * writes these and the interpreter runs them, so a malformed command must
 * surface at load rather than as a conversation that stops halfway.
 */
export function parseEvent(raw: unknown, path: string): MapEvent {
  const e = raw as Partial<MapEvent>
  if (!e || typeof e !== 'object') fail(path, 'not an object')
  if (typeof e.id !== 'string' || !e.id) fail(path, 'missing "id"')
  if (!Number.isInteger(e.x) || !Number.isInteger(e.y)) fail(path, 'missing "x"/"y"')
  if (!Array.isArray(e.pages)) fail(path, 'missing "pages" as an array')
  if (e.pages.length === 0) fail(path, 'has no pages')

  const pages = e.pages.map((p, i) => parsePage(p, `${path}: page[${i}]`))
  return { id: e.id, x: e.x as number, y: e.y as number, pages }
}

function parsePage(raw: unknown, at: string): EventPage {
  const p = raw as Partial<EventPage>
  if (!p || typeof p !== 'object') fail(at, 'not an object')

  const when = p.when ?? []
  if (!Array.isArray(when)) fail(at, '"when" must be an array')
  when.forEach((c, i) => parseCondition(c, `${at}: when[${i}]`))

  const trigger = p.trigger ?? 'talk'
  if (!TRIGGERS.includes(trigger as Trigger)) {
    fail(at, `trigger "${trigger}" is not one of ${TRIGGERS.join(', ')}`)
  }

  let look: EventLook | undefined
  if (p.look !== undefined) {
    const l = p.look as Partial<EventLook>
    if (typeof l?.character !== 'string' || !l.character) fail(`${at}: look`, 'missing "character"')
    if (!FACINGS.includes(l.facing as string)) fail(`${at}: look`, `facing "${l.facing}" invalid`)
    if (l.tint !== undefined && !Number.isInteger(l.tint)) fail(`${at}: look`, '"tint" must be an integer')
    look = { character: l.character, facing: l.facing as Facing, tint: l.tint }
  }

  const commands = p.do ?? []
  if (!Array.isArray(commands)) fail(at, '"do" must be an array')
  const parsed = commands.map((c, i) => parseCommand(c, `${at}: do[${i}]`))

  return { when: when as Condition[], trigger: trigger as Trigger, look, blocks: p.blocks === true, do: parsed }
}

export function parseCondition(raw: unknown, at: string): Condition {
  const c = raw as Record<string, unknown>
  if (!c || typeof c !== 'object') fail(at, 'not an object')
  if (typeof c.flag === 'string') {
    if (typeof c.is !== 'boolean') fail(at, '"is" must be true or false')
    return { flag: c.flag, is: c.is }
  }
  if (typeof c.var === 'string') {
    if (!OPS.includes(c.op as string)) fail(at, `op "${c.op}" is not one of ${OPS.join(' ')}`)
    if (typeof c.value !== 'number') fail(at, '"value" must be a number')
    return { var: c.var, op: c.op as CompareOp, value: c.value }
  }
  fail(at, 'needs either "flag" or "var"')
}

function list(raw: unknown, at: string): Command[] {
  if (!Array.isArray(raw)) fail(at, 'must be an array of commands')
  return raw.map((c, i) => parseCommand(c, `${at}[${i}]`))
}

export function parseCommand(raw: unknown, at: string): Command {
  const c = raw as Record<string, unknown>
  if (!c || typeof c !== 'object') fail(at, 'not an object')

  if ('say' in c) {
    if (!Array.isArray(c.say) || c.say.length === 0) fail(at, '"say" needs at least one line')
    // Through the dialogue format's own validator, so lines written here get
    // the same labels, gotos and choices as lines written in a file — and the
    // same refusal when a goto names a label that is not there.
    return { say: parseLines(c.say, `${at}: say`) }
  }
  if ('script' in c) {
    if (typeof c.script !== 'string' || !c.script) fail(at, '"script" must be a path')
    return { script: c.script }
  }
  if ('setFlag' in c) {
    if (typeof c.setFlag !== 'string' || !c.setFlag) fail(at, '"setFlag" must be a name')
    if (typeof c.to !== 'boolean') fail(at, '"to" must be true or false')
    return { setFlag: c.setFlag, to: c.to }
  }
  if ('setVar' in c) {
    if (typeof c.setVar !== 'string' || !c.setVar) fail(at, '"setVar" must be a name')
    if (typeof c.to !== 'number') fail(at, '"to" must be a number')
    return { setVar: c.setVar, to: c.to }
  }
  if ('addVar' in c) {
    if (typeof c.addVar !== 'string' || !c.addVar) fail(at, '"addVar" must be a name')
    if (typeof c.by !== 'number') fail(at, '"by" must be a number')
    return { addVar: c.addVar, by: c.by }
  }
  if ('if' in c) {
    if (!Array.isArray(c.if)) fail(at, '"if" must be an array of conditions')
    c.if.forEach((cond, i) => parseCondition(cond, `${at}: if[${i}]`))
    return {
      if: c.if as Condition[],
      then: list(c.then, `${at}: then`),
      else: c.else === undefined ? undefined : list(c.else, `${at}: else`),
    }
  }
  if ('while' in c) {
    if (!Array.isArray(c.while)) fail(at, '"while" must be an array of conditions')
    c.while.forEach((cond, i) => parseCondition(cond, `${at}: while[${i}]`))
    return { while: c.while as Condition[], do: list(c.do, `${at}: do`) }
  }
  if ('repeat' in c) {
    if (!Number.isInteger(c.repeat) || (c.repeat as number) < 0) {
      fail(at, '"repeat" must be a whole number of times')
    }
    return { repeat: c.repeat as number, do: list(c.do, `${at}: do`) }
  }
  if ('break' in c) return { break: true }
  if ('wait' in c) {
    if (!Number.isInteger(c.wait) || (c.wait as number) < 0) fail(at, '"wait" must be a whole number of frames')
    return { wait: c.wait as number }
  }
  if ('battle' in c) {
    if (typeof c.battle !== 'string' || !c.battle) fail(at, '"battle" must be a path')
    return {
      battle: c.battle,
      won: c.won === undefined ? undefined : list(c.won, `${at}: won`),
      lost: c.lost === undefined ? undefined : list(c.lost, `${at}: lost`),
    }
  }
  if ('warp' in c) {
    const w = c.warp as Partial<WarpTarget>
    if (typeof w?.to !== 'string' || !w.to) fail(`${at}: warp`, 'missing "to"')
    if (!Number.isInteger(w.x) || !Number.isInteger(w.y)) fail(`${at}: warp`, 'missing "x"/"y"')
    if (w.facing !== undefined && !FACINGS.includes(w.facing)) {
      fail(`${at}: warp`, `facing "${w.facing}" invalid`)
    }
    return { warp: { to: w.to, x: w.x as number, y: w.y as number, facing: w.facing } }
  }
  if ('face' in c) {
    if (!FACINGS.includes(c.face as string)) fail(at, `face "${c.face}" invalid`)
    return { face: c.face as Facing }
  }
  if ('walk' in c) {
    if (!Array.isArray(c.walk)) fail(at, '"walk" must be an array of directions')
    c.walk.forEach((d, i) => {
      if (!FACINGS.includes(d as string)) fail(`${at}: walk[${i}]`, `direction "${d}" invalid`)
    })
    return { walk: c.walk as Facing[] }
  }
  if ('stop' in c) return { stop: true }

  fail(at, `unknown command: ${Object.keys(c).join(', ') || '(empty)'}`)
}

/** A blank page, for the editor's "add page". */
export function blankPage(): EventPage {
  return { when: [], trigger: 'talk', blocks: true, do: [] }
}
