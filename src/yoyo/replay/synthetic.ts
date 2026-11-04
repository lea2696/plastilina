import type { HandDetection, HandFrame, Landmark } from '../../shared/contracts';
import type { ArmedIntents, IntentKind, Vec2 } from '../contracts';
import { buildHand, DEFAULT_PALM_SIZE, IMAGE_ASPECT, wristToAnchor } from './handPose';
import { Random } from './random';

/**
 * Synthetic HandFrame replays with the noise of PRD_YOYO.md §8.2: canonical launch and tug
 * curves sampled at 30 fps with random phase, 50 ms of tracking delay, Gaussian jitter, dropped
 * frames, exits through the bottom and a zoo of non-events. Everything is seeded: the same seed
 * gives the same corpus bit for bit, so a failing clip can be named and reproduced.
 *
 * Gestures are noise-free anchor paths in mirrored image space (ih, x right, y down), the same
 * space the classifiers see. Ground truth comes from the path itself, not from the classifier:
 * `onsetMs` is the first instant the true speed along the gesture reaches 50 % of its peak.
 */

export const FRAME_MS = 1000 / 30;

export type ClipKind = 'launch' | 'tug' | 'non-event' | 'long' | 'stress';

/** Ground truth of one gesture, capture-time ms. */
export interface GestureLabel {
  kind: IntentKind;
  /** First instant the noise-free speed along the gesture reaches 50 % of its peak (the Y-S2 reference). */
  onsetMs: number;
  /** Same for 10 % of the peak: how early the first perceptible motion was. */
  onset10Ms: number;
  /** The path starts to move. */
  motionStartMs: number;
  /** Peak noise-free speed along the gesture, ih/s. */
  peakSpeed: number;
}

export interface DeliveredFrame {
  frame: HandFrame;
  arrivalMs: number;
}

/** One instant of a noise-free anchor path: capture time (ms) and mirrored image position (ih). */
export interface CleanSample {
  t: number;
  x: number;
  y: number;
}

export interface SyntheticClip {
  id: string;
  kind: ClipKind;
  armed: ArmedIntents;
  /** Frames in arrival order, exactly as the camera path would deliver them (dropped frames are absent). */
  frames: DeliveredFrame[];
  labels: GestureLabel[];
  /**
   * The noise-free anchor at every slot of the clip's own 30 fps grid, slots whose frame was
   * dropped included: same timestamps (jitter and all) as the delivered frames, but no landmark
   * noise, no drops, no glitches. This is what the Y-S1 consistency oracle (evaluate.ts) reads.
   */
  clean: CleanSample[];
  /** What the clip contains and which accidents it suffered; for diagnosing a failing case. */
  tags: string[];
  durationMs: number;
  /** Peak speed of the fastest casual (unlabelled) motion, ih/s; set on non-event and stress clips. */
  casualPeak?: number;
  /** Time spans of the casual parts (non-event and stress clips), to attribute a false trigger to what the hand was doing. */
  segments?: Segment[];
}

/** One casual action of a non-event clip and when it happened. */
export interface Segment {
  tag: string;
  startMs: number;
  endMs: number;
  /** Peak speed of the motion, ih/s, when it has one. */
  peak?: number;
}

export interface Corpus {
  seed: number;
  /** Movement scale the scenes were performed at (1 standing; 0.7 for the seated preset). */
  amplitude: number;
  launch: SyntheticClip[];
  tug: SyntheticClip[];
  nonEvent: SyntheticClip[];
  long: SyntheticClip[];
  /** Informational: faster casual motions that show where the decision boundary lies. Never gates. */
  stress: SyntheticClip[];
}

// ---------------------------------------------------------------------------------------------
// Noise model (PRD §8.2). Normalized x is a fraction of the image width, normalized y of its height.
// ---------------------------------------------------------------------------------------------

const TIMESTAMP_JITTER_MS = 2;
const TRACKING_LATENCY_MS = 50;
const ARRIVAL_SPREAD_MS = 10;
/** Hand-level jitter: σ = 0.5 % of the image width, in both axes (y scaled by 4/3 to the same length). */
const COMMON_JITTER = 0.005;
/** Extra independent jitter per landmark: σ = 0.15 % of the image width. */
const LANDMARK_JITTER = 0.0015;
/** Multiplicative palm-size jitter about the wrist: σ = 2 %. */
const PALM_JITTER = 0.02;
/** MediaPipe's z is the noisiest coordinate: per-landmark noise and a whole-hand depth wobble. */
const Z_JITTER = 0.008;
const Z_COMMON_JITTER = 0.01;
const DROP_PROBABILITY = 0.03;
/** Chance per delivered frame that a burst of two consecutive frames is lost on top of the iid drops. */
const BURST_PROBABILITY = 0.01;
/** The hand is not detected once the anchor passes this normalized y, or the wrist passes the second. */
const EXIT_ANCHOR_Y = 0.97;
const EXIT_WRIST_Y = 1.02;

/** Glitch magnitudes: anchor jumps (ih), palm-size spikes (fraction) and whole-hand z jumps. */
const GLITCH_JUMP = [0.15, 0.3] as const;
const GLITCH_PALM = 0.3;
const GLITCH_Z = [0.04, 0.09] as const;
/**
 * Glitches never land inside [motionStart − 100 ms, onset + 160 ms] of a labelled gesture: a
 * glitch there is indistinguishable from losing the frame that carried the gesture, and would
 * blame the detector for latency that no detector can recover.
 */
const GLITCH_GUARD_BEFORE_MS = 100;
const GLITCH_GUARD_AFTER_MS = 160;

// ---------------------------------------------------------------------------------------------
// Smooth profiles
// ---------------------------------------------------------------------------------------------

/** 3u² − 2u³ and its integral u³ − u⁴/2: the speed ramp and the distance covered while ramping. */
const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const smoothstepIntegral = (u: number) => (u <= 0 ? 0 : u >= 1 ? 0.5 : u * u * u - (u * u * u * u) / 2);
/** Minimum-jerk point-to-point position (0 → 1) and speed (peak 1.875 at the midpoint). */
const minJerk = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));
const minJerkSpeed = (u: number) => (u <= 0 || u >= 1 ? 0 : 30 * u * u * (1 - u) * (1 - u));
const MIN_JERK_PEAK = 1.875;

