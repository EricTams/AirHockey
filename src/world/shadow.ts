import * as THREE from 'three'
import type { PropDef, Tileset } from './tileset'
import { propArt, type ArtTrim } from './artBounds'
import { castOffset, type Daylight } from './daylight'

/**
 * Ground shadows, in a handful of styles you can flip between.
 *
 * None of this is a real shadow, and at top-down pitch it cannot be. A prop or
 * a character is a billboard: at pitch 90 it already lies flat on the ground,
 * so its true projection onto the ground is itself. The trick is to draw the
 * shadow it would cast if it were standing up — which is what the player reads
 * it as — and to lay that on the ground so it stays put when the camera tilts
 * and the thing casting it really does stand up.
 *
 *   blob   a soft pool at the foot. Cheap, reads instantly, tells you nothing
 *          about the shape of the thing casting it.
 *   sharp  the silhouette itself, sheared out along the sun. Hard edge, flat
 *          black — a bright midday look that sits well with pixel art.
 *   soft   the same silhouette blurred, tightest at the contact point and
 *          spreading toward the tip, which is how a real penumbra behaves.
 *   combo  soft, plus a small tight blob at the foot. The cast shadow carries
 *          the shape and the blob carries the contact, which a cast shadow
 *          alone is weakest at: its darkest point is spread over the whole
 *          silhouette, so nothing pins the caster to the ground. The two
 *          halves are drawn fainter than either is on its own so that where
 *          they overlap they land near a single shadow's weight rather than
 *          stacking into a hole.
 */

export type ShadowStyle = 'none' | 'blob' | 'sharp' | 'soft' | 'combo'

/** Cycle order for the toggle. */
export const SHADOW_STYLES: readonly ShadowStyle[] = ['none', 'blob', 'sharp', 'soft', 'combo']

/** What the world starts with, and what the toggle cycles away from. */
export const DEFAULT_SHADOW_STYLE: ShadowStyle = 'soft'

export const SHADOW_LABELS: Record<ShadowStyle, string> = {
  none: 'off',
  blob: 'blob',
  sharp: 'cast — sharp',
  soft: 'cast — soft',
  combo: 'blob + soft',
}

/** The styles that shear a silhouette out along the sun. */
type CastStyle = 'sharp' | 'soft'
type CastingStyle = CastStyle | 'combo'

/**
 * How dark each style draws at full daylight. The hour scales this — a shadow
 * at midnight is a hint rather than a hole — and picks its colour; see
 * `Light` in `daylight.ts`.
 *
 * `combo` is the strength of its cast half; its blob has its own, below,
 * because the two are drawn on top of each other.
 */
const STRENGTH: Record<Exclude<ShadowStyle, 'none'>, number> = {
  blob: 0.5,
  sharp: 0.44,
  soft: 0.5,
  combo: 0.42,
}

/** Blur radius at the tip, in source pixels. Zero is a hard edge. */
const BLUR_PX: Record<CastStyle, number> = { sharp: 0, soft: 6 }

/** How much of its strength a cast shadow keeps out at the tip. */
const TIP_FADE: Record<CastStyle, number> = { sharp: 1, soft: 0.4 }

/**
 * How much of the caster's own width a blob spans. Props are cut to their art,
 * so a blob can be nearly as wide as the prop; a character's frame is a box
 * with air either side of the body, so its blob has to be a good deal smaller
 * than the frame or it pools out past the character's shoulders.
 */
const BLOB_OF_PROP = 0.82
const BLOB_OF_FRAME = 0.5

/**
 * The combo's blob, against the blob the same caster would get on its own.
 * Smaller, so it reads as the dark right under the caster rather than as a
 * second shadow beside the cast one; and fainter, so the two together at the
 * contact point come out about as dark as one shadow.
 */
const COMBO_BLOB_SCALE = 0.62
const COMBO_BLOB_STRENGTH = 0.3

/**
 * Footprint of a blob, in tiles. Wider than deep because the ground is being
 * looked at from above at a slant, so a circle would read as an egg standing
 * on end.
 */
