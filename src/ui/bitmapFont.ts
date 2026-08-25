import * as THREE from 'three'

export const FIRST_CHAR = 32   // space
export const LAST_CHAR = 126   // ~
const COLUMNS = 16

export interface BitmapFont {
  texture: THREE.Texture
  glyphW: number
  glyphH: number
  columns: number
  /** Normalised atlas rect for a character code; falls back to '?' if unmapped. */
  uv(code: number): { u0: number; v0: number; u1: number; v1: number }
  /** True when this font is procedurally generated rather than authored art. */
  readonly isPlaceholder: boolean
}

/**
 * Procedurally generated stand-in for the authored bitmap font (doc §9, plan
 * spec: 12×18 glyphs, ASCII 32–126). Rendered once into a canvas atlas with a
 * system monospace face, so the UI layer can be built and text can be read
 * before real font art exists.
 */
export function generatePlaceholderFont(glyphW = 12, glyphH = 18): BitmapFont {
  const count = LAST_CHAR - FIRST_CHAR + 1
  const rows = Math.ceil(count / COLUMNS)
  const canvas = document.createElement('canvas')
  canvas.width = COLUMNS * glyphW
  canvas.height = rows * glyphH

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Slightly under the cell height so descenders are not clipped.
  ctx.font = `${glyphH - 5}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`

  for (let i = 0; i < count; i++) {
    const col = i % COLUMNS
    const row = Math.floor(i / COLUMNS)
    const ch = String.fromCharCode(FIRST_CHAR + i)
    ctx.fillText(ch, col * glyphW + glyphW / 2, row * glyphH + glyphH / 2)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.name = 'placeholder:font'

  return {
    texture, glyphW, glyphH, columns: COLUMNS, isPlaceholder: true,
    uv(code: number) {
      const idx = uvIndex(code)
      const col = idx % COLUMNS
      const row = Math.floor(idx / COLUMNS)
      return {
        u0: (col * glyphW) / canvas.width,
        // Canvas rows run top-down; texture v runs bottom-up.
        v0: 1 - ((row + 1) * glyphH) / canvas.height,
        u1: ((col + 1) * glyphW) / canvas.width,
        v1: 1 - (row * glyphH) / canvas.height,
      }
    },
  }
}

/** Atlas index for a character code, substituting '?' for anything unmapped. */
export function uvIndex(code: number): number {
  if (code < FIRST_CHAR || code > LAST_CHAR) return '?'.charCodeAt(0) - FIRST_CHAR
  return code - FIRST_CHAR
}

let shared: BitmapFont | undefined

/** The one font instance. Generating the atlas per call would leak canvases. */
export function getFont(): BitmapFont {
  shared ??= generatePlaceholderFont()
  return shared
}
