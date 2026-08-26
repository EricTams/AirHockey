# Level Editor — Working Handoff

**Temporary.** A working note to carry the editor across sessions. Delete it
once the editor is finished; it is not part of the design record. The permanent
spec is `mechanical-design-v1.md`.

**All seven stages are built.** What is left is the thing this document has
always said comes next: hand it to a designer and get feedback.

Before deleting this file, move the durable parts into the permanent record —
section 3 (decisions) and section 4 (invariants) are the ones worth keeping, and
`Docs/events.md` already holds the event format. Section 7's traps are the other
thing worth keeping: each of them cost real time and none is obvious.

---

## 1. The goal

An editor with comparable functionality to RPG Maker: paint tiles and props
from a palette, place and configure NPCs, write dialogue, and author triggers.
Eric is **not** the user — a designer is. Names need not follow RPG Maker's; use
our own vocabulary (events, triggers, actions, flags). The reference is about
the capability bar only.

The working method is: build our best guess, hand it to the designer, get
feedback. Do not stall waiting for requirements that are not going to arrive.

---

## 2. Where things stand

### Done

**The overworld is data-driven.** It used to be `MAP_COLS`/`MAP_ROWS`, a
checkerboard, and a `const NPCS` array with no collision grid at all. It now
loads `public/data/maps/overworld.json`.

| File | What it is |
|---|---|
| `src/world/map.ts` | `GameMap` types, strict validation, `tileAt` / `blockedAt` |
| `src/world/tileset.ts` | Grid maths, the rider file, `isPaintable`, `propUv` |
| `src/world/tileLayer.ts` | Builds one merged mesh per layer (was `groundMesh.ts`) |
| `public/data/maps/overworld.json` | The world, one grid row per line |
| `public/data/tilesets/terrain.json` | The terrain rider file |
| `tools/editor-server.mjs` | The downloadable helper |
| `src/editor/server.ts` | Client for the helper, site fallback, content index |
| `src/editor/ui.ts` | Edit button, setup panel, edit-mode toggle |
| `src/core/paths.ts` | `contentUrl` — the read-through the editor redirects |
| `src/editor/editor.ts` | The editing session: pointers, chrome, wiring |
| `src/editor/mapDoc.ts` | The map being edited, and the undo stack |
| `src/editor/tools.ts` | Brush/rect/fill geometry over the grid |
| `src/editor/mapFile.ts` | Diffable map serialisation |
| `src/editor/overlay.ts` | Grid, border, collision mask, tool cursor |
| `src/editor/palette.ts` | The sheet drawn into a canvas, click to select |
| `src/editor/zip.ts`, `handoff.ts` | "Download my changes" |
| `src/editor/dialogueEditor.ts` | Line list, fields, live preview |
| `src/editor/dialogueDoc.ts` | The script being edited, snapshot undo |
| `src/editor/dialogueFile.ts` | Diffable dialogue serialisation |
| `src/editor/entityEditor.ts` | NPC and prop placement and inspector |
| `src/world/prop.ts` | Prop billboards, and where their anchor lands |
| `src/editor/tilesetEditor.ts` | Sheet import and the review screen |
| `src/editor/sheetAnalysis.ts` | Coverage measurement and prop clustering |
| `src/editor/tilesetFile.ts` | Diffable rider serialisation |
| `src/editor/mapPicker.ts` | Map list, new map, resize |
| `src/world/event.ts` | Event types and validation |
| `src/world/eventRunner.ts` | The interpreter |
| `src/world/gameState.ts` | Flags and variables |
| `src/editor/eventEditor.ts` | Pages, conditions, command list, state panel |
| `src/editor/commandList.ts` | The command tree, addressed by path |

**The helper works.** One dependency-free file the designer downloads from the
published site. Creates `airhockey-content/`, writes only there, no clone and no
npm. Reachable from the published HTTPS origin — verified in Chrome 151.

**The front door works.** Edit button top-right. No helper running → setup panel
with per-platform instructions and the download; it polls and enters edit mode
by itself once the helper appears. First run offers a desktop shortcut.

**Edit mode stops the game.** `Loop.setPaused()` halts logic ticks while still
presenting frames.

**Content routing works.** The game reads through the helper while editing
(`contentUrl`), so a save changes the world and an imported sheet is visible at
all. Leaving the editor keeps the routing: the designer drops into the world
they just built rather than back into the shipped one.