export function blobSize(widthTiles: number): { w: number; d: number } {
  return { w: widthTiles, d: widthTiles * 0.56 }
}

let blobTexture: THREE.Texture | undefined

/**
 * A white disc with a soft alpha falloff, tinted by the material. Built once
 * and shared: every blob in the world is the same picture at a different size.
 */
function getBlobTexture(): THREE.Texture {
  if (blobTexture) return blobTexture
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const r = size / 2
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r)
  // Flat-ish in the middle with the falloff pushed to the rim, so the blob
  // reads as an object's shadow rather than as a lens flare.
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.94)')
  grad.addColorStop(0.75, 'rgba(255,255,255,0.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  blobTexture = new THREE.CanvasTexture(canvas)
  blobTexture.colorSpace = THREE.SRGBColorSpace
  blobTexture.name = 'shadow:blob'
  return blobTexture
}

const VERTEX = /* glsl */`
attribute float rise;
varying vec2 vUv;
varying float vRise;
void main() {
  vUv = uv;
  vRise = rise;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/**
 * Alpha from the caster's own region of its sheet, optionally blurred.
 *
 * The blur is a plain disc of taps rather than a separable two-pass Gaussian:
 * there is one small quad per caster on screen, so the cost is nothing, and a
 * second pass would mean a render target for a handful of pixels.
 *
 * Taps are clamped to the caster's UV rect. Without that the blur reaches into
 * whatever sits next on the sheet, and a tree's shadow grows a corner of the
 * roof beside it — or a walking character's shadow grows the next frame's arm.
 */
const FRAGMENT = /* glsl */`
uniform sampler2D map;
uniform vec2 uvMin;
uniform vec2 uvMax;
uniform vec2 texel;
uniform vec3 tint;
uniform float blur;
uniform float strength;
uniform float tipFade;
uniform float hard;
varying vec2 vUv;
varying float vRise;

float alphaAt(vec2 uv) {
  return texture2D(map, clamp(uv, uvMin, uvMax)).a;
}

