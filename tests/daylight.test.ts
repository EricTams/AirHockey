import { describe, it, expect } from 'vitest'
import {
  castOffset, daylightAt, hourLabel, HOURS, HOUR_PHASE, normalizeHour,
  phaseAt, PHASE_LIGHT, sunAt, DEFAULT_HOUR,
} from '../src/world/daylight'

/** Length of the shadow a one-tile-tall thing throws at a given hour. */
function shadow(hour: number): { dx: number; dz: number; len: number } {
  const { dx, dz } = castOffset(1, sunAt(hour))
  return { dx, dz, len: Math.hypot(dx, dz) }
}

describe('the clock', () => {
  it('names a phase for every hour, and only hours', () => {
    expect(HOUR_PHASE).toHaveLength(HOURS)
    for (let h = 0; h < HOURS; h++) expect(HOUR_PHASE[h]).toBeTruthy()
  })

  it('reads dawn as yellow, midday as nothing, evening as red and night as blue', () => {
    expect(phaseAt(6)).toBe('dawn')
    expect(phaseAt(12)).toBe('day')
    expect(phaseAt(18)).toBe('dusk')
    expect(phaseAt(23)).toBe('night')
  })

  // A slider is not the only thing that will ever set this, and a map file is
  // written by hand often enough that a bad hour must land somewhere sane
  // rather than indexing off the end of the table.
  it('pulls anything into the clock', () => {
    expect(normalizeHour(-3)).toBe(0)
    expect(normalizeHour(99)).toBe(HOURS - 1)
    expect(normalizeHour(6.4)).toBe(6)
    expect(normalizeHour(Number.NaN)).toBe(DEFAULT_HOUR)
  })

  it('labels an hour with the phase, so the number is not the only clue', () => {
    expect(hourLabel(6)).toBe('06:00 · dawn')
  })
})

/**
 * Midday must draw exactly what the world drew before there were hours. If this
 * fails the game has quietly changed colour everywhere, at the hour every map
 * without an opinion is drawn at.
 */
describe('the middle of the day', () => {
  it('is the identity: no multiply, no wash, full-strength shadows', () => {
    const day = PHASE_LIGHT.day
    expect(day.mul).toBe(0xffffff)
    expect(day.washAmount).toBe(0)
    expect(day.shadow).toBe(1)
  })

  it('is what a map with no hour of its own gets', () => {
    expect(daylightAt(DEFAULT_HOUR).phase).toBe('day')
  })
})

/**
 * The sun sits in the south all day, behind the camera. Getting the sign of Z
 * wrong points every shadow at the camera instead of away from it, which reads
 * as light coming from behind the player — plausible enough on one prop to miss.
 */
describe('the sun over the day', () => {
  it('throws every shadow away from the camera, at every hour', () => {
    for (let h = 0; h < HOURS; h++) {
      expect(shadow(h).dz, `hour ${h}`).toBeLessThanOrEqual(0)   // north; Z runs south
    }
  })

  // The world draws every shadow from one group beneath every sprite, which is
  // only right while a shadow falls on ground the things behind it are already
  // drawn on. Past a quarter turn off north that stops being true, silently.
  it('never swings a shadow sideways, let alone toward the camera', () => {
    for (let h = 0; h < HOURS; h++) {
      expect(Math.abs(sunAt(h).bearingDeg), `hour ${h}`).toBeLessThan(90)
    }
  })

  it('runs west in the morning and east in the evening', () => {
    expect(shadow(6).dx).toBeLessThan(0)      // morning sun in the east, shadow west
    expect(shadow(18).dx).toBeGreaterThan(0)  // evening sun in the west, shadow east
  })

  it('is shortest around noon and longest at either end of the day', () => {
    const noon = shadow(12).len
    expect(noon).toBeLessThan(shadow(6).len)
    expect(noon).toBeLessThan(shadow(19).len)
  })

  it('keeps moving through the middle of the day, where the colour holds still', () => {
    expect(phaseAt(9)).toBe(phaseAt(15))
    expect(shadow(9).dx).toBeLessThan(shadow(15).dx)
  })

  // After dark the moon stands in, and it stands where the sun does.
  it('throws a short shadow straight up the screen at night', () => {
    expect(shadow(2).dx).toBeCloseTo(0, 6)
    expect(shadow(2).len).toBeLessThan(shadow(6).len)
  })
})

describe('castOffset', () => {
  const sun = { bearingDeg: 45, tiltDeg: 30 }

  it('leans out by the tangent of the tilt', () => {
    const { dx, dz } = castOffset(4, sun)
    expect(Math.hypot(dx, dz)).toBeCloseTo(4 * Math.tan(30 * Math.PI / 180), 6)
  })

  it('scales with height, so a tall prop throws a long shadow', () => {
    const one = castOffset(1, sun)
    const three = castOffset(3, sun)
    expect(three.dx).toBeCloseTo(one.dx * 3, 6)
    expect(three.dz).toBeCloseTo(one.dz * 3, 6)
  })

  it('casts nothing from something with no height', () => {
    expect(castOffset(0, sun)).toEqual({ dx: 0, dz: -0 })
  })
})
