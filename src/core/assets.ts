import * as THREE from 'three'
import { makePlaceholderTexture, type PlaceholderOpts } from '../world/placeholder'
import { findMissing } from '../world/missingArt'
import { contentUrl } from './paths'

/**
 * Texture cache with a placeholder fallback: a missing or broken file yields a
 * labelled square rather than an exception or an invisible object. Every
 * substitution is recorded so the debug overlay can report what is fake.
 */
export class Assets {
  private cache = new Map<string, THREE.Texture>()
  private substituted = new Set<string>()

  /** Assets currently standing in for files that failed to load. */
  get placeholders(): string[] { return [...this.substituted].sort() }

  /**
   * Load a project-relative path as a pixel-art texture. On failure, fall back
   * to a placeholder — from the MISSING_ART manifest if the path is a known
   * gap, otherwise a generic square derived from `fallback`.
   *
   * Cached and looked up by the logical path, so the manifest keys stay stable
   * wherever the site is hosted.
   */
  async texture(path: string, fallback?: Partial<PlaceholderOpts>): Promise<THREE.Texture> {
    const url = path
    const hit = this.cache.get(url)
    if (hit) return hit

    let tex: THREE.Texture
    try {
      tex = await this.loadImage(contentUrl(path))
    } catch {
      const known = findMissing(path)
      tex = makePlaceholderTexture({
        width: known?.width ?? fallback?.width ?? 48,
        height: known?.height ?? fallback?.height ?? 48,
        label: known?.label ?? fallback?.label ?? basename(url),
        kind: known?.kind ?? fallback?.kind ?? 'generic',
      })
      this.substituted.add(url)
      console.warn(`[assets] missing ${url} — using placeholder "${tex.name}"`)
    }
    this.cache.set(url, tex)
    return tex
  }

  private loadImage(url: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      // While editing, textures come from the helper on 127.0.0.1 — a different
      // origin from the page. WebGL refuses to upload an image that is not
      // CORS-clean, and the refusal is silent: the texture samples as
      // transparent black, so the world goes blank rather than erroring. The
      // helper answers with access-control-allow-origin, so an anonymous
      // request succeeds; on same-origin site assets this changes nothing.
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        const tex = new THREE.Texture(img)
        tex.magFilter = THREE.NearestFilter
        tex.minFilter = THREE.NearestFilter
        tex.generateMipmaps = false
        tex.colorSpace = THREE.SRGBColorSpace
        tex.name = url
        tex.needsUpdate = true
        resolve(tex)
      }
      img.onerror = () => reject(new Error(`failed to load ${url}`))
      img.src = url
    })
  }

  /**
   * Drop a cached texture so the next request reloads it.
   *
   * The cache is keyed by logical path, which is what makes an edit invisible:
   * re-importing a sheet writes new bytes to the same path and would otherwise
   * keep showing the old image for the rest of the session. Returns true if
   * something was actually cached.
   */
  invalidate(path: string): boolean {
    const tex = this.cache.get(path)
    if (!tex) return false
    tex.dispose()
    this.cache.delete(path)
    this.substituted.delete(path)
    return true
  }

  dispose(): void {
    for (const tex of this.cache.values()) tex.dispose()
    this.cache.clear()
    this.substituted.clear()
  }
}

function basename(url: string): string {
  return (url.split('/').pop() ?? url).replace(/\.[^.]+$/, '').toUpperCase()
}
