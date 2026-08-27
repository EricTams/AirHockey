import type { LoopFailure } from './loop'

/**
 * On-screen notice that an exception escaped a mode and was contained.
 *
 * DOM rather than the virtual framebuffer, for the same reason the debug
 * readout is (see debugOverlay.ts) and for one more: the thing most likely to
 * be broken is rendering, and a message drawn by the renderer that just threw
 * is not a message. It also stays up in edit mode, where the debug readout is
 * deliberately hidden — the editor is exactly where a designer needs to be told
 * that something is wrong rather than left looking at a world that stopped.
 *
 * It reports; it does not interpret. The message is whatever was thrown, and
 * the count says whether this happened once or is happening every frame, which
 * is the difference between a glitch and a broken build.
 */
export class FailureBanner {
  private el = document.createElement('div')
  private shown = ''

  constructor(parent: HTMLElement = document.body) {
    this.el.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'margin:0', 'padding:8px 12px',
      'font:12px/1.5 ui-monospace,Menlo,monospace', 'color:#ffdede',
      'background:rgba(120,20,28,.92)', 'border-top:2px solid #ff6b6b',
      // Never swallow a click meant for the game or the editor's chrome.
      'pointer-events:none', 'white-space:pre-wrap', 'z-index:20', 'display:none',
    ].join(';')
    parent.appendChild(this.el)
  }

  /** Show a contained failure. Repeats of the same one only update the count. */
  show(failure: LoopFailure): void {
    const err = failure.error as Error | undefined
    const text = `${failure.phase} threw: ${err?.message ?? String(failure.error)}` +
      (failure.count > 1 ? `  (×${failure.count})` : '') +
      '\nThe game kept running. See the console for the stack.'
    if (text === this.shown) return
    this.shown = text
    this.el.textContent = text
    this.el.style.display = 'block'
  }

  /** Hide the banner, e.g. once the content that failed has been reloaded. */
  clear(): void {
    this.shown = ''
    this.el.textContent = ''
    this.el.style.display = 'none'
  }

  get visible(): boolean { return this.el.style.display !== 'none' }
}
