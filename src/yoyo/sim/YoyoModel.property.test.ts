import { describe, expect, it } from 'vitest';
import { createConfig, type YoyoConfig } from '../config';
import type { PinState, YoyoEvent, YoyoPhase } from '../contracts';
import { Random } from '../replay/random';
import { YoyoModel } from './YoyoModel';

/**
 * Property tests: thousands of seeded random episodes, SYNTHETIC input only (a scripted pivot, no
 * tracking, no camera). Every step of every episode is checked against the model invariants.
 * Set YOYO_REPORT=1 to print the aggregate statistics.
 *
 * Two kinds of hand:
 * - realistic: gentle sway (pivot ≤ 1 m/s, ≤ 8 m/s²), holds, and the strokes of real play: a launch
 *   stroke at 1.5–3 m/s before every throw, a tug flick at 0.8–1.6 m/s before every tug;
 * - chaos: random strokes up to 2.5 m/s and 25 m/s² unrelated to the throws, to try to break the model.
 */

const STEP_S = 1 / 240;
const REALISTIC_EPISODES = 1500;
const CHAOS_EPISODES = 1000;
const CHAOS_MAX_SPEED = 2.5;
const CHAOS_MAX_ACCELERATION = 25;
const REALISTIC_NOISE_MAX_SPEED = 1;
const REALISTIC_NOISE_MAX_ACCELERATION = 8;
/** Steps in one 60 Hz render frame, the span the runtime scenarios compare snapshots over (Y-05 «no jumps»). */
const FRAME_STEPS = 4;
const GRAVITY = 9.81;
/** Fastest a yoyo moves in these episodes, m/s: sets how much of its speed one step of air drag takes. */
const FRAME_TOP_SPEED = 5;
/** Slack allowed on |X − P| ≤ L: only floating point rounding. */
const STRING_TOLERANCE = 1e-6;
const MAX_VIOLATIONS_KEPT = 12;
/**
 * A yoyo on the end of a sleeping string that keeps moving outward relative to the pivot, by more
 * than the centripetal velocity one step of rotation leaves behind plus this margin (m/s), for this
 * many steps in a row is not being held by its string.
 */
const PINNED_STEPS_LIMIT = 3;
const PINNED_MARGIN = 0.1;
const HOME: readonly [number, number] = [0, 0.85];

const report = (label: string, value: number | string) => {
  if (process.env.YOYO_REPORT === '1') console.info(`[property] ${label}: ${typeof value === 'number' ? value.toPrecision(5) : value}`);
};

interface Stroke {
  elapsed: number;
  duration: number;
  /** Min-jerk stroke length, m. */
  distance: number;
  dx: number;
  dy: number;
}

/** A hand the episode can drive: it owns the pivot and moves it one step at a time. */
interface Hand {
  readonly pin: PinState;
  /** A directed stroke: peak speed in m/s, angle in radians (0 = right, −π/2 = down), duration in s. */
  gesture(peakSpeed: number, angle: number, duration: number): void;
  /** Advances the pivot one step; `t` is the simulation time in seconds. */
  step(t: number): void;
  /** The hand is gone: the stabilizer would have frozen the pivot, so it stands still, and the stroke it was making is gone with it. */
  freeze(): void;
}

/** Min-jerk strokes (throws, flicks) playing on top of whatever else the hand does. */
class Strokes {
  private readonly active: Stroke[] = [];

  add(peakSpeed: number, angle: number, duration: number): void {
    // A min-jerk stroke of length D over T peaks at 1.875·D/T.
    this.active.push({ elapsed: 0, duration, distance: (peakSpeed * duration) / 1.875, dx: Math.cos(angle), dy: Math.sin(angle) });
  }

  /** The hand is gone: whatever stroke it was making goes with it, and does not resume when it is back. */
  clear(): void {
    this.active.length = 0;
  }

  /** Summed stroke velocity for this step, written into `out`. */
  velocity(out: { vx: number; vy: number }): void {
    out.vx = 0;
    out.vy = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const stroke = this.active[i];
      stroke.elapsed += STEP_S;
      const u = stroke.elapsed / stroke.duration;
      if (u >= 1) {
        this.active.splice(i, 1);
        continue;
      }
      const speed = (stroke.distance / stroke.duration) * (30 * u * u - 60 * u ** 3 + 30 * u ** 4);
      out.vx += speed * stroke.dx;
      out.vy += speed * stroke.dy;
    }
  }
}

const clampVector = (vx: number, vy: number, limit: number): [number, number] => {
  const size = Math.hypot(vx, vy);
  return size > limit ? [(vx * limit) / size, (vy * limit) / size] : [vx, vy];
};

/**
 * Chaos: an Ornstein–Uhlenbeck drift on velocity (sway) pulled back to the home position, plus random
 * strokes in any direction. Velocity and acceleration are clamped to 2.5 m/s and 25 m/s², and the pivot
 * is advanced with the same semi-implicit step it reports its velocity from.
 */