/** Smallest u in [lo, hi] where the increasing function f reaches `target` (bisection). */
function firstReach(f: (u: number) => number, lo: number, hi: number, target: number): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------------------------
// Motion primitives: displacement of the noise-free anchor from where the motion starts
// ---------------------------------------------------------------------------------------------

/**
 * A displacement of the anchor over time, in ih, relative to its rest position: zero before
 * `startMs`, and after `endMs` either back to zero (oscillations) or held at its final value
 * (strokes, flicks, moves). Motions add up, see `sumOffsets`, which is how a Scene's `anchorAt`
 * is composed.
 */
export interface Motion {
  offset: (tMs: number) => Vec2;
  startMs: number;
  endMs: number;
}

/**
 * Instants of a speed profile with a known peak, for ground truth: when the noise-free speed
 * first reaches 50 % and 10 % of the peak. `labelOf` turns them into a GestureLabel.
 */
export interface Timing {
  onsetMs: number;
  onset10Ms: number;
  peakSpeed: number;
}

const scaled = (d: Vec2, k: number): Vec2 => [d[0] * k, d[1] * k];

/** Unit vector `deg` away from vertical toward the right; `up` flips it to point up the image. */
function vertical(deg: number, up: boolean): Vec2 {
  const a = (deg * Math.PI) / 180;
  return [Math.sin(a), up ? -Math.cos(a) : Math.cos(a)];
}

/**
 * Launch stroke: speed ramps up with a smoothstep over `riseMs`, holds `peak` ih/s for
 * `plateauMs` and ramps down over `fallMs`, along the unit vector `dir` (mirrored ih axes: x
 * right, y down). Closed-form distance, so ground truth involves no sampling; the returned
 * Timing carries the onsets for `labelOf`.
 */
export function stroke(startMs: number, riseMs: number, plateauMs: number, fallMs: number, peak: number, dir: Vec2): Motion & Timing {
  const distance = (tMs: number) => {
    const t = tMs - startMs;
    if (t <= 0) return 0;
    if (t <= riseMs) return (peak * riseMs * smoothstepIntegral(t / riseMs)) / 1000;
    if (t <= riseMs + plateauMs) return (peak * (0.5 * riseMs + (t - riseMs))) / 1000;
    const w = Math.min(1, (t - riseMs - plateauMs) / fallMs);
    // Falling: speed = peak·(1 − smoothstep(w)), whose integral is w − (w³ − w⁴/2).
    return (peak * (0.5 * riseMs + plateauMs + fallMs * (w - (w * w * w - (w * w * w * w) / 2)))) / 1000;
  };
  return {
    offset: tMs => scaled(dir, distance(tMs)),
    startMs,
    endMs: startMs + riseMs + plateauMs + fallMs,
    onsetMs: startMs + riseMs * firstReach(smoothstep, 0, 1, 0.5),
    onset10Ms: startMs + riseMs * firstReach(smoothstep, 0, 1, 0.1),
    peakSpeed: peak,
  };
}

/**
 * Straight minimum-jerk displacement of `delta` (ih) over `durationMs`: a smooth bell of speed
 * whose peak is 1.875 × length / duration. For repositioning, rebounds and slow returns; use
 * `flick` when the peak speed and the onsets matter.
 */
export function move(startMs: number, durationMs: number, delta: Vec2): Motion & { peakSpeed: number } {
  const length = Math.hypot(delta[0], delta[1]);
  return {
    offset: tMs => scaled(delta, minJerk((tMs - startMs) / durationMs)),
    startMs,
    endMs: startMs + durationMs,
    peakSpeed: (MIN_JERK_PEAK * length) / (durationMs / 1000),
  };
}

/**
 * Tug flick: a minimum-jerk bell along the unit vector `dir` whose peak speed is `peak` ih/s and
 * whose length follows from the duration (peak × duration / 1.875). The returned Timing carries
 * the onsets for `labelOf`.
 */
export function flick(startMs: number, durationMs: number, peak: number, dir: Vec2): Motion & Timing {
  const length = (peak * (durationMs / 1000)) / MIN_JERK_PEAK;
  const base = move(startMs, durationMs, scaled(dir, length));
  const speed = (u: number) => minJerkSpeed(u) / MIN_JERK_PEAK;
  return {
    ...base,
    onsetMs: startMs + durationMs * firstReach(speed, 0, 0.5, 0.5),
    onset10Ms: startMs + durationMs * firstReach(speed, 0, 0.5, 0.1),
    peakSpeed: peak,
  };
}

/**
 * Sinusoid of `amplitude` ih along the unit vector `dir` at `freqHz`, with raised-cosine fades of
 * up to `fadeMs` at both ends so the hand does not start or stop abruptly. Zero outside
 * [startMs, startMs + durationMs]: waves, scratching wiggles.
 */
export function oscillation(startMs: number, durationMs: number, freqHz: number, amplitude: number, dir: Vec2, phase: number, fadeMs: number): Motion {
  const fade = Math.min(fadeMs, durationMs / 2);
  return {
    offset: tMs => {
      const t = tMs - startMs;
      if (t <= 0 || t >= durationMs) return [0, 0];
      const envelope = Math.min(1, t / fade, (durationMs - t) / fade);
      const gain = 0.5 - 0.5 * Math.cos(Math.PI * envelope);
      return scaled(dir, amplitude * gain * Math.sin(2 * Math.PI * freqHz * (t / 1000) + phase));
    },
    startMs,
    endMs: startMs + durationMs,
  };
}

/**
 * Sway that runs for the whole scene (no fades, phase measured from t = 0): the hand drifts
 * gently while it waits, `amplitude` ih along the unit vector `dir`.
 */
export function sway(durationMs: number, freqHz: number, amplitude: number, dir: Vec2, phase: number): Motion {
  return {
    offset: tMs => scaled(dir, amplitude * Math.sin(2 * Math.PI * freqHz * (tMs / 1000) + phase)),
    startMs: 0,
    endMs: durationMs,
  };
}

/**
 * Circular or semicircular arc. Arc length follows the same smooth speed profile as a stroke
 * (so the hand accelerates like a hand, not like a cursor), and the position is measured from
 * where the arc starts.
 */
