import * as THREE from 'three'
import { cellUv, EMPTY_TILE } from './tileset'
import type { Tileset } from './tileset'
import type { GameMap, LayerName } from './map'
import { tileAt } from './map'

/**
 * One merged quad per non-empty cell: a single draw call per layer.
 *
 * Draw order (doc §6.2) is ground, decoration, sprites y-sorted, overhead. At
 * top-down pitch every one of those is coplanar, so depth testing cannot
 * separate them and `renderOrder` has to. Sprites take theirs from
 * Projection.sortKey, which is bounded by the map height in tiles, so the tile
 * layers bracket that range from well outside it.
 *
 * Three sorts its transparent list after its opaque one, whatever the
 * renderOrder. That is why decoration and overhead are transparent even though
 * alphaTest alone would cut them out: they have to share the sprites' list to
 * sort against sprites at all. Ground has nothing to sort against and stays
 * opaque.
 */
const LAYER_ORDER: Record<LayerName, { renderOrder: number; transparent: boolean }> = {
  ground:     { renderOrder: 0,      transparent: false },
  decoration: { renderOrder: -1000,  transparent: true },
  overhead:   { renderOrder: 100000, transparent: true },
}

export function buildTileLayer(
  texture: THREE.Texture, map: GameMap, layer: LayerName, tileset: Tileset,
): THREE.Mesh {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  let q = 0
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const index = tileAt(map, layer, tx, ty)
      if (index === EMPTY_TILE) continue

      const { u0, u1, v0, v1 } = cellUv(tileset, index)
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

  const { renderOrder, transparent } = LAYER_ORDER[layer]
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: texture,
    transparent,
    alphaTest: transparent ? 0.5 : 0,
    // Coplanar with the sprites at top-down pitch, so let renderOrder decide
    // rather than a depth comparison that is a tie by construction.
    depthWrite: false,
    depthTest: false,
  }))
  mesh.name = `layer:${layer}`
  mesh.renderOrder = renderOrder
  mesh.frustumCulled = false
  return mesh
}

/** Quad count, i.e. non-empty cells. Exposed for tests and the debug overlay. */
export function layerQuadCount(map: GameMap, layer: LayerName): number {
  return map.layers[layer].reduce((n, t) => (t === EMPTY_TILE ? n : n + 1), 0)
}
