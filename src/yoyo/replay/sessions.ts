import { framingZone } from '../app/framing';
import { DEFAULT_HOME_IMAGE, zoneCentre, type TetherZone } from '../app/TetherDetector';
import { YoyoRuntime } from '../app/YoyoRuntime';
import { createConfig, type YoyoConfig } from '../config';
import type { FrameEdge, ReplayFile, Vec2, YoyoEventKind, YoyoPhase, YoyoSnapshot } from '../contracts';
import type { PointerRect, PointerScriptStep } from '../input/MouseDriver';
import { Random } from './random';
import {
  flick, FRAME_MS, labelOf, move, oscillation, randomPalm, renderScene, stroke, sumOffsets, sway,
  type CleanSample, type DeliveredFrame, type GestureLabel, type Glitch, type GlitchKind, type Motion, type Scene, type SyntheticClip,
} from './synthetic';
import { buildHand, DEFAULT_PALM_SIZE, IMAGE_ASPECT } from './handPose';

/**
 * Play sessions for the whole pipeline: a hand that appears, holds still until the yoyo ties on,
 * throws, waits while the yoyo sleeps, tugs, loses the frame, comes back. Written as a short list of
 * steps and rendered through the same camera model as the corpus (renderScene: 30 fps with random
 * phase, 50 ms of tracking delay, Gaussian jitter, dropped frames, exits through the bottom), so what
 * a test or the «Ver demo» button plays is a camera replay in everything but its origin.
 *
 * Ground truth comes with the scene: the labelled onset of every launch and tug, in capture time,
 * exactly as the corpus labels them, so latency can be measured against it.
 */

/** Gentle motion of a waiting hand: a sinusoid along a line close to horizontal. */
export interface SwaySpec {
  /** Peak displacement, ih. */
  amplitude: number;
  freqHz: number;
  /** Direction, degrees above the horizontal. */
  angleDeg?: number;
  /** Phase, radians. */
  phase?: number;
}

export type CasualMotion = 'wave' | 'circle' | 'drift';

/** One segment of a session. The hand's position carries over from step to step. */
export type SessionStep =
  /** The hand shows up at `at` (default: the default home) and holds still. The first one fixes where the session starts. */
  | { kind: 'appear'; holdMs: number; at?: Vec2; sway?: SwaySpec }
  /** The hand stays where it is: waiting to tie on, or while the yoyo sleeps. */
  | { kind: 'hold'; ms: number; sway?: SwaySpec }
  /**
   * From here on the hand sways, fading in over a quarter of a second, until the session ends: a
   * hand does not stop swaying to tug. Not before the yoyo ties on: a swaying hand is not «estable».
   */
  | { kind: 'sway'; spec: SwaySpec }
  /** A throw: optional small wind-up, then a stroke (speed ramps up, holds `peak`, ramps down), then a small rebound. */
  | {
    kind: 'launch';
    /** Peak stroke speed, ih/s. */
    peak: number;
    riseMs?: number; plateauMs?: number; fallMs?: number;
    /** Degrees away from straight down. */
    angleDeg?: number;
    /** Wind-up: the hand rises `rise` ih over `ms` and pauses a moment before the stroke. */
    windup?: { rise: number; ms: number };
    /** The hand comes back up a little after the stroke, ih. 0 for none. */
    reboundUp?: number;
  }
  /** An upward flick whose peak speed is `peak` ih/s. */
  | { kind: 'tug'; peak: number; durationMs?: number; angleDeg?: number }
  /** A smooth repositioning, by `delta` or to the absolute position `to`. */
  | { kind: 'move'; ms: number; delta?: Vec2; to?: Vec2 }
  /** Something a hand does that is not a throw: waving, circling, drifting. */
  | { kind: 'casual'; motion: CasualMotion; ms: number; amplitude?: number; freqHz?: number; speed?: number; angleDeg?: number }
  /**
   * No hand in the frame for `ms`. With `exit` the hand goes out through the bottom (at `speed` ih/s),
   * stays out for `ms` and comes back up over `returnMs`: the absence lasts a little longer than `ms`.
   */
  | { kind: 'lose'; ms: number; exit?: { speed?: number; returnMs?: number } }
  /** The hand is back, `offset` ih from where it was lost (it moved while the camera could not see it). */
  | { kind: 'reappear'; offset: Vec2 };

export interface SessionOptions {
  /** No hand in view for this long at the start: the hand «enters» afterwards. */
  leadMs?: number;
  /** The scene keeps running this long after the last step. */
  tailMs?: number;
  palmSize?: number;
  handedness?: 'Left' | 'Right';
  /** A sway that never stops (phase measured from t = 0): a hand does not hold perfectly still while it waits. */
  sway?: SwaySpec;
  /** One-frame tracking glitches (jumps, palm-size spikes, depth jumps) scattered outside the gestures. */
  glitches?: { count: number; seed: number };
  tags?: readonly string[];
}

/** A span of the scene in which no hand is delivered. */
export interface Absence {
  startMs: number;
  endMs: number;
  /** The hand left through the bottom of the frame (as opposed to a plain tracking loss). */
  exit: boolean;
}

/** A Scene that also knows when the hand is out of view, so a mouse script can release the button there. */
export interface SessionScene extends Scene {
  /** Ascending, non-overlapping. Includes the lead-in. */
  absences: Absence[];
}

// ---------------------------------------------------------------------------------------------
// Defaults of the segments: mid-range values of the corpus's own gestures (synthetic.ts)
// ---------------------------------------------------------------------------------------------

const DEFAULT_LEAD_MS = 0;
const DEFAULT_TAIL_MS = 300;
const DEFAULT_STROKE = { riseMs: 60, plateauMs: 70, fallMs: 90 } as const;
const DEFAULT_REBOUND_UP = 0.025;
const REBOUND_GAP_MS = 20;
const REBOUND_MS = 160;
/** Pause at the top of a wind-up before the stroke starts. */
const WINDUP_PAUSE_MS = 30;
const DEFAULT_TUG_MS = 160;
const SWAY_FADE_MS = 250;
const UNBOUNDED_MS = 1e9;
const WAVE = { freqHz: 2.5, amplitude: 0.08, fadeMs: 250 } as const;
const CIRCLE = { freqHz: 0.7, radius: 0.08 } as const;
const DRIFT = { speed: 0.3, rampMs: 100 } as const;
/** A hand that leaves through the bottom travels to this height, ih: well below the frame, so it is certainly gone. */
const EXIT_PATH_Y = 1.2;
const DEFAULT_EXIT = { speed: 1, returnMs: 500, rampMs: 150 } as const;
/**
 * The synthetic camera loses a hand whose anchor is below this height, ih from the top of the frame (the wrist leaves
 * first, see synthetic.ts EXIT_*): a mouse script releases here. A property of the camera model in image space, not of
 * the world: it does not move with `config.world`. (It was the same number as the world home's height before that
 * moved, which is a coincidence to keep in mind when reading old notes.)
 */
