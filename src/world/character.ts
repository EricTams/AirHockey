import * as THREE from 'three'
import type { Assets } from '../core/assets'
import { loadAseprite, type SpriteSheet } from './aseprite'
import { TILE } from '../core/config'

export type Facing = 'down' | 'left' | 'right' | 'up'
export const FACINGS: Facing[] = ['down', 'left', 'right', 'up']

export interface CharacterDef {
  id: string
  frameSize: [number, number]
  /**
   * Frame shown while standing still. ASSUMPTION: the drop's 4 frames carry no
   * Aseprite tags, so which frame is the neutral pose is unverified.
   */
  idleFrame: number
  /**
   * Animation frames advanced per tile step. The walk cycle is 4 frames at
   * 100ms and a step is 200ms, so 2 keeps the feet locked to the ground.
   */
  framesPerStep: number
  /** Per-facing sheet paths. A "*" key applies one sheet to every facing. */
  directions: Partial<Record<Facing | '*', string>>
}

/**
 * A character's sheets plus the quad that draws them. Facing switches the
 * material's map; the frame within a sheet is selected by rewriting UVs, so
 * there is one geometry and one draw call per character.
 */
export class CharacterSprite {
  readonly mesh: THREE.Mesh
  private sheets = new Map<Facing, SpriteSheet>()
  private material: THREE.MeshBasicMaterial
  private uv: THREE.BufferAttribute
  private current: { facing: Facing; frame: number } = { facing: 'down', frame: -1 }

  private constructor(readonly def: CharacterDef) {
    const [fw, fh] = def.frameSize
    // Plane sized in tiles, origin translated to the bottom-centre so the
    // projection can rotate it about its base.
    const geo = new THREE.PlaneGeometry(fw / TILE, fh / TILE)
    geo.translate(0, fh / TILE / 2, 0)

    this.material = new THREE.MeshBasicMaterial({
      transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.uv = geo.getAttribute('uv') as THREE.BufferAttribute
  }

  static async load(def: CharacterDef, assets: Assets): Promise<CharacterSprite> {
    const sprite = new CharacterSprite(def)
    const shared = def.directions['*']
    for (const facing of FACINGS) {
      const url = def.directions[facing] ?? shared
      if (!url) continue
      sprite.sheets.set(facing, await loadAseprite(url, assets))
    }
    if (sprite.sheets.size === 0) throw new Error(`character ${def.id}: no direction sheets`)
    sprite.setFrame('down', def.idleFrame)
    return sprite
  }

  /** Sheets actually present, for reporting which facings fall back. */
  get facingsLoaded(): Facing[] { return [...this.sheets.keys()] }

  frameCount(facing: Facing): number {
    return (this.sheets.get(facing) ?? this.sheets.values().next().value)?.frames.length ?? 0
  }

  setFrame(facing: Facing, frame: number): void {
    const sheet = this.sheets.get(facing) ?? this.sheets.values().next().value
    if (!sheet) return
    const idx = ((frame % sheet.frames.length) + sheet.frames.length) % sheet.frames.length
    if (this.current.facing === facing && this.current.frame === idx) return
    this.current = { facing, frame: idx }

    if (this.material.map !== sheet.texture) {
      this.material.map = sheet.texture
      this.material.needsUpdate = true
    }
    const f = sheet.frames[idx]!
    // PlaneGeometry UV order: TL, TR, BL, BR.
    const a = this.uv.array as Float32Array
    a[0] = f.u0; a[1] = f.v1
    a[2] = f.u1; a[3] = f.v1
    a[4] = f.u0; a[5] = f.v0
    a[6] = f.u1; a[7] = f.v0
    this.uv.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * Frame for a step-locked walk: the cycle advances with distance travelled, not
 * wall-clock, so the feet never slide regardless of step duration.
 *
 * `stepsTaken` counts completed steps; `progress` is 0..1 through the current
 * one. With framesPerStep = 2 and a 4-frame sheet, step 0 plays frames 0-1 and
 * step 1 plays 2-3, giving a left-foot/right-foot cycle across two tiles.
 */
export function walkFrame(
  stepsTaken: number, progress: number, framesPerStep: number, frameCount: number,
): number {
  if (frameCount <= 0) return 0
  const within = Math.min(framesPerStep - 1, Math.floor(progress * framesPerStep))
  return (stepsTaken * framesPerStep + within) % frameCount
}
