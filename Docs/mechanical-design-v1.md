# Mechanical Design Document — Version 1
*Scope: walk around the world, talk to NPCs, fight air hockey battles. Nothing else.*

---

## 1. Scope

Version 1 delivers three connected systems:

1. **Overworld** — tile-based maps the player walks around, with collision.
2. **Dialogue** — talk to NPCs via an interaction key; linear text with portraits.
3. **Battle** — an NPC interaction can start an air hockey match on a 3D table; the match ends and control returns to the overworld.

Explicitly out of scope for v1: event scripting/command lists, switches and variables, NPC event pages, branching dialogue, battle phases, special pucks, obstacle effects, moving obstacles, save/load, audio beyond basic SFX hooks, and both editors. All data is hand-authored JSON. The data formats below are designed so the editors can be added later without migration.

## 2. Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript |
| Rendering | Three.js (single renderer for both modes) |
| Physics (battle only) | Rapier 2D (or Matter.js; one, not both) |
| Data | Static JSON files fetched at load |
| Hosting | Static files (GitHub Pages compatible); no server required in v1 |
| Build | Vite |

There is no launcher, no localhost server, and no file writing in v1. The game is a static page.

## 3. Game Loop and Modes

A single top-level state machine with three modes:

```
OVERWORLD  <-->  DIALOGUE
    |
    v
  BATTLE  --(result)-->  OVERWORLD
```

- One `requestAnimationFrame` loop drives everything. Each mode has `update(dt)` and `render()`; only the active mode runs.
- Fixed timestep for logic (60 Hz accumulator), variable render. Battle physics steps at the fixed rate.
- Mode transitions are hard cuts in v1 (optionally a 200 ms fade). No transition animations.

## 4. Rendering Pipeline

One Three.js `WebGLRenderer` shared by both modes. Two scenes, two cameras.

### 4.1 Low-res target (both modes)

- All rendering goes to a `WebGLRenderTarget` at **640×360**.
- The target texture is drawn to the canvas as a fullscreen quad with `NearestFilter`, scaled by the largest integer multiple that fits the window, centered, letterboxed with black.
- All loaded textures use `NearestFilter` / `NearestMipmapNearestFilter`, no anisotropy.

### 4.2 Overworld camera and scene

- `OrthographicCamera`, sized so 1 world unit = 1 tile = 16 texture pixels; visible area is 40×22.5 tiles at 640×360.
- Camera follows the player, clamped to map bounds. Camera position is snapped to the virtual pixel grid (multiples of 1/16 world unit) after follow-lerp to prevent shimmer.
- Draw order (back to front): ground tile layer, decoration tile layer, sprites (y-sorted), overhead tile layer.
- Tile layers are each a single static merged mesh built at map load (one plane per non-empty tile, merged; one draw call per layer per tileset).
- Sprites (player, NPCs) are textured planes. Y-sorting is done by setting `renderOrder` from world y each frame; all sprite materials use `depthTest: false` within the sprite group.

### 4.3 Battle camera and scene

- `PerspectiveCamera`, fixed position: behind and above the player's end of the table, looking down-table toward the opponent (elevation ≈ 35°, FOV 50). Static in v1 — no shake, no cinematics.
- Scene contents: table mesh, wall meshes, two goal cutouts, two paddle meshes, puck mesh, opponent sprite.
- The opponent is a billboarded plane (rotates about Y to face the camera) positioned behind the far goal, scaled to read large in frame.
- Obstacles (if any in the layout) are static extruded-sprite meshes (see 8.4).
- Lighting: one ambient + one directional light, flat shading on extruded meshes. No shadows in v1.

## 5. Input

Keyboard only in v1.

| Context | Keys | Action |
|---|---|---|
| Overworld | Arrows / WASD | 4-direction movement |
| Overworld | Z / Enter / Space | Interact |
| Dialogue | Z / Enter / Space | Advance text |
| Battle | Arrows / WASD | Move paddle (2D, analog-style via key mix) |
| Any | Esc | (reserved; no pause menu in v1) |

Input is polled into a per-frame snapshot (`held`, `pressed`) consumed by the active mode.

## 6. Overworld Mechanics

### 6.1 Map data

One JSON file per map:

