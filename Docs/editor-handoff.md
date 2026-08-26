# Level Editor — Working Handoff

**Temporary.** A working note to carry the editor across sessions. Delete it
once the editor is finished; it is not part of the design record. The permanent
spec is `mechanical-design-v1.md`.

Last updated after commit `52a97be` ("Make the overworld data-driven, and stand
up the level editor's front door").

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
| `src/editor/server.ts` | Client for the helper, with site fallback |
| `src/editor/ui.ts` | Edit button, setup panel, edit-mode toggle |

**The helper works.** One dependency-free file the designer downloads from the
published site. Creates `airhockey-content/`, writes only there, no clone and no
npm. Reachable from the published HTTPS origin — verified in Chrome 151.

**The front door works.** Edit button top-right. No helper running → setup panel
with per-platform instructions and the download; it polls and enters edit mode
by itself once the helper appears. First run offers a desktop shortcut.

**Edit mode stops the game.** `Loop.setPaused()` halts logic ticks while still
presenting frames.

### Not started

Everything that actually edits: palette, painting, import, entity placement,
dialogue editing, events. That is section 5.

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
- Validation is strict and loud. The editor writes these files; a bad save must
  fail at load, not half-draw a world.

---

## 5. What to build next

### 5.1 Editor shell and tile painting

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

### 5.2 Tileset import

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

### 5.3 Entity placement

`map.npcs` exists and renders. `map.props` exists in the format and is validated
but **is not rendered yet** — that is part of this stage. A prop is a billboard
quad `w × h` tiles, UVs from `propUv`, placed with `Projection.placeBillboard`,
`renderOrder` from `proj.sortKey(y)`, offset by the prop's `anchor`.

Then drag-to-place, and an inspector for NPC fields (sprite, facing, dialogue
file, battle file, tint).

### 5.4 Dialogue editor

`public/data/dialogue/*.json` is a linear list of `{name, face, text}`. A line
list with reordering, plus live preview through the real `DialogueMode`
renderer. The cheapest stage; consider doing it before 5.3 to get the designer
something to react to sooner.

### 5.5 Events and triggers

Nothing exists. Eric chose the **full** model: event pages with per-page
conditions, flags and variables, conditional branches, loops, waits.

Three pieces: a data format; an interpreter that runs across ticks (the game is
a 60Hz fixed-timestep loop, so an event that waits has to suspend and resume,
not block); and a command-list editor. This is the largest remaining stage —
comparable to everything above it combined. Design the format first and get it
in front of Eric before building the interpreter.

Use our own vocabulary, not RPG Maker's.

---

## 6. Open questions for Eric

1. **How does the designer's work get back?** Their edits live in their own
   `airhockey-content/` folder with no route to the repo. Options: a "download
   my changes" zip, the helper opening a PR, or manual copying. **This will bite
   as soon as the designer has real work**, and it is the most urgent of these.
2. **Should the Edit button be public?** It is currently visible to every
   visitor of the published site. Harmless without a helper, but prominent.
3. **Multiple maps.** The format assumes one entry map. Doc §10 says map
   transitions via a `warps` array are the first post-v1 addition.
4. **Does the importer need to handle non-48px grids** or sheets from other
   tools?

---

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
- **The running game loads content from the site, not the helper.** After a save
  the world will not change until the editor rebuilds the scene (see 5.1) or the
  page is reloaded. Expect to be confused by this once.
- `npm run editor` and a downloaded helper behave identically, but the content
  folder follows the working directory.
