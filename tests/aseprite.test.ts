import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { frameAtTime, type SpriteSheet } from '../src/world/aseprite'
import { FACINGS, type CharacterDef } from '../src/world/character'

/**
 * Wall-clock frame selection. This is what an idle runs on: nothing is moving,
 * so unlike the walk cycle there is no distance to lock the animation to, and
 * the exported per-frame durations are the only timing there is.
 */
describe('frameAtTime', () => {
  const sheet = (durations: number[]): SpriteSheet => ({
    texture: undefined as never,
    frames: durations.map((durationMs, i) => ({
      x: i, y: 0, w: 1, h: 1, durationMs, u0: 0, u1: 1, v0: 0, v1: 1,
    })),
    width: durations.length,
    height: 1,
    totalMs: durations.reduce((a, b) => a + b, 0),
  })

  it('holds each frame for its own duration', () => {
    const s = sheet([100, 100])
    expect(frameAtTime(s, 0)).toBe(0)
    expect(frameAtTime(s, 99)).toBe(0)
    expect(frameAtTime(s, 100)).toBe(1)
    expect(frameAtTime(s, 199)).toBe(1)
  })

  it('loops', () => {
    const s = sheet([100, 100])
    expect(frameAtTime(s, 200)).toBe(0)
    expect(frameAtTime(s, 350)).toBe(1)
    expect(frameAtTime(s, 100_000)).toBe(0)
  })

  it('honours uneven durations rather than dividing the cycle evenly', () => {
    // A long hold and a short blink is a common idle; splitting 400ms in two
    // would show the blink for half the cycle.
    const s = sheet([300, 100])
    expect(frameAtTime(s, 299)).toBe(0)
    expect(frameAtTime(s, 300)).toBe(1)
    expect(frameAtTime(s, 400)).toBe(0)
  })

  it('returns the first frame for a zero-length cycle rather than dividing by it', () => {
    expect(frameAtTime(sheet([0, 0]), 50)).toBe(0)
  })
})

/**
 * The character defs are hand-edited JSON with no validation layer — they are
 * fetched and cast. A mistyped sheet path therefore fails at runtime as a
 * placeholder in the world, which is exactly the kind of thing that is easy to
 * miss and cheap to check here.
 */
describe('shipped character definitions', () => {
  const dir = 'public/data/characters'
  const defs = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as CharacterDef] as const)

  it('finds some', () => expect(defs.length).toBeGreaterThan(0))

  it.each(defs)('%s points at sheets that exist, in both poses', (_name, def) => {
    const paths = [
      ...Object.values(def.directions ?? {}),
      ...Object.values(def.idle ?? {}),
    ]
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      expect(existsSync(`public/${p}`), `${p} is missing`).toBe(true)
      expect(existsSync(`public/${p.replace(/\.json$/, '.png')}`), `${p} has no png`).toBe(true)
    }
  })

  it.each(defs)('%s only mirrors real facings', (_name, def) => {
    for (const f of def.mirror ?? []) expect(FACINGS).toContain(f)
  })
})
