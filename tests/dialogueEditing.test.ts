import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { continuation, parseDialogue } from '../src/modes/dialogue'
import { serializeDialogue } from '../src/editor/dialogueFile'
import { DialogueDoc, blankDialogue } from '../src/editor/dialogueDoc'

const SHIPPED = ['blorb', 'wing', 'plumber']

describe('parseDialogue', () => {
  it('accepts every shipped script', () => {
    for (const id of SHIPPED) {
      const raw = JSON.parse(readFileSync(`public/data/dialogue/${id}.json`, 'utf8'))
      expect(() => parseDialogue(raw, id)).not.toThrow()
    }
  })

  it('rejects a script with no lines', () => {
    // The mode only leaves on interact, and with no line there is nothing to
    // advance: the player would be stuck in the box.
    expect(() => parseDialogue({ id: 'x', lines: [] }, 'x')).toThrow(/no lines/)
  })

  it('rejects a line with no text', () => {
    expect(() => parseDialogue({ id: 'x', lines: [{ name: 'A' }] }, 'x')).toThrow(/"text"/)
  })

  it('rejects a missing id', () => {
    expect(() => parseDialogue({ lines: [{ text: 'hi' }] }, 'x')).toThrow(/"id"/)
  })

  it('names the offending line', () => {
    expect(() => parseDialogue({ id: 'x', lines: [{ text: 'a' }, { text: 1 }] }, 'x'))
      .toThrow(/line\[1\]/)
  })
})

describe('the shipped Blorb script', () => {
  const blorb = parseDialogue(
    JSON.parse(readFileSync('public/data/dialogue/blorb.json', 'utf8')), 'blorb')
  const asked = blorb.lines.findIndex((l) => l.choices)

  it('offers the challenge as something the player can turn down', () => {
    expect(blorb.lines[asked]!.choices).toHaveLength(2)
  })

  it('declining calls the match off rather than starting it', () => {
    // Blorb is an entry in `npcs[]`, so ending the conversation hands off to
    // his battle file whatever was said. Only `stop` means no.
    const declined = blorb.lines[asked]!.choices!.at(-1)!
    const branch = continuation(blorb.lines, asked, declined.goto)
    expect(branch.kind).toBe('line')
    const line = branch.kind === 'line' ? branch.index : -1
    expect(continuation(blorb.lines, line, blorb.lines[line]!.goto)).toEqual({ kind: 'stop' })
    expect(declined.setFlag).toBe('ducked-blorb')
  })

  it('accepting reaches the end, and the battle behind it', () => {
    const accepted = blorb.lines[asked]!.choices![0]!
    const branch = continuation(blorb.lines, asked, accepted.goto)
    const line = branch.kind === 'line' ? branch.index : -1
    expect(continuation(blorb.lines, line, blorb.lines[line]!.goto)).toEqual({ kind: 'end' })
  })
})

describe('serializeDialogue', () => {
  it('reproduces the hand-authored files byte for byte', () => {
    for (const id of SHIPPED) {
      const text = readFileSync(`public/data/dialogue/${id}.json`, 'utf8')
      expect(serializeDialogue(parseDialogue(JSON.parse(text), id))).toBe(text)
    }
  })

  it('keeps the text of one line on one line', () => {
    const out = serializeDialogue({
      id: 'x',
      lines: [{ name: 'A', face: 'f.png', text: 'a very long piece of dialogue indeed' }],
    })
    const textLines = out.split('\n').filter((l) => l.includes('"text"'))
    expect(textLines).toHaveLength(1)
    expect(textLines[0]).toContain('a very long piece of dialogue indeed" }')
  })

  it('omits name and face when a line has neither', () => {
    const out = serializeDialogue({ id: 'x', lines: [{ text: 'just narration' }] })
    expect(out).not.toContain('"name"')
    expect(out).toContain('{ "text": "just narration" }')
  })

  it('round-trips through validation', () => {
    const script = { id: 'x', lines: [{ name: 'A', text: 'one' }, { text: 'two' }] }
    expect(parseDialogue(JSON.parse(serializeDialogue(script)), 'x')).toEqual(script)
  })
})

describe('DialogueDoc', () => {
  const script = () => ({
    id: 'blorb',
    lines: [
      { name: 'Blorb', face: 'f.png', text: 'one' },
      { name: 'Blorb', face: 'f.png', text: 'two' },
    ],
  })

  it('carries the speaker forward onto a new line', () => {
    // Retyping the name and portrait for every consecutive line is the tedious
    // part of writing a conversation.
    const doc = new DialogueDoc('p', script())
    doc.select(0)
    doc.addLine()
    expect(doc.lines[1]).toEqual({ name: 'Blorb', face: 'f.png', text: '' })
    expect(doc.selected).toBe(1)
  })

  it('refuses to delete the last line', () => {
    const doc = new DialogueDoc('p', blankDialogue('solo'))
    expect(doc.removeLine(0)).toBe(false)
    expect(doc.lines).toHaveLength(1)
  })

  it('deletes and selects a line that still exists', () => {
    const doc = new DialogueDoc('p', script())
    doc.select(1)
    expect(doc.removeLine(1)).toBe(true)
    expect(doc.selected).toBe(0)
  })

  it('reorders and follows the moved line with the selection', () => {
    const doc = new DialogueDoc('p', script())
    expect(doc.moveLine(0, 1)).toBe(true)
    expect(doc.lines.map((l) => l.text)).toEqual(['two', 'one'])
    expect(doc.selected).toBe(1)
  })

  it('will not move a line off either end', () => {
    const doc = new DialogueDoc('p', script())
    expect(doc.moveLine(0, -1)).toBe(false)
    expect(doc.moveLine(1, 1)).toBe(false)
  })

  it('undoes a structural edit', () => {
    const doc = new DialogueDoc('p', script())
    doc.removeLine(1)
    expect(doc.lines).toHaveLength(1)
    expect(doc.undo()).toBe(true)
    expect(doc.lines.map((l) => l.text)).toEqual(['one', 'two'])
    expect(doc.redo()).toBe(true)
    expect(doc.lines).toHaveLength(1)
  })

  it('drops an emptied name rather than writing an empty string', () => {
    // The format treats name and face as optional and the renderer keys off
    // their absence, so "" would draw an empty speaker label.
    const doc = new DialogueDoc('p', script())
    doc.select(0)
    doc.setField('name', '')
    expect('name' in doc.lines[0]!).toBe(false)
  })

  it('tracks dirty against the saved content, not a flag', () => {
    const doc = new DialogueDoc('p', script())
    expect(doc.dirty).toBe(false)
    doc.setField('text', 'changed')
    expect(doc.dirty).toBe(true)
    doc.setField('text', 'one')
    expect(doc.dirty).toBe(false)
  })
})

