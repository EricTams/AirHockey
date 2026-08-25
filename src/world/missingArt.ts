import type { PlaceholderOpts } from './placeholder'

/**
 * Art the design calls for that the current content drop does not contain.
 * Each entry drives a labelled placeholder, so the gap is visible in-game and
 * enumerable in one place. Delete an entry when the real asset lands.
 */
export interface MissingArt extends PlaceholderOpts {
  /** Asset path this stands in for, once it exists. */
  path: string
  /** Why it is needed, referencing the design doc. */
  reason: string
}

export const MISSING_ART: MissingArt[] = [
  {
    path: 'assets/faces/character-1.png',
    label: 'FACE C1',
    kind: 'face',
    width: 144, height: 144,
    reason: 'doc 7.2 dialogue portrait',
  },
  {
    path: 'assets/faces/character-2.png',
    label: 'FACE C2',
    kind: 'face',
    width: 144, height: 144,
    reason: 'doc 7.2 dialogue portrait',
  },
  {
    path: 'assets/characters/character-2-left.png',
    label: 'C2 LEFT',
    kind: 'character',
    width: 48, height: 48,
    reason: 'doc 6.4 NPC turns to face the player; C2 has idle frames only',
  },
  {
    path: 'assets/characters/character-2-right.png',
    label: 'C2 RIGHT',
    kind: 'character',
    width: 48, height: 48,
    reason: 'doc 6.4 NPC turns to face the player; C2 has idle frames only',
  },
  {
    path: 'assets/characters/character-2-up.png',
    label: 'C2 UP',
    kind: 'character',
    width: 48, height: 48,
    reason: 'doc 6.4 NPC turns to face the player; C2 has idle frames only',
  },
  {
    path: 'assets/battlers/character-2-hit.png',
    label: 'C2 HIT',
    kind: 'battler',
    width: 48, height: 48,
    reason: 'doc 8.5 opponent hit reaction; both C2 frames read as idle',
  },
  {
    path: 'assets/props/chicken-wing.png',
    label: 'CHICKEN WING',
    kind: 'generic',
    width: 64, height: 64,
    reason: 'lodged in the goal in the Gravy fight; no prop art exists',
  },
]

export function findMissing(path: string): MissingArt | undefined {
  return MISSING_ART.find((m) => m.path === path)
}