class ChaosHand implements Hand {
  readonly pin: PinState = { x: HOME[0], y: HOME[1], vx: 0, vy: 0 };
  private readonly strokes = new Strokes();
  private readonly scratch = { vx: 0, vy: 0 };
  private driftVx = 0;
  private driftVy = 0;

  constructor(private readonly random: Random, private readonly swayStd: number, private readonly strokeRate: number) {}

  gesture(peakSpeed: number, angle: number, duration: number): void {
    this.strokes.add(peakSpeed, angle, duration);
  }

  step(): void {
    const { random, pin } = this;
    const tau = 0.4;
    const pull = 20;
    const noise = this.swayStd * Math.sqrt(2 / tau) * Math.sqrt(STEP_S);
    this.driftVx += (-this.driftVx / tau - pull * (pin.x - HOME[0])) * STEP_S + noise * random.gaussian();
    this.driftVy += (-this.driftVy / tau - pull * (pin.y - HOME[1])) * STEP_S + noise * random.gaussian();
    if (random.chance(this.strokeRate * STEP_S)) {
      const duration = random.range(0.12, 0.35);
      const reachable = Math.min(1.875 * 1.33, 1.875 * 4.33 * duration);
      this.strokes.add(Math.min(reachable, CHAOS_MAX_SPEED) * random.range(0.3, 1), random.range(0, 2 * Math.PI), duration);
    }
    this.strokes.velocity(this.scratch);
    const [targetVx, targetVy] = clampVector(this.driftVx + this.scratch.vx, this.driftVy + this.scratch.vy, CHAOS_MAX_SPEED);
    let ax = (targetVx - pin.vx) / STEP_S;
    let ay = (targetVy - pin.vy) / STEP_S;
    [ax, ay] = clampVector(ax, ay, CHAOS_MAX_ACCELERATION);
    pin.vx += ax * STEP_S;
    pin.vy += ay * STEP_S;
    pin.x += pin.vx * STEP_S;
    pin.y += pin.vy * STEP_S;
  }

  freeze(): void {
    this.strokes.clear();
    this.pin.vx = 0;
    this.pin.vy = 0;
  }
}

/**
 * Realistic: smooth sway whose speed stays ≤ 1 m/s and acceleration ≤ 8 m/s² (an Ornstein–Uhlenbeck
 * velocity pulled toward the home position), holds where the hand stays put for 0.5–3 s, and the
 * strokes of play on top, which are not limited: a throw is a 1.5–3 m/s stroke in a few tenths of a second.
 */
class RealisticHand implements Hand {
  readonly pin: PinState = { x: HOME[0], y: HOME[1], vx: 0, vy: 0 };
  private readonly strokes = new Strokes();
  private readonly scratch = { vx: 0, vy: 0 };
  private noiseVx = 0;
  private noiseVy = 0;
  private holdUntil = -1;

  /** @param holdRate holds started per second of free hand */
  constructor(private readonly random: Random, private readonly swayStd: number, private readonly holdRate: number) {}

  gesture(peakSpeed: number, angle: number, duration: number): void {
    this.strokes.add(peakSpeed, angle, duration);
  }

  step(t: number): void {
    const { random, pin } = this;
    if (t >= this.holdUntil && random.chance(this.holdRate * STEP_S)) this.holdUntil = t + random.range(0.5, 3);
    const holding = t < this.holdUntil;
    const tau = 0.4;
    const pull = 20;
    const kickScale = holding ? 0 : (this.swayStd * Math.sqrt(2 / tau)) / Math.sqrt(STEP_S);
    // A hold also brakes the sway quickly: the hand is put down.
    const brake = holding ? 8 : 0;
    let ax = -this.noiseVx / tau - brake * this.noiseVx - pull * (pin.x - HOME[0]) + kickScale * random.gaussian();
    let ay = -this.noiseVy / tau - brake * this.noiseVy - pull * (pin.y - HOME[1]) + kickScale * random.gaussian();
    [ax, ay] = clampVector(ax, ay, REALISTIC_NOISE_MAX_ACCELERATION);
    this.noiseVx += ax * STEP_S;
    this.noiseVy += ay * STEP_S;
    [this.noiseVx, this.noiseVy] = clampVector(this.noiseVx, this.noiseVy, REALISTIC_NOISE_MAX_SPEED);
    this.strokes.velocity(this.scratch);
    pin.vx = this.noiseVx + this.scratch.vx;
    pin.vy = this.noiseVy + this.scratch.vy;
    pin.x += pin.vx * STEP_S;
    pin.y += pin.vy * STEP_S;
  }

  freeze(): void {
    this.strokes.clear();
    this.pin.vx = 0;
    this.pin.vy = 0;
  }
}

type Mode = 'realistic' | 'chaos';

/**
 * Realistic episodes vary only what a player or the panel could vary without making a return
 * impossible: responsiveness, auto-return, how long the spin lasts and when a sleeper counts as spent.
 * Chaos episodes also vary the launch band and the return spin and ascent cap over the panel's ranges
 * (some of which cannot climb the string at all).
 */
