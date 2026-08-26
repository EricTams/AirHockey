# AirHockey RPG

Walk a tile world, talk to the locals, and settle it over a table.

A small RPG built on a single Three.js renderer: a top-down overworld, linear
dialogue, and air hockey matches against opponents who each bring their own
arena gimmick. Built from `Docs/mechanical-design-v1.md`.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # typecheck + production build into dist/
```

## Playing

| Context | Input | Action |
|---|---|---|
| Overworld | WASD / arrows | Walk |
| Overworld | Z / Enter / Space | Talk to whoever you are facing |
| Dialogue | Z / Enter / Space | Reveal the rest of the line, then advance |
| Battle | Mouse | Move your paddle |
| Battle | Click your paddle | Start or resume play |
| Any | `M` | Cycle modes · `F1` overlay · `[` `]` camera pitch |

Three opponents wait to the north. **Blorb** plays it straight across a table
with bumpers. **Gravy** will not play you at all — there is a chicken wing
lodged in their goal, and you have to knock it loose. **Sprocket** plumbed their
own table, and the pipes turn the puck a quarter-turn on the way through.

## How it fits together

One `WebGLRenderer` draws every mode into a 960×540 target, which is blitted to
the canvas at the largest integer multiple that fits and letterboxed, so the
pixel art stays crisp at any window size. A single `requestAnimationFrame` loop
drives a 60 Hz fixed-timestep tick with a variable render.

- `src/core` — renderer, loop, input, mode machine, asset loading, path resolution
- `src/world` — Aseprite sheets, characters, the camera rig, the generated backdrop
- `src/modes` — overworld, dialogue, and `battle/` with its own 2D sim
- `src/ui` — screen-space layer, bitmap font, text batching

The overworld camera is one dial rather than two code paths. Pitch drives the
field of view: a ~1° lens at long throw is optically orthographic, keeping the
flat view pixel-exact, and widening it as the camera tilts introduces real
convergence. `[` and `]` scrub it live.

Battle physics is hand-written rather than an engine. The puck covers around two
radii per tick at top speed, so tunnelling is a live risk, and the paddle-to-puck
impulse — the interaction the game rests on — needs direct control.

## Art

Source art is authored in Aseprite and arrives as sheet + JSON pairs in a
gitignored `ContentDrop-*/` folder; `tools/import-assets.sh` normalizes it into
`public/assets/`.

Anything the design calls for that does not exist yet renders as a labelled
placeholder rather than breaking or silently vanishing — see
`src/world/missingArt.ts` for the current list. The bitmap font is generated at
runtime for the same reason.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Content is addressed by project-relative path
and resolved against `document.baseURI`, so the build works unchanged at a
domain root or under a `/<repo>/` subpath.