```json
{
  "id": "map_test",
  "width": 40,
  "height": 30,
  "tileset": "tiles/main.png",
  "layers": {
    "ground":     [ ...width*height tile indices... ],
    "decoration": [ ... ],
    "overhead":   [ ... ]
  },
  "collision":    [ ...width*height 0|1... ],
  "playerStart": { "x": 10, "y": 12, "facing": "down" },
  "npcs": [ { "id": "npc_a", "sprite": "sprites/npc_a.png",
              "x": 14, "y": 9, "facing": "left",
              "dialogue": "dialogue/npc_a.json",
              "battle": "battles/npc_a.json" } ]
}
```

- Tile indices reference a fixed-grid tileset image (16×16 cells). `-1` = empty.
- `collision` is a separate boolean grid, not derived from tiles.
- `battle` on an NPC is optional. If present, the battle starts when that NPC's dialogue finishes (see 7.3).

### 6.2 Movement and collision

- Grid-locked movement, RPG Maker style: the player occupies exactly one tile and moves in discrete one-tile steps.
- Pressing a direction: if the player is idle, turn to face that direction; if already facing it (or after a 4-frame turn grace), attempt a step.
- A step is allowed if the destination tile is in bounds, `collision == 0`, and not occupied by an NPC.
- Steps tween the sprite from tile to tile over 12 frames (200 ms) with a walk animation; input is buffered so held keys chain steps seamlessly.
- NPCs are stationary in v1. They occupy their tile for collision purposes.

### 6.3 Sprites and animation

- Character sheets: 4 rows (down, left, right, up) × 3 columns (step-A, idle, step-B), 16×24 px frames drawn on planes 1×1.5 world units, anchored at bottom-center of the occupied tile.
- Walk cycle: A, idle, B, idle at 8 fps while stepping; idle frame when stationary.
- Animation is implemented by offsetting texture UVs per frame — one texture per character, no per-frame textures.

### 6.4 Interaction

- On Interact press in overworld mode: compute the tile the player faces. If an NPC occupies it, turn that NPC to face the player and enter DIALOGUE mode with the NPC's dialogue file.
- Nothing else is interactable in v1.

## 7. Dialogue Mechanics

### 7.1 Data

```json
{
  "id": "npc_a",
  "lines": [
    { "name": "A", "portrait": "portraits/a_neutral.png", "text": "First line." },
    { "name": "A", "portrait": "portraits/a_happy.png",   "text": "Second line." }
  ]
}
```

Strictly linear: an ordered list of lines. No choices, no conditions.

> Post-v1: lines can now carry `label`, `goto` and `choices`, which is how the
> player answers back. Every one of them is optional and a script that uses none
> is exactly the file specified here. `Docs/dialogue.md` is the reference.

### 7.2 Presentation

