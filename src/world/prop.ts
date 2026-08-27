import * as THREE from 'three'
import type { PropDef, Tileset } from './tileset'
import { propArt, NO_TRIM, type ArtTrim } from './artBounds'
import type { Projection } from './projection'

/**
 * A tileset prop placed in the world: a multi-cell region of the sheet drawn as
 * one billboard rather than merged into a tile layer.
 *
 * The distinction is not an editor convenience. A tile is a flat quad in the XZ
 * plane and stays flat when the camera tilts; a prop stands upright and y-sorts
 * against the sprites, which is what makes a tree a tree rather than a picture
 * of one painted on the ground.
 */

/**
 * Where the billboard's own origin tile sits, given that the prop's `anchor`
 * cell is the one standing on `(x, y)`.
 *
 * `placeBillboard` puts a w×h plane with its origin at bottom-centre on a tile,
 * so the plane covers x ∈ [tx - w/2, tx + w/2] and z ∈ [ty + 0.5 - h, ty + 0.5].
 * Solving for the anchor cell's centre landing on (x, y) gives the offsets
 * below. A 1×1 prop anchored at its only cell resolves to (x, y) unchanged.
 */
export function propOrigin(def: PropDef, x: number, y: number): { tx: number; ty: number } {
  const [ax, ay] = def.anchor
  return {
    tx: x + def.w / 2 - ax - 0.5,
    ty: y + def.h - ay - 1,
  }
}

/**
 * One prop's quad, sized in tiles and UV'd to the drawing inside its region.
 *
 * Sized to the drawing rather than to the region, so the quad's bottom edge is
 * the drawing's bottom edge. A region is whole cells and nothing makes the art
 * fill it; since a billboard stands on the bottom edge of its quad, any empty
 * strip below the art is exactly how far the prop would float. See `propArt`
 * for why this is a smaller quad and not a shifted one.
 */
export function buildProp(
  texture: THREE.Texture, tileset: Tileset, def: PropDef, trim: ArtTrim = NO_TRIM,
): THREE.Mesh {
  const { w, h, u0, u1, v0, v1 } = propArt(tileset, def, trim)
  const geo = new THREE.PlaneGeometry(w, h)
  // Origin at the bottom edge, which is what placeBillboard rotates about.
  geo.translate(0, h / 2, 0)
  const uv = geo.getAttribute('uv')
  // PlaneGeometry's vertices run top-left, top-right, bottom-left, bottom-right.
  uv.setXY(0, u0, v1)
  uv.setXY(1, u1, v1)
  uv.setXY(2, u0, v0)
  uv.setXY(3, u1, v0)
  uv.needsUpdate = true

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.5,
    // Coplanar with the ground and the sprites at top-down pitch, so ordering
    // is by renderOrder like everything else in this scene.
    depthWrite: false,
    depthTest: false,
  }))
  mesh.name = `prop:${def.id}`
  mesh.frustumCulled = false
  return mesh
}

/** Stand a built prop on its tile and give it its place in the sort. */
export function placeProp(
  proj: Projection, mesh: THREE.Mesh, def: PropDef, x: number, y: number,
): void {
  const { tx, ty } = propOrigin(def, x, y)
  proj.placeBillboard(mesh, tx, ty)
  // Sorted by the tile it stands on, not by the top of its bounding box, or a
  // tall tree would draw behind a character standing well in front of it.
  mesh.renderOrder = proj.sortKey(y)
}
