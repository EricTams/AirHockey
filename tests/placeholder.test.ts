import { describe, it, expect } from 'vitest'
import { wrapText } from '../src/world/placeholder'
import { MISSING_ART, findMissing } from '../src/world/missingArt'

/** Fixed-width measure so expectations are exact: 10px per character. */
const mono = (s: string) => s.length * 10

describe('wrapText', () => {
  it('keeps words on one line while they fit', () => {
    expect(wrapText('C2 LEFT', 100, mono)).toEqual(['C2 LEFT'])
  })

  it('wraps at word boundaries', () => {
    expect(wrapText('FACE C1 PORTRAIT', 80, mono)).toEqual(['FACE C1', 'PORTRAIT'])
  })

  it('hard-breaks a single word too wide to fit', () => {
    expect(wrapText('UNBREAKABLE', 40, mono)).toEqual(['UNBR', 'EAKA', 'BLE'])
  })

  it('handles a word exactly at the limit', () => {
    expect(wrapText('ABCD', 40, mono)).toEqual(['ABCD'])
  })

  it('collapses extra whitespace rather than emitting empty lines', () => {
    expect(wrapText('  A   B  ', 100, mono)).toEqual(['A B'])
  })

  it('returns nothing for empty input', () => {
    expect(wrapText('', 100, mono)).toEqual([])
  })
})

describe('MISSING_ART manifest', () => {
  it('has no duplicate paths', () => {
    const paths = MISSING_ART.map((m) => m.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('gives every entry a label, a reason and positive dimensions', () => {
    for (const m of MISSING_ART) {
      expect(m.label, m.path).toBeTruthy()
      expect(m.reason, m.path).toBeTruthy()
      expect(m.width, m.path).toBeGreaterThan(0)
      expect(m.height, m.path).toBeGreaterThan(0)
    }
  })

  it('looks an entry up by path, and misses cleanly', () => {
    expect(findMissing(MISSING_ART[0]!.path)?.label).toBe(MISSING_ART[0]!.label)
    expect(findMissing('assets/nope.png')).toBeUndefined()
  })
})
