/**
 * Yoyó physics benchmark and long-run stability (Y-10 and Y-09). SYNTHETIC input, Node on this
 * machine: it measures the cost of the physics (pin stabilizer + reduced model) and nothing else.
 * No rendering, no tracking, no browser main-thread contention. The browser will be slower; this
 * number says how much of the 1.5 ms budget the physics alone spends, not what a frame costs.
 *
 * The chain is the real one: a random hand → noisy 30 Hz samples with 50 ms latency, dropouts and
 * discontinuities → PinStabilizer → YoyoModel at 240 Hz, 4 steps per 60 Hz frame.
 *
 * Writes artifacts/qa/yoyo/benchmark.json and exits 1 if any criterion fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createConfig, type YoyoConfig } from '../src/yoyo/config';
import type { PinState, YoyoEvent, YoyoPhase } from '../src/yoyo/contracts';
import { PinStabilizer, type PinSample } from '../src/yoyo/perception/PinStabilizer';
import { Random } from '../src/yoyo/replay/random';
import { YoyoModel } from '../src/yoyo/sim/YoyoModel';

const STEP_S = 1 / 240;
const STEP_MS = 1000 / 240;
const STEPS_PER_FRAME = 4;
const STEPS_PER_SAMPLE = 8;
/** Capture → arrival delay in steps: 12 steps = 50 ms, with ±1 step of jitter. */
const LATENCY_STEPS = 12;
const JITTER_SIGMA = 0.0067;

/** Y-10: physics per render frame at the 95th percentile, ms. */
const FRAME_BUDGET_P95_MS = 1.5;
const TIMED_FRAMES = 240_000;
const WARMUP_FRAMES = 30_000;
/** Y-09: ten minutes of simulated time at 240 Hz. */
const STABILITY_STEPS = 10 * 60 * 240;
const STABILITY_SEEDS = [1, 2, 3];
const MAX_TAUT_ERROR = 0.02;
const MAX_LENGTH_OVER_M = 0.001;
const MAX_PIVOT_SPEED = 2.5;
const MAX_PIVOT_ACCELERATION = 25;
/** A spent yoyo waits this long before the scripted player tugs it, ms. */
const EXHAUSTED_TUG_AFTER_MS = 1000;
/**
 * Y-06: the pivot never moves more than this in one 60 Hz frame beyond what its target (the hand where it
 * was LATENCY_STEPS ago) moved in the same frame, cm. A hand at 3 m/s moves 5 cm per frame on its own and a
 * pivot that keeps up with it has teleported nothing.
 */
const TELEPORT_LIMIT_CM = 5;
/** How many steps of the hand's true path are kept: at least the latency plus a frame of look-ahead, rounded up. */
const HAND_TRAIL_STEPS = 32;
/** Events the runtime has to drain per frame: four steps, a couple of events each at most. Anything more is a leak. */
const MAX_EVENTS_PER_FRAME = 8;
const HOME: readonly [number, number] = [0, 0.85];

// ---------------------------------------------------------------------------------------------
// Random hand (the same smooth-sway-plus-strokes motion the property tests use, kept local on
// purpose: scripts do not import test files).
// ---------------------------------------------------------------------------------------------

interface Stroke {
  elapsed: number;
  duration: number;
  distance: number;
  dx: number;
  dy: number;
}

class Hand {
  x = HOME[0];
  y = HOME[1];
  private vx = 0;
  private vy = 0;
  private driftVx = 0;
  private driftVy = 0;
  private readonly strokes: Stroke[] = [];

  constructor(private readonly random: Random, private readonly swayStd: number) {}

  /** A directed stroke: peak speed m/s, angle rad (−π/2 = down), duration s. */
  gesture(peakSpeed: number, angle: number, duration: number): void {
    this.strokes.push({ elapsed: 0, duration, distance: (peakSpeed * duration) / 1.875, dx: Math.cos(angle), dy: Math.sin(angle) });
  }

