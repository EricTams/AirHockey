import * as THREE from 'three'
import { VIRTUAL_W, VIRTUAL_H } from './config'

/**
 * Orthographic screen space for the UI layer (doc §9) and debug patterns,
 * authored in virtual pixels with a top-left origin and y increasing downward.
 *
 * The camera itself is NOT y-flipped. Building the flip into the projection
 * (top=0, bottom=H) mirrors it, which reverses triangle winding and silently
 * backface-culls every quad. The y-down convention is applied per-object in
 * `screenRect` instead, so materials can stay single-sided.
 */
export function makeScreenCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(0, VIRTUAL_W, VIRTUAL_H, 0, -1000, 1000)
  cam.position.z = 100
  return cam
}

/** Axis-aligned rect in virtual pixels, top-left anchored, y down. */
export function screenRect(x: number, y: number, w: number, h: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
  )
  mesh.position.set(x + w / 2, VIRTUAL_H - (y + h / 2), 0)
  mesh.frustumCulled = false
  return mesh
}
