import type * as THREE from 'three'
import type { Assets } from '../core/assets'
import { fetchJson } from '../core/paths'

/** One frame of an Aseprite export, with UVs precomputed for the atlas. */
export interface Frame {
  x: number; y: number; w: number; h: number
  durationMs: number
  u0: number; v0: number; u1: number; v1: number
}

export interface SpriteSheet {
  texture: THREE.Texture
  frames: Frame[]
  /** Atlas dimensions in pixels. */
  width: number
  height: number
  /** Total cycle length, for wall-clock animation. Step-locked animation ignores it. */
  totalMs: number
}

/** The subset of the Aseprite JSON export we rely on. */
interface AsepriteFrame {
  frame: { x: number; y: number; w: number; h: number }
  duration?: number
}
interface AsepriteJson {
  frames: AsepriteFrame[] | Record<string, AsepriteFrame>
  meta?: { size?: { w: number; h: number } }
}

/**
 * Load an Aseprite sheet+JSON pair.
 *
 * The PNG path is derived from the JSON path rather than read from
 * `meta.image`: the exporter records the original filename, which in this
 * project's drops contains spaces that the import step strips.
 */
export async function loadAseprite(jsonPath: string, assets: Assets): Promise<SpriteSheet> {
  const data = await fetchJson<AsepriteJson>(jsonPath)

  const pngPath = jsonPath.replace(/\.json$/, '.png')
  const texture = await assets.texture(pngPath, { label: 'SHEET', kind: 'character' })

  // Aseprite exports `frames` as an array or as a filename-keyed object.
  const raw = Array.isArray(data.frames) ? data.frames : Object.values(data.frames)
  if (raw.length === 0) throw new Error(`aseprite json ${jsonPath}: no frames`)

  const img = texture.image as { width?: number; height?: number } | undefined
  const width = data.meta?.size?.w ?? img?.width ?? 1
  const height = data.meta?.size?.h ?? img?.height ?? 1

  let totalMs = 0
  const frames: Frame[] = raw.map((f) => {
    const { x, y, w, h } = f.frame
    const durationMs = f.duration ?? 100
    totalMs += durationMs
    return {
      x, y, w, h, durationMs,
      u0: x / width,
      u1: (x + w) / width,
      // Aseprite y runs top-down; texture v runs bottom-up.
      v0: 1 - (y + h) / height,
      v1: 1 - y / height,
    }
  })

  return { texture, frames, width, height, totalMs }
}

/** Frame index for a wall-clock elapsed time, looping the cycle. */
export function frameAtTime(sheet: SpriteSheet, elapsedMs: number): number {
  if (sheet.totalMs <= 0) return 0
  let t = elapsedMs % sheet.totalMs
  for (let i = 0; i < sheet.frames.length; i++) {
    t -= sheet.frames[i]!.durationMs
    if (t < 0) return i
  }
  return sheet.frames.length - 1
}