export const LOST_BELOW_Y = 0.85;

/**
 * Glitches keep clear of a gesture the way the corpus's do (synthetic.ts): a glitch there is
 * indistinguishable from the frame that carried the gesture being lost, and no detector can recover it.
 */
const GLITCH_GUARD_BEFORE_MS = 100;
const GLITCH_GUARD_AFTER_MS = 160;
const GLITCH_MIN_SPACING_MS = 100;
const GLITCH_KINDS: readonly GlitchKind[] = ['jump', 'palm', 'z'];
const GLITCH_EARLIEST_MS = 150;
const GLITCH_LATEST_MARGIN_MS = 100;
const GLITCH_ATTEMPTS = 30;

const NO_TILT = () => 0;

/** Unit vector `deg` away from the horizontal, pointing right (and up the image for positive angles). */
function fromHorizontal(deg: number): Vec2 {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a)];
}

/** Unit vector `deg` away from straight down (positive tilts toward the image's right); `up` points the other way. */
function verticalDir(deg: number, up: boolean): Vec2 {
  const a = (deg * Math.PI) / 180;
  return [Math.sin(a), up ? -Math.cos(a) : Math.cos(a)];
}

/** A displacement that happens all at once: the hand moved while nobody was looking. */
function relocation(atMs: number, delta: Vec2): Motion {
  return { offset: tMs => (tMs >= atMs ? delta : [0, 0]), startMs: atMs, endMs: atMs };
}

/** Builds one scene: a cursor in time, the hand's rest position, and everything that has been laid down so far. */
class Timeline {
  private t: number;
  private pos: Vec2 = DEFAULT_HOME_IMAGE;
  private base: Vec2 | null = null;
  private readonly motions: Motion[] = [];
  private readonly labels: GestureLabel[] = [];
  private readonly absences: Absence[] = [];
  /** Spans of `lose` steps that go out through the bottom: their absence is where the path is below the camera's view. */
  private readonly exits: Array<readonly [number, number]> = [];

  constructor(private readonly options: SessionOptions) {
    this.t = options.leadMs ?? DEFAULT_LEAD_MS;
    if (this.t > 0) this.absences.push({ startMs: 0, endMs: this.t, exit: false });
  }

  add(step: SessionStep): void {
    switch (step.kind) {
      case 'appear': return this.appear(step);
      case 'hold': return this.hold(step.ms, step.sway);
      case 'sway': return this.swayFrom(step.spec);
      case 'launch': return this.launch(step);
      case 'tug': return this.tug(step);
      case 'move': return this.reposition(step);
      case 'casual': return this.casual(step);
      case 'lose': return this.lose(step);
      case 'reappear': return this.reappear(step.offset);
    }
  }

  private shift(delta: Vec2): void {
    this.pos = [this.pos[0] + delta[0], this.pos[1] + delta[1]];
  }

  private swayFor(spec: SwaySpec | undefined, ms: number): void {
    if (!spec) return;
    this.motions.push(oscillation(this.t, ms, spec.freqHz, spec.amplitude, fromHorizontal(spec.angleDeg ?? 0), spec.phase ?? 0, SWAY_FADE_MS));
  }

  private appear(step: Extract<SessionStep, { kind: 'appear' }>): void {
    const at = step.at ?? DEFAULT_HOME_IMAGE;
    if (this.base === null) {
      this.base = at;
    } else {
      this.motions.push(relocation(this.t, [at[0] - this.pos[0], at[1] - this.pos[1]]));
    }
    this.pos = at;
    this.hold(step.holdMs, step.sway);
  }

  private hold(ms: number, spec?: SwaySpec): void {
    this.swayFor(spec, ms);
    this.t += ms;
  }

  /** An oscillation with no end: its duration is far longer than any session. */
  private swayFrom(spec: SwaySpec): void {
    this.motions.push(oscillation(this.t, UNBOUNDED_MS, spec.freqHz, spec.amplitude, fromHorizontal(spec.angleDeg ?? 0), spec.phase ?? 0, SWAY_FADE_MS));
  }

  private launch(step: Extract<SessionStep, { kind: 'launch' }>): void {
    if (step.windup) {
      this.motions.push(move(this.t, step.windup.ms, [0, -step.windup.rise]));
      this.shift([0, -step.windup.rise]);
      this.t += step.windup.ms + WINDUP_PAUSE_MS;
    }
    const riseMs = step.riseMs ?? DEFAULT_STROKE.riseMs;
    const plateauMs = step.plateauMs ?? DEFAULT_STROKE.plateauMs;
    const fallMs = step.fallMs ?? DEFAULT_STROKE.fallMs;
    const down = stroke(this.t, riseMs, plateauMs, fallMs, step.peak, verticalDir(step.angleDeg ?? 0, false));
    this.motions.push(down);
    this.labels.push(labelOf('launch', down, this.t));
    this.shift(down.offset(down.endMs));
    this.t = down.endMs;
    const rebound = step.reboundUp ?? DEFAULT_REBOUND_UP;
    if (rebound > 0) {
      const start = this.t + REBOUND_GAP_MS;
      this.motions.push(move(start, REBOUND_MS, [0, -rebound]));
      this.shift([0, -rebound]);
      this.t = start + REBOUND_MS;
    }
  }

  private tug(step: Extract<SessionStep, { kind: 'tug' }>): void {
    const pull = flick(this.t, step.durationMs ?? DEFAULT_TUG_MS, step.peak, verticalDir(step.angleDeg ?? 0, true));
    this.motions.push(pull);
    this.labels.push(labelOf('tug', pull, this.t));
    this.shift(pull.offset(pull.endMs));
    this.t = pull.endMs;
  }

  private reposition(step: Extract<SessionStep, { kind: 'move' }>): void {
    const delta: Vec2 = step.to ? [step.to[0] - this.pos[0], step.to[1] - this.pos[1]] : (step.delta ?? [0, 0]);
    this.motions.push(move(this.t, step.ms, delta));
    this.shift(delta);
    this.t += step.ms;
  }

