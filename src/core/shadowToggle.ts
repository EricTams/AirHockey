import { SHADOW_LABELS, SHADOW_STYLES, type ShadowStyle } from '../world/shadow'

/**
 * A button for flipping between shadow styles while looking at the world.
 *
 * DOM rather than the in-frame bitmap font, for the same reason as the debug
 * readout (doc §9): this is a thing to evaluate the art with, not shipped UI,
 * and it has no business inside the 960x540 framebuffer. It sits under the
 * Edit button so the two dev affordances stack in the same corner.
 */
export class ShadowToggle {
  private el = document.createElement('button')

  constructor(private onChange: (style: ShadowStyle) => void, style: ShadowStyle) {
    this.el.type = 'button'
    this.el.style.cssText = [
      'position:fixed', 'right:12px', 'top:52px', 'z-index:60',
      'padding:7px 15px', 'border-radius:7px', 'border:1px solid #3a4658',
      'background:#1a2130', 'color:#d6e2f0', 'cursor:pointer',
      'font:600 13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
      'letter-spacing:.02em',
    ].join(';')
    this.el.onclick = () => this.set(next(this.style))
    // Clicking must not leave the button holding focus, or the next Space or
    // arrow key presses it again instead of moving the player.
    this.el.onmouseup = () => this.el.blur()
    this.style = style
    this.paint()
    document.body.appendChild(this.el)
  }

  private style: ShadowStyle

  set(style: ShadowStyle): void {
    this.style = style
    this.paint()
    this.onChange(style)
  }

  cycle(): void { this.set(next(this.style)) }

  setVisible(on: boolean): void { this.el.style.display = on ? 'block' : 'none' }

  private paint(): void {
    this.el.textContent = `Shadows: ${SHADOW_LABELS[this.style]}`
    this.el.style.color = this.style === 'none' ? '#8494a8' : '#d6e2f0'
  }
}

function next(style: ShadowStyle): ShadowStyle {
  const i = (SHADOW_STYLES.indexOf(style) + 1) % SHADOW_STYLES.length
  return SHADOW_STYLES[i] ?? 'none'
}