  step(): void {
    const tau = 0.4;
    const pull = 20;
    const noise = this.swayStd * Math.sqrt(2 / tau) * Math.sqrt(STEP_S);
    this.driftVx += (-this.driftVx / tau - pull * (this.x - HOME[0])) * STEP_S + noise * this.random.gaussian();
    this.driftVy += (-this.driftVy / tau - pull * (this.y - HOME[1])) * STEP_S + noise * this.random.gaussian();
    let strokeVx = 0;
    let strokeVy = 0;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i];
      stroke.elapsed += STEP_S;
      const u = stroke.elapsed / stroke.duration;
      if (u >= 1) {
        this.strokes.splice(i, 1);
        continue;
      }
      const speed = (stroke.distance / stroke.duration) * (30 * u * u - 60 * u ** 3 + 30 * u ** 4);
      strokeVx += speed * stroke.dx;
      strokeVy += speed * stroke.dy;
    }
    let targetVx = this.driftVx + strokeVx;
    let targetVy = this.driftVy + strokeVy;
    const speed = Math.hypot(targetVx, targetVy);
    if (speed > MAX_PIVOT_SPEED) {
      targetVx *= MAX_PIVOT_SPEED / speed;
      targetVy *= MAX_PIVOT_SPEED / speed;
    }
    let ax = (targetVx - this.vx) / STEP_S;
    let ay = (targetVy - this.vy) / STEP_S;
    const acceleration = Math.hypot(ax, ay);
    if (acceleration > MAX_PIVOT_ACCELERATION) {
      ax *= MAX_PIVOT_ACCELERATION / acceleration;
      ay *= MAX_PIVOT_ACCELERATION / acceleration;
    }
    this.vx += ax * STEP_S;
    this.vy += ay * STEP_S;
    this.x += this.vx * STEP_S;
    this.y += this.vy * STEP_S;
  }
}

// ---------------------------------------------------------------------------------------------
// One simulated play session: hand, tracking stream, stabilizer, model and the cycle script.
// ---------------------------------------------------------------------------------------------

interface Arrival {
  valid: boolean;
  x: number;
  y: number;
  timestampMs: number;
  arrivalMs: number;
  continuous: boolean;
}

interface InFlight extends Arrival {
  /** Absolute step at which it arrives. */
  step: number;
}

type CyclePlan = 'tug' | 'auto-return';

class Session {
  readonly pin: PinStabilizer;
  readonly model: YoyoModel;
  readonly events: YoyoEvent[] = [];
  readonly counts: Record<string, number> = {};
  maxEventsPerFrame = 0;
  stepCount = 0;

  private readonly random: Random;
  private readonly hand: Hand;
  private readonly sample: PinSample = { x: 0, y: 0, timestampMs: 0, arrivalMs: 0, continuous: false };
  private readonly frame: Arrival[] = Array.from({ length: STEPS_PER_FRAME }, () => ({ valid: false, x: 0, y: 0, timestampMs: 0, arrivalMs: 0, continuous: false }));
  private readonly inFlight: InFlight[] = [];
  /** The hand's true position at each of the last steps (ring buffer, x then y): the target is where it was LATENCY_STEPS ago. */
  private readonly handTrail = new Float64Array(2 * HAND_TRAIL_STEPS);
  private firstSample = true;
  private dropSamples = 0;
  private lostAGap = false;
  // Cycle script.
  private plan: CyclePlan = 'tug';
  private launchAfterMs = 800;
  private tugAfterMs = 2000;

  constructor(seed: number, readonly config: YoyoConfig = createConfig()) {
    this.random = new Random(seed);
    this.hand = new Hand(this.random, this.random.range(0.03, 0.25));
    this.pin = new PinStabilizer(config);
    this.model = new YoyoModel(config);
    this.pin.reset({ x: HOME[0], y: HOME[1], vx: 0, vy: 0 });
    this.model.tether(this.pin.state, 0, this.events);
    this.drainEvents();
    for (let i = 0; i < HAND_TRAIL_STEPS; i++) {
      this.handTrail[2 * i] = HOME[0];
      this.handTrail[2 * i + 1] = HOME[1];
    }
  }

