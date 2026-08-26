/**
 * Chrome for the editing session, as DOM over the canvas.
 *
 * Shares the `ed-` namespace and the palette of the setup panel in ui.ts, so
 * the two read as one tool. Kept out of the 960x540 frame deliberately: a
 * palette and a row of labelled buttons have no business being drawn in
 * pixel art, and would be unreadable at that resolution besides.
 */
/**
 * Width of the dock, in CSS pixels. Shared with the camera: the dock covers the
 * left of the canvas, so framing a map has to fit it into what is left rather
 * than into the whole viewport.
 */
export const DOCK_PX = 300

export const EDITOR_CSS = `
.ed-dock { pointer-events: auto; position: absolute; top: 0; left: 0; bottom: 0;
  width: ${DOCK_PX}px; display: flex; flex-direction: column;
  background: #131924; border-right: 1px solid #26303f; color: #cdd8e6; }
.ed-dock h4 { margin: 0; padding: 11px 14px 9px; font-size: 12px; color: #fff;
  font-weight: 600; letter-spacing: .03em; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid #212a38; }
.ed-dot { width: 7px; height: 7px; border-radius: 50%; background: #3d4a5c; flex: none; }
.ed-dot[data-dirty="1"] { background: #e0b64a; }
.ed-sec { padding: 10px 12px; border-bottom: 1px solid #1c2431; }
.ed-sec > label { display: block; font-size: 10px; text-transform: uppercase;
  letter-spacing: .09em; color: #6d7d92; margin-bottom: 6px; }
.ed-seg { display: flex; flex-wrap: wrap; gap: 4px; }
.ed-seg button { flex: 1 1 auto; min-width: 0; padding: 5px 8px; border-radius: 5px;
  border: 1px solid #2a3444; background: #1a2230; color: #97a7bb;
  font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
.ed-seg button:hover { background: #212b3b; color: #d3dfec; }
.ed-seg button[aria-pressed="true"] { background: #294064; border-color: #3e6394; color: #e9f2fd; }
.ed-key { opacity: .5; margin-left: 4px; font-size: 10px; }
.ed-pal-wrap { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px;
  background: #0e131c; }
.ed-palette { display: block; image-rendering: pixelated; cursor: crosshair;
  border: 1px solid #222c3a; }
.ed-foot2 { padding: 10px 12px; display: flex; gap: 6px; align-items: center;
  border-top: 1px solid #212a38; }
.ed-save { flex: 1; padding: 7px 10px; border-radius: 6px; border: 1px solid #35608f;
  background: #2a4d7a; color: #fff; font: inherit; font-weight: 600; font-size: 12px;
  cursor: pointer; }
.ed-save:hover { background: #345c8e; }
.ed-save:disabled { background: #1e2836; border-color: #2a3444; color: #5d6d81;
  cursor: default; }
.ed-foot3 { padding: 0 12px 12px; }
.ed-second { width: 100%; padding: 6px 10px; border-radius: 6px;
  border: 1px solid #2a3444; background: #1a2230; color: #97a7bb;
  font: inherit; font-size: 11px; cursor: pointer; }
.ed-second:hover:not(:disabled) { background: #212b3b; color: #d3dfec; }
.ed-second:disabled { opacity: .5; cursor: default; }
.ed-icon { padding: 6px 9px; border-radius: 6px; border: 1px solid #2a3444;
  background: #1a2230; color: #97a7bb; font: inherit; font-size: 12px; cursor: pointer; }
.ed-icon:hover:not(:disabled) { background: #212b3b; color: #d3dfec; }
.ed-icon:disabled { opacity: .38; cursor: default; }
.ed-bar { pointer-events: none; position: absolute; left: ${DOCK_PX}px; right: 0; bottom: 0;
  padding: 5px 12px; background: rgba(10, 14, 20, .82); color: #8ea0b6;
  font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: flex; gap: 16px; border-top: 1px solid #212a38; }
.ed-bar b { color: #cfdcea; font-weight: 600; }
.ed-bar .ed-msg { margin-left: auto; }
.ed-bar .ed-msg[data-tone="err"] { color: #e79a9a; }
.ed-bar .ed-msg[data-tone="ok"] { color: #8fdca8; }
.ed-check { display: flex; align-items: center; gap: 6px; font-size: 11px;
  color: #97a7bb; cursor: pointer; margin-top: 6px; }
.ed-check input { accent-color: #3e6394; }
`