function randomConfig(random: Random, mode: Mode): YoyoConfig {
  const config = createConfig();
  config.yoyo.autoReturn = random.chance(0.6);
  if (mode === 'realistic') {
    config.responsiveness = random.chance(0.85) ? 'responsive' : 'unresponsive';
    config.yoyo.sleepTau = random.range(1, 12);
    config.yoyo.exhaustedSpin = random.range(5, 200);
    return config;
  }
  if (random.chance(0.5)) {
    config.yoyo.launchSpinMin = random.range(300, 450);
    config.yoyo.launchSpinMax = config.yoyo.launchSpinMin + random.range(100, 400);
    config.yoyo.sleepTau = random.range(1, 12);
    config.yoyo.exhaustedSpin = random.range(5, 200);
    config.yoyo.returnSpinMin = random.range(180, 900);
    config.yoyo.maxAscent = random.range(0.5, 4);
  }
  config.responsiveness = random.chance(0.7) ? 'responsive' : 'unresponsive';
  return config;
}

interface AboveStats {
  steps: number;
  /** Separate passes above the pivot (runs of consecutive steps). */
  passes: number;
  max: number;
  episodes: Set<number>;
}

interface Aggregate {
  episodes: number;
  steps: number;
  violations: string[];
  events: Record<string, number>;
  phaseSteps: Partial<Record<YoyoPhase, number>>;
  above: Partial<Record<YoyoPhase, AboveStats>>;
  maxLengthOver: number;
  maxSpin: number;
  maxDistanceOverLength: number;
  maxTautError: number;
  tugsRefused: number;
  launchesRefused: number;
  /**
   * Displacement of a step beyond what its own velocity explains, max(|V before|, |V after|)·dt, in m.
   * Kept for the steps where the phase changed (a throw, a tug, a snap, a catch... took effect), for
   * the catches among them, and for the steps spent in `caught` after the catch.
   */
  transitionSteps: number;
  transitionExcess: number[];
  catchExcess: number[];
  caughtExcess: number[];
  /**
   * Winding steps (`returning` before and after) and the largest displacement among them beyond what their
   * velocity explains, in m: the pull of the string must be folded into the velocity, so this stays 0.
   */
  windingSteps: number;
  windingExcessMax: number;
  /**
   * Frame measure, as the runtime scenarios take it between snapshots: over every window of four steps that
   * starts and ends in the same phase, the displacement beyond max(|V| at the two ends)·Δt. Windows seen and the
   * worst excess, per phase, in m.
   */
  frameWindows: Partial<Record<YoyoPhase, number>>;
  frameExcessMax: Partial<Record<YoyoPhase, number>>;
}

const newAggregate = (): Aggregate => ({
  episodes: 0, steps: 0, violations: [], events: {}, phaseSteps: {}, above: {},
  maxLengthOver: -Infinity, maxSpin: 0, maxDistanceOverLength: -Infinity, maxTautError: 0, tugsRefused: 0, launchesRefused: 0,
  transitionSteps: 0, transitionExcess: [], catchExcess: [], caughtExcess: [],
  windingSteps: 0, windingExcessMax: 0, frameWindows: {}, frameExcessMax: {},
});

interface PendingRequest {
  /** Simulation time at which the request is made, s. */
  at: number;
  strength: number;
}

/**
 * One episode: a random config, a random hand and a script of throws and tugs, with every step
 * checked against the invariants. Results are appended to `into`; every step's state goes to
 * `trace` if one is given.
 */