  get timeMs(): number {
    return this.stepCount * STEP_MS;
  }

  /** The hand as the stabilizer's newest data has it: its true position LATENCY_STEPS before the current step. */
  get target(): { x: number; y: number } {
    const slot = (((this.stepCount - LATENCY_STEPS) % HAND_TRAIL_STEPS) + HAND_TRAIL_STEPS) % HAND_TRAIL_STEPS;
    return { x: this.handTrail[2 * slot], y: this.handTrail[2 * slot + 1] };
  }

  /**
   * Untimed half of a frame: moves the hand, produces the tracking samples that arrive during the
   * next four steps, and runs the cycle script (the intent classifier's job in the real app).
   */
  prepareFrame(): void {
    this.runScript();
    for (let k = 0; k < STEPS_PER_FRAME; k++) {
      const stepNumber = this.stepCount + k + 1;
      this.hand.step();
      this.handTrail[2 * (stepNumber % HAND_TRAIL_STEPS)] = this.hand.x;
      this.handTrail[2 * (stepNumber % HAND_TRAIL_STEPS) + 1] = this.hand.y;
      if (stepNumber % STEPS_PER_SAMPLE === 0) this.capture(stepNumber);
      this.frame[k].valid = false;
      for (let i = 0; i < this.inFlight.length; i++) {
        if (this.inFlight[i].step === stepNumber) {
          Object.assign(this.frame[k], this.inFlight[i]);
          this.frame[k].valid = true;
          this.inFlight.splice(i, 1);
          break;
        }
      }
    }
  }

  /**
   * Timed half of a frame: the physics. Four fixed steps of pin + model, with the samples that
   * arrive in between pushed to the stabilizer, exactly as the runtime does.
   */
  physicsFrame(observe?: (session: Session) => void): void {
    for (let k = 0; k < STEPS_PER_FRAME; k++) {
      const arrival = this.frame[k];
      if (arrival.valid) {
        const sample = this.sample;
        sample.x = arrival.x;
        sample.y = arrival.y;
        sample.timestampMs = arrival.timestampMs;
        sample.arrivalMs = arrival.arrivalMs;
        sample.continuous = arrival.continuous;
        this.pin.push(sample);
      }
      this.stepCount++;
      const timeMs = this.stepCount * STEP_MS;
      const pivot = this.pin.step(STEP_S, timeMs);
      this.model.step(STEP_S, { pin: pivot, handPresent: this.pin.fresh }, timeMs, this.events);
      observe?.(this);
    }
    this.drainEvents();
  }

  /** A raw sample taken at `stepNumber`, subject to jitter, dropouts and gaps. */
  private capture(stepNumber: number): void {
    if (this.dropSamples > 0) {
      this.dropSamples--;
      this.lostAGap = true;
      return;
    }
    if (this.random.chance(0.004)) {
      // Tracking dropout: 3–12 samples (100–400 ms) never arrive. Long ones leave the pivot frozen.
      this.dropSamples = this.random.int(3, 12);
      this.lostAGap = true;
      return;
    }
    if (this.random.chance(0.0004)) {
      // The hand leaves the frame for a second or more.
      this.dropSamples = this.random.int(30, 90);
      this.lostAGap = true;
      return;
    }
    const jitter = this.random.int(-1, 1);
    const lastArrival = this.inFlight.length ? this.inFlight[this.inFlight.length - 1].step : 0;
    const arrivalStep = Math.max(stepNumber + LATENCY_STEPS + jitter, lastArrival + 1);
    this.inFlight.push({
      valid: true,
      step: arrivalStep,
      x: this.hand.x + this.random.gaussian(0, JITTER_SIGMA),
      y: this.hand.y + this.random.gaussian(0, JITTER_SIGMA),
      timestampMs: stepNumber * STEP_MS,
      arrivalMs: arrivalStep * STEP_MS,
      // The perception layer flags the first sample and the first after a gap as not continuous.
      continuous: !(this.firstSample || this.lostAGap),
    });
    this.firstSample = false;
    this.lostAGap = false;
  }

