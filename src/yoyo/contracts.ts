import type { HandFrame } from '../shared/contracts';

/**
 * Yoyó contracts. Two coordinate spaces that are never mixed:
 *
 * - Image space, in image heights ("ih"): mirrored exactly once so x grows to the user's right
 *   on screen and y grows downward. A 4:3 camera frame spans x ∈ [0, 4/3], y ∈ [0, 1]. For the
 *   mouse the "image" is the viewport (x, y in viewport heights). Perception and the intent
 *   classifiers work here, on raw samples.
 * - World space, in metres: x right, y up, z toward the viewer. Phase 1 lives on the hard plane
 *   z = 0; the floor is y = 0. Physics and rendering work here.
 *
 * Timestamps are monotonic milliseconds. Capture time (when the camera saw it) and arrival time
 * (when the app could use it) are kept apart so latency can be measured instead of guessed.
 */

export type Vec2 = readonly [number, number];

export type InputSource = 'camera' | 'replay' | 'mouse';

export type FrameEdge = 'bottom' | 'top' | 'left' | 'right';

/** One raw observation of the throwing hand's anchor (landmark 9, middle-finger MCP), image space. */
export interface AnchorSample {
  /** Capture time of the frame or pointer sample. */
  timestampMs: number;
  /** When the app received it (capture + tracking latency). Equals timestampMs for the mouse. */
  arrivalMs: number;
  source: InputSource;
  /** Mirrored image position of the anchor, ih. */
  x: number;
  y: number;
  /** Apparent wrist→knuckles size, ih (0 for the mouse). */
  palmSize: number;
  /**
   * False when this sample does not continue the previous one: first sample, identity change,
   * discontinuous jump or a gap longer than perception.strokeGapMs. Nobody differences across it.
   */
  continuous: boolean;
  /** The hand touches a frame edge (bottom wins). Absent for the mouse. */
  edge?: FrameEdge;
  /** 21 mirrored landmarks, ih, only for drawing the hand. Absent for the mouse. */
  landmarks?: readonly Vec2[];
}

/** Result of reading one HandFrame: the tracked hand's sample, or its absence. */
export type AnchorObservation =
  | { kind: 'sample'; sample: AnchorSample }
  | { kind: 'absent'; timestampMs: number; arrivalMs: number; source: InputSource; exitEdge?: FrameEdge };

export type IntentKind = 'launch' | 'tug';

/** A classified intent, fired on the sample whose arrival made it certain. */
export interface IntentEvent {
  kind: IntentKind;
  /** Capture time of the triggering sample. */
  timestampMs: number;
  /** Arrival time of the triggering sample: the earliest moment the app could react. */
  arrivalMs: number;
  /** Peak speed along the gesture over the detection window, ih/s. Modulates, never gates, the response. */
  strength: number;
}

/** Which intents the yoyo currently accepts. Classifiers stay silent for unarmed kinds. */
export interface ArmedIntents { launch: boolean; tug: boolean }

/** Intent classifier over raw image-space samples (launch, tug, refractory period). */
export interface IntentClassifierLike {
  push(sample: AnchorSample, armed: ArmedIntents): IntentEvent | null;
  /**
   * The tracked hand vanished. A hard throw often carries the hand out through the bottom edge
   * before a second fast interval exists, so this may complete such a launch. Clears the motion
   * history but keeps the refractory timer, so a hand that comes back cannot double-fire.
   */
  absent(timestampMs: number, arrivalMs: number, exitEdge: FrameEdge | undefined, armed: ArmedIntents): IntentEvent | null;
  /** Forget all history, refractory included: pause, recalibration. */
  reset(): void;
}

/**
 * Yoyo phases. UI names: untethered «sin atar», tethered «atado», rolling «rodando»,
 * sleeping «durmiendo», returning «enrollando», caught «atrapado», exhausted «giro agotado».
 * No physics step runs while untethered.
 */
export type YoyoPhase = 'untethered' | 'tethered' | 'rolling' | 'sleeping' | 'returning' | 'caught' | 'exhausted';

/** Responsive yoyos return on a tug; unresponsive ones need a bind (phase 3, not implemented yet). */
export type Responsiveness = 'responsive' | 'unresponsive';

/** Discrete happenings of a step; they drive sound, hit-stop, UI and metrics. */
export type YoyoEventKind =
  | 'tether' | 'launch' | 'snap' | 'tug' | 'auto-return' | 'catch' | 'retether'
  | 'exhausted' | 'return-failed' | 'hand-lost' | 'hand-found';

export interface YoyoEvent {
  kind: YoyoEventKind;
  /** Simulation time at which it happened. */
  timeMs: number;
  /** Launch or tug speed (ih/s), snap/catch impact speed (m/s); meaning depends on kind. */
  strength?: number;
  /** Capture time of the input that caused it, for intent→reaction latency. */
  causeMs?: number;
}

/** Kinematic pivot of the string (stabilised anchor), world. */
export interface PinState { x: number; y: number; vx: number; vy: number }

/** Reduced-model state. Spin is a magnitude; its sense never matters in phase 1. */
export interface YoyoModelState {
  phase: YoyoPhase;
  /** Yoyo centre (m) and velocity (m/s). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Exposed string length L, m. */
  length: number;
  /** Spin ω ≥ 0, rad/s, and the accumulated angle used only for drawing. */
  spin: number;
  spinAngle: number;
  /** String tension, N; 0 while slack. */
  tension: number;
  slack: boolean;
  /** Time spent in the current phase, ms. */
  phaseMs: number;
}