class Episode {
  private readonly random: Random;
  private readonly config: YoyoConfig;
  private readonly hand: Hand;
  private readonly model: YoyoModel;
  private readonly events: YoyoEvent[] = [];
  private readonly steps: number;
  private readonly spinBound: number;
  private launchAt: number;
  private lostUntil = -1;
  private pendingLaunch: PendingRequest | null = null;
  private pendingTug: PendingRequest | null = null;
  private previousPhase: YoyoPhase;
  private previousSleepSpin = Number.NaN;
  private pinnedRun = 0;
  private abovePhase: YoyoPhase | null = null;
  private returningLength: number | null = null;
  /** The state at the end of the previous step: where this step's displacement is measured from. */
  private readonly before = { x: 0, y: 0, vx: 0, vy: 0, phase: 'untethered' as YoyoPhase };
  /** The last FRAME_STEPS + 1 states (ring buffer, reused: no allocation per step) for the frame measure. */
  private readonly recent = Array.from({ length: FRAME_STEPS + 1 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, phase: 'untethered' as YoyoPhase }));
  private recorded = 0;

  constructor(private readonly seed: number, private readonly mode: Mode, private readonly into: Aggregate, private readonly trace?: number[]) {
    this.random = new Random(seed);
    this.config = randomConfig(this.random, mode);
    this.hand = this.makeHand();
    this.model = new YoyoModel(this.config);
    this.steps = Math.floor(this.random.range(mode === 'realistic' ? 20 : 14, mode === 'realistic' ? 40 : 28) / STEP_S);
    this.spinBound = Math.max(this.config.yoyo.launchSpinMax * 2, this.config.yoyo.maxAscent / this.config.yoyo.axleRadius);
    this.model.tether(this.hand.pin, 0, this.events);
    this.launchAt = this.random.range(0.4, 1.5);
    this.previousPhase = this.model.state.phase;
    this.rememberState();
  }

  private makeHand(): Hand {
    const random = this.random;
    if (this.mode === 'realistic') return new RealisticHand(random, Math.exp(random.range(Math.log(0.02), Math.log(0.35))), random.range(0.05, 0.5));
    return new ChaosHand(random, Math.exp(random.range(Math.log(0.05), Math.log(0.6))), random.range(0.3, 1.5));
  }

  run(): void {
    for (let i = 1; i <= this.steps; i++) {
      const t = i * STEP_S;
      const timeMs = t * 1000;
      const lost = this.moveHand(t);
      this.makeRequests(t, timeMs);
      this.model.step(STEP_S, { pin: this.hand.pin, handPresent: !lost }, timeMs, this.events);
      this.observe(i);
    }
    for (const event of this.events) this.into.events[event.kind] = (this.into.events[event.kind] ?? 0) + 1;
    this.into.episodes++;
  }

  /** Occasionally the hand leaves for 1–3 s (the stabilizer freezes the pivot); otherwise it moves. Returns whether it is gone. */
  private moveHand(t: number): boolean {
    const random = this.random;
    if (this.lostUntil < 0 && random.chance(0.00005)) this.lostUntil = t + random.range(1, 3);
    const lost = this.lostUntil > t;
    if (this.lostUntil > 0 && t >= this.lostUntil) this.lostUntil = -1;
    if (lost) {
      this.hand.freeze();
      // Nobody calls a throw or a tug for a hand that is not there, and the stroke that announced it is gone.
      this.pendingLaunch = null;
      this.pendingTug = null;
      return true;
    }
    this.scheduleThrowOrTug(t);
    this.hand.step(t);
    return false;
  }

  /**
   * In realistic play a throw or tug is announced by a stroke that starts a little before the call,
   * as a real one does: a launch stroke of 1.5–3 m/s down, a flick of 0.8–1.6 m/s up. In chaos the
   * calls come with no matching stroke at all.
   */
  private scheduleThrowOrTug(t: number): void {
    const random = this.random;
    const phase = this.model.state.phase;
    const realistic = this.mode === 'realistic';
    if (phase === 'tethered' && !this.pendingLaunch && t >= this.launchAt) {
      const strength = realistic ? random.range(1.5, 3) : random.range(0.8, 3.5);
      if (realistic) this.hand.gesture(strength, -Math.PI / 2 + random.range(-0.4, 0.4), random.range(0.12, 0.3));
      this.pendingLaunch = { at: realistic ? t + 0.03 : t, strength };
      this.launchAt = t + random.range(0.4, 1.5);
    }
    const tugCandidate = phase === 'sleeping' || phase === 'exhausted';
    if (tugCandidate && !this.pendingTug && random.chance(0.004)) {
      const strength = realistic ? random.range(0.8, 1.6) : random.range(0.5, 2);
      if (realistic) this.hand.gesture(strength, Math.PI / 2 + random.range(-0.5, 0.5), random.range(0.1, 0.2));
      this.pendingTug = { at: realistic ? t + 0.02 : t, strength };
    }
  }

  /**
   * Scheduled requests plus a trickle at random moments, which checks that the state machine refuses
   * what it must and is not corrupted by what it accepts. In realistic play every call the model
   * accepts comes with its stroke, as the intent classifier needs one to call it. A call with no
   * stroke behind it would be a false positive, and a hand that then really throws dives past the
   * weakly launched yoyo (4 of the 5 episodes in 6000 where it got up to 1.3 cm above the pivot for
   * 46 ms were that; the fifth was a stroke that survived a lost hand), so the realistic trickle makes
   * only calls the model refuses. Chaos makes them all.
   */
  private makeRequests(t: number, timeMs: number): void {
    const { model, events, random, into } = this;
    if (this.pendingLaunch && t >= this.pendingLaunch.at) {
      if (!model.launch(this.pendingLaunch.strength, timeMs, timeMs, events)) into.launchesRefused++;
      this.pendingLaunch = null;
    }
    if (this.pendingTug && t >= this.pendingTug.at) {
      if (!model.tug(this.pendingTug.strength, timeMs, timeMs, events)) into.tugsRefused++;
      this.pendingTug = null;
    }
    const stray = this.mode === 'chaos';
    if (random.chance(0.001) && (stray || !this.wouldAcceptLaunch()) && !model.launch(random.range(0.8, 3.5), timeMs, timeMs, events)) into.launchesRefused++;
    if (random.chance(0.002) && (stray || !this.wouldAcceptTug()) && !model.tug(random.range(0.5, 2), timeMs, timeMs, events)) into.tugsRefused++;
  }

  /** The rule the model applies to a launch call: only a tethered yoyo can be thrown. */
  private wouldAcceptLaunch(): boolean {
    return this.model.state.phase === 'tethered';
  }

  /** The rule the model applies to a tug call: a responsive yoyo that is sleeping or spent. */
  private wouldAcceptTug(): boolean {
    const phase = this.model.state.phase;
    return this.config.responsiveness === 'responsive' && (phase === 'sleeping' || phase === 'exhausted');
  }

  private fail(message: string): void {
    const { violations } = this.into;
    if (violations.length < MAX_VIOLATIONS_KEPT) violations.push(`seed ${this.seed} (${this.mode}): ${message}`);
  }

  /** Statistics and invariants after step `i`. */
  private observe(i: number): void {
    const s = this.model.state;
    const pin = this.hand.pin;
    const into = this.into;
    into.steps++;
    into.phaseSteps[s.phase] = (into.phaseSteps[s.phase] ?? 0) + 1;
    this.trace?.push(s.x, s.y, s.vx, s.vy, s.length, s.spin, s.tension);
    const distance = Math.hypot(s.x - pin.x, s.y - pin.y);
    this.checkNumbers(i);
    this.checkString(i, distance);
    this.checkSleepingYoyoIsHeld(i, distance);
    this.countAboveThePivot();
    this.measureDisplacement();
    this.measureFrame();
    this.rememberState();
  }

  private rememberState(): void {
    const s = this.model.state;
    const b = this.before;
    b.x = s.x;
    b.y = s.y;
    b.vx = s.vx;
    b.vy = s.vy;
    b.phase = s.phase;
  }

  /**
   * 10. No teleport: at a phase change, while a caught yoyo settles and while it winds in, a step moves the
   * yoyo no more than its velocity before or after the step explains. (Where the projection only drags a taut
   * string along with a moving pivot, outside winding, it is not counted: only the steps where something
   * changes state.)
   */
  private measureDisplacement(): void {
    const s = this.model.state;
    const b = this.before;
    const changed = s.phase !== b.phase;
    const settling = s.phase === 'caught' && !changed;
    const winding = s.phase === 'returning' && !changed;
    if (!changed && !settling && !winding) return;
    const moved = Math.hypot(s.x - b.x, s.y - b.y);
    const allowed = Math.max(Math.hypot(b.vx, b.vy), Math.hypot(s.vx, s.vy)) * STEP_S;
    const excess = Math.max(0, moved - allowed);
    if (winding) {
      this.into.windingSteps++;
      this.into.windingExcessMax = Math.max(this.into.windingExcessMax, excess);
      return;
    }
    if (settling) {
      this.into.caughtExcess.push(excess);
      return;
    }
    this.into.transitionSteps++;
    this.into.transitionExcess.push(excess);
    if (s.phase === 'caught' && b.phase === 'returning') this.into.catchExcess.push(excess);
  }

  /**
   * 11. The frame measure of the runtime scenarios: how far the yoyo moved over four steps beyond what the
   * faster of its two end velocities explains. It is not an invariant of the motion: a string that snaps taut
   * at the start of the frame and a yoyo that then flies free for three steps (a hand that stops, a pivot
   * falling away as fast as gravity) leaves the end velocity lower than the average one by up to 1.5 steps
   * of gravity, which is a displacement, not a jump. It is recorded per phase, reported, and bounded.
   */
  private measureFrame(): void {
    const s = this.model.state;
    const ring = this.recent;
    const slot = ring[this.recorded % ring.length];
    slot.x = s.x;
    slot.y = s.y;
    slot.vx = s.vx;
    slot.vy = s.vy;
    slot.phase = s.phase;
    this.recorded++;
    if (this.recorded <= FRAME_STEPS) return;
    const start = ring[(this.recorded - 1 - FRAME_STEPS) % ring.length];
    if (start.phase !== s.phase) return;
    const moved = Math.hypot(s.x - start.x, s.y - start.y);
    const explained = Math.max(Math.hypot(start.vx, start.vy), Math.hypot(s.vx, s.vy)) * FRAME_STEPS * STEP_S;
    const { frameWindows, frameExcessMax } = this.into;
    frameWindows[s.phase] = (frameWindows[s.phase] ?? 0) + 1;
    frameExcessMax[s.phase] = Math.max(frameExcessMax[s.phase] ?? -Infinity, moved - explained);
  }

  private checkNumbers(i: number): void {
    const s = this.model.state;
    const { maxLength } = this.config.yoyo;
    // 1. finite
    if (![s.x, s.y, s.vx, s.vy, s.length, s.spin, s.spinAngle, s.tension, s.phaseMs].every(Number.isFinite)) this.fail(`non-finite state at step ${i}`);
    // 2. 0 ≤ L ≤ maxLength + 1 mm
    this.into.maxLengthOver = Math.max(this.into.maxLengthOver, s.length - maxLength);
    if (s.length < 0 || s.length > maxLength + 0.001) this.fail(`length ${s.length} at step ${i}`);
    // 3. spin ≥ 0 and ≤ spinBound. A throw can start no faster than launchSpinMax; gravity feeds the descent
    //    only ~70 rad/s per second of string, and a hand pumping the string adds a few rad/s per jerk, so 2× the
    //    band's top is ample headroom. A return is capped at maxAscent/r by construction, hence the max of the two.
    this.into.maxSpin = Math.max(this.into.maxSpin, s.spin);
    if (s.spin < 0 || s.spin > this.spinBound) this.fail(`spin ${s.spin} (${s.phase}) at step ${i}`);
    // 4. spin never rises while sleeping
    if (s.phase === 'sleeping' && this.previousPhase === 'sleeping' && s.spin > this.previousSleepSpin) this.fail(`sleeping spin rose at step ${i}`);
    this.previousPhase = s.phase;
    this.previousSleepSpin = s.spin;
    // 5. a returning yoyo only ever winds string in, taut or slack
    if (s.phase === 'returning' && this.returningLength !== null && s.length > this.returningLength + 1e-12) this.fail(`returning string grew from ${this.returningLength} to ${s.length} at step ${i}`);
    this.returningLength = s.phase === 'returning' ? s.length : null;
  }

  private checkString(i: number, distance: number): void {
    const s = this.model.state;
    // 6. the string is never over-stretched
    this.into.maxDistanceOverLength = Math.max(this.into.maxDistanceOverLength, distance - s.length);
    if (distance > s.length + STRING_TOLERANCE) this.fail(`string over-stretched by ${distance - s.length} (${s.phase}) at step ${i}`);
    // 7. while the string carries tension the yoyo is on its circle
    if (!s.slack && s.length > 0.01) {
      const error = Math.abs(distance - s.length) / s.length;
      this.into.maxTautError = Math.max(this.into.maxTautError, error);
      if (error >= 0.02) this.fail(`taut string off by ${(error * 100).toFixed(2)} % (${s.phase}) at step ${i}`);
    }
  }

  /**
   * 8. A sleeping string holds the yoyo: on the end of the string it must not keep moving outward
   * relative to the pivot. (A yoyo pinned there by the position projection alone would pile up
   * gravity's velocity, then jerk the string: the bug this guards against.)
   */
  private checkSleepingYoyoIsHeld(i: number, distance: number): void {
    const s = this.model.state;
    const pin = this.hand.pin;
    if ((s.phase !== 'sleeping' && s.phase !== 'exhausted') || distance < s.length - 1e-6 || distance <= 1e-9) {
      this.pinnedRun = 0;
      return;
    }
    const wx = s.vx - pin.vx;
    const wy = s.vy - pin.vy;
    const outward = (wx * (s.x - pin.x) + wy * (s.y - pin.y)) / distance;
    const tangentialSquared = wx * wx + wy * wy - outward * outward;
    const allowance = (2 * tangentialSquared * STEP_S) / s.length + PINNED_MARGIN;
    this.pinnedRun = outward > allowance ? this.pinnedRun + 1 : 0;
    if (this.pinnedRun === PINNED_STEPS_LIMIT) this.fail(`yoyo pinned on the string end moving outward at ${outward.toFixed(2)} m/s (${s.phase}) at step ${i}`);
  }

  /** 9. The yoyo above the pivot is counted per phase and per pass; whether it is an error depends on the mode and the phase. */
  private countAboveThePivot(): void {
    const s = this.model.state;
    const above = s.y - this.hand.pin.y;
    if (above <= 1e-9) {
      this.abovePhase = null;
      return;
    }
    const entry = (this.into.above[s.phase] ??= { steps: 0, passes: 0, max: 0, episodes: new Set<number>() });
    entry.steps++;
    if (this.abovePhase !== s.phase) entry.passes++;
    this.abovePhase = s.phase;
    entry.max = Math.max(entry.max, above);
    entry.episodes.add(this.seed);
  }
}

