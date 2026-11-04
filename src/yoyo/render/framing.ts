import type { WorldRect } from '../contracts';

/**
 * Camera framing for the yoyó (PRD §6: frontal, mirrored once, aligned with what the webcam sees).
 *
 * The camera looks straight down −z with no roll or pitch, so the play plane z = 0 is parallel to the
 * image plane and its visible part is an exact axis-aligned rectangle. That is what lets the mouse
 * mapping and the framing guide work in world metres without a raycast.
 */

/**
 * Vertical field of view, degrees. Deliberately narrow: a long lens keeps perspective gentle so the
 * z = 0 plane reads almost orthographic (the hand, string and yoyo all live on it), while off-axis
 * the yoyo still shows a sliver of its rim, which is the only depth cue the frontal view has.
 */
export const CAMERA_FOV_DEG = 30;

/**
 * World y that must always be visible: the floor with a small margin below it (so the floor line and
 * the contact shadow are not glued to the screen edge) up to head-room above the home pivot (0.95 m),
 * where the hand and its fingertips live. The home sits high so that a sleeper stays above the floor
 * even when the hand ends a throw 0.3 ih below where it started (0.95 − 0.3 − 0.65 = 0).
 */
export const FRAME_BOTTOM = -0.06;
export const FRAME_TOP = 1.24;

/** World x half-extent that must stay visible on narrow screens: a swinging yoyo and the hand fit. */
export const FRAME_HALF_WIDTH = 0.45;

/**
 * On portrait screens the width rule needs more height than the base framing. Only this share of the
 * surplus goes below the floor line; the rest is head-room, because nothing lives under y = 0.
 */
export const EXTRA_BELOW_SHARE = 0.2;

/** Aspect used when the canvas has no layout yet (0 × 0 canvas, detached element). */
const FALLBACK_ASPECT = 16 / 9;

/** Result of fitting the required world region into a viewport of the given aspect. */
export interface Framing {
  fovDeg: number;
  aspect: number;
  /** Camera distance from the z = 0 plane, m. */
  distance: number;
  /** World point the camera looks at (x is always 0). */
  centerX: number;
  centerY: number;
  /** Half extents of the visible rectangle on z = 0, m. */
  halfWidth: number;
  halfHeight: number;
  /** Exact visible rectangle on z = 0. */
  rect: WorldRect;
}

/**
 * Fits [FRAME_BOTTOM, FRAME_TOP] vertically and [−FRAME_HALF_WIDTH, FRAME_HALF_WIDTH] horizontally into
 * a viewport with the given width/height aspect. Landscape is limited by height, portrait by width.
 */
export function computeFraming(aspect: number, fovDeg: number = CAMERA_FOV_DEG): Framing {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT;
  const baseHeight = FRAME_TOP - FRAME_BOTTOM;
  const halfHeight = Math.max(baseHeight / 2, FRAME_HALF_WIDTH / a);
  const surplus = 2 * halfHeight - baseHeight;
  const bottom = FRAME_BOTTOM - surplus * EXTRA_BELOW_SHARE;
  const centerY = bottom + halfHeight;
  const distance = halfHeight / Math.tan((fovDeg * Math.PI) / 360);
  return {
    fovDeg,
    aspect: a,
    distance,
    centerX: 0,
    centerY,
    halfWidth: halfHeight * a,
    halfHeight,
    rect: rectAtPlane(0, centerY, distance, fovDeg, a),
  };
}

/**
 * Exact rectangle a camera at (x, y, z) looking down −z with vertical FOV `fovDeg` and the given aspect
 * sees on the plane z = planeZ. Used for the shaken camera too, so the backdrop follows the camera.
 */
export function rectAtPlane(x: number, y: number, z: number, fovDeg: number, aspect: number, planeZ = 0): WorldRect {
  const halfHeight = (z - planeZ) * Math.tan((fovDeg * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  return { left: x - halfWidth, right: x + halfWidth, bottom: y - halfHeight, top: y + halfHeight };
}
