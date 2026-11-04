import type { Vec2 } from '../contracts';

/**
 * Hand silhouette geometry (PRD §6: «cápsulas por falange + palma», no rigged hand: the rotations of the
 * phalanges cannot be observed with 21 points). Pure and allocation-free per call: it turns the 21 world
 * landmarks into a list of tapered capsules that the hand shader evaluates as a signed-distance union, so
 * overlapping capsules form ONE translucent shape instead of stacking opacity at every joint.
 */

export const HAND_LANDMARKS = 21;
/** Landmark the string is tied to (middle-finger MCP) and the next one up the finger. */
export const ANCHOR_LANDMARK = 9;
export const FINGER_NEXT_LANDMARK = 10;

/** Upper bound of capsules the shader loops over. The real count is 23; one slot is spare. */
export const MAX_BONES = 24;

/** Radii, in palm units (wrist→middle-MCP distance), joint by joint from the knuckle to the tip. */
const FINGER_RADII = [0.105, 0.095, 0.085, 0.072] as const;
const THUMB_RADII = [0.16, 0.135, 0.115, 0.098, 0.085] as const;
/** Index, middle, ring, pinky: pinky and ring are a little slimmer. */
const FINGER_SCALE = [1, 1.02, 0.96, 0.86] as const;
const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20],
];
/** The palm is a fan of fat capsules from the wrist to each knuckle plus the knuckle row. */
const PALM_WRIST_RADIUS = 0.26;
const PALM_KNUCKLE_RADIUS = 0.12;
const KNUCKLE_ROW_RADIUS = 0.11;
/** Forearm stub below the wrist: it fades out, so the hand does not look cut off. */
const ARM_LENGTH = 1.1;
const ARM_RADII = [0.3, 0.27] as const;
/** Smooth-union radius, palm units: joins fingers to the palm without visible creases. */
const SMOOTH_UNION = 0.07;
/** The ring around the middle finger: where on the proximal phalanx (0 = knuckle, 1 = next joint). */
const RING_ALONG = 0.65;
/** Ring clearance over the finger radius, and its tube radius relative to the ring's major radius. */
const RING_CLEARANCE = 1.04;
export const RING_TUBE_RATIO = 0.16;

/** Capsule list: [from landmark, to landmark, radius at from, radius at to] with radii in palm units. */
const BONES: ReadonlyArray<readonly [number, number, number, number]> = (() => {
  const bones: Array<readonly [number, number, number, number]> = [];
  for (let k = 0; k < 4; k++) bones.push([k, k + 1, THUMB_RADII[k], THUMB_RADII[k + 1]]);
  FINGERS.forEach((finger, f) => {
    for (let k = 0; k < 3; k++) {
      bones.push([finger[k], finger[k + 1], FINGER_RADII[k] * FINGER_SCALE[f], FINGER_RADII[k + 1] * FINGER_SCALE[f]]);
    }
  });
  for (const mcp of [5, 9, 13, 17]) bones.push([0, mcp, PALM_WRIST_RADIUS, PALM_KNUCKLE_RADIUS]);
  for (const [a, b] of [[5, 9], [9, 13], [13, 17]] as const) bones.push([a, b, KNUCKLE_ROW_RADIUS, KNUCKLE_ROW_RADIUS]);
  return bones;
})();

export const BONE_COUNT = BONES.length;

/** Everything the hand shader and the finger ring need for one frame. Reused: build() overwrites it. */
export interface HandPose {
  /** Capsules used. */
  count: number;
  /** ax, ay, bx, by per capsule, world m. */
  seg: Float32Array;
  /** Radius at a and at b per capsule, m. */
  rad: Float32Array;
  /** Forearm stub: ax, ay, bx, by, then its two radii. */
  arm: Float32Array;
  /** Smooth-union radius, m. */
  smooth: number;
  /** Palm unit actually used, m. */
  unit: number;
  /** Bounding box of the silhouette, m (padded by the largest radius). */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * Ring around the middle finger: centre, unit direction along the finger, major radius (m). The centre
   * is also where the string is tied; from there it runs down the finger to the knuckle (the pivot).
   */
  ringX: number;
  ringY: number;
  ringDirX: number;
  ringDirY: number;
  ringRadius: number;
  /** Translated landmarks, x, y interleaved. Exposed for the string and for tests. */
  points: Float32Array;
}

export function createHandPose(): HandPose {
  return {
    count: 0,
    seg: new Float32Array(4 * MAX_BONES),
    rad: new Float32Array(2 * MAX_BONES),
    arm: new Float32Array(6),
    smooth: 0,
    unit: 0,
    minX: 0, minY: 0, maxX: 0, maxY: 0,
    ringX: 0, ringY: 0, ringDirX: 0, ringDirY: 1, ringRadius: 0,
    points: new Float32Array(2 * HAND_LANDMARKS),
  };
}

