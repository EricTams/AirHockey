import * as THREE from 'three'

/**
 * Procedurally drawn stand-ins for art that does not exist yet: a labelled
 * square so a gap is obvious on screen rather than silently invisible.
 *
 * Everything is drawn at exact pixel size with NearestFilter, so a placeholder
 * occupies the same footprint the real asset will and can be swapped 1:1.
 */
export type PlaceholderKind = 'face' | 'character' | 'battler' | 'tile' | 'ui' | 'generic'

const PALETTE: Record<PlaceholderKind, { bg: string; fg: string; accent: string }> = {
  face:      { bg: '#2f2a44', fg: '#e8e2ff', accent: '#6b5ea8' },
  character: { bg: '#123a2e', fg: '#d6ffe9', accent: '#2f7d63' },
  battler:   { bg: '#43202a', fg: '#ffdfe6', accent: '#8c3d4f' },
  tile:      { bg: '#2b3140', fg: '#dbe6ff', accent: '#4d5a75' },
  ui:        { bg: '#3a3320', fg: '#fff3d1', accent: '#7d6c3d' },
  generic:   { bg: '#2a2a2a', fg: '#f0f0f0', accent: '#585858' },
}

export interface PlaceholderOpts {
  width: number
  height: number
  /** Short identifier, e.g. "C2 LEFT". Wrapped and auto-shrunk to fit. */
  label: string
  kind?: PlaceholderKind
  /** Set false to omit the "WxH" footer (useful for very small squares). */
  showSize?: boolean
}

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

/**
 * Wrap `text` to `maxWidth`, hard-breaking any single word too wide to fit.
 * Takes an explicit `measure` so it is testable without a canvas.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const last = lines[lines.length - 1]
    if (last !== undefined && measure(`${last} ${word}`) <= maxWidth) {
      lines[lines.length - 1] = `${last} ${word}`
      continue
    }
    if (measure(word) <= maxWidth) { lines.push(word); continue }
    let chunk = ''
    for (const ch of word) {
      if (chunk && measure(chunk + ch) > maxWidth) { lines.push(chunk); chunk = ch }
      else chunk += ch
    }
    if (chunk) lines.push(chunk)
  }
  return lines
}

export function drawPlaceholder(ctx: CanvasRenderingContext2D, o: PlaceholderOpts): void {
  const { width: w, height: h, label } = o
  const pal = PALETTE[o.kind ?? 'generic']
  const showSize = o.showSize ?? Math.min(w, h) >= 40

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, w, h)

  // Diagonal hatch reads as "not real art" at a glance, even out of context.
  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip()
  ctx.strokeStyle = pal.accent
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1
  for (let x = -h; x < w; x += 8) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + h + 0.5, h); ctx.stroke()
  }
  ctx.restore()

  // Border, inset by half a pixel so it lands on exact pixels.
  ctx.strokeStyle = pal.fg
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)

  const pad = Math.max(2, Math.round(Math.min(w, h) * 0.08))
  const inner = w - pad * 2
  const footer = showSize ? 10 : 0
  const avail = h - pad * 2 - footer

  // Largest font size at which the wrapped label still fits the box.
  let size = Math.min(16, Math.floor(h / 3))
  let lines: string[] = []
  for (; size >= 5; size--) {
    ctx.font = `bold ${size}px ${MONO}`
    lines = wrapText(label, inner, (t) => ctx.measureText(t).width)
    if (lines.length * (size + 2) <= avail) break
  }
  ctx.font = `bold ${size}px ${MONO}`
  ctx.fillStyle = pal.fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lineH = size + 2
  const top = (h - footer) / 2 - (lines.length - 1) * lineH / 2
  lines.forEach((line, i) => ctx.fillText(line, w / 2, Math.round(top + i * lineH)))

  if (showSize) {
    ctx.font = `8px ${MONO}`
    ctx.globalAlpha = 0.75
    ctx.fillText(`${w}x${h}`, w / 2, h - pad - 2)
    ctx.globalAlpha = 1
  }
}

export function makePlaceholderCanvas(o: PlaceholderOpts): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = o.width
  canvas.height = o.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.imageSmoothingEnabled = false
  drawPlaceholder(ctx, o)
  return canvas
}

export function makePlaceholderTexture(o: PlaceholderOpts): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(makePlaceholderCanvas(o))
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.name = `placeholder:${o.label}`
  return tex
}
