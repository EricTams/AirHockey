import * as THREE from 'three'

/**
 * What hour it is, and what that does to the picture.
 *
 * Nothing in the overworld is lit — every material is unlit and draws its own
 * texture at full brightness — so "lighting" here is not a light at all. It is
 * two things:
 *
 *   the light   a colour multiplied into the finished frame, plus a faint wash
 *               over the top. The multiply is the tint and the darkening; the
 *               wash lifts the blacks toward the colour of the sky, which a
 *               multiply cannot do and which is the difference between a blue
 *               night and a black one.
 *
 *   the sun     where the shadows point and how long they are. It sits in the
 *               south, behind the camera, all day, so a shadow always runs away
 *               from the viewer; but it crosses from east to west, so the
 *               shadow swings from pointing west in the morning to east in the
 *               evening, and is shortest at noon.
 *
 * The light is per PHASE and the sun is per HOUR, deliberately. Colour snapping
 * at four boundaries is what makes day fall into night quickly rather than
 * fading across twelve hours, and it is honest with the flat dithered palette
 * the art is drawn in. The sun keeps moving through the flat middle of the day
 * anyway, so the world reads as a sundial even while its colour holds still.
 */

const DEG = Math.PI / 180

export type Phase = 'night' | 'dawn' | 'day' | 'dusk'

/** Where the sun is, as the shadow it throws: a bearing and a lean. */
export type Sun = {
  /** Clockwise from north. Negative is west of north, positive is east of it. */
  bearingDeg: number
  /** Off vertical. 0 is straight overhead and casts nothing. */
  tiltDeg: number
}

export type Light = {
  /** Multiplied into the frame. White is no tint at all. */
  mul: number
  /** Washed over it afterwards, at `washAmount`. */
  wash: number
  washAmount: number
  /** Scales whatever strength the shadow style asks for. */
  shadow: number
  /** What colour a shadow is — it is lit by the sky, not by the sun. */
  shadowTint: number
}

export type Daylight = {
  hour: number
  phase: Phase
  sun: Sun
  light: Light
}

/** Hours in the clock the slider runs over. */
export const HOURS = 24

/** What a map without an hour of its own is drawn at: plain midday. */
export const DEFAULT_HOUR = 12

/**
 * Which look each hour gets. The boundaries here ARE the transitions — there is
 * no interpolation anywhere — so moving one of these numbers moves the moment
 * the world changes colour.
 */
export const HOUR_PHASE: readonly Phase[] = [
  'night', 'night', 'night', 'night', 'night',   //  0- 4
  'dawn', 'dawn', 'dawn',                        //  5- 7
  'day', 'day', 'day', 'day', 'day',             //  8-12
  'day', 'day', 'day', 'day',                    // 13-16
  'dusk', 'dusk', 'dusk', 'dusk',                // 17-20
  'night', 'night', 'night',                     // 21-23
]

/**
 * The four looks.
 *
 * `day` is the identity: a white multiply and no wash leave the frame exactly
 * as it was drawn, and its shadow numbers are the ones the world shipped with
 * before there were hours. Midday must come out pixel for pixel unchanged.
 */
export const PHASE_LIGHT: Record<Phase, Light> = {
  // Low sun through a lot of air, and the ground still cold from the night.
  // Mild: enough to read as morning against the hour either side of it, well
  // short of a filter laid over the art.
  dawn: {
    mul: 0xffecd0, wash: 0xffdca0, washAmount: 0.05,
    shadow: 0.85, shadowTint: 0x141426,
  },
  day: {
    mul: 0xffffff, wash: 0xffffff, washAmount: 0,
    shadow: 1, shadowTint: 0x0b1018,
  },
  // The same low sun, warmer and redder, over ground that has been in it all
  // day. Redder than dawn is warmer, but no stronger: both are a tint on the
  // art, and night is the only hour that really changes what you are looking at.
  dusk: {
    mul: 0xffc8a6, wash: 0xff9a68, washAmount: 0.06,
    shadow: 0.88, shadowTint: 0x1a1122,
  },
  // Moonlight is sunlight twice reflected: much less of it, and blue.
  night: {
    mul: 0x44609e, wash: 0x1d2c52, washAmount: 0.14,
    shadow: 0.35, shadowTint: 0x070b14,
  },
}

/** Hours the sun is above the horizon. Outside them the moon stands in. */
const SUNRISE = 5
const SUNSET = 20

/**
 * How far off north the shadow swings at either end of the day.
 *
 * This has to stay well under 90. Every shadow in the world is drawn from one
 * group beneath every sprite (see OverworldMode), which is only right while a
 * shadow falls on ground the things behind it have already been drawn on — that
 * is, while it runs northward. A bearing past 90 would break that with no error
 * and no obvious symptom beyond a shadow drawn over the thing casting it.
 */
