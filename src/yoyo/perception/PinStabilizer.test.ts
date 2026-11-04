import { describe, expect, it } from 'vitest';
import { createConfig, setConfigValue, type YoyoConfig } from '../config';
import type { PinState } from '../contracts';
import { Random } from '../replay/random';
import { PinStabilizer } from './PinStabilizer';

/**
 * Pin stabilizer criteria, all on SYNTHETIC input: a true hand path sampled at 30 Hz with 50 ms
 * capture → arrival latency, stepped at the physics rate (240 Hz). Nothing here says how it feels
 * on a real webcam. Set YOYO_REPORT=1 to print every measured number.
 */

const STEP_S = 1 / 240;
const STEP_MS = 1000 / 240;
const SAMPLE_INTERVAL_MS = 1000 / 30;
const LATENCY_MS = 50;
/** Per-axis tracking jitter the PRD asks the replays to carry (0.5 % of a 4:3 frame width in ih). */
const JITTER_SIGMA = 0.0067;

const report = (label: string, value: number | string) => {
  if (process.env.YOYO_REPORT === '1') console.info(`[pin] ${label}: ${typeof value === 'number' ? value.toPrecision(4) : value}`);
};

/**
 * The PRD / DECISIONS starting values (1€ 2.5 Hz, β 0.6, ω 25, feed-forward 0.8), spelled out so tests
 * that need a «sluggish» pivot, or a baseline to beat, do not depend on what config.ts holds.
 */
const PRD_START_PIN = { minCutoff: 2.5, beta: 0.6, derivativeCutoff: 1, springOmega: 25, feedForward: 0.8 } as const;

/**
 * A Masa-like tuning (low resting cutoff, high β, stiff spring) that lies OUTSIDE the box PRD §4.2 allows
 * (1€ minCutoff 2–3 Hz with «beta bajo», ω ≈ 25). It is here only as evidence: it shows the stabilizer CAN
 * reach the 3 cm lag budget, so what keeps the shipped tuning above it is the PRD's box, not the code.
 */
const MASA_LIKE_PIN = { minCutoff: 1, beta: 14, derivativeCutoff: 0.5, springOmega: 50, feedForward: 0.95 } as const;

/**
 * The lag the shipped tuning is held to at 1 m/s, behind the path at capture time. The spec asked for 3 cm.
 * Inside the box PRD §4.2 and the coordinator allow (minCutoff 2–3 Hz, β ≤ 6, ω 20–30 rad/s, feed-forward
 * 0.8–1, derivative cutoff 0.5–2 Hz) 3 cm is out of reach for this stabilizer: a sweep of tens of thousands
 * of points in the box, then a scan of its best corner, bottoms out at 4.17–4.22 cm, with β, ω and the
 * feed-forward all at their limits (β 6, ω 30, ff 1). The lag is the sum of
 *   - the 1€ stage, ~15 ms at 1 m/s even at β 6;
 *   - the spring, 2/ω·(1 − ff·0.63) ≈ 25 ms: the extrapolation decays by design, so on average only ~63 % of
 *     the feed-forward is in force between two arrivals;
 *   - half a sample interval of sample-and-hold (~17 ms) minus the ~12 ms of extrapolation lead (§4.2 caps it at
 *     33 ms), which nets to a few ms.
 * Going below needs a stiffer spring or a bigger β (outside the box: see MASA_LIKE_PIN) or a change in the
 * stabilizer's feed-forward: an offline sweep of the same box with the feed-forward held at full strength through
 * the whole extrapolation window, plus a gate on noisy low-speed velocity estimates (neither is implemented),
 * reached 3.15 cm. The bound is a regression guard, not a target: 4.3 cm leaves 0.1 cm over the worst phase.
 */
const BEST_IN_BOX_LAG_M = 0.043;

function withPin(pin: Readonly<Record<string, number>>): YoyoConfig {
  let config = createConfig();
  for (const [key, value] of Object.entries(pin)) config = setConfigValue(config, `pin.${key}`, value);
  return config;
}

const prdConfig = () => withPin(PRD_START_PIN);
const masaLikeConfig = () => withPin(MASA_LIKE_PIN);

type Path = (tMs: number) => readonly [number, number];

interface RigOptions {
  path: Path;
  seed?: number;
  /** Gaussian jitter per axis, m. */
  noise?: number;
  /** Capture phase against the 240 Hz step grid, ms. */
  phaseMs?: number;
  /** Capture times stop after this; the hand is gone and nothing else arrives. */
  stopCaptureAtMs?: number;
  /** With stopCaptureAtMs: captures resume from this time, the first one flagged as a discontinuity (the hand is back). */
  resumeCaptureAtMs?: number;
  /** The first sample captured at or after this time is flagged as a discontinuity. */
  discontinuityAtMs?: number;
  /** Start with the pivot already here instead of at the world home. */
  startAt?: PinState;
}

/** Drives a PinStabilizer exactly like the runtime will: deliver arrived samples, then step. */
class StreamRig {
  readonly pin: PinStabilizer;
  stepIndex = 0;
  /** Capture and arrival time of the most recently delivered sample (NaN before the first). */
  lastCaptureMs = Number.NaN;
  lastArrivalMs = Number.NaN;
  private captureIndex = 0;
  private flaggedDiscontinuity = false;
  private flaggedResume = false;
  private readonly random: Random;

