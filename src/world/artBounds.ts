import * as THREE from 'three'
import { regionUv, type PropDef, type Tileset } from './tileset'

/**
 * Where the art actually is inside the box a sheet says it occupies.
 *
 * A prop's region is `w`x`h` whole cells, chosen when the sheet was
 * classified. Nothing makes the drawing fill it: several props in the city
 * drop sit in a region with the better part of an empty cell below them, and
 * since a billboard stands on the bottom edge of its quad, that empty strip is
 * exactly how far the prop floats above the ground.
 *
 * The sheet is not wrong and neither is the placement code — the region is
 * simply bigger than the drawing. Rather than ask a designer to re-cut every
 * region by hand, measure the drawing and let the renderer stop reserving the
 * space that isn't used.
 */

/** Empty rows above and below the art inside a region, in source pixels. */
export interface ArtTrim {
  top: number
  bottom: number
}

export const NO_TRIM: ArtTrim = { top: 0, bottom: 0 }

/**
 * Alpha above this counts as drawn. Above zero because a soft edge exported
 * from Aseprite can leave a rim of near-transparent pixels that would defeat
 * the measurement entirely.
 */
const OPAQUE = 24

interface Mask {
  w: number
  h: number
  /** One byte of alpha per pixel, row-major. */
  a: Uint8Array
}

/**
 * Alpha masks are cached against the texture rather than its path: the editor
 * re-imports a sheet to the same path, and gets a new Texture for it, so
 * keying on identity is what makes a re-import re-measure.
 */
const masks = new WeakMap<THREE.Texture, Mask | null>()

/**
 * Read a texture's alpha into a plain array, or undefined if it cannot be
 * read.
 *
 * It can fail for ordinary reasons — no DOM under the test runner, a texture
 * whose image has not decoded, a canvas tainted by an image that arrived
 * without CORS headers — and every one of them is a reason to skip the
 * measurement, not to break the world. Callers fall back to the untrimmed
 * region, which is what the game did before any of this existed.
 */
function alphaMask(texture: THREE.Texture): Mask | undefined {
  const hit = masks.get(texture)
  if (hit !== undefined) return hit ?? undefined

  const mask = readAlpha(texture)
  masks.set(texture, mask ?? null)
  return mask
}

function readAlpha(texture: THREE.Texture): Mask | undefined {
  if (typeof document === 'undefined') return undefined
  const image = texture.image as CanvasImageSource & { width?: number; height?: number }
  const w = image?.width ?? 0
  const h = image?.height ?? 0
  if (!image || !w || !h) return undefined

  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return undefined
    ctx.drawImage(image, 0, 0)
    const rgba = ctx.getImageData(0, 0, w, h).data
    const a = new Uint8Array(w * h)
    for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3]!
    return { w, h, a }
  } catch (err) {
    console.warn('[art] could not measure the sheet, drawing regions as declared —', err)
    return undefined
  }
}

/** Empty rows above and below the drawing in one rectangle of a mask. */
function trimOf(mask: Mask, x: number, y: number, w: number, h: number): ArtTrim {
  let first = -1
  let last = -1
  for (let row = 0; row < h; row++) {
    const sy = y + row
    if (sy < 0 || sy >= mask.h) continue
    let drawn = false
    for (let col = 0; col < w && !drawn; col++) {
      const sx = x + col
      if (sx < 0 || sx >= mask.w) continue
      if (mask.a[sy * mask.w + sx]! > OPAQUE) drawn = true
    }
    if (!drawn) continue
    if (first < 0) first = row
    last = row
  }
  // A region with nothing in it gets no trim: shrinking it to nothing would
  // hide the fact that it is empty, which is worth seeing.
  if (first < 0) return NO_TRIM
  return { top: first, bottom: h - 1 - last }
}

/**
 * Measure every prop in a tileset against its own sheet.
 *
 * Returns an empty map when the sheet cannot be read, so the caller's lookup
 * misses and it falls back to the region as declared.
 */
export function measurePropTrims(texture: THREE.Texture, tileset: Tileset): Map<string, ArtTrim> {
  const out = new Map<string, ArtTrim>()
  const mask = alphaMask(texture)
  if (!mask) return out

  const tp = tileset.tilePx
  for (const def of tileset.props) {
    out.set(def.id, trimOf(mask, def.col * tp, def.row * tp, def.w * tp, def.h * tp))
  }
  return out
}

/**
 * The drawing inside a prop's region: how big it is in tiles, and the piece of
 * the sheet it comes from.
 *
 * This is what a prop's quad is built from — not the region — so the quad's
 * bottom edge and the drawing's bottom edge are the same line. That equality is
 * what keeps a prop on the ground at every camera pitch. Shifting a full-region
 * quad south by the empty strip instead only works flat: as the camera tilts,
 * the billboard stands up, and a slide across the ground stops being the same
 * screen distance as a slide up the billboard's own face, so the prop lifts
 * off again by however much the sheet left empty.
 *
 * Only the vertical is trimmed. Standing on the ground is a real invariant;
 * being centred in your own region is not, and `street-lamp-arm` is drawn
 * deliberately off-centre so that its pole lands on the tile.
 */
export function propArt(
  tileset: Tileset, def: PropDef, trim: ArtTrim = NO_TRIM, eps = 0.01,
): { w: number; h: number; u0: number; u1: number; v0: number; v1: number } {
  const tp = tileset.tilePx
  const topPx = def.row * tp + trim.top
  const bottomPx = (def.row + def.h) * tp - trim.bottom
  const { u0, u1 } = regionUv(tileset, def.col, def.row, def.w, def.h, eps)
  return {
    w: def.w,
    h: (bottomPx - topPx) / tp,
    u0,
    u1,
    v0: 1 - (bottomPx - eps) / tileset.sheetH,
    v1: 1 - (topPx + eps) / tileset.sheetH,
  }
}
