import type { HandFrame, HandDetection, Landmark, MappedHand, Vec3 } from '../shared/contracts';
import { OneEuroFilter } from './OneEuro';

/** Frames are resized to 640×480 before inference; landmark x and z are in image-width units. */
const ASPECT = 4 / 3;
/**
 * World length of the mean wrist→knuckle distance. Keeps the virtual hand one size at any
 * camera distance. Deliberately ~1.6× a real hand: next to a 36 cm ball, life-size hands
 * felt like fingertips poking a boulder and were hard to aim.
 */
const HAND_WORLD_SIZE = 0.15;
/** Metres of studio per full image width / height for the wrist position. */
const X_GAIN = 1.0;
const Y_GAIN = 0.8;
/**
 * Depth from apparent hand size: z = calibrationDepth − DEPTH_GAIN·ln(size/calibrationSize).
 * Gentle on purpose (depth was making every gesture harder): with the depth assist in
 * HandInteraction, ~5–8% closer to the webcam (≈3–4 cm at arm's length) sets the hand on the
 * clay's front face; ~40% closer reaches its centre.
 */
const DEPTH_GAIN = 0.8;
const DEPTH_MIN = -0.24;
const DEPTH_MAX = 0.42;
/**
 * MediaPipe per-landmark z relative to the wrist (fingers pointing at the camera go deeper).
 * Kept low: it is the noisiest coordinate and made finger depths disagree during a pinch.
 */
const RELATIVE_Z_GAIN = 0.35;
const STALE_TRACK_MS = 200;
const FRESH_MS = 180;

export interface Calibration {
  centerX: number;
  centerY: number;
  /** Apparent palm size at calibration; adopted from the first frame when absent. */
  palmSize?: number;
  /** Studio height of the wrist at the calibrated pose. */
  wristY: number;
  /** Studio depth of the wrist at the calibrated pose; in front of the clay so a resting hand never touches. */
  depth: number;
}

interface Track { id: string; wrist: Vec3; handedness: HandDetection['handedness']; points: Vec3[]; velocities: Vec3[]; lastMs: number; pointFilter: OneEuroFilter; sizeFilter: OneEuroFilter }

/**
 * 1€ settings. Points: steady at rest (1.2 Hz), ~+15 Hz per m/s so a quick move keeps up.
 * Apparent size (log units) drives depth and is the noisiest signal: smoothed harder.
 */
const pointFilter = () => new OneEuroFilter(63, 1.2, 15, 2);
const sizeFilter = () => new OneEuroFilter(1, 0.6, 4, 1);

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const zero: Vec3 = [0, 0, 0];

/** Mean wrist→knuckle length in image-height units, using MediaPipe's relative z so tilting the hand barely changes it. */
export function palmSize(landmarks: readonly Landmark[]): number {
  const w = landmarks[0];
  let sum = 0;
  for (const i of [5, 9, 13, 17]) {
    const p = landmarks[i];
    sum += Math.hypot((p.x - w.x) * ASPECT, p.y - w.y, (p.z - w.z) * ASPECT);
  }
  return sum / 4;
}

/**
 * Maps normalized screen landmarks into bounded studio space. Mirroring happens exactly once here:
 * screen x grows right, studio x grows left, so the user's right hand appears on the right.
 * Monocular depth is heuristic (apparent hand size), not a metric reconstruction.
 */
export class HandMapper {
  private tracks = new Map<string, Track>();
  private nextId = 1;
  private lastFrameMs = -Infinity;
  calibration: Calibration = { centerX: 0.5, centerY: 0.5, wristY: 0.1, depth: 0.32 };

  calibrate(frame: HandFrame, options: Partial<Pick<Calibration, 'wristY' | 'depth'>> = {}) {
    const hands = frame.hands.filter(h => h.landmarks.length === 21);
    if (!hands.length) return false;
    const wrists = hands.map(h => h.landmarks[0]);
    this.calibration = {
      centerX: wrists.reduce((a, p) => a + p.x, 0) / wrists.length,
      centerY: wrists.reduce((a, p) => a + p.y, 0) / wrists.length,
      palmSize: hands.reduce((a, h) => a + palmSize(h.landmarks), 0) / hands.length,
      wristY: options.wristY ?? 0.1,
      depth: options.depth ?? 0.32,
    };
    return true;
  }

  reset() { this.tracks.clear(); this.lastFrameMs = -Infinity; }

  /** Studio depth of the wrist for a given apparent palm size. */
  depthFor(size: number) {
    const reference = this.calibration.palmSize ?? size;
    return clamp(this.calibration.depth - DEPTH_GAIN * Math.log(size / reference), DEPTH_MIN, DEPTH_MAX);
  }

