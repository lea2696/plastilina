import type { HandBasis, HandCollider, InteractionFrame, MappedHand, Vec3 } from '../shared/contracts';
import { depthToSurface, surfaceDistance } from './surfaceDistance';

const FRESH_MS = 180;
// Radii match the enlarged virtual hand (HAND_WORLD_SIZE in HandMapper).
const TIP_RADIUS = 0.032;
const SEGMENT_RADIUS = 0.026;
/** Grip volumes: material inside is held. Acquired only when the grip point is this close to the surface. */
const PINCH_RADIUS = 0.08;
const FIST_RADIUS = 0.11;
/**
 * Grab intent (a pinch or fist closing) widens the depth assist: a closing hand up to
 * GRAB_ASSIST_TOUCH in front of the clay is set on it, so a grab does not depend on
 * judging monocular depth. The hand moves to the clay, never the clay to the hand.
 */
const GRAB_ASSIST_TOUCH = 0.15;
const GRAB_ASSIST_RANGE = 0.22;
/** An opening hand must stay open this long before the grip lets go (tracking flicker). */
const RELEASE_MS = 150;
/** Distance at which a hand starts to light up as it approaches the clay. */
const PROXIMITY_RANGE = 0.16;
/**
 * Depth assist. Monocular depth is the hard axis, so a hand whose fingertips are
 * within ASSIST_TOUCH in front of the clay is set down on its surface (touching, through
 * the solver's friction skin, but not pressing); the help fades out by ASSIST_RANGE.
 * Only the virtual hand moves, never the clay, and only along the view depth.
 */
const ASSIST_TOUCH = 0.045;
const ASSIST_RANGE = 0.11;
/** Stop this short of the surface: inside the 4 mm friction skin, outside the push radius. */
const ASSIST_HOVER = 0.002;

const FINGER_CHAINS: ReadonlyArray<readonly number[]> = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const TIPS = [4, 8, 12, 16, 20];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const average = (...points: Vec3[]): Vec3 => {
  const s = [0, 0, 0];
  for (const p of points) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  return [s[0] / points.length, s[1] / points.length, s[2] / points.length];
};
const zero: Vec3 = [0, 0, 0];

/** Broad palm frame (not the noisy thumb-index gap) so a held patch twists with the hand. */
export function palmBasis(points: readonly Vec3[]): HandBasis | undefined {
  const width = distance(points[5], points[17]);
  if (width < 0.015) return;
  const x: Vec3 = [(points[5][0] - points[17][0]) / width, (points[5][1] - points[17][1]) / width, (points[5][2] - points[17][2]) / width];
  const up: Vec3 = [points[9][0] - points[0][0], points[9][1] - points[0][1], points[9][2] - points[0][2]];
  const along = up[0] * x[0] + up[1] * x[1] + up[2] * x[2];
  const perpendicular: Vec3 = [up[0] - along * x[0], up[1] - along * x[1], up[2] - along * x[2]];
  const length = Math.hypot(...perpendicular);
  if (length < 0.015) return;
  const y: Vec3 = [perpendicular[0] / length, perpendicular[1] / length, perpendicular[2] / length];
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x, y, z];
}

/** Number of long fingers (index..pinky) curled towards the palm. */
function curledFingers(points: readonly Vec3[]) {
  let curled = 0;
  for (const tip of [8, 12, 16, 20]) if (distance(points[tip], points[0]) < distance(points[tip - 3], points[0]) * 1.25) curled++;
  return curled;
}

/**
 * A held grip remembers how closed the hand was when it took the clay (Meta's TouchHandGrab
 * caches the finger–thumb distance): it lets go when the hand opens clearly beyond that,
 * not at a fixed threshold, so loose and tight grips both release on a deliberate opening.
 */
interface GraspState { mode: 'pinch' | 'fist'; finger: number; gapAtGrab: number; curledAtGrab: number }
/** How much wider than at grab time the pinch must open to release. */
const RELEASE_OPENING = 0.03;

const PALM_POINTS = [0, 5, 9, 13, 17];
const palmRadiusFor = (points: readonly Vec3[]) => clamp(clamp(distance(points[5], points[17]), 0.06, 0.2) * 0.34, 0.03, 0.06);
/** Largest solid radius around each landmark (tip sphere, finger capsule or palm capsule). */
function landmarkRadius(i: number, palmRadius: number) {
  return PALM_POINTS.includes(i) ? palmRadius : TIPS.includes(i) ? TIP_RADIUS : SEGMENT_RADIUS;
}

/** Sample spheres covering the hand's solid parts: landmarks plus finger and palm capsule midpoints. */
function solidProbes(points: readonly Vec3[]): Array<{ point: Vec3; radius: number }> {
  const palmRadius = palmRadiusFor(points);
  const probes = points.map((point, i) => ({ point, radius: landmarkRadius(i, palmRadius) }));
  for (const chain of FINGER_CHAINS) for (let k = 0; k < chain.length - 1; k++) probes.push({ point: average(points[chain[k]], points[chain[k + 1]]), radius: SEGMENT_RADIUS });
  probes.push({ point: average(points[5], points[17]), radius: palmRadius });
  probes.push({ point: average(points[0], points[5], points[17]), radius: palmRadius });
  return probes;
}

