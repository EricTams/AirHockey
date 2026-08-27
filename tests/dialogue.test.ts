import { describe, it, expect } from 'vitest'
import { wrapMono, DialogueMode, parseDialogue } from '../src/modes/dialogue'
import { brokenScript } from '../src/modes/overworld'

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
