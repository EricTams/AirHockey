import { assetUrl } from '../core/paths'

/**
 * Client for the local editor server (tools/editor-server.mjs).
 *
 * The editor is part of the shipped build, so this may be talking to a server
 * on the designer's own machine from a page served by GitHub Pages. Nothing
 * authenticates: reaching the server is the whole handshake. What keeps that
 * reasonable is on the server's side — it writes only into a fixed folder it
 * creates, and only .json and .png.
 *
 * Paths here are the same project-relative paths the game fetches content by —
 * `data/maps/overworld.json`, not a filesystem path. The server resolves them
 * inside its content folder, and this client falls back to the site's own copy
 * for anything the designer has not edited yet. So a fresh, empty content
 * folder still opens the real game world.
 */

export const DEFAULT_ORIGIN = 'http://127.0.0.1:5178'
const ORIGIN_KEY = 'airhockey.editor.origin'

/** Where the downloadable copy of the server lives on this site. */
export const SERVER_DOWNLOAD_URL = assetUrl('airhockey-editor.mjs')
export const SERVER_FILENAME = 'airhockey-editor.mjs'

export type Reachability =
  | { state: 'offline' }
  | { state: 'ready' }

function stored(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

function store(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* private browsing; the session just will not be remembered */ }
}

export class EditorServer {
  origin = stored(ORIGIN_KEY, DEFAULT_ORIGIN)

  setOrigin(origin: string): void {
    this.origin = origin.replace(/\/+$/, '')
    store(ORIGIN_KEY, this.origin)
  }

  private url(route: string, params: Record<string, string> = {}): string {
    const u = new URL(route, this.origin)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u.toString()
  }

  /** Is the helper running? That is the entire handshake. */
  async probe(timeoutMs = 1500): Promise<Reachability> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(this.url('/api/health'), { signal: ctl.signal })
      return res.ok ? { state: 'ready' } : { state: 'offline' }
    } catch {
      return { state: 'offline' }
    } finally {
      clearTimeout(timer)
    }
  }

  async list(path: string): Promise<{ name: string; dir: boolean }[]> {
    const res = await fetch(this.url('/api/list', { path }))
    if (!res.ok) throw new Error(await errorText(res))
    return (await res.json()).entries
  }

  /**
   * Read an edited file, falling back to the version this site shipped with.
   * A 404 from the server means "not edited yet", which is not an error.
   */
  async readJson<T>(path: string): Promise<T> {
    const res = await fetch(this.url('/api/file', { path }))
    if (res.ok) return await res.json() as T
    if (res.status !== 404) throw new Error(await errorText(res))
    const site = await fetch(assetUrl(path))
    if (!site.ok) throw new Error(`${path}: not edited locally, and not on the site either`)
    return await site.json() as T
  }

  /** True if the designer has an edited copy of this file. */
  async hasLocal(path: string): Promise<boolean> {
    const res = await fetch(this.url('/api/file', { path }))
    return res.ok
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.write(path, JSON.stringify(value, null, 2) + '\n', 'application/json')
  }

  async write(path: string, body: BodyInit, contentType = 'application/octet-stream'): Promise<void> {
    const res = await fetch(this.url('/api/file', { path }), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    })
    if (!res.ok) throw new Error(await errorText(res))
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string }
    if (body.error) return body.error
  } catch { /* fall through to the status line */ }
  return `${res.status} ${res.statusText}`
}