**Tile painting works.** Brush, rect, fill and eyedropper across the three tile
layers and the collision grid; stroke-grouped undo/redo; a palette drawn from
the sheet; zoom and pan; save through the helper. Verified end to end in Chrome:
paint collision, save, exit, walk into it, get blocked.

**The work gets back.** "Download my changes" zips the content folder under the
same paths the game loads by, so it unzips straight over `public/`.

**Dialogue editing works.** Line list with reorder, add, duplicate and delete;
speaker, portrait and text fields; live preview through the real
`DialogueMode`, including a warning when a line wraps past the bottom of the
box. `parseDialogue` now validates these files on load as strictly as maps.

**Entity placement works.** NPCs and props: place, drag to move, delete, and an
inspector for every field, all undoing through the same MapDoc as the tiles.
Props render now — `map.props` validated but drew nothing before.

**Tileset import works.** A PNG goes in, gets written to the content folder,
decoded in the browser, and classified; the review screen alongside it lets the
designer cycle cell kinds, drag prop boxes, set anchors, and save — which is the
only thing that sets `reviewed: true`. "Use this sheet for the map" repoints the
open map, undoably, with a warning about what that does to its tile indices.

On the shipped sheet the importer proposes exactly the failure decision 5
predicted: one 9x9 prop swallowing everything. That is the review screen earning
its place, not a bug to tune out.

**Events work.** Pages with conditions, four triggers, flags and variables, an
interpreter that suspends and resumes across ticks, and a command-list editor
with the tree flattened into an indented list. Battles report who won, so
`won:`/`lost:` branches have something to branch on. An NPC can be turned into
the event that does the same thing in one click. Format: `Docs/events.md`.

**Multiple maps work.** A map picker with create and resize, and warps as a
placeable entity kind. `warps` is in the format and validated; the overworld
follows one on arrival, holding the sim still while the destination loads.
Verified end to end: place a warp, save, exit, walk into it, arrive.

The dock has tabs (Map, Entities, Dialogue, Sheet) — that is where events go.

### Not started

Nothing in section 5. What remains is not a stage:

- **Designer feedback.** The working method was always "build our best guess,
  hand it to a designer, get feedback". That has not happened yet, and it is now
  the only thing that will meaningfully improve this.
- **Saving.** Flags and variables live for a session (doc §1 puts save/load out
  of v1 scope). The event system is the thing that makes saving worth having,
  and `GameState` is the shape it would attach to.
- **Chunked layer meshes.** Rebuilding a whole layer per stroke is O(cells) and
  fine at 20x12. It will not be fine at 200x200.

---

## 3. Decisions already made — do not relitigate

Each of these was argued through with Eric. Re-opening them wastes a session.

1. **The designer never clones the repo.** They download one file. There is no
   npm, no checkout, no git in their flow.

2. **The helper has no authentication.** A token was weighed and rejected as
   more friction than the contents are worth. **The compensating bound is that
   the content folder is fixed** at `./airhockey-content` with no flag to move
   it, so it can never be aimed at a checkout or a home directory. Writes are
   confined to that folder and to `.json`/`.png`, checked after `realpath`.

   **If you add a folder-choosing flag, you have re-opened the auth question.**
   Do not widen this quietly.

3. **Nothing the browser can reach may write outside the content folder.** This
   is why the desktop-shortcut offer is a stdin prompt in the helper's terminal
   and not an HTTP route — a route that writes an executable to the Desktop
   would hand any open web page a way to do the same.

4. **Edit mode stops the game.** Not an overlay on a running game.

5. **The rider file proposes; the designer decides.** Measured per-cell alpha
   coverage on the terrain sheet climbs 0.13% → 11.8% with no gap, so no
   threshold separates art from outline bleed, and clustering merges the terrace
   and plateau into one blob. Hence `reviewed`. An importer must never present
   its guesses as settled.

6. **Tilesets are addressed through a rider file that states the sheet size**,
   never by measuring the loaded image. `Assets` substitutes a 48×48 placeholder
   for a texture that fails to load, which would silently re-index a 10-column
   sheet as 1-column and move every tile in every map.

7. **Don't over-index on the current art.** It is placeholder. Keep formats
   general; the terrain rider is deliberately minimal and unreviewed.

8. **Edits come back as a zip.** The editor offers "download my changes"; Eric
   unzips it over `public/` and commits. A helper that opens a PR was weighed
   and rejected: it would put a GitHub token and network egress into a tool
   whose safety case rests on having neither. See decision 2.

