/**
 * Dev-only readout. Deliberately DOM rather than the in-frame bitmap font
 * (doc §9): it must stay legible regardless of the virtual framebuffer, and it
 * is not shipped UI.
 */
export class DebugOverlay {
  private el = document.createElement('pre')
  visible = true

  constructor() {
    this.el.style.cssText = [
      'position:fixed', 'left:8px', 'top:8px', 'margin:0', 'padding:6px 8px',
      'font:12px/1.4 ui-monospace,Menlo,monospace', 'color:#9f9', 'background:rgba(0,0,0,.6)',
      'pointer-events:none', 'white-space:pre', 'z-index:10',
    ].join(';')
    document.body.appendChild(this.el)
  }

  toggle(): void {
    this.visible = !this.visible
    this.el.style.display = this.visible ? 'block' : 'none'
  }

  set(lines: Record<string, string | number>): void {
    if (!this.visible) return
    this.el.textContent = Object.entries(lines)
      .map(([k, v]) => `${k.padEnd(12)} ${v}`)
      .join('\n')
  }
}
