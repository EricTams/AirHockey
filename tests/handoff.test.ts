import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleChanges } from '../src/editor/handoff'
import type { EditorServer } from '../src/editor/server'

/**
 * The zip is the designer's only route back to the repo (decision 8), so what
 * matters is that everything they edited is in it, under the paths the game
 * loads by.
 */

const text = (s: string) => new TextEncoder().encode(s)

function stubServer(files: Record<string, string>): EditorServer {
  const read: string[] = []
  return {
    async buildIndex() { return new Set(Object.keys(files)) },
    async readBytes(path: string) {
      read.push(path)
      const body = files[path]
      if (body === undefined) throw new Error(`${path}: not there`)
      return text(body)
    },
    reads: read,
  } as unknown as EditorServer
}

const fixed = new Date(2026, 7, 26, 9, 30, 0)

describe('bundleChanges', () => {
  it('packs every edited file under its content path', async () => {
    const bundle = await bundleChanges(stubServer({
      'data/maps/overworld.json': '{"id":"overworld"}\n',
      'data/dialogue/blorb.json': '{"id":"blorb"}\n',
    }), fixed)

    expect(bundle.paths).toEqual(['data/dialogue/blorb.json', 'data/maps/overworld.json'])

    const dir = mkdtempSync(join(tmpdir(), 'airhockey-bundle-'))
    try {
      const file = join(dir, bundle.filename)
      writeFileSync(file, bundle.bytes)
      execFileSync('unzip', ['-o', '-q', file, '-d', join(dir, 'out')], { stdio: 'pipe' })
      // The paths are the ones the game fetches by, so unzipping over public/
      // lands each file where the game already looks.
      expect(readFileSync(join(dir, 'out/data/maps/overworld.json'), 'utf8'))
        .toBe('{"id":"overworld"}\n')
      expect(readFileSync(join(dir, 'out/data/dialogue/blorb.json'), 'utf8'))
        .toBe('{"id":"blorb"}\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes a README saying where the files go', async () => {
    const bundle = await bundleChanges(stubServer({ 'data/maps/a.json': '{}' }), fixed)
    const dir = mkdtempSync(join(tmpdir(), 'airhockey-bundle-'))
    try {
      const file = join(dir, bundle.filename)
      writeFileSync(file, bundle.bytes)
      execFileSync('unzip', ['-o', '-q', file, '-d', join(dir, 'out')], { stdio: 'pipe' })
      const readme = readFileSync(join(dir, 'out/README.txt'), 'utf8')
      expect(readme).toContain('public')
      expect(readme).toContain('data/maps/a.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the file by the day, so exports do not collide in Downloads', async () => {
    const bundle = await bundleChanges(stubServer({}), fixed)
    expect(bundle.filename).toBe('airhockey-content-2026-08-26.zip')
  })

  it('reports an empty folder rather than pretending it packed something', async () => {
    const bundle = await bundleChanges(stubServer({}), fixed)
    expect(bundle.paths).toEqual([])
  })
})
