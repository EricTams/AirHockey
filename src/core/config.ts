/** Virtual framebuffer. Doc §4.1 said 640×360 for 16px tiles; the art is 48px, so 960×540. */
export const VIRTUAL_W = 960
export const VIRTUAL_H = 540

/** 1 world unit = 1 tile = 48 source pixels. */
export const TILE = 48

/** One elevation step = 24px = half a tile (matches the cliff-strip band pitch). */
export const HEIGHT_STEP = 0.5

/** Fixed logic rate (doc §3). */
export const TICK_HZ = 60
export const TICK_DT = 1 / TICK_HZ

/**
 * Overworld camera pitch in degrees. 90 = flat top-down (v1); ~35 stands every
 * billboard fully upright for the 2.5D look (see plan "Camera Rig"). 45 is the
 * middle: enough tilt to stand the art up and to show the ground shadows it
 * casts, while the tile grid still reads as a map you can navigate.
 */
export const CAMERA_PITCH_DEG = 45

/**
 * Field of view at full top-down. Near zero is optically orthographic: a
 * narrow FOV at a long distance has no appreciable convergence, which keeps
 * the flat view pixel-exact.
 */
export const FOV_FLAT_DEG = 1
/** Field of view at full tilt, where convergence should read as depth. */
export const FOV_TILTED_DEG = 38
