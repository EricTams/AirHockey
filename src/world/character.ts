import * as THREE from 'three'
import type { Assets } from '../core/assets'
import { loadAseprite, type SpriteSheet } from './aseprite'
import { makePlaceholderTexture } from './placeholder'
import { TILE } from '../core/config'

export type Facing = 'down' | 'left' | 'right' | 'up'
export const FACINGS: Facing[] = ['down', 'left', 'right', 'up']

/**
 * Which set of sheets a character is drawing from.
 *
 * The two are animated by different clocks, which is why they are separate
 * rather than tagged ranges of one sheet: a walk is locked to distance
 * travelled so the feet cannot slide, and an idle has no distance to lock to,
 * so it runs on wall-clock at the durations the artist exported.
 */
export type Pose = 'walk' | 'idle'
export const POSES: Pose[] = ['walk', 'idle']

/** Per-facing sheet paths. A "*" key applies one sheet to every facing. */
export type DirectionSheets = Partial<Record<Facing | '*', string>>

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
  /** Sheets used while walking. */
  directions: DirectionSheets
  /**
   * Sheets used while standing still. Optional: a character without them
   * stands on `idleFrame` of its walk sheet, which is what every character did
   * before idles existed.
   */
  idle?: DirectionSheets
  /**
   * Facings drawn by mirroring their sheet horizontally.
   *
   * A side view is one drawing that serves two facings, so a sheet listed here
   * is flipped rather than duplicated on disk. It is declared rather than
   * inferred because mirroring is only ever right for the left/right pair: the
   * mirror of a front view is another front view, not a back one, so a rule
   * like "flip when the opposite facing has art" would silently draw a
   * character walking away from you facing you.
   */
  mirror?: Facing[]
}

/**
 * A character's sheets plus the quad that draws them. Facing switches the
 * material's map; the frame within a sheet is selected by rewriting UVs, so
 * there is one geometry and one draw call per character.
 */
export class CharacterSprite {
  readonly mesh: THREE.Mesh
  private poses: Record<Pose, Map<Facing, SpriteSheet>> = { walk: new Map(), idle: new Map() }
  private material: THREE.MeshBasicMaterial
  private uv: THREE.BufferAttribute
  private mirrored: ReadonlySet<Facing>
  /** True only for `broken`, whose texture is made here rather than by Assets. */
  private ownsTexture = false
  // Pose is part of the key: walk frame 0 and idle frame 0 are different
  // pictures, so a change of pose alone still has to rewrite the UVs.
  private current: { facing: Facing; frame: number; pose: Pose } =
    { facing: 'down', frame: -1, pose: 'walk' }

  private constructor(readonly def: CharacterDef) {
    this.mirrored = new Set((def.mirror ?? []).filter((f) => FACINGS.includes(f)))
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
    await sprite.loadPose('walk', def.directions, assets)
    if (def.idle) await sprite.loadPose('idle', def.idle, assets)
    if (sprite.poses.walk.size === 0) throw new Error(`character ${def.id}: no direction sheets`)
    sprite.setFrame('down', def.idleFrame)
    return sprite
  }

  /**
   * A stand-in for a character whose definition could not be loaded at all.
   *
   * `Assets` already substitutes a labelled square for a texture that fails,
   * but that only covers a sheet that is missing; it cannot help when the
   * character JSON itself is a typo, because there is then nothing saying what
   * size the sprite is or how many frames it has. This is the same idea one
   * level up: the entity stands on its tile as a labelled box, so a designer
   * sees which NPC is broken and where, instead of losing the map.
   *
   * Built without touching the network, because the reason we are here is that
   * the network answer was no.
   */
  static broken(def: Pick<CharacterDef, 'id'>, label: string): CharacterSprite {
    const [w, h] = [TILE, TILE * 2]
    const sprite = new CharacterSprite({
      id: def.id, frameSize: [w, h], idleFrame: 0, framesPerStep: 1, directions: {},
    })
    const texture = makePlaceholderTexture({ width: w, height: h, label, kind: 'character' })
    const sheet: SpriteSheet = {
      texture,
      frames: [{ x: 0, y: 0, w, h, durationMs: 100, u0: 0, u1: 1, v0: 0, v1: 1 }],
      width: w, height: h, totalMs: 100,
    }
    for (const facing of FACINGS) sprite.poses.walk.set(facing, sheet)
    sprite.ownsTexture = true
    sprite.setFrame('down', 0)
    return sprite
  }

