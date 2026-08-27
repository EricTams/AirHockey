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
    path: 'assets/faces/sleuth.png',
    label: 'FACE SLEUTH',
    kind: 'face',
    width: 144, height: 144,
    reason: 'doc 7.2 dialogue portrait',
  },
  {
    path: 'assets/faces/civilian-1.png',
    label: 'FACE CIV1',
    kind: 'face',
    width: 144, height: 144,
    reason: 'doc 7.2 dialogue portrait',
  },
  {
    path: 'assets/faces/civilian-2.png',
    label: 'FACE CIV2',
    kind: 'face',
    width: 144, height: 144,
    reason: 'doc 7.2 dialogue portrait',
  },
  {
    path: 'assets/faces/civilian-3.png',
    label: 'FACE CIV3',
    kind: 'face',
    width: 144, height: 144,
    reason: 'doc 7.2 dialogue portrait',
  },
  {
    path: 'assets/characters/sleuth-walk-up.png',
    label: 'SLEUTH UP',
    kind: 'character',
    width: 75, height: 78,
    reason: 'doc 6.2 the player faces four ways; left is the mirrored walk, but a side view cannot be turned into a front or back one',
  },
  {
    path: 'assets/characters/sleuth-walk-down.png',
    label: 'SLEUTH DOWN',
    kind: 'character',
    width: 75, height: 78,
    reason: 'doc 6.2 the player faces four ways; left is the mirrored walk, but a side view cannot be turned into a front or back one',
  },
  {
    path: 'assets/characters/civilian-turn.png',
    label: 'CIV TURN',
    kind: 'character',
    width: 48, height: 96,
    reason: 'doc 6.4 NPC turns to face the player; the civilians face front only',
  },
  {
    path: 'assets/battlers/civilian-hit.png',
    label: 'CIV HIT',
    kind: 'battler',
    width: 48, height: 96,
    reason: 'doc 8.5 opponent hit reaction; all four civilian frames read as idle',
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
