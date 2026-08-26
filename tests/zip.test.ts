import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip, crc32 } from '../src/editor/zip'

const text = (s: string) => new TextEncoder().encode(s)

describe('crc32', () => {
  it('matches the standard vector', () => {
    // "The quick brown fox jumps over the lazy dog" is CRC-32 0x414FA339.
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('matches the check value for "123456789"', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926)
  })
})

describe('makeZip', () => {
  const fixed = new Date(2026, 7, 26, 12, 34, 56)

  it('produces an archive the platform unzip accepts', () => {
    const zip = makeZip([
      { path: 'data/maps/overworld.json', data: text('{"id":"overworld"}\n') },
      { path: 'README.txt', data: text('put these in public/\n') },
    ], fixed)

    const dir = mkdtempSync(join(tmpdir(), 'airhockey-zip-'))
    try {
      const file = join(dir, 'out.zip')
      writeFileSync(file, zip)
      // unzip -t verifies every CRC and the central directory. A hand-written
      // writer that gets either wrong makes a file no designer can open.
      execFileSync('unzip', ['-t', file], { stdio: 'pipe' })
      execFileSync('unzip', ['-o', '-q', file, '-d', join(dir, 'out')], { stdio: 'pipe' })
      expect(readFileSync(join(dir, 'out/data/maps/overworld.json'), 'utf8'))
        .toBe('{"id":"overworld"}\n')
      expect(readFileSync(join(dir, 'out/README.txt'), 'utf8')).toBe('put these in public/\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips binary bytes untouched', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const zip = makeZip([{ path: 'sheet.png', data: bytes }], fixed)

    const dir = mkdtempSync(join(tmpdir(), 'airhockey-zip-'))
    try {
      const file = join(dir, 'out.zip')
      writeFileSync(file, zip)
      execFileSync('unzip', ['-o', '-q', file, '-d', join(dir, 'out')], { stdio: 'pipe' })
      expect(new Uint8Array(readFileSync(join(dir, 'out/sheet.png')))).toEqual(bytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes an empty but valid archive when there is nothing to send', () => {
    const zip = makeZip([], fixed)
    expect(zip).toHaveLength(22)   // just the end-of-central-directory record
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x06054b50)
    expect(view.getUint16(8, true)).toBe(0)
  })

  it('keeps a non-ASCII path readable by flagging the name as UTF-8', () => {
    const zip = makeZip([{ path: 'data/maps/café.json', data: text('{}') }], fixed)
    const view = new DataView(zip.buffer)
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
  })
})
