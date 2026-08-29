# Dialogue

The format the dialogue editor writes and the game speaks. Permanent reference,
like `events.md`.

`mechanical-design-v1.md` §7.1 says dialogue is strictly linear, with no
choices, and §1 puts branching dialogue out of scope for v1. That was
deliberate, and the format it specified is unchanged: everything below is
optional, a script that uses none of it is exactly the file v1 described, and
the three shipped scripts are byte for byte what they were.

---

## A script

```json
{
  "id": "blorb",
  "lines": [
    { "name": "Blorb", "face": "assets/faces/civilian-1.png",
      "text": "My table has bumpers down the middle. First to three?",
      "choices": [
        { "text": "You're on.", "goto": "yes" },
        { "text": "Not now.", "goto": "stop", "setFlag": "ducked-blorb" }
      ] },
    { "name": "Blorb",
      "text": "Then rack them up.",
      "label": "yes" }
  ]
}
```

| Field | On | Meaning |
|---|---|---|
| `name` | line | Who is speaking. Drawn above the text. |
| `face` | line | Portrait, drawn at the left of the box. |
| `text` | line | What they say. Types out one character per frame. |
| `label` | line | A name jumps can aim at. Unique within the script. |
| `goto` | line | Where to continue after this line, instead of the next one. |
| `choices` | line | What the player can say back. |
| `text` | choice | The option, as the player reads it. |
| `goto` | choice | Where picking it continues. |
| `setFlag` | choice | A flag set when it is picked. |
| `to` | choice | What that flag becomes. Absent means `true`. |

---

## Choices

Options appear once the line has finished typing — until then the player has
not read the question. Up and down move the highlight, wrapping; interact
picks. The press that finishes the typewriter never picks, so mashing through
text cannot answer a question on the player's behalf.

They draw in their own panel above the box. Every one of the box's five text
rows belongs to the line asking the question, and a list of options that pushed
the question off the top would be a strange way to ask it. About fourteen fit
above the box; the editor warns past that.

---

## Where a jump can go

`goto` names a line's `label`, or one of two reserved destinations. No line may
be labelled `end` or `stop`, and a `goto` that names neither a label nor a
reserved word fails validation at load.

| `goto` | Means |
|---|---|
| absent | the next line |
| a label | that line, forwards or backwards |
| `end` | the conversation is over, and **what it was leading to still happens** — the NPC's battle starts, the event that ran the script carries on |
| `stop` | **calls the whole thing off** — no battle, and a running event is cancelled |

The difference between the two is the whole reason choices are worth having:
"First to three?" / "Not now." has to be able to mean no. Without `stop`,
declining a challenge starts the challenge.

Falling off the end of the script is `end`.

---

## Being heard outside the conversation

A `goto` decides what is said next. `setFlag` decides what the world knows
afterwards, and it is the same flag an event page's `when` or an `if` command
tests:

```json
{ "text": "Not now.", "goto": "stop", "setFlag": "ducked-blorb" }
```

```json
{ "when": [{ "flag": "ducked-blorb", "is": true }],
  "trigger": "talk",
  "do": [{ "say": [{ "name": "Blorb", "text": "Changed your mind?" }] }] }
```

Flags are booleans, so an answer with more than two outcomes sets a different
flag per option. They are not persisted — see `gameState.ts`.

An NPC in `npcs[]` has no conditions, so it cannot say something different next
time. Turning it into an event — one click in the entity inspector — is what
makes a remembered answer visible. The NPC shorthand stays a shorthand.

---

## Inline lines

An event's `say` command holds the same lines and gets the same branching:

```json
{ "say": [
  { "text": "Take the shortcut?", "choices": [
    { "text": "Yes", "goto": "shortcut" },
    { "text": "No", "goto": "end" } ] },
  { "label": "shortcut", "text": "Mind the pipes." }
] }
```

Labels resolve within the run of lines they are written in, and nowhere else.
A `goto` in a `say` block reaches that block's own lines; there is no jumping
between files, which would make a script's meaning depend on who called it.

---

## What the editor writes

One option per line, for the same reason maps keep one grid row per line: a
reworded option should read as a reworded option. `serializeDialogue` omits
every optional field that is absent, which is what keeps a script that does not
branch identical to the file v1 specified.

The Dialogue tab's fields follow the same order as the format: speaker,
portrait, text, then **Label**, **Then go to**, then the options. Each option
has its text, where it goes, and the flag it leaves behind. The preview draws
through the real `DialogueMode`, so the panel a designer is looking at is the
panel the player gets.