  private async loadPose(pose: Pose, sheets: DirectionSheets, assets: Assets): Promise<void> {
    const shared = sheets['*']
    for (const facing of FACINGS) {
      const url = sheets[facing] ?? shared
      if (!url) continue
      this.poses[pose].set(facing, await loadAseprite(url, assets))
    }
  }

  /**
   * The sheet to draw, falling back twice: to any facing this pose does have,
   * and then to the walk pose. Both matter — a character may be drawn from one
   * side only, and most characters have no idle art at all.
   */
  private resolve(facing: Facing, pose: Pose): SpriteSheet | undefined {
    const inPose = this.poses[pose]
    const found = inPose.get(facing) ?? inPose.values().next().value
    if (found) return found
    return pose === 'walk' ? undefined : this.resolve(facing, 'walk')
  }

  /**
   * Multiply the sprite's colour. Each civilian has their own sheet now, so
   * this is dressing rather than the only thing telling two NPCs apart.
   */
  setTint(hex: number): void {
    this.material.color.setHex(hex)
  }

  /** The sheet for a facing, so callers can reuse its texture and frames. */
  sheetFor(facing: Facing, pose: Pose = 'walk'): SpriteSheet | undefined {
    return this.resolve(facing, pose)
  }

  /** Sheets actually present, for reporting which facings fall back. */
  facingsLoaded(pose: Pose = 'walk'): Facing[] { return [...this.poses[pose].keys()] }

  /** True if this character has art of its own for a pose. */
  hasPose(pose: Pose): boolean { return this.poses[pose].size > 0 }

  frameCount(facing: Facing, pose: Pose = 'walk'): number {
    return this.resolve(facing, pose)?.frames.length ?? 0
  }

  setFrame(facing: Facing, frame: number, pose: Pose = 'walk'): void {
    const sheet = this.resolve(facing, pose)
    if (!sheet) return
    const idx = ((frame % sheet.frames.length) + sheet.frames.length) % sheet.frames.length
    if (this.current.facing === facing && this.current.frame === idx && this.current.pose === pose) return
    this.current = { facing, frame: idx, pose }

    if (this.material.map !== sheet.texture) {
      this.material.map = sheet.texture
      this.material.needsUpdate = true
    }
    writeFrameUv(this.uv.array as Float32Array, sheet.frames[idx]!, this.mirrored.has(facing))
    this.uv.needsUpdate = true
  }

  /** True if this facing is drawn by flipping its sheet. */
  isMirrored(facing: Facing): boolean { return this.mirrored.has(facing) }

  dispose(): void {
    this.mesh.geometry.dispose()
    // Sheet textures belong to Assets, which caches them; a placeholder made by
    // `broken` belongs to this sprite and would otherwise leak per rebuild.
    if (this.ownsTexture) this.material.map?.dispose()
    this.material.dispose()
  }
}

/**
 * Write a frame's UVs in PlaneGeometry's vertex order: TL, TR, BL, BR.
 *
 * Mirroring swaps the two u values, which reflects the quad's texture about its
 * own vertical centre. Deliberately not a negative scale on the mesh: that
 * would flip the winding order, and the sprite would vanish for anything
 * culling back faces.
 */
export function writeFrameUv(
  a: Float32Array | number[], f: { u0: number; u1: number; v0: number; v1: number }, flip = false,
): void {
  const left = flip ? f.u1 : f.u0
  const right = flip ? f.u0 : f.u1
  a[0] = left;  a[1] = f.v1
  a[2] = right; a[3] = f.v1
  a[4] = left;  a[5] = f.v0
  a[6] = right; a[7] = f.v0
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
