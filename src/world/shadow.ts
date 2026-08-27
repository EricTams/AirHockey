import * as THREE from 'three'
import type { PropDef, Tileset } from './tileset'
import { propArt, type ArtTrim } from './artBounds'

/**
 * Ground shadows, in three styles you can flip between.
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
 */

const DEG = Math.PI / 180

export type ShadowStyle = 'none' | 'blob' | 'sharp' | 'soft'

/** Cycle order for the toggle. */
export const SHADOW_STYLES: readonly ShadowStyle[] = ['none', 'blob', 'sharp', 'soft']

export const SHADOW_LABELS: Record<ShadowStyle, string> = {
  none: 'off',
  blob: 'blob',
  sharp: 'cast — sharp',
  soft: 'cast — soft',
}

/**
 * How far the sun leans off vertical. 0 would be straight overhead and cast
 * nothing; 30 gives a shadow a little over half the caster's height, which is
 * long enough to read as a shadow and short enough not to reach the next tile
 * but one.
 */
const SUN_TILT_DEG = 30

/**
 * Compass bearing the shadow runs along, clockwise from north. 45 sends it
 * north-east, which is up and to the right on screen — where a sun sitting
 * below and to the left of the camera puts it.
 */
const SHADOW_BEARING_DEG = 45

/** Not quite black: a cool tint sits better on warm ground art than a hole. */
const TINT = new THREE.Color(0x0b1018)

type CastStyle = 'sharp' | 'soft'

const STRENGTH: Record<Exclude<ShadowStyle, 'none'>, number> = {
  blob: 0.5,
  sharp: 0.44,
  soft: 0.5,
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
 * Where the top of something `h` tiles tall lands on the ground, relative to
 * its base, in tiles. The whole geometry of a cast shadow is this one vector.
 */
export function castOffset(h: number): { dx: number; dz: number } {
  const len = h * Math.tan(SUN_TILT_DEG * DEG)
  const b = SHADOW_BEARING_DEG * DEG
  // Z runs south, so a northward bearing is negative Z.
  return { dx: len * Math.sin(b), dz: -len * Math.cos(b) }
}

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
 */
export class Shadow {
  private uv?: THREE.BufferAttribute
  private material: THREE.Material

  private constructor(readonly mesh: THREE.Mesh, cast: boolean) {
    this.material = mesh.material as THREE.Material
    // Only a cast shadow tracks the sheet; a blob has UVs of its own that
    // nothing ever rewrites, and holding the attribute would invite that.
    if (cast) this.uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute
  }

  /**
   * A prop's shadow, cast by the drawing rather than by its declared region —
   * the same rectangle `buildProp` draws, so the shadow starts at the prop's
   * feet and is as long as the prop is tall.
   */
  static forProp(
    texture: THREE.Texture, tileset: Tileset, def: PropDef, trim: ArtTrim, style: ShadowStyle,
  ): Shadow | undefined {
    if (style === 'none') return undefined
    if (style === 'blob') return new Shadow(blobMesh(def.w * BLOB_OF_PROP), false)

    const art = propArt(tileset, def, trim)
    const mesh = castMesh(art.w, art.h, art, style)
    mesh.name = `shadow:${style}:${def.id}`
    const shadow = new Shadow(mesh, true)
    shadow.point(texture, tileset.sheetW, tileset.sheetH)
    return shadow
  }

  /**
   * A character's shadow. It is built blind — the sprite hands it a frame
   * immediately afterwards and again on every frame change — so a cast shadow
   * stays hidden until it has been given something to draw.
   */
  static forSprite(wTiles: number, hTiles: number, style: ShadowStyle): Shadow | undefined {
    if (style === 'none') return undefined
    if (style === 'blob') return new Shadow(blobMesh(wTiles * BLOB_OF_FRAME), false)

    const mesh = castMesh(wTiles, hTiles, { u0: 0, u1: 1, v0: 0, v1: 1 }, style)
    mesh.name = `shadow:${style}:sprite`
    mesh.visible = false
    return new Shadow(mesh, true)
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
    this.mesh.visible = true
  }

  /** Give the shader its texture and the UV box the blur may not leave. */
  private point(texture: THREE.Texture, sheetW: number, sheetH: number, uv?: Float32Array): void {
    const u = (this.material as THREE.ShaderMaterial).uniforms
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
    this.mesh.position.set(tx, 0, ty + 0.5)
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

/** A flat disc on the ground, `w` tiles across. */
function blobMesh(widthTiles: number): THREE.Mesh {
  const { w, d } = blobSize(widthTiles)
  const geo = new THREE.PlaneGeometry(w, d)
  // Flat on the ground, centred on the base edge so it pools at the foot.
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: getBlobTexture(),
    color: TINT,
    transparent: true,
    opacity: STRENGTH.blob,
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
function castMesh(wTiles: number, hTiles: number, uv: UvRect, style: CastStyle): THREE.Mesh {
  const { dx, dz } = castOffset(hTiles)
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
      tint: { value: TINT.clone() },
      blur: { value: BLUR_PX[style] },
      strength: { value: STRENGTH[style] },
      tipFade: { value: TIP_FADE[style] },
      hard: { value: style === 'sharp' ? 1 : 0 },
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
