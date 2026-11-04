import { createConfig, setConfigValue, type YoyoConfig } from '../config';
import type { InputSource, IntentEvent, Vec2, WorldMapping, YoyoEvent, YoyoEventKind, YoyoPhase, YoyoSnapshot } from '../contracts';
import { MouseDriver, type PointerRect, type PointerScriptStep } from '../input/MouseDriver';
import { mappingFromHome } from '../perception/worldMapping';
import { matchDetections, percentiles, runFrames } from '../replay/evaluate';
import { Random } from '../replay/random';
import { parseReplay, replayFrames, serializeReplay } from '../replay/replayFile';
import {
  buildDemoSession, buildQaCameraSession, DEMO_SEED, pointerScriptFromScene, qaCheckTake, qaSessionScene, renderCleanSession, renderDemoTake, renderQaTake,
  renderSession, replayClip, sessionScene, toReplayFile, walksBothRounds,
  type QaCameraSession, type SessionScene, type SessionStep, type SwaySpec,
} from '../replay/sessions';
import { FRAME_MS, randomPalm, type DeliveredFrame, type GestureLabel, type SyntheticClip } from '../replay/synthetic';
import { framingZone } from './framing';
import { MIN_HAND_LOSS_MS } from './MetricsRecorder';
import { DEFAULT_HOME_IMAGE, DEFAULT_TETHER_ZONE, type TetherZone } from './TetherDetector';
import { YoyoRuntime } from './YoyoRuntime';

/**
 * End-to-end scenarios for the headless runtime (PRD_YOYO.md §9, criteria Y-01 .. Y-09, Y-11 and the
 * full-pipeline half of Y-S4). Every one is SYNTHETIC evidence: sessions generated with the PRD §8.2
 * camera noise (jitter, dropped frames, 50 ms of delay) or a noise-free mouse script, driven through
 * the runtime at a 60 Hz render cadence. No webcam, no GPU, no human: they say the pipeline behaves
 * on that noise model, not that it works in Luis's hands.
 *
 * The scenarios live here, apart from the vitest file and the CLI script, so both run exactly the
 * same code: the suite asserts each `Check`, the script prints them and writes the numbers.
 *
 * Deterministic: every scene, noise draw and render time derives from fixed seeds.
 */

export type Evidence = 'synthetic';

/** One verdict of a scenario: a PRD condition, the measured value and whether it holds. */
export interface Check {
  /** Stable key, used to declare a known gap. */
  id: string;
  name: string;
  pass: boolean;
  /** What was measured and against which limit. */
  detail: string;
  /**
   * Set when the condition is NOT met and that is known and reported. The suite encodes it as
   * `it.fails`, so it cannot be forgotten: the day it passes, the suite goes red until the mark goes.
   */
  knownGap?: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  evidence: Evidence;
  checks: Check[];
  /** Every number measured, for the JSON report. */
  numbers: Record<string, unknown>;
}

/**
 * Conditions that are NOT met, known, measured and reported to the owner of the module that decides
 * them (never hidden, never weakened): check id → why. The suite runs each as `it.fails`, the script
 * prints it as a known gap, and both turn red the day the check starts to pass, so the mark cannot
 * outlive the gap.
 */
export const KNOWN_GAPS: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'Y-02:noisy-recall-1.5',
    'Perception (IntentClassifier). A 1.5 ih/s stroke, the lower bound of the PRD range, is detected in about 70 % of the noisy runs: the rule «two consecutive intervals ≥ 1.2 ih/s» sits at 80 % of that peak, with ±0.28 ih/s of jitter per interval. Over the whole 1.5–3 m/s range recall is 94 % (Y-02:noisy-range-recall).',
  ],
  [
    'Y-02:noisy-frames-1.5',
    'Perception (IntentClassifier). Same cause: at 1.5 ih/s the second fast interval often arrives a frame or two late (p95 4 frames). The whole-range p95 is 2 frames (Y-02:noisy-range-frames).',
  ],
  [
    'Y-04:noisy-recall-0.8',
    'Perception (IntentClassifier). A 0.8 ih/s flick of 120–200 ms rises 0.05–0.085 ih against a 0.04 ih threshold and 0.01 ih of jitter, and the classifier asks for more evidence than the PRD text (minSpeedFactor and friends): about 70 % are detected. Over the whole 0.8–1.6 m/s range recall is 89 % (Y-04:noisy-recall).',
  ],
  [
    'Y-04:noisy-decision-max',
    'Camera noise (PRD §8.2), not a module. The p95 of onset → decision meets the bar (Y-04:noisy-decision-p95). The one flick of 266 decided later (~135 ms) had two camera frames in a row dropped inside its stroke (the PRD §8.2 noise, 1 % pairs): its samples were about 100 ms apart and the classifier decided on the first frame captured after the gap. Y-04:late-decisions-are-camera-gaps checks that this is the cause of every late decision, so the mark cannot hide a slow classifier. On this noise model only a p95 reading of the PRD\'s «≤ 100 ms» can hold for every flick.',
  ],
  [
    'Y-04:scripted',
    'Perception (IntentClassifier). Two noise-free 0.8 ih/s, 100 ms flicks (0.043 ih long, right on the PRD threshold) are not detected: the extra evidence the classifier asks for (tug.minSpeedFactor: 1.4 × the PRD mean speed = 0.56 ih/s over the last three samples) rejects them. Every other scripted flick (0.8–1.6 ih/s, 100–200 ms, three angles) returns the yoyo.',
  ],
]);

const check = (id: string, name: string, pass: boolean, detail: string): Check => ({ id, name, pass, detail, ...(KNOWN_GAPS.has(id) ? { knownGap: KNOWN_GAPS.get(id) } : {}) });

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

/** Render cadence of every scenario: the app calls `advance` once per 60 Hz frame. */
export const RENDER_HZ = 60;
const RENDER_MS = 1000 / RENDER_HZ;
/** Time the scenario keeps rendering after its last input, ms. */
const TAIL_MS = 600;

/** One render frame of a played scenario. */
export interface Tick {
  nowMs: number;
  snapshot: YoyoSnapshot;
  /** Physics steps the model has run so far (stays 0 until the yoyo is tied on). */
  modelSteps: number;
  /** Fastest the yoyo moved at any physics step of this frame, m/s (`diagnostics.lastAdvancePeakSpeed`). */
  peakSpeed: number;
  /** Time the frame's physics steps covered, s: steps × step. The yoyo moves only while they run, not during time the cap dropped. */
  physicsS: number;
}

export interface IntentRecord {
  event: IntentEvent;
  accepted: boolean;
}

export interface PlayedEvent extends YoyoEvent {
  /** Render time of the snapshot that carried the event. */
  renderMs: number;
}

export interface Played {
  runtime: YoyoRuntime;
  ticks: Tick[];
  events: PlayedEvent[];
  intents: IntentRecord[];
}

interface RuntimeSetup {
  config?: YoyoConfig;
  zone?: TetherZone | null;
  source?: InputSource;
  pointerMapping?: WorldMapping;
}

interface RunOptions {
  /** Last render time; default: the last input plus TAIL_MS. */
  endMs?: number;
  /** Keep every tick (default). A long run turns it off and reads each tick through `onTick`. */
  keepTicks?: boolean;
  onTick?: (tick: Tick, runtime: YoyoRuntime) => void;
  /** Called before each render frame's inputs are pushed and before `advance`. */
  beforeTick?: (runtime: YoyoRuntime, nowMs: number, index: number) => void;
  /** Render time of frame k; default k × 1000/60. Must increase. */
  renderTime?: (index: number) => number;
}

/** What feeds the runtime in a scenario: pushes whatever is due by `nowMs`. */
interface InputDriver {
  pushDue(runtime: YoyoRuntime, nowMs: number): void;
  /** Time of the last input, ms. */
  endOfInput: number;
}

function frameDriver(frames: readonly DeliveredFrame[]): InputDriver {
  let next = 0;
  return {
    pushDue(runtime, nowMs) {
      while (next < frames.length && frames[next].arrivalMs <= nowMs) {
        runtime.pushFrame(frames[next].frame, frames[next].arrivalMs);
        next++;
      }
    },
    endOfInput: frames.length ? frames[frames.length - 1].arrivalMs : 0,
  };
}

/**
 * A scripted mouse: events are applied at their own times and polled right after, as `runPointerScript`
 * does, and the samples (and a button-up as a null sample) go to the runtime when the render frame that
 * covers them comes round.
 */
function pointerDriver(steps: readonly PointerScriptStep[], rect: PointerRect): InputDriver {
  const driver = new MouseDriver();
  let next = 0;
  return {
    pushDue(runtime, nowMs) {
      while (next < steps.length && steps[next].t <= nowMs) {
        const step = steps[next++];
        if (step.down) driver.down(step.x, step.y, step.t, rect);
        else if (step.up) driver.up(step.t);
        else driver.move(step.x, step.y, step.t);
        for (const sample of driver.poll(step.t)) runtime.pushPointer(sample, step.t);
        if (step.up) runtime.pushPointer(null, step.t);
      }
      // Between events the button may be held down: the driver keeps producing its 30 Hz samples.
      for (const sample of driver.poll(nowMs)) runtime.pushPointer(sample, nowMs);
    },
    endOfInput: steps.length ? steps[steps.length - 1].t : 0,
  };
}

function setup(s: RuntimeSetup): YoyoRuntime {
  const runtime = new YoyoRuntime(s.config ?? createConfig(), s.source ?? 'replay');
  if (s.zone !== undefined) runtime.setTetherZone(s.zone);
  if (s.pointerMapping) runtime.setPointerMapping(s.pointerMapping);
  return runtime;
}

function run(runtime: YoyoRuntime, driver: InputDriver, options: RunOptions = {}, stepS = 1 / createConfig().sim.hz): Played {
  const played: Played = { runtime, ticks: [], events: [], intents: [] };
  runtime.onIntent = (event, accepted) => played.intents.push({ event, accepted });
  const endMs = options.endMs ?? driver.endOfInput + TAIL_MS;
  const keep = options.keepTicks ?? true;
  const renderTime = options.renderTime ?? ((k: number) => k * RENDER_MS);
  for (let k = 0; ; k++) {
    const nowMs = renderTime(k);
    if (nowMs > endMs) break;
    options.beforeTick?.(runtime, nowMs, k);
    driver.pushDue(runtime, nowMs);
    const snapshot = runtime.advance(nowMs);
    const tick: Tick = { nowMs, snapshot, modelSteps: runtime.model.stepsTaken, peakSpeed: runtime.diagnostics.lastAdvancePeakSpeed, physicsS: snapshot.steps * stepS };
    if (keep) {
      played.ticks.push(tick);
      for (const event of snapshot.events) played.events.push({ ...event, renderMs: nowMs });
    }
    options.onTick?.(tick, runtime);
  }
  return played;
}

const stepSecondsOf = (s: RuntimeSetup): number => 1 / (s.config ?? createConfig()).sim.hz;

function playFrames(frames: readonly DeliveredFrame[], s: RuntimeSetup = {}, options: RunOptions = {}): Played {
  return run(setup(s), frameDriver(frames), options, stepSecondsOf(s));
}

function playPointer(steps: readonly PointerScriptStep[], s: RuntimeSetup = {}, options: RunOptions = {}): Played {
  return run(setup({ ...s, source: 'mouse' }), pointerDriver(steps, POINTER_RECT), options, stepSecondsOf(s));
}

/** An element that does not start at the page origin and is wider than tall, like the game canvas. */
const POINTER_RECT: PointerRect = { left: 100, top: 50, width: 1280, height: 720 };

// ---------------------------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------------------------

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const speedOf = (v: Vec2): number => Math.hypot(v[0], v[1]);
const fmt = (v: number, digits = 1): string => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');
const maxOf = (values: readonly number[]): number => values.reduce((m, v) => Math.max(m, v), -Infinity);
const minOf = (values: readonly number[]): number => values.reduce((m, v) => Math.min(m, v), Infinity);
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const finite = (values: readonly number[]): number[] => values.filter(Number.isFinite);
const share = (part: number, whole: number): number => (whole === 0 ? NaN : part / whole);
const pct = (v: number): string => `${fmt(v * 100)} %`;

function isFiniteSnapshot(s: YoyoSnapshot): boolean {
  const numbers = [
    s.timeMs, ...s.pivot, ...s.pivotVelocity, ...s.yoyo, ...s.yoyoVelocity, s.length, s.maxLength, s.spin, s.spinAngle, s.tension,
    s.hand.lostMs, s.hand.palmWorld, s.steps, s.droppedMs, ...(s.hand.landmarks ?? []).flat(),
  ];
  return numbers.every(Number.isFinite);
}

/** Phases in the order they were visited, repeats collapsed. */
function phaseSequence(ticks: readonly Tick[]): YoyoPhase[] {
  const out: YoyoPhase[] = [];
  for (const t of ticks) if (out[out.length - 1] !== t.snapshot.phase) out.push(t.snapshot.phase);
  return out;
}

const sameSequence = (a: readonly unknown[], b: readonly unknown[]): boolean => JSON.stringify(a) === JSON.stringify(b);

const eventsOf = (played: Played, kind: YoyoEventKind): PlayedEvent[] => played.events.filter(e => e.kind === kind);
const firstOf = (played: Played, kind: YoyoEventKind, afterMs = -Infinity): PlayedEvent | undefined => played.events.find(e => e.kind === kind && e.timeMs >= afterMs);
const lastTick = (played: Played): Tick => played.ticks[played.ticks.length - 1];

/**
 * Hand losses the metrics had counted when the hand was last in view. A scenario ends with the camera going
 * quiet, which is itself a loss that has lasted long enough by the time the last frame is rendered; asked a
 * moment earlier, the count is that of the scenario.
 */
function lossesCountedWhileInView(played: Played): number {
  const lastInView = [...played.ticks].reverse().find(t => t.snapshot.hand.present);
  return played.runtime.metrics.snapshot(lastInView ? lastInView.nowMs : lastTick(played).nowMs).handLosses;
}

/** Everything the runtime says other than hand presence. */
const gameEvents = (played: Played): YoyoEventKind[] => played.events.map(e => e.kind).filter(k => k !== 'hand-found' && k !== 'hand-lost');

/** Delivered frames from the labelled onset up to the frame that decided, 0 meaning that very frame (the Y-S2 count). */
function framesAfterOnset(frames: readonly DeliveredFrame[], onsetMs: number, causeMs: number): number {
  let n = 0;
  for (const f of frames) if (f.frame.timestampMs >= onsetMs && f.frame.timestampMs <= causeMs) n++;
  return n - 1;
}

/** The intent the classifier fired for a labelled gesture: the first of its kind inside the match window, as evaluate.ts matches. */
const MATCH_EARLY_MS = 100;
const MATCH_LATE_MS = 400;
function intentFor(played: Played, label: GestureLabel): IntentRecord | undefined {
  return played.intents.find(r => r.event.kind === label.kind
    && r.event.timestampMs >= label.onsetMs - MATCH_EARLY_MS && r.event.timestampMs <= label.onsetMs + MATCH_LATE_MS);
}