/** Thumb-to-finger gap with view depth down-weighted: monocular finger z is too noisy to judge a pinch. */
const pinchGap = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] - b[2]) * 0.4);

/**
 * How far to move a hand along −z so its nearest solid part rests on the clay. The view-depth ray
 * gives the first estimate; true surface distance then backs it off on the curved flanks, where
 * a sphere touches sideways before its depth ray does. Keeping a hover gap (no push) also stops
 * a resting hand from creeping into its own dent frame after frame.
 */
function assistOffset(points: readonly Vec3[], surface: Float32Array, indices: Uint32Array, touch = ASSIST_TOUCH, range = ASSIST_RANGE) {
  const probes = solidProbes(points);
  let gap = Infinity;
  for (const { point, radius } of probes) {
    const depth = depthToSurface(point, surface, indices);
    if (depth < 0) return 0; // already inside the clay: the user is pressing, no help needed
    gap = Math.min(gap, depth - radius);
  }
  if (!(gap > ASSIST_HOVER) || gap >= range) return 0;
  let offset = gap <= touch ? gap - ASSIST_HOVER : (touch - ASSIST_HOVER) * (range - gap) / (range - touch);
  for (let round = 0; round < 4 && offset > 0; round++) {
    let clearance = Infinity;
    for (const { point, radius } of probes) clearance = Math.min(clearance, surfaceDistance([point[0], point[1], point[2] - offset], surface, indices) - radius);
    if (clearance >= ASSIST_HOVER) break;
    offset = Math.max(0, offset - (ASSIST_HOVER - clearance) * 1.5);
  }
  return offset;
}

/**
 * Turns tracked hands into solver colliders. Two ways to hold clay:
 *  - pinch: thumb against index, middle or ring finger, close to the surface;
 *  - fist: three or more fingers curled while the hand is on the clay (whole-hand grab).
 * A grip is acquired only next to the surface (never at distance), keeps its mode
 * and finger while held, and releases when the hand opens or the signal goes stale.
 * Fingers doing the holding stop being solid so they do not push away what they hold.
 */
export class HandInteraction {
  private grasps = new Map<string, GraspState>();
  private assists = new Map<string, number>();
  private openSince = new Map<string, number>();

  reset() { this.grasps.clear(); this.assists.clear(); this.openSince.clear(); }
  isGrasping(handId: string) { return this.grasps.has(handId); }
  graspFingers(handId: string): number[] {
    const g = this.grasps.get(handId);
    return !g ? [] : g.mode === 'pinch' ? [4, g.finger] : TIPS;
  }

