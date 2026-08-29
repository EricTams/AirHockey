import { describe, it, expect, beforeAll } from 'vitest'
import { wrapMono, DialogueMode, parseDialogue, parseLines, continuation } from '../src/modes/dialogue'
import { brokenScript } from '../src/modes/overworld'
import { GameState } from '../src/world/gameState'

describe('wrapMono', () => {
  it('keeps a short line intact', () => {
    expect(wrapMono('You there.', 20)).toEqual(['You there.'])
  })

  it('breaks at word boundaries within the column count', () => {
    expect(wrapMono('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  it('preserves explicit newlines as hard breaks', () => {
    expect(wrapMono('a\nb', 20)).toEqual(['a', 'b'])
  })

  it('puts a word longer than the column count on its own line', () => {
    // Better an overrun than an infinite loop; the box clips rather than hangs.
    expect(wrapMono('hi supercalifragilistic', 6)).toEqual(['hi', 'supercalifragilistic'])
  })

  it('handles an empty string', () => {
    expect(wrapMono('', 10)).toEqual([''])
  })
})

/**
 * Entering with nothing to say.
 *
 * This was a real trap: the debug mode key cycled through every registered
 * mode, so one press from the overworld entered `dialogue` with no payload.
 * The script fell back to zero lines, `update` returned before it could build
 * anything, and the box was never drawn — so the world kept rendering
 * underneath and simply stopped answering Z and the arrow keys. The only exit
 * from dialogue is advancing past the last line, and there was no line.
 *
 * The mode now leaves under its own power, whatever put it there.
 */
describe('DialogueMode entered with no script', () => {
  const stub = () => {
    const switched: { mode: string; payload?: unknown }[] = []
    const mode = new DialogueMode(
      {} as never,
      { pressed: () => false, held: () => false } as never,
      {} as never,
      { name: 'under', enter() {}, exit() {}, update() {}, render() {} },
      new GameState(),
    )
    mode.bindSwitch((m, payload) => switched.push({ mode: m, payload }))
    return { mode, switched }
  }

  it('asks to leave on its first update instead of sitting there', () => {
    const { mode, switched } = stub()
    mode.enter(undefined)
    mode.update(1 / 60)
    expect(switched).toEqual([{ mode: 'overworld', payload: undefined }])
  })

  it('honours the caller\'s next mode when it has one', () => {
    const { mode, switched } = stub()
    mode.enter({ script: { id: 'empty', lines: [] }, next: { mode: 'battle', payload: { a: 1 } } })
    mode.update(1 / 60)
    expect(switched).toEqual([{ mode: 'battle', payload: { a: 1 } }])
  })

  // The non-empty path is not asserted here: building a box needs the runtime
  // bitmap font, which needs a canvas, and the suite runs in node. It is
  // covered by playing a conversation in the browser.
})

/**
 * What a designer sees when they mistype a path in the entity editor.
 *
 * Every one of these references is hand-typed, so a typo is routine rather
 * than corruption. Silence is the one answer they cannot act on: an NPC with a
 * broken dialogue file behaves exactly like an NPC that never had one, and
 * like standing on the wrong tile.
 */
describe('brokenScript', () => {
  it('names the path that failed', () => {
    const s = brokenScript({ id: 'wing', dialogue: 'data/dialogue/plummer.json' })
    expect(s.lines[0]!.text).toContain('data/dialogue/plummer.json')
    expect(s.lines[0]!.name).toBe('wing')
  })

  it('is a valid script, so the box opens and can be advanced past', () => {
    // The whole point is that it behaves like an ordinary conversation: if it
    // did not parse, the player would be back in an empty dialogue.
    const s = brokenScript({ id: 'wing', dialogue: 'nope.json' })
    expect(() => parseDialogue(s, 'broken')).not.toThrow()
    expect(s.lines).toHaveLength(1)
  })

  it('does not collide with a real script id', () => {
    expect(brokenScript({ id: 'wing', dialogue: 'x' }).id).toBe('broken:wing')
  })
})

/**
 * Branching dialogue: a line can offer options, and an option can jump.
 *
 * The format is validated at load rather than at the moment the player picks:
 * an option that jumps nowhere is a conversation that dead-ends in front of the
 * player, and there is nothing they can do about it by then.
 */
describe('parseDialogue with choices', () => {
  const script = (lines: unknown[]) => ({ id: 'x', lines })

  it('accepts options that jump to a label', () => {
    expect(() => parseDialogue(script([
      { text: 'First to three?', choices: [
        { text: "You're on.", goto: 'yes' },
        { text: 'Not now.', goto: 'stop', setFlag: 'ducked' },
      ] },
      { label: 'yes', text: 'Rack them up.' },
    ]), 'x')).not.toThrow()
  })

  it('rejects a goto that names no label', () => {
    expect(() => parseDialogue(script([
      { text: 'q', choices: [{ text: 'a', goto: 'nowhere' }] },
    ]), 'x')).toThrow(/no line is labelled/)
  })

  it('names the option that is wrong, not just the line', () => {
    expect(() => parseDialogue(script([
      { text: 'q', choices: [{ text: 'a' }, { text: '' }] },
    ]), 'x')).toThrow(/line\[0\]: choices\[1\]/)
  })

  it('rejects an empty options list', () => {
    // A line that says it asks something and then offers nothing leaves the
    // player pressing interact at a box that will not move on.
    expect(() => parseDialogue(script([{ text: 'q', choices: [] }]), 'x'))
      .toThrow(/at least one option/)
  })

  it('rejects two lines with the same label', () => {
    expect(() => parseDialogue(script([
      { label: 'a', text: '1' }, { label: 'a', text: '2' },
    ]), 'x')).toThrow(/duplicate label/)
  })

  it('refuses to let a label shadow a reserved destination', () => {
    // A line labelled "end" would make `goto: "end"` mean two things.
    expect(() => parseDialogue(script([{ label: 'end', text: '1' }]), 'x'))
      .toThrow(/reserved/)
  })

  it('rejects a non-boolean flag value', () => {
    expect(() => parseDialogue(script([
      { text: 'q', choices: [{ text: 'a', setFlag: 'f', to: 'yes' }] },
    ]), 'x')).toThrow(/"to" must be true or false/)
  })

  it('validates an inline say block the same way', () => {
    // The event editor writes these, and they are the same shape as a file.
    expect(() => parseLines([{ text: 'q', choices: [{ text: 'a', goto: 'gone' }] }], 'say'))
      .toThrow(/no line is labelled/)
  })
})

describe('continuation', () => {
  const lines = [
    { text: 'q' },
    { label: 'yes', text: 'a' },
    { text: 'b' },
  ]

  it('falls through to the next line when nothing says otherwise', () => {
    expect(continuation(lines, 0)).toEqual({ kind: 'line', index: 1 })
  })

  it('ends after the last line', () => {
    expect(continuation(lines, 2)).toEqual({ kind: 'end' })
  })

  it('finds a label anywhere in the script, including backwards', () => {
    expect(continuation(lines, 2, 'yes')).toEqual({ kind: 'line', index: 1 })
  })

  it('reads the two reserved destinations', () => {
    expect(continuation(lines, 0, 'end')).toEqual({ kind: 'end' })
    expect(continuation(lines, 0, 'stop')).toEqual({ kind: 'stop' })
  })

  it('ends rather than stranding the player on an unvalidated goto', () => {
    expect(continuation(lines, 0, 'missing')).toEqual({ kind: 'end' })
  })
})

/**
 * Playing a conversation that branches.
 *
 * The suite runs in node, and building the box needs the runtime bitmap font,
 * which needs a canvas — so this stubs one. It is worth the stub: everything
 * the player experiences of a choice happens in `update`, and none of it is
 * reachable from the pure helpers above.
 */
describe('DialogueMode with choices', () => {
  const canvas = () => ({
    width: 0, height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false, fillStyle: '', textAlign: '', textBaseline: '', font: '',
      clearRect() {}, fillText() {},
    }),
  })
  beforeAll(() => {
    ;(globalThis as { document?: unknown }).document ??= { createElement: canvas }
  })

  const script = {
    id: 'blorb',
    lines: [
      { text: 'First to three?', choices: [
        { text: "You're on.", goto: 'yes', setFlag: 'agreed' },
        { text: 'Not now.', goto: 'stop' },
      ] },
      { label: 'yes', text: 'Rack them up.' },
    ],
  }

  /** A mode wired to a one-button-per-tick input, and what it asked for. */
  const play = (next = { mode: 'battle', payload: { config: 1 } }) => {
    let press: string | undefined
    const switched: { mode: string; payload?: unknown }[] = []
    const state = new GameState()
    const mode = new DialogueMode(
      {} as never,
      { pressed: (b: string) => press === b, held: () => false } as never,
      {} as never,
      { name: 'under', enter() {}, exit() {}, update() {}, render() {} },
      state,
    )
    mode.bindSwitch((m, payload) => switched.push({ mode: m, payload }))
    mode.enter({ script: parseDialogue(script, 'blorb'), next })
    const tick = (button?: string) => { press = button; mode.update(1 / 60); press = undefined }
    // The first press finishes the typewriter, which is doc §7.2 and is what
    // makes the options appear at all.
    tick('interact')
    return { tick, switched, state }
  }

  it('picks the highlighted option and follows it', () => {
    const { tick, switched, state } = play()
    tick('interact')
    expect(state.flag('agreed')).toBe(true)
    // Jumped to "yes", which is the last line, so the next press ends the
    // script and hands off to the battle the NPC was carrying.
    expect(switched).toEqual([])
    tick('interact')
    tick('interact')
    expect(switched).toEqual([{ mode: 'battle', payload: { config: 1 } }])
  })

  it('moves the highlight, wrapping past the ends', () => {
    const { tick, switched, state } = play()
    tick('up')                       // wraps from the first option to the last
    tick('interact')
    // "Not now." calls it off: back to the world, and the battle does not run.
    expect(switched).toEqual([{ mode: 'overworld', payload: { dialogueStopped: true } }])
    expect(state.flag('agreed')).toBe(false)
  })

  it('does not pick with the press that finishes the line', () => {
    // Otherwise a player who mashes through the text answers a question they
    // have not read, and the first option is always the one they "chose".
    const { switched } = play()
    expect(switched).toEqual([])
  })
})
