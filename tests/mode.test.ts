import { describe, it, expect } from 'vitest'
import { ModeManager, type Mode, nextDebugMode } from '../src/core/mode'

function spyMode(name: string, log: string[]): Mode {
  return {
    name,
    enter: (p) => log.push(`enter:${name}${p === undefined ? '' : `(${String(p)})`}`),
    exit: () => log.push(`exit:${name}`),
    update: () => log.push(`update:${name}`),
    render: () => log.push(`render:${name}`),
  }
}

describe('ModeManager', () => {
  it('defers a switch to the next update, then enters exactly once', () => {
    const log: string[] = []
    const m = new ModeManager()
    m.register(spyMode('a', log))
    m.register(spyMode('b', log))

    m.switchTo('a')
    expect(m.activeName).toBe('<none>')   // not applied until update
    expect(log).toEqual([])

    m.update(1 / 60)
    expect(m.activeName).toBe('a')
    expect(log).toEqual(['enter:a', 'update:a'])
  })

  it('exits the old mode before entering the new one', () => {
    const log: string[] = []
    const m = new ModeManager()
    m.register(spyMode('a', log))
    m.register(spyMode('b', log))
    m.switchTo('a'); m.update(0)
    log.length = 0

    m.switchTo('b'); m.update(0)
    expect(log).toEqual(['exit:a', 'enter:b', 'update:b'])
  })

  it('lets a mode request a switch from inside its own update without re-entrancy', () => {
    const log: string[] = []
    const m = new ModeManager()
    const a: Mode = {
      name: 'a',
      enter: () => log.push('enter:a'),
      exit: () => log.push('exit:a'),
      update: () => { log.push('update:a'); m.switchTo('b') },
      render: () => {},
    }
    m.register(a)
    m.register(spyMode('b', log))
    m.switchTo('a')

    m.update(0)                              // enters a, a requests b
    expect(log).toEqual(['enter:a', 'update:a'])
    expect(m.activeName).toBe('a')           // still a for the rest of this tick
    m.update(0)
    expect(m.activeName).toBe('b')
    expect(log).toEqual(['enter:a', 'update:a', 'exit:a', 'enter:b', 'update:b'])
  })

  it('forwards a payload to enter()', () => {
    const log: string[] = []
    const m = new ModeManager()
    m.register(spyMode('battle', log))
    m.switchTo('battle', 'battles/npc_a.json')
    m.update(0)
    expect(log[0]).toBe('enter:battle(battles/npc_a.json)')
  })

  it('rejects an unknown mode name at request time', () => {
    const m = new ModeManager()
    expect(() => m.switchTo('nope')).toThrow(/unknown mode/)
  })

  it('renders nothing before any mode is active', () => {
    const m = new ModeManager()
    expect(() => m.render()).not.toThrow()
  })
})

/**
 * The debug cycle key. It used to walk `modes.names`, which is every
 * registered mode — including the two that are entered *with* something.
 * Cycling into `battle` cold threw "battle requires a config payload", and
 * cycling into `dialogue` cold opened a conversation with no lines: it drew
 * nothing, and the only way out of dialogue is advancing past the last line,
 * so there was nothing to advance and no box to say so. The world simply
 * stopped responding to Z and to the arrow keys.
 */
describe('nextDebugMode', () => {
  it('cycles the modes that can be entered on their own', () => {
    expect(nextDebugMode('overworld')).toBe('gallery')
    expect(nextDebugMode('gallery')).toBe('overworld')
  })

  it('never offers a mode that needs a payload', () => {
    const seen = new Set<string>()
    let at = 'overworld'
    for (let i = 0; i < 10; i++) { at = nextDebugMode(at); seen.add(at) }
    expect(seen).not.toContain('dialogue')
    expect(seen).not.toContain('battle')
  })

  it('lets the key double as a way out of a real conversation or battle', () => {
    expect(nextDebugMode('dialogue')).toBe('overworld')
    expect(nextDebugMode('battle')).toBe('overworld')
  })

  it('handles a single-entry cycle without dividing by zero or repeating', () => {
    expect(nextDebugMode('overworld', ['overworld'])).toBe('overworld')
  })
})

/**
 * The other half of the same bug: a mode must be able to leave itself. This is
 * the shape DialogueMode relies on — a mode that requests a switch from inside
 * its own update, which the manager defers to the next tick.
 */
describe('a mode that switches away from itself on entry', () => {
  it('leaves on the next update rather than re-entering', () => {
    const modes = new ModeManager()
    const log: string[] = []
    const stuck: Mode = {
      name: 'stuck',
      enter: () => log.push('enter stuck'),
      exit: () => log.push('exit stuck'),
      update: () => { log.push('update stuck'); modes.switchTo('home') },
      render: () => {},
    }
    const home: Mode = {
      name: 'home',
      enter: () => log.push('enter home'),
      exit: () => {}, update: () => { log.push('update home') }, render: () => {},
    }
    modes.register(stuck)
    modes.register(home)

    modes.switchTo('stuck')
    modes.update(1)        // enters stuck, its update asks to leave
    modes.update(1)        // the switch lands
    modes.update(1)

    expect(log).toEqual([
      'enter stuck', 'update stuck',
      'exit stuck', 'enter home', 'update home',
      'update home',
    ])
    expect(modes.activeName).toBe('home')
  })
})