  constructor(config: YoyoConfig, private readonly options: RigOptions) {
    this.pin = new PinStabilizer(config);
    this.random = new Random(options.seed ?? 1);
    const first = options.path(0);
    this.pin.reset(options.startAt ?? { x: first[0], y: first[1], vx: 0, vy: 0 });
  }

  get timeMs(): number {
    return this.stepIndex * STEP_MS;
  }

  /** One 240 Hz step. */
  tick(): PinState {
    this.stepIndex++;
    const t = this.timeMs;
    for (;;) {
      const capture = (this.options.phaseMs ?? 0) + this.captureIndex * SAMPLE_INTERVAL_MS;
      const { stopCaptureAtMs: stop, resumeCaptureAtMs: resume } = this.options;
      if (stop !== undefined && capture > stop) {
        if (resume === undefined) break;
        if (capture < resume) {
          this.captureIndex++;
          continue;
        }
      }
      const arrival = capture + LATENCY_MS;
      if (arrival > t) break;
      this.deliver(capture, arrival);
      this.captureIndex++;
    }
    return this.pin.step(STEP_S, t);
  }

  runUntil(ms: number, each?: (pivot: PinState, tMs: number) => void): void {
    while (this.timeMs + STEP_MS / 2 < ms) {
      const pivot = this.tick();
      each?.(pivot, this.timeMs);
    }
  }

  private deliver(captureMs: number, arrivalMs: number): void {
    const [x, y] = this.options.path(captureMs);
    const noise = this.options.noise ?? 0;
    let continuous = this.captureIndex > 0;
    const at = this.options.discontinuityAtMs;
    if (at !== undefined && !this.flaggedDiscontinuity && captureMs >= at) {
      continuous = false;
      this.flaggedDiscontinuity = true;
    }
    const resume = this.options.resumeCaptureAtMs;
    if (resume !== undefined && !this.flaggedResume && captureMs >= resume) {
      continuous = false;
      this.flaggedResume = true;
    }
    this.pin.push({
      x: x + (noise > 0 ? this.random.gaussian(0, noise) : 0),
      y: y + (noise > 0 ? this.random.gaussian(0, noise) : 0),
      timestampMs: captureMs,
      arrivalMs,
      continuous,
    });
    this.lastCaptureMs = captureMs;
    this.lastArrivalMs = arrivalMs;
  }
}

const still = (x = 0.2, y = 0.9): Path => () => [x, y];
const ramp = (speed: number): Path => (t) => [(speed * t) / 1000, 0.9];

describe('PinStabilizer without data', () => {
  it('holds still, with zero velocity, before the first sample', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0.3, y: 0.7, vx: 0, vy: 0 });
    for (let i = 1; i <= 240; i++) pin.step(STEP_S, i * STEP_MS);
    expect(pin.state).toEqual({ x: 0.3, y: 0.7, vx: 0, vy: 0 });
    expect(pin.fresh).toBe(false);
  });

  it('starts at the world home', () => {
    const config = createConfig();
    const pin = new PinStabilizer(config);
    expect(pin.state.x).toBe(config.world.homeX);
    expect(pin.state.y).toBe(config.world.homeY);
  });

  it('returns the same state object every step (no per-step allocation)', () => {
    const pin = new PinStabilizer(createConfig());
    const first = pin.step(STEP_S, STEP_MS);
    expect(pin.step(STEP_S, 2 * STEP_MS)).toBe(first);
    expect(pin.state).toBe(first);
  });
});

describe('PinStabilizer (a) static jitter', () => {
  const rawRms = JITTER_SIGMA * Math.SQRT2;

  function jitterRatio(config: YoyoConfig, seed: number): number {
    const rig = new StreamRig(config, { path: still(), noise: JITTER_SIGMA, seed, phaseMs: seed * 3.1 });
    let sum = 0;
    let n = 0;
    rig.runUntil(30_000, (pivot, t) => {
      if (t < 2000) return;
      sum += (pivot.x - 0.2) ** 2 + (pivot.y - 0.9) ** 2;
      n++;
    });
    return Math.sqrt(sum / n) / rawRms;
  }

  for (const [name, make] of [['shipped', createConfig], ['PRD starting values', prdConfig], ['Masa-like, off the PRD box', masaLikeConfig]] as const) {
    it(`pivot RMS deviation is at most 50 % of the raw jitter (${name})`, () => {
      const ratios = [1, 2, 3, 4, 5].map((seed) => jitterRatio(make(), seed));
      report(`jitter ratio ${name} (worst of 5 seeds)`, Math.max(...ratios));
      for (const ratio of ratios) expect(ratio).toBeLessThanOrEqual(0.5);
    });
  }
});