/** One episode, appended to `into`. If `trace` is given every step's state is recorded in it. */
function runEpisode(seed: number, mode: Mode, into: Aggregate, trace?: number[]): void {
  new Episode(seed, mode, into, trace).run();
}

function runMode(mode: Mode, episodes: number): Aggregate {
  const aggregate = newAggregate();
  for (let seed = 1; seed <= episodes; seed++) runEpisode(seed, mode, aggregate);
  return aggregate;
}

function printAggregate(label: string, a: Aggregate): void {
  report(`${label}: episodes / steps`, `${a.episodes} / ${a.steps}`);
  report(`${label}: events`, JSON.stringify(a.events));
  report(`${label}: steps per phase`, JSON.stringify(a.phaseSteps));
  report(`${label}: max L − maxLength (mm)`, a.maxLengthOver * 1000);
  report(`${label}: max spin (rad/s)`, a.maxSpin);
  report(`${label}: max |dist − L|/L while taut`, a.maxTautError);
  report(`${label}: max dist − L (m)`, a.maxDistanceOverLength);
  report(`${label}: requests refused (tugs / launches)`, `${a.tugsRefused} / ${a.launchesRefused}`);
  const above: Record<string, { steps: number; passes: number; maxCm: number; episodes: number }> = {};
  for (const [phase, stats] of Object.entries(a.above)) {
    if (stats) above[phase] = { steps: stats.steps, passes: stats.passes, maxCm: +(stats.max * 100).toFixed(1), episodes: stats.episodes.size };
  }
  report(`${label}: yoyo above the pivot, by phase`, JSON.stringify(above));
  report(`${label}: winding steps / worst displacement beyond the velocity (mm)`, `${a.windingSteps} / ${(a.windingExcessMax * 1000).toFixed(4)}`);
  const frame = Object.entries(a.frameExcessMax).map(([phase, worst]) => `${phase} ${((worst ?? 0) * 1000).toFixed(2)} mm of ${a.frameWindows[phase as YoyoPhase]}`).join(', ');
  report(`${label}: worst 60 Hz frame excess beyond max(|V| at the ends)·Δt, by phase (same phase at both ends)`, frame);
}

