import * as THREE from 'three'
import { makePlaceholderTexture, type PlaceholderOpts } from '../world/placeholder'
import { findMissing } from '../world/missingArt'

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
   * Load `url` as a pixel-art texture. On failure, fall back to a placeholder —
   * from the MISSING_ART manifest if the path is a known gap, otherwise a
   * generic square derived from `fallback`.
   */
  async texture(url: string, fallback?: Partial<PlaceholderOpts>): Promise<THREE.Texture> {
    const hit = this.cache.get(url)
    if (hit) return hit

    let tex: THREE.Texture
    try {
      tex = await this.loadImage(url)
    } catch {
      const known = findMissing(url)
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

  dispose(): void {
    for (const tex of this.cache.values()) tex.dispose()
    this.cache.clear()
    this.substituted.clear()
  }
}

function basename(url: string): string {
  return (url.split('/').pop() ?? url).replace(/\.[^.]+$/, '').toUpperCase()
}
