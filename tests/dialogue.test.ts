import { describe, it, expect } from 'vitest'
import { wrapMono } from '../src/modes/dialogue'

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