/** The invariants every episode must keep, whatever the hand does. */
function expectHardInvariants(a: Aggregate): void {
  expect(a.violations).toEqual([]);
  expect(a.maxLengthOver).toBeLessThanOrEqual(0.001);
  expect(a.maxDistanceOverLength).toBeLessThanOrEqual(STRING_TOLERANCE);
  expect(a.maxTautError).toBeLessThan(0.02);
}

const maxOf = (values: number[]) => values.reduce((largest, value) => Math.max(largest, value), 0);
const percentile = (values: number[], share: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};
/** How far a step may move the yoyo beyond what its own velocity explains at a catch or a phase change, m: 1 mm. */
const POP_LIMIT = 0.001;
/**
 * The most a 60 Hz frame of winding can show beyond max(|V| at its two ends)·Δt, m. The string snaps taut at
 * the start of the frame and the yoyo then flies free for the other three steps, losing d = what one step of
 * gravity and air drag takes off its speed each: the four displacements average 1.5·d above the last velocity,
 * whatever the size of the snap. 1.5 · (9.81/240 + 0.25·5/240) · (1/60) = 1.15 mm. The exact (continuous) motion
 * would show g·Δt²/2 = 1.36 mm, so a «≤ 1 mm» comparison of frame displacement with end speeds cannot hold for
 * any physical string; this bound is what the model reaches, and a step that is not consistent with its velocity
 * (a pull that does not reach it) would break it.
 */
