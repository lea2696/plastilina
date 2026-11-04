import type { HandFrame } from '../../shared/contracts';
import type { Preset, YoyoConfig } from '../config';
import type { FramingGuide, Vec2 } from '../contracts';
import { mappingFromHome, toWorld } from '../perception/worldMapping';
import { zoneCentre, type TetherZone } from './TetherDetector';

/** Camera frames are 640×480: image width is 4/3 image heights (ih). */
const IMAGE_ASPECT = 4 / 3;

/**
 * How long the guided framing waits for the yoyo to tie on before it gives up and ties on wherever the
 * hand is (PRD §3.2: «~10 s, omitible»). A person who cannot or will not follow the outline is not
 * stuck on a screen that asks for the impossible.
 */
export const FRAMING_TIMEOUT_MS = 10_000;

/**
 * Half-size of the zone the anchor (middle-finger knuckle) must be in for the yoyo to tie on, ih.
 * Wider than tall on purpose: the hand has room to settle left or right of centre, but vertically it
 * must stay where a throw (about 0.3 ih down from the anchor) still fits inside the frame together
 * with the wrist, which sits ~0.17 ih below the anchor (PRD risk 3: throwing downward takes the
 * hand out of view).
 */
export const ZONE_HALF_SIZE: Vec2 = [0.22, 0.14];

/**
 * Where the anchor rests, ih. x is the middle of a 4:3 frame (2/3 ih). y:
 * - De pie: 0.40, a hand held up in front of a laptop camera. The stroke has 0.6 ih below it.
 * - Sentado, antebrazo apoyado: 0.60, lower, because the elbow rests on the desk and the hand cannot
 *   rise as high. The strokes of this preset are smaller (config.ts scales them by 0.7), so the same
 *   room below is enough.
 */
const ZONE_CENTRE: Readonly<Record<Preset, Vec2>> = {
  standing: [IMAGE_ASPECT / 2, 0.4],
  seated: [IMAGE_ASPECT / 2, 0.6],
};

/** The tie-on zone of a preset, in image space (ih). */
export function framingZone(preset: Preset): TetherZone {
  const [cx, cy] = ZONE_CENTRE[preset];
  const [hx, hy] = ZONE_HALF_SIZE;
  return { x0: cx - hx, y0: cy - hy, x1: cx + hx, y1: cy + hy };
}

/**
 * The zone as the renderer draws it: world centre and half-size in metres, through the very mapping the
 * runtime uses while the zone is set (the zone's centre is the world home, `YoyoRuntime.setTetherZone`).
 * So the outline sits exactly where the hand will be drawn when its anchor is in the zone.
 */
export function guideForZone(config: YoyoConfig, zone: TetherZone): FramingGuide {
  const centre = zoneCentre(zone);
  const mapping = mappingFromHome(config, centre);
  const world = toWorld(mapping, centre[0], centre[1]);
  return {
    center: [world[0], world[1]],
    halfSize: [((zone.x1 - zone.x0) / 2) * mapping.scale, ((zone.y1 - zone.y0) / 2) * mapping.scale],
  };
}

/** What the camera saw of the hand: kept only in memory, only for the diagnostics panel. */
export interface HandMeasure {
  /** Mean wrist→knuckle distance, ih (the extractor's «palm size»). */
  palmSize: number;
  /** Height of the anchor, ih from the top of the frame. */
  anchorY: number;
}

const ANCHOR = 9;
const WRIST = 0;
const KNUCKLES = [5, 9, 13, 17] as const;
const LANDMARKS = 21;

/**
 * Palm size and anchor height of the biggest hand in a frame, measured like AnchorExtractor does (z
 * included, so tilting the hand barely changes it); null when there is no usable hand. Not used for
 * any decision: the UI shows nothing technical during framing, and thresholds come from the config.
 */
export function measureHand(frame: HandFrame): HandMeasure | null {
  let best: HandMeasure | null = null;
  for (const hand of frame.hands) {
    const lm = hand.landmarks;
    if (lm.length !== LANDMARKS) continue;
    const w = lm[WRIST];
    let sum = 0;
    for (const i of KNUCKLES) sum += Math.hypot((lm[i].x - w.x) * IMAGE_ASPECT, lm[i].y - w.y, (lm[i].z - w.z) * IMAGE_ASPECT);
    const palmSize = sum / KNUCKLES.length;
    const anchorY = lm[ANCHOR].y;
    if (!Number.isFinite(palmSize + anchorY)) continue;
    if (best === null || palmSize > best.palmSize) best = { palmSize, anchorY };
  }
  return best;
}
