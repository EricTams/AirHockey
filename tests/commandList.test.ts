import { describe, it, expect } from 'vitest'
import {
  listAt, commandAt, sublistAt, insertAfter, removeAt, moveAt, flatten,
  summarize, describeAll, sublistsOf, problems, COMMAND_KINDS,
} from '../src/editor/commandList'
import { parseCommand, type Command } from '../src/world/event'

/**
 * An off-by-one in an insert puts a designer's command in the wrong branch of
 * their own logic — visible only when the event runs, and then only sometimes.
 * These are the tests that stop that.
 */

function tree(): Command[] {
  return [
    { setFlag: 'a', to: true },
    {
      if: [{ flag: 'a', is: true }],
      then: [{ wait: 10 }, { setVar: 'n', to: 1 }],
      else: [{ stop: true }],
    },
    { wait: 5 },
  ]
}

describe('paths', () => {
  it('finds a top-level command', () => {
    expect(commandAt(tree(), [2])).toEqual({ wait: 5 })
  })

  it('finds one nested in a branch', () => {
    expect(commandAt(tree(), [1, 'then', 1])).toEqual({ setVar: 'n', to: 1 })
  })

  it('names the sublist itself when the path ends in a key', () => {
    expect(sublistAt(tree(), [1, 'else'])).toEqual([{ stop: true }])
  })

  it('returns the containing list, not the item', () => {
    expect(listAt(tree(), [1, 'then', 0])).toHaveLength(2)
    expect(listAt(tree(), [])).toHaveLength(3)
  })

  it('gives nothing for a path into a sublist that does not exist', () => {
    expect(commandAt(tree(), [0, 'then', 0])).toBeUndefined()
    expect(sublistAt(tree(), [2, 'do'])).toBeUndefined()
  })
})

describe('insertAfter', () => {
  it('inserts after a top-level command, not at the end', () => {
    const root = tree()
    insertAfter(root, [0], { stop: true })
    expect(root[1]).toEqual({ stop: true })
    expect(root).toHaveLength(4)
  })

  it('inserts inside the branch it was given', () => {
    const root = tree()
    insertAfter(root, [1, 'then', 0], { break: true })
    const then = sublistAt(root, [1, 'then'])!
    expect(then[1]).toEqual({ break: true })
    expect(then).toHaveLength(3)
  })

  it('appends when given a sublist rather than an item', () => {
    const root = tree()
    insertAfter(root, [1, 'then'], { break: true })
    expect(sublistAt(root, [1, 'then'])).toHaveLength(3)
  })

  it('creates an optional sublist that was absent', () => {
    // `else`, `won` and `lost` are optional in the format; adding to one is how
    // it comes into existence.
    const root: Command[] = [{ battle: 'b.json' }]
    expect(insertAfter(root, [0, 'won'], { stop: true })).toBe(true)
    expect(sublistAt(root, [0, 'won'])).toEqual([{ stop: true }])
  })
})

describe('removeAt and moveAt', () => {
  it('removes a nested command without touching its siblings', () => {
    const root = tree()
    removeAt(root, [1, 'then', 0])
    expect(sublistAt(root, [1, 'then'])).toEqual([{ setVar: 'n', to: 1 }])
  })

  it('refuses a path that names nothing', () => {
    const root = tree()
    expect(removeAt(root, [9])).toBe(false)
    expect(removeAt(root, [1, 'then'])).toBe(false)
  })

  it('moves within its own list', () => {
    const root = tree()
    expect(moveAt(root, [1, 'then', 1], -1)).toBe(true)
    expect(sublistAt(root, [1, 'then'])![0]).toEqual({ setVar: 'n', to: 1 })
  })

  it('will not move off either end, or between branches', () => {
    const root = tree()
    expect(moveAt(root, [1, 'then', 0], -1)).toBe(false)
    expect(moveAt(root, [1, 'then', 1], 1)).toBe(false)
    expect(sublistAt(root, [1, 'then'])).toHaveLength(2)
  })
})

describe('flatten', () => {
  it('indents a branch under the command that owns it', () => {
    const rows = flatten(tree())
    const kinds = rows.map((r) => `${r.depth}:${r.kind}`)
    expect(kinds.slice(0, 4)).toEqual(['0:command', '0:command', '1:heading', '2:command'])
  })

  it('offers an absent optional branch rather than hiding it', () => {
    const rows = flatten([{ battle: 'b.json' }])
    expect(rows.filter((r) => r.kind === 'heading').map((r) => r.text)).toEqual(['won', 'lost'])
    expect(rows.filter((r) => r.kind === 'empty')).toHaveLength(2)
  })

  it('gives every command row a path that finds it again', () => {
    const root = tree()
    for (const row of flatten(root)) {
      if (row.kind !== 'command') continue
      expect(commandAt(root, row.path)).toBe(row.command)
    }
  })
})

describe('sublistsOf', () => {
  it('knows which branches each command carries', () => {
    expect(sublistsOf({ if: [], then: [] })).toEqual(['then', 'else'])
    expect(sublistsOf({ battle: 'x' })).toEqual(['won', 'lost'])
    expect(sublistsOf({ wait: 1 })).toEqual([])
  })
})

describe('summaries', () => {
  it('says what a command does in one line', () => {
    expect(summarize({ setFlag: 'a', to: true })).toBe('Set flag a = true')
    expect(summarize({ wait: 30 })).toBe('Wait 30 frames')
    expect(summarize({ say: [{ name: 'Blorb', text: 'Hello there' }] }))
      .toBe('Say — Blorb: Hello there')
  })

  it('clips a long line rather than filling the panel', () => {
    const long = summarize({ say: [{ text: 'x'.repeat(200) }] })
    expect(long.length).toBeLessThan(60)
  })

  it('reads an empty condition list as always', () => {
    expect(describeAll([])).toBe('(always)')
    expect(describeAll([{ flag: 'a', is: false }, { var: 'n', op: '>=', value: 2 }]))
      .toBe('a is false and n >= 2')
  })
})

describe('COMMAND_KINDS', () => {
  it('gives flags and variables a usable default name', () => {
    // Any non-empty string is a valid name, so there is no reason to make the
    // designer type one before the command is even legal.
    for (const id of ['setFlag', 'setVar', 'addVar']) {
      const made = COMMAND_KINDS.find((k) => k.id === id)!.make()
      expect(() => parseCommand(made, id)).not.toThrow()
    }
  })

  it('leaves file paths empty, and reports them as unfinished', () => {
    // There is no sensible default dialogue file, and a made-up one would
    // validate and then fail at runtime.
    const made = COMMAND_KINDS.filter((k) => ['script', 'battle', 'warp'].includes(k.id))
      .map((k) => k.make())
    expect(problems(made)).toHaveLength(3)
  })

  it('reports an unfinished command inside a branch, with its path', () => {
    const root = [{ if: [], then: [{ script: '' }] }] as never
    expect(problems(root)).toEqual([{ path: [0, 'then', 0], message: 'no dialogue file chosen' }])
  })

  it('finds nothing wrong with a finished list', () => {
    expect(problems([
      { say: [{ text: 'hello' }] },
      { battle: 'data/battles/blorb.json' },
    ])).toEqual([])
  })

  it('makes a fresh object every time', () => {
    const a = COMMAND_KINDS[0]!.make()
    const b = COMMAND_KINDS[0]!.make()
    expect(a).not.toBe(b)
  })
})