  private casual(step: Extract<SessionStep, { kind: 'casual' }>): void {
    const dir = fromHorizontal(step.angleDeg ?? 0);
    if (step.motion === 'wave') {
      this.motions.push(oscillation(this.t, step.ms, step.freqHz ?? WAVE.freqHz, step.amplitude ?? WAVE.amplitude, dir, 0, WAVE.fadeMs));
    } else if (step.motion === 'circle') {
      const freq = step.freqHz ?? CIRCLE.freqHz, radius = step.amplitude ?? CIRCLE.radius;
      // Two quarter-turn-shifted sinusoids make a circle; the shared fade spirals it in and out.
      this.motions.push(oscillation(this.t, step.ms, freq, radius, [1, 0], 0, WAVE.fadeMs));
      this.motions.push(oscillation(this.t, step.ms, freq, radius, [0, 1], Math.PI / 2, WAVE.fadeMs));
    } else {
      const speed = step.speed ?? DRIFT.speed;
      const ramp = Math.min(DRIFT.rampMs, step.ms / 2);
      const drift = stroke(this.t, ramp, Math.max(0, step.ms - 2 * ramp), ramp, speed, dir);
      this.motions.push(drift);
      this.shift(drift.offset(drift.endMs));
    }
    this.t += step.ms;
  }

  private lose(step: Extract<SessionStep, { kind: 'lose' }>): void {
    if (!step.exit) {
      this.absences.push({ startMs: this.t, endMs: this.t + step.ms, exit: false });
      this.t += step.ms;
      return;
    }
    const speed = step.exit.speed ?? DEFAULT_EXIT.speed;
    const returnMs = step.exit.returnMs ?? DEFAULT_EXIT.returnMs;
    if (!(speed > 0)) throw new RangeError(`A hand leaves the frame at a positive speed, got ${speed}`);
    const start = this.t;
    // A constant-speed run out of the frame: ramp up, cruise, ramp down at the bottom.
    const distance = EXIT_PATH_Y - this.pos[1];
    const ramp = DEFAULT_EXIT.rampMs;
    const cruiseMs = Math.max(0, (distance * 1000) / speed - ramp);
    const out = stroke(this.t, ramp, cruiseMs, ramp, speed, [0, 1]);
    this.motions.push(out);
    const gone = out.offset(out.endMs);
    this.t = out.endMs + step.ms;
    this.motions.push(move(this.t, returnMs, [-gone[0], -gone[1]]));
    this.t += returnMs;
    this.exits.push([start, this.t]);
  }

  private reappear(offset: Vec2): void {
    this.motions.push(relocation(this.t, offset));
    this.shift(offset);
  }

  finish(): SessionScene {
    const o = this.options;
    const base = this.base ?? DEFAULT_HOME_IMAGE;
    const durationMs = this.t + (o.tailMs ?? DEFAULT_TAIL_MS);
    const offset = sumOffsets(o.sway
      ? [...this.motions, sway(durationMs, o.sway.freqHz, o.sway.amplitude, fromHorizontal(o.sway.angleDeg ?? 0), o.sway.phase ?? 0)]
      : this.motions);
    const anchorAt = (tMs: number): Vec2 => {
      const d = offset(tMs);
      return [base[0] + d[0], base[1] + d[1]];
    };
    const absences = [...this.absences, ...this.exits.map(([from, to]) => exitAbsence(anchorAt, from, to))]
      .sort((a, b) => a.startMs - b.startMs);
    const guards = this.labels.map(l => [l.motionStartMs - GLITCH_GUARD_BEFORE_MS, l.onsetMs + GLITCH_GUARD_AFTER_MS] as const);
    const forbidden = [...guards, ...absences.map(a => [a.startMs, a.endMs] as const)];
    return {
      durationMs,
      anchorAt,
      tiltAt: NO_TILT,
      palmSize: o.palmSize ?? DEFAULT_PALM_SIZE,
      handedness: o.handedness ?? 'Right',
      labels: this.labels,
      glitches: o.glitches ? scheduleGlitches(new Random(o.glitches.seed), o.glitches.count, durationMs, forbidden) : [],
      glitchGuards: guards,
      tags: ['session', ...(o.tags ?? [])],
      absences,
    };
  }
}

/** The part of an exit span in which the anchor is below the camera's view: first and last millisecond. */
function exitAbsence(anchorAt: (tMs: number) => Vec2, from: number, to: number): Absence {
  let first = -1, last = -1;
  for (let t = Math.ceil(from); t <= to; t++) {
    if (anchorAt(t)[1] >= LOST_BELOW_Y) {
      if (first < 0) first = t;
      last = t;
    }
  }
  // A path that never gets below the line (an exit from very high up at a slow speed would not): the whole span.
  return first < 0 ? { startMs: from, endMs: to, exit: true } : { startMs: first, endMs: last + 1, exit: true };
}

