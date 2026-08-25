import { describe, it, expect } from 'vitest'
import { ModeManager, type Mode } from '../src/core/mode'

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
