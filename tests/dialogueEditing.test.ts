import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseDialogue } from '../src/modes/dialogue'
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
