import { assetUrl, setContentResolver } from '../core/paths'

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

export const SERVER_FILENAME = 'airhockey-editor.mjs'

/**
 * Where the downloadable copy of the server lives on this site. A function
 * rather than a constant: at module scope it would read `document.baseURI`
 * before anything has decided whether there is a document at all.
 */
export function serverDownloadUrl(): string { return assetUrl(SERVER_FILENAME) }

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
    this.edited?.add(path.replace(/^\/+/, ''))
  }

  // --- Content routing -----------------------------------------------------
  //
  // While editing, the game itself has to read the designer's files, not the
  // site's. Deciding that per read would mean probing the helper for every
  // path; instead the content folder is indexed once on entry, because it is
  // small by construction (the helper creates it and writes only there) and
  // because `/api/list` exists in every version of the helper. A per-file
  // HEAD probe would have been tidier but would report "not edited" against an
  // older helper that does not route HEAD — failing silently, in the direction
  // that hides the designer's own work.

  private edited?: Set<string>

  /** Paths the designer has an edited copy of, or undefined before indexing. */
  get editedPaths(): ReadonlySet<string> | undefined { return this.edited }

  /** Walk the content folder and remember every file in it. */
  async buildIndex(): Promise<ReadonlySet<string>> {
    const found = new Set<string>()
    const walk = async (prefix: string, depth: number): Promise<void> => {
      if (depth > MAX_INDEX_DEPTH) return
      let entries: { name: string; dir: boolean }[]
      try {
        entries = await this.list(prefix)
      } catch {
        return   // an unreadable subfolder is empty as far as the game cares
      }
      await Promise.all(entries.map((e) =>
        e.dir ? walk(`${prefix}${e.name}/`, depth + 1)
              : void found.add(`${prefix}${e.name}`)))
    }
    await walk('', 0)
    this.edited = found
    return found
  }

  /**
   * Read-through URL for a content path: the designer's copy if they have one,
   * otherwise the copy this site shipped with. So an empty content folder still
   * opens the real game world.
   */
  contentUrl = (path: string): string => {
    return this.edited?.has(path) ? this.url('/api/file', { path }) : assetUrl(path)
  }

  /** Point the game's content reads at this helper. */
  async install(): Promise<void> {
    await this.buildIndex()
    setContentResolver(this.contentUrl)
  }

  /** Put the game back on the site's own content. */
  uninstall(): void {
    setContentResolver(undefined)
    this.edited = undefined
  }
}

/** Deep enough for the content tree, shallow enough that a cycle cannot hang. */
const MAX_INDEX_DEPTH = 8

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string }
    if (body.error) return body.error
  } catch { /* fall through to the status line */ }
  return `${res.status} ${res.statusText}`
}