describe('PinStabilizer (b) ramp lag and stop overshoot', () => {
  /**
   * Lag against the path at the capture time of the data the pivot can know about: pivot(t) is
   * compared with truth(t − latency). Positive = the pivot is behind. The tracking latency itself
   * (50 ms = 5 cm at 1 m/s) is not the stabilizer's to remove; what it adds on top is.
   */
  function steadyLag(config: YoyoConfig, speed: number, phaseMs = 0): { captureLagM: number; endToEndLagM: number } {
    const path = ramp(speed);
    const rig = new StreamRig(config, { path, phaseMs });
    let capture = 0;
    let endToEnd = 0;
    let n = 0;
    rig.runUntil(6000, (pivot, t) => {
      if (t < 3000) return;
      capture += path(t - LATENCY_MS)[0] - pivot.x;
      endToEnd += path(t)[0] - pivot.x;
      n++;
    });
    return { captureLagM: capture / n, endToEndLagM: endToEnd / n };
  }

  function stopOvershoot(config: YoyoConfig, speed: number): number {
    const stopAt = 3000;
    const stopX = (speed * stopAt) / 1000;
    const path: Path = (t) => [(speed * Math.min(t, stopAt)) / 1000, 0.9];
    const rig = new StreamRig(config, { path });
    let over = -Infinity;
    rig.runUntil(6000, (pivot, t) => {
      if (t > stopAt) over = Math.max(over, pivot.x - stopX);
    });
    return over;
  }

  it('shipped tuning: the pivot trails the capture-time path by at most the best the PRD box allows (4.3 cm) at 1 m/s', () => {
    // The 3 cm of the spec is not reachable inside the box: see BEST_IN_BOX_LAG_M for the sweep and the lag budget.
    for (const phase of [0, 4.1, 9.7, 17.3]) {
      const { captureLagM, endToEndLagM } = steadyLag(createConfig(), 1, phase);
      report('lag vs capture-time path, shipped, 1 m/s (cm)', captureLagM * 100);
      report('lag end to end, shipped, 1 m/s (cm)', endToEndLagM * 100);
      expect(captureLagM).toBeLessThanOrEqual(BEST_IN_BOX_LAG_M);
      expect(captureLagM).toBeGreaterThan(0);
    }
  });

  it('shipped tuning beats the PRD starting values by well over 3 cm of lag at 1 m/s', () => {
    const shipped = steadyLag(createConfig(), 1).captureLagM;
    const start = steadyLag(prdConfig(), 1).captureLagM;
    report('lag vs capture-time path, PRD starting values, 1 m/s (cm)', start * 100);
    expect(start - shipped).toBeGreaterThan(0.03);
  });

  it('the 3 cm budget of the spec is reachable by this stabilizer, only outside the PRD box (Masa-like tuning)', () => {
    for (const phase of [0, 4.1, 9.7, 17.3]) {
      const { captureLagM, endToEndLagM } = steadyLag(masaLikeConfig(), 1, phase);
      report('lag vs capture-time path, Masa-like, 1 m/s (cm)', captureLagM * 100);
      report('lag end to end, Masa-like, 1 m/s (cm)', endToEndLagM * 100);
      expect(captureLagM).toBeLessThanOrEqual(0.03);
    }
  });

  it('the shipped tuning is not a knife edge: 10 % off on any one field still meets jitter and overshoot, and costs under 1 cm of lag', () => {
    const rawRms = JITTER_SIGMA * Math.SQRT2;
    const shipped = createConfig().pin;
    for (const key of ['minCutoff', 'beta', 'derivativeCutoff', 'springOmega', 'feedForward'] as const) {
      for (const factor of [0.9, 1.1]) {
        const config = setConfigValue(createConfig(), `pin.${key}`, Math.min(shipped[key] * factor, key === 'feedForward' ? 1 : Infinity));
        const lag = steadyLag(config, 1).captureLagM;
        const overshoot = stopOvershoot(config, 1);
        const rig = new StreamRig(config, { path: still(), noise: JITTER_SIGMA, seed: 3 });
        let sum = 0;
        let n = 0;
        rig.runUntil(20_000, (pivot, t) => {
          if (t < 2000) return;
          sum += (pivot.x - 0.2) ** 2 + (pivot.y - 0.9) ** 2;
          n++;
        });
        const jitter = Math.sqrt(sum / n) / rawRms;
        report(`10 % off ${key} x${factor}: lag cm / overshoot cm / jitter ratio`, `${(lag * 100).toFixed(2)} / ${(overshoot * 100).toFixed(2)} / ${jitter.toFixed(3)}`);
        expect(lag, `${key} x${factor}: lag`).toBeLessThanOrEqual(BEST_IN_BOX_LAG_M + 0.01);
        expect(overshoot, `${key} x${factor}: overshoot`).toBeLessThanOrEqual(0.01);
        expect(jitter, `${key} x${factor}: jitter`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('shipped tuning keeps the lag, in time, under 55 ms from 0.5 to 3 m/s (it shrinks as the hand speeds up)', () => {
    for (const speed of [0.5, 1, 2, 3]) {
      const { captureLagM } = steadyLag(createConfig(), speed);
      report(`lag in ms, shipped, ${speed} m/s`, (captureLagM / speed) * 1000);
      expect(captureLagM / speed).toBeLessThanOrEqual(0.055);
    }
  });

  for (const [name, make] of [['shipped', createConfig], ['PRD starting values', prdConfig], ['Masa-like, off the PRD box', masaLikeConfig]] as const) {
    it(`overshoots a stop from 1 m/s by at most 1 cm (${name})`, () => {
      const over = stopOvershoot(make(), 1);
      report(`stop overshoot ${name} (cm)`, over * 100);
      // Information only: overshoot grows with speed (a stop from 2 m/s is not part of the criterion).
      report(`stop overshoot ${name} from 2 m/s (cm)`, stopOvershoot(make(), 2) * 100);
      expect(over).toBeLessThanOrEqual(0.01);
    });
  }
});

describe('PinStabilizer (c) discontinuities never teleport the pivot', () => {
  interface JumpResult {
    maxSpeed: number;
    maxStep16: number;
    convergedAfterMs: number;
    maxErrorAfterConverged: number;
    pivotAtJumpArrival: number;
  }

  /** Static hand, then an instantaneous jump of `size` metres flagged as a discontinuity. */
  function jump(config: YoyoConfig, size: number): JumpResult {
    const jumpAt = 2000;
    const rig = new StreamRig(config, { path: (t) => [t >= jumpAt ? size : 0, 0.9], discontinuityAtMs: jumpAt });
    const history: number[] = [];
    let jumpArrival = Number.NaN;
    let maxSpeed = 0;
    let maxStep16 = 0;
    let convergedAt = Number.NaN;
    let maxErrorAfter = 0;
    let pivotAtJumpArrival = 0;
    const tolerance = 0.002;
    rig.runUntil(jumpAt + 3000, (pivot, t) => {
      history.push(pivot.x);
      if (Number.isNaN(jumpArrival) && rig.lastCaptureMs >= jumpAt) {
        jumpArrival = rig.lastArrivalMs;
        pivotAtJumpArrival = pivot.x;
      }
      if (Number.isNaN(jumpArrival)) return;
      if (t - jumpArrival < config.pin.recoverMs) maxSpeed = Math.max(maxSpeed, Math.hypot(pivot.vx, pivot.vy));
      // Displacement over 4 steps = 16.7 ms = one 60 Hz render frame.
      if (history.length > 4) maxStep16 = Math.max(maxStep16, Math.abs(pivot.x - history[history.length - 5]));
      const error = Math.abs(pivot.x - size);
      if (Number.isNaN(convergedAt) && error < tolerance) convergedAt = t - jumpArrival;
      else if (!Number.isNaN(convergedAt)) maxErrorAfter = Math.max(maxErrorAfter, error);
    });
    return { maxSpeed, maxStep16, convergedAfterMs: convergedAt, maxErrorAfterConverged: maxErrorAfter, pivotAtJumpArrival };
  }

  for (const [name, make] of [['shipped', createConfig], ['PRD starting values', prdConfig], ['Masa-like, off the PRD box', masaLikeConfig]] as const) {
    it(`0.4 m jump: speed ≤ recoverSpeed, ≤ 4.1 cm per 16.7 ms, converged within 400 ms (${name})`, () => {
      const config = make();
      const result = jump(config, 0.4);
      report(`jump 0.4 m ${name}: max speed (m/s)`, result.maxSpeed);
      report(`jump 0.4 m ${name}: max displacement in 16.7 ms (cm)`, result.maxStep16 * 100);
      report(`jump 0.4 m ${name}: converged after (ms)`, result.convergedAfterMs);
      expect(result.maxSpeed).toBeLessThanOrEqual(config.pin.recoverSpeed + 1e-9);
      expect(result.maxStep16).toBeLessThanOrEqual(0.041);
      expect(result.convergedAfterMs).toBeLessThanOrEqual(400);
      // Once there it stays there: no ringing back out of the 2 mm band.
      expect(result.maxErrorAfterConverged).toBeLessThan(0.0025);
    });
  }

  it('when the jump arrives the pivot has moved at most one capped step: it does not blend or leap', () => {
    for (const make of [createConfig, masaLikeConfig, prdConfig]) {
      const config = make();
      const result = jump(config, 0.4);
      expect(Math.abs(result.pivotAtJumpArrival)).toBeLessThanOrEqual(config.pin.recoverSpeed * STEP_S + 1e-9);
    }
  });

  it('a hand reappearing across the whole frame (1.2 m) still never exceeds 4.1 cm per 16.7 ms', () => {
    for (const make of [createConfig, prdConfig, masaLikeConfig]) {
      const result = jump(make(), 1.2);
      report('jump 1.2 m: max displacement in 16.7 ms (cm)', result.maxStep16 * 100);
      report('jump 1.2 m: converged after (ms)', result.convergedAfterMs);
      expect(result.maxStep16).toBeLessThanOrEqual(0.041);
      expect(result.convergedAfterMs).toBeLessThanOrEqual(1000);
    }
  });

  it('recovery ends on its own: the cap is held until the pivot has caught up, then eases off, well before a second has passed', () => {
    for (const make of [createConfig, prdConfig, masaLikeConfig]) {
      const config = make();
      const jumpAt = 2000;
      const rig = new StreamRig(config, { path: (t) => [t >= jumpAt ? 0.4 : 0, 0.9], discontinuityAtMs: jumpAt });
      let arrival = Number.NaN;
      let overAt = Number.NaN;
      let holdingAt100 = false;
      rig.runUntil(jumpAt + 3000, (_pivot, t) => {
        if (Number.isNaN(arrival) && rig.lastCaptureMs >= jumpAt) arrival = rig.lastArrivalMs;
        if (Number.isNaN(arrival)) return;
        if (t - arrival >= 100 && t - arrival < 100 + STEP_MS) holdingAt100 = rig.pin.recovering;
        if (Number.isNaN(overAt) && t > arrival && !rig.pin.recovering) overAt = t - arrival;
      });
      report('recovery over after (ms), 0.4 m jump', overAt);
      expect(holdingAt100).toBe(true);
      // Caught up in ~300 ms, then 150 ms of easing: before recoverMs + the ramp, never stuck.
      expect(overAt).toBeLessThanOrEqual(config.pin.recoverMs + 150 + 2 * STEP_MS);
      expect(overAt).toBeGreaterThan(150);
    }
  });

  interface LostAndFound {
    /** Largest pivot displacement in any 16.7 ms window after the hand is back (absolute). */
    maxStep16: number;
    /** Largest displacement of the pivot beyond the target's own displacement in the same window: the Y-06 teleport. */
    maxTeleport: number;
    maxSpeed: number;
  }

  /**
   * The hand moves, leaves the frame for `lostMs` (the pivot freezes), and reappears `distance` metres away
   * moving at `speed`. Measures what the pivot does in every 16.7 ms window once the hand is back (Y-06): its
   * absolute displacement, and the part of it that the target itself (the hand as captured, `LATENCY_MS` ago)
   * did not move in that window. The second is the teleport: a hand that moves 3 m/s moves 5 cm per frame on its
   * own, and a pivot that keeps up with it has teleported nothing.
   */
  function lostAndFound(config: YoyoConfig, random: Random, speed: number): LostAndFound {
    const lostAt = 2000;
    const lostMs = random.range(300, 1500);
    const foundAt = lostAt + lostMs;
    const before = random.range(0, 1);
    const beforeAngle = random.range(0, 2 * Math.PI);
    const distance = random.range(0.3, 0.6);
    const jumpAngle = random.range(0, 2 * Math.PI);
    const afterAngle = random.range(0, 2 * Math.PI);
    const start = [0.3, 0.9];
    const last = [start[0] + (before * Math.cos(beforeAngle) * lostAt) / 1000, start[1] + (before * Math.sin(beforeAngle) * lostAt) / 1000];
    const back = [last[0] + distance * Math.cos(jumpAngle), last[1] + distance * Math.sin(jumpAngle)];
    const path: Path = (t) => t < lostAt
      ? [start[0] + (before * Math.cos(beforeAngle) * t) / 1000, start[1] + (before * Math.sin(beforeAngle) * t) / 1000]
      : [back[0] + (speed * Math.cos(afterAngle) * (t - foundAt)) / 1000, back[1] + (speed * Math.sin(afterAngle) * (t - foundAt)) / 1000];
    const rig = new StreamRig(config, { path, stopCaptureAtMs: lostAt, resumeCaptureAtMs: foundAt });
    const xs: number[] = [];
    const ys: number[] = [];
    const targetXs: number[] = [];
    const targetYs: number[] = [];
    let maxStep16 = 0;
    let maxTeleport = 0;
    let maxSpeed = 0;
    rig.runUntil(foundAt + 4000, (pivot, t) => {
      const [targetX, targetY] = path(t - LATENCY_MS);
      xs.push(pivot.x);
      ys.push(pivot.y);
      targetXs.push(targetX);
      targetYs.push(targetY);
      if (t < foundAt + LATENCY_MS) return;
      maxSpeed = Math.max(maxSpeed, Math.hypot(pivot.vx, pivot.vy));
      const n = xs.length;
      if (n <= 4) return;
      // Displacement over 4 steps = 16.7 ms = one 60 Hz render frame.
      const moved = Math.hypot(pivot.x - xs[n - 5], pivot.y - ys[n - 5]);
      const targetMoved = Math.hypot(targetX - targetXs[n - 5], targetY - targetYs[n - 5]);
      maxStep16 = Math.max(maxStep16, moved);
      maxTeleport = Math.max(maxTeleport, moved - targetMoved);
    });
    return { maxStep16, maxTeleport, maxSpeed };
  }

  function lostAndFoundWorst(config: YoyoConfig, speedUpTo: number, fixedSpeed: boolean, trials: number) {
    const random = new Random(2026);
    const steps: number[] = [];
    const teleports: number[] = [];
    let maxSpeed = 0;
    for (let i = 0; i < trials; i++) {
      const result = lostAndFound(config, random, fixedSpeed ? speedUpTo : random.range(0, speedUpTo));
      steps.push(result.maxStep16);
      teleports.push(result.maxTeleport);
      maxSpeed = Math.max(maxSpeed, result.maxSpeed);
    }
    steps.sort((a, b) => a - b);
    teleports.sort((a, b) => a - b);
    return {
      worst: steps[steps.length - 1],
      p95: steps[Math.floor(trials * 0.95)],
      worstTeleport: teleports[teleports.length - 1],
      p95Teleport: teleports[Math.floor(trials * 0.95)],
      maxSpeed,
    };
  }

  it('Y-06: a hand lost for 0.3–1.5 s that reappears 0.3–0.6 m away moving at 0–3 m/s never makes the pivot move more than 5 cm in 16.7 ms beyond what the target itself moved', () => {
    for (const make of [createConfig, prdConfig, masaLikeConfig]) {
      const { worstTeleport, p95Teleport, worst } = lostAndFoundWorst(make(), 3, false, 150);
      report('Y-06 hand 0-3 m/s: worst teleport in 16.7 ms (cm)', worstTeleport * 100);
      report('Y-06 hand 0-3 m/s: p95 teleport in 16.7 ms (cm)', p95Teleport * 100);
      report('Y-06 hand 0-3 m/s: worst absolute displacement in 16.7 ms (cm)', worst * 100);
      expect(worstTeleport).toBeLessThanOrEqual(0.05);
    }
  });

  it('Y-06 at fixed hand speeds: the teleport stays under 5 cm and the absolute displacement per frame is the hand\'s own plus the catch-up (reported at 1, 2 and 3 m/s)', () => {
    for (const speed of [0, 1, 2, 3]) {
      const { worst, p95, worstTeleport, p95Teleport, maxSpeed } = lostAndFoundWorst(createConfig(), speed, true, 150);
      report(`Y-06 hand at ${speed} m/s: worst absolute displacement in 16.7 ms (cm)`, worst * 100);
      report(`Y-06 hand at ${speed} m/s: p95 absolute displacement in 16.7 ms (cm)`, p95 * 100);
      report(`Y-06 hand at ${speed} m/s: worst / p95 teleport in 16.7 ms (cm)`, `${(worstTeleport * 100).toFixed(2)} / ${(p95Teleport * 100).toFixed(2)}`);
      report(`Y-06 hand at ${speed} m/s: max pivot speed (m/s)`, maxSpeed);
      expect(worstTeleport).toBeLessThanOrEqual(0.05);
      // Never more than the hand's own frame displacement plus the capped closing speed (4 cm per frame) plus the ease-off's extra.
      expect(worst).toBeLessThanOrEqual((speed * 1000) / 60 / 1000 + 0.05);
    }
  });

  it('the recovery cap is relative to the hand: while it holds, the pivot moves at most |v_f| + recoverSpeed, which for a moving hand is more than recoverSpeed', () => {
    const config = createConfig();
    const jumpAt = 2000;
    const handSpeed = 1.5;
    const rig = new StreamRig(config, { path: (t) => [t >= jumpAt ? 0.4 + (handSpeed * (t - jumpAt)) / 1000 : 0, 0.9], discontinuityAtMs: jumpAt });
    let arrival = Number.NaN;
    let fastest = 0;
    let worstOverCap = -Infinity;
    rig.runUntil(jumpAt + 2000, (pivot, t) => {
      if (Number.isNaN(arrival) && rig.lastCaptureMs >= jumpAt) arrival = rig.lastArrivalMs;
      // The hold of a moving hand lasts at least recoverMs (the spring alone trails it by more than the 1 cm that would end it).
      if (Number.isNaN(arrival) || t - arrival > config.pin.recoverMs || t < arrival) return;
      const speed = Math.hypot(pivot.vx, pivot.vy);
      const cap = Math.hypot(rig.pin.filtered.vx, rig.pin.filtered.vy) + config.pin.recoverSpeed;
      fastest = Math.max(fastest, speed);
      worstOverCap = Math.max(worstOverCap, speed - cap);
    });
    report('relative cap: fastest pivot speed while holding, hand at 1.5 m/s (m/s)', fastest);
    expect(worstOverCap).toBeLessThanOrEqual(1e-9);
    // An absolute cap of recoverSpeed would have stopped it there; the relative one lets it keep up with the hand and close in.
    expect(fastest).toBeGreaterThan(config.pin.recoverSpeed + 0.5);
  });

  it('a flagged discontinuity reseeds the 1€ filter at the new sample', () => {
    const config = createConfig();
    const pin = new PinStabilizer(config);
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    pin.push({ x: 0, y: 0.9, timestampMs: 33, arrivalMs: 83, continuous: true });
    pin.push({ x: 0.5, y: 0.9, timestampMs: 66, arrivalMs: 116, continuous: false });
    expect(pin.filtered.x).toBe(0.5);
    expect(pin.filtered.vx).toBe(0);
    expect(pin.recovering).toBe(true);
  });

  it('a continuous sample is smoothed instead (control for the previous test)', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    pin.push({ x: 0.5, y: 0.9, timestampMs: 33, arrivalMs: 83, continuous: true });
    expect(pin.filtered.x).toBeGreaterThan(0);
    expect(pin.filtered.x).toBeLessThan(0.5);
  });
});

describe('PinStabilizer (d) stale data applies no force', () => {
  it('freezes with exactly zero velocity and a constant position once data is older than staleMs', () => {
    for (const make of [createConfig, prdConfig, masaLikeConfig]) {
      const config = make();
      const rig = new StreamRig(config, { path: ramp(1), stopCaptureAtMs: 3000 });
      rig.runUntil(4000);
      const lastCapture = rig.lastCaptureMs;
      expect(lastCapture).toBeLessThanOrEqual(3000);
      // The step at which age first exceeds staleMs, and everything after.
      let frozenX = Number.NaN;
      let checked = 0;
      rig.runUntil(lastCapture + config.perception.staleMs + 2 * STEP_MS);
      frozenX = rig.pin.state.x;
      rig.runUntil(lastCapture + config.perception.staleMs + 3000, (pivot, t) => {
        if (t - lastCapture <= config.perception.staleMs) return;
        expect(pivot.vx).toBe(0);
        expect(pivot.vy).toBe(0);
        expect(pivot.x).toBe(frozenX);
        expect(rig.pin.fresh).toBe(false);
        checked++;
      });
      expect(checked).toBeGreaterThan(500);
    }
  });

  it('is fresh exactly while the newest data is no older than staleMs', () => {
    const config = createConfig();
    const rig = new StreamRig(config, { path: still(), stopCaptureAtMs: 1000 });
    // Run until the last sample that will ever exist has arrived, then watch freshness expire.
    rig.runUntil(1000 + LATENCY_MS + 2 * STEP_MS);
    const lastCapture = rig.lastCaptureMs;
    let fresh = 0;
    let stale = 0;
    rig.runUntil(2000, (_pivot, t) => {
      const young = t - lastCapture <= config.perception.staleMs;
      expect(rig.pin.fresh).toBe(young);
      if (young) fresh++;
      else stale++;
    });
    expect(fresh).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(100);
  });

  it('does not apply force while frozen: a long silence leaves the pivot where it was', () => {
    const rig = new StreamRig(createConfig(), { path: still(0.4, 0.8), stopCaptureAtMs: 1000 });
    rig.runUntil(1500);
    const held = { ...rig.pin.state };
    rig.runUntil(30_000);
    expect(rig.pin.state).toEqual(held);
  });

  it('restarts at the new place when data returns after going stale (no blending from the old place)', () => {
    const config = createConfig();
    const pin = new PinStabilizer(config);
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    pin.step(STEP_S, 100);
    // Time passes with nothing arriving, so the pivot freezes; then a sample that CLAIMS continuity.
    pin.step(STEP_S, 400);
    expect(pin.fresh).toBe(false);
    pin.push({ x: 0.7, y: 0.9, timestampMs: 450, arrivalMs: 500, continuous: true });
    expect(pin.filtered.x).toBe(0.7);
    expect(pin.recovering).toBe(true);
  });

  it('restarts even if nobody stepped while the stream stalled (arrival gap beyond staleMs)', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    pin.push({ x: 0.7, y: 0.9, timestampMs: 400, arrivalMs: 450, continuous: true });
    expect(pin.filtered.x).toBe(0.7);
  });
});

describe('PinStabilizer (e) extrapolation is bounded', () => {
  function extrapolation(config: YoyoConfig, vx: number, vy: number): { beyond: number; limit: number } {
    const path: Path = (t) => [(vx * t) / 1000, 0.5 + (vy * t) / 1000];
    const rig = new StreamRig(config, { path, stopCaptureAtMs: 3000 });
    // Run until the last sample that will ever exist has been delivered, then watch what the pivot does.
    rig.runUntil(3000 + LATENCY_MS + 2 * STEP_MS);
    const f = { ...rig.pin.filtered };
    const speed = Math.hypot(f.vx, f.vy);
    const ux = f.vx / speed;
    const uy = f.vy / speed;
    let beyond = -Infinity;
    rig.runUntil(4000, (pivot) => {
      beyond = Math.max(beyond, (pivot.x - f.x) * ux + (pivot.y - f.y) * uy);
    });
    return { beyond, limit: (speed * config.pin.extrapolateMs) / 1000 };
  }

  for (const [name, make] of [['shipped', createConfig], ['PRD starting values', prdConfig], ['Masa-like, off the PRD box', masaLikeConfig]] as const) {
    it(`never goes farther than |v|·33 ms plus 2 mm past the last filtered position (${name})`, () => {
      for (const [vx, vy] of [[1, 0], [0.5, 0], [2, 0], [-1, 0], [0.7, -0.7], [0, -1.5]]) {
        const { beyond, limit } = extrapolation(make(), vx, vy);
        report(`extrapolation beyond p_f ${name} v=(${vx},${vy}): cm (limit ${(limit * 100).toFixed(1)})`, beyond * 100);
        expect(beyond).toBeLessThanOrEqual(limit + 0.002);
      }
    });
  }

  it('the pivot settles when the data stops: it ends up still, not drifting on a leftover velocity', () => {
    const config = createConfig();
    const rig = new StreamRig(config, { path: ramp(1.5), stopCaptureAtMs: 3000 });
    rig.runUntil(3000 + config.perception.staleMs);
    const before = rig.pin.state.x;
    rig.runUntil(6000);
    // Frozen by staleMs; whatever it traveled after the last arrival stays bounded.
    expect(Math.abs(rig.pin.state.x - before)).toBeLessThan(0.05);
    expect(rig.pin.state.vx).toBe(0);
  });
});

describe('PinStabilizer input hygiene and bookkeeping', () => {
  it('ignores samples with non-finite numbers and keeps a finite pivot', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      pin.push({ x: bad, y: 0.9, timestampMs: 33, arrivalMs: 83, continuous: true });
      pin.push({ x: 0, y: bad, timestampMs: 33, arrivalMs: 83, continuous: true });
      pin.push({ x: 0, y: 0.9, timestampMs: bad, arrivalMs: 83, continuous: true });
      pin.push({ x: 0, y: 0.9, timestampMs: 33, arrivalMs: bad, continuous: true });
    }
    for (let i = 1; i <= 240; i++) pin.step(STEP_S, 100 + i * STEP_MS);
    expect(Number.isFinite(pin.state.x + pin.state.y + pin.state.vx + pin.state.vy)).toBe(true);
    expect(pin.filtered.x).toBe(0);
  });

  it('drops samples that run time backwards or repeat a timestamp inside a continuous run', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 100, arrivalMs: 150, continuous: false });
    pin.push({ x: 0.1, y: 0.9, timestampMs: 133, arrivalMs: 183, continuous: true });
    const kept = pin.filtered.x;
    pin.push({ x: 0.5, y: 0.9, timestampMs: 133, arrivalMs: 190, continuous: true });
    pin.push({ x: 0.5, y: 0.9, timestampMs: 120, arrivalMs: 195, continuous: true });
    expect(pin.filtered.x).toBe(kept);
  });

  it('clamps the filtered velocity used for extrapolation to 4 m/s', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    // 1 ms apart and 0.3 m away: an absurd 300 m/s that must not reach the target.
    pin.push({ x: 0.3, y: 0.9, timestampMs: 1, arrivalMs: 51, continuous: true });
    expect(Math.hypot(pin.filtered.vx, pin.filtered.vy)).toBeLessThanOrEqual(4 + 1e-12);
  });

  it('reset(at) puts the pivot there at rest and forgets every sample', () => {
    const rig = new StreamRig(createConfig(), { path: ramp(1) });
    rig.runUntil(2000);
    rig.pin.reset({ x: -0.3, y: 1.1, vx: 0, vy: 0 });
    expect(rig.pin.state).toEqual({ x: -0.3, y: 1.1, vx: 0, vy: 0 });
    expect(rig.pin.fresh).toBe(false);
    rig.pin.step(STEP_S, rig.timeMs + 5000);
    expect(rig.pin.state).toEqual({ x: -0.3, y: 1.1, vx: 0, vy: 0 });
  });

  it('a first sample after reset glides to it at the capped speed instead of jumping', () => {
    const config = createConfig();
    const rig = new StreamRig(config, { path: still(0.5, 0.85), startAt: { x: 0, y: 0.85, vx: 0, vy: 0 } });
    let previous = 0;
    let maxStep = 0;
    rig.runUntil(2000, (pivot) => {
      maxStep = Math.max(maxStep, pivot.x - previous);
      previous = pivot.x;
    });
    expect(maxStep).toBeLessThanOrEqual(config.pin.recoverSpeed * STEP_S + 1e-12);
    expect(rig.pin.state.x).toBeCloseTo(0.5, 2);
  });

  it('setConfig keeps the pivot continuous: new tunables, no jump', () => {
    const rig = new StreamRig(prdConfig(), { path: ramp(1) });
    rig.runUntil(3000);
    const before = rig.pin.state.x;
    rig.pin.setConfig(createConfig());
    expect(rig.pin.state.x).toBe(before);
    let worstStep = 0;
    let previous = before;
    rig.runUntil(4000, (pivot) => {
      worstStep = Math.max(worstStep, Math.abs(pivot.x - previous));
      previous = pivot.x;
    });
    // 1 m/s is 4.2 mm per step; a re-seeded filter that jumped would show a far larger step.
    expect(worstStep).toBeLessThan(0.01);
  });

  it('new tunables take effect: the shipped pivot trails less than the PRD-valued one', () => {
    const lag = (config: YoyoConfig) => {
      const rig = new StreamRig(config, { path: ramp(1) });
      rig.runUntil(4000);
      return ramp(1)(4000)[0] - rig.pin.state.x;
    };
    expect(lag(createConfig())).toBeLessThan(lag(prdConfig()) - 0.03);
  });

  it('is deterministic: the same stream gives the same pivot, step for step', () => {
    const run = () => {
      const rig = new StreamRig(createConfig(), { path: ramp(0.8), noise: JITTER_SIGMA, seed: 11, phaseMs: 7 });
      const trace: number[] = [];
      rig.runUntil(5000, (pivot) => trace.push(pivot.x, pivot.y, pivot.vx, pivot.vy));
      return trace;
    };
    const a = run();
    const b = run();
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('survives a dt far beyond the physics step without blowing up', () => {
    const pin = new PinStabilizer(createConfig());
    pin.reset({ x: 0, y: 0.9, vx: 0, vy: 0 });
    pin.push({ x: 0.3, y: 0.9, timestampMs: 0, arrivalMs: 50, continuous: false });
    for (let i = 0; i < 50; i++) pin.step(0.5, 60 + i);
    expect(Number.isFinite(pin.state.x + pin.state.vx)).toBe(true);
    expect(Math.abs(pin.state.x)).toBeLessThan(1);
  });
});
