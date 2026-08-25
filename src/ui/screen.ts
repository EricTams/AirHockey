import * as THREE from 'three'
import { makeScreenCamera } from '../core/screenScene'

/**
 * The screen-space layer (doc §9): dialogue box, score, countdown and result
 * text all draw through this, over the active world scene and into the same
 * virtual framebuffer.
 */
export class ScreenLayer {
  readonly scene = new THREE.Scene()
  private camera = makeScreenCamera()
  private owned: THREE.Object3D[] = []
  private pinned: THREE.Object3D[] = []

  /**
   * Add something that survives `set`. Rebuilt-every-tick content goes through
   * `set`; anything static and expensive (a portrait) is pinned once instead.
   */
  pin(obj: THREE.Object3D): void {
    this.scene.add(obj)
    this.pinned.push(obj)
  }

  unpinAll(): void {
    for (const o of this.pinned) {
      this.scene.remove(o)
      const mesh = o as THREE.Mesh
      mesh.geometry?.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    }
    this.pinned.length = 0
  }

  /** Replace the layer's contents, disposing what the previous build made. */
  set(objects: THREE.Object3D[]): void {
    this.clear()
    for (const o of objects) {
      this.scene.add(o)
      this.owned.push(o)
    }
  }

  /** Clears only `set` content; pinned objects stay. */
  clear(): void {
    for (const o of this.owned) {
      this.scene.remove(o)
      const mesh = o as THREE.Mesh
      mesh.geometry?.dispose()
      const mat = mesh.material
      // Textures are owned by Assets or the font, so only materials are freed.
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    }
    this.owned.length = 0
  }

  render(gl: THREE.WebGLRenderer): void {
    gl.render(this.scene, this.camera)
  }
}