  build(timestampMs: number, hands: readonly MappedHand[], surface: Float32Array, indices?: Uint32Array): InteractionFrame {
    const colliders: HandCollider[] = [];
    const states: MappedHand[] = [];
    for (const id of this.grasps.keys()) if (!hands.some(h => h.id === id)) this.grasps.delete(id);
    for (const id of this.assists.keys()) if (!hands.some(h => h.id === id)) this.assists.delete(id);
    for (const original of hands) {
      if (timestampMs - original.timestampMs > FRESH_MS) { this.grasps.delete(original.id); this.assists.delete(original.id); this.openSince.delete(original.id); continue; }
      // A held grip keeps its current assist so lifting or pulling does not change depth under it.
      // A closing hand (grab intent) gets the wider assist. Distances are unaffected by the shift.
      const previousAssist = this.assists.get(original.id) ?? 0;
      const o = original.points;
      const closing = Math.min(...[8, 12, 16].map(f => pinchGap(o[4], o[f]))) < clamp(distance(o[5], o[17]), 0.06, 0.2) * 0.85 || curledFingers(o) >= 2;
      const target = this.grasps.has(original.id) || !indices ? previousAssist
        : closing ? assistOffset(o, surface, indices, GRAB_ASSIST_TOUCH, GRAB_ASSIST_RANGE) : assistOffset(o, surface, indices);
      const assist = previousAssist + (target - previousAssist) * 0.5;
      this.assists.set(original.id, assist);
      const hand: MappedHand = assist > 1e-4 ? { ...original, points: original.points.map(q => [q[0], q[1], q[2] - assist] as Vec3) } : original;
      const p = hand.points;
      const near = (point: Vec3) => surfaceDistance(point, surface, indices);
      // A grip point already inside the clay (fingers sunk in) counts as on it.
      const onClay = (point: Vec3, radius: number) => (!!indices && depthToSurface(point, surface, indices) < 0) || near(point) < radius;
      const speed = (i: number) => hand.velocities?.[i] ?? zero;
      const width = clamp(distance(p[5], p[17]), 0.06, 0.2);
      const thumb = p[4], previous = this.grasps.get(hand.id);
      const finger = previous?.mode === 'pinch' ? previous.finger : [8, 12, 16].sort((a, b) => pinchGap(thumb, p[a]) - pinchGap(thumb, p[b]))[0];
      const gap = pinchGap(thumb, p[finger]);
      const pinchClose = clamp(width * 0.5, 0.035, 0.08), pinchOpen = clamp(width * 0.85, 0.06, 0.12);
      const curled = curledFingers(p);
      const pinchPoint = average(thumb, p[finger]);
      const fistPoint = average(p[4], p[8], p[12], p[16], p[20], p[5], p[9], p[13], p[17]);

      let grasp: GraspState | undefined;
      if (previous) {
        const stillClosed = previous.mode === 'pinch' ? gap < previous.gapAtGrab + RELEASE_OPENING : curled >= Math.max(1, previous.curledAtGrab - 2);
        if (stillClosed) this.openSince.delete(hand.id);
        else if (!this.openSince.has(hand.id)) this.openSince.set(hand.id, timestampMs);
        // Hold through brief flicker; let go once the hand has stayed open for RELEASE_MS.
        grasp = stillClosed || timestampMs - this.openSince.get(hand.id)! < RELEASE_MS ? previous : undefined;
      } else if (gap < pinchClose && onClay(pinchPoint, PINCH_RADIUS)) grasp = { mode: 'pinch', finger, gapAtGrab: gap, curledAtGrab: curled };
      else if (curled >= 3 && onClay(fistPoint, FIST_RADIUS)) grasp = { mode: 'fist', finger, gapAtGrab: gap, curledAtGrab: curled };
      if (grasp) this.grasps.set(hand.id, grasp);
      else { this.grasps.delete(hand.id); this.openSince.delete(hand.id); }

      const holding = new Set<number>();
      if (grasp?.mode === 'pinch') for (const chain of [FINGER_CHAINS[0], FINGER_CHAINS[[8, 12, 16].indexOf(grasp.finger) + 1]]) for (const i of chain) holding.add(i);
      const solid = grasp?.mode !== 'fist';
      if (solid) {
        for (const tip of TIPS) {
          if (holding.has(tip)) continue;
          colliders.push({ id: `${hand.id}-tip-${tip}`, kind: 'tip', center: p[tip], radius: TIP_RADIUS, velocity: speed(tip), handId: hand.id, landmarks: [tip] });
        }
        for (const chain of FINGER_CHAINS) for (let k = 0; k < chain.length - 1; k++) {
          const a = chain[k], b = chain[k + 1];
          if (holding.has(b)) continue;
          colliders.push({ id: `${hand.id}-segment-${a}-${b}`, kind: 'segment', center: p[a], end: p[b], radius: SEGMENT_RADIUS, velocity: average(speed(a), speed(b)), handId: hand.id, landmarks: [a, b] });
        }
        // Two overlapping capsules fill a palm (a sphere only makes a central dimple);
        // they also transmit lateral rolling and kneading through friction.
        const knuckles = average(p[5], p[17]);
        const palmRadius = palmRadiusFor(p);
        const palmLandmarks = [0, 5, 9, 13, 17];
        colliders.push({ id: `${hand.id}-palm`, kind: 'palm', center: p[5], end: p[17], radius: palmRadius, velocity: average(speed(5), speed(17)), handId: hand.id, landmarks: palmLandmarks });
        colliders.push({ id: `${hand.id}-palm-heel`, kind: 'palm', center: p[0], end: knuckles, radius: palmRadius, velocity: average(speed(0), speed(5), speed(17)), handId: hand.id, landmarks: palmLandmarks });
      }
      if (grasp) {
        const pinch = grasp.mode === 'pinch';
        colliders.push({
          id: `${hand.id}-grasp`,
          kind: 'tip',
          center: pinch ? pinchPoint : fistPoint,
          radius: pinch ? PINCH_RADIUS : FIST_RADIUS,
          velocity: pinch ? average(speed(4), speed(grasp.finger)) : average(speed(0), speed(9)),
          grasp: true,
          basis: palmBasis(p),
          gripStrength: pinch ? 0.65 + 0.35 * clamp(1 - gap / pinchOpen, 0, 1) : 1,
          handId: hand.id,
          landmarks: pinch ? [4, grasp.finger] : TIPS,
        });
      }
      const closest = Math.min(...TIPS.map(i => near(p[i])), near(average(p[0], p[9])));
      states.push({ ...hand, proximity: clamp(1 - closest / PROXIMITY_RANGE, 0, 1), state: grasp ? 'grasp' : closest < TIP_RADIUS + 0.004 ? 'contact' : 'free' });
    }
    return { timestampMs, colliders, hands: states };
  }
}
