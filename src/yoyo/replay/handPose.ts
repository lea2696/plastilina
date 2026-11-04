import type { HandDetection, Landmark } from '../../shared/contracts';

/** Camera frames are 640×480: image width is 4/3 image heights (ih). */
export const IMAGE_ASPECT = 4 / 3;
/** Landmark the yoyó ties its string to: the middle-finger MCP. */
export const ANCHOR_INDEX = 9;
/** Mean wrist→MCP distance of an adult hand at ~60 cm from a laptop webcam, ih (z included). */
export const DEFAULT_PALM_SIZE = 0.17;
/** Palm size the z template below was drawn for; relative z grows with the hand's apparent size. */
const REFERENCE_PALM_SIZE = 0.17;
const MCP_INDICES = [5, 9, 13, 17] as const;

/**
 * Hand skeleton in palm units, MediaPipe landmark order, for a hand held up with the palm toward
 * the camera. u points to the image's right and v up the fingers (x and y before scaling); the
 * wrist is the origin and the middle MCP sits about one palm unit above it. Proportions follow a
 * relaxed open hand: the thumb splays out, the four MCPs lie on a shallow arc.
 */
const TEMPLATE_UV: ReadonlyArray<readonly [number, number]> = [
  [0.00, 0.00],
  [0.30, 0.22], [0.52, 0.45], [0.70, 0.66], [0.84, 0.84],
  [0.31, 0.93], [0.36, 1.30], [0.38, 1.52], [0.39, 1.72],
  [0.09, 1.00], [0.10, 1.40], [0.10, 1.64], [0.10, 1.86],
  [-0.14, 0.96], [-0.17, 1.32], [-0.18, 1.54], [-0.19, 1.74],
  [-0.35, 0.86], [-0.41, 1.14], [-0.43, 1.31], [-0.44, 1.46],
];

/**
 * MediaPipe z relative to the wrist at the reference palm size, in image-width units. Negative is
 * closer to the camera: fingertips of a palm-forward hand sit 0.04–0.08 in front of the wrist.
 */
const TEMPLATE_Z: readonly number[] = [
  0.000,
  -0.010, -0.020, -0.030, -0.040,
  -0.030, -0.045, -0.055, -0.065,
  -0.035, -0.050, -0.062, -0.072,
  -0.030, -0.045, -0.056, -0.065,
  -0.025, -0.038, -0.046, -0.054,
];

export interface HandPoseOptions {
  /** Where landmark 9 lands: normalized image coordinates, unmirrored like MediaPipe output. */
  anchor: { x: number; y: number };
  /** Mean wrist→MCP(5,9,13,17) distance in ih with relative z, as the extractor measures it. */
  palmSize?: number;
  /** Rotation about the wrist in the image plane, radians; positive tips the fingers toward the image's right. */
  tilt?: number;
  /**
   * Shift of every landmark's z except the wrist's (MediaPipe's z is relative to the wrist, so
   * this is what a depth error of the whole hand looks like), image-width units.
   */
  zOffset?: number;
  /** Right: thumb toward the image's right (palm toward the camera, unmirrored image). Left: mirrored. */
  handedness?: 'Left' | 'Right';
}

/** Mean norm of the MCPs in ih for a unit palm scale: relates the template to the palm size it yields. */
const TEMPLATE_PALM_NORM = (() => {
  let sum = 0;
  for (const i of MCP_INDICES) {
    const [u, v] = TEMPLATE_UV[i];
    sum += Math.hypot(u, v, (TEMPLATE_Z[i] * IMAGE_ASPECT) / REFERENCE_PALM_SIZE);
  }
  return sum / MCP_INDICES.length;
})();

/** ih per palm unit such that the hand's measured palm size equals the requested one. */
function scaleFor(palmSize: number): number {
  return palmSize / TEMPLATE_PALM_NORM;
}

function rotated(u: number, v: number, tilt: number, flip: number): readonly [number, number] {
  // Tipping fingers toward image-right is a clockwise turn with v up: u' = u·cos + v·sin.
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const fu = u * flip;
  return [fu * c + v * s, -fu * s + v * c];
}

/**
 * Offset from the wrist to landmark 9 in ih, in the unmirrored image axes (x right, y down).
 * Tilting a hand about its wrist moves its anchor along an arc of this radius; the generator
 * uses it to keep the wrist still while the anchor swings.
 */
export function wristToAnchor(palmSize: number, tilt = 0, handedness: 'Left' | 'Right' = 'Right'): readonly [number, number] {
  const k = scaleFor(palmSize);
  const [u, v] = TEMPLATE_UV[ANCHOR_INDEX];
  const [ru, rv] = rotated(u, v, tilt, handedness === 'Left' ? -1 : 1);
  return [ru * k, -rv * k];
}

/** A plausible 21-landmark hand with landmark 9 exactly on `anchor`. No noise: callers add it. */
export function buildHand(options: HandPoseOptions): HandDetection {
  const palmSize = options.palmSize ?? DEFAULT_PALM_SIZE;
  const tilt = options.tilt ?? 0;
  const zOffset = options.zOffset ?? 0;
  const handedness = options.handedness ?? 'Right';
  const flip = handedness === 'Left' ? -1 : 1;
  const k = scaleFor(palmSize);
  // z scales with the same factor as x and y (all three share k), or the measured palm size drifts.
  const zScale = k / REFERENCE_PALM_SIZE;

  const [ox, oy] = wristToAnchor(palmSize, tilt, handedness);
  const wristX = options.anchor.x - ox / IMAGE_ASPECT;
  const wristY = options.anchor.y - oy;

  const landmarks: Landmark[] = TEMPLATE_UV.map(([u, v], i) => {
    const [ru, rv] = rotated(u, v, tilt, flip);
    return {
      x: wristX + (ru * k) / IMAGE_ASPECT,
      y: wristY - rv * k,
      z: i === 0 ? 0 : TEMPLATE_Z[i] * zScale + zOffset,
    };
  });
  return { landmarks, handedness };
}
