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
    this.scale = Math.max(1, Math.min(Math.floor(w / VIRTUAL_W), Math.floor(h / VIRTUAL_H)))
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
    const dx = Math.floor((cw - dw) / 2)
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
}
