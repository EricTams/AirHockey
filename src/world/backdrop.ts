import * as THREE from 'three'
import { VIRTUAL_W, VIRTUAL_H } from '../core/config'

/**
 * What sits behind the level once the camera tilts off top-down.
 *
 * The camera gains real convergence as it tilts (see Projection), so distance
 * reads and a true vanishing point exists. At the pitches this game actually
 * uses the horizon still falls above the top of the frame, so what shows past
 * the level is sky and silhouette ridges rather than a visible horizon line.
 *
 * Generated rather than authored, in the same flat-colour idiom as the terrain
 * art: hard bands with ordered dithering at the transitions and no smooth
 * gradients. Sky fills the frame at every tilt; the ridges are separate layers
 * positioned in screen space, which is what carries the composition.
 */

/** Ordered 4x4 Bayer matrix, the classic flat-palette gradient dither. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

type RGB = [number, number, number]

/** Cool tones, so the warm saturated grass and dirt read as foreground. */
const SKY_STOPS: { at: number; color: RGB }[] = [
  { at: 0.00, color: [26, 34, 66] },
  { at: 0.38, color: [43, 66, 104] },
  { at: 0.68, color: [76, 118, 146] },
  { at: 1.00, color: [138, 182, 178] },
]

/**
 * Ridge layers, far to near. `parallax` is the fraction of lateral world motion
 * each scrolls at; `ridgeFlat`/`ridgeTilted` are where the ridge line sits in
 * NDC at each end of the dial. Above +1 is off-screen, which is where ridges
 * park near top-down.
 */
const HILLS: {
  color: RGB; amp: number; freq: number; phase: number
  parallax: number; ridgeFlat: number; ridgeTilted: number
}[] = [
  { color: [52, 80, 99], amp: 22, freq: 2.0, phase: 0.0, parallax: 0.012, ridgeFlat: 1.35, ridgeTilted: 0.80 },
  { color: [36, 58, 70], amp: 30, freq: 1.3, phase: 2.3, parallax: 0.026, ridgeFlat: 1.55, ridgeTilted: 0.62 },
]

/** Fraction of a ridge texture's height sitting above the ridge line. */
const RIDGE_FRAC = 0.15
/** Ridge quad height in NDC; taller than the screen so its fill always reaches the bottom. */
const RIDGE_QUAD_H = 4

function sampleStops(t: number): { lo: RGB; hi: RGB; f: number } {
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const a = SKY_STOPS[i]!
    const b = SKY_STOPS[i + 1]!
    if (t <= b.at || i === SKY_STOPS.length - 2) {
      const span = b.at - a.at
      return { lo: a.color, hi: b.color, f: span > 0 ? (t - a.at) / span : 0 }
    }
  }
  return { lo: SKY_STOPS[0]!.color, hi: SKY_STOPS[0]!.color, f: 0 }
}

function generateSky(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  const img = ctx.createImageData(w, h)
  const px = img.data
  for (let y = 0; y < h; y++) {
    const { lo, hi, f } = sampleStops(y / (h - 1))
    for (let x = 0; x < w; x++) {
      // Dither picks one of the two bounding colours rather than blending, so
      // the result stays on a small flat palette like the rest of the art.
      const threshold = (BAYER[y & 3]![x & 3]! + 0.5) / 16
      const c = f > threshold ? hi : lo
      const o = (y * w + x) * 4
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  return canvas
}

/** One ridge layer: transparent above the ridge line, solid below it. */
function generateRidge(w: number, h: number, layer: (typeof HILLS)[number]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  const baseY = h * RIDGE_FRAC
  ctx.fillStyle = `rgb(${layer.color[0]},${layer.color[1]},${layer.color[2]})`
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let x = 0; x <= w; x++) {
    // Summed sines at whole-number frequencies, so the ridge wraps seamlessly
    // when the layer scrolls.
    const u = (x / w) * Math.PI * 2
    const n =
      Math.sin(u * layer.freq + layer.phase) * 0.6 +
      Math.sin(u * layer.freq * 3 + layer.phase * 2) * 0.3 +
      Math.sin(u * layer.freq * 5 + layer.phase * 3) * 0.1
    ctx.lineTo(x, Math.round(baseY + n * layer.amp))
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fill()
  return canvas
}

function pixelTexture(canvas: HTMLCanvasElement, wrapX: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas)
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = wrapX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

export class Backdrop {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10)
  private skyTex: THREE.CanvasTexture
  private ridges: { mesh: THREE.Mesh; tex: THREE.CanvasTexture; layer: (typeof HILLS)[number] }[] = []
  private materials: THREE.Material[] = []

  constructor() {
    this.skyTex = pixelTexture(generateSky(VIRTUAL_W * 2, VIRTUAL_H), true)
    this.skyTex.repeat.set(0.5, 1)
    this.skyTex.name = 'backdrop:sky'
    this.addLayer(new THREE.PlaneGeometry(2, 2), this.skyTex, -1)

    for (const layer of HILLS) {
      const tex = pixelTexture(generateRidge(VIRTUAL_W * 2, VIRTUAL_H * 2, layer), true)
      tex.repeat.set(0.5, 1)
      tex.name = 'backdrop:ridge'
      const mesh = this.addLayer(new THREE.PlaneGeometry(2, RIDGE_QUAD_H), tex, 0, true)
      this.ridges.push({ mesh, tex, layer })
    }
  }

  private addLayer(
    geo: THREE.BufferGeometry, map: THREE.Texture, z: number, transparent = false,
  ): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      map, transparent, depthTest: false, depthWrite: false,
    })
    this.materials.push(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.z = z
    mesh.frustumCulled = false
    this.scene.add(mesh)
    return mesh
  }

  /**
   * Track the camera. Lateral movement scrolls each layer at its own rate so
   * depth reads; tilt slides the ridges down into frame, since near top-down
   * the horizon belongs above the screen and the level fills the view anyway.
   */
  update(camX: number, camZ: number, pitchDeg: number): void {
    const tilt = Math.max(0, Math.min(1, (90 - pitchDeg) / 55))
    this.skyTex.offset.x = camX * 0.008

    for (const { mesh, tex, layer } of this.ridges) {
      tex.offset.x = camX * layer.parallax
      const ridgeNdc = layer.ridgeFlat + (layer.ridgeTilted - layer.ridgeFlat) * tilt
      // The ridge sits RIDGE_FRAC down a quad of RIDGE_QUAD_H, so the quad's
      // centre must sit that far below where the ridge should land.
      mesh.position.y = ridgeNdc - RIDGE_QUAD_H * (0.5 - RIDGE_FRAC) - camZ * layer.parallax * 0.15
    }
  }

  render(gl: THREE.WebGLRenderer): void {
    gl.render(this.scene, this.camera)
  }

  dispose(): void {
    this.skyTex.dispose()
    for (const r of this.ridges) r.tex.dispose()
    for (const m of this.materials) m.dispose()
  }
}
