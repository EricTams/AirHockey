/**
 * All runtime content is addressed by project-relative path — no leading slash
 * — and resolved against the page's base URL here.
 *
 * GitHub Pages serves a project site from https://user.github.io/<repo>/, so an
 * absolute path like /data/game.json resolves to the domain root and 404s. The
 * repo name is never hardcoded: `document.baseURI` already carries it, and the
 * same code works unchanged at a domain root or under any subpath.
 *
 * Content reads go through `contentUrl`, which is normally `assetUrl` but which
 * the editor redirects at the designer's own machine while editing. Without
 * that indirection the game only ever sees the published site: a saved map
 * would not change the world, and — worse — a freshly imported tileset PNG,
 * which exists nowhere but the content folder, would fall back to a placeholder
 * and silently re-index every map that references it.
 *
 * `assetUrl` deliberately stays site-only. The editor's own download link and
 * its fallback-to-the-shipped-copy read must not be redirected at the helper.
 */
export function assetUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).toString()
}

/** Maps a project-relative path to the URL content should be read from. */
export type ContentResolver = (path: string) => string

let resolver: ContentResolver | undefined

/**
 * Redirect content reads. Passing undefined restores the site, which is what
 * leaving edit mode does — nothing should keep pointing at a helper that the
 * designer has since closed.
 */
export function setContentResolver(fn: ContentResolver | undefined): void {
  resolver = fn
}

/** Where a project-relative path should be read from right now. */
export function contentUrl(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return resolver?.(clean) ?? assetUrl(clean)
}

/** Fetch and parse a JSON file addressed by project-relative path. */
export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(contentUrl(path))
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}