9. **Multi-map is in scope**, including a map list, creation, resize, and a
   `warps` array (doc §10 names warps as the first post-v1 addition). An editor
   with one map is not the thing we agreed to build.

10. **Events land last, and the format is reviewed before the interpreter.**
   Stage order puts everything the designer can actually use ahead of the
   largest stage. Design the format, show it to Eric, then build.

---

## 4. Invariants

- Tile grid is 48px anchored top-left; the right/bottom remainder is unused
  margin. Settled in `.artlog/decisions.json` ("grid-origin"). Every tile index
  in every map depends on it.
- Tile index is row-major: `row * cols + col`. `-1` is empty.
- Collision lives in the map and is authoritative. `solid` in a rider file is
  only a default the editor seeds from (doc §6.1).
- A tile is a flat XZ quad merged into a layer mesh. A prop is a billboard that
  stands upright when the camera tilts and y-sorts against sprites. Two render
  paths that already exist — see `Projection`.
- Content is addressed by project-relative path (`data/maps/overworld.json`),
  the same string the game fetches by and the helper writes by.
- Map files stay diffable: one grid row per line.
- Every grid is row-major, so a width change re-indexes every cell after the
  first row. `resizeMap` does; anything that truncates instead produces a
  scrambled map that still validates.
- Validation is strict and loud. The editor writes these files; a bad save must
  fail at load, not half-draw a world.

---

## 5. What to build next

**Order** (settled 2026-08-26): ~~5.0~~ → ~~5.1~~ → ~~5.4 dialogue~~ → ~~5.3 entities~~
→ ~~5.2 import~~ → ~~5.6 multiple maps~~ → ~~5.5 events~~. Dialogue is cheap and gets the
designer something to react to a stage sooner. Events last, per decision 10.

### 5.0 Content routing — DONE

`fetchJson` (`src/core/paths.ts`) and `Assets.texture` both resolve against
`document.baseURI` unconditionally, so **the game only ever reads the site**.
`EditorServer.readJson` has the read-through-with-fallback logic, but nothing in
the game calls it. Two consequences, and the second is the sharp one:

- A saved map does not change the world until the page reloads.
- An **imported tileset PNG exists only in the content folder**, where
  `Assets.texture` cannot see it. It falls back to a 48×48 placeholder — which
  by decision 6 is exactly the silent re-indexing the rider file exists to
  prevent.

So both loaders need a content source that edit mode swings over to the helper
(read local, fall back to the site) and back on exit. Small, but 5.1 through 5.6
all sit on it. Do it first.

### 5.1 Editor shell and tile painting — DONE

**Code changes needed first.** `OverworldMode` keeps everything private and
loads its map exactly once in `init()`. The editor needs:

- an accessor for the current map, tileset and scene;
- `applyMap(map, tileset)` that rebuilds the layer meshes and NPC sprites, so an
  edit shows immediately;
- direct control of `Projection` — `lookAt()` is currently driven from the
  player each update, and while paused nothing calls it at all.

**Picking is mostly solved.** `Renderer.clientToNdc()` already undoes the
integer upscale and the letterbox. Raycast that against a `y = 0` plane to get
world coordinates.

> Tile centres sit at integers — `buildTileLayer` spans `tx - 0.5` to
> `tx + 0.5` — so the tile under a point is `Math.round(worldX)`, **not**
> `Math.floor`.

**Zoom needs a real change.** `Projection.HALF_H` is a static derived from
`VIRTUAL_H / TILE`, so the framed area is fixed. Editing a large map without
zoom will be painful.

**The rest:** palette drawn from the sheet into a DOM canvas (cell rects via
`indexOf`, honour `isPaintable`); layer selector; brush / rect / fill /
eyedropper / erase; a collision-grid overlay with its own tool; undo as a stroke
-grouped stack of `{layer, index, from, to}`; save with
`server.writeJson('data/maps/overworld.json', map)`.

Rebuilding a whole layer mesh per stroke is fine at 20×12. It is O(cells) and
will want chunking before maps get large.

### 5.2 Tileset import — DONE

Eric asked for this explicitly. The helper already permits `.png` writes.

1. `<input type="file">` → `ArrayBuffer` → `server.write('assets/…/x.png', buf,
   'image/png')`.
2. Decode in the **browser** (`createImageBitmap` + canvas) — the helper has no
   image decoder and should not grow one.
3. Propose a classification: fully-opaque cells → `T`; 8-connected clusters of
   partially-opaque cells → prop bounding boxes.
