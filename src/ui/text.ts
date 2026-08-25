import * as THREE from 'three'
import { VIRTUAL_H } from '../core/config'
import type { BitmapFont } from './bitmapFont'

/**
 * Builds one batched mesh for a run of text (doc §9: one quad per glyph, drawn
 * as a single geometry rather than a mesh per character).
 *
 * `x`/`y` are the top-left corner in virtual pixels with y running downward,
 * matching `screenRect`.
 */
export function makeTextMesh(
  font: BitmapFont,
  text: string,
  x: number,
  y: number,
  color = 0xffffff,
  scale = 1,
): THREE.Mesh {
  const gw = font.glyphW * scale
  const gh = font.glyphH * scale
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  let col = 0
  let line = 0
  let glyphs = 0
  for (const ch of text) {
    if (ch === '\n') { line++; col = 0; continue }
    if (ch !== ' ') {
      const { u0, v0, u1, v1 } = font.uv(ch.charCodeAt(0))
      const x0 = x + col * gw
      const yTop = y + line * gh
      // Convert the y-down layout box into the y-up world of the screen camera.
      const wy1 = VIRTUAL_H - yTop
      const wy0 = wy1 - gh

      positions.push(x0, wy0, 0, x0 + gw, wy0, 0, x0 + gw, wy1, 0, x0, wy1, 0)
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1)
      const b = glyphs * 4
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
      glyphs++
    }
    col++
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: font.texture, color, transparent: true,
      depthTest: false, depthWrite: false,
    }),
  )
  mesh.frustumCulled = false
  return mesh
}

/** Width in virtual pixels of the longest line of `text`. */
export function textWidth(font: BitmapFont, text: string, scale = 1): number {
  const longest = text.split('\n').reduce((m, l) => Math.max(m, l.length), 0)
  return longest * font.glyphW * scale
}
