import * as THREE from 'three'
import type { Mode } from '../core/mode'
import type { Renderer } from '../core/renderer'
import { makeScreenCamera, screenRect } from '../core/screenScene'
import { VIRTUAL_W, VIRTUAL_H } from '../core/config'
import { MISSING_ART } from '../world/missingArt'
import { makePlaceholderTexture } from '../world/placeholder'
import { generatePlaceholderFont, type BitmapFont } from '../ui/bitmapFont'
import { makeTextMesh, textWidth } from '../ui/text'

/**
 * Debug view listing every piece of art the design calls for that the content
 * drop does not contain, drawn as its labelled placeholder at real size.
 * Doubles as the first exercise of the bitmap font and screen-space UI layer.
 */
export class GalleryMode implements Mode {
  readonly name = 'gallery'
  private scene = new THREE.Scene()
  private camera = makeScreenCamera()
  private font: BitmapFont

  constructor(private gfx: Renderer) {
    this.font = generatePlaceholderFont()
    this.build()
  }

  private sprite(tex: THREE.Texture, x: number, y: number, w: number, h: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
    )
    mesh.position.set(x + w / 2, VIRTUAL_H - (y + h / 2), 0)
    mesh.frustumCulled = false
    return mesh
  }

  private build(): void {
    const F = this.font
    this.scene.add(screenRect(0, 0, VIRTUAL_W, VIRTUAL_H, 0x14161c))
    this.scene.add(makeTextMesh(F, 'MISSING ART - PLACEHOLDERS', 16, 14, 0xffd76b))
    this.scene.add(makeTextMesh(
      F, `${MISSING_ART.length} assets stubbed - font is generated, not authored`, 16, 34, 0x8892a6))
    this.scene.add(screenRect(16, 54, VIRTUAL_W - 32, 1, 0x394052))

    // Columns advance by the wider of the swatch and its caption, or captions collide.
    const place = (art: (typeof MISSING_ART)[number], x: number, y: number, caption: string) => {
      this.scene.add(this.sprite(makePlaceholderTexture(art), x, y, art.width, art.height))
      this.scene.add(makeTextMesh(F, caption, x, y + art.height + 5, 0x8892a6))
      return Math.max(art.width, textWidth(F, caption)) + 16
    }

    let x = 16
    for (const art of MISSING_ART.filter((a) => a.width >= 96)) {
      x += place(art, x, 70, art.path.split('/').pop() ?? art.label)
    }

    x = 16
    for (const art of MISSING_ART.filter((a) => a.width < 96)) {
      x += place(art, x, 250, art.label)
    }

    // Generated font atlas at 1:1, with samples beside it.
    const ay = 336
    this.scene.add(makeTextMesh(F, 'GENERATED FONT ATLAS 12x18 ASCII 32-126', 16, ay, 0xffd76b))
    this.scene.add(this.sprite(F.texture, 16, ay + 20, F.columns * F.glyphW, 6 * F.glyphH))
    const sx = 16 + F.columns * F.glyphW + 24
    this.scene.add(makeTextMesh(F, 'The quick brown fox jumps', sx, ay + 22, 0xd6e2ff))
    this.scene.add(makeTextMesh(F, 'over the lazy dog 0123456789', sx, ay + 40, 0xd6e2ff))
    this.scene.add(makeTextMesh(F, 'P 3 - 2 O', sx, ay + 66, 0xffffff, 2))

    this.scene.add(makeTextMesh(F, 'M cycles modes  -  F1 toggles overlay', 16, VIRTUAL_H - 24, 0x5f6b80))
  }

  enter(): void {}
  exit(): void {}
  update(_dt: number): void {}

  render(): void {
    this.gfx.beginFrame(0x14161c)
    this.gfx.gl.render(this.scene, this.camera)
  }
}
