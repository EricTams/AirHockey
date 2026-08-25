import * as THREE from 'three'

/**
 * A merged flat quad per tile, all sampling one tileset cell — the minimal
 * slice of the tile-layer builder needed to stand the overworld on real art.
 * The full ground/overlay/overhead layer builder lands in M3.
 */
export interface Cell { col: number; row: number }

export function buildGroundMesh(
  texture: THREE.Texture,
  cols: number, rows: number,
  cellAt: (tx: number, ty: number) => Cell,
  tilePx: number,
  sheetW: number, sheetH: number,
): THREE.Mesh {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  // Inset by a fraction of a texel so neighbouring cells never bleed in.
  const eps = 0.01

  let q = 0
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const cell = cellAt(tx, ty)
      const u0 = (cell.col * tilePx + eps) / sheetW
      const u1 = ((cell.col + 1) * tilePx - eps) / sheetW
      const v0 = 1 - ((cell.row + 1) * tilePx - eps) / sheetH
      const v1 = 1 - (cell.row * tilePx + eps) / sheetH

      const x0 = tx - 0.5, x1 = tx + 0.5
      const z0 = ty - 0.5, z1 = ty + 0.5
      // Flat in XZ, facing up.
      positions.push(x0, 0, z1, x1, 0, z1, x1, 0, z0, x0, 0, z0)
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1)
      const b = q * 4
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
      q++
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture }))
  mesh.frustumCulled = false
  return mesh
}