/** The first run of frames without a hand after `afterMs`: the last frame that carried one, the first empty one, and the first that carried one again. */
interface FrameGap {
  lastWithHand: DeliveredFrame;
  firstEmpty: DeliveredFrame;
  firstBack: DeliveredFrame | undefined;
}
function frameGapAfter(frames: readonly DeliveredFrame[], afterMs: number): FrameGap | undefined {
  const i = frames.findIndex(f => f.frame.timestampMs >= afterMs && f.frame.hands.length === 0);
  if (i <= 0) return undefined;
  let j = i;
  while (j < frames.length && frames[j].frame.hands.length === 0) j++;
  return { lastWithHand: frames[i - 1], firstEmpty: frames[i], firstBack: frames[j] };
}

function randomSway(rng: Random, amplitude: readonly [number, number] = [0.02, 0.06], freq: readonly [number, number] = [0.3, 1.2]): SwaySpec {
  return { amplitude: rng.range(...amplitude), freqHz: rng.range(...freq), angleDeg: rng.range(-17, 17), phase: rng.range(0, 2 * Math.PI) };
}

/** Where a throwing hand rests: high enough that the stroke and the hand that follows it stay in the frame. */
function restPosition(rng: Random): Vec2 {
  return [rng.range(0.55, 0.8), rng.range(0.28, 0.36)];
}

/** Stroke parameters of the corpus's launches (synthetic.ts), with the stroke length kept below `maxLength` so the hand stays in view. */
function strokeParams(rng: Random, peak: number, maxLength = 0.42) {
  const riseMs = rng.range(40, 80), fallMs = rng.range(60, 120);
  const plateauMs = Math.min(rng.range(30, 120), Math.max(20, (maxLength / peak) * 1000 - 0.5 * riseMs - 0.5 * fallMs));
  return { riseMs, plateauMs, fallMs, angleDeg: rng.range(-25, 25) };
}

/**
 * A throw nobody can miss, for scenarios whose subject is what happens after it: fast, with a long
 * enough plateau for two clear intervals, about straight down, and short enough to keep the hand in view.
 */
function firmLaunch(rng: Random): SessionStep {
  return { kind: 'launch', peak: rng.range(2.6, 3), riseMs: rng.range(40, 60), plateauMs: rng.range(40, 60), fallMs: rng.range(80, 100), angleDeg: rng.range(-15, 15) };
}

/** Seeds tried before a session whose throw did not take is given up on. */
const SETUP_TRIES = 6;
/** Step between the seeds of the retries: far apart, so the retry is a fresh draw, not a neighbour of the last. */
const SETUP_SEED_STRIDE = 100_003;

/**
 * Runs `attempt` until the session took (the throw it starts from put the yoyo to sleep), each time with a
 * fresh seed, and returns the last run either way together with how many tries it needed. A throw that the
 * noise happens to defeat is the subject of Y-02, not of the scenarios that only need a sleeping yoyo.
 */
function withSetup<T extends { slept: boolean }>(seed: number, attempt: (seed: number) => T): T & { tries: number } {
  let run = attempt(seed);
  let tries = 1;
  while (!run.slept && tries < SETUP_TRIES) run = attempt(seed + SETUP_SEED_STRIDE * tries++);
  return { ...run, tries };
}

const stats = (values: readonly number[]) => {
  const v = finite(values);
  const p = percentiles(v);
  return { count: p.count, min: minOf(v), p50: p.p50, p95: p.p95, max: p.max };
};

// ---------------------------------------------------------------------------------------------
// Y-01: tying on
// ---------------------------------------------------------------------------------------------

const TIE_ON_RUNS = 24;
const TIE_ON_MIN_MS = 400;
const TIE_ON_MAX_MS = 1000;
const MOVING_HAND_MS = 5000;
/** The hand must not jump on screen when the yoyo ties on inside a zone (fixed mapping), m. */
const NO_JUMP_M = 0.02;
/** Without a zone the pivot starts at the world home within this, m. */
const HOME_TOLERANCE_M = 0.01;
const SETTLE_LEAD_MS = 300;

/**
 * A hand that is already moving when it appears, comes to rest and holds still. `restMs` is when the
 * scripted motion ends. A decelerating hand has barely moved for a while before that, so `leftBallMs` is
 * the better «last moved» instant: the last time the noise-free hand was farther than half the stability
 * spread (about a centimetre) from where it ends up.
 */