const FRAME_EXCESS_CEILING = 1.5 * (GRAVITY / 240 + (0.25 * FRAME_TOP_SPEED) / 240) * (1 / 60);

describe('YoyoModel properties: realistic hands', () => {
  // Computed once: the tests below read the same 1500 episodes.
  const realistic = runMode('realistic', REALISTIC_EPISODES);

  it(`${REALISTIC_EPISODES} episodes keep every invariant, visit the whole state machine, and the yoyo is never above the pivot in any phase`, () => {
    const a = realistic;
    printAggregate('realistic', a);
    expect(a.episodes).toBe(REALISTIC_EPISODES);
    expectHardInvariants(a);

    // «Yoyo never above the pivot» (PRD §8.2): zero steps, in every phase.
    for (const phase of ['tethered', 'rolling', 'sleeping', 'returning', 'caught', 'exhausted'] as const) {
      expect(a.above[phase], `${phase}: yoyo above the pivot`).toBeUndefined();
    }

    // The episodes really are play: thousands of throws, tugs, auto-returns and catches.
    expect(a.events.launch).toBeGreaterThan(10_000);
    expect(a.events.snap).toBeGreaterThan(10_000);
    expect(a.events.tug).toBeGreaterThan(8000);
    expect(a.events.catch).toBeGreaterThan(8000);
    expect(a.events.retether).toBeGreaterThan(8000);
    expect(a.events['auto-return']).toBeGreaterThan(40);
    expect(a.events.exhausted).toBeGreaterThan(100);
    expect(a.tugsRefused).toBeGreaterThan(1000);
    expect(a.launchesRefused).toBeGreaterThan(1000);
    for (const phase of ['tethered', 'rolling', 'sleeping', 'returning', 'caught', 'exhausted'] as const) {
      expect(a.phaseSteps[phase] ?? 0, `${phase} steps`).toBeGreaterThan(100_000);
    }
  }, 120_000);

  it('no pop: at every catch and every phase change a step moves the yoyo no farther than its velocity explains, to 1 mm', () => {
    const a = realistic;
    report('realistic: phase changes measured / catches measured', `${a.transitionExcess.length} / ${a.catchExcess.length}`);
    report('realistic: displacement beyond max(|V before|, |V after|)·dt at a phase change, max / p95 (mm)', `${(maxOf(a.transitionExcess) * 1000).toFixed(3)} / ${(percentile(a.transitionExcess, 0.95) * 1000).toFixed(3)}`);
    report('realistic: ... at a catch, max / p95 (mm)', `${(maxOf(a.catchExcess) * 1000).toFixed(3)} / ${(percentile(a.catchExcess, 0.95) * 1000).toFixed(3)}`);
    report('realistic: ... in the steps a caught yoyo settles, max / p95 (mm)', `${(maxOf(a.caughtExcess) * 1000).toFixed(3)} / ${(percentile(a.caughtExcess, 0.95) * 1000).toFixed(3)}`);
    // Every catch and every phase change was measured, not a sample of them.
    expect(a.catchExcess).toHaveLength(a.events.catch);
    expect(a.transitionExcess.length).toBeGreaterThan(50_000);
    expect(a.caughtExcess.length).toBeGreaterThan(100_000);
    expect(maxOf(a.transitionExcess)).toBeLessThanOrEqual(POP_LIMIT);
    expect(maxOf(a.catchExcess)).toBeLessThanOrEqual(POP_LIMIT);
    expect(maxOf(a.caughtExcess)).toBeLessThanOrEqual(POP_LIMIT);
  }, 120_000);

  it('winding is kinematically consistent: no returning step moves the yoyo beyond its velocity, and a 60 Hz frame of it stays under the free-flight ceiling', () => {
    const a = realistic;
    const frameWorst = a.frameExcessMax.returning ?? Number.NaN;
    report('realistic: winding steps measured / worst displacement beyond the velocity (mm)', `${a.windingSteps} / ${(a.windingExcessMax * 1000).toFixed(5)}`);
    report('realistic: worst frame excess while returning / ceiling (mm)', `${(frameWorst * 1000).toFixed(3)} / ${(FRAME_EXCESS_CEILING * 1000).toFixed(3)}`);
    for (const phase of ['rolling', 'sleeping', 'exhausted', 'tethered', 'caught'] as const) {
      report(`realistic: worst frame excess while ${phase} (mm)`, `${((a.frameExcessMax[phase] ?? Number.NaN) * 1000).toFixed(3)} over ${a.frameWindows[phase] ?? 0} frames`);
    }
    // Every step of every return was measured, and the projection that reels the yoyo in is folded into its velocity.
    expect(a.windingSteps).toBeGreaterThan(1_000_000);
    expect(a.windingSteps).toBe((a.phaseSteps.returning ?? 0) - (a.events.tug ?? 0) - (a.events['auto-return'] ?? 0));
    expect(a.windingExcessMax).toBeLessThanOrEqual(1e-6);
    // A frame of winding shows at most the free-flight ceiling, which is a displacement and not a jump.
    expect(a.frameWindows.returning ?? 0).toBeGreaterThan(1_000_000);
    expect(frameWorst).toBeLessThanOrEqual(FRAME_EXCESS_CEILING);
  }, 120_000);

  it('is deterministic: an episode re-run gives identical results, step for step', () => {
    for (const seed of [7, 1234, 99]) {
      const first: number[] = [];
      const second: number[] = [];
      runEpisode(seed, 'realistic', newAggregate(), first);
      runEpisode(seed, 'realistic', newAggregate(), second);
      expect(first.length).toBeGreaterThan(20 * 240 * 7);
      expect(second).toHaveLength(first.length);
      for (let i = 0; i < first.length; i++) {
        if (first[i] !== second[i]) throw new Error(`seed ${seed}: run differs at value ${i}: ${first[i]} vs ${second[i]}`);
      }
    }
  });
});

