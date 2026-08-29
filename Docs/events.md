# Events

The format the level editor writes and the game runs. Permanent reference —
unlike `editor-handoff.md`, this outlives the editor build.

Events are out of scope in `mechanical-design-v1.md` §1, which said so
deliberately: the v1 data formats were designed so they could be added later
without migration, and they were. `npcs[]` still loads and still works.

---

## What an event is

An event stands on a tile of a map and has ordered **pages**. The first page
whose **conditions** all hold is the live one — an if/else chain, read top to
bottom. That page decides four things: what the event looks like, whether it
blocks the way, what starts it, and what it does.

A guard who steps aside once you have beaten them is one event with two pages.

```json
{
  "id": "gate-guard",
  "x": 10, "y": 4,
  "pages": [
    {
      "when": [{ "flag": "beat-blorb", "is": false }],
      "trigger": "talk",
      "blocks": true,
      "look": { "character": "data/characters/civilian-1.json", "facing": "down" },
      "do": [
        { "script": "data/dialogue/blorb.json" },
        { "battle": "data/battles/blorb.json",
          "won":  [{ "setFlag": "beat-blorb", "to": true }],
          "lost": [{ "say": [{ "name": "Blorb", "text": "Come back when you can hold a paddle." }] }] }
      ]
    },
    {
      "when": [],
      "trigger": "talk",
      "blocks": false,
      "look": { "character": "data/characters/civilian-1.json", "facing": "down" },
      "do": [{ "say": [{ "name": "Blorb", "text": "Table's yours." }] }]
    }
  ]
}
```

Events live in the map file, in an `events` array. Everything about a map is in
one place, and there is no second index to keep in sync.

---

## Pages

| Field | Meaning |
|---|---|
| `when` | Conditions, all of which must hold. Empty means always — the fallback, so put that page last. |
| `trigger` | How it starts. See below. |
| `blocks` | Whether the player can walk through it. Separate from the map's collision grid, which is why a door can open without the grid changing. |
| `look` | `{ character, facing, tint? }`. Absent means invisible. |
| `do` | The commands. |

### Triggers

| Trigger | Starts when |
|---|---|
| `talk` | the player faces it and presses interact |
| `touch` | the player's step finishes on its tile |
| `auto` | this page becomes the live one — holds the player still while it runs |
| `parallel` | this page becomes the live one — runs alongside the player, who keeps walking |

`auto` and `parallel` fire once per page activation, not on a loop. Write a
`while` if you want a loop; it is clearer and it cannot be a footgun by accident.

A `parallel` page cannot say anything, start a battle or warp. All three take
over the screen, and interrupting the player mid-step is worse than refusing.
The refusal is logged rather than silent.

---

## Conditions

```json
{ "flag": "beat-blorb", "is": true }
{ "var": "coins", "op": ">=", "value": 3 }
```

Operators: `=` `!=` `<` `<=` `>` `>=`.

A flag nobody has set reads `false`; a variable nobody has set reads `0`. That
is what lets you write the "after you have beaten Blorb" page before writing the
page that sets the flag.

---

## Commands

| Command | Does |
|---|---|
| `{ "say": [ { "name"?, "face"?, "text" } ] }` | Speaks lines written here |
| `{ "script": "data/dialogue/x.json" }` | Speaks a dialogue file, so the dialogue editor's work is reusable |
| `{ "setFlag": "name", "to": true }` | |
| `{ "setVar": "name", "to": 3 }` | |
| `{ "addVar": "name", "by": 1 }` | |
| `{ "if": [conditions], "then": [...], "else"?: [...] }` | |
| `{ "while": [conditions], "do": [...] }` | Tested before the first pass |
| `{ "repeat": 4, "do": [...] }` | |
| `{ "break": true }` | Leaves the innermost loop. Outside a loop, ends the event |
| `{ "wait": 30 }` | Frames. 60 is a second |
| `{ "battle": "path", "won"?: [...], "lost"?: [...] }` | |
| `{ "warp": { "to": "path", "x": 4, "y": 9, "facing"? } }` | |
| `{ "face": "down" }` | The event turns |
| `{ "walk": ["up", "up", "left"] }` | The event walks, one tile per direction |
| `{ "stop": true }` | Ends the event, whatever it is inside |

`say` and `script` both speak dialogue **lines**, which can offer the player
choices and branch on the answer — see `dialogue.md`. An option can set a flag,
which is how an answer reaches the conditions above. One thing to know before
writing one: an option that ends the conversation lets the rest of the event
run, and an option that calls it off cancels the event where it stands.

---

## How it runs

The game is a 60Hz fixed-timestep loop, so an event that waits cannot block the
tick. The interpreter (`src/world/eventRunner.ts`) suspends and resumes: it runs
commands until one needs the outside world, hands that back as a request, and
picks up where it left off when the host answers.

One event has the foreground at a time — talk, touch and auto pages — and holds
the player still while it runs. Parallel pages run in their own runners
alongside.

A `while` whose condition never changes is a designer's mistake, but not one
that should lock the browser: the interpreter yields after a fixed number of
commands per tick, so the game keeps running visibly while the loop spins.

---

## Flags and variables are not saved

`GameState` lives for the session and resets on reload. Doc §1 puts save/load
out of v1 scope, and a `localStorage` autosave would be a save system by the
back door — no slots, no versioning, and no way to tell a designer's test state
from a player's game.

The editor's Events tab has a panel that lists every flag and variable in play
and lets you set one by hand. Without it, testing a second page would mean
walking the world again to earn its flag after every reload.

Real saving is its own piece of work, and this is the shape it would attach to.