  /**
   * Launch after 0.5–1.5 s tied on; tug after 1–4 s asleep, or sometimes let it auto-return. A spent
   * («exhausted») yoyo is tugged after a second, as the UI invites the player to do.
   */
  private runScript(): void {
    const s = this.model.state;
    const now = this.timeMs;
    if (s.phase === 'tethered' && s.phaseMs >= this.launchAfterMs) {
      const strength = this.random.range(0.8, 3.5);
      this.hand.gesture(Math.min(strength, MAX_PIVOT_SPEED), -Math.PI / 2 + this.random.range(-0.4, 0.4), this.random.range(0.1, 0.25));
      this.model.launch(strength, now, now, this.events);
      this.plan = this.random.chance(0.3) ? 'auto-return' : 'tug';
      this.tugAfterMs = this.random.range(1000, 4000);
      this.launchAfterMs = this.random.range(500, 1500);
    } else if ((s.phase === 'sleeping' && this.plan === 'tug' && s.phaseMs >= this.tugAfterMs) || (s.phase === 'exhausted' && s.phaseMs >= EXHAUSTED_TUG_AFTER_MS)) {
      const strength = this.random.range(0.5, 2);
      this.hand.gesture(Math.min(strength, MAX_PIVOT_SPEED), Math.PI / 2 + this.random.range(-0.5, 0.5), this.random.range(0.08, 0.2));
      this.model.tug(strength, now, now, this.events);
    }
  }

  private drainEvents(): void {
    this.maxEventsPerFrame = Math.max(this.maxEventsPerFrame, this.events.length);
    for (const event of this.events) this.counts[event.kind] = (this.counts[event.kind] ?? 0) + 1;
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Y-10: cost of the physics per render frame.
// ---------------------------------------------------------------------------------------------

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

interface TimingResult {
  frames: number;
  stepsPerFrame: number;
  meanUs: number;
  meanUsWithoutTimerOverhead: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  maxUs: number;
  timerOverheadUs: number;
  framesOverBudget: number;
  budgetP95Ms: number;
  pass: boolean;
}

function measureTimerOverheadUs(): number {
  const n = 200_000;
  const start = performance.now();
  let sink = 0;
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    sink += performance.now() - a;
  }
  const elapsed = performance.now() - start;
  if (sink < 0) throw new Error('unreachable');
  return ((elapsed / n) * 1000) / 2;
}

function benchmarkFrames(): TimingResult {
  const session = new Session(2024);
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    session.prepareFrame();
    session.physicsFrame();
  }
  const samples = new Float64Array(TIMED_FRAMES);
  for (let i = 0; i < TIMED_FRAMES; i++) {
    session.prepareFrame();
    const start = performance.now();
    session.physicsFrame();
    samples[i] = (performance.now() - start) * 1000;
  }
  let sum = 0;
  let over = 0;
  for (const value of samples) {
    sum += value;
    if (value > FRAME_BUDGET_P95_MS * 1000) over++;
  }
  const sorted = Float64Array.from(samples).sort();
  const p95Us = percentile(sorted, 0.95);
  const timerOverheadUs = measureTimerOverheadUs();
  return {
    frames: TIMED_FRAMES,
    stepsPerFrame: STEPS_PER_FRAME,
    meanUs: sum / TIMED_FRAMES,
    meanUsWithoutTimerOverhead: sum / TIMED_FRAMES - timerOverheadUs,
    p50Us: percentile(sorted, 0.5),
    p95Us,
    p99Us: percentile(sorted, 0.99),
    maxUs: sorted[sorted.length - 1],
    timerOverheadUs,
    framesOverBudget: over,
    budgetP95Ms: FRAME_BUDGET_P95_MS,
    pass: p95Us <= FRAME_BUDGET_P95_MS * 1000,
  };
}

