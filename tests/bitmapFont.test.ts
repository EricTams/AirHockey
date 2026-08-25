import { describe, it, expect } from 'vitest'
import { uvIndex, FIRST_CHAR, LAST_CHAR } from '../src/ui/bitmapFont'

describe('bitmap font atlas indexing', () => {
  it('maps space to index 0 and tilde to the last index', () => {
    expect(uvIndex(FIRST_CHAR)).toBe(0)
    expect(uvIndex(LAST_CHAR)).toBe(LAST_CHAR - FIRST_CHAR)
  })

  it('maps printable ASCII contiguously', () => {
    expect(uvIndex('A'.charCodeAt(0))).toBe(65 - FIRST_CHAR)
    expect(uvIndex('a'.charCodeAt(0))).toBe(97 - FIRST_CHAR)
    expect(uvIndex('0'.charCodeAt(0))).toBe(48 - FIRST_CHAR)
  })

  it('substitutes "?" for anything outside the mapped range', () => {
    const q = '?'.charCodeAt(0) - FIRST_CHAR
    expect(uvIndex(0)).toBe(q)                      // control char
    expect(uvIndex(FIRST_CHAR - 1)).toBe(q)         // just below range
    expect(uvIndex(LAST_CHAR + 1)).toBe(q)          // just above range
    expect(uvIndex('·'.charCodeAt(0))).toBe(q)      // non-ASCII punctuation
    expect(uvIndex('é'.charCodeAt(0))).toBe(q)
  })
})