- Dialogue renders as part of the low-res frame (a screen-space quad layer over the active scene), not as HTML: a box occupying the bottom ~30% of the 640×360 frame, portrait at left (96×96), name above the text.
- Text reveals one character per frame (60 cps). Advance press: if revealing, complete the line instantly; if complete, go to next line. After the last line, close the box.
- Text codes are not supported in v1 (reserve `\` as an escape so files stay forward-compatible).
- Overworld simulation is frozen during dialogue; the overworld still renders beneath the box.

### 7.3 Battle handoff

When a dialogue ends: if the NPC has a `battle` file, transition to BATTLE mode with it; otherwise return to OVERWORLD. This hardcoded rule stands in for the future event system.

## 8. Battle Mechanics

### 8.1 Battle data

```json
{
  "id": "npc_a",
  "opponent": {
    "sprite": "battlesprites/a.png",
    "paddleSpeed": 6.0,
    "reactionMs": 180,
    "roamDepth": 0.45,
    "aggression": 0.5
  },
  "table": {
    "width": 4.0,
    "length": 7.0,
    "goalWidth": 1.2,
    "obstacles": [
      { "sprite": "pieces/block.png", "x": 0.0, "y": 1.5,
        "collider": [[-0.3,-0.2],[0.3,-0.2],[0.3,0.2],[-0.3,0.2]] }
    ]
  },
  "rules": { "targetScore": 5 },
  "puck": { "radius": 0.12, "maxSpeed": 14.0, "friction": 0.995, "restitution": 0.98 },
  "paddle": { "radius": 0.22, "maxSpeed": 9.0 }
}
```

Obstacles are optional, static, and purely geometric in v1 (no hit effects). `collider` is a convex polygon in local units; multiple obstacles approximate concave shapes.

### 8.2 Physics (2D plane)

- The simulation is entirely 2D: x across the table, y along it, origin at table center. The 3D scene maps sim (x, y) to mesh (x, z) on the table surface.
- Bodies: puck (dynamic circle), two paddles (kinematic circles), four walls minus goal gaps (static segments), obstacles (static convex polygons).
- Puck: linear damping per `friction`, restitution per config, speed clamped to `maxSpeed` after every step.
- Paddles are kinematic: each frame they are assigned a velocity toward their target position (player input / AI decision), clamped to `paddle.maxSpeed`. Paddle→puck impulse comes from the physics engine's kinematic-vs-dynamic contact using the paddle's current velocity.
- Each paddle is constrained to its own half: y ∈ [−length/2, 0] for the player, [0, length/2] for the opponent, and x within walls, enforced by clamping the target before the physics step.
- Goal detection: a sensor region behind each goal mouth. Puck fully inside sensor ⇒ goal.

### 8.3 Match flow

1. **Faceoff:** puck placed at center (offset 0.5 toward whoever conceded last; center at start), velocity zero, paddles reset to home positions, 30-frame countdown, then play.
2. **Play:** physics runs; first sensor trigger scores a point for the attacker.
3. **Score:** 45-frame pause showing updated score (screen-space score layer, same system as the dialogue box), then Faceoff.
4. **End:** first to `targetScore` wins. Result screen ("WIN" / "LOSE", Interact to continue) then return to OVERWORLD, player facing the NPC. The result is not recorded anywhere in v1; the same battle can be replayed by talking again.
5. Stuck-puck rule: if puck speed stays below 0.2 for 3 seconds, re-faceoff with no score change.

### 8.4 Opponent AI

Two states evaluated every frame, with decisions delayed by `reactionMs` (the AI reads a snapshot of the puck from `reactionMs` ago):

- **Defend** (puck in player half or moving away): move to intercept the puck's current x at a home line `y = roamDepth × length/2`, drifting toward goal center when the puck is far.
- **Attack** (puck in opponent half and reachable): move to a point behind the puck relative to the player's goal and drive through it. Entered with probability `aggression` per approach opportunity; otherwise stays in Defend and blocks.

Target positions are clamped to the opponent's half and fed to the same kinematic paddle mover the player uses. No prediction beyond the delayed snapshot in v1.

### 8.5 Battle presentation

- Table, walls, paddles: untextured or simply-textured low-poly meshes.
- Puck: flat cylinder.
- Opponent sprite: billboarded plane behind the far goal; two frames only in v1 — idle and hit-reaction (played for 20 frames when conceding).
- Obstacles: extruded-sprite slabs generated at load — alpha outline traced (marching squares), simplified, extruded to 0.08 units, side faces shaded 40% darker via vertex colors, flat normals. The drawn slab is cosmetic; the JSON `collider` polygon is the physics truth.
- Score display: screen-space layer, top center, "P 3 — 2 O" style.

## 9. Screen-Space UI Layer

Dialogue box, score, countdown, and result text share one system: a set of quads rendered with an orthographic camera into the same 640×360 target after the world scene, using a pre-baked bitmap font texture (monospace, 8×12 px glyphs) drawn as one quad per glyph, batched. No HTML/CSS UI.

## 10. Asset Conventions

| Asset | Format | Size |
|---|---|---|
| Tileset | PNG | 16×16 px tiles, fixed grid |
| Character sheet | PNG | 48×96 (3×4 frames of 16×24) |
| Portrait | PNG | 96×96 |
| Battle opponent sprite | PNG | up to 128×160, 2 frames side by side |
| Obstacle piece | PNG | up to 64×64, alpha = shape |
| Bitmap font | PNG | 8×12 glyphs, ASCII 32–126 |

All coordinates in JSON are tile units (overworld) or table units (battle). All pixel art is authored 1:1 and scaled only by the integer upscale of the final frame.

## 11. Boot Sequence

1. Load `game.json` (entry map id, asset manifest).
2. Fetch all JSON and textures listed in the manifest; build tile meshes, generate obstacle slabs for every battle file, bake nothing else.
3. Enter OVERWORLD at `playerStart` of the entry map.

Single map is acceptable for v1; map transitions (warp tiles) are the first post-v1 addition and the map format already tolerates them (a future `warps` array).

## 12. Definition of Done (v1)

- Player walks a test map with collision at a stable 60 Hz logic rate; pixels are crisp at any window size.
- Talking to an NPC plays its dialogue; a battle-flagged NPC then starts its battle.
- The battle is playable and winnable/losable against the parameterized AI; obstacles deflect the puck exactly where their drawn colliders say they will.
- Ending a battle returns cleanly to the overworld with no state leakage; the loop can repeat indefinitely without memory growth.