/** `count` glitches at random instants outside the forbidden spans, at least GLITCH_MIN_SPACING_MS apart. */
function scheduleGlitches(rng: Random, count: number, durationMs: number, forbidden: ReadonlyArray<readonly [number, number]>): Glitch[] {
  const out: Glitch[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < GLITCH_ATTEMPTS; attempt++) {
      const atMs = rng.range(GLITCH_EARLIEST_MS, Math.max(GLITCH_EARLIEST_MS + 1, durationMs - GLITCH_LATEST_MARGIN_MS));
      if (forbidden.some(([lo, hi]) => atMs >= lo && atMs <= hi)) continue;
      if (out.some(g => Math.abs(g.atMs - atMs) < GLITCH_MIN_SPACING_MS)) continue;
      out.push({ atMs, kind: rng.pick(GLITCH_KINDS) });
      break;
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Composes a session from steps. The result is a noise-free scene with its ground truth (labels,
 * absences); `renderSession` turns it into the frames a camera would deliver.
 */
export function sessionScene(steps: readonly SessionStep[], options: SessionOptions = {}): SessionScene {
  const timeline = new Timeline(options);
  for (const step of steps) timeline.add(step);
  return timeline.finish();
}

const isAbsent = (absences: readonly Absence[], tMs: number): boolean => absences.some(a => tMs >= a.startMs && tMs < a.endMs);

/**
 * Renders a session as the camera path would deliver it: the corpus's noise model (renderScene), then
 * no hand at all in the frames that fall inside an absence (a tracking loss shows as frames without
 * hands, which is what MediaPipe reports). Deterministic in (scene, seed).
 */
export function renderSession(scene: SessionScene, seed: number, id = 'session'): SyntheticClip {
  const clip = renderScene(scene, new Random(seed), { id, kind: 'long', armed: { launch: true, tug: true } });
  const frames = clip.frames.map(delivered => (isAbsent(scene.absences, delivered.frame.timestampMs)
    ? { frame: { ...delivered.frame, hands: [] }, arrivalMs: delivered.arrivalMs }
    : delivered));
  return { ...clip, frames };
}

/** Tracking delay of the noise-free camera, ms: the same 50 ms the noisy one has at its best. */
const CLEAN_DELAY_MS = 50;

/**
 * The same session as a camera with perfect tracking would deliver it: exactly 30 fps, constant
 * delay, no jitter, no dropped frames, no glitches, no size noise. Where a mouse script is a replay
 * without tracking noise at the anchor level, this is one at the HandFrame level, so the two routes
 * can be compared with perception noise taken out (Y-11): any difference left is the pipeline's.
 */
export function renderCleanSession(scene: SessionScene, id = 'clean'): SyntheticClip {
  const frames: DeliveredFrame[] = [];
  const clean: CleanSample[] = [];
  for (let i = 0; ; i++) {
    const t = i * FRAME_MS;
    if (t >= scene.durationMs) break;
    const [x, y] = scene.anchorAt(t);
    clean.push({ t, x, y });
    const hands = isAbsent(scene.absences, t) ? [] : [buildHand({
      anchor: { x: 1 - x / IMAGE_ASPECT, y }, palmSize: scene.palmSize, tilt: scene.tiltAt(t), handedness: scene.handedness,
    })];
    frames.push({ frame: { timestampMs: t, source: 'replay', hands }, arrivalMs: t + CLEAN_DELAY_MS });
  }
  return { id, kind: 'long', armed: { launch: true, tug: true }, frames, labels: scene.labels, clean, tags: [...scene.tags, 'clean'], durationMs: scene.durationMs };
}

// ---------------------------------------------------------------------------------------------
// Replaying a clip through the runtime
// ---------------------------------------------------------------------------------------------

/** Render cadence a clip is replayed at, and the time the runtime is given after its last frame, ms. */
const REPLAY_RENDER_MS = 1000 / 60;
const REPLAY_TAIL_MS = 600;

/** How a clip is replayed through a fresh runtime. */
export interface ReplayOptions {
  /** Default: `createConfig()`. */
  config?: YoyoConfig;
  /**
   * The tie-on zone, as the app sets it while it frames a hand: the camera mode does, «Ver demo» does not (the
   * world re-homes wherever the hand is when the yoyo ties on). Default: none.
   */
  zone?: TetherZone | null;
}

/**
 * Plays `clip` through a fresh runtime at a 60 Hz render cadence, every frame delivered at its arrival time, and
 * hands each snapshot to `visit`. The one loop behind everything that asks «what would the person watching see?»,
 * so the demo, the QA session and the tests that hold them to their promises all see the same thing.
 */
function playThrough(clip: SyntheticClip, options: ReplayOptions, visit: (snapshot: YoyoSnapshot) => void): void {
  const runtime = new YoyoRuntime(options.config ?? createConfig(), 'replay');
  if (options.zone) runtime.setTetherZone(options.zone);
  let next = 0;
  for (let k = 0; k * REPLAY_RENDER_MS <= clip.durationMs + REPLAY_TAIL_MS; k++) {
    const nowMs = k * REPLAY_RENDER_MS;
    while (next < clip.frames.length && clip.frames[next].arrivalMs <= nowMs) {
      runtime.pushFrame(clip.frames[next].frame, clip.frames[next].arrivalMs);
      next++;
    }
    visit(runtime.advance(nowMs));
  }
}

/** Every snapshot a fresh runtime shows while it plays `clip` (see `ReplayOptions`), one per 60 Hz render frame. */
export function replayClip(clip: SyntheticClip, options: ReplayOptions = {}): YoyoSnapshot[] {
  const snapshots: YoyoSnapshot[] = [];
  playThrough(clip, options, snapshot => snapshots.push(snapshot));
  return snapshots;
}

const GENTLE_SWAY_AMPLITUDE: readonly [number, number] = [0.02, 0.04];
const GENTLE_SWAY_FREQ: readonly [number, number] = [0.4, 0.9];

/** A gentle sway for a hand that waits while the yoyo sleeps: a few centimetres, a fraction of a hertz, nearly horizontal. */
function gentleSway(rng: Random): SwaySpec {
  return { amplitude: rng.range(...GENTLE_SWAY_AMPLITUDE), freqHz: rng.range(...GENTLE_SWAY_FREQ), angleDeg: rng.range(-10, 10), phase: rng.range(0, 2 * Math.PI) };
}

/** How far a stroke takes the hand, ih: where it ends, measured from where it started. */
function strokeLength(spec: { peak: number; riseMs: number; plateauMs: number; fallMs: number }): number {
  const s = stroke(0, spec.riseMs, spec.plateauMs, spec.fallMs, spec.peak, [0, 1]);
  return s.offset(s.endMs)[1];
}

/** The follow-through: the hand comes back up by this share of the stroke's length (the rest stays below where it started), over this long, ms. */
const FOLLOW_THROUGH_SHARE: readonly [number, number] = [0.6, 0.75];
const FOLLOW_THROUGH_MS: readonly [number, number] = [400, 600];

/** A follow-through as drawn: the step that brings the hand back up, and what was drawn for it. */
interface FollowThrough {
  step: Extract<SessionStep, { kind: 'move' }>;
  /** Share of the stroke's length the hand comes back up by. */
  share: number;
  ms: number;
}

/**
 * The follow-through of a throw: once the stroke is over the hand comes back up by a share of the stroke's length,
 * over a few hundred milliseconds, while the yoyo is still on its way down. A hand left at the bottom of the
 * stroke hangs the pivot a whole stroke lower, and the sleeper with it, under the floor of the screen; a real
 * hand rarely stays there, it rebounds.
 */
function followThrough(rng: Random, strokeIh: number, share: readonly [number, number], ms: readonly [number, number]): FollowThrough {
  const drawnShare = rng.range(...share), drawnMs = rng.range(...ms);
  return { step: { kind: 'move', delta: [0, -drawnShare * strokeIh], ms: drawnMs }, share: drawnShare, ms: drawnMs };
}

/** Scenes carry one tag per follow-through, `follow-through=<share>/<ms>ms`: for the tests, and for whoever diagnoses a clip. */
export const FOLLOW_THROUGH_TAG = 'follow-through=';
const followThroughTag = (f: FollowThrough): string => `${FOLLOW_THROUGH_TAG}${f.share.toFixed(3)}/${f.ms.toFixed(0)}ms`;

// ---------------------------------------------------------------------------------------------
// «Ver demo»
// ---------------------------------------------------------------------------------------------

/**
 * The seed the app plays. Every seed gives a working demo (see `buildDemoSession`); this one fixes which
 * hand, which starting spot and which sway the person watching sees.
 */
export const DEMO_SEED = 2;

/**
 * The phases a demo that works walks through, in order: the yoyo ties on, is thrown, sleeps, is tugged,
 * returns, is caught and tied on again, and the same once more.
 */
export const DEMO_PHASES: readonly YoyoPhase[] = [
  'untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught',
  'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'tethered',
];

/** Where the demo hand starts: a little different for every seed. */
const DEMO_START_X_JITTER = 0.05;
/**
 * Height of the hand at rest, ih, with its jitter. The throw covers 0.26 ih: from here the hand ends at about 0.62
 * and even a big palm's wrist, up to 0.21 ih below the anchor, stays inside the frame (and out of the 0.04 ih edge
 * margin); each tug then takes the hand about 0.04 ih above where it started, so the fingertips (0.19 ih above
 * the anchor) stay out of the top margin too. Inside the default zone, which spans 0.2–0.6.
 */
const DEMO_START_Y = 0.36;
const DEMO_START_Y_JITTER = 0.02;
const DEMO_LEAD_MS = 300;
/** Hold before the first throw: the hand is perfectly still, so the yoyo ties on (≈ 0.45 s) and the throw starts from rest. */
const DEMO_HOLD_MS = 800;
/**
 * A firm throw, well above the 2.2 ih/s the demo promises, and a short one: 0.26 ih in 150 ms, with 50 ms at the
 * full speed (a camera frame and a half) and ramps of 50 ms either side, so the two consecutive fast intervals the
 * classifier asks for are far from its 1.2 ih/s limit.
 *
 * Short on purpose. The pivot follows the hand, and the yoyo reaches the end of its string (0.65 m) some 0.45 s
 * after the stroke starts, when the hand has had time to come back only a part of the way: the length of the stroke
 * is how far below the home the pivot still is at that moment. With the 0.40 ih stroke a longer plateau would give,
 * the sleeper dipped up to 6 cm under the floor as the string went taut; with this one it never goes below 8 cm
 * above it (and the throw detects as often: 179 first takes of 200, against 178).
 */
const DEMO_THROW = { peak: 2.6, riseMs: 50, plateauMs: 50, fallMs: 50 } as const;
/** The yoyo sleeps about 3 s before the tug (the follow-through, then this): first the hand sways gently with it (the balanceo), then it calms down. */
const DEMO_SWAY_MS = 1700;
/**
 * A calm hand before every tug, with no sway at all: the tug is judged against how still the hand was just before
 * it (robust speed and drift over 300 ms, drift over the last 200 ms), so the flick starts from a hand that has
 * been quiet for much longer than the 500 ms the classifier would settle for.
 */
const DEMO_CALM_MS = 800;
const DEMO_MIN_CALM_MS = 500;
/** A decisive flick, well above the 1.4 ih/s the demo promises, short so that it is over in three camera frames. */
const DEMO_TUG = { peak: 2, durationMs: 120 } as const;
const DEMO_WAIT_MS = 800;
const DEMO_RESET_MS = 1000;
const DEMO_FINAL_WAIT_MS = 1500;

/** What the demo promises, for the tests that hold it to it. */
export const DEMO_PROMISE = {
  /** Slowest throw, ih/s, and slowest tug. */
  minThrowPeak: 2.2,
  minTugPeak: 1.4,
  /** The hand holds this still, with no sway, before each tug, ms. */
  minCalmMs: DEMO_MIN_CALM_MS,
  /** After a throw the hand comes back up by this share of the stroke's length, over this long, ms. */
  followThroughShare: FOLLOW_THROUGH_SHARE,
  followThroughMs: FOLLOW_THROUGH_MS,
} as const;

/**
 * The scene behind «Ver demo»: the hand appears in the default zone and holds perfectly still for 0.8 s (the
 * yoyo ties on), throws firmly (2.6 ih/s) from rest, follows through (comes back up by 60–75 % of the stroke in
 * 0.4–0.6 s, while the yoyo descends), lets the yoyo sleep (1.7 s of gentle sway, then a calm hand for 0.8 s),
 * tugs decisively (2 ih/s), waits for the catch, and does it all once more. About 13 s. Deterministic in `seed`,
 * which picks the starting spot, the hand, the follow-through and the sway.
 *
 * Every gesture is as unambiguous as a person's can be: far above the classifier's thresholds, from a hand that
 * is still, with no sway in the 500 ms before a tug and none at all before a throw. The follow-through is what
 * keeps the sleeper on the screen: without it the pivot ends a whole stroke low and the yoyo hangs under the floor.
 */
export function demoSessionScene(seed: number): SessionScene {
  const rng = new Random(seed);
  const start: Vec2 = [DEFAULT_HOME_IMAGE[0] + rng.range(-DEMO_START_X_JITTER, DEMO_START_X_JITTER), DEMO_START_Y + rng.range(-DEMO_START_Y_JITTER, DEMO_START_Y_JITTER)];
  const strokeIh = strokeLength(DEMO_THROW);
  const tags = ['demo'];
  const round = (): SessionStep[] => {
    const follow = followThrough(rng, strokeIh, FOLLOW_THROUGH_SHARE, FOLLOW_THROUGH_MS);
    tags.push(followThroughTag(follow));
    return [
      { kind: 'launch', ...DEMO_THROW, reboundUp: 0 },
      follow.step,
      { kind: 'hold', ms: DEMO_SWAY_MS, sway: gentleSway(rng) },
      { kind: 'hold', ms: DEMO_CALM_MS },
      { kind: 'tug', ...DEMO_TUG },
      { kind: 'hold', ms: DEMO_WAIT_MS },
    ];
  };
  const steps: SessionStep[] = [
    { kind: 'appear', at: start, holdMs: DEMO_HOLD_MS },
    ...round(),
    // The hand settles back to exactly where it started while the yoyo winds in and is caught.
    { kind: 'move', to: start, ms: DEMO_RESET_MS },
    { kind: 'hold', ms: DEMO_WAIT_MS },
    ...round(),
    { kind: 'hold', ms: DEMO_FINAL_WAIT_MS },
  ];
  return sessionScene(steps, { leadMs: DEMO_LEAD_MS, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left', tags });
}

/** Render seeds tried, one per take, until a take works; the first or the second almost always does. */
const DEMO_MAX_TAKES = 32;
/** Mixes the render seed of one take into the next, far enough apart that every take is a fresh draw of the camera noise. */
const DEMO_TAKE_STRIDE = 0x9e3779b1;
const DEMO_RENDER_SEED = 0x5bd1e995;

/** Camera-noise seed of one take of the demo of `seed`. */
function demoRenderSeed(seed: number, take: number): number {
  return ((seed ^ DEMO_RENDER_SEED) + Math.imul(take, DEMO_TAKE_STRIDE)) >>> 0;
}

/** One take of the demo: the scene of `seed`, rendered with the camera noise of take number `take` (0 is the first). */
export function renderDemoTake(seed: number, take = 0): SyntheticClip {
  const clip = renderSession(demoSessionScene(seed), demoRenderSeed(seed, take), `demo-${seed}`);
  return { ...clip, tags: [...clip.tags, `take=${take}`] };
}

/**
 * The phases a fresh runtime visits when it plays `clip` at a 60 Hz render cadence, with the default config
 * unless told otherwise, repeats collapsed: what the person watching «Ver demo» would see the yoyo do.
 */
export function demoPhasesOf(clip: SyntheticClip, config: YoyoConfig = createConfig()): YoyoPhase[] {
  const phases: YoyoPhase[] = [];
  playThrough(clip, { config }, ({ phase }) => {
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  });
  return phases;
}

/** Does `clip` walk both rounds of the demo through a fresh runtime? */
export function walksBothRounds(clip: SyntheticClip, config: YoyoConfig = createConfig()): boolean {
  const phases = demoPhasesOf(clip, config);
  return phases.length === DEMO_PHASES.length && phases.every((phase, i) => phase === DEMO_PHASES[i]);
}

/**
 * The demo as the camera path would deliver it (see `demoSessionScene`): a replay with the PRD noise, a camera
 * with jitter, delay and dropped frames. Deterministic in `seed`, and it WORKS for every seed.
 *
 * Why it is validated rather than left to chance: the classifiers answer to the PRD's own thresholds, and those
 * sit close to the camera noise. A hand that is perfectly still still has a measured speed of σ ≈ 0.036 ih/s
 * over a 250 ms window against a limit of 0.1 ih/s, and the tug's calm test has a similar tail, so about one
 * gesture in thirty is missed whatever its strength (strengthening the gestures moves the rate by a point or two:
 * `demoSessionScene` already uses the firmest ones). A demo has four gestures, so about one take in eight would
 * stop halfway, and a demo that sometimes does not work is not a demo.
 *
 * So a take is the same scene under a different draw of the camera noise, and the demo is the first take that a
 * fresh runtime with the default config walks through both rounds. It is still a noisy replay, not a clean one,
 * and still deterministic in `seed`; the tag `take=N` says which take it is. Settings changed in «Ajustes» are
 * not seen here: under a tighter threshold the replay can still miss a gesture, as a real hand could.
 */
export function buildDemoSession(seed: number): SyntheticClip {
  let take = 0;
  let clip = renderDemoTake(seed, take);
  while (!walksBothRounds(clip) && take + 1 < DEMO_MAX_TAKES) clip = renderDemoTake(seed, ++take);
  return clip;
}

// ---------------------------------------------------------------------------------------------
// Browser QA: the session a fake camera plays
// ---------------------------------------------------------------------------------------------

/**
 * The phases the QA session walks: the same two rounds as the demo. The hand leaving through the bottom in the
 * second round adds none, because a yoyo that sleeps keeps sleeping while the hand is away (Y-07).
 */
export const QA_PHASES: readonly YoyoPhase[] = DEMO_PHASES;

/**
 * The events a session that walks `QA_PHASES` shows, in order (`QaTimeline.events`): the tie-on, then a throw, the
 * string going taut, a tug, the catch and the yoyo tied on again, twice.
 */
export const QA_EVENTS: readonly YoyoEventKind[] = ['tether', 'launch', 'snap', 'tug', 'catch', 'retether', 'launch', 'snap', 'tug', 'catch', 'retether'];

/** A seed for a hook that has no preference: every seed works. */
export const QA_SEED = 1;

/** Keeps the draws of a QA scene apart from those of the demo scene of the same seed. */
const QA_STREAM = 0x51a7;
/** The hand rests at the centre of the standing framing zone, a little off it for every seed, ih. */
const QA_START_JITTER: Vec2 = [0.03, 0.02];
const QA_LEAD_MS = 400;
/** The hand holds inside the zone this long: the yoyo ties on after about 0.45 s of it, and the page gets to show it tethered. */
const QA_TIE_ON_HOLD_MS = 2500;
/**
 * The same short, firm throw as the demo's: from the zone's centre (0.4 ih) it ends at about 0.66, so even a big
 * palm's wrist stays under the 0.96 ih edge limit and the only edge this session touches is the exit it is about.
 */
const QA_THROW = DEMO_THROW;
/** Sleep before the tug of each round, swaying gently, ms. */
const QA_SLEEP_MS = [2600, 1600] as const;
const QA_CALM_MS = 800;
const QA_TUG = DEMO_TUG;
const QA_CATCH_WAIT_MS = 1200;
const QA_RESET_MS = 800;
const QA_HOLD_AFTER_CATCH_MS = 2300;
/** The hand is back from the exit and calm this long before the tug of round two (the tug wants 0.5 s of calm). */
const QA_CALM_AFTER_EXIT_MS = 1000;
const QA_FINAL_HOLD_MS = 4000;
/** Out through the bottom at this speed (ih/s), staying out a moment and coming back up over `returnMs`: about 0.6 s without a hand in view. */
const QA_EXIT = { speed: 1.2, returnMs: 400 } as const;
const QA_EXIT_STAY_MS = 40;
/** Edge flags are expected from this long before the camera loses the hand (its wrist reaches the border first) to this long after it is back. */
const QA_EDGE_SLACK_MS = 300;
/** Takes tried before `buildQaCameraSession` gives up. */
const QA_MAX_TAKES = 32;

/**
 * The scene of the browser QA session: the hand comes in and rests inside the standing framing zone (centre
 * x = 2/3 ih, y = 0.40 ih) until the yoyo ties on, throws, follows through, lets it sleep, tugs, waits for the
 * catch and holds; then throws again and, while the yoyo sleeps, goes out through the bottom for about 0.6 s,
 * comes back, tugs and waits for the catch. About 20 s. Deterministic in `seed`, which picks the resting spot
 * (a few centimetres around the centre), the hand, the follow-through and the sways.
 */
export function qaSessionScene(seed: number): SessionScene {
  const rng = new Random(seed + QA_STREAM);
  const centre = zoneCentre(framingZone('standing'));
  const start: Vec2 = [centre[0] + rng.range(-QA_START_JITTER[0], QA_START_JITTER[0]), centre[1] + rng.range(-QA_START_JITTER[1], QA_START_JITTER[1])];
  const strokeIh = strokeLength(QA_THROW);
  const tags = ['qa'];
  const throwAndFollow = (): SessionStep[] => {
    const follow = followThrough(rng, strokeIh, FOLLOW_THROUGH_SHARE, FOLLOW_THROUGH_MS);
    tags.push(followThroughTag(follow));
    return [{ kind: 'launch', ...QA_THROW, reboundUp: 0 }, follow.step];
  };
  const steps: SessionStep[] = [
    { kind: 'appear', at: start, holdMs: QA_TIE_ON_HOLD_MS },
    // Round one: the hand stays in view the whole time.
    ...throwAndFollow(),
    { kind: 'hold', ms: QA_SLEEP_MS[0], sway: gentleSway(rng) },
    { kind: 'hold', ms: QA_CALM_MS },
    { kind: 'tug', ...QA_TUG },
    { kind: 'hold', ms: QA_CATCH_WAIT_MS },
    { kind: 'move', to: start, ms: QA_RESET_MS },
    { kind: 'hold', ms: QA_HOLD_AFTER_CATCH_MS },
    // Round two: the hand leaves through the bottom while the yoyo sleeps, and comes back.
    ...throwAndFollow(),
    { kind: 'hold', ms: QA_SLEEP_MS[1], sway: gentleSway(rng) },
    { kind: 'lose', ms: QA_EXIT_STAY_MS, exit: QA_EXIT },
    { kind: 'hold', ms: QA_CALM_AFTER_EXIT_MS },
    { kind: 'tug', ...QA_TUG },
    { kind: 'hold', ms: QA_FINAL_HOLD_MS },
  ];
  return sessionScene(steps, { leadMs: QA_LEAD_MS, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left', tags });
}

/** A stretch of the app clock (ms from 0, the clock frames arrive on) in which the yoyo is in `phase`. */
export interface QaPhaseSpan { phase: YoyoPhase; fromMs: number; toMs: number }
/** When the runtime said something happened (app clock): tether, launch, snap, tug, catch, retether… The hand's coming and going is not in here, see `edges`. */
export interface QaEventAt { kind: YoyoEventKind; atMs: number }
/** A stretch of the app clock in which the runtime reported the hand at the border of the frame (the vignette): from the first render frame that flagged it to the last. */
export interface QaEdgeSpan { edge: FrameEdge; fromMs: number; toMs: number }

/**
 * What a fresh runtime does with the session, as the page would see it: the app clock is the clock the frames
 * arrive on, ms from 0 (`advance(arrivalMs)` at 60 Hz), so a page that plays the frames at `t0 + arrivalMs` sees
 * the same things at about `t0 + atMs`. A real page runs its own render clock, so compare with a tolerance of
 * a hundred milliseconds or so, never exactly.
 */
export interface QaTimeline {
  /** The phases in order, each with the span in which the runtime showed it; `QA_PHASES` says which. */
  phases: QaPhaseSpan[];
  /** The game events in order, `QA_EVENTS` says which; the hand's coming and going is not among them. */
  events: QaEventAt[];
  /** One span, 'bottom': the hand leaving through the bottom. No other edge is ever flagged. */
  edges: QaEdgeSpan[];
}

/**
 * The browser QA session: the frames of a fake camera, replacing the landmarks the page would get from the
 * model, plus what a page that plays them must see. Same shape as `buildDemoSession`'s clip (`frames` are
 * `DeliveredFrame`s: a `HandFrame` and the time it arrives, both in ms from 0, the start of the scene) with the
 * ground truth added.
 */
export interface QaCameraSession extends SyntheticClip {
  seed: number;
  /** Which draw of the camera noise this is; 0 is the first (see `buildQaCameraSession`). */
  take: number;
  /**
   * Spans of the scene in which no hand is in the frames (capture time, ms from 0): the lead-in, and the one with
   * `exit: true` where the hand left through the bottom. Frames inside carry `hands: []`. Around the exit the camera
   * may lose the hand a frame or two sooner (its wrist leaves the frame before the knuckle), as a real one does, so
   * the span is exact for the scene and approximate, to a tenth of a second, for the frames.
   */
  absences: Absence[];
  timeline: QaTimeline;
}

/** Camera-noise seed of one take of the QA session of `seed`. */
function qaRenderSeed(seed: number, take: number): number {
  return ((seed ^ DEMO_RENDER_SEED ^ QA_STREAM) + Math.imul(take, DEMO_TAKE_STRIDE)) >>> 0;
}

/** One take of the QA session: its scene, rendered with the camera noise of take number `take` (0 is the first). */
export function renderQaTake(seed: number, take = 0, scene: SessionScene = qaSessionScene(seed)): SyntheticClip {
  const clip = renderSession(scene, qaRenderSeed(seed, take), `qa-${seed}`);
  return { ...clip, tags: [...clip.tags, `take=${take}`] };
}

/**
 * Plays a take of the QA session through a fresh runtime the way the browser does (the default config, the
 * standing framing zone set) and draws its timeline. `walks` says whether it is the session the QA promises: the
 * phases of `QA_PHASES` and the events of `QA_EVENTS` in order; one span of the bottom edge, reported on every
 * render frame in which the hand is out of view during the exit and on no frame outside it; no other border flagged.
 */
export function qaCheckTake(clip: SyntheticClip, scene: SessionScene, config: YoyoConfig = createConfig()): { timeline: QaTimeline; walks: boolean; problems: string[] } {
  const phases: QaPhaseSpan[] = [], events: QaEventAt[] = [], edges: QaEdgeSpan[] = [];
  const exit = scene.absences.find(a => a.exit);
  const inExit = (ms: number): boolean => exit !== undefined && ms >= exit.startMs - QA_EDGE_SLACK_MS && ms <= exit.endMs + QA_EDGE_SLACK_MS;
  let absentInExit = 0, absentWithoutEdge = 0, strayEdges = 0, lastMs = 0;
  let openEdge: QaEdgeSpan | null = null;
  playThrough(clip, { config, zone: framingZone('standing') }, s => {
    lastMs = s.timeMs;
    const phase = phases[phases.length - 1];
    if (phase === undefined || phase.phase !== s.phase) {
      if (phase) phase.toMs = s.timeMs;
      phases.push({ phase: s.phase, fromMs: s.timeMs, toMs: s.timeMs });
    }
    for (const e of s.events) if (e.kind !== 'hand-lost' && e.kind !== 'hand-found') events.push({ kind: e.kind, atMs: e.timeMs });
    if (s.hand.edge === null) {
      openEdge = null;
    } else if (openEdge !== null && openEdge.edge === s.hand.edge) {
      openEdge.toMs = s.timeMs;
    } else {
      openEdge = { edge: s.hand.edge, fromMs: s.timeMs, toMs: s.timeMs };
      edges.push(openEdge);
    }
    if (s.hand.edge !== null && !inExit(s.timeMs)) strayEdges++;
    if (!s.hand.present && inExit(s.timeMs)) {
      absentInExit++;
      if (s.hand.edge !== 'bottom') absentWithoutEdge++;
    }
  });
  if (phases.length > 0) phases[phases.length - 1].toMs = lastMs;

  const problems: string[] = [];
  const walked = phases.map(p => p.phase);
  if (walked.length !== QA_PHASES.length || walked.some((phase, i) => phase !== QA_PHASES[i])) problems.push(`phases ${walked.join(' > ')}`);
  const happened = events.map(e => e.kind);
  if (happened.length !== QA_EVENTS.length || happened.some((kind, i) => kind !== QA_EVENTS[i])) problems.push(`events ${happened.join(' > ')}`);
  if (exit === undefined) problems.push('the scene has no exit through the bottom');
  else if (absentInExit === 0) problems.push('the runtime never saw the hand leave');
  if (absentWithoutEdge > 0) problems.push(`${absentWithoutEdge} render frames out of view without the bottom edge`);
  if (strayEdges > 0) problems.push(`${strayEdges} render frames flag an edge outside the exit`);
  if (edges.some(e => e.edge !== 'bottom')) problems.push('an edge other than the bottom was flagged');
  if (exit !== undefined && edges.length !== 1) problems.push(`${edges.length} spans of edge instead of one`);
  return { timeline: { phases, events, edges }, walks: problems.length === 0, problems };
}

/**
 * The browser QA session for `seed` (see `QaCameraSession`), validated like the demo: a take is the same scene
 * under another draw of the camera noise, and the session is the first take whose replay through a fresh
 * runtime walks the promised phases, events and edge (`qaCheckTake`). The PRD thresholds sit close to the camera
 * noise, so roughly one take in ten needs a retake; every seed has a working one. Deterministic in `seed`; the tag
 * `take=N` says which take it is. Throws if no take of the first 32 works, which would be a bug in the session,
 * not luck: a QA hook must not play a session that does not do what the test asserts.
 *
 * For a hook that replaces the landmarks of a fake camera's frames: deliver each of `frames` at `t0 + arrivalMs`
 * (it was captured at `t0 + frame.timestampMs`) with its `hands` as they are: 21 landmarks in the normalized image
 * coordinates the camera path hands over, or `[]` while the hand is out of view. About 20 s in which the yoyo ties
 * on, is thrown, sleeps, is tugged and is caught, twice, the second time after the hand left through the bottom for
 * about 0.6 s; `timeline` says in which order, and when, a page that plays it should see all that.
 */
export function buildQaCameraSession(seed: number): QaCameraSession {
  const scene = qaSessionScene(seed);
  let lastProblems: string[] = [];
  for (let take = 0; take < QA_MAX_TAKES; take++) {
    const clip = renderQaTake(seed, take, scene);
    const { timeline, walks, problems } = qaCheckTake(clip, scene);
    if (walks) return { ...clip, seed, take, absences: scene.absences, timeline };
    lastProblems = problems;
  }
  throw new Error(`QA camera session ${seed}: none of ${QA_MAX_TAKES} takes walks the promised phases and edge (last: ${lastProblems.join('; ')})`);
}

// ---------------------------------------------------------------------------------------------
// Mouse parity and replay files
// ---------------------------------------------------------------------------------------------

/** Pointer events per second of a scripted mouse: a mouse reports far faster than the 30 Hz the driver resamples to. */
const POINTER_EVENT_HZ = 120;

/** The spans of the scene in which the hand is in view. */
function presenceSpans(scene: SessionScene): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let from = 0;
  for (const a of scene.absences) {
    if (a.startMs > from) spans.push([from, a.startMs]);
    from = Math.max(from, a.endMs);
  }
  if (from < scene.durationMs) spans.push([from, scene.durationMs]);
  return spans;
}

/**
 * The same noise-free anchor path as a pointer script (client pixels, for `runPointerScript` or
 * Playwright): the button goes down where the hand appears, follows the path, and is released where
 * the hand is lost; a hand that reappears is a new press. The camera's mirrored image and the
 * viewport share their axes (x to the right on screen, y down), so the numbers are the same, only
 * scaled by the element's height. A mouse is a replay without tracking noise: the pipeline's answer
 * to this script says what physics and intents do when perception is perfect.
 */
export function pointerScriptFromScene(scene: SessionScene, rect: PointerRect, options: { eventHz?: number } = {}): PointerScriptStep[] {
  const eventHz = options.eventHz ?? POINTER_EVENT_HZ;
  const at = (t: number) => {
    const [x, y] = scene.anchorAt(t);
    return { t, x: rect.left + x * rect.height, y: rect.top + y * rect.height };
  };
  const steps: PointerScriptStep[] = [];
  for (const [from, to] of presenceSpans(scene)) {
    steps.push({ ...at(from), down: true });
    // Times are written like the driver's grid times (multiply first), so events stay exact.
    for (let k = 1; from + (k * 1000) / eventHz < to; k++) steps.push(at(from + (k * 1000) / eventHz));
    // The session simply ends while the hand is still there; only a loss releases the button.
    if (to < scene.durationMs) steps.push({ ...at(to), up: true });
  }
  return steps;
}

/** A clip as a replay file (landmarks only, never images): what the opt-in recorder would have written. */
export function toReplayFile(clip: SyntheticClip, note?: string): ReplayFile {
  return {
    schema: 'yoyo-replay/1',
    ...(note !== undefined ? { note } : {}),
    frames: clip.frames.map(({ frame, arrivalMs }) => ({
      t: frame.timestampMs,
      a: arrivalMs,
      hands: frame.hands.map(hand => ({ h: hand.handedness, lm: hand.landmarks.map(p => [p.x, p.y, p.z] as [number, number, number]) })),
    })),
    labels: clip.labels.map(l => ({ kind: l.kind, onsetMs: l.onsetMs })),
  };
}