describe('YoyoModel properties: chaos hands', () => {
  it(`${CHAOS_EPISODES} episodes (random strokes unrelated to the throws, up to 2.5 m/s and 25 m/s², wild configs) keep the hard invariants`, () => {
    const a = runMode('chaos', CHAOS_EPISODES);
    printAggregate('chaos', a);
    expect(a.episodes).toBe(CHAOS_EPISODES);
    expectHardInvariants(a);
    // Waiting on the finger the yoyo is still never above it, whatever the hand does: that is the clamp.
    expect(a.above.tethered).toBeUndefined();
    // Everything else is reported, not asserted. A hand that dives past a climbing yoyo or pumps the swing can put
    // it over the top, and a catch can then find it above the finger: it is brought down at a bounded pace
    // (no pop), so `caught` is not guarded either.
    expect(a.events.launch).toBeGreaterThan(4000);
    expect(a.events.catch).toBeGreaterThan(2000);
    // A return that runs dry is rare under the panel's ranges (a swinging yoyo used to burn spin on the centripetal
    // pull of its whirl; with the swing damped only the lowest return spins on the longest strings fall short): the
    // unit tests cover the path exactly, here it only has to be visited.
    expect(a.events['return-failed']).toBeGreaterThan(0);
  }, 120_000);

  it('is deterministic: an episode re-run gives identical results, step for step', () => {
    for (const seed of [11, 99, 4242]) {
      const first: number[] = [];
      const second: number[] = [];
      runEpisode(seed, 'chaos', newAggregate(), first);
      runEpisode(seed, 'chaos', newAggregate(), second);
      expect(first.length).toBeGreaterThan(14 * 240 * 7);
      expect(second).toHaveLength(first.length);
      for (let i = 0; i < first.length; i++) {
        if (first[i] !== second[i]) throw new Error(`seed ${seed}: run differs at value ${i}: ${first[i]} vs ${second[i]}`);
      }
    }
  });

  it('different seeds give different episodes (the generators are not stuck)', () => {
    for (const mode of ['realistic', 'chaos'] as const) {
      const a: number[] = [];
      const b: number[] = [];
      runEpisode(1, mode, newAggregate(), a);
      runEpisode(2, mode, newAggregate(), b);
      expect(a).not.toEqual(b);
    }
  });
});
