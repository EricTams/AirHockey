/**
 * All runtime content is addressed by project-relative path — no leading slash
 * — and resolved against the page's base URL here.
 *
 * GitHub Pages serves a project site from https://user.github.io/<repo>/, so an
 * absolute path like /data/game.json resolves to the domain root and 404s. The
 * repo name is never hardcoded: `document.baseURI` already carries it, and the
 * same code works unchanged at a domain root or under any subpath.
 */
export function assetUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).toString()
}

/** Fetch and parse a JSON file addressed by project-relative path. */
export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(assetUrl(path))
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}
