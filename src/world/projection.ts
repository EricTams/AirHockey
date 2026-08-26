import * as THREE from 'three'
import {
  TILE, VIRTUAL_W, VIRTUAL_H, HEIGHT_STEP, CAMERA_PITCH_DEG,
  FOV_FLAT_DEG, FOV_TILTED_DEG,
} from '../core/config'

const DEG = Math.PI / 180

/** The plane every ground pick is against: y = 0, where tile quads lie. */
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 6

/**
 * The overworld camera rig, as one dial rather than two code paths.
 *
 * World axes: X right, Y up, Z south. A map tile (tx, ty) sits at world
 * (tx, height * HEIGHT_STEP, ty), and ground quads lie flat in the XZ plane.
 *
 * Every non-ground quad — character sprites, props, cliff faces — is a
 * billboard rotated about X by -pitch, so its normal always points at the
 * camera:
 *
 *   pitch 90  camera straight down; billboards lie flat on the ground,
 *             giving the classic top-down look. This is what v1 ships.
 *   pitch ~35 the identical quads stand upright as real walls and props.
 *
 * Projection follows the same dial. Rather than switching camera types — a
 * visible cut mid-scrub — this is always a PerspectiveCamera whose FOV is
 * driven by pitch. A ~1 degree FOV at long range is optically orthographic, so
 * the flat view stays pixel-exact; widening it as the camera tilts introduces
 * real convergence, which is what gives the tilted view a true horizon and
 * makes distance read.
 *
 * Billboards rotate about their BOTTOM EDGE, which is pinned to the SOUTH edge
 * of the tile (ty + 0.5). At pitch 90 that makes a one-tile-tall sprite cover
 * exactly its own tile; anchoring at the tile centre instead would shift it
 * half a tile north of where it logically stands.
 */
export class Projection {
  readonly camera: THREE.PerspectiveCamera
  private pitch: number

  /** Half-height of the framed area at the focus plane, in tiles, at 1x. */
  private static readonly BASE_HALF_H = VIRTUAL_H / TILE / 2   // 5.625 tiles

  /**
   * Framing scale. The game runs at 1x and never touches this; the editor does,
   * because a fixed 11.25-tile-tall view makes anything larger than the entry
   * map painful to work on. Above 1 shows less and larger, below 1 more and
   * smaller.
   */
  private zoomLevel = 1

  constructor(pitchDeg = CAMERA_PITCH_DEG) {
    this.pitch = pitchDeg
    this.camera = new THREE.PerspectiveCamera(FOV_FLAT_DEG, VIRTUAL_W / VIRTUAL_H, 0.1, 4000)
  }

  /** 0 at top-down, 1 at full tilt. Drives both FOV and the flatness tests. */
  private get tilt(): number {
    return Math.max(0, Math.min(1, (90 - this.pitch) / 55))
  }

  get fovDeg(): number {
    return FOV_FLAT_DEG + (FOV_TILTED_DEG - FOV_FLAT_DEG) * this.tilt
  }

  get pitchDeg(): number { return this.pitch }

  get zoom(): number { return this.zoomLevel }

  /** Clamped so the framed area cannot collapse or swallow an entire world. */
  setZoom(z: number): void {
    this.zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
  }

  /** Half-height of the framed area right now, in tiles. */
  private get halfH(): number { return Projection.BASE_HALF_H / this.zoomLevel }

  /** Tiles across and down that the camera currently frames. */
  get framedTiles(): { w: number; h: number } {
    const h = this.halfH * 2
    return { w: h * (VIRTUAL_W / VIRTUAL_H), h }
  }

  setPitchDeg(deg: number): void {
    this.pitch = Math.max(5, Math.min(90, deg))
  }

  /** True while the rig is flat enough that billboards are coplanar with the ground. */
  get isFlat(): boolean { return this.pitch > 80 }

  /** World position of a tile's centre at a given integer height. */
  tileToWorld(tx: number, ty: number, height = 0): THREE.Vector3 {
    return new THREE.Vector3(tx, height * HEIGHT_STEP, ty)
  }

  /**
   * Orient and place a billboard whose geometry is a plane of `wTiles`×`hTiles`
   * with its origin at the bottom-centre, standing on tile (tx, ty).
   */
  placeBillboard(obj: THREE.Object3D, tx: number, ty: number, height = 0): void {
    obj.rotation.set(-this.pitch * DEG, 0, 0)
    obj.position.set(tx, height * HEIGHT_STEP, ty + 0.5)
  }

  /**
   * Point the camera at a world position. Snaps to the virtual pixel grid after
   * the follow, or sub-pixel camera motion shimmers the whole scene.
   */
  lookAt(x: number, z: number, height = 0): void {
    // Snapping only means anything while the projection is effectively
    // orthographic; under real convergence there is no fixed pixel grid.
    const px = this.isFlat ? Math.round(x * TILE) / TILE : x
    const pz = this.isFlat ? Math.round(z * TILE) / TILE : z
    const y = height * HEIGHT_STEP

    // Pull the camera back far enough that the framed area stays the same size
    // at the focus plane whatever the FOV, so widening the lens adds
    // convergence without also zooming.
    const fov = this.fovDeg
    const dist = this.halfH / Math.tan((fov / 2) * DEG)

    const p = this.pitch * DEG
    this.camera.fov = fov
    this.camera.position.set(px, y + Math.sin(p) * dist, pz + Math.cos(p) * dist)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(px, y, pz)
    // Track the planes to the distance, or depth precision collapses at the
    // very long throws a narrow FOV needs.
    this.camera.near = Math.max(0.1, dist * 0.05)
    this.camera.far = dist * 4
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  /**
   * World point where a ray through a normalised-device point meets the ground.
   *
   * Tile centres sit at integers — a tile quad spans tx-0.5 to tx+0.5 — so the
   * tile under this point is Math.round, not Math.floor. Returns undefined when
   * the ray runs parallel to the ground, which a tilted camera aimed at the
   * horizon can manage.
   */
  pickGround(ndc: THREE.Vector2): { x: number; z: number } | undefined {
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.ray.intersectPlane(GROUND, new THREE.Vector3())
    return hit ? { x: hit.x, z: hit.z } : undefined
  }

  private raycaster = new THREE.Raycaster()

  /**
   * Draw order for the billboard group. At pitch 90 sprites and ground are
   * coplanar so depth testing cannot separate them; sort by southness, then
   * height, so nearer and higher things draw last.
   */
  sortKey(ty: number, height = 0): number {
    return Math.round(ty * 16) + height * 4096
  }
}
