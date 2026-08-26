import * as THREE from 'three'
import type { GameMap } from '../world/map'

/**
 * The editor's own geometry, drawn into the game's scene: the tile grid, the
 * collision mask, the map border, and whatever the current tool is about to
 * touch.
 *
 * In the scene rather than in DOM over the canvas, for two reasons. It has to
 * survive the camera being tilted or zoomed, which a DOM overlay would need a
 * world-to-client projection to manage — and the game does not have one, only
 * the inverse. And drawing it into the same 960x540 target as the world means
 * the designer sees the grid at the resolution the art is actually authored at.
 *
 * Everything here is coplanar with the ground at top-down pitch, so like the
 * tile layers it turns depth testing off and orders by hand. It sits above the
 * overhead layer's 100000, since the point of a grid is to be visible.
 */

const ORDER = {
  collision: 200_000,
  grid: 200_100,
  border: 200_200,
  marks: 200_250,
  cursor: 200_300,
}

/** Small lifts off the ground so a tilted camera does not z-fight the tiles. */
const Y = {
  collision: 0.010,
  grid: 0.020,
  border: 0.021,
  marks: 0.025,
  cursor: 0.030,
}

/**
 * The grid has to read over both the brightest and the darkest art on the
 * sheet, from one colour, at one virtual pixel wide. A light line at moderate
 * opacity is the compromise: dark lines vanish into shadowed tiles, and
 * anything stronger competes with the art it is there to help you place.
 */
const COLOR = {
  grid: 0xdbe6f5,
  border: 0xe0b64a,
  collision: 0xd2453f,
  marks: 0x59c9f0,
  cursor: 0xffffff,
}

export class EditorOverlay {
  readonly group = new THREE.Group()

  private grid?: THREE.LineSegments
  private border?: THREE.LineSegments
  private collision?: THREE.Mesh
  private marks?: THREE.Mesh
  private cursor?: THREE.Mesh

  private gridVisible = true
  private collisionVisible = false

  constructor() {
    this.group.name = 'editor:overlay'
    // Nothing here is inside the frustum bounds Three computes for it once the
    // camera pulls back to its near-orthographic throw.
    this.group.frustumCulled = false
  }

  /** Rebuild everything that depends on the map's size. */
  setMap(map: GameMap): void {
    this.buildGrid(map)
    this.buildBorder(map)
    this.setCollision(map)
  }

  setGridVisible(on: boolean): void {
    this.gridVisible = on
    if (this.grid) this.grid.visible = on
  }

  setCollisionVisible(on: boolean): void {
    this.collisionVisible = on
    if (this.collision) this.collision.visible = on
  }

  get isGridVisible(): boolean { return this.gridVisible }
  get isCollisionVisible(): boolean { return this.collisionVisible }

  private buildGrid(map: GameMap): void {
    this.drop('grid')
    const pts: number[] = []
    const x0 = -0.5, x1 = map.width - 0.5
    const z0 = -0.5, z1 = map.height - 0.5
    for (let x = 0; x <= map.width; x++) {
      pts.push(x - 0.5, Y.grid, z0, x - 0.5, Y.grid, z1)
    }
    for (let z = 0; z <= map.height; z++) {
      pts.push(x0, Y.grid, z - 0.5, x1, Y.grid, z - 0.5)
    }
    this.grid = this.lines(pts, COLOR.grid, 0.45, ORDER.grid)
    this.grid.visible = this.gridVisible
    this.group.add(this.grid)
  }

  /** The map edge, drawn separately: it is the one line that means something. */
  private buildBorder(map: GameMap): void {
    this.drop('border')
    const x0 = -0.5, x1 = map.width - 0.5
    const z0 = -0.5, z1 = map.height - 0.5
    const y = Y.border
    this.border = this.lines([
      x0, y, z0, x1, y, z0,
      x1, y, z0, x1, y, z1,
      x1, y, z1, x0, y, z1,
      x0, y, z1, x0, y, z0,
    ], COLOR.border, 0.85, ORDER.border)
    this.group.add(this.border)
  }

  /** Rebuild the blocked-cell mask from the map's collision grid. */
  setCollision(map: GameMap): void {
    this.drop('collision')
    const cells: { x: number; y: number }[] = []
    for (let i = 0; i < map.collision.length; i++) {
      if (map.collision[i] === 1) {
        cells.push({ x: i % map.width, y: Math.floor(i / map.width) })
      }
    }
    this.collision = this.quads(cells, COLOR.collision, 0.38, Y.collision, ORDER.collision)
    this.collision.visible = this.collisionVisible
    this.group.add(this.collision)
  }

  /**
   * Show where the map's entities stand. A sprite is drawn a tile tall and
   * anchored at its feet, so at a glance there is no telling which tile it
   * actually occupies — which is the tile that matters for collision and for
   * talking to it.
   */
  setMarks(cells: readonly { x: number; y: number }[]): void {
    this.drop('marks')
    this.marks = this.quads(cells, COLOR.marks, 0.3, Y.marks, ORDER.marks)
    this.group.add(this.marks)
  }

  /** Highlight the cells the current tool would touch. Empty clears it. */
  setCursor(cells: readonly { x: number; y: number }[]): void {
    this.drop('cursor')
    this.cursor = this.quads(cells, COLOR.cursor, 0.3, Y.cursor, ORDER.cursor)
    this.group.add(this.cursor)
  }

  private lines(
    points: number[], color: number, opacity: number, renderOrder: number,
  ): THREE.LineSegments {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthTest: false, depthWrite: false,
    }))
    mesh.renderOrder = renderOrder
    mesh.frustumCulled = false
    return mesh
  }

  private quads(
    cells: readonly { x: number; y: number }[],
    color: number, opacity: number, y: number, renderOrder: number,
  ): THREE.Mesh {
    const positions: number[] = []
    const indices: number[] = []
    cells.forEach((c, q) => {
      const x0 = c.x - 0.5, x1 = c.x + 0.5
      const z0 = c.y - 0.5, z1 = c.y + 0.5
      positions.push(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0)
      const b = q * 4
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setIndex(indices)
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide,
    }))
    mesh.renderOrder = renderOrder
    mesh.frustumCulled = false
    return mesh
  }

  private drop(which: 'grid' | 'border' | 'collision' | 'marks' | 'cursor'): void {
    const old = this[which] as THREE.Mesh | THREE.LineSegments | undefined
    if (!old) return
    this.group.remove(old)
    old.geometry.dispose()
    ;(old.material as THREE.Material).dispose()
    this[which] = undefined
  }

  dispose(): void {
    this.drop('grid')
    this.drop('border')
    this.drop('collision')
    this.drop('marks')
    this.drop('cursor')
    this.group.removeFromParent()
  }
}