const SWING_DEG = 55

/** Lean off vertical at noon, and at either end of the day. */
const TILT_NOON_DEG = 18
const TILT_HORIZON_DEG = 45

/** The moon sits in the south too, but low enough to throw only a short shadow. */
const MOON: Sun = { bearingDeg: 0, tiltDeg: 26 }

function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t }

/** Round and clamp anything into an hour of the clock. */
export function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return DEFAULT_HOUR
  return Math.max(0, Math.min(HOURS - 1, Math.round(hour)))
}

export function phaseAt(hour: number): Phase {
  return HOUR_PHASE[normalizeHour(hour)]!
}

/** Where the sun — or after dark, the moon — stands at a given hour. */
export function sunAt(hour: number): Sun {
  const h = normalizeHour(hour)
  if (h < SUNRISE || h > SUNSET) return MOON
  const u = clamp01((h - SUNRISE) / (SUNSET - SUNRISE))
  return {
    // 0 at sunrise sends the shadow north-west; 1 at sunset, north-east.
    bearingDeg: -SWING_DEG + 2 * SWING_DEG * u,
    // Farthest from noon is lowest, and a low sun throws a long shadow.
    tiltDeg: TILT_NOON_DEG + (TILT_HORIZON_DEG - TILT_NOON_DEG) * Math.abs(2 * u - 1),
  }
}

/**
 * Where the top of something `h` tiles tall lands on the ground, relative to
 * its base, in tiles. The whole geometry of a cast shadow is this one vector,
 * and the hour enters the world through it.
 */
export function castOffset(h: number, sun: Sun): { dx: number; dz: number } {
  const len = h * Math.tan(sun.tiltDeg * DEG)
  const b = sun.bearingDeg * DEG
  // Z runs south, so a northward bearing is negative Z.
  return { dx: len * Math.sin(b), dz: -len * Math.cos(b) }
}

export function daylightAt(hour: number): Daylight {
  const h = normalizeHour(hour)
  const phase = HOUR_PHASE[h]!
  return { hour: h, phase, sun: sunAt(h), light: PHASE_LIGHT[phase] }
}

/** How an hour reads in the editor and the debug overlay. */
export function hourLabel(hour: number): string {
  const h = normalizeHour(hour)
  return `${String(h).padStart(2, '0')}:00 · ${HOUR_PHASE[h]}`
}

/**
 * The light, as a pass over the finished frame.
 *
 * Two full-screen quads in their own scene, drawn after the world and its
 * backdrop. Doing it here rather than on each material means the ground, the
 * props, the sprites, their shadows and the sky are all caught by construction,
 * including whatever gets added to the world next.
 */
export class DaylightPass {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1)
  private mulMat: THREE.MeshBasicMaterial
  private washMat: THREE.MeshBasicMaterial
  private mul: THREE.Mesh
  private wash: THREE.Mesh
  private geo = new THREE.PlaneGeometry(2, 2)

  constructor(light: Light = PHASE_LIGHT.day) {
    // Multiply: the frame times the colour of the light. Darkens and tints, and
    // cannot brighten — which is why the wash exists.
    //
    // Spelled out rather than `MultiplyBlending`, which three only honours on a
    // premultiplied material and otherwise drops with a console error, leaving
    // the quad to paint the frame flat.
    this.mulMat = new THREE.MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
    })
    this.mul = this.quad(this.mulMat, 0)

    // Wash: ordinary alpha over the top, so black pixels come up toward the sky
    // instead of staying black.
    this.washMat = new THREE.MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
    })
    this.wash = this.quad(this.washMat, 1)

    this.setLight(light)
  }

  private quad(material: THREE.Material, order: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo, material)
    mesh.renderOrder = order
    mesh.frustumCulled = false
    this.scene.add(mesh)
    return mesh
  }

  setLight(light: Light): void {
    this.mulMat.color.setHex(light.mul)
    // A white multiply is the identity, so midday draws nothing at all.
    this.mul.visible = light.mul !== 0xffffff
    this.washMat.color.setHex(light.wash)
    this.washMat.opacity = light.washAmount
    this.wash.visible = light.washAmount > 0
  }

  /** Nothing to draw at midday, which is worth knowing before binding a target. */
  get isIdentity(): boolean { return !this.mul.visible && !this.wash.visible }

  render(gl: THREE.WebGLRenderer): void {
    if (this.isIdentity) return
    gl.render(this.scene, this.camera)
  }

  dispose(): void {
    this.geo.dispose()
    this.mulMat.dispose()
    this.washMat.dispose()
  }
}