/** True when `landmarks` can be drawn: 21 points, all finite. Anything else is treated as "no hand". */
export function isDrawableHand(landmarks: readonly Vec2[] | null): landmarks is readonly Vec2[] {
  if (!landmarks || landmarks.length < HAND_LANDMARKS) return false;
  for (let i = 0; i < HAND_LANDMARKS; i++) {
    const p = landmarks[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  }
  return true;
}

/**
 * Builds the silhouette for `landmarks` into `out`.
 *
 * `anchorX/anchorY`: when `translate` is true the whole hand is shifted so landmark 9 sits exactly on
 * this point. The renderer passes the snapshot's pivot: the pivot is the smoothed anchor, and drawing the
 * hand where it was tracked would pull it away from the string by the filter lag.
 *
 * `palmWorld` (m) sets the thickness; 0 or non-finite falls back to the measured wrist→knuckle distance.
 * Returns false (and leaves `out` unchanged) when the landmarks are not drawable.
 */
export function buildHandPose(
  out: HandPose,
  landmarks: readonly Vec2[] | null,
  anchorX: number,
  anchorY: number,
  translate: boolean,
  palmWorld: number,
): boolean {
  if (!isDrawableHand(landmarks)) return false;
  const shiftX = translate && Number.isFinite(anchorX) ? anchorX - landmarks[ANCHOR_LANDMARK][0] : 0;
  const shiftY = translate && Number.isFinite(anchorY) ? anchorY - landmarks[ANCHOR_LANDMARK][1] : 0;
  const p = out.points;
  for (let i = 0; i < HAND_LANDMARKS; i++) {
    p[2 * i] = landmarks[i][0] + shiftX;
    p[2 * i + 1] = landmarks[i][1] + shiftY;
  }

  let unit = Number.isFinite(palmWorld) && palmWorld > 0 ? palmWorld : 0;
  if (unit === 0) unit = Math.hypot(p[2 * ANCHOR_LANDMARK] - p[0], p[2 * ANCHOR_LANDMARK + 1] - p[1]);
  // A collapsed hand (all landmarks coincide) would draw nothing; give it a plausible size instead.
  if (unit < 0.02) unit = 0.17;
  out.unit = unit;
  out.smooth = SMOOTH_UNION * unit;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxRadius = 0;
  out.count = BONES.length;
  for (let i = 0; i < BONES.length; i++) {
    const [a, b, ra, rb] = BONES[i];
    const ax = p[2 * a];
    const ay = p[2 * a + 1];
    const bx = p[2 * b];
    const by = p[2 * b + 1];
    out.seg[4 * i] = ax;
    out.seg[4 * i + 1] = ay;
    out.seg[4 * i + 2] = bx;
    out.seg[4 * i + 3] = by;
    out.rad[2 * i] = ra * unit;
    out.rad[2 * i + 1] = rb * unit;
    minX = Math.min(minX, ax, bx);
    minY = Math.min(minY, ay, by);
    maxX = Math.max(maxX, ax, bx);
    maxY = Math.max(maxY, ay, by);
    maxRadius = Math.max(maxRadius, ra * unit, rb * unit);
  }
  // Pad the box by the largest radius and a little more for the soft edge.
  const pad = maxRadius * 1.25;

  // Forearm stub: continues the line from the knuckles' centre to the wrist, away from the fingers.
  const cx = (p[10] + p[18] + p[26] + p[34]) / 4;
  const cy = (p[11] + p[19] + p[27] + p[35]) / 4;
  let dx = p[0] - cx;
  let dy = p[1] - cy;
  const dl = Math.hypot(dx, dy);
  if (dl > 1e-9) { dx /= dl; dy /= dl; } else { dx = 0; dy = -1; }
  out.arm[0] = p[0];
  out.arm[1] = p[1];
  out.arm[2] = p[0] + dx * ARM_LENGTH * unit;
  out.arm[3] = p[1] + dy * ARM_LENGTH * unit;
  out.arm[4] = ARM_RADII[0] * unit;
  out.arm[5] = ARM_RADII[1] * unit;
  minX = Math.min(minX, out.arm[2]);
  minY = Math.min(minY, out.arm[3]);
  maxX = Math.max(maxX, out.arm[2]);
  maxY = Math.max(maxY, out.arm[3]);

  out.minX = minX - pad;
  out.minY = minY - pad;
  out.maxX = maxX + pad;
  out.maxY = maxY + pad;

  // Ring on the proximal phalanx of the middle finger.
  const kx = p[2 * ANCHOR_LANDMARK];
  const ky = p[2 * ANCHOR_LANDMARK + 1];
  let fx = p[2 * FINGER_NEXT_LANDMARK] - kx;
  let fy = p[2 * FINGER_NEXT_LANDMARK + 1] - ky;
  const fl = Math.hypot(fx, fy);
  if (fl > 1e-9) { fx /= fl; fy /= fl; } else { fx = 0; fy = 1; }
  out.ringDirX = fx;
  out.ringDirY = fy;
  out.ringX = kx + (p[2 * FINGER_NEXT_LANDMARK] - kx) * RING_ALONG;
  out.ringY = ky + (p[2 * FINGER_NEXT_LANDMARK + 1] - ky) * RING_ALONG;
  // Wide enough to clear the finger (whose radius is FINGER_RADII[0] palm units) plus the tube itself.
  out.ringRadius = FINGER_RADII[0] * FINGER_SCALE[1] * unit * RING_CLEARANCE / (1 - RING_TUBE_RATIO);
  return true;
}

/**
 * Hand skeleton in palm units, MediaPipe landmark order: u to the image's right, v up the fingers, the
 * wrist at the origin and the middle-finger MCP about one unit above it. A relaxed open hand with the
 * palm to the camera. Used for the framing guide's ghost hand and for the QA fixture.
 */
export const HAND_TEMPLATE_UV: ReadonlyArray<readonly [number, number]> = [
  [0.00, 0.00],
  [0.30, 0.22], [0.52, 0.45], [0.70, 0.66], [0.84, 0.84],
  [0.31, 0.93], [0.36, 1.30], [0.38, 1.52], [0.39, 1.72],
  [0.09, 1.00], [0.10, 1.40], [0.10, 1.64], [0.10, 1.86],
  [-0.14, 0.96], [-0.17, 1.32], [-0.18, 1.54], [-0.19, 1.74],
  [-0.35, 0.86], [-0.41, 1.14], [-0.43, 1.31], [-0.44, 1.46],
];

/** Extent of the template in palm units: u ∈ [TEMPLATE_MIN_U, TEMPLATE_MAX_U], v ∈ [0, TEMPLATE_MAX_V]. */
export const TEMPLATE_MIN_U = -0.44;
export const TEMPLATE_MAX_U = 0.84;
export const TEMPLATE_MAX_V = 1.86;

/**
 * Share of each phalanx that remains visible at full curl, joint by joint (PIP, DIP, tip): a finger that
 * folds toward the palm (toward the camera) foreshortens in the frontal view, its tip landing near its
 * knuckle. The thumb is left alone.
 */
const CURL_REMAINING = [0.48, 0.26, 0.1] as const;

/**
 * A plausible hand in world metres with landmark 9 exactly on (pivotX, pivotY) and the given wrist→knuckle
 * distance. `tilt` (rad, positive tips the fingers toward +x) rotates it about the wrist; `curl` in 0..1
 * foreshortens the fingers, so the QA fixture can show a closing hand.
 */
export function templateHand(pivotX: number, pivotY: number, palm: number, tilt = 0, curl = 0): Vec2[] {
  const [mu, mv] = HAND_TEMPLATE_UV[ANCHOR_LANDMARK];
  const k = palm / Math.hypot(mu, mv);
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const uv: Array<[number, number]> = HAND_TEMPLATE_UV.map(([u, v]) => [u, v]);
  const c = Math.min(1, Math.max(0, curl));
  if (c > 0) {
    for (const finger of FINGERS) {
      const [ku, kv] = HAND_TEMPLATE_UV[finger[0]];
      for (let j = 1; j < 4; j++) {
        const [fu, fv] = HAND_TEMPLATE_UV[finger[j]];
        const keep = 1 - c * (1 - CURL_REMAINING[j - 1]);
        uv[finger[j]] = [ku + (fu - ku) * keep, kv + (fv - kv) * keep];
      }
    }
  }
  // Rotate about the wrist (tipping the fingers toward +x is a clockwise turn with v up), then shift so
  // that landmark 9 lands on the pivot.
  const rotate = (u: number, v: number): readonly [number, number] => [u * cos + v * sin, -u * sin + v * cos];
  const [au, av] = rotate(uv[ANCHOR_LANDMARK][0], uv[ANCHOR_LANDMARK][1]);
  return uv.map(([u, v]): Vec2 => {
    const [ru, rv] = rotate(u, v);
    return [pivotX + (ru - au) * k, pivotY + (rv - av) * k];
  });
}