// ---------------------------------------------------------------------------------------------
// Y-09: ten minutes at 240 Hz.
// ---------------------------------------------------------------------------------------------

interface StabilityResult {
  seed: number;
  steps: number;
  simulatedSeconds: number;
  nonFiniteSteps: number;
  maxTautError: number;
  maxLengthOverMm: number;
  maxDistanceOverLength: number;
  maxSpin: number;
  minSpinWhileSpinning: number;
  maxSpeed: number;
  maxTension: number;
  maxPivotSpeed: number;
  /** Largest pivot displacement in one 16.7 ms frame, absolute. */
  maxPivotStepCm: number;
  /** Largest pivot displacement in one 16.7 ms frame beyond its target's own displacement: the Y-06 teleport. */
  maxTeleportCm: number;
  maxEventsPerFrame: number;
  cycles: Record<string, number>;
  stepsPerPhase: Partial<Record<YoyoPhase, number>>;
  aboveThePivotStepsByPhase: Partial<Record<YoyoPhase, number>>;
  pass: boolean;
  failures: string[];
}

function runStability(seed: number): StabilityResult {
  const session = new Session(seed);
  const config = session.config;
  const spinBound = Math.max(config.yoyo.launchSpinMax * 2, config.yoyo.maxAscent / config.yoyo.axleRadius);
  const r: StabilityResult = {
    seed, steps: 0, simulatedSeconds: 0, nonFiniteSteps: 0, maxTautError: 0, maxLengthOverMm: -Infinity, maxDistanceOverLength: -Infinity,
    maxSpin: 0, minSpinWhileSpinning: Infinity, maxSpeed: 0, maxTension: 0, maxPivotSpeed: 0, maxPivotStepCm: 0, maxTeleportCm: 0, maxEventsPerFrame: 0,
    cycles: {}, stepsPerPhase: {}, aboveThePivotStepsByPhase: {}, pass: true, failures: [],
  };
  const recentPivotX: number[] = [];
  const recentPivotY: number[] = [];
  const recentTargetX: number[] = [];
  const recentTargetY: number[] = [];
  const observe = (current: Session) => {
    const s = current.model.state;
    const pin: PinState = current.pin.state;
    r.steps++;
    r.stepsPerPhase[s.phase] = (r.stepsPerPhase[s.phase] ?? 0) + 1;
    const values = [s.x, s.y, s.vx, s.vy, s.length, s.spin, s.spinAngle, s.tension, pin.x, pin.y, pin.vx, pin.vy];
    if (!values.every(Number.isFinite)) r.nonFiniteSteps++;
    const distance = Math.hypot(s.x - pin.x, s.y - pin.y);
    r.maxDistanceOverLength = Math.max(r.maxDistanceOverLength, distance - s.length);
    if (!s.slack && s.length > 0.01 && s.phase !== 'tethered' && s.phase !== 'caught') {
      r.maxTautError = Math.max(r.maxTautError, Math.abs(distance - s.length) / s.length);
    }
    r.maxLengthOverMm = Math.max(r.maxLengthOverMm, (s.length - config.yoyo.maxLength) * 1000);
    r.maxSpin = Math.max(r.maxSpin, s.spin);
    if (s.phase === 'rolling' || s.phase === 'sleeping' || s.phase === 'returning') r.minSpinWhileSpinning = Math.min(r.minSpinWhileSpinning, s.spin);
    r.maxSpeed = Math.max(r.maxSpeed, Math.hypot(s.vx, s.vy));
    r.maxTension = Math.max(r.maxTension, s.tension);
    r.maxPivotSpeed = Math.max(r.maxPivotSpeed, Math.hypot(pin.vx, pin.vy));
    const target = current.target;
    recentPivotX.push(pin.x);
    recentPivotY.push(pin.y);
    recentTargetX.push(target.x);
    recentTargetY.push(target.y);
    if (recentPivotX.length > 4) {
      // Displacement over 4 steps (16.7 ms, one 60 Hz frame), absolute and beyond the target's own.
      const moved = Math.hypot(pin.x - recentPivotX[0], pin.y - recentPivotY[0]);
      const targetMoved = Math.hypot(target.x - recentTargetX[0], target.y - recentTargetY[0]);
      r.maxPivotStepCm = Math.max(r.maxPivotStepCm, moved * 100);
      r.maxTeleportCm = Math.max(r.maxTeleportCm, (moved - targetMoved) * 100);
      recentPivotX.shift();
      recentPivotY.shift();
      recentTargetX.shift();
      recentTargetY.shift();
    }
    if (s.y > pin.y + 1e-9) r.aboveThePivotStepsByPhase[s.phase] = (r.aboveThePivotStepsByPhase[s.phase] ?? 0) + 1;
  };
  while (r.steps < STABILITY_STEPS) {
    session.prepareFrame();
    session.physicsFrame(observe);
  }
  r.simulatedSeconds = r.steps / 240;
  r.cycles = { ...session.counts };
  r.maxEventsPerFrame = session.maxEventsPerFrame;
  const check = (ok: boolean, message: string) => {
    if (!ok) r.failures.push(message);
  };
  check(r.nonFiniteSteps === 0, `${r.nonFiniteSteps} steps with non-finite values`);
  check(r.maxTautError < MAX_TAUT_ERROR, `taut string error ${(r.maxTautError * 100).toFixed(3)} % ≥ 2 %`);
  check(r.maxLengthOverMm <= MAX_LENGTH_OVER_M * 1000, `L exceeded maxLength by ${r.maxLengthOverMm.toFixed(3)} mm`);
  check(r.maxDistanceOverLength <= 1e-6, `|X − P| exceeded L by ${r.maxDistanceOverLength}`);
  check(r.maxSpin <= spinBound, `spin ${r.maxSpin.toFixed(1)} above the bound ${spinBound}`);
  check(r.maxEventsPerFrame <= MAX_EVENTS_PER_FRAME, `${r.maxEventsPerFrame} events in one frame (limit ${MAX_EVENTS_PER_FRAME})`);
  check(r.maxTeleportCm <= TELEPORT_LIMIT_CM, `pivot moved ${r.maxTeleportCm.toFixed(2)} cm in 16.7 ms beyond its target's own displacement (Y-06 limit ${TELEPORT_LIMIT_CM})`);
  check((r.cycles.launch ?? 0) >= 20 && (r.cycles.catch ?? 0) >= 10, `too few cycles to mean anything: ${JSON.stringify(r.cycles)}`);
  r.pass = r.failures.length === 0;
  return r;
}

