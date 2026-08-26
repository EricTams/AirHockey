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
.ed-tabrow { display: flex; border-bottom: 1px solid #212a38; }
.ed-tabrow button { flex: 1; padding: 8px 6px; border: none; border-bottom: 2px solid transparent;
  background: transparent; color: #7f8fa5; font: inherit; font-size: 11px;
  font-weight: 600; letter-spacing: .04em; cursor: pointer; }
.ed-tabrow button:hover { color: #c4d2e2; }
.ed-tabrow button[aria-pressed="true"] { color: #e9f2fd; border-bottom-color: #4a7bb5; }
.ed-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
.ed-pane[hidden] { display: none; }
.ed-sec { flex: none; padding: 10px 12px; border-bottom: 1px solid #1c2431; }
.ed-row2 { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
.ed-row2[hidden] { display: none; }
.ed-row2 + .ed-row2 { margin-top: 6px; }
.ed-select, .ed-input2 { flex: 1; min-width: 0; background: #0c1119; border: 1px solid #2b3545;
  border-radius: 5px; padding: 5px 8px; color: #dbe6f5; font: inherit; font-size: 11px; }
.ed-select:focus, .ed-input2:focus { outline: none; border-color: #4a7bb5; }
.ed-input2:disabled { opacity: .45; }
/* Never shrink: squeezing the list to fit clips a row mid-height, which reads
   as a rendering fault. The pane scrolls instead. */
.ed-lines { flex: none; max-height: 190px; overflow: auto;
  background: #0e131c; border-bottom: 1px solid #1c2431; }
.ed-line { display: grid; grid-template-columns: 30px 76px 1fr; gap: 6px; align-items: baseline;
  padding: 5px 10px; cursor: pointer; border-bottom: 1px solid #151d29; font-size: 11px; }
.ed-line:hover { background: #161e2b; }
.ed-line[aria-selected="true"] { background: #22314a; }
.ed-lineno { color: #5d6d81; text-align: right; font-variant-numeric: tabular-nums; }
.ed-linekind { color: #6d8098; font-size: 10px; text-transform: uppercase;
  letter-spacing: .06em; }
.ed-hint { color: #6d7d92; font-size: 11px; line-height: 1.5; }
.ed-hint[hidden] { display: none; }
.ed-color { flex: 1; height: 26px; padding: 0; background: #0c1119;
  border: 1px solid #2b3545; border-radius: 5px; cursor: pointer; }
.ed-fields > div { margin-bottom: 2px; }
.ed-linewho { color: #ffd76b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-linetext { color: #9fb0c5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-line[aria-selected="true"] .ed-linetext { color: #dce7f5; }
.ed-fields label { display: block; font-size: 10px; text-transform: uppercase;
  letter-spacing: .09em; color: #6d7d92; margin: 8px 0 4px; }
.ed-fields label:first-child { margin-top: 0; }
.ed-fields .ed-input2 { width: 100%; display: block; }
.ed-textarea { width: 100%; background: #0c1119; border: 1px solid #2b3545; border-radius: 5px;
  padding: 6px 8px; color: #dbe6f5; font: inherit; font-size: 11px; line-height: 1.5;
  resize: vertical; }
.ed-textarea:focus { outline: none; border-color: #4a7bb5; }
.ed-file { flex: 1; min-width: 0; color: #97a7bb; font: inherit; font-size: 11px; }
.ed-file::file-selector-button { margin-right: 8px; padding: 5px 10px; border-radius: 5px;
  border: 1px solid #2a3444; background: #1a2230; color: #d3dfec; font: inherit;
  font-size: 11px; cursor: pointer; }
.ed-file::file-selector-button:hover { background: #212b3b; }
.ed-sheet { display: block; image-rendering: pixelated; cursor: crosshair;
  border: 1px solid #222c3a; touch-action: none; }
.ed-propline { grid-template-columns: 1fr 34px 16px 24px; align-items: center; }
.ed-propline .ed-input2 { padding: 3px 6px; }
.ed-warn { margin-top: 8px; padding: 6px 8px; border-radius: 5px; font-size: 11px;
  background: #38240f; border: 1px solid #6b4718; color: #f0c489; }
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
/* Sticky, because a long warning or a tall field list can push the pane past
   the dock's height and Save must not scroll away. */
.ed-foot2[hidden] { display: none; }
.ed-foot2 { flex: none; position: sticky; bottom: 0; padding: 10px 12px; display: flex;
  gap: 6px; align-items: center; border-top: 1px solid #212a38; background: #131924; }
.ed-save { flex: 1; padding: 7px 10px; border-radius: 6px; border: 1px solid #35608f;
  background: #2a4d7a; color: #fff; font: inherit; font-weight: 600; font-size: 12px;
  cursor: pointer; }
.ed-save:hover { background: #345c8e; }
.ed-save:disabled { background: #1e2836; border-color: #2a3444; color: #5d6d81;
  cursor: default; }
.ed-foot3 { flex: none; padding: 10px 12px; border-top: 1px solid #212a38; }
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