4. Write `data/tilesets/<id>.json` with `reviewed: false`.
5. **Build the review screen in the same stage.** Per decision 5, a proposal the
   designer cannot correct is worse than no proposal. Toggle cell kinds, drag
   prop rectangles, set anchors; saving marks `reviewed: true`.

### 5.3 Entity placement — DONE

`map.npcs` exists and renders. `map.props` exists in the format and is validated
but **is not rendered yet** — that is part of this stage. A prop is a billboard
quad `w × h` tiles, UVs from `propUv`, placed with `Projection.placeBillboard`,
`renderOrder` from `proj.sortKey(y)`, offset by the prop's `anchor`.

Then drag-to-place, and an inspector for NPC fields (sprite, facing, dialogue
file, battle file, tint).

### 5.4 Dialogue editor — DONE

`public/data/dialogue/*.json` is a linear list of `{name, face, text}`. A line
list with reordering, plus live preview through the real `DialogueMode`
renderer. The cheapest stage; consider doing it before 5.3 to get the designer
something to react to sooner.

### 5.5 Events and triggers — DONE

Nothing exists. Eric chose the **full** model: event pages with per-page
conditions, flags and variables, conditional branches, loops, waits.

Three pieces: a data format; an interpreter that runs across ticks (the game is
a 60Hz fixed-timestep loop, so an event that waits has to suspend and resume,
not block); and a command-list editor.

**Most of this stage is runtime, not editor.** Flags and variables mean a game
state store, and doc §1 puts save/load out of v1 scope, so none of it exists.
And `OverworldMode.tryInteract` hardcodes talk → dialogue → battle; doc §158
calls that rule "a stand-in for the future event system", so this stage
replaces it. Budget accordingly. This is the largest remaining stage —
comparable to everything above it combined. Design the format first and get it
in front of Eric before building the interpreter.

Use our own vocabulary, not RPG Maker's.

---

### 5.6 Multiple maps — DONE

Per decision 9. `ENTRY_MAP` is a module constant and `OverworldMode.init()`
loads exactly once, so this is runtime work as much as editor work: a map
registry, load-on-warp, and a `warps` array in the format (doc §10) with the
same strict validation as everything else. Editor side: a map list, create,
and resize — resize has to re-index every layer and the collision grid, which is
the one operation here that can quietly corrupt a file, so it wants a test.

## 6. Open questions for Eric

Answered 2026-08-26 — see decisions 8, 9 and 10, all three now implemented or
scheduled. What remains:

1. **Should the Edit button be public?** It is currently visible to every
   visitor of the published site. Harmless without a helper, but prominent.
   *Working assumption: yes, leave it public.*
2. **Does the importer need to handle non-48px grids** or sheets from other
   tools? *Working assumption: 48px only for now.*

## 7. Running and verifying

```sh
npm run dev        # game on 5173
npm run editor     # helper on 5178, writes ./airhockey-content (gitignored)
npm test           # 127 tests
npm run build      # typecheck + build; also emits airhockey-editor.mjs
```

Published at https://erictams.github.io/AirHockey/ — pushing to `main` deploys.

### Traps that cost time already

- **An automated browser tab is backgrounded, so `requestAnimationFrame` is
  throttled and the game does not advance.** Observing "nothing moved" there is
  a false pass — it proves nothing about whether a pause worked. Use
  `__game.tick(n)` to step the sim by hand, or write a unit test with a
  hand-cranked rAF (see `tests/loop.test.ts`).
- **The Chrome extension's synthetic key events do not set `e.code`,** which is
  what `Input` binds on. Dispatch
  `new KeyboardEvent('keydown', { code: 'KeyW' })` instead.
- **The helper is on 5178, not 5174** — 5174 is Vite's fallback when 5173 is
  taken, and they fight over it.
- **Sprites are positioned in `update()`, which does not run while paused.**
  Anything that builds a sprite outside a tick has to place it too, or it sits
  at the world origin — which for four sprites looks like one smudge in the
  map's top-left corner, not like a bug. `placeEntities` exists for this.
- Content routing (5.0) fixed the old "the game reads the site, not the helper"
  trap. A save now shows immediately.
- **A texture served from the helper is cross-origin, and WebGL will not upload
  an image that is not CORS-clean.** The refusal is silent — the texture samples
  as transparent black and the world goes blank, with nothing in the console.
  `Assets` sets `img.crossOrigin` for this. It only bites once a texture
  actually comes from the content folder, i.e. after an import.
- `npm run editor` and a downloaded helper behave identically, but the content
  folder follows the working directory.