void main() {
  float a = alphaAt(vUv);

  if (blur > 0.0) {
    // Contact hardening: crisp where the caster meets the ground, spreading
    // out toward the tip. This is most of what sells a soft shadow as soft.
    float r = blur * (0.15 + 0.85 * vRise);
    float sum = a;
    float weight = 1.0;
    for (int ring = 1; ring <= 3; ring++) {
      float rr = r * float(ring) / 3.0;
      float w = 1.0 - float(ring) / 4.0;
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.7853981634 + float(ring) * 0.2617993878;
        vec2 d = vec2(cos(ang), sin(ang)) * rr * texel;
        sum += alphaAt(vUv + d) * w;
        weight += w;
      }
    }
    a = sum / weight;
  }

  // A hard shadow wants the sprite's own cutout, not its antialiased rim.
  if (hard > 0.5) a = step(0.5, a);

  float fade = mix(1.0, tipFade, vRise);
  float shade = a * strength * fade;
  if (shade <= 0.003) discard;
  gl_FragColor = vec4(tint, shade);
}
`

/** UV rect, in the vertex order PlaneGeometry uses: TL, TR, BL, BR. */
type UvRect = { u0: number; u1: number; v0: number; v1: number }

/**
 * One caster's shadow: a quad lying in the ground plane, and whatever it takes
 * to keep it pointed at the right picture.
 *
 * A prop's silhouette never changes, so its shadow is built once and only ever
 * moved. A character's changes every frame of the walk, so `setFrame` re-points
 * the same quad at the frame the sprite is showing.
 *
 * The hour is baked in at build time — the shear is vertex positions, not a
 * uniform — so moving the sun means throwing every shadow away and building it
 * again. That is already how a style change works, and the hour changes about
 * as often.
 */
export class Shadow {
  /** What to hang in the world's shadow group. */
  readonly object: THREE.Object3D
  private uv?: THREE.BufferAttribute
  private cast?: THREE.Mesh

  /**
   * `cast`, when there is one, must also appear in `parts`: it is the quad
   * that follows the sheet, and the rest are drawn and forgotten.
   */
  private constructor(private parts: THREE.Mesh[], cast?: THREE.Mesh) {
    // A single-part shadow hangs its own mesh in the world; only the combo
    // pays for a group, and then it is one node for both halves to be moved by.
    this.object = parts.length === 1 ? parts[0]! : group(parts)
    this.cast = cast
    // Only a cast shadow tracks the sheet; a blob has UVs of its own that
    // nothing ever rewrites, and holding the attribute would invite that.
    if (cast) this.uv = cast.geometry.getAttribute('uv') as THREE.BufferAttribute
  }

  /**
   * A prop's shadow, cast by the drawing rather than by its declared region —
   * the same rectangle `buildProp` draws, so the shadow starts at the prop's
   * feet and is as long as the prop is tall.
   */
  static forProp(
    texture: THREE.Texture, tileset: Tileset, def: PropDef, trim: ArtTrim, style: ShadowStyle,
    day: Daylight,
  ): Shadow | undefined {
    if (style === 'none') return undefined
    const blobW = def.w * BLOB_OF_PROP
    if (style === 'blob') return new Shadow([blobMesh(blobW, STRENGTH.blob, day)])

    const art = propArt(tileset, def, trim)
    const mesh = castMesh(art.w, art.h, art, style, day)
    mesh.name = `shadow:${style}:${def.id}`
    const shadow = new Shadow(withComboBlob(mesh, blobW, style, day), mesh)
    shadow.point(texture, tileset.sheetW, tileset.sheetH)
    return shadow
  }

  /**
   * A character's shadow. It is built blind — the sprite hands it a frame
   * immediately afterwards and again on every frame change — so a cast shadow
   * stays hidden until it has been given something to draw.
   */
  static forSprite(
    wTiles: number, hTiles: number, style: ShadowStyle, day: Daylight,
  ): Shadow | undefined {
    if (style === 'none') return undefined
    const blobW = wTiles * BLOB_OF_FRAME
    if (style === 'blob') return new Shadow([blobMesh(blobW, STRENGTH.blob, day)])

    const mesh = castMesh(wTiles, hTiles, { u0: 0, u1: 1, v0: 0, v1: 1 }, style, day)
    mesh.name = `shadow:${style}:sprite`
    // Hidden until a frame arrives. A combo's blob is not: it is the same
    // pool whatever the sprite is doing, so there is nothing to wait for.
    mesh.visible = false
    return new Shadow(withComboBlob(mesh, blobW, style, day), mesh)
  }

  /**
   * Point a cast shadow at the frame a sprite is currently showing.
   *
   * The UV array is the sprite's own, already written in PlaneGeometry order
   * and already mirrored if this facing is drawn flipped, so it is copied
   * rather than recomputed — there is then no way for the two to disagree.
   */
  setFrame(texture: THREE.Texture, sheetW: number, sheetH: number, uv: ArrayLike<number>): void {
    if (!this.uv) return   // a blob does not care what the sprite is doing
    const a = this.uv.array as Float32Array
    for (let i = 0; i < 8; i++) a[i] = uv[i]!
    this.uv.needsUpdate = true
    this.point(texture, sheetW, sheetH, a)
    this.cast!.visible = true
  }

  /** Give the shader its texture and the UV box the blur may not leave. */
  private point(texture: THREE.Texture, sheetW: number, sheetH: number, uv?: Float32Array): void {
    const u = (this.cast!.material as THREE.ShaderMaterial).uniforms
    u.map!.value = texture
    u.texel!.value.set(1 / sheetW, 1 / sheetH)
    if (!uv) return
    // Mirroring swaps u0 and u1, so the box is min/max of the corners rather
    // than the corners themselves.
    u.uvMin!.value.set(Math.min(uv[0]!, uv[2]!), Math.min(uv[1]!, uv[5]!))
    u.uvMax!.value.set(Math.max(uv[0]!, uv[2]!), Math.max(uv[1]!, uv[5]!))
  }

  /**
   * Stand the shadow at the caster's feet.
   *
   * Unlike the caster, this is never billboarded: it stays lying on the ground
   * however far the camera tilts, which is the whole point of drawing it.
   * Billboards are pinned to the south edge of their tile, so that is where the
   * feet are and where the shadow starts.
   */
  place(tx: number, ty: number): void {
    this.object.position.set(tx, 0, ty + 0.5)
  }

  dispose(): void {
    this.object.removeFromParent()
    for (const part of this.parts) {
      part.geometry.dispose()
      ;(part.material as THREE.Material).dispose()
    }
  }
}

/** The parts of a combo: its contact blob under the cast shadow it goes with. */
function withComboBlob(
  cast: THREE.Mesh, widthTiles: number, style: ShadowStyle, day: Daylight,
): THREE.Mesh[] {
  if (style !== 'combo') return [cast]
  // Blob first, so the cast shadow lands on top of it where they overlap.
  return [blobMesh(widthTiles * COMBO_BLOB_SCALE, COMBO_BLOB_STRENGTH, day), cast]
}

/** One node holding both halves of a combo, so `place` moves them together. */
function group(parts: THREE.Mesh[]): THREE.Group {
  const g = new THREE.Group()
  g.name = 'shadow:combo'
  for (const part of parts) g.add(part)
  return g
}

/** A flat disc on the ground, `w` tiles across. */
function blobMesh(widthTiles: number, strength: number, day: Daylight): THREE.Mesh {
  const { w, d } = blobSize(widthTiles)
  const geo = new THREE.PlaneGeometry(w, d)
  // Flat on the ground, centred on the base edge so it pools at the foot.
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: getBlobTexture(),
    color: day.light.shadowTint,
    transparent: true,
    opacity: strength * day.light.shadow,
    depthWrite: false,
    depthTest: false,
  }))
  mesh.name = 'shadow:blob'
  mesh.frustumCulled = false
  return mesh
}

/**
 * The silhouette sheared out along the sun: a parallelogram whose base edge
 * stays at the caster's feet and whose top edge slides out by `castOffset`.
 */
function castMesh(
  wTiles: number, hTiles: number, uv: UvRect, style: CastingStyle, day: Daylight,
): THREE.Mesh {
  // The combo's cast half is a soft shadow; only its strength differs.
  const look: CastStyle = style === 'combo' ? 'soft' : style
  const { dx, dz } = castOffset(hTiles, day.sun)
  const hw = wTiles / 2

  // Same vertex order as the sprite quads — top-left, top-right, bottom-left,
  // bottom-right — so a sprite's UV array can be copied straight in.
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    -hw + dx, 0, dz,
    hw + dx, 0, dz,
    -hw, 0, 0,
    hw, 0, 0,
  ], 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([
    uv.u0, uv.v1, uv.u1, uv.v1, uv.u0, uv.v0, uv.u1, uv.v0,
  ], 2))
  // 0 where the shadow touches the caster's feet, 1 at the far tip.
  geo.setAttribute('rise', new THREE.Float32BufferAttribute([1, 1, 0, 0], 1))
  geo.setIndex([0, 2, 1, 2, 3, 1])

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      map: { value: null },
      uvMin: { value: new THREE.Vector2(Math.min(uv.u0, uv.u1), Math.min(uv.v0, uv.v1)) },
      uvMax: { value: new THREE.Vector2(Math.max(uv.u0, uv.u1), Math.max(uv.v0, uv.v1)) },
      texel: { value: new THREE.Vector2(0, 0) },
      tint: { value: new THREE.Color(day.light.shadowTint) },
      blur: { value: BLUR_PX[look] },
      strength: { value: STRENGTH[style] * day.light.shadow },
      tipFade: { value: TIP_FADE[look] },
      hard: { value: look === 'sharp' ? 1 : 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // The quad is authored flat in XZ and never billboarded, so which way it
    // faces depends on where the sun put it.
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  return mesh
}