// ---------------------------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------------------------

const fmt = (value: number, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : String(value));

function main(): void {
  const environment = {
    runtime: 'node',
    node: process.version,
    platform: `${platform()}/${arch()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    note: 'Node on this machine, not the browser. Synthetic input. Physics only: no rendering, tracking or main-thread contention.',
  };
  console.log(`Yoyó physics benchmark: ${environment.node} on ${environment.platform}, ${environment.cpu}`);
  console.log(environment.note);

  console.log(`\nY-10: physics per render frame (${STEPS_PER_FRAME} model steps + ${STEPS_PER_FRAME} pin steps + sample pushes), ${TIMED_FRAMES} frames after ${WARMUP_FRAMES} warm-up`);
  const timing = benchmarkFrames();
  console.log(`  mean ${fmt(timing.meanUs)} µs (${fmt(timing.meanUsWithoutTimerOverhead)} without timer overhead)   p50 ${fmt(timing.p50Us)}   p95 ${fmt(timing.p95Us)}   p99 ${fmt(timing.p99Us)}   max ${fmt(timing.maxUs, 1)}`);
  console.log(`  per-frame timer overhead ≈ ${fmt(timing.timerOverheadUs, 3)} µs (included above); frames over ${FRAME_BUDGET_P95_MS} ms: ${timing.framesOverBudget}`);
  console.log(`  budget: p95 ≤ ${FRAME_BUDGET_P95_MS} ms (${FRAME_BUDGET_P95_MS * 1000} µs) → ${timing.pass ? 'PASS' : 'FAIL'}  (${fmt((timing.p95Us / (FRAME_BUDGET_P95_MS * 1000)) * 100, 3)} % of budget at p95)`);

  console.log(`\nY-09: ${STABILITY_STEPS} steps (10 min) at 240 Hz, hand → tracking noise/dropouts → stabilizer → model; seeds ${STABILITY_SEEDS.join(', ')}`);
  const stability = STABILITY_SEEDS.map((seed) => runStability(seed));
  for (const r of stability) {
    console.log(`  seed ${r.seed}: ${r.pass ? 'PASS' : 'FAIL'}  steps ${r.steps} (${fmt(r.simulatedSeconds, 0)} s)  NaN steps ${r.nonFiniteSteps}`);
    console.log(`    max |dist−L|/L while taut ${r.maxTautError.toExponential(2)} (limit ${MAX_TAUT_ERROR})   max L−maxLength ${fmt(r.maxLengthOverMm, 4)} mm (limit ${MAX_LENGTH_OVER_M * 1000})   max dist−L ${r.maxDistanceOverLength.toExponential(2)} m`);
    console.log(`    spin ${fmt(r.minSpinWhileSpinning, 1)}…${fmt(r.maxSpin, 1)} rad/s   max speed ${fmt(r.maxSpeed)} m/s   max tension ${fmt(r.maxTension)} N   pivot ≤ ${fmt(r.maxPivotSpeed)} m/s, ≤ ${fmt(r.maxPivotStepCm)} cm per 16.7 ms (${fmt(r.maxTeleportCm)} cm beyond its target's own, Y-06 limit ${TELEPORT_LIMIT_CM})`);
    console.log(`    cycles ${JSON.stringify(r.cycles)}   max events in a frame ${r.maxEventsPerFrame}`);
    console.log(`    steps with the yoyo above the pivot, by phase: ${JSON.stringify(r.aboveThePivotStepsByPhase)}`);
    for (const failure of r.failures) console.log(`    FAILURE: ${failure}`);
  }

  const pass = timing.pass && stability.every((r) => r.pass);
  const outputPath = fileURLToPath(new URL('../artifacts/qa/yoyo/benchmark.json', import.meta.url));
  mkdirSync(dirname(outputPath), { recursive: true });
  const document = {
    kind: 'yoyo-physics-benchmark',
    evidence: 'synthetic, Node, physics only',
    generatedAt: new Date().toISOString(),
    environment,
    y10: timing,
    y09: stability,
    criteria: [
      { id: 'Y-10', text: `physics ≤ ${FRAME_BUDGET_P95_MS} ms p95 per frame (Node, this machine)`, pass: timing.pass },
      { id: 'Y-09', text: '10 min at 240 Hz: no NaN, taut-string error < 2 %, L ≤ maxLength + 1 mm, bounded spin, bounded events per frame, pivot teleport ≤ 5 cm per frame beyond its target', pass: stability.every((r) => r.pass) },
    ],
    pass,
  };
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`\nWrote ${outputPath}`);
  console.log(pass ? 'ALL CRITERIA PASS (synthetic, Node)' : 'CRITERIA FAILED');
  process.exitCode = pass ? 0 : 1;
}

main();
