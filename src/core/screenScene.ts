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

/** A line segment between two virtual-pixel points, y down. */
export function screenLine(
  x0: number, y0: number, x1: number, y1: number, thickness: number, color: number,
): THREE.Mesh {
  const wy0 = VIRTUAL_H - y0
  const wy1 = VIRTUAL_H - y1
  const dx = x1 - x0
  const dy = wy1 - wy0
  const len = Math.hypot(dx, dy)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(len, thickness),
    new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
  )
  mesh.position.set((x0 + x1) / 2, (wy0 + wy1) / 2, 0)
  mesh.rotation.z = Math.atan2(dy, dx)
  mesh.frustumCulled = false
  return mesh
}

/**
 * A filled convex polygon from virtual-pixel points in order, y down.
 * Fan-triangulated, so the points must describe a convex shape.
 */
export function screenPoly(points: [number, number][], color: number, opacity = 1): THREE.Mesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x, y] of points) positions.push(x, VIRTUAL_H - y, 0)
  for (let i = 1; i < points.length - 1; i++) indices.push(0, i, i + 1)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color, depthTest: false, depthWrite: false,
      transparent: opacity < 1, opacity,
    }),
  )
  mesh.frustumCulled = false
  return mesh
}