/** Maps mirrored image positions (ih) to world metres around the calibrated home. */
export interface WorldMapping {
  /** Metres of world per image height. */
  scale: number;
  /** Image position (ih) that maps to homeWorld. */
  homeImage: Vec2;
  homeWorld: Vec2;
}

export interface HandView {
  /** Fresh data is arriving for the tracked hand. */
  present: boolean;
  /** Milliseconds since the last fresh sample (0 while present). */
  lostMs: number;
  /** Edge the hand touches or left through. */
  edge: FrameEdge | null;
  /** 21 world-space landmarks for the silhouette; null for the mouse or when never seen. */
  landmarks: readonly Vec2[] | null;
  /** Calibrated palm size in world metres (for silhouette thickness); 0 when unknown. */
  palmWorld: number;
}

/** Everything the renderer, audio and UI need for one frame. Plain data; never mutated after return. */
export interface YoyoSnapshot {
  /** Simulation clock, ms (same timebase as samples). */
  timeMs: number;
  phase: YoyoPhase;
  responsiveness: Responsiveness;
  pivot: Vec2;
  pivotVelocity: Vec2;
  yoyo: Vec2;
  yoyoVelocity: Vec2;
  length: number;
  maxLength: number;
  spin: number;
  spinAngle: number;
  tension: number;
  slack: boolean;
  hand: HandView;
  paused: boolean;
  /** Events emitted since the previous snapshot, oldest first. */
  events: readonly YoyoEvent[];
  /** Fixed physics steps run during the last advance, and wall time dropped by the step cap. */
  steps: number;
  droppedMs: number;
}

/** Local-only counters. Never sent anywhere; exportable only by an explicit user action. */
export interface YoyoMetrics {
  sessionMs: number;
  firstLaunchMs: number | null;
  launches: number;
  tugs: number;
  catches: number;
  autoReturns: number;
  exhausted: number;
  /** Tugs that ended in a catch / all tugs. NaN before the first tug. */
  tugSuccessRate: number;
  /** Intents classified while not armed (ignored), a proxy for false triggers. */
  ignoredIntents: number;
  handLosses: number;
  /** Capture→render latencies of intent reactions, ms (bounded ring). */
  reactionLatencyMs: readonly number[];
}

/** World rectangle visible on the z = 0 plane, metres. */
export interface WorldRect { left: number; right: number; bottom: number; top: number }

/** Framing guide drawn during calibration: where the hand should go, in world space. */
export interface FramingGuide { center: Vec2; halfSize: Vec2 }

/** What the page needs from a renderer (phase 1: three.js on WebGL2, built from scratch). */
export interface YoyoRendererLike {
  /** Draws one frame. nowMs drives render-only effects (hit-stop, shake, string overshoot). */
  render(snapshot: YoyoSnapshot, nowMs: number): void;
  setColor(hex: string): void;
  /** prefers-reduced-motion: no shake, no hit-stop, no overshoot. */
  setReducedMotion(reduced: boolean): void;
  setGuide(guide: FramingGuide | null): void;
  resize(): void;
  /** Visible world at z = 0; the mouse mapping and the framing guide derive from it. */
  visibleWorld(): WorldRect;
  /** Pixel ratio currently used (adaptive quality), for diagnostics. */
  readonly pixelRatio: number;
  onContextLost?: () => void;
  dispose(): void;
}

/** Procedural Web Audio for the yoyo (phase 1). Silent until unlocked by a user gesture. */
export interface YoyoAudioLike {
  /** Creates or resumes the AudioContext; call only from a user gesture handler. */
  unlock(): void;
  setMuted(muted: boolean): void;
  /** 0..1, applied to the master gain. */
  setVolume(volume: number): void;
  /** Once per rendered frame: plays the snapshot's events and steers the hum from spin. */
  update(snapshot: YoyoSnapshot, nowMs: number): void;
  suspend(): void;
  resume(): void;
  close(): void;
}

/**
 * File written by the opt-in recorder and read back as a regression fixture.
 * Landmarks only, never images; nothing personal is filled in automatically.
 */
export interface ReplayFile {
  schema: 'yoyo-replay/1';
  /** Optional free text the user types before downloading. */
  note?: string;
  /** Effective config while recording, so classifier behaviour can be reproduced. */
  config?: unknown;
  /** t: capture ms, a: arrival ms (monotonic, relative to the first frame); lm: 21 × [x, y, z] normalized. */
  frames: Array<{ t: number; a: number; hands: Array<{ h: 'Left' | 'Right' | 'Unknown'; lm: Array<[number, number, number]> }> }>;
  /** What the live classifier fired while recording; not ground truth. */
  detected?: Array<{ kind: IntentKind; t: number }>;
  /** Ground-truth gesture onsets (capture ms), added later by hand; enable precision/recall on real data. */
  labels?: Array<{ kind: IntentKind; onsetMs: number }>;
}

/** Headless core that the browser engine, replays and tests all drive the same way. */
export interface YoyoRuntimeLike {
  /** Camera or replay frame, delivered at arrivalMs. */
  pushFrame(frame: HandFrame, arrivalMs: number): void;
  /** Mouse path: an already-resampled anchor sample, or null when the button is up. */
  pushPointer(sample: AnchorSample | null, timeMs: number): void;
  /** Run fixed steps up to nowMs (at most sim.maxStepsPerFrame) and report. */
  advance(nowMs: number): YoyoSnapshot;
}