function arc(startMs: number, radius: number, speed: number, spanRad: number, startAngle: number, clockwise: boolean, rampMs: number): Motion & { peakSpeed: number } {
  const cruiseMs = Math.max(40, (spanRad * radius * 1000) / speed - rampMs);
  const path = stroke(startMs, rampMs, cruiseMs, rampMs, speed, [1, 0]);
  const sign = clockwise ? 1 : -1;
  const origin: Vec2 = [radius * Math.cos(startAngle), radius * Math.sin(startAngle)];
  return {
    offset: tMs => {
      const angle = startAngle + (sign * path.offset(tMs)[0]) / radius;
      return [radius * Math.cos(angle) - origin[0], radius * Math.sin(angle) - origin[1]];
    },
    startMs,
    endMs: path.endMs,
    peakSpeed: speed,
  };
}

/** Anchor offset (ih, mirrored image axes) of rotating the hand by `rad` about its wrist. */
function tiltAnchorOffset(palmSize: number, rad: number): Vec2 {
  const [x0, y0] = wristToAnchor(palmSize, 0);
  const [x1, y1] = wristToAnchor(palmSize, rad);
  // wristToAnchor uses unmirrored image axes: x flips when mirrored.
  return [-(x1 - x0), y1 - y0];
}

/** The sum of the motions' offsets as a function of time: a Scene's `anchorAt` is a rest position plus this. */
export const sumOffsets = (motions: readonly Motion[]) => (tMs: number): Vec2 => {
  let x = 0, y = 0;
  for (const m of motions) {
    const o = m.offset(tMs);
    x += o[0]; y += o[1];
  }
  return [x, y];
};

// ---------------------------------------------------------------------------------------------
// Scenes: a noise-free performance with its ground truth
// ---------------------------------------------------------------------------------------------

export type GlitchKind = 'jump' | 'palm' | 'z';

/** A one-frame tracking error, landing on the delivered frame nearest to `atMs` that the guards allow. */
export interface Glitch {
  atMs: number;
  kind: GlitchKind;
}

/**
 * A noise-free performance with its ground truth: where the anchor is at every instant, how the
 * hand is tilted, which gestures happen when, and which tracking accidents are planned.
 * `renderScene` turns it into a clip by sampling at 30 fps and adding the PRD §8.2 noise.
 */
export interface Scene {
  durationMs: number;
  /** Noise-free anchor, mirrored ih. */
  anchorAt: (tMs: number) => Vec2;
  /** Rotation of the hand about its wrist, radians. */
  tiltAt: (tMs: number) => number;
  palmSize: number;
  handedness: 'Left' | 'Right';
  labels: GestureLabel[];
  glitches: Glitch[];
  /** Time spans no glitch may land in, whatever frame drops do to the plan. */
  glitchGuards: ReadonlyArray<readonly [number, number]>;
  tags: string[];
  /** Peak speed of the fastest casual (unlabelled) motion, for the stress analysis. */
  casualPeak?: number;
  segments?: Segment[];
}

const NO_TILT = () => 0;
const GLITCH_KINDS: readonly GlitchKind[] = ['jump', 'palm', 'z'];

/** A random apparent palm size, ih: the hand at 0.78–1.28 × the default distance from the camera. */
export function randomPalm(rng: Random): number {
  return DEFAULT_PALM_SIZE * rng.range(0.78, 1.28);
}

/** A direction whose vertical share is at most `maxTan` of its horizontal one: sway and waves are mostly horizontal. */
function mostlyHorizontal(rng: Random, maxTan: number): Vec2 {
  const angle = Math.atan(rng.range(0, maxTan)) * (rng.chance(0.5) ? 1 : -1);
  return [Math.cos(angle), Math.sin(angle)];
}

function randomDirection(rng: Random): Vec2 {
  const angle = rng.range(0, 2 * Math.PI);
  return [Math.cos(angle), Math.sin(angle)];
}

/** Glitches are single-frame events: no two closer than this, or they would be a two-frame event. */
const GLITCH_MIN_SPACING_MS = 100;