  private mapHand(landmarks: readonly Landmark[], size: number): Vec3[] {
    const c = this.calibration, w = landmarks[0];
    const depth = this.depthFor(size);
    const wx = clamp((c.centerX - w.x) * X_GAIN, -0.6, 0.6);
    const wy = clamp(c.wristY + (c.centerY - w.y) * Y_GAIN, 0.02, 0.8);
    const k = HAND_WORLD_SIZE / size;
    return landmarks.map(p => [
      wx - (p.x - w.x) * ASPECT * k,
      Math.max(0.008, wy - (p.y - w.y) * k),
      depth + (p.z - w.z) * ASPECT * k * RELATIVE_Z_GAIN,
    ] as Vec3);
  }

  consume(frame: HandFrame): MappedHand[] {
    if (frame.timestampMs <= this.lastFrameMs) return [];
    this.lastFrameMs = frame.timestampMs;
    for (const [id, t] of this.tracks) if (frame.timestampMs - t.lastMs > STALE_TRACK_MS) this.tracks.delete(id);
    const used = new Set<string>();
    const mapped: MappedHand[] = [];
    for (const hand of frame.hands.slice(0, 2)) {
      if (hand.landmarks.length !== 21 || hand.landmarks.some(p => !Number.isFinite(p.x + p.y + p.z))) continue;
      const size = palmSize(hand.landmarks);
      if (!(size > 0.01)) continue;
      if (this.calibration.palmSize === undefined) this.calibration.palmSize = size;
      const rawWrist = this.mapHand(hand.landmarks, size)[0];
      const candidates = [...this.tracks.values()]
        .filter(t => !used.has(t.id) && (t.handedness === hand.handedness || t.handedness === 'Unknown' || hand.handedness === 'Unknown'))
        .map(t => ({ track: t, cost: distance(rawWrist, t.wrist) }))
        .sort((a, b) => a.cost - b.cost);
      if (candidates.length > 1 && candidates[0].cost < 0.16 && candidates[1].cost - candidates[0].cost < 0.035) {
        // Ambiguous crossing: suspend both old anchors rather than silently transfer them.
        this.tracks.delete(candidates[0].track.id);
        this.tracks.delete(candidates[1].track.id);
        continue;
      }
      const best = candidates[0]?.cost <= 0.16 ? candidates[0].track : undefined;
      const id = best?.id ?? `hand-${this.nextId++}`;

      // Size is filtered first (in log space) because it sets the depth of every point.
      const filters = best ? { pointFilter: best.pointFilter, sizeFilter: best.sizeFilter } : { pointFilter: pointFilter(), sizeFilter: sizeFilter() };
      const logSize = filters.sizeFilter.filter([Math.log(size)], frame.timestampMs)[0];
      const raw = this.mapHand(hand.landmarks, Math.exp(logSize));
      const flat = filters.pointFilter.filter(raw.flat(), frame.timestampMs);
      const points = raw.map((_, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]] as Vec3);
      const dt = best ? Math.max(1 / 120, (frame.timestampMs - best.lastMs) / 1000) : 0;
      const velocities: Vec3[] = points.map((p, i) => {
        if (!best || dt > 0.18) return zero;
        const q = best.points[i];
        const vx = (p[0] - q[0]) / dt, vy = (p[1] - q[1]) / dt, vz = (p[2] - q[2]) / dt;
        const scale = Math.min(1, 1.4 / (Math.hypot(vx, vy, vz) || 1));
        return [vx * scale, vy * scale, vz * scale];
      });
      this.tracks.set(id, { id, wrist: points[0], handedness: hand.handedness, points, velocities, lastMs: frame.timestampMs, ...filters });
      used.add(id);
      mapped.push({ id, timestampMs: frame.timestampMs, points, velocities, handedness: hand.handedness, state: 'free' });
    }
    // A hand missing from a new frame is released immediately.
    for (const id of this.tracks.keys()) if (!used.has(id)) this.tracks.delete(id);
    return mapped;
  }

  /** Hands still fresh enough to apply forces; velocities decay so stale motion cannot fling the clay. */
  fresh(nowMs: number): MappedHand[] {
    const out: MappedHand[] = [];
    for (const t of this.tracks.values()) {
      if (nowMs - t.lastMs > FRESH_MS) continue;
      const decay = Math.exp(-Math.max(0, nowMs - t.lastMs) / 65);
      out.push({ id: t.id, timestampMs: t.lastMs, points: t.points, velocities: t.velocities.map(v => [v[0] * decay, v[1] * decay, v[2] * decay] as Vec3), handedness: t.handedness, state: 'free' });
    }
    return out;
  }
}