function settlingSession(seed: number): { scene: SessionScene; restMs: number; leftBallMs: number; appearMs: number } {
  const rng = new Random(seed);
  const from: Vec2 = [rng.range(0.5, 0.85), rng.range(0.3, 0.5)];
  // A decisive motion, at least 0.2 ih: the hand is really moving until it stops.
  let to: Vec2 = [from[0] + 0.25, from[1]];
  for (let attempt = 0; attempt < 100; attempt++) {
    const a = rng.range(0, 2 * Math.PI), d = rng.range(0.2, 0.35);
    const candidate: Vec2 = [from[0] + d * Math.cos(a), from[1] + d * Math.sin(a)];
    if (candidate[0] >= 0.45 && candidate[0] <= 0.95 && candidate[1] >= 0.3 && candidate[1] <= 0.55) { to = candidate; break; }
  }
  const moveMs = rng.range(250, 450);
  const scene = sessionScene([
    { kind: 'appear', at: from, holdMs: 0 },
    { kind: 'move', to, ms: moveMs },
    { kind: 'hold', ms: 2000 },
  ], { leadMs: SETTLE_LEAD_MS, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left' });
  const restMs = SETTLE_LEAD_MS + moveMs;
  const ballRadius = createConfig().tether.stableSpread / 2;
  let leftBallMs = restMs;
  while (leftBallMs > SETTLE_LEAD_MS && dist(scene.anchorAt(leftBallMs), to) <= ballRadius) leftBallMs--;
  return { scene, restMs, leftBallMs, appearMs: SETTLE_LEAD_MS };
}

/** Hand motions that must keep the yoyo untied for 5 s: waving, circling, drifting to and fro, repositioning. */
function movingSessions(): Array<{ name: string; steps: SessionStep[] }> {
  const start: Vec2 = [0.67, 0.42];
  return [
    { name: 'wave 2.5 Hz', steps: [{ kind: 'appear', at: start, holdMs: 0 }, { kind: 'casual', motion: 'wave', ms: MOVING_HAND_MS }] },
    { name: 'circle 0.7 Hz', steps: [{ kind: 'appear', at: start, holdMs: 0 }, { kind: 'casual', motion: 'circle', ms: MOVING_HAND_MS, freqHz: 0.7, amplitude: 0.08 }] },
    {
      name: 'drift 0.25 ih/s to and fro',
      steps: [
        { kind: 'appear', at: [0.35, 0.42], holdMs: 0 },
        { kind: 'casual', motion: 'drift', ms: MOVING_HAND_MS / 2, speed: 0.25, angleDeg: 0 },
        { kind: 'casual', motion: 'drift', ms: MOVING_HAND_MS / 2, speed: 0.25, angleDeg: 180 },
      ],
    },
    {
      name: 'zigzag, 0.4 ih every 0.45 s',
      steps: [
        { kind: 'appear', at: start, holdMs: 0 },
        ...Array.from({ length: 12 }, (_, i): SessionStep => ({ kind: 'move', ms: 450, delta: [i % 2 === 0 ? 0.4 : -0.4, i % 2 === 0 ? 0.06 : -0.06] })),
      ],
    },
  ];
}

function y01(): ScenarioResult {
  const checks: Check[] = [];
  const numbers: Record<string, unknown> = {};

  // (a) After the hand comes to rest: tied on 400–1000 ms later, never earlier, and no physics before.
  const sinceRest: number[] = [], sinceAppear: number[] = [], sinceLeftBall: number[] = [];
  let stepsBeforeTie = 0, untied = 0;
  for (let seed = 1; seed <= TIE_ON_RUNS; seed++) {
    const { scene, restMs, leftBallMs, appearMs } = settlingSession(seed);
    const played = playFrames(renderSession(scene, 7000 + seed, `settle-${seed}`).frames);
    const tether = firstOf(played, 'tether');
    for (const t of played.ticks) if (t.snapshot.phase === 'untethered') stepsBeforeTie += t.modelSteps;
    if (!tether) { untied++; continue; }
    sinceRest.push(tether.timeMs - restMs);
    sinceLeftBall.push(tether.timeMs - leftBallMs);
    sinceAppear.push(tether.timeMs - appearMs);
  }
  numbers.tieOnAfterRestMs = stats(sinceRest);
  numbers.tieOnAfterLastMovedMs = stats(sinceLeftBall);
  numbers.tieOnAfterAppearMs = stats(sinceAppear);
  numbers.neverTied = untied;
  numbers.modelStepsBeforeTie = stepsBeforeTie;
  checks.push(check(
    'Y-01:tie-on-window',
    `ties on ${TIE_ON_MIN_MS}–${TIE_ON_MAX_MS} ms after a moving hand comes to rest (${TIE_ON_RUNS} noisy runs, app clock): never before ${TIE_ON_MIN_MS} ms after the hand last moved more than 1 cm from where it rests, and at most ${TIE_ON_MAX_MS} ms after the scripted rest`,
    untied === 0 && sinceLeftBall.length > 0 && minOf(sinceLeftBall) >= TIE_ON_MIN_MS && maxOf(sinceRest) <= TIE_ON_MAX_MS,
    `${sinceRest.length}/${TIE_ON_RUNS} tied on; after the hand last moved >1 cm: min ${fmt(minOf(sinceLeftBall))}, p50 ${fmt(percentiles(sinceLeftBall).p50)}, max ${fmt(maxOf(sinceLeftBall))} ms; after the scripted rest instant: min ${fmt(minOf(sinceRest))}, p50 ${fmt(percentiles(sinceRest).p50)}, max ${fmt(maxOf(sinceRest))} ms (the window tolerates the last ~0.04 ih of a decelerating hand)`,
  ));
  checks.push(check('Y-01:no-physics', 'no physics step before tie-on (model.stepsTaken === 0 while untethered)', stepsBeforeTie === 0, `${stepsBeforeTie} model steps seen while untethered over ${TIE_ON_RUNS} runs`));

  // (b) A hand that keeps moving never ties on, and no step runs while it does.
  const moving = movingSessions().map(({ name, steps }) => {
    const scene = sessionScene(steps, { leadMs: SETTLE_LEAD_MS, tags: [name] });
    const motionEndMs = SETTLE_LEAD_MS + MOVING_HAND_MS;
    const played = playFrames(renderSession(scene, 7100, `moving-${name}`).frames);
    const during = played.ticks.filter(t => t.nowMs <= motionEndMs);
    return {
      name,
      tethersWhileMoving: eventsOf(played, 'tether').filter(e => e.timeMs <= motionEndMs).length,
      phasesWhileMoving: [...new Set(during.map(t => t.snapshot.phase))].join(','),
      modelSteps: maxOf(during.map(t => t.modelSteps)),
      movedMs: Math.min(scene.durationMs, motionEndMs) - SETTLE_LEAD_MS,
    };
  });
  numbers.movingHand = moving;
  checks.push(check(
    'Y-01:moving-hand',
    `${MOVING_HAND_MS / 1000} s of a moving hand (wave, circle, drift, repositioning) never ties on and runs no model step`,
    moving.every(r => r.tethersWhileMoving === 0 && r.phasesWhileMoving === 'untethered' && r.modelSteps === 0 && r.movedMs >= MOVING_HAND_MS),
    moving.map(r => `${r.name}: ${r.tethersWhileMoving} tether(s), phases ${r.phasesWhileMoving}, ${r.modelSteps} steps`).join('; '),
  ));

  // (c) With a zone: no tie-on outside it, tie-on after entering it; the mapping is fixed so nothing jumps.
  const outside: Vec2 = [0.2, 0.4];
  const zoneScene = sessionScene([
    { kind: 'appear', at: outside, holdMs: 3000 },
    { kind: 'move', to: DEFAULT_HOME_IMAGE, ms: 400 },
    { kind: 'hold', ms: 2000 },
  ], { leadMs: SETTLE_LEAD_MS, tags: ['zone'] });
  const zonePlayed = playFrames(renderSession(zoneScene, 7200, 'zone').frames, { zone: DEFAULT_TETHER_ZONE });
  const zoneTether = firstOf(zonePlayed, 'tether');
  const enteredAt = SETTLE_LEAD_MS + 3000 + 400;
  numbers.zone = { tetherMs: zoneTether?.timeMs ?? null, enteredAtMs: enteredAt };
  checks.push(check(
    'Y-01:zone',
    `with a zone, 3 s of a still hand outside it never ties on; it ties on ${TIE_ON_MIN_MS}–${TIE_ON_MAX_MS} ms after coming to rest inside`,
    zoneTether !== undefined && zoneTether.timeMs - enteredAt >= TIE_ON_MIN_MS && zoneTether.timeMs - enteredAt <= TIE_ON_MAX_MS,
    `tied on at ${fmt(zoneTether?.timeMs ?? NaN, 0)} ms; the hand came to rest in the zone at ${enteredAt} ms (${fmt((zoneTether?.timeMs ?? NaN) - enteredAt, 0)} ms later)`,
  ));

  /** How far landmark 9 moved on screen across the frame in which the yoyo tied on. */
  const jump = (played: Played): number => {
    const k = played.ticks.findIndex(t => t.snapshot.events.some(e => e.kind === 'tether'));
    if (k < 1) return NaN;
    const before = played.ticks[k - 1].snapshot.hand.landmarks?.[9], after = played.ticks[k].snapshot.hand.landmarks?.[9];
    return before && after ? dist(before, after) : NaN;
  };
  const zoneJump = jump(zonePlayed);
  const freeScene = sessionScene([{ kind: 'appear', at: [0.55, 0.36], holdMs: 2500 }], { leadMs: SETTLE_LEAD_MS });
  const free = playFrames(renderSession(freeScene, 7201, 'free').frames);
  const freeTick = free.ticks.find(t => t.snapshot.events.some(e => e.kind === 'tether'));
  const home = createConfig().world;
  const homeError = freeTick ? dist(freeTick.snapshot.pivot, [home.homeX, home.homeY]) : NaN;
  numbers.mapping = { zoneJumpM: zoneJump, freeHomeErrorM: homeError, freeJumpM: jump(free) };
  checks.push(check('Y-01:zone-no-jump', 'with a zone the mapping is fixed: the hand does not jump on screen when the yoyo ties on', zoneJump < NO_JUMP_M, `landmark 9 moved ${fmt(zoneJump * 100, 2)} cm across the tie-on frame (limit ${NO_JUMP_M * 100} cm)`));
  checks.push(check('Y-01:rehome', 'without a zone the world re-homes at the anchor: the pivot starts at the world home', homeError < HOME_TOLERANCE_M, `pivot ${fmt(homeError * 100, 2)} cm from the home at tie-on (limit ${HOME_TOLERANCE_M * 100} cm); the hand jumped ${fmt(jump(free) * 100, 1)} cm on screen (the re-homing)`));

  // (d) A hand against the frame edge never ties on, zone or not.
  const edgeScene = sessionScene([
    { kind: 'appear', at: [0.67, 0.1], holdMs: 3000 },
    { kind: 'move', to: [0.67, 0.42], ms: 400 },
    { kind: 'hold', ms: 2000 },
  ], { leadMs: SETTLE_LEAD_MS, palmSize: 0.17 });
  const edgePlayed = playFrames(renderSession(edgeScene, 7202, 'edge').frames);
  const edgeTether = firstOf(edgePlayed, 'tether');
  const edgeSeen = edgePlayed.ticks.some(t => t.snapshot.hand.edge === 'top');
  numbers.edge = { tetherMs: edgeTether?.timeMs ?? null, topEdgeSeen: edgeSeen };
  checks.push(check(
    'Y-01:edge',
    'a still hand against the top edge never ties on; it ties on once it is inside the frame',
    edgeSeen && edgeTether !== undefined && edgeTether.timeMs > SETTLE_LEAD_MS + 3000,
    `edge 'top' reported: ${edgeSeen}; tied on at ${fmt(edgeTether?.timeMs ?? NaN, 0)} ms (the hand came down at ${SETTLE_LEAD_MS + 3000} ms)`,
  ));

  return { id: 'Y-01', title: 'Tying on: ≤ 1 s after a steady hand, never before, no physics before', evidence: 'synthetic', checks, numbers };
}

// ---------------------------------------------------------------------------------------------
// Y-02: launching
// ---------------------------------------------------------------------------------------------

/** m/s of the PRD range 1.5–3, written as ih/s (world scale 1 m per ih). */
const LAUNCH_SPEEDS = [1.5, 2.25, 3] as const;
const LAUNCH_RUNS = 100;
/** Launches with the corpus's own distribution of peak speed (uniform 1.5–3 ih/s): what the Y-S1 bars are set against. */
const LAUNCH_RANGE_RUNS = 300;
const SCRIPTED_VARIANTS = 12;
const STILL_RUNS = 10;
const STILL_HAND_MS = 5000;
const MAX_LAUNCH_FRAMES = 2;
/** The Y-S1 bars for noisy replays (PRD §9). */
const MIN_RECALL = 0.85;

interface LaunchRun {
  speed: number;
  windup: boolean;
  fired: boolean;
  rolling: boolean;
  falseLaunches: number;
  frames: number;
  msFromOnset: number;
  msToArrival: number;
  captureToArrival: number;
  arrivalToPhase: number;
  visibleAfterArrival: number;
}

/** One session: the hand holds, throws at `speed`, holds. Noisy like the camera, or noise-free like a scripted replay. */
function launchRun(speed: number, seed: number, windup: boolean, noiseFree: boolean): LaunchRun {
  const rng = new Random(seed);
  const scene = sessionScene([
    { kind: 'appear', at: restPosition(rng), holdMs: rng.range(1000, 1500) },
    { kind: 'launch', peak: speed, ...strokeParams(rng, speed), ...(windup ? { windup: { rise: rng.range(0.03, 0.09), ms: rng.range(150, 350) } } : {}) },
    { kind: 'hold', ms: 800 },
  ], { leadMs: 300, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left', tags: [windup ? 'windup' : 'still'] });
  const clip = noiseFree ? renderCleanSession(scene, `launch-${speed}-${seed}`) : renderSession(scene, seed * 31 + 7, `launch-${speed}-${seed}`);
  const played = playFrames(clip.frames);
  const [label] = scene.labels;
  const record = intentFor(played, label);
  const launch = record ? eventsOf(played, 'launch').find(e => e.causeMs === record.event.timestampMs) : undefined;
  return {
    speed,
    windup,
    fired: record !== undefined && record.accepted,
    rolling: launch !== undefined && played.ticks.some(t => t.snapshot.phase === 'rolling' && t.nowMs >= launch.renderMs),
    falseLaunches: played.intents.filter(r => r.event.kind === 'launch' && r !== record).length,
    frames: record ? framesAfterOnset(clip.frames, label.onsetMs, record.event.timestampMs) : NaN,
    msFromOnset: record ? record.event.timestampMs - label.onsetMs : NaN,
    msToArrival: record ? record.event.arrivalMs - label.onsetMs : NaN,
    captureToArrival: record ? record.event.arrivalMs - record.event.timestampMs : NaN,
    arrivalToPhase: launch && record ? launch.timeMs - record.event.arrivalMs : NaN,
    visibleAfterArrival: launch && record ? launch.renderMs - record.event.arrivalMs : NaN,
  };
}

const latencyBreakdown = (runs: ReadonlyArray<{ msFromOnset: number; msToArrival: number; captureToArrival: number; arrivalToPhase: number; visibleAfterArrival: number }>) => ({
  onsetToDecisionMs: stats(runs.map(r => r.msFromOnset)),
  onsetToArrivalMs: stats(runs.map(r => r.msToArrival)),
  captureToArrivalMs: stats(runs.map(r => r.captureToArrival)),
  arrivalToPhaseChangeMs: stats(runs.map(r => r.arrivalToPhase)),
  arrivalToVisibleMs: stats(runs.map(r => r.visibleAfterArrival)),
});

function y02(): ScenarioResult {
  const checks: Check[] = [];
  const numbers: Record<string, unknown> = {};

  const noisy: LaunchRun[] = [];
  for (const speed of LAUNCH_SPEEDS) for (let i = 0; i < LAUNCH_RUNS; i++) noisy.push(launchRun(speed, 100 * Math.round(speed * 100) + i, i % 2 === 1, false));
  const scripted: LaunchRun[] = [];
  for (const speed of LAUNCH_SPEEDS) for (let i = 0; i < SCRIPTED_VARIANTS; i++) scripted.push(launchRun(speed, 40000 + 100 * Math.round(speed * 100) + i, i % 2 === 1, true));
  const range: LaunchRun[] = [];
  for (let i = 0; i < LAUNCH_RANGE_RUNS; i++) range.push(launchRun(new Random(80000 + i).range(1.5, 3), 80000 + i, i % 2 === 1, false));

  const rows = (runs: readonly LaunchRun[]) => LAUNCH_SPEEDS.map(speed => {
    const rs = runs.filter(r => r.speed === speed), fired = rs.filter(r => r.fired);
    const by = (windup: boolean) => ({ runs: rs.filter(r => r.windup === windup).length, fired: fired.filter(r => r.windup === windup).length });
    return {
      speed, runs: rs.length, fired: fired.length, rolling: rs.filter(r => r.rolling).length,
      recall: share(fired.length, rs.length), falseLaunches: sum(rs.map(r => r.falseLaunches)),
      frames: stats(fired.map(r => r.frames)), msFromOnset: stats(fired.map(r => r.msFromOnset)),
      overTwoFrames: fired.filter(r => r.frames > MAX_LAUNCH_FRAMES).length,
      still: by(false), windup: by(true),
    };
  });
  const noisyRows = rows(noisy), scriptedRows = rows(scripted);
  const rangeFired = range.filter(r => r.fired);
  numbers.noisyRange = {
    runs: range.length, fired: rangeFired.length, recall: share(rangeFired.length, range.length),
    frames: stats(rangeFired.map(r => r.frames)), msFromOnset: stats(rangeFired.map(r => r.msFromOnset)),
    byBucket: [[1.5, 2], [2, 2.5], [2.5, 3.01]].map(([lo, hi]) => {
      const rs = range.filter(r => r.speed >= lo && r.speed < hi);
      return { from: lo, to: Math.min(hi, 3), runs: rs.length, fired: rs.filter(r => r.fired).length };
    }),
  };
  numbers.noisyBySpeed = noisyRows;
  numbers.scriptedBySpeed = scriptedRows;
  numbers.noisyLatencyBreakdown = latencyBreakdown(noisy.filter(r => r.fired));
  numbers.scriptedLatencyBreakdown = latencyBreakdown(scripted.filter(r => r.fired));

  checks.push(check(
    'Y-02:noisy-range-recall',
    `launches over the PRD's whole range (1.5–3 m/s, ${range.length} noisy runs, half with a wind-up) reach 'rolling' in ≥ ${MIN_RECALL * 100} % (the Y-S1 bar)`,
    share(range.filter(r => r.rolling).length, range.length) >= MIN_RECALL,
    `${range.filter(r => r.rolling).length}/${range.length} (${pct(share(range.filter(r => r.rolling).length, range.length))}); by speed ${(numbers.noisyRange as { byBucket: Array<{ from: number; to: number; runs: number; fired: number }> }).byBucket.map(b => `${b.from}–${b.to} ih/s ${b.fired}/${b.runs}`).join(', ')}`,
  ));
  checks.push(check(
    'Y-02:noisy-range-frames',
    `launches over the whole range: p95 of detection latency ≤ ${MAX_LAUNCH_FRAMES} frames after the labelled onset (the Y-S2 bar)`,
    percentiles(rangeFired.map(r => r.frames)).p95 <= MAX_LAUNCH_FRAMES,
    `frames after onset p50 ${percentiles(rangeFired.map(r => r.frames)).p50}, p95 ${percentiles(rangeFired.map(r => r.frames)).p95}, max ${maxOf(rangeFired.map(r => r.frames))}; ${rangeFired.filter(r => r.frames > MAX_LAUNCH_FRAMES).length}/${rangeFired.length} later than ${MAX_LAUNCH_FRAMES} frames`,
  ));
  for (const row of noisyRows) {
    checks.push(check(
      `Y-02:noisy-recall-${row.speed}`,
      `${row.speed} m/s launches reach 'rolling' in ≥ ${MIN_RECALL * 100} % of ${row.runs} noisy runs (half with a wind-up; the Y-S1 bar)`,
      share(row.rolling, row.runs) >= MIN_RECALL,
      `${row.rolling}/${row.runs} reached rolling (${pct(share(row.rolling, row.runs))}); still ${row.still.fired}/${row.still.runs} fired, wind-up ${row.windup.fired}/${row.windup.runs}`,
    ));
    checks.push(check(
      `Y-02:noisy-frames-${row.speed}`,
      `${row.speed} m/s noisy launches: p95 of detection latency ≤ ${MAX_LAUNCH_FRAMES} frames after the labelled onset (the Y-S2 bar)`,
      row.frames.p95 <= MAX_LAUNCH_FRAMES,
      `frames after onset p50 ${row.frames.p50}, p95 ${row.frames.p95}, max ${row.frames.max}; ${row.overTwoFrames}/${row.fired} later than ${MAX_LAUNCH_FRAMES} frames (max ${fmt(row.msFromOnset.max, 0)} ms)`,
    ));
  }
  for (const row of scriptedRows) {
    checks.push(check(
      `Y-02:scripted-${row.speed}`,
      `${row.speed} m/s scripted launches (noise-free camera, ${row.runs} variants) reach 'rolling' within ${MAX_LAUNCH_FRAMES} frames of the labelled onset`,
      row.rolling === row.runs && row.overTwoFrames === 0,
      `${row.rolling}/${row.runs} reached rolling; frames after onset p50 ${row.frames.p50}, max ${row.frames.max}; ${row.overTwoFrames} over ${MAX_LAUNCH_FRAMES}; ms from onset max ${fmt(row.msFromOnset.max, 0)}`,
    ));
  }

  const stillRuns = Array.from({ length: STILL_RUNS }, (_, i) => {
    const rng = new Random(900 + i);
    const scene = sessionScene([{ kind: 'appear', at: restPosition(rng), holdMs: STILL_HAND_MS + 1500 }], {
      leadMs: 300, palmSize: randomPalm(rng), ...(i % 2 === 1 ? { glitches: { count: 3, seed: i } } : {}),
    });
    const played = playFrames(renderSession(scene, 900 + i, `still-${i}`).frames);
    const tether = firstOf(played, 'tether');
    return {
      tethered: tether !== undefined,
      stillMs: tether ? 300 + STILL_HAND_MS + 1500 - tether.timeMs : 0,
      launches: eventsOf(played, 'launch').length + played.intents.filter(r => r.event.kind === 'launch').length,
      phase: lastTick(played).snapshot.phase,
    };
  });
  numbers.stillHand = stillRuns;
  checks.push(check(
    'Y-02:still-5s',
    `0 launches in ${STILL_HAND_MS / 1000} s of a still, tethered hand (${STILL_RUNS} runs, half with tracking glitches)`,
    stillRuns.every(r => r.tethered && r.launches === 0 && r.phase === 'tethered' && r.stillMs >= STILL_HAND_MS),
    `${sum(stillRuns.map(r => r.launches))} launches; ${stillRuns.filter(r => r.tethered).length}/${STILL_RUNS} tethered; tethered still time ≥ ${fmt(minOf(stillRuns.map(r => r.stillMs)), 0)} ms`,
  ));
  const falseTotal = sum([...noisyRows, ...scriptedRows].map(r => r.falseLaunches));
  checks.push(check('Y-02:no-false', 'no launch fires on anything but the labelled stroke in the launch runs', falseTotal === 0, `${falseTotal} extra launch intents in ${noisy.length + scripted.length} runs`));

  return { id: 'Y-02', title: 'Launching: 1.5–3 m/s reaches rolling within 2 frames; 0 launches in 5 s still', evidence: 'synthetic', checks, numbers };
}

// ---------------------------------------------------------------------------------------------
// Y-03: the sleeper
// ---------------------------------------------------------------------------------------------

const SLEEPER_RUNS = 10;
const SLEEP_HOLD_MS = 8000;
/** The model must not pass the end of the string by more than this, m (PRD: 1 mm). */
const LENGTH_SLACK_M = 0.001;
const SPIN_CURVE_TOLERANCE = 0.02;

function y03(): ScenarioResult {
  const config = createConfig();
  let reached = 0, worstLength = -Infinity, worstReach = -Infinity, worstSpinError = 0, sleepingTicks = 0;
  for (let i = 0; i < SLEEPER_RUNS; i++) {
    const rng = new Random(300 + i);
    const scene = sessionScene([
      { kind: 'appear', at: restPosition(rng), holdMs: rng.range(1000, 1500) },
      firmLaunch(rng),
      { kind: 'hold', ms: SLEEP_HOLD_MS, sway: randomSway(rng) },
    ], { leadMs: 300, palmSize: randomPalm(rng) });
    const played = playFrames(renderSession(scene, 300 + i, `sleeper-${i}`).frames);
    const sleeping = played.ticks.filter(t => t.snapshot.phase === 'sleeping');
    if (sleeping.length > 0) reached++;
    for (const t of played.ticks) {
      if (t.snapshot.phase === 'untethered') continue;
      worstLength = Math.max(worstLength, t.snapshot.length - config.yoyo.maxLength);
      worstReach = Math.max(worstReach, dist(t.snapshot.yoyo, t.snapshot.pivot) - config.yoyo.maxLength);
    }
    if (sleeping.length === 0) continue;
    const first = sleeping[0].snapshot;
    for (const t of sleeping) {
      const expected = first.spin * Math.exp(-(t.snapshot.timeMs - first.timeMs) / (config.yoyo.sleepTau * 1000));
      worstSpinError = Math.max(worstSpinError, Math.abs(t.snapshot.spin - expected) / expected);
      sleepingTicks++;
    }
  }
  const checks = [
    check('Y-03:sleeps', "every launch reaches 'sleeping'", reached === SLEEPER_RUNS, `${reached}/${SLEEPER_RUNS} runs slept`),
    check(
      'Y-03:length',
      'L and the string stretch stay within maxLength + 1 mm throughout',
      worstLength <= LENGTH_SLACK_M && worstReach <= LENGTH_SLACK_M,
      `worst L over maxLength ${fmt(worstLength * 1000, 3)} mm, worst |yoyo − pivot| over maxLength ${fmt(worstReach * 1000, 3)} mm (limit ${LENGTH_SLACK_M * 1000} mm)`,
    ),
    check(
      'Y-03:spin-curve',
      `spin follows ω₀·e^(−t/τ) within ${SPIN_CURVE_TOLERANCE * 100} % while sleeping`,
      sleepingTicks > 0 && worstSpinError <= SPIN_CURVE_TOLERANCE,
      `worst relative error ${fmt(worstSpinError * 100, 4)} % over ${sleepingTicks} sleeping frames (τ = ${config.yoyo.sleepTau} s)`,
    ),
  ];
  return {
    id: 'Y-03', title: 'The sleeper: reaches sleeping, ω decays as e^(−t/τ), L ≤ maxLength + 1 mm', evidence: 'synthetic', checks,
    numbers: { runs: SLEEPER_RUNS, reached, worstLengthOverMaxM: worstLength, worstReachOverMaxM: worstReach, worstSpinError, sleepingTicks },
  };
}

// ---------------------------------------------------------------------------------------------
// Y-04 and Y-05: tugging, returning, catching
// ---------------------------------------------------------------------------------------------

/** Peak speeds (ih/s) at which the flick is also tried on its own, and runs of each. */
const TUG_RUNS = 100;
/** Flicks with the corpus's own distribution (peak uniform 0.8–1.6 ih/s, 100–200 ms, ±25°): what the Y-S1 bars are set against. */
const TUG_RANGE_RUNS = 300;
const TUG_LOWER_BOUND = 0.8;
const TUG_MAX_DECISION_MS = 100;
const JITTER_RUN_MS = 60_000;
const CATCH_DISTANCE_M = 0.03;
/** Displacement of the yoyo between two snapshots beyond its peak speed × the time of the frame's physics steps, m: 1 mm. */
const JUMP_SLACK_M = 0.001;
/**
 * What the information-only number outside the return is. In `rolling`, while the hand is still diving after a
 * firm launch, the string can start a physics step slack and end it taut; the string pays out only while taut, so
 * the constraint then corrects the yoyo's POSITION alone: a few mm in one 240 Hz step (3.3 mm in the physics
 * owner's measure, about 4 mm over a render frame) that its velocity does not explain. It is real and known, but it
 * belongs to the launch, not to the return and the catch that Y-05 is about, so it is reported and not checked.
 */
const ROLLING_JUMP_NOTE = 'the launch dive: the string starts a step slack and ends it taut, and the constraint then corrects the position only';

interface TugRun {
  peak: number;
  durationMs: number;
  /** The throw before the tug put the yoyo to sleep, so the tug had something to wake. */
  slept: boolean;
  /** Seeds it took to get a throw that took (1 = the first). */
  tries: number;
  returned: boolean;
  caught: boolean;
  retethered: boolean;
  msFromOnset: number;
  msToArrival: number;
  captureToArrival: number;
  arrivalToPhase: number;
  visibleAfterArrival: number;
  /** Longest time between two delivered frames from the onset to the deciding frame, ms: the camera's dropped frames inside the stroke. */
  gapMs: number;
  /** Distance yoyo–pivot at the first tethered snapshot after the catch, and at the catch itself, m. */
  distanceAtRetether: number;
  distanceAtCatch: number;
  /** Worst snapshot-to-snapshot jump from the tug to a little after the yoyo is tied on again: the return and the catch. */
  worstJump: Jump;
  /** The same over everything else in the session (the throw, the sleep), for information. */
  worstJumpElsewhere: Jump;
  falseTugs: number;
}

/** A launch, a sleep (swaying half the time, through the flick) and one flick of known peak and duration. */
function tugRun(peak: number, durationMs: number, angleDeg: number, seed: number, noiseFree: boolean): TugRun {
  return withSetup(seed, s => tugRunOnce(peak, durationMs, angleDeg, s, noiseFree));
}

function tugRunOnce(peak: number, durationMs: number, angleDeg: number, seed: number, noiseFree: boolean): Omit<TugRun, 'tries'> {
  const rng = new Random(seed);
  const swaying = rng.chance(0.5);
  const scene = sessionScene([
    { kind: 'appear', at: restPosition(rng), holdMs: rng.range(1000, 1400) },
    firmLaunch(rng),
    ...(swaying ? [{ kind: 'sway', spec: randomSway(rng) } as SessionStep] : []),
    { kind: 'hold', ms: 2500 },
    { kind: 'tug', peak, durationMs, angleDeg },
    { kind: 'hold', ms: 2600 },
  ], { leadMs: 300, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left' });
  const clip = noiseFree ? renderCleanSession(scene, `tug-${seed}`) : renderSession(scene, seed * 17 + 3, `tug-${peak}-${seed}`);
  const played = playFrames(clip.frames);
  const label = scene.labels[1];
  const record = intentFor(played, label);
  const tug = record ? eventsOf(played, 'tug').find(e => e.causeMs === record.event.timestampMs) : undefined;
  const afterTug = tug ? played.ticks.filter(t => t.nowMs >= tug.renderMs) : [];
  const catchTick = afterTug.find(t => t.snapshot.phase === 'caught');
  const retetherTick = catchTick ? afterTug.find(t => t.nowMs > catchTick.nowMs && t.snapshot.phase === 'tethered') : undefined;
  return {
    peak,
    durationMs,
    slept: eventsOf(played, 'snap').length > 0,
    returned: tug !== undefined && afterTug.some(t => t.snapshot.phase === 'returning'),
    caught: catchTick !== undefined,
    retethered: retetherTick !== undefined,
    msFromOnset: record ? record.event.timestampMs - label.onsetMs : NaN,
    msToArrival: record ? record.event.arrivalMs - label.onsetMs : NaN,
    captureToArrival: record ? record.event.arrivalMs - record.event.timestampMs : NaN,
    arrivalToPhase: tug && record ? tug.timeMs - record.event.arrivalMs : NaN,
    visibleAfterArrival: tug && record ? tug.renderMs - record.event.arrivalMs : NaN,
    gapMs: record ? longestFrameGapMs(clip.frames, label.onsetMs, record.event.timestampMs) : NaN,
    distanceAtRetether: retetherTick ? dist(retetherTick.snapshot.yoyo, retetherTick.snapshot.pivot) : NaN,
    distanceAtCatch: catchTick ? dist(catchTick.snapshot.yoyo, catchTick.snapshot.pivot) : NaN,
    ...jumpsAround(played.ticks, tug?.renderMs, retetherTick?.nowMs),
    falseTugs: played.intents.filter(r => r.event.kind === 'tug' && r !== record).length,
  };
}

/** A gap between two delivered frames this long (1.5 periods of the 30 fps camera) means at least one frame was dropped. */
const DROPPED_FRAME_GAP_MS = FRAME_MS * 1.5;

/**
 * Longest time between two consecutive delivered frames, by capture time, among the frames after the onset up to
 * the one that decided: the camera's dropped frames inside the stroke. A classifier cannot decide on a sample that
 * was never captured, so a late decision that comes with a gap here is the camera's doing, not its.
 */
function longestFrameGapMs(frames: readonly DeliveredFrame[], onsetMs: number, decidedMs: number): number {
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    const t = frames[i].frame.timestampMs;
    if (t <= onsetMs) continue;
    if (t > decidedMs) break;
    worst = Math.max(worst, t - frames[i - 1].frame.timestampMs);
  }
  return worst;
}

/** Render frames kept in the return-and-catch window after the yoyo is tied on again. */
const SETTLE_TICKS = 6;

/** The worst jump inside the return-and-catch window (tug → tied on again + a few frames) and the worst outside it. */
function jumpsAround(ticks: readonly Tick[], tugMs: number | undefined, retetherMs: number | undefined): { worstJump: Jump; worstJumpElsewhere: Jump } {
  if (tugMs === undefined || retetherMs === undefined) return { worstJump: NO_JUMP, worstJumpElsewhere: worstSnapshotJump(ticks) };
  const first = ticks.findIndex(t => t.nowMs >= tugMs);
  const last = Math.min(ticks.length - 1, ticks.findIndex(t => t.nowMs >= retetherMs) + SETTLE_TICKS);
  const worse = (a: Jump, b: Jump): Jump => ({ ...(b.excessM > a.excessM ? b : a), excessByEndSpeedsM: Math.max(a.excessByEndSpeedsM, b.excessByEndSpeedsM) });
  return {
    worstJump: worstSnapshotJump(ticks, first, last),
    worstJumpElsewhere: worse(worstSnapshotJump(ticks, 1, first - 1), worstSnapshotJump(ticks, last + 1, ticks.length - 1)),
  };
}

/** The worst pair of consecutive snapshots: how far the yoyo moved beyond what its speed explains, and where. */
interface Jump {
  /** Displacement beyond (peak speed over the frame's physics steps) × (their time), m. This is what is checked. */
  excessM: number;
  /** The same pair measured the way this check used to: with the speeds at the two ends of the frame only. For information. */
  excessByEndSpeedsM: number;
  atMs: number;
  phases: string;
  movedM: number;
  /** Peak speed over the frame's steps, m/s. */
  speedMs: number;
}

const NO_JUMP: Jump = { excessM: -Infinity, excessByEndSpeedsM: -Infinity, atMs: NaN, phases: '', movedM: NaN, speedMs: NaN };

/**
 * Largest displacement of the yoyo between two consecutive snapshots beyond what it could cover at the
 * fastest it moved during the frame: (peak |V| over the frame's physics steps, `diagnostics.lastAdvancePeakSpeed`)
 * × (the time those steps cover). Why the peak and not the two end velocities: a speed can peak inside a
 * 16.7 ms frame (the string goes taut and snaps the yoyo back, then free flight begins), and then neither end
 * velocity bounds how far it went. Pairs that straddle the instant the yoyo appears (tie-on) are skipped: a
 * yoyo that did not exist cannot have moved.
 */
function worstSnapshotJump(ticks: readonly Tick[], from = 1, to = ticks.length - 1): Jump {
  let worst = NO_JUMP;
  let byEnds = -Infinity;
  for (let i = Math.max(1, from); i <= to; i++) {
    const a = ticks[i - 1].snapshot, b = ticks[i].snapshot;
    if (a.phase === 'untethered' || b.phase === 'untethered') continue;
    const moved = dist(a.yoyo, b.yoyo);
    const excess = moved - ticks[i].peakSpeed * ticks[i].physicsS;
    byEnds = Math.max(byEnds, moved - Math.max(speedOf(a.yoyoVelocity), speedOf(b.yoyoVelocity)) * ((b.timeMs - a.timeMs) / 1000));
    if (excess > worst.excessM) worst = { ...worst, excessM: excess, atMs: b.timeMs, phases: a.phase === b.phase ? a.phase : `${a.phase}>${b.phase}`, movedM: moved, speedMs: ticks[i].peakSpeed };
  }
  return { ...worst, excessByEndSpeedsM: byEnds };
}

/** 60 s with the yoyo asleep and a hand that does nothing but jitter, sway or suffer glitches: only a real tug may wake it. */
function jitterRun(variant: 'still' | 'sway' | 'glitchy', seed: number) {
  return withSetup(seed, s => jitterRunOnce(variant, s));
}

function jitterRunOnce(variant: 'still' | 'sway' | 'glitchy', seed: number) {
  const rng = new Random(seed);
  const config = setConfigValue(createConfig(), 'yoyo.sleepTau', 1e9);
  config.yoyo.autoReturn = false;
  const scene = sessionScene([
    { kind: 'appear', at: restPosition(rng), holdMs: 1200 },
    firmLaunch(rng),
    ...(variant === 'sway' ? [{ kind: 'sway', spec: randomSway(rng, [0.03, 0.06]) } as SessionStep] : []),
    { kind: 'hold', ms: JITTER_RUN_MS },
  ], { leadMs: 300, palmSize: randomPalm(rng), ...(variant === 'glitchy' ? { glitches: { count: 18, seed } } : {}) });
  const played = playFrames(renderSession(scene, seed, `jitter-${variant}`).frames, { config });
  const sleeping = played.ticks.filter(t => t.snapshot.phase === 'sleeping');
  const firstSleep = sleeping.length ? sleeping[0].nowMs : Infinity;
  return {
    variant,
    slept: sleeping.length > 0,
    tugs: eventsOf(played, 'tug').length,
    intents: played.intents.filter(r => r.event.kind === 'tug').length,
    phases: phaseSequence(played.ticks.filter(t => t.nowMs >= firstSleep)),
    /** hand-lost events: every flicker of the tracking says one. */
    handLostEvents: eventsOf(played, 'hand-lost').length,
    /** What the metrics count as hand losses (those that last at least MIN_HAND_LOSS_MS). */
    handLossesCounted: lossesCountedWhileInView(played),
    asleepMs: sleeping.length ? sleeping[sleeping.length - 1].nowMs - firstSleep : 0,
  };
}

/** Noisy tug runs are shared by Y-04 and Y-05: the corpus-like range, and the PRD's lower bound on its own. */
let noisyTugsMemo: { range: TugRun[]; lower: TugRun[] } | null = null;
function noisyTugs(): { range: TugRun[]; lower: TugRun[] } {
  if (!noisyTugsMemo) {
    const range = Array.from({ length: TUG_RANGE_RUNS }, (_, i) => {
      const rng = new Random(60000 + i);
      return tugRun(rng.range(0.8, 1.6), rng.range(100, 200), rng.range(-25, 25), 61000 + i, false);
    });
    const lower = Array.from({ length: TUG_RUNS }, (_, i) => {
      const rng = new Random(62000 + i);
      return tugRun(TUG_LOWER_BOUND, rng.range(120, 200), rng.range(-20, 20), 63000 + i, false);
    });
    noisyTugsMemo = { range, lower };
  }
  return noisyTugsMemo;
}

/** Scripted flicks: the PRD's range (0.8–1.6 m/s, 100–200 ms) on a camera with perfect tracking. */
function scriptedTugs(): TugRun[] {
  const out: TugRun[] = [];
  let i = 0;
  for (const peak of [0.8, 1, 1.2, 1.6]) for (const durationMs of [100, 150, 200]) for (const angleDeg of [-20, 0, 20]) out.push(tugRun(peak, durationMs, angleDeg, 70000 + i++, true));
  return out;
}

function y04(): ScenarioResult {
  const { range: runs, lower } = noisyTugs();
  const scripted = scriptedTugs();
  const numbers: Record<string, unknown> = {};
  const everyRun = [...runs, ...lower, ...scripted];
  const attempts = sum(everyRun.map(r => r.tries)), sessions = everyRun.length;
  const takeRate = sessions / attempts;
  const unusable = everyRun.filter(r => !r.slept).length;
  const returned = runs.filter(r => r.returned);
  const lowerReturned = lower.filter(r => r.returned);
  const byPeak = [[0.8, 1], [1, 1.3], [1.3, 1.61]].map(([lo, hi]) => {
    const rs = runs.filter(r => r.peak >= lo && r.peak < hi);
    return { from: lo, to: Math.min(hi, 1.6), runs: rs.length, returned: rs.filter(r => r.returned).length, recall: share(rs.filter(r => r.returned).length, rs.length), onsetToDecisionMs: stats(rs.filter(r => r.returned).map(r => r.msFromOnset)) };
  });
  numbers.noisyByPeak = byPeak;
  numbers.lowerBound = { peak: TUG_LOWER_BOUND, runs: lower.length, returned: lowerReturned.length, recall: share(lowerReturned.length, lower.length) };
  numbers.noisyLatencyBreakdown = latencyBreakdown(returned);
  numbers.scriptedLatencyBreakdown = latencyBreakdown(scripted.filter(r => r.returned));
  numbers.setup = { sessions, attempts, takeRate, unusable };
  numbers.scripted = { runs: scripted.length, returned: scripted.filter(r => r.returned).length, decisionMsMax: maxOf(finite(scripted.map(r => r.msFromOnset))) };

  const recall = share(returned.length, runs.length);
  const slow = returned.filter(r => r.msFromOnset > TUG_MAX_DECISION_MS);
  const late = [...returned, ...lowerReturned].filter(r => r.msFromOnset > TUG_MAX_DECISION_MS);
  numbers.lateDecisions = late.map(r => ({ peak: r.peak, durationMs: r.durationMs, msFromOnset: r.msFromOnset, gapMs: r.gapMs }));
  const decisionMs = returned.map(r => r.msFromOnset);
  const breakdown = `onset → arrival processed p50 ${fmt(percentiles(returned.map(r => r.msToArrival)).p50)} ms; capture → arrival p50 ${fmt(percentiles(returned.map(r => r.captureToArrival)).p50)} ms; arrival → phase change max ${fmt(maxOf(returned.map(r => r.arrivalToPhase)), 2)} ms; visible in the next frame max ${fmt(maxOf(returned.map(r => r.visibleAfterArrival)), 2)} ms`;
  const checks: Check[] = [
    check(
      'Y-04:setup',
      'the throws that put the yoyo to sleep before each flick took on the first try in ≥ 95 % of the sessions (the throw is not the subject here; a failed one is redrawn)',
      takeRate >= 0.95 && unusable === 0,
      `${sessions} sessions took ${attempts} throws (${pct(takeRate)} first-try); ${unusable} sessions never slept`,
    ),
    check(
      'Y-04:noisy-recall',
      `flicks over the PRD's whole range (0.8–1.6 m/s, 100–200 ms, ${runs.length} noisy runs, half swaying) send the sleeping yoyo to 'returning' in ≥ ${MIN_RECALL * 100} % (the Y-S1 bar)`,
      recall >= MIN_RECALL,
      `${returned.length}/${runs.length} returned (${pct(recall)}); by peak: ${byPeak.map(b => `${b.from}–${b.to} ih/s ${b.returned}/${b.runs}`).join(', ')}`,
    ),
    check(
      'Y-04:noisy-recall-0.8',
      `flicks at the PRD's lower bound (0.8 m/s) return the yoyo in ≥ ${MIN_RECALL * 100} % of the noisy runs`,
      share(lowerReturned.length, lower.length) >= MIN_RECALL,
      `${lowerReturned.length}/${lower.length} (${pct(share(lowerReturned.length, lower.length))}): a 0.8 ih/s flick of 120–200 ms covers 0.05–0.085 ih against 0.04 ih of threshold and 0.01 ih of jitter`,
    ),
    check(
      'Y-04:noisy-decision-p95',
      `noisy flicks: p95 of onset → decision ≤ ${TUG_MAX_DECISION_MS} ms (capture time)`,
      returned.length > 0 && percentiles(decisionMs).p95 <= TUG_MAX_DECISION_MS,
      `p50 ${fmt(percentiles(decisionMs).p50)}, p95 ${fmt(percentiles(decisionMs).p95)}, max ${fmt(maxOf(decisionMs))} ms; ${breakdown}`,
    ),
    check(
      'Y-04:noisy-decision-max',
      `noisy flicks: every detected flick is decided ≤ ${TUG_MAX_DECISION_MS} ms after the onset`,
      returned.length > 0 && slow.length === 0,
      `${slow.length}/${returned.length} later than ${TUG_MAX_DECISION_MS} ms, max ${fmt(maxOf(decisionMs))} ms`,
    ),
    check(
      'Y-04:late-decisions-are-camera-gaps',
      `every flick decided later than ${TUG_MAX_DECISION_MS} ms had a camera frame dropped between its onset and the decision (a late decision is the camera's, not a slow classifier's)`,
      late.every(r => r.gapMs >= DROPPED_FRAME_GAP_MS),
      late.length === 0
        ? `no flick was decided later than ${TUG_MAX_DECISION_MS} ms`
        : `${late.length} late of ${returned.length + lowerReturned.length} detected (whole range and lower bound): ${late.map(r => `${fmt(r.msFromOnset)} ms with ${fmt(r.gapMs)} ms between two delivered frames (${fmt(r.peak, 2)} ih/s, ${fmt(r.durationMs, 0)} ms)`).join('; ')}; a frame is ${fmt(FRAME_MS)} ms, so one dropped makes ${fmt(FRAME_MS * 2)} ms and two in a row ${fmt(FRAME_MS * 3)} ms`,
    ),
    check(
      'Y-04:scripted',
      `scripted flicks (0.8–1.6 m/s, 100–200 ms, noise-free camera; ${scripted.length} variants) all return the yoyo within ${TUG_MAX_DECISION_MS} ms of the onset`,
      scripted.every(r => r.returned && r.msFromOnset <= TUG_MAX_DECISION_MS),
      `${scripted.filter(r => r.returned).length}/${scripted.length} returned; decision max ${fmt(maxOf(finite(scripted.map(r => r.msFromOnset))))} ms; missed: ${scripted.filter(r => !r.returned).map(r => `${r.peak} ih/s ${r.durationMs} ms`).join(', ') || 'none'}`,
    ),
  ];
  const falseTugs = sum([...runs, ...scripted].map(r => r.falseTugs));
  checks.push(check('Y-04:no-false-in-runs', 'no tug fires on anything but the labelled flick in the tug runs', falseTugs === 0, `${falseTugs} extra tug intents in ${runs.length + scripted.length} runs`));

  const jitter = (['still', 'sway', 'glitchy'] as const).map((variant, i) => jitterRun(variant, 5000 + i));
  numbers.jitter = jitter;
  checks.push(check(
    'Y-04:jitter-60s',
    `0 tug events in ${JITTER_RUN_MS / 1000} s of jitter while sleeping (still, swaying, glitchy; autoReturn off, τ huge so only a tug could wake it)`,
    jitter.every(j => j.slept && j.tugs === 0 && j.intents === 0 && j.phases.length === 1 && j.phases[0] === 'sleeping' && j.asleepMs >= JITTER_RUN_MS - 3000),
    jitter.map(j => `${j.variant}: ${j.tugs} tug events, ${j.intents} intents, ${fmt(j.asleepMs / 1000)} s asleep`).join('; '),
  ));
  checks.push(check(
    'Y-04:jitter-losses',
    `a hand that stays in view for ${JITTER_RUN_MS / 1000} s is never counted as lost, although dropped frames make the tracking flicker`,
    jitter.every(j => j.handLossesCounted === 0),
    jitter.map(j => `${j.variant}: ${j.handLostEvents} hand-lost events, ${j.handLossesCounted} counted`).join('; ') + ' (three camera frames in a row leave the newest sample 188 ms old, 8 ms past staleMs: physics stops for that instant, the hand is not lost)',
  ));
  return { id: 'Y-04', title: 'Tugging: flicks ≥ 0.8 m/s return the yoyo within 100 ms of the onset; 0 returns in 60 s of jitter', evidence: 'synthetic', checks, numbers };
}

function y05(): ScenarioResult {
  const noisy = noisyTugs();
  const all = [...noisy.range, ...noisy.lower, ...scriptedTugs()];
  const runs = all.filter(r => r.returned);
  const caught = runs.filter(r => r.caught), retethered = runs.filter(r => r.retethered);
  const jumpWorst = maxOf(runs.map(r => r.worstJump.excessM));
  const worstRun = runs.reduce((w, r) => (r.worstJump.excessM > w.worstJump.excessM ? r : w), runs[0]);
  const elsewhere = runs.reduce((w, r) => (r.worstJumpElsewhere.excessM > w.worstJumpElsewhere.excessM ? r : w), runs[0]).worstJumpElsewhere;
  const numbers = {
    runs: runs.length,
    caught: caught.length,
    retethered: retethered.length,
    distanceAtCatchM: stats(caught.map(r => r.distanceAtCatch)),
    distanceAtRetetherM: stats(retethered.map(r => r.distanceAtRetether)),
    worstJumpBeyondVelocityM: jumpWorst,
    worstJump: worstRun.worstJump,
    worstJumpOutsideReturn: elsewhere,
  };
  const checks = [
    check('Y-05:caught-retethered', "the yoyo is caught and tied on again ('caught' then 'tethered') after every return", caught.length === runs.length && retethered.length === runs.length, `${caught.length}/${runs.length} caught, ${retethered.length}/${runs.length} tethered again`),
    check(
      'Y-05:distance',
      `it comes back to < ${CATCH_DISTANCE_M * 100} cm of the pivot`,
      retethered.length > 0 && maxOf(retethered.map(r => r.distanceAtRetether)) < CATCH_DISTANCE_M,
      `when tethered again: max ${fmt(maxOf(retethered.map(r => r.distanceAtRetether)) * 100, 2)} cm; at the catch itself (L < 5 cm, within 10 cm of the pivot) max ${fmt(maxOf(caught.map(r => r.distanceAtCatch)) * 100, 2)} cm`,
    ),
    check(
      'Y-05:no-jumps',
      'no jumps in the return and the catch: between snapshots the yoyo moves at most (its peak speed over the frame\'s physics steps)·(their time) + 1 mm',
      jumpWorst <= JUMP_SLACK_M,
      `from the tug to tied on again: worst excess ${fmt(jumpWorst * 1000, 3)} mm over ${all.length} sessions (limit ${JUMP_SLACK_M * 1000} mm), in phase ${worstRun.worstJump.phases}: moved ${fmt(worstRun.worstJump.movedM * 1000, 2)} mm at up to ${fmt(worstRun.worstJump.speedMs, 3)} m/s. Measured with only the two end velocities, as this check used to, the same frames show up to ${fmt(Math.max(...runs.map(r => r.worstJump.excessByEndSpeedsM)) * 1000, 3)} mm. For information, not checked: outside the return the worst is ${fmt(elsewhere.excessM * 1000, 2)} mm (${elsewhere.phases}${elsewhere.phases === 'rolling' ? `, ${ROLLING_JUMP_NOTE}` : ''})`,
    ),
  ];
  return { id: 'Y-05', title: 'Return and catch: back within 3 cm, tied on again, no jumps', evidence: 'synthetic', checks, numbers };
}

// ---------------------------------------------------------------------------------------------
// Y-06 and Y-07: losing the hand
// ---------------------------------------------------------------------------------------------

const LOST_DURATIONS_MS = [300, 600, 1000, 1500] as const;
/** Losses this long are far from the metrics' MIN_HAND_LOSS_MS, so the count must be exact whatever the frame timing. */
const LOSS_CLEARLY_LONG_MS = 450;
const LOST_RUNS_PER_DURATION = 8;
const TELEPORT_LIMIT_M = 0.05;
const REAPPEAR_DISTANCE: readonly [number, number] = [0.3, 0.6];
/** The stroke ends about this far below the rest position (the firm throw's length): where the hand is when it is lost. */
const THROW_DROP_IH = 0.33;

/** A reappearance offset of 0.3–0.6 ih in a random direction that keeps the hand inside the frame. */
function reappearOffset(rng: Random, from: Vec2): Vec2 {
  for (let attempt = 0; attempt < 100; attempt++) {
    const d = rng.range(...REAPPEAR_DISTANCE), a = rng.range(0, 2 * Math.PI);
    const to: Vec2 = [from[0] + d * Math.cos(a), from[1] + d * Math.sin(a)];
    if (to[0] > 0.3 && to[0] < 1.0 && to[1] > 0.3 && to[1] < 0.7) return [to[0] - from[0], to[1] - from[1]];
  }
  return [0.3, 0];
}

interface LostRun {
  slept: boolean;
  /** What the metrics counted as hand losses over the whole run. */
  lossesCounted: number;
  lostMs: number;
  lossSeen: boolean;
  recovered: boolean;
  intentsWhileLost: number;
  eventsWhileLost: string[];
  nonZeroVelocityWhileStale: number;
  nonFinite: number;
  teleportM: number;
  phasesAfterSleep: YoyoPhase[];
}

function lostRun(lostMs: number, seed: number, config: YoyoConfig) {
  return withSetup(seed, s => lostRunOnce(lostMs, s, config));
}

function lostRunOnce(lostMs: number, seed: number, config: YoyoConfig): LostRun {
  const rng = new Random(seed);
  const at = restPosition(rng);
  const scene = sessionScene([
    { kind: 'appear', at, holdMs: rng.range(1000, 1300) },
    firmLaunch(rng),
    { kind: 'hold', ms: 1500, sway: randomSway(rng, [0.01, 0.03]) },
    { kind: 'lose', ms: lostMs },
    { kind: 'reappear', offset: reappearOffset(rng, [at[0], at[1] + THROW_DROP_IH]) },
    { kind: 'hold', ms: 2500 },
  ], { leadMs: 300, palmSize: randomPalm(rng) });
  const clip = renderSession(scene, seed * 13 + 1, `lost-${lostMs}-${seed}`);
  const played = playFrames(clip.frames, { config });
  const gap = frameGapAfter(clip.frames, 1000)!;

  // The window in which the runtime itself says the hand is gone.
  const lost = played.events.find(e => e.kind === 'hand-lost' && e.timeMs >= gap.lastWithHand.arrivalMs);
  const found = played.events.find(e => e.kind === 'hand-found' && lost && e.timeMs >= lost.timeMs);
  const inside = played.events.filter(e => lost && found && e.timeMs >= lost.timeMs && e.timeMs <= found.timeMs);
  const stale = played.ticks.filter(t => lost && found && t.snapshot.hand.lostMs > config.perception.staleMs && t.nowMs <= found.renderMs);
  const afterFound = played.ticks.filter(t => found && t.nowMs >= found.renderMs - RENDER_MS && t.nowMs <= found.renderMs + 1500);
  let teleport = 0;
  for (let i = 1; i < afterFound.length; i++) teleport = Math.max(teleport, dist(afterFound[i].snapshot.pivot, afterFound[i - 1].snapshot.pivot));
  const firstSleep = played.ticks.find(t => t.snapshot.phase === 'sleeping');
  return {
    slept: firstSleep !== undefined,
    lossesCounted: lossesCountedWhileInView(played),
    lostMs: (gap.firstBack?.frame.timestampMs ?? NaN) - gap.firstEmpty.frame.timestampMs,
    lossSeen: lost !== undefined,
    recovered: found !== undefined && lastTick(played).snapshot.phase === 'sleeping',
    intentsWhileLost: played.intents.filter(r => lost && found && r.event.arrivalMs >= lost.timeMs && r.event.arrivalMs <= found.timeMs).length,
    eventsWhileLost: inside.filter(e => e.kind !== 'hand-lost' && e.kind !== 'hand-found').map(e => e.kind),
    nonZeroVelocityWhileStale: stale.filter(t => t.snapshot.pivotVelocity[0] !== 0 || t.snapshot.pivotVelocity[1] !== 0).length,
    nonFinite: played.ticks.filter(t => !isFiniteSnapshot(t.snapshot)).length,
    teleportM: teleport,
    phasesAfterSleep: phaseSequence(played.ticks.filter(t => firstSleep && t.nowMs >= firstSleep.nowMs)),
  };
}

function y06(): ScenarioResult {
  const config = createConfig();
  const runs: LostRun[] = [];
  for (const lostMs of LOST_DURATIONS_MS) for (let i = 0; i < LOST_RUNS_PER_DURATION; i++) runs.push(lostRun(lostMs, 600 + lostMs + i, config));
  const numbers = {
    runs: runs.length,
    absenceMs: stats(runs.map(r => r.lostMs)),
    worstTeleportM: maxOf(runs.map(r => r.teleportM)),
    p95TeleportM: percentiles(runs.map(r => r.teleportM)).p95,
    eventsWhileLost: runs.flatMap(r => r.eventsWhileLost),
  };
  const checks = [
    check(
      'Y-06:nothing-fires',
      'while the hand is lost (0.3–1.5 s, yoyo asleep) nothing fires: only hand-lost / hand-found, no intent, and the hand is found again',
      runs.every(r => r.lossSeen && r.eventsWhileLost.length === 0 && r.intentsWhileLost === 0 && r.recovered),
      `${sum(runs.map(r => r.eventsWhileLost.length))} other events and ${sum(runs.map(r => r.intentsWhileLost))} intents in ${runs.length} runs; loss seen in ${runs.filter(r => r.lossSeen).length}, recovered in ${runs.filter(r => r.recovered).length}; absences ${fmt(minOf(runs.map(r => r.lostMs)), 0)}–${fmt(maxOf(runs.map(r => r.lostMs)), 0)} ms`,
    ),
    check(
      'Y-06:stale-velocity',
      `pivot velocity is exactly 0 once the data is older than ${config.perception.staleMs} ms`,
      runs.every(r => r.nonZeroVelocityWhileStale === 0),
      `${sum(runs.map(r => r.nonZeroVelocityWhileStale))} snapshots with a moving pivot and stale data`,
    ),
    check('Y-06:finite', 'no NaN or infinity anywhere in the snapshots', runs.every(r => r.nonFinite === 0), `${sum(runs.map(r => r.nonFinite))} non-finite snapshots`),
    check(
      'Y-06:teleport',
      `a hand reappearing 0.3–0.6 ih away makes the pivot move at most ${TELEPORT_LIMIT_M * 100} cm in a 16.7 ms frame (the hand itself is still)`,
      maxOf(runs.map(r => r.teleportM)) <= TELEPORT_LIMIT_M,
      `worst ${fmt(maxOf(runs.map(r => r.teleportM)) * 100, 2)} cm, p95 ${fmt(percentiles(runs.map(r => r.teleportM)).p95 * 100, 2)} cm over ${runs.length} runs`,
    ),
    check(
      'Y-06:loss-counted',
      `the metrics count the loss: exactly one per run when the hand was gone for ≥ ${LOSS_CLEARLY_LONG_MS} ms (and at most one for the borderline ${LOST_DURATIONS_MS[0]} ms), never the flickers of the tracking`,
      runs.every(r => (r.lostMs >= LOSS_CLEARLY_LONG_MS ? r.lossesCounted === 1 : r.lossesCounted <= 1)),
      `counted per run: ${LOST_DURATIONS_MS.map(ms => `${ms} ms → ${runs.filter(r => Math.abs(r.lostMs - ms) < 100).map(r => r.lossesCounted).join('')}`).join(', ')}`,
    ),
    check('Y-06:phase-kept', 'the yoyo keeps sleeping through the loss and the recovery (no state change)', runs.every(r => sameSequence(r.phasesAfterSleep, ['sleeping'])), `phase sequences after the first sleep: ${[...new Set(runs.map(r => r.phasesAfterSleep.join('>')))].join(' | ')}`),
  ];
  return { id: 'Y-06', title: 'Hand lost 0.3–1.5 s: nothing fires, no force from old data, no teleport on recovery, no NaN', evidence: 'synthetic', checks, numbers };
}

const EXIT_SPEEDS = [0.5, 1, 1.5] as const;
const EXIT_RUNS_PER_SPEED = 8;
const EXIT_HOLD_MS = 500;
/** The extrapolation the pivot may keep after the last sample: one tracking interval. */
const EXTRAPOLATION_MS = 33;
const EXIT_EXTRA_M = 0.01;

interface ExitRun {
  slept: boolean;
  speed: number;
  absenceMs: number;
  lossSeen: boolean;
  edgeMisses: number;
  phaseChanges: number;
  /** Pivot path length after the last sample arrived, m. */
  travelM: number;
  /** Where the pivot ended relative to where the hand was last seen, along the direction of motion (positive = beyond), m. */
  overshootM: number;
  /** How far the pivot lagged the hand when the last sample arrived, m. */
  lagM: number;
  handSpeed: number;
  nonFinite: number;
}

function exitRun(speed: number, seed: number, config: YoyoConfig) {
  return withSetup(seed, s => exitRunOnce(speed, s, config));
}

function exitRunOnce(speed: number, seed: number, config: YoyoConfig): ExitRun {
  const rng = new Random(seed);
  const at = restPosition(rng);
  const scene = sessionScene([
    { kind: 'appear', at, holdMs: rng.range(1000, 1300) },
    firmLaunch(rng),
    { kind: 'hold', ms: 1500, sway: randomSway(rng, [0.01, 0.03]) },
    { kind: 'lose', ms: EXIT_HOLD_MS, exit: { speed, returnMs: 600 } },
    { kind: 'hold', ms: 2000 },
  ], { leadMs: 300, palmSize: randomPalm(rng) });
  const clip = renderSession(scene, seed * 7 + 2, `exit-${speed}-${seed}`);
  const played = playFrames(clip.frames, { config });
  const gap = frameGapAfter(clip.frames, 1000)!;
  const lost = played.events.find(e => e.kind === 'hand-lost' && e.timeMs >= gap.lastWithHand.arrivalMs);
  const found = played.events.find(e => e.kind === 'hand-found' && lost && e.timeMs >= lost.timeMs);

  // The last sample the runtime saw: the last frame that carried a hand before the first empty one.
  const lastMs = gap.lastWithHand.frame.timestampMs;
  const handSpeed = (Math.abs(scene.anchorAt(lastMs + 1)[1] - scene.anchorAt(lastMs - 1)[1]) / 0.002) * config.world.scale;
  const duringAbsence = played.ticks.filter(t => lost && found && t.nowMs >= lost.renderMs && t.nowMs < found.renderMs);
  const arrivalTick = played.ticks.find(t => t.nowMs >= gap.lastWithHand.arrivalMs);
  const afterLast = played.ticks.filter(t => arrivalTick && t.nowMs >= arrivalTick.nowMs && found && t.nowMs < found.renderMs);
  let travel = 0;
  for (let i = 1; i < afterLast.length; i++) travel += dist(afterLast[i].snapshot.pivot, afterLast[i - 1].snapshot.pivot);

  // World height of the last sample: the pivot at tie-on is the world home, which is the rest position's image point (y grows up in the world).
  const tether = firstOf(played, 'tether');
  const tied = tether ? played.ticks.find(t => t.nowMs >= tether.renderMs) : undefined;
  const homeY = tied ? tied.snapshot.pivot[1] : config.world.homeY;
  const lastWorldY = homeY - config.world.scale * (scene.anchorAt(lastMs)[1] - at[1]);
  const startPivotY = afterLast.length ? afterLast[0].snapshot.pivot[1] : homeY;
  const endPivotY = afterLast.length ? afterLast[afterLast.length - 1].snapshot.pivot[1] : homeY;
  const sleepStart = played.ticks.find(t => t.snapshot.phase === 'sleeping');
  const sleepPhases = phaseSequence(played.ticks.filter(t => sleepStart && t.nowMs >= sleepStart.nowMs));
  return {
    slept: sleepStart !== undefined,
    speed,
    absenceMs: (gap.firstBack?.frame.timestampMs ?? NaN) - gap.firstEmpty.frame.timestampMs,
    lossSeen: lost !== undefined && found !== undefined,
    edgeMisses: duringAbsence.filter(t => t.snapshot.hand.edge !== 'bottom').length,
    phaseChanges: sleepPhases.length - 1,
    travelM: travel,
    // The hand went down: lower in the world is a smaller y, so the pivot is beyond the last sample when it ends below it.
    overshootM: lastWorldY - endPivotY,
    lagM: startPivotY - lastWorldY,
    handSpeed,
    nonFinite: played.ticks.filter(t => !isFiniteSnapshot(t.snapshot)).length,
  };
}

function y07(): ScenarioResult {
  const config = createConfig();
  const runs: ExitRun[] = [];
  for (const speed of EXIT_SPEEDS) for (let i = 0; i < EXIT_RUNS_PER_SPEED; i++) runs.push(exitRun(speed, 700 + Math.round(speed * 10) * 100 + i, config));
  const bound = (r: ExitRun) => (r.handSpeed * EXTRAPOLATION_MS) / 1000 + EXIT_EXTRA_M;
  const numbers = {
    runs: runs.length,
    bySpeed: EXIT_SPEEDS.map(speed => {
      const rs = runs.filter(r => r.speed === speed);
      return {
        speed, absenceMs: stats(rs.map(r => r.absenceMs)), handSpeed: stats(rs.map(r => r.handSpeed)),
        travelCm: stats(rs.map(r => r.travelM * 100)), lagCm: stats(rs.map(r => r.lagM * 100)), overshootCm: stats(rs.map(r => r.overshootM * 100)),
        boundCm: stats(rs.map(r => bound(r) * 100)),
      };
    }),
  };
  const overshootOk = runs.filter(r => r.overshootM <= bound(r));
  // «Extrapolación acotada» (PRD Y-07) is about where the pivot ENDS: it must not run on past the last sample
  // by more than one tracking interval of hand motion. It is not about how far it travels after that sample.
  // The pivot trails the hand by ~36 ms by design (1€ filter + spring, DECISIONS.md), so for a moment after the
  // last sample it only catches up with where the hand already was; that is lag, not extrapolation, and it
  // grows with speed (travel and lag are kept in the numbers for information). A bound on the travel after the
  // last sample (|v|·33 ms + 1 cm) would ask a filter with no lag for its extrapolation: it holds at 0.5 m/s
  // and fails from 1 m/s whatever the extrapolation does, so it was dropped as a criterion.
  const checks = [
    check('Y-07:set-up', 'the exit sessions were thrown and slept first, and the loss was seen', runs.every(r => r.slept && r.lossSeen), `${runs.filter(r => r.slept).length}/${runs.length} slept, ${runs.filter(r => r.lossSeen).length}/${runs.length} loss and recovery seen; absences ${fmt(minOf(finite(runs.map(r => r.absenceMs))), 0)}–${fmt(maxOf(finite(runs.map(r => r.absenceMs))), 0)} ms`),
    check(
      'Y-07:edge',
      "while the hand is out through the bottom every snapshot reports edge 'bottom' (the vignette)",
      runs.every(r => r.edgeMisses === 0),
      `${sum(runs.map(r => r.edgeMisses))} snapshots without it in ${runs.length} runs (by exit speed: ${EXIT_SPEEDS.map(v => `${v} ih/s ${sum(runs.filter(r => r.speed === v).map(r => r.edgeMisses))}`).join(', ')}); runs affected: ${runs.filter(r => r.edgeMisses > 0).length}`,
    ),
    check('Y-07:phase-kept', 'the phase is kept (still sleeping, never untethered or exhausted)', runs.every(r => r.phaseChanges === 0), `${sum(runs.map(r => r.phaseChanges))} phase changes after the first sleep`),
    check('Y-07:finite', 'no NaN or infinity', runs.every(r => r.nonFinite === 0), `${sum(runs.map(r => r.nonFinite))} non-finite snapshots`),
    check(
      'Y-07:overshoot',
      `extrapolation is bounded: the pivot ends no further than |v|·${EXTRAPOLATION_MS} ms + ${EXIT_EXTRA_M * 100} cm beyond where the hand was last seen`,
      overshootOk.length === runs.length,
      `${overshootOk.length}/${runs.length} within the bound; worst overshoot ${fmt(maxOf(runs.map(r => r.overshootM)) * 100, 2)} cm (negative: the pivot ends short of the last sample, as it lags the hand)`,
    ),
  ];
  return { id: 'Y-07', title: 'Hand out through the bottom for 0.5 s: edge reported, state kept, bounded extrapolation', evidence: 'synthetic', checks, numbers };
}

// ---------------------------------------------------------------------------------------------
// Y-08: spent spin
// ---------------------------------------------------------------------------------------------

function y08(): ScenarioResult {
  const rng = new Random(800);
  const throwSteps = (): SessionStep[] => [{ kind: 'appear', at: restPosition(rng), holdMs: 1200 }, firmLaunch(rng)];
  const tugBack: SessionStep[] = [{ kind: 'hold', ms: 1500 }, { kind: 'tug', peak: 1.4, durationMs: 150 }, { kind: 'hold', ms: 3000 }];

  // (a) Auto-return off: the hand is there when the spin runs out, so the yoyo just hangs.
  const hangingConfig = createConfig();
  hangingConfig.yoyo.autoReturn = false;
  const hanging = playFrames(renderSession(sessionScene([...throwSteps(), { kind: 'hold', ms: 17_000 }, ...tugBack], { leadMs: 300 }), 801, 'exhausted-a').frames, { config: hangingConfig });
  // (b) Hand absent when the spin runs out: even with auto-return on there is nobody to catch it.
  const absentScene = sessionScene([...throwSteps(), { kind: 'hold', ms: 6000, sway: randomSway(rng, [0.01, 0.03]) }, { kind: 'lose', ms: 13_000 }, { kind: 'reappear', offset: [0.08, 0] }, ...tugBack], { leadMs: 300 });
  const absent = playFrames(renderSession(absentScene, 802, 'exhausted-b').frames);

  const summarize = (played: Played) => {
    const exhausted = firstOf(played, 'exhausted');
    const tug = firstOf(played, 'tug', exhausted?.timeMs ?? Infinity);
    const tickWhenExhausted = exhausted ? played.ticks.find(t => t.nowMs >= exhausted.renderMs) : undefined;
    return {
      exhaustedAtMs: exhausted?.timeMs ?? null,
      handPresentWhenExhausted: tickWhenExhausted?.snapshot.hand.present ?? null,
      tugAtMs: tug?.timeMs ?? null,
      phases: phaseSequence(played.ticks),
      autoReturns: eventsOf(played, 'auto-return').length,
      spinWhenExhausted: tickWhenExhausted?.snapshot.spin ?? null,
    };
  };
  const a = summarize(hanging), b = summarize(absent);
  const wanted: YoyoPhase[] = ['sleeping', 'exhausted', 'returning', 'caught', 'tethered'];
  const tail = (phases: readonly YoyoPhase[]) => phases.slice(phases.indexOf('sleeping'));
  const checks = [
    check(
      'Y-08:hangs',
      "'exhausted' is reached with auto-return off: the yoyo hangs (the UI offers «Tirá para enrollar»)",
      a.exhaustedAtMs !== null && a.handPresentWhenExhausted === true && a.autoReturns === 0,
      `exhausted at ${fmt(a.exhaustedAtMs ?? NaN, 0)} ms, hand present: ${a.handPresentWhenExhausted}, spin ${fmt(a.spinWhenExhausted ?? NaN)} rad/s, ${a.autoReturns} auto-returns`,
    ),
    check(
      'Y-08:hand-absent',
      "'exhausted' is reached when the hand is absent as the spin runs out, even with auto-return on",
      b.exhaustedAtMs !== null && b.handPresentWhenExhausted === false && b.autoReturns === 0,
      `exhausted at ${fmt(b.exhaustedAtMs ?? NaN, 0)} ms, hand present: ${b.handPresentWhenExhausted}, ${b.autoReturns} auto-returns`,
    ),
    check(
      'Y-08:tug-from-exhausted',
      'a tug from exhausted winds the yoyo in: exhausted → returning → caught → tethered',
      sameSequence(tail(a.phases), wanted) && a.tugAtMs !== null,
      `phases from the first sleep: ${tail(a.phases).join(' > ')}; tug at ${fmt(a.tugAtMs ?? NaN, 0)} ms`,
    ),
    check(
      'Y-08:tug-after-loss',
      'a tug from exhausted also works after the hand came back from a loss',
      sameSequence(tail(b.phases), wanted) && b.tugAtMs !== null,
      `phases from the first sleep: ${tail(b.phases).join(' > ')}; tug at ${fmt(b.tugAtMs ?? NaN, 0)} ms`,
    ),
  ];
  return { id: 'Y-08', title: 'Spent spin: exhausted is defined and reachable, and a tug winds the yoyo in', evidence: 'synthetic', checks, numbers: { handPresent: a, handAbsent: b } };
}

// ---------------------------------------------------------------------------------------------
// Y-09: stability over ten minutes
// ---------------------------------------------------------------------------------------------

const STABILITY_MS = 10 * 60 * 1000;
/** Share of render frames that stall (a hitch: GC, a heavy tab), and how long a stall lasts, ms. */
const HITCH_CHANCE = 0.004;
const HITCH_MS: readonly [number, number] = [30, 140];
const STABILITY_RECALIBRATE_EVERY = 9;
const TAUT_ERROR_LIMIT = 0.02;
/** The error of a very short string is not meaningful as a ratio. */
const TAUT_MIN_LENGTH_M = 0.05;
const QUEUE_LIMIT = 8;
const SESSION_GAP_MS = 100;
/** The hand is out of view this long between two loops (plus SESSION_GAP_MS): far above what the metrics count as a loss. */
const LOOP_LEAD_MS = 500;
/** A hand lost inside a loop stays gone at least this long: clear of the metrics' MIN_HAND_LOSS_MS, so the count can be exact. */
const LOOP_LOSS_MS: readonly [number, number] = [400, 1500];

/** One looping session: a throw, a sleep, a tug, with a loss, an exit or a wave now and then. */
function loopSession(rng: Random, index: number): SessionScene {
  const at = restPosition(rng);
  const steps: SessionStep[] = [
    { kind: 'appear', at, holdMs: rng.range(600, 1200) },
    { kind: 'launch', peak: rng.range(1.5, 3), ...strokeParams(rng, 2.2, 0.38) },
    { kind: 'hold', ms: rng.range(1500, 6000), sway: randomSway(rng) },
  ];
  const roll = rng.next();
  if (roll < 0.25) {
    steps.push({ kind: 'lose', ms: rng.range(...LOOP_LOSS_MS) }, { kind: 'reappear', offset: reappearOffset(rng, [at[0], at[1] + THROW_DROP_IH]) }, { kind: 'hold', ms: 800 });
  } else if (roll < 0.35) {
    steps.push({ kind: 'lose', ms: 500, exit: { speed: rng.range(0.5, 1.5) } }, { kind: 'hold', ms: 800 });
  } else if (roll < 0.45) {
    steps.push({ kind: 'casual', motion: 'wave', ms: 1500 }, { kind: 'hold', ms: 600 });
  }
  steps.push({ kind: 'tug', peak: rng.range(0.9, 1.6), durationMs: rng.range(120, 200) }, { kind: 'hold', ms: rng.range(1500, 2500) });
  return sessionScene(steps, { leadMs: LOOP_LEAD_MS, palmSize: randomPalm(rng), handedness: rng.chance(0.5) ? 'Right' : 'Left', glitches: { count: 3, seed: index } });
}

/** Clips laid end to end with a gap, as one stream of frames in arrival order. */
function chain(clips: readonly SyntheticClip[], gapMs: number): { frames: DeliveredFrame[]; boundaries: number[]; durationMs: number } {
  const frames: DeliveredFrame[] = [];
  const boundaries: number[] = [];
  let offset = 0;
  for (const clip of clips) {
    boundaries.push(offset);
    for (const { frame, arrivalMs } of clip.frames) frames.push({ frame: { ...frame, timestampMs: frame.timestampMs + offset }, arrivalMs: arrivalMs + offset });
    offset += clip.durationMs + gapMs;
  }
  return { frames, boundaries, durationMs: offset };
}

function y09(): ScenarioResult {
  const config = createConfig();
  const rng = new Random(900_001);
  const clips: SyntheticClip[] = [];
  const scenes: SessionScene[] = [];
  let total = 0, index = 0;
  while (total < STABILITY_MS) {
    const scene = loopSession(rng, index);
    const clip = renderSession(scene, 9000 + index, `loop-${index}`);
    scenes.push(scene);
    clips.push(clip);
    total += clip.durationMs + SESSION_GAP_MS;
    index++;
  }
  const { frames, boundaries, durationMs } = chain(clips, SESSION_GAP_MS);

  // Render times: a steady 60 Hz with the odd stall, so the step cap is exercised and its dropped time reported.
  const hitchRng = new Random(900_002);
  let clock = 0;
  const renderTime = (k: number): number => {
    if (k > 0) clock += RENDER_MS + (hitchRng.chance(HITCH_CHANCE) ? hitchRng.range(...HITCH_MS) : 0);
    return clock;
  };

  let nonFinite = 0, lengthOver = -Infinity, reachOver = -Infinity, tautWorst = 0, tautSamples = 0, jumps = -Infinity, ticks = 0, endMs = 0, handLostEvents = 0;
  let previous: YoyoSnapshot | null = null;
  const phaseTicks: Record<string, number> = {};
  let nextBoundary = 1;
  const done = playFrames(frames, { config }, {
    endMs: durationMs + TAIL_MS,
    keepTicks: false,
    renderTime,
    beforeTick: (runtime, nowMs) => {
      // Every few loops the user recalibrates, between two sessions (the hand is out of view there).
      if (nextBoundary < boundaries.length && nowMs >= boundaries[nextBoundary] - SESSION_GAP_MS) {
        if (nextBoundary % STABILITY_RECALIBRATE_EVERY === 0) runtime.recalibrate();
        nextBoundary++;
      }
    },
    onTick: ({ snapshot: s, nowMs, peakSpeed, physicsS }) => {
      ticks++;
      endMs = nowMs;
      for (const e of s.events) if (e.kind === 'hand-lost') handLostEvents++;
      if (!isFiniteSnapshot(s)) nonFinite++;
      phaseTicks[s.phase] = (phaseTicks[s.phase] ?? 0) + 1;
      if (s.phase !== 'untethered') {
        lengthOver = Math.max(lengthOver, s.length - s.maxLength);
        reachOver = Math.max(reachOver, dist(s.yoyo, s.pivot) - s.maxLength);
        if (!s.slack && s.length >= TAUT_MIN_LENGTH_M && (s.phase === 'rolling' || s.phase === 'sleeping' || s.phase === 'exhausted')) {
          tautWorst = Math.max(tautWorst, Math.abs(dist(s.yoyo, s.pivot) - s.length) / s.length);
          tautSamples++;
        }
        if (previous && previous.phase !== 'untethered') {
          jumps = Math.max(jumps, dist(s.yoyo, previous.yoyo) - peakSpeed * physicsS);
        }
      }
      previous = s;
    },
  });
  const { runtime } = done;
  const metrics = runtime.metrics.snapshot(endMs);
  const d = runtime.diagnostics;
  const stepMs = 1000 / config.sim.hz;
  const accountedMs = d.stepsTotal * stepMs + d.droppedMs;
  // The hand is really lost: every absence inside a loop (they last ≥ 400 ms), the gap between two loops, and the
  // silence at the end of the run. The lead of the very first loop is not a loss: the hand had not appeared yet.
  const expectedHandLosses = sum(scenes.map((scene, k) => scene.absences.filter(a => a.startMs > 0).length + (k > 0 ? 1 : 0))) + 1;
  const numbers = {
    simulatedMinutes: endMs / 60_000,
    sessions: clips.length,
    frames: frames.length,
    renderFrames: ticks,
    stepsTotal: d.stepsTotal,
    modelSteps: runtime.model.stepsTaken,
    droppedMs: d.droppedMs,
    droppedShare: d.droppedMs / endMs,
    accountedMs,
    queuePeak: d.queuePeak,
    queueDrops: d.queueDrops,
    nonFinite,
    worstLengthOverMaxM: lengthOver,
    worstReachOverMaxM: reachOver,
    worstTautLengthError: tautWorst,
    tautSamples,
    worstSnapshotJumpBeyondPeakSpeedM: jumps,
    phaseTicks,
    handLostEvents,
    expectedHandLosses,
    metrics: { launches: metrics.launches, tugs: metrics.tugs, catches: metrics.catches, autoReturns: metrics.autoReturns, exhausted: metrics.exhausted, handLosses: metrics.handLosses, ignoredIntents: metrics.ignoredIntents },
  };
  const checks = [
    check(
      'Y-09:finite',
      'ten simulated minutes at 240 Hz: no NaN or infinity in any snapshot',
      nonFinite === 0 && endMs >= STABILITY_MS,
      `${nonFinite} non-finite snapshots over ${fmt(endMs / 60_000, 2)} simulated minutes; ${d.stepsTotal} fixed steps (${runtime.model.stepsTaken} with the yoyo tied on), ${fmt(d.droppedMs, 1)} ms dropped by the step cap (${fmt((d.droppedMs / endMs) * 100, 3)} %)`,
    ),
    check('Y-09:queue', `the input queue never holds more than ${QUEUE_LIMIT}`, d.queuePeak <= QUEUE_LIMIT, `peak ${d.queuePeak}, ${d.queueDrops} inputs dropped`),
    check('Y-09:taut-error', `taut string length error < ${TAUT_ERROR_LIMIT * 100} %`, tautSamples > 0 && tautWorst < TAUT_ERROR_LIMIT, `worst ${fmt(tautWorst * 100, 4)} % over ${tautSamples} taut snapshots`),
    check(
      'Y-09:length',
      'L and the string stretch stay within maxLength + 1 mm',
      lengthOver <= LENGTH_SLACK_M && reachOver <= LENGTH_SLACK_M,
      `worst L over maxLength ${fmt(lengthOver * 1000, 3)} mm, worst |yoyo − pivot| over it ${fmt(reachOver * 1000, 3)} mm`,
    ),
    check(
      'Y-09:hand-losses',
      `the metrics count the real hand losses (≥ ${MIN_HAND_LOSS_MS} ms) and not the flickers of the tracking`,
      metrics.handLosses === expectedHandLosses && handLostEvents > metrics.handLosses,
      `${metrics.handLosses} counted, ${expectedHandLosses} expected from the sessions' absences; the runtime said hand-lost ${handLostEvents} times (the other ${handLostEvents - metrics.handLosses} are camera stalls of a few frames)`,
    ),
    check(
      'Y-09:time-accounted',
      'no time is lost silently: fixed steps plus the time the step cap dropped account for the whole run',
      Math.abs(accountedMs - endMs) <= stepMs,
      `${fmt(accountedMs, 1)} ms accounted of ${fmt(endMs, 1)} ms (difference ${fmt(endMs - accountedMs, 2)} ms, under one ${fmt(stepMs, 2)} ms step)`,
    ),
  ];
  return { id: 'Y-09', title: 'Stability: 10 simulated minutes, no NaN, bounded queue, taut length error < 2 %, L ≤ maxLength + 1 mm', evidence: 'synthetic', checks, numbers };
}

// ---------------------------------------------------------------------------------------------
// Y-11: the same session by camera and by mouse
// ---------------------------------------------------------------------------------------------

const PARITY_RUNS = 12;
const FULL_SEQUENCE: readonly YoyoPhase[] = ['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'tethered'];

function paritySession(seed: number): SessionScene {
  const rng = new Random(seed);
  return sessionScene([
    { kind: 'appear', at: restPosition(rng), holdMs: rng.range(1000, 1300) },
    { kind: 'launch', peak: rng.range(1.5, 3), ...strokeParams(rng, 2.2) },
    { kind: 'hold', ms: 2500 },
    { kind: 'tug', peak: rng.range(0.9, 1.6), durationMs: rng.range(120, 200) },
    { kind: 'hold', ms: 2800 },
  ], { leadMs: 300, palmSize: randomPalm(rng) });
}

function y11(): ScenarioResult {
  const config = createConfig();
  const pointerMapping = mappingFromHome(config, DEFAULT_HOME_IMAGE);
  const rows = Array.from({ length: PARITY_RUNS }, (_, i) => {
    const scene = paritySession(1100 + i);
    const mouse = playPointer(pointerScriptFromScene(scene, POINTER_RECT), { config, pointerMapping });
    const clean = playFrames(renderCleanSession(scene, `parity-clean-${i}`).frames, { config });
    const noisy = playFrames(renderSession(scene, 1100 + i, `parity-noisy-${i}`).frames, { config });
    const [launchLabel, tugLabel] = scene.labels;
    const decision = (played: Played, label: GestureLabel) => {
      const record = intentFor(played, label);
      return record ? record.event.timestampMs - label.onsetMs : NaN;
    };
    return {
      mouse: phaseSequence(mouse.ticks), clean: phaseSequence(clean.ticks), noisy: phaseSequence(noisy.ticks),
      mouseEvents: gameEvents(mouse), cleanEvents: gameEvents(clean),
      mouseLaunchDecisionMs: decision(mouse, launchLabel), mouseTugDecisionMs: decision(mouse, tugLabel),
    };
  });
  const count = (pick: (r: (typeof rows)[number]) => boolean) => rows.filter(pick).length;
  const mouseFull = count(r => sameSequence(r.mouse, FULL_SEQUENCE));
  const cleanSame = count(r => sameSequence(r.mouse, r.clean));
  const cleanSameEvents = count(r => sameSequence(r.mouseEvents, r.cleanEvents));
  const noisyFull = count(r => sameSequence(r.noisy, FULL_SEQUENCE));
  const mouseDecisionMax = maxOf(finite(rows.flatMap(r => [r.mouseLaunchDecisionMs, r.mouseTugDecisionMs])));
  const numbers = {
    runs: PARITY_RUNS, mouseFull, cleanCameraSamePhases: cleanSame, cleanCameraSameEvents: cleanSameEvents, noisyCameraFullSequence: noisyFull,
    phases: rows[0].mouse, mouseLaunchDecisionMs: stats(rows.map(r => r.mouseLaunchDecisionMs)), mouseTugDecisionMs: stats(rows.map(r => r.mouseTugDecisionMs)),
  };
  const checks = [
    check('Y-11:mouse-sequence', `the mouse route walks ${FULL_SEQUENCE.join(' → ')} in every run`, mouseFull === PARITY_RUNS, `${mouseFull}/${PARITY_RUNS} runs; sequence of run 0: ${rows[0].mouse.join(' > ')}`),
    check(
      'Y-11:same-states',
      'a camera with perfect tracking replaying the same sessions walks the same phases and fires the same events as the mouse',
      cleanSame === PARITY_RUNS && cleanSameEvents === PARITY_RUNS,
      `identical phase sequences ${cleanSame}/${PARITY_RUNS}, identical event sequences ${cleanSameEvents}/${PARITY_RUNS}`,
    ),
    check(
      'Y-11:mouse-latency',
      `pointer route: every launch and tug is detected within ${TUG_MAX_DECISION_MS} ms of the labelled onset`,
      mouseDecisionMax <= TUG_MAX_DECISION_MS && finite(rows.flatMap(r => [r.mouseLaunchDecisionMs, r.mouseTugDecisionMs])).length === 2 * PARITY_RUNS,
      `launch decision max ${fmt(maxOf(finite(rows.map(r => r.mouseLaunchDecisionMs))))} ms, tug decision max ${fmt(maxOf(finite(rows.map(r => r.mouseTugDecisionMs))))} ms after the onset`,
    ),
  ];
  return { id: 'Y-11', title: 'Mouse parity: the pointer route walks the same states as the camera replay', evidence: 'synthetic', checks, numbers };
}

// ---------------------------------------------------------------------------------------------
// Y-S4: determinism through the whole pipeline
// ---------------------------------------------------------------------------------------------

const DETERMINISM_TOLERANCE = 1e-6;

/** Largest numeric difference between two snapshots, Infinity when anything non-numeric differs. */
function snapshotDifference(a: YoyoSnapshot, b: YoyoSnapshot): number {
  let worst = 0;
  const number = (x: number, y: number) => { worst = Math.max(worst, Math.abs(x - y)); };
  const exact = (x: unknown, y: unknown) => { if (x !== y) worst = Infinity; };
  number(a.timeMs, b.timeMs);
  exact(a.phase, b.phase); exact(a.responsiveness, b.responsiveness); exact(a.paused, b.paused); exact(a.slack, b.slack);
  for (const k of [0, 1] as const) {
    number(a.pivot[k], b.pivot[k]); number(a.pivotVelocity[k], b.pivotVelocity[k]);
    number(a.yoyo[k], b.yoyo[k]); number(a.yoyoVelocity[k], b.yoyoVelocity[k]);
  }
  number(a.length, b.length); number(a.spin, b.spin); number(a.spinAngle, b.spinAngle); number(a.tension, b.tension);
  number(a.steps, b.steps); number(a.droppedMs, b.droppedMs);
  exact(a.hand.present, b.hand.present); exact(a.hand.edge, b.hand.edge);
  number(a.hand.lostMs, b.hand.lostMs); number(a.hand.palmWorld, b.hand.palmWorld);
  exact(a.hand.landmarks === null, b.hand.landmarks === null);
  if (a.hand.landmarks && b.hand.landmarks) for (let i = 0; i < a.hand.landmarks.length; i++) { number(a.hand.landmarks[i][0], b.hand.landmarks[i][0]); number(a.hand.landmarks[i][1], b.hand.landmarks[i][1]); }
  exact(a.events.length, b.events.length);
  if (a.events.length === b.events.length) {
    a.events.forEach((e, i) => {
      exact(e.kind, b.events[i].kind); number(e.timeMs, b.events[i].timeMs);
      exact(e.strength === undefined, b.events[i].strength === undefined); exact(e.causeMs === undefined, b.events[i].causeMs === undefined);
      number(e.strength ?? 0, b.events[i].strength ?? 0); number(e.causeMs ?? 0, b.events[i].causeMs ?? 0);
    });
  }
  return worst;
}

function ticksDifference(a: readonly Tick[], b: readonly Tick[]): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, snapshotDifference(a[i].snapshot, b[i].snapshot));
  return worst;
}

const DEMO_SEEDS = 200;
/** The floor of the world is the table, y = 0 (AGENTS.md); a sleeping yoyo must hang at least this far above it to be on the screen. */
const FLOOR_Y = 0;
const SLEEPER_CLEARANCE_M = 0.05;

/** The lowest height of the yoyo while it sleeps in `snapshots`, m above the floor; Infinity when it never sleeps. */
function lowestSleeper(snapshots: readonly YoyoSnapshot[]): number {
  let lowest = Infinity;
  for (const s of snapshots) if (s.phase === 'sleeping') lowest = Math.min(lowest, s.yoyo[1] - FLOOR_Y);
  return lowest;
}

/**
 * «Ver demo» for every seed: how many walk both rounds on the first take of the camera noise, and how many after the
 * validated takes. A first take that stops halfway is explained when the classifier ALONE, with both intents always
 * armed and no runtime around it, also misses a labelled gesture of that clip: then it is the classifier's noise
 * floor and nothing the runtime or the physics did. And how high the sleeper hangs: the lowest it gets in any sleep of
 * any demo, with the world re-homed where the hand is (how the demo plays) and with the standing framing zone.
 */
function demoSeeds() {
  let firstTake = 0, working = 0, maxTake = 0, classifierMisses = 0;
  let lowestRehomed = Infinity, lowestZone = Infinity, lowestSeed = 0;
  const takes: Record<number, number> = {};
  for (let seed = 1; seed <= DEMO_SEEDS; seed++) {
    const first = renderDemoTake(seed, 0);
    if (walksBothRounds(first)) firstTake++;
    else if (matchDetections(first.labels, runFrames(first.frames, { launch: true, tug: true }, createConfig())).missed.length > 0) classifierMisses++;
    const clip = buildDemoSession(seed);
    const take = Number(clip.tags.find(tag => tag.startsWith('take='))!.slice('take='.length));
    takes[take] = (takes[take] ?? 0) + 1;
    maxTake = Math.max(maxTake, take);
    if (walksBothRounds(clip)) working++;
    const rehomed = lowestSleeper(replayClip(clip));
    if (rehomed < lowestRehomed) { lowestRehomed = rehomed; lowestSeed = seed; }
    lowestZone = Math.min(lowestZone, lowestSleeper(replayClip(clip, { zone: framingZone('standing') })));
  }
  return { seeds: DEMO_SEEDS, firstTake, working, maxTake, takes, classifierMisses, unexplained: DEMO_SEEDS - firstTake - classifierMisses, lowestSleeperM: lowestRehomed, lowestSleeperSeed: lowestSeed, lowestSleeperZoneM: lowestZone };
}

/** Out through the bottom the hand pulls the pivot down with it, and the yoyo hangs under the floor for that moment: it is the point of the exit. */
const QA_EXIT_SLEEPER_SKIP_BEFORE_MS = 300;
const QA_EXIT_SLEEPER_SKIP_AFTER_MS = 1500;

/**
 * The browser QA camera session for every seed: how many walk their phases and edge on the first take, how many after
 * the validated takes (a seed that no take serves throws, and counts as one that does not work), how long they are, how
 * long the hand is out, and how high the sleeper hangs outside the exit.
 */
function qaSeeds() {
  let firstTake = 0, working = 0, maxTake = 0;
  let shortest = Infinity, longest = 0, shortestExit = Infinity, longestExit = 0, lowest = Infinity;
  const takes: Record<number, number> = {};
  const failures: string[] = [];
  for (let seed = 1; seed <= DEMO_SEEDS; seed++) {
    if (qaCheckTake(renderQaTake(seed, 0), qaSessionScene(seed)).walks) firstTake++;
    let session: QaCameraSession;
    try {
      session = buildQaCameraSession(seed);
    } catch (error) {
      failures.push(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    working++;
    takes[session.take] = (takes[session.take] ?? 0) + 1;
    maxTake = Math.max(maxTake, session.take);
    shortest = Math.min(shortest, session.durationMs);
    longest = Math.max(longest, session.durationMs);
    const exit = session.absences.find(a => a.exit)!;
    shortestExit = Math.min(shortestExit, exit.endMs - exit.startMs);
    longestExit = Math.max(longestExit, exit.endMs - exit.startMs);
    const outside = replayClip(session, { zone: framingZone('standing') }).filter(s => s.timeMs < exit.startMs - QA_EXIT_SLEEPER_SKIP_BEFORE_MS || s.timeMs > exit.endMs + QA_EXIT_SLEEPER_SKIP_AFTER_MS);
    lowest = Math.min(lowest, lowestSleeper(outside));
  }
  return { seeds: DEMO_SEEDS, firstTake, working, maxTake, takes, failures, shortestMs: shortest, longestMs: longest, shortestExitMs: shortestExit, longestExitMs: longestExit, lowestSleeperM: lowest };
}

function yS4(): ScenarioResult {
  // The very clip the «Ver demo» button plays: two rounds of throw, sleep, tug and catch.
  const clip = buildDemoSession(DEMO_SEED);
  const first = playFrames(clip.frames);
  const second = playFrames(clip.frames);
  // The same session after a round trip through a replay file: what the recorder writes is what the runtime reads.
  const roundTrip = playFrames(replayFrames(parseReplay(serializeReplay(toReplayFile(clip, 'determinism')))));
  const sameRuns = ticksDifference(first.ticks, second.ticks);
  const viaFile = ticksDifference(first.ticks, roundTrip.ticks);
  const metricsA = first.runtime.metrics.snapshot(1e9), metricsB = second.runtime.metrics.snapshot(1e9);
  const checks = [
    check(
      'Y-S4:twice',
      'the same replay run twice through fresh runtimes gives identical snapshots (positions, spin, phase, events)',
      sameRuns <= DETERMINISM_TOLERANCE && first.ticks.length > 500,
      `worst difference ${sameRuns} over ${first.ticks.length} snapshots (tolerance ${DETERMINISM_TOLERANCE}); events: ${gameEvents(first).join(', ')}`,
    ),
    check('Y-S4:replay-file', 'the same session through a replay file (serialize → parse → replay) matches the in-memory one', viaFile <= DETERMINISM_TOLERANCE, `worst difference ${viaFile} over ${roundTrip.ticks.length} snapshots`),
    check('Y-S4:metrics', 'the session metrics are identical too', JSON.stringify(metricsA) === JSON.stringify(metricsB), `launches ${metricsA.launches}, tugs ${metricsA.tugs}, catches ${metricsA.catches}`),
  ];
  const demo = demoSeeds();
  checks.push(check(
    'Y-S4:demo-seeds',
    `«Ver demo» walks both rounds (tie-on, throw, sleep, tug, catch, twice) for ${demo.seeds} of ${demo.seeds} seeds, deterministically`,
    demo.working === demo.seeds,
    `${demo.working}/${demo.seeds} seeds work; the first take of the camera noise works on ${demo.firstTake}/${demo.seeds}, the rest need a retake (takes needed: ${Object.entries(demo.takes).map(([take, n]) => `${take}:${n}`).join(', ')}; max ${demo.maxTake})`,
  ));
  checks.push(check(
    'Y-S4:demo-sleeper-on-screen',
    `in every demo the sleeper hangs at least ${SLEEPER_CLEARANCE_M * 100} cm above the floor (y = ${FLOOR_Y}) in every sleeping phase, with the world re-homed where the hand is and with the standing framing zone: the hand follows through after the throw`,
    demo.lowestSleeperM >= SLEEPER_CLEARANCE_M && demo.lowestSleeperZoneM >= SLEEPER_CLEARANCE_M,
    `lowest over ${demo.seeds} seeds: ${fmt(demo.lowestSleeperM * 100, 1)} cm re-homed (seed ${demo.lowestSleeperSeed}), ${fmt(demo.lowestSleeperZoneM * 100, 1)} cm with the zone`,
  ));
  checks.push(check(
    'Y-S4:demo-misses-are-perception',
    'every demo take that stops halfway does so because the classifier alone misses a gesture of it (the noise floor of the PRD thresholds): nothing the runtime or the physics did',
    demo.unexplained === 0,
    `${demo.seeds - demo.firstTake} first takes stop halfway; ${demo.classifierMisses} of them also lose a gesture for the classifier alone with both intents always armed, ${demo.unexplained} do not`,
  ));
  const qa = qaSeeds();
  checks.push(check(
    'Y-S4:qa-session-seeds',
    `the browser QA camera session (hand in the standing zone, two rounds, the second with the hand out through the bottom) walks its phases and its bottom edge for ${qa.seeds} of ${qa.seeds} seeds`,
    qa.working === qa.seeds,
    `${qa.working}/${qa.seeds} seeds work; the first take of the camera noise works on ${qa.firstTake}/${qa.seeds} (takes needed: ${Object.entries(qa.takes).map(([take, n]) => `${take}:${n}`).join(', ')}; max ${qa.maxTake})${qa.failures.length ? `; ${qa.failures.slice(0, 3).join('; ')}` : ''}`,
  ));
  checks.push(check(
    'Y-S4:qa-session-shape',
    `the QA session lasts 19–21 s, the hand is out through the bottom for 0.5–0.75 s, and outside that exit the sleeper hangs at least ${SLEEPER_CLEARANCE_M * 100} cm above the floor`,
    qa.shortestMs >= 19_000 && qa.longestMs <= 21_000 && qa.shortestExitMs >= 500 && qa.longestExitMs <= 750 && qa.lowestSleeperM >= SLEEPER_CLEARANCE_M,
    `${fmt(qa.shortestMs / 1000, 2)}–${fmt(qa.longestMs / 1000, 2)} s; exit absence ${fmt(qa.shortestExitMs, 0)}–${fmt(qa.longestExitMs, 0)} ms; lowest sleeper outside the exit ${fmt(qa.lowestSleeperM * 100, 1)} cm`,
  ));
  return { id: 'Y-S4', title: 'Determinism: the same replay gives the same trajectory through the whole pipeline (1e-6); the demo and the QA session work for every seed', evidence: 'synthetic', checks, numbers: { sameRuns, viaFile, snapshots: first.ticks.length, frames: clip.frames.length, tolerance: DETERMINISM_TOLERANCE, demo, qa } };
}

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

export interface ScenarioEntry {
  id: string;
  run: () => ScenarioResult;
}

export const SCENARIOS: readonly ScenarioEntry[] = [
  { id: 'Y-01', run: y01 },
  { id: 'Y-02', run: y02 },
  { id: 'Y-03', run: y03 },
  { id: 'Y-04', run: y04 },
  { id: 'Y-05', run: y05 },
  { id: 'Y-06', run: y06 },
  { id: 'Y-07', run: y07 },
  { id: 'Y-08', run: y08 },
  { id: 'Y-09', run: y09 },
  { id: 'Y-11', run: y11 },
  { id: 'Y-S4', run: yS4 },
];

/**
 * Runs one scenario. An exception inside it (a bug in the harness, not a criterion that failed) is
 * reported as a failing check instead of taking the other scenarios down with it.
 */
export function runScenario(entry: ScenarioEntry): ScenarioResult {
  try {
    return entry.run();
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    return { id: entry.id, title: `${entry.id} (the scenario itself threw)`, evidence: 'synthetic', checks: [check(`${entry.id}:runs`, 'the scenario runs to the end', false, message)], numbers: {} };
  }
}