/** Random glitch times in [fromMs, toMs] outside the guarded intervals and at least GLITCH_MIN_SPACING_MS apart. */
function scheduleGlitches(rng: Random, count: number, fromMs: number, toMs: number, guards: ReadonlyArray<readonly [number, number]>): Glitch[] {
  const out: Glitch[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const atMs = rng.range(fromMs, toMs);
      if (guards.some(([lo, hi]) => atMs >= lo && atMs <= hi)) continue;
      if (out.some(g => Math.abs(g.atMs - atMs) < GLITCH_MIN_SPACING_MS)) continue;
      out.push({ atMs, kind: rng.pick(GLITCH_KINDS) });
      break;
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

const guardOf = (label: GestureLabel): readonly [number, number] => [label.motionStartMs - GLITCH_GUARD_BEFORE_MS, label.onsetMs + GLITCH_GUARD_AFTER_MS];

/**
 * Ground-truth label of a gesture from its Timing (`stroke` or `flick` return one) and the
 * instant its motion starts: the label every detection is matched against.
 */
export function labelOf(kind: IntentKind, timing: Timing, startMs: number): GestureLabel {
  return { kind, onsetMs: timing.onsetMs, onset10Ms: timing.onset10Ms, motionStartMs: startMs, peakSpeed: timing.peakSpeed };
}

/** Rest position of a gesture clip: away from the borders the gesture will not touch. */
function restX(rng: Random): number {
  return rng.range(0.5, 0.85);
}

/** Share of launch clips that start low enough for the hand to leave through the bottom. */
const LAUNCH_EXIT_SHARE = 0.2;
/**
 * Where in the stroke (as a share of its vertical travel) the hand crosses the exit line: «during
 * the stroke», after 70–95 % of it, and it then stays out of view through the rebound and rest.
 */
const EXIT_AT_STROKE_FRACTION = [0.7, 0.95] as const;
/** The stroke must end at least this far past the exit line, so the hand really is gone (noise is ±0.008 ih). */
const EXIT_MARGIN = 0.04;
/** Anchor y at which the wrist (≈ 0.165 ih below it) crosses the exit line of 1.02. */
const WRIST_EXIT_ANCHOR_Y = EXIT_WRIST_Y - 0.165;
/** Share of gesture clips that get one to three one-frame glitches. */
const GESTURE_GLITCH_SHARE = 0.25;

/** Share of the stroke's vertical travel done when the hand crosses the exit line. */
function exitFraction(rng: Random, strokeDown: number): number {
  const latest = Math.min(EXIT_AT_STROKE_FRACTION[1], 1 - EXIT_MARGIN / strokeDown);
  return rng.range(Math.min(EXIT_AT_STROKE_FRACTION[0], latest - 0.01), latest);
}

/**
 * Launch: still ≥ 400 ms or a small wind-up, then a fast stroke about straight down, a small
 * rebound and rest. 20 % of the clips start low enough to leave the frame through the bottom.
 */
function launchScene(rng: Random): Scene {
  const windup = rng.chance(0.4);
  const exits = rng.chance(LAUNCH_EXIT_SHARE);
  const peak = rng.range(1.5, 3.0);
  const riseMs = rng.range(40, 80), plateauMs = rng.range(30, 120), fallMs = rng.range(60, 120);
  const angle = rng.range(-25, 25);
  const dir = vertical(angle, false);
  const strokeLength = (peak * (0.5 * riseMs + plateauMs + 0.5 * fallMs)) / 1000;
  const strokeDown = strokeLength * dir[1];

  const reboundUp = rng.range(0.01, 0.04);
  // Where the stroke starts (the top of the wind-up, if any).
  const topY = exits
    ? WRIST_EXIT_ANCHOR_Y - strokeDown * exitFraction(rng, strokeDown)
    : rng.range(0.1, Math.max(0.1, 0.8 - strokeDown));
  const x = restX(rng);

  const motions: Motion[] = [];
  let strokeStart: number;
  const tags = ['launch', windup ? 'windup' : 'still'];
  let restY = topY;
  if (windup) {
    const lead = rng.range(350, 800);
    const rise = rng.range(0.02, 0.1);
    const durationMs = rng.range(150, 350);
    restY = topY + rise;
    motions.push(move(lead, durationMs, [0, -rise]));
    strokeStart = lead + durationMs + rng.range(0, 60);
    tags.push(`windup=${rise.toFixed(3)}`);
  } else {
    strokeStart = rng.range(450, 1200);
  }
  const launch = stroke(strokeStart, riseMs, plateauMs, fallMs, peak, dir);
  motions.push(launch);
  const reboundStart = launch.endMs + rng.range(0, 40);
  const reboundMs = rng.range(100, 250);
  motions.push(move(reboundStart, reboundMs, [0, -reboundUp]));
  let durationMs = reboundStart + reboundMs + rng.range(400, 800);

  if (exits) {
    // The hand comes back into view slowly once it has left: exercises absence and re-acquisition.
    const outY = topY + strokeDown - reboundUp;
    const climb = Math.max(0, outY - 0.55);
    const climbMs = Math.max(600, (MIN_JERK_PEAK * climb) / 0.5 * 1000);
    const climbStart = durationMs + rng.range(100, 400);
    motions.push(move(climbStart, climbMs, [0, -climb]));
    durationMs = climbStart + climbMs + rng.range(300, 600);
    tags.push('exit');
  }
  const label = labelOf('launch', launch, strokeStart);
  const palmSize = randomPalm(rng);
  const offset = sumOffsets(motions);
  return {
    durationMs,
    anchorAt: t => { const o = offset(t); return [x + o[0], restY + o[1]]; },
    tiltAt: NO_TILT,
    palmSize,
    handedness: rng.chance(0.5) ? 'Right' : 'Left',
    labels: [label],
    glitches: rng.chance(GESTURE_GLITCH_SHARE)
      ? scheduleGlitches(rng, rng.int(1, 3), 150, durationMs - 100, [guardOf(label)]) : [],
    glitchGuards: [guardOf(label)],
    tags: [...tags, `peak=${peak.toFixed(2)}`, `angle=${angle.toFixed(0)}`],
  };
}

/**
 * Tug: still or gently swaying for ≥ 400 ms, then a short upward flick, then rest or a slow
 * return. The sway keeps going through the flick: a hand does not stop to tug.
 */
function tugScene(rng: Random): Scene {
  const swaying = rng.chance(0.5);
  const peak = rng.range(0.8, 1.6);
  const durationFlick = rng.range(100, 200);
  const angle = rng.range(-25, 25);
  const flickStart = rng.range(450, 1300);
  const motions: Motion[] = [];
  const tags = ['tug', swaying ? 'sway' : 'still'];

  const total = flickStart + durationFlick + rng.range(500, 900);
  if (swaying) {
    const amplitude = rng.range(0.02, 0.06), freq = rng.range(0.3, 1.2);
    motions.push(sway(total + 800, freq, amplitude, mostlyHorizontal(rng, 0.3), rng.range(0, 2 * Math.PI)));
    tags.push(`swayAmp=${amplitude.toFixed(3)}`, `swayHz=${freq.toFixed(2)}`);
  }
  const pull = flick(flickStart, durationFlick, peak, vertical(angle, true));
  motions.push(pull);
  let durationMs = total;
  if (rng.chance(0.5)) {
    const length = (peak * (durationFlick / 1000)) / MIN_JERK_PEAK;
    const backMs = Math.max(500, (MIN_JERK_PEAK * length) / 0.4 * 1000);
    const backStart = pull.endMs + rng.range(100, 400);
    motions.push(move(backStart, backMs, [0, length]));
    durationMs = Math.max(durationMs, backStart + backMs + 200);
    tags.push('return');
  }
  const x = restX(rng), y = rng.range(0.38, 0.62);
  const offset = sumOffsets(motions);
  const label = labelOf('tug', pull, flickStart);
  return {
    durationMs,
    anchorAt: t => { const o = offset(t); return [x + o[0], y + o[1]]; },
    tiltAt: NO_TILT,
    palmSize: randomPalm(rng),
    handedness: rng.chance(0.5) ? 'Right' : 'Left',
    labels: [label],
    glitches: rng.chance(GESTURE_GLITCH_SHARE)
      ? scheduleGlitches(rng, rng.int(1, 3), 150, durationMs - 100, [guardOf(label)]) : [],
    glitchGuards: [guardOf(label)],
    tags: [...tags, `peak=${peak.toFixed(2)}`, `dur=${durationFlick.toFixed(0)}`, `angle=${angle.toFixed(0)}`],
  };
}

// ---------------------------------------------------------------------------------------------
// Non-event parts: things a hand does that are not a launch or a tug
// ---------------------------------------------------------------------------------------------

/** One casual action starting at `startMs`. */
interface Part {
  motions: Motion[];
  tilt?: (tMs: number) => number;
  durationMs: number;
  tag: string;
  glitches?: Glitch[];
  /** Peak speed of the casual motion, ih/s (absent for stillness and wobble). */
  peak?: number;
}

type PartKind = 'wave' | 'readjust' | 'scratch' | 'arc' | 'tilt' | 'glitchStill' | 'still';
const PART_KINDS: readonly PartKind[] = ['wave', 'readjust', 'scratch', 'arc', 'tilt', 'glitchStill', 'still'];

/** Where casual motions may roam: keeps the hand in view so absence does not hide the test. */
const ROAM_X = [0.45, 0.95] as const;
const ROAM_Y = [0.3, 0.7] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Rest between two casual parts, and still tail at the end of a clip, ms. */
const REST_MIN_MS = 150, REST_MAX_MS = 700;
const TAIL_MIN_MS = 200, TAIL_MAX_MS = 600;

/** Wave: horizontal, 2–3.5 Hz, 0.04–0.12 ih, vertical share ≤ 25 %. */
function wavePart(rng: Random, startMs: number): Part {
  const durationMs = rng.range(1000, 2500);
  const motion = oscillation(startMs, durationMs, rng.range(2, 3.5), rng.range(0.04, 0.12), mostlyHorizontal(rng, 0.25), rng.range(0, 2 * Math.PI), 250);
  return { motions: [motion], durationMs, tag: 'wave' };
}

/** Reposition the hand to somewhere else in view, as a smooth minimum-jerk move with a capped peak speed. */
function readjustPart(rng: Random, startMs: number, here: Vec2, peakRange: readonly [number, number], reach: readonly [number, number]): Part {
  const d = randomDirection(rng);
  const length = rng.range(reach[0], reach[1]);
  const target: Vec2 = [clamp(here[0] + d[0] * length, ROAM_X[0], ROAM_X[1]), clamp(here[1] + d[1] * length, ROAM_Y[0], ROAM_Y[1])];
  const delta: Vec2 = [target[0] - here[0], target[1] - here[1]];
  const peak = rng.range(peakRange[0], peakRange[1]);
  const durationMs = Math.max(250, (MIN_JERK_PEAK * Math.hypot(delta[0], delta[1]) * 1000) / peak);
  const m = move(startMs, durationMs, delta);
  return { motions: [m], durationMs, tag: 'readjust', peak: m.peakSpeed };
}

/** Scratch the face: up 0.1–0.25 ih, 3–6 Hz wiggle of ≤ 0.015 ih, back down, all at capped speed. */
function scratchPart(rng: Random, startMs: number, peakRange: readonly [number, number]): Part {
  const height = rng.range(0.1, 0.25);
  const sideways = rng.range(-0.04, 0.04);
  const upPeak = rng.range(peakRange[0], peakRange[1]), downPeak = rng.range(peakRange[0], peakRange[1]);
  const upMs = (MIN_JERK_PEAK * Math.hypot(height, sideways) * 1000) / upPeak;
  const downMs = (MIN_JERK_PEAK * Math.hypot(height, sideways) * 1000) / downPeak;
  const wiggleMs = rng.range(600, 1800);
  const up = move(startMs, upMs, [sideways, -height]);
  const wiggle = oscillation(startMs + upMs, wiggleMs, rng.range(3, 6), rng.range(0.005, 0.015), randomDirection(rng), rng.range(0, 2 * Math.PI), 120);
  const down = move(startMs + upMs + wiggleMs, downMs, [-sideways, height]);
  return { motions: [up, wiggle, down], durationMs: upMs + wiggleMs + downMs, tag: 'scratch', peak: Math.max(up.peakSpeed, down.peakSpeed) };
}

/**
 * Circular or semicircular arc, radius 0.1–0.25 ih, tangential speed 0.5–1.8 ih/s. A casual
 * hand speeds up smoothly: the ramp is the time to reach that speed at 2–5 ih/s² (at least
 * 150 ms), against the 12–50 ih/s² of a tug or the 20–100 ih/s² of a launch stroke. Without
 * that limit a 1.8 ih/s arc that starts from rest in 150 ms IS a flick: no classifier could
 * tell them apart and «0 triggers» would be unreachable by construction. The stress set
 * drops the limit.
 */
function arcPart(rng: Random, startMs: number, accelerationLimit: readonly [number, number] = [2, 5]): Part {
  const speed = rng.range(0.5, 1.8);
  const rampMs = clamp((1000 * speed) / rng.range(accelerationLimit[0], accelerationLimit[1]), 150, 700);
  const m = arc(startMs, rng.range(0.1, 0.25), speed, rng.pick([Math.PI, 2 * Math.PI]), rng.range(0, 2 * Math.PI), rng.chance(0.5), rampMs);
  return { motions: [m], durationMs: m.endMs - startMs, tag: 'arc', peak: m.peakSpeed };
}

/**
 * Tilt the hand ±10–30° about the wrist over 200–600 ms, hold, and tilt back. The wrist stays
 * put, so the anchor swings along an arc of palm-size radius: tilting is a real anchor motion.
 */
function tiltPart(rng: Random, startMs: number, palmSize: number): Part {
  const angle = (rng.range(10, 30) * Math.PI / 180) * (rng.chance(0.5) ? 1 : -1);
  const inMs = rng.range(200, 600), holdMs = rng.range(100, 400), outMs = rng.range(200, 600);
  const outStart = startMs + inMs + holdMs;
  const tilt = (tMs: number) => angle * (minJerk((tMs - startMs) / inMs) - minJerk((tMs - outStart) / outMs));
  const motion: Motion = { offset: tMs => tiltAnchorOffset(palmSize, tilt(tMs)), startMs, endMs: outStart + outMs };
  return { motions: [motion], tilt, durationMs: inMs + holdMs + outMs, tag: 'tilt' };
}

function stillPart(rng: Random): Part {
  return { motions: [], durationMs: rng.range(800, 2000), tag: 'still' };
}

/** A still hand suffering three to six tracking glitches of every kind. */
function glitchStillPart(rng: Random, startMs: number): Part {
  const durationMs = rng.range(1000, 2000);
  return { motions: [], durationMs, tag: 'glitches', glitches: scheduleGlitches(rng, rng.int(3, 6), startMs + 50, startMs + durationMs - 50, []) };
}

function makePart(kind: PartKind, rng: Random, startMs: number, here: Vec2, palmSize: number): Part {
  switch (kind) {
    case 'wave': return wavePart(rng, startMs);
    case 'readjust': return readjustPart(rng, startMs, here, [0.2, 0.6], [0.05, 0.3]);
    case 'scratch': return scratchPart(rng, startMs, [0.3, 0.6]);
    case 'arc': return arcPart(rng, startMs);
    case 'tilt': return tiltPart(rng, startMs, palmSize);
    case 'glitchStill': return glitchStillPart(rng, startMs);
    case 'still': return stillPart(rng);
  }
}

/** Distinct random picks from a list, in random order. */
function sample<T>(rng: Random, items: readonly T[], count: number): T[] {
  const pool = [...items], out: T[] = [];
  while (out.length < count && pool.length) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  return out;
}

/**
 * Lays parts one after another with short rests between them, from a still lead-in, until the
 * soft target duration is reached. `choose` names the kind for a slot (and attempt: a part that
 * would run past the hard end is redrawn). Nothing ever runs past `targetMs[1]`.
 */
function composeParts(
  rng: Random, base: Vec2, palmSize: number, targetMs: [number, number],
  choose: (slot: number, attempt: number) => PartKind, partsRange: [number, number],
  makeOne: (kind: PartKind, rng: Random, startMs: number, here: Vec2, palmSize: number) => Part = makePart,
): Scene {
  const limit = rng.range(targetMs[0], targetMs[1]);
  const hardEnd = targetMs[1] - TAIL_MAX_MS - REST_MAX_MS;
  const motions: Motion[] = [];
  const tilts: Array<(tMs: number) => number> = [];
  const glitches: Glitch[] = [];
  const tags: string[] = [];
  const segments: Segment[] = [];
  let t = rng.range(400, 900);
  let casualPeak = 0, slot = 0;
  for (let attempt = 0; attempt < 40 && slot < partsRange[1]; attempt++) {
    if (slot >= partsRange[0] && t >= limit) break;
    const o = sumOffsets(motions)(t);
    const part = makeOne(choose(slot, attempt), rng, t, [base[0] + o[0], base[1] + o[1]], palmSize);
    if (t + part.durationMs > hardEnd) continue;
    motions.push(...part.motions);
    if (part.tilt) tilts.push(part.tilt);
    glitches.push(...(part.glitches ?? []));
    tags.push(part.tag);
    segments.push({ tag: part.tag, startMs: t, endMs: t + part.durationMs, ...(part.peak !== undefined ? { peak: part.peak } : {}) });
    if (part.peak !== undefined) casualPeak = Math.max(casualPeak, part.peak);
    t += part.durationMs + rng.range(REST_MIN_MS, REST_MAX_MS);
    slot++;
  }
  const durationMs = Math.max(targetMs[0], t + rng.range(TAIL_MIN_MS, TAIL_MAX_MS));
  const offset = sumOffsets(motions);
  return {
    durationMs,
    anchorAt: tMs => { const o = offset(tMs); return [base[0] + o[0], base[1] + o[1]]; },
    tiltAt: tMs => tilts.reduce((sum, f) => sum + f(tMs), 0),
    palmSize,
    handedness: rng.chance(0.5) ? 'Right' : 'Left',
    labels: [],
    glitches,
    glitchGuards: [],
    tags,
    casualPeak,
    segments,
  };
}

/** Non-events: 4–8 s mixing two or three kinds of casual behaviour. */
function nonEventScene(rng: Random): Scene {
  const kinds = sample(rng, PART_KINDS, rng.int(2, 3));
  const palmSize = randomPalm(rng);
  const scene = composeParts(rng, [rng.range(0.55, 0.85), rng.range(0.4, 0.55)], palmSize, [4000, 8000],
    (slot, attempt) => (slot < kinds.length && attempt < 3 ? kinds[slot] : rng.pick(kinds)), [2, 12]);
  scene.tags.unshift('non-event');
  return scene;
}

/**
 * Stress set: casual motions at higher speeds than the PRD's non-events (reaches, scratches and
 * readjusts up to 1.2 ih/s) to find where the decision boundary lies. Informational only.
 */
function stressScene(rng: Random): Scene {
  const kinds: PartKind[] = ['readjust', 'scratch'];
  const make = (kind: PartKind, r: Random, startMs: number, here: Vec2) => (
    kind === 'scratch'
      ? scratchPart(r, startMs, [0.6, 1.2])
      : readjustPart(r, startMs, here, [0.6, 1.2], [0.1, 0.45])
  );
  const scene = composeParts(rng, [rng.range(0.55, 0.85), rng.range(0.4, 0.55)], randomPalm(rng), [3000, 6000],
    () => rng.pick(kinds), [2, 6], make);
  scene.tags.unshift('stress');
  return scene;
}

// ---------------------------------------------------------------------------------------------
// Long clips: the false-trigger gates (Y-02: 5 s still, Y-04: 60 s of jitter and sway)
// ---------------------------------------------------------------------------------------------

function stillScene(rng: Random, durationMs: number, tags: string[], glitchEveryMs?: readonly [number, number]): Scene {
  const glitches: Glitch[] = [];
  if (glitchEveryMs) {
    for (let t = rng.range(...glitchEveryMs); t < durationMs - 200; t += rng.range(...glitchEveryMs)) glitches.push({ atMs: t, kind: rng.pick(GLITCH_KINDS) });
  }
  const x = restX(rng), y = rng.range(0.38, 0.62);
  return { durationMs, anchorAt: () => [x, y], tiltAt: NO_TILT, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left', labels: [], glitches, glitchGuards: [], tags };
}

function swayLongScene(rng: Random, durationMs: number): Scene {
  const amplitude = rng.range(0.03, 0.06), freq = rng.range(0.3, 1.2);
  const motion = sway(durationMs, freq, amplitude, mostlyHorizontal(rng, 0.3), rng.range(0, 2 * Math.PI));
  const x = restX(rng), y = rng.range(0.38, 0.62);
  return {
    durationMs, anchorAt: tMs => { const o = motion.offset(tMs); return [x + o[0], y + o[1]]; }, tiltAt: NO_TILT,
    palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left', labels: [], glitches: [], glitchGuards: [],
    tags: ['long', 'sway', `swayAmp=${amplitude.toFixed(3)}`, `swayHz=${freq.toFixed(2)}`],
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering: timing, noise, glitches, drops and exits
// ---------------------------------------------------------------------------------------------

/** Alias kept for the importers that already use this name. */
export type { Scene as SyntheticScene };

const TWO_PI = 2 * Math.PI;

/** Applies PRD §8.2 noise (and an optional one-frame glitch) to a clean hand. */
function noisyHand(rng: Random, hand: HandDetection, glitch: Glitch | undefined): HandDetection {
  const wrist = hand.landmarks[0];
  let scale = 1 + rng.gaussian(0, PALM_JITTER);
  if (glitch?.kind === 'palm') scale *= rng.chance(0.5) ? 1 + GLITCH_PALM : 1 - GLITCH_PALM;
  let dx = rng.gaussian(0, COMMON_JITTER);
  let dy = rng.gaussian(0, COMMON_JITTER * IMAGE_ASPECT);
  if (glitch?.kind === 'jump') {
    const size = rng.range(GLITCH_JUMP[0], GLITCH_JUMP[1]);
    const heading = rng.range(0, TWO_PI);
    dx += (size * Math.cos(heading)) / IMAGE_ASPECT;
    dy += size * Math.sin(heading);
  }
  let zCommon = rng.gaussian(0, Z_COMMON_JITTER);
  if (glitch?.kind === 'z') zCommon += rng.range(GLITCH_Z[0], GLITCH_Z[1]) * (rng.chance(0.5) ? 1 : -1);

  const landmarks: Landmark[] = hand.landmarks.map((p, i) => ({
    x: wrist.x + (p.x - wrist.x) * scale + dx + rng.gaussian(0, LANDMARK_JITTER),
    y: wrist.y + (p.y - wrist.y) * scale + dy + rng.gaussian(0, LANDMARK_JITTER * IMAGE_ASPECT),
    // MediaPipe's z is relative to the wrist, which stays at 0.
    z: i === 0 ? 0 : p.z * scale + zCommon + rng.gaussian(0, Z_JITTER),
  }));
  return { landmarks, handedness: hand.handedness };
}

/** MediaPipe loses a hand that is mostly out of the frame: no detection past these lines. */
function hasLeftThroughBottom(hand: HandDetection): boolean {
  return hand.landmarks[9].y > EXIT_ANCHOR_Y || hand.landmarks[0].y > EXIT_WRIST_Y;
}

/**
 * Frames that reach the app: 30 fps with random phase and ±2 ms of timestamp jitter, minus the
 * iid and burst drops. Returns their capture times, the whole grid they were drawn from (dropped
 * slots included) and how many frames were lost.
 */
function deliveredTimes(rng: Random, durationMs: number): { times: number[]; grid: number[]; drops: number } {
  const times: number[] = [];
  const grid: number[] = [];
  const phase = rng.range(0, FRAME_MS);
  let burstLeft = 0, drops = 0;
  for (let i = 0; ; i++) {
    const tMs = phase + i * FRAME_MS + rng.range(-TIMESTAMP_JITTER_MS, TIMESTAMP_JITTER_MS);
    if (tMs >= durationMs) break;
    grid.push(tMs);
    if (burstLeft > 0) { burstLeft--; drops++; continue; }
    if (rng.chance(DROP_PROBABILITY)) { drops++; continue; }
    if (rng.chance(BURST_PROBABILITY)) { burstLeft = 1; drops++; continue; }
    times.push(tMs);
  }
  return { times, grid, drops };
}

/**
 * Puts each planned glitch on the delivered frame nearest to it that lies outside the guards
 * and is not next to another glitch. Planning on times and landing on frames keeps frame
 * drops from sliding a glitch into the gesture it was meant to stay clear of.
 */
function placeGlitches(times: readonly number[], glitches: readonly Glitch[], guards: Scene['glitchGuards']): Map<number, Glitch> {
  const placed = new Map<number, Glitch>();
  const blocked = (i: number) => guards.some(([lo, hi]) => times[i] >= lo && times[i] <= hi) || [-2, -1, 0, 1, 2].some(d => placed.has(i + d));
  for (const glitch of [...glitches].sort((a, b) => a.atMs - b.atMs)) {
    let best = -1;
    for (let i = 0; i < times.length; i++) {
      if (blocked(i)) continue;
      if (best < 0 || Math.abs(times[i] - glitch.atMs) < Math.abs(times[best] - glitch.atMs)) best = i;
    }
    if (best >= 0) placed.set(best, glitch);
  }
  return placed;
}

/**
 * Samples a scene as the camera path would deliver it: 30 fps with random phase and ±2 ms of
 * timestamp jitter, 50 ms plus 0–10 ms of tracking delay (arrival strictly increasing), iid and
 * burst frame drops, noise on every landmark, glitches, and no hand once it leaves the frame.
 */
export function renderScene(scene: Scene, rng: Random, meta: { id: string; kind: ClipKind; armed: ArmedIntents }): SyntheticClip {
  const { times, grid, drops } = deliveredTimes(rng, scene.durationMs);
  const glitchOn = placeGlitches(times, scene.glitches, scene.glitchGuards);
  const frames: DeliveredFrame[] = [];
  let exits = 0;
  let lastArrival = -Infinity;

  times.forEach((tMs, i) => {
    const anchor = scene.anchorAt(tMs);
    const clean = buildHand({
      anchor: { x: 1 - anchor[0] / IMAGE_ASPECT, y: anchor[1] },
      palmSize: scene.palmSize,
      tilt: scene.tiltAt(tMs),
      handedness: scene.handedness,
    });
    const hand = noisyHand(rng, clean, glitchOn.get(i));
    const gone = hasLeftThroughBottom(hand);
    if (gone) exits++;

    const arrivalMs = Math.max(lastArrival + 0.001, tMs + TRACKING_LATENCY_MS + rng.range(0, ARRIVAL_SPREAD_MS));
    lastArrival = arrivalMs;
    frames.push({ frame: { timestampMs: tMs, source: 'replay', hands: gone ? [] : [hand] }, arrivalMs });
  });
  const tags = [...scene.tags, `drops=${drops}`, `glitched=${glitchOn.size}`];
  for (const i of [...glitchOn.keys()].sort((a, b) => a - b)) tags.push(`glitchAt=${times[i].toFixed(0)}`);
  if (exits) tags.push(`goneFrames=${exits}`);
  const clean = grid.map((t): CleanSample => {
    const [x, y] = scene.anchorAt(t);
    return { t, x, y };
  });
  return {
    id: meta.id, kind: meta.kind, armed: meta.armed, frames, labels: scene.labels, clean, tags, durationMs: scene.durationMs,
    ...(scene.casualPeak !== undefined ? { casualPeak: scene.casualPeak } : {}),
    ...(scene.segments ? { segments: scene.segments } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------------------------

export const DEFAULT_SEED = 20261001;

/** Clip counts of the corpus. Long clips are repeated with fresh noise: a single 60 s run is thin evidence of «never». */
export const CORPUS_SIZE = {
  launch: 400,
  tug: 400,
  nonEvent: 300,
  stress: 200,
  longTugStill: 3,
  longTugSway: 3,
  longTugGlitchy: 2,
  longLaunchStill: 10,
} as const;

const LONG_MS = 60_000;
const SHORT_LONG_MS = 5_000;

const SALT = { launch: 1, tug: 2, nonEvent: 3, stress: 4, longTugStill: 5, longTugSway: 6, longTugGlitchy: 7, longLaunchStill: 8, render: 1000 } as const;

/** Mixes (seed, salt, index) into an independent 32-bit seed so clips never share a random stream. */
function derive(seed: number, salt: number, index: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35) ^ Math.imul(index + 1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

export type SceneKind = 'launch' | 'tug' | 'non-event' | 'stress' | 'long-tug-still' | 'long-tug-sway' | 'long-tug-glitchy' | 'long-launch-still';

const SCENES: Record<SceneKind, { salt: number; clip: ClipKind; armed: ArmedIntents; make: (rng: Random) => Scene }> = {
  launch: { salt: SALT.launch, clip: 'launch', armed: { launch: true, tug: false }, make: launchScene },
  tug: { salt: SALT.tug, clip: 'tug', armed: { launch: false, tug: true }, make: tugScene },
  'non-event': { salt: SALT.nonEvent, clip: 'non-event', armed: { launch: true, tug: true }, make: nonEventScene },
  stress: { salt: SALT.stress, clip: 'stress', armed: { launch: true, tug: true }, make: stressScene },
  'long-tug-still': { salt: SALT.longTugStill, clip: 'long', armed: { launch: false, tug: true }, make: rng => stillScene(rng, LONG_MS, ['long', 'still-60s']) },
  'long-tug-sway': { salt: SALT.longTugSway, clip: 'long', armed: { launch: false, tug: true }, make: rng => swayLongScene(rng, LONG_MS) },
  'long-tug-glitchy': { salt: SALT.longTugGlitchy, clip: 'long', armed: { launch: false, tug: true }, make: rng => stillScene(rng, LONG_MS, ['long', 'still-60s', 'glitchy'], [2500, 6000]) },
  'long-launch-still': { salt: SALT.longLaunchStill, clip: 'long', armed: { launch: true, tug: false }, make: rng => stillScene(rng, SHORT_LONG_MS, ['long', 'still-5s']) },
};

/**
 * A scene performed with smaller (or larger) movements: «sentado, antebrazo apoyado» moves the
 * anchor 0.7× as far at 0.7× the speed (PRD §3). Noise, timing and rests stay as they are, so the
 * signal-to-noise ratio drops: that is what the seated preset has to live with.
 */
function withAmplitude(scene: Scene, k: number): Scene {
  if (k === 1) return scene;
  const origin = scene.anchorAt(0);
  return {
    ...scene,
    anchorAt: t => {
      const a = scene.anchorAt(t);
      return [origin[0] + k * (a[0] - origin[0]), origin[1] + k * (a[1] - origin[1])];
    },
    labels: scene.labels.map(l => ({ ...l, peakSpeed: l.peakSpeed * k })),
    casualPeak: scene.casualPeak === undefined ? undefined : scene.casualPeak * k,
    segments: scene.segments?.map(seg => (seg.peak === undefined ? seg : { ...seg, peak: seg.peak * k })),
    tags: [...scene.tags, `amplitude=${k}`],
  };
}

/** The noise-free performance behind clip `index` of a kind: what ground truth is computed from. */
export function createScene(kind: SceneKind, seed: number, index: number, amplitude = 1): Scene {
  return withAmplitude(SCENES[kind].make(new Random(derive(seed, SCENES[kind].salt, index))), amplitude);
}

/** One clip, deterministic in (kind, seed, index, amplitude) and independent of every other clip. */
export function buildClip(kind: SceneKind, seed: number, index: number, amplitude = 1): SyntheticClip {
  const spec = SCENES[kind];
  const scene = createScene(kind, seed, index, amplitude);
  const id = `${kind}-${String(index).padStart(4, '0')}`;
  return renderScene(scene, new Random(derive(seed, spec.salt + SALT.render, index)), { id, kind: spec.clip, armed: spec.armed });
}

const clipsOf = (kind: SceneKind, count: number, seed: number, amplitude: number) => Array.from({ length: count }, (_, i) => buildClip(kind, seed, i, amplitude));

/**
 * The whole seeded corpus: 400 launches, 400 tugs, 300 non-events, long false-trigger clips and
 * the stress set. `amplitude` scales every movement (1 standing, 0.7 for the seated preset).
 */
export function buildCorpus(seed = DEFAULT_SEED, amplitude = 1): Corpus {
  return {
    seed,
    amplitude,
    launch: clipsOf('launch', CORPUS_SIZE.launch, seed, amplitude),
    tug: clipsOf('tug', CORPUS_SIZE.tug, seed, amplitude),
    nonEvent: clipsOf('non-event', CORPUS_SIZE.nonEvent, seed, amplitude),
    long: [
      ...clipsOf('long-tug-still', CORPUS_SIZE.longTugStill, seed, amplitude),
      ...clipsOf('long-tug-sway', CORPUS_SIZE.longTugSway, seed, amplitude),
      ...clipsOf('long-tug-glitchy', CORPUS_SIZE.longTugGlitchy, seed, amplitude),
      ...clipsOf('long-launch-still', CORPUS_SIZE.longLaunchStill, seed, amplitude),
    ],
    stress: clipsOf('stress', CORPUS_SIZE.stress, seed, amplitude),
  };
}