/**
 * Authoring choices.
 *
 * The traps here are all about the things that hang off a line rather than the
 * line itself: a snapshot that shares the options array undoes nothing, a
 * duplicated label fails validation on the next save, and a deleted line takes
 * every jump to it with it.
 */
describe('DialogueDoc choices', () => {
  const withQuestion = () => {
    const doc = new DialogueDoc('data/dialogue/x.json', {
      id: 'x', lines: [{ text: 'First to three?' }, { label: 'yes', text: 'Rack them up.' }],
    })
    doc.addChoice()
    doc.addChoice()
    return doc
  }

  it('adds options that are valid the moment they exist', () => {
    // An option with no text fails validation, so a designer who adds one and
    // saves before typing would be refused for something they did not do.
    const doc = withQuestion()
    expect(doc.lines[0]!.choices?.map((c) => c.text)).toEqual(['Yes', 'No'])
    expect(() => parseDialogue(JSON.parse(serializeDialogue(doc.value)), 'x')).not.toThrow()
  })

  it('undoes an edit to an option', () => {
    const doc = withQuestion()
    doc.setChoice(0, { goto: 'yes' })
    expect(doc.lines[0]!.choices![0]!.goto).toBe('yes')
    doc.undo()
    expect(doc.lines[0]!.choices![0]!.goto).toBeUndefined()
  })

  it('removing the last option leaves a plain line', () => {
    const doc = withQuestion()
    doc.removeChoice(1)
    doc.removeChoice(0)
    expect('choices' in doc.lines[0]!).toBe(false)
  })

  it('reorders options', () => {
    const doc = withQuestion()
    doc.moveChoice(0, 1)
    expect(doc.lines[0]!.choices?.map((c) => c.text)).toEqual(['No', 'Yes'])
    expect(doc.moveChoice(1, 1)).toBe(false)
  })

  it('repoints jumps when a label is renamed', () => {
    const doc = withQuestion()
    doc.setChoice(0, { goto: 'yes' })
    doc.select(1)
    doc.setLabel('agreed')
    expect(doc.lines[0]!.choices![0]!.goto).toBe('agreed')
  })

  it('drops jumps to a line that is deleted', () => {
    const doc = withQuestion()
    doc.setChoice(0, { goto: 'yes' })
    doc.removeLine(1)
    expect(doc.lines[0]!.choices![0]!.goto).toBeUndefined()
    expect(() => parseDialogue(JSON.parse(serializeDialogue(doc.value)), 'x')).not.toThrow()
  })

  it('duplicating a line does not duplicate its label or share its options', () => {
    const doc = withQuestion()
    doc.duplicateLine(0)
    doc.select(1)
    doc.setChoice(0, { text: 'changed' })
    expect(doc.lines[0]!.choices![0]!.text).toBe('Yes')
    expect(doc.lines.filter((l) => l.label === 'yes')).toHaveLength(1)
  })

  it('offers every label but the selected line\'s own', () => {
    const doc = withQuestion()
    expect(doc.labels()).toEqual(['yes'])
    doc.select(1)
    expect(doc.labels()).toEqual([])
  })
})

describe('serializeDialogue with choices', () => {
  const branching = {
    id: 'blorb',
    lines: [
      { name: 'Blorb', face: 'assets/faces/civilian-1.png', text: 'First to three?', choices: [
        { text: "You're on.", goto: 'yes' },
        { text: 'Not now.', goto: 'stop', setFlag: 'ducked-blorb' },
        { text: 'Say that again?', setFlag: 'heard', to: false },
      ] },
      { label: 'yes', name: 'Blorb', text: 'Rack them up.', goto: 'end' },
      { name: 'Blorb', text: 'Suit yourself.' },
    ],
  }

  it('writes what parseDialogue reads back', () => {
    const text = serializeDialogue(branching)
    expect(() => parseDialogue(JSON.parse(text), 'x')).not.toThrow()
    expect(serializeDialogue(parseDialogue(JSON.parse(text), 'x'))).toBe(text)
  })

  it('keeps one option per line, so a reworded option reads as one', () => {
    const rows = serializeDialogue(branching).split('\n').filter((l) => l.includes('"goto": "yes"'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("You're on.")
  })
})
