import * as THREE from 'three'
import type { Mode } from '../core/mode'
import type { Renderer } from '../core/renderer'
import { makeScreenCamera, screenRect } from '../core/screenScene'
import { VIRTUAL_W, VIRTUAL_H } from '../core/config'

/**
 * M0 placeholder mode. Draws a test pattern that makes non-integer upscaling
 * visually obvious: a 1px checkerboard border, corner markers, and a 48px grid.
 * Replaced by the real modes in M1–M4.
 */
export class StubMode implements Mode {
  private scene = new THREE.Scene()
  private camera = makeScreenCamera()

  constructor(readonly name: string, private gfx: Renderer, tint: number) {
    const edge = 0xffffff
    // 1px checkerboard along the top and left edges — any blur or fractional
    // scale turns this into grey mush.
    for (let x = 0; x < VIRTUAL_W; x += 2) this.scene.add(screenRect(x, 0, 1, 1, edge))
    for (let y = 0; y < VIRTUAL_H; y += 2) this.scene.add(screenRect(0, y, 1, 1, edge))

    // 48px tile grid, so the virtual frame's tile capacity is readable at a glance.
    for (let x = 0; x <= VIRTUAL_W; x += 48) this.scene.add(screenRect(x, 0, 1, VIRTUAL_H, 0x203040))
    for (let y = 0; y <= VIRTUAL_H; y += 48) this.scene.add(screenRect(0, y, VIRTUAL_W, 1, 0x203040))

    // Corner brackets prove nothing is cropped by the letterbox.
    for (const [cx, cy] of [[0, 0], [VIRTUAL_W - 16, 0], [0, VIRTUAL_H - 16], [VIRTUAL_W - 16, VIRTUAL_H - 16]]) {
      this.scene.add(screenRect(cx!, cy!, 16, 2, edge))
      this.scene.add(screenRect(cx!, cy!, 2, 16, edge))
    }

    // A mode-coloured block, centred.
    this.scene.add(screenRect(VIRTUAL_W / 2 - 96, VIRTUAL_H / 2 - 48, 192, 96, tint))
  }

  enter(): void {}
  exit(): void {}
  update(_dt: number): void {}

  render(): void {
    this.gfx.beginFrame(0x101014)
    this.gfx.gl.render(this.scene, this.camera)
  }
}
