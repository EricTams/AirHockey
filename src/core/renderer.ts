import * as THREE from 'three'
import { VIRTUAL_W, VIRTUAL_H } from './config'

/**
 * Owns the single WebGLRenderer shared by both modes (doc §4). Everything draws
 * into a VIRTUAL_W×VIRTUAL_H target, which is then blitted to the canvas at the
 * largest integer multiple that fits, centred and letterboxed with black.
 *
 * pixelRatio is pinned to 1: the drawing buffer matches CSS pixels, and on HiDPI
 * the browser's own upscale is a clean integer multiple under `image-rendering:
 * pixelated`, so the total scale stays integral and the pixels stay crisp.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer
  readonly target: THREE.WebGLRenderTarget

  private blitScene = new THREE.Scene()
  private blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private scale = 1
  /**
   * Client pixels reserved on the left. The editor's dock sits there, and
   * without this the frame is centred underneath it — hiding the map's first
   * column and the left third of the dialogue box, portrait included.
   *
   * It moves the presented image rather than the camera, so the world and the
   * screen-space UI shift together and picking stays correct: `clientToVirtual`
   * undoes the same offset.
   */
  private inset = 0

  constructor() {
    this.gl = new THREE.WebGLRenderer({ antialias: false, alpha: false })
    this.gl.setPixelRatio(1)
    this.gl.autoClear = false
    document.body.appendChild(this.gl.domElement)

    this.target = new THREE.WebGLRenderTarget(VIRTUAL_W, VIRTUAL_H, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    })

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.target.texture, depthTest: false, depthWrite: false }),
    )
    quad.frustumCulled = false
    this.blitScene.add(quad)

    window.addEventListener('resize', () => this.resize())
    this.resize()
  }

  private resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.gl.setSize(w, h, true)
    const usable = Math.max(1, w - this.inset)
    this.scale = Math.max(1, Math.min(Math.floor(usable / VIRTUAL_W), Math.floor(h / VIRTUAL_H)))
  }

  /** Reserve space on the left of the canvas. 0 restores the centred frame. */
  setViewportInset(px: number): void {
    if (px === this.inset) return
    this.inset = Math.max(0, px)
    this.resize()
  }

  /** Point subsequent draws at the virtual framebuffer. */
  beginFrame(clear: THREE.ColorRepresentation = 0x000000): void {
    this.gl.setRenderTarget(this.target)
    this.gl.setViewport(0, 0, VIRTUAL_W, VIRTUAL_H)
    this.gl.setScissorTest(false)
    this.gl.setClearColor(clear, 1)
    this.gl.clear(true, true, false)
  }

  /** Blit the virtual framebuffer to the canvas, centred and letterboxed. */
  present(): void {
    const cw = this.gl.domElement.width
    const ch = this.gl.domElement.height
    const dw = VIRTUAL_W * this.scale
    const dh = VIRTUAL_H * this.scale
    const dx = this.inset + Math.floor((cw - this.inset - dw) / 2)
    const dy = Math.floor((ch - dh) / 2)

    this.gl.setRenderTarget(null)
    this.gl.setViewport(0, 0, cw, ch)
    this.gl.setScissorTest(false)
    this.gl.setClearColor(0x000000, 1)
    this.gl.clear(true, true, false)

    this.gl.setViewport(dx, dy, dw, dh)
    this.gl.render(this.blitScene, this.blitCamera)
  }

  get integerScale(): number { return this.scale }

  /** The canvas itself, for anything that needs to bind its own pointer events. */
  get canvas(): HTMLCanvasElement { return this.gl.domElement }

  /**
   * Map a client-space point into the virtual framebuffer, accounting for the
   * integer upscale and the letterbox. Returns undefined outside the image.
   */
  clientToVirtual(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const rect = this.gl.domElement.getBoundingClientRect()
    const dw = VIRTUAL_W * this.scale
    const dh = VIRTUAL_H * this.scale
    const ox = this.inset + Math.floor((rect.width - this.inset - dw) / 2)
    const oy = Math.floor((rect.height - dh) / 2)
    const x = (clientX - rect.left - ox) / this.scale
    const y = (clientY - rect.top - oy) / this.scale
    if (x < 0 || y < 0 || x > VIRTUAL_W || y > VIRTUAL_H) return undefined
    return { x, y }
  }

  /** Same point as normalised device coordinates, for raycasting. */
  clientToNdc(clientX: number, clientY: number): THREE.Vector2 | undefined {
    const v = this.clientToVirtual(clientX, clientY)
    if (!v) return undefined
    return new THREE.Vector2((v.x / VIRTUAL_W) * 2 - 1, 1 - (v.y / VIRTUAL_H) * 2)
  }
}
