import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assetUrl, contentUrl, setContentResolver, fetchJson } from '../src/core/paths'
import { EditorServer } from '../src/editor/server'

/**
 * Content routing is what makes an edit visible: while editing, the game has to
 * read the designer's own files rather than the published site's. Getting it
 * wrong is quiet — a save that appears to do nothing, or an imported sheet that
 * falls back to a placeholder and silently re-indexes every map.
 */

const BASE = 'https://erictams.github.io/AirHockey/'

/** `assetUrl` resolves against document.baseURI; node has no document. */
function stubDocument(baseURI = BASE): void {
  ;(globalThis as Record<string, unknown>).document = { baseURI }
}

/** A fetch that answers from a fixed routing table and records what it saw. */
function stubFetch(routes: Record<string, unknown>) {
  const seen: string[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
    const url = String(input)
    seen.push(url)
    const body = routes[url]
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  }
  return seen
}

beforeEach(() => {
  stubDocument()
  setContentResolver(undefined)
})

afterEach(() => {
  setContentResolver(undefined)
  delete (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).fetch
})

describe('contentUrl', () => {
  it('resolves against the site when nothing is installed', () => {
    expect(contentUrl('data/maps/overworld.json')).toBe(BASE + 'data/maps/overworld.json')
  })

  it('strips a leading slash, which would otherwise escape a project subpath', () => {
    // GitHub Pages serves from /<repo>/; an absolute path 404s at the domain root.
    expect(contentUrl('/data/maps/overworld.json')).toBe(BASE + 'data/maps/overworld.json')
  })

  it('sends reads to the resolver once one is installed', () => {
    setContentResolver((p) => `http://127.0.0.1:5178/api/file?path=${p}`)
    expect(contentUrl('data/maps/overworld.json'))
      .toBe('http://127.0.0.1:5178/api/file?path=data/maps/overworld.json')
  })

  it('goes back to the site when the resolver is removed', () => {
    setContentResolver(() => 'http://127.0.0.1:5178/x')
    setContentResolver(undefined)
    expect(contentUrl('a.json')).toBe(BASE + 'a.json')
  })

  it('leaves assetUrl alone, so the editor can still reach the shipped copy', () => {
    setContentResolver(() => 'http://127.0.0.1:5178/x')
    expect(assetUrl('data/maps/overworld.json')).toBe(BASE + 'data/maps/overworld.json')
  })

  it('routes fetchJson through the resolver', async () => {
    const seen = stubFetch({ 'http://helper/data/a.json': { id: 'local' } })
    setContentResolver((p) => `http://helper/${p}`)
    expect(await fetchJson('data/a.json')).toEqual({ id: 'local' })
    expect(seen).toEqual(['http://helper/data/a.json'])
  })
})

describe('EditorServer content index', () => {
  /** A helper whose content folder holds exactly `files`. */
  function stubHelper(files: string[]) {
    const tree = new Map<string, { name: string; dir: boolean }[]>()
    const ensure = (dir: string) => {
      if (!tree.has(dir)) tree.set(dir, [])
      return tree.get(dir)!
    }
    ensure('')
    for (const file of files) {
      const parts = file.split('/')
      let prefix = ''
      for (const part of parts.slice(0, -1)) {
        const kids = ensure(prefix)
        if (!kids.some((k) => k.name === part)) kids.push({ name: part, dir: true })
        prefix += part + '/'
      }
      ensure(prefix).push({ name: parts.at(-1)!, dir: false })
    }
    ;(globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
      const url = new URL(String(input))
      const path = url.searchParams.get('path') ?? ''
      const entries = tree.get(path)
      if (!entries) return { ok: true, status: 200, json: async () => ({ entries: [] }) }
      return { ok: true, status: 200, json: async () => ({ entries }) }
    }
  }

  it('finds files nested under several directories', async () => {
    stubHelper(['data/maps/overworld.json', 'assets/terrain/sheet.png'])
    const server = new EditorServer()
    const index = await server.buildIndex()
    expect([...index].sort()).toEqual(['assets/terrain/sheet.png', 'data/maps/overworld.json'])
  })

  it('sends indexed paths to the helper and everything else to the site', async () => {
    stubHelper(['data/maps/overworld.json'])
    const server = new EditorServer()
    await server.buildIndex()
    expect(server.contentUrl('data/maps/overworld.json'))
      .toBe('http://127.0.0.1:5178/api/file?path=data%2Fmaps%2Foverworld.json')
    // Never edited, so the site's shipped copy: an empty folder still opens the
    // real world.
    expect(server.contentUrl('data/dialogue/blorb.json'))
      .toBe(BASE + 'data/dialogue/blorb.json')
  })

  it('reads the site for everything when the content folder is empty', async () => {
    stubHelper([])
    const server = new EditorServer()
    await server.buildIndex()
    expect(server.contentUrl('data/maps/overworld.json'))
      .toBe(BASE + 'data/maps/overworld.json')
  })

  it('uninstalling forgets the index as well as the resolver', async () => {
    stubHelper(['data/maps/overworld.json'])
    const server = new EditorServer()
    await server.install()
    expect(contentUrl('data/maps/overworld.json')).toContain('127.0.0.1')
    server.uninstall()
    expect(server.editedPaths).toBeUndefined()
    expect(contentUrl('data/maps/overworld.json')).toBe(BASE + 'data/maps/overworld.json')
  })
})
