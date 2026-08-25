import * as THREE from 'three'
import { TILE, VIRTUAL_W, VIRTUAL_H, HEIGHT_STEP, CAMERA_PITCH_DEG } from '../core/config'

const DEG = Math.PI / 180

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
 * Billboards rotate about their BOTTOM EDGE, which is pinned to the SOUTH edge
 * of the tile (ty + 0.5). At pitch 90 that makes a one-tile-tall sprite cover
 * exactly its own tile; anchoring at the tile centre instead would shift it
 * half a tile north of where it logically stands.
 */
export class Projection {
  readonly camera: THREE.OrthographicCamera
  private pitch: number

  constructor(pitchDeg = CAMERA_PITCH_DEG) {
    this.pitch = pitchDeg
    const halfW = VIRTUAL_W / TILE / 2   // 10 tiles
    const halfH = VIRTUAL_H / TILE / 2   // 5.625 tiles
    this.camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 200)
  }

  get pitchDeg(): number { return this.pitch }

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
    const px = Math.round(x * TILE) / TILE
    const pz = Math.round(z * TILE) / TILE
    const y = height * HEIGHT_STEP
    const p = this.pitch * DEG
    const dist = 50
    this.camera.position.set(px, y + Math.sin(p) * dist, pz + Math.cos(p) * dist)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(px, y, pz)
    this.camera.updateMatrixWorld()
  }

  /**
   * Draw order for the billboard group. At pitch 90 sprites and ground are
   * coplanar so depth testing cannot separate them; sort by southness, then
   * height, so nearer and higher things draw last.
   */
  sortKey(ty: number, height = 0): number {
    return Math.round(ty * 16) + height * 4096
  }
}
