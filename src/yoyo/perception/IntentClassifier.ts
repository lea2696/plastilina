import type { AnchorSample, ArmedIntents, FrameEdge, IntentClassifierLike, IntentEvent } from '../contracts';
import type { YoyoConfig } from '../config';
import { firstIndexAtOrAfter, fitLine, type TimedPoint } from './robust';

/**
 * The ring is sized for samples arriving at up to this rate. perception.minSampleSpacingMs already
 * keeps the rate under 1000 / spacing (40 Hz by default); the floor covers a source that bursts.
 */
const RING_RATE_HZ = 60;
/** Even with the spacing tuned down to nothing the ring stops growing here: nobody streams anchors faster than the 240 Hz sim steps. */
const RING_MAX_RATE_HZ = 240;
/** History kept beyond the longest quietness window: the stroke itself plus the end slack. */
const RING_EXTRA_MS = 250;
/** Spare slots on top of the rate-derived size. */
const RING_EXTRA_SLOTS = 4;

/** A quietness window must be backed by at least this share of its nominal duration in actual samples. */
const STILL_COVERAGE = 0.75;
/** And by at least this many samples: a slope through three points is mostly noise. */
const MIN_STILL_POINTS = 4;
/**
 * The top of a wind-up is looked for among at least this many samples before the first fast
 * interval: by the time speed reaches the launch threshold the hand has already started down from it.
 */
const WINDUP_TOP_SLACK = 3;
/**
 * A slow-start wind-up (see hasWindUp) looks for its top among all the samples of this many ms before
 * the first fast interval. Luis's throws set off down slowly: from the apex to the first interval at
 * the launch speed takes 35–233 ms (up to 6 samples), and a top searched for among the last three
 * samples would be a point on the slope, with the rise measured to it too small and its line too slanted.
 */
const WINDUP_TOP_WINDOW_MS = 250;
/**
 * No point of the wind-up window may lie higher than the apex by more than this, ih: the apex is the
 * top of the window, not a point of a descent that began higher up (the rounded top of a casual arc,
 * where the hand slows for a sample or two, would pass for one). Luis's apexes are the highest point of
 * their window within the 3-sample mean's noise (0.008 ih).
 */
const WINDUP_APEX_TOLERANCE = 0.02;
/**
 * How far below the apex a slow-start stroke may start, as a share of the wind-up's rise: Luis's
 * slowest starts are 0.43 of it with the seated preset and 0.7 with the standing one (whose windows
 * begin later in the same throws); the casual arc that drifts 0.05 ih down from a 0.02 ih bump before
 * speeding up is 2, and one arc in 2 000 synthetic clips gets through at 1.5.
 */
const WINDUP_DROP_SHARE = 1;
/**
 * A stroke that rests on one stretched interval (see detectLaunch) is confirmed when the sample after
 * it, and the sample before it, are at least this share of the way down it.
 */
const STRETCHED_HOLD_SHARE = 0.75;
/**
 * The PRD counts «frames» at its 30 fps camera: tug.minUpDelta over tug.maxFrames frames is a mean
 * speed in ih/s only at that rate. tug.minSpeedFactor multiplies that mean speed.
 */
const REFERENCE_FRAME_RATE_HZ = 30;

/**
 * How many frames of that 30 fps clock an interval between two samples covers: 1 for the camera's
 * usual 25–49 ms, 2 for the 50–83 ms of one dropped frame, 3 for two. «Sustained over 2 frames» is
 * a duration, and a camera that drops frames (Luis's webcam: 10 % of the intervals are 67 ms, and
 * the fastest strokes lose the hand outright) delivers 0.2 ih of stroke as one interval, not two.
 */
export function framesSpanned(intervalMs: number): number {
  return Math.max(1, Math.round((intervalMs * REFERENCE_FRAME_RATE_HZ) / 1000));
}

/** Mutable slot; the ring hands out read-only views of it. */
interface Slot { t: number; x: number; y: number }

/**
 * Fixed-capacity history of raw anchor samples. Pushing past capacity overwrites the oldest
 * sample, so a classifier left running for hours holds exactly the same memory as at start-up.
 */
export class SampleRing {
  private readonly slots: Slot[];
  private oldest = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.slots = Array.from({ length: capacity }, () => ({ t: 0, x: 0, y: 0 }));
  }

  get length(): number {
    return this.count;
  }

  clear() {
    this.oldest = 0;
    this.count = 0;
  }

  push(t: number, x: number, y: number) {
    let slot: Slot;
    if (this.count < this.capacity) {
      slot = this.slots[(this.oldest + this.count) % this.capacity];
      this.count++;
    } else {
      slot = this.slots[this.oldest];
      this.oldest = (this.oldest + 1) % this.capacity;
    }
    slot.t = t; slot.x = x; slot.y = y;
  }

  /** Chronological access: 0 is the oldest sample. The view is only valid until the next push. */
  at(index: number): TimedPoint {
    return this.slots[(this.oldest + index) % this.capacity];
  }

  /** The same history in a ring of another capacity, keeping the newest samples that fit. */
  resized(capacity: number): SampleRing {
    const next = new SampleRing(capacity);
    for (let i = Math.max(0, this.count - capacity); i < this.count; i++) {
      const p = this.at(i);
      next.push(p.t, p.x, p.y);
    }
    return next;
  }
}

/**
 * Ring size for a configuration: the longest look-back window, plus the stroke, at the highest
 * rate the configured sample spacing lets through (never below RING_RATE_HZ).
 */
export function ringCapacity(config: YoyoConfig): number {
  const { launch, tug, perception } = config;
  const longest = Math.max(launch.stillWindowMs, launch.windupWindowMs, tug.stillBeforeMs, tug.calmWindowMs);
  const rate = Math.min(RING_MAX_RATE_HZ, Math.max(RING_RATE_HZ, 1000 / Math.max(1, perception.minSampleSpacingMs)));
  return Math.ceil(((longest + RING_EXTRA_MS) * rate) / 1000) + RING_EXTRA_SLOTS;
}

/** Angle in degrees between the vector (dx, along) and the axis it is meant to follow; along must be positive. */
function angleFromAxis(dx: number, along: number): number {
  return (Math.atan2(Math.abs(dx), along) * 180) / Math.PI;
}

/**
 * How «≥ minDownSpeed sustained over sustainFrames frames» (PRD §4.4) is read on noisy samples.
 *
 * - `strict`: every one of the last `sustainFrames` intervals has vy ≥ minDownSpeed. The literal
 *   reading. A single interval carries ±0.28 ih/s of jitter (σ = 0.5 % of the width over 33 ms),
 *   so a true 1.4 ih/s stroke fails it 42 % of the time at any given sample, and it is then
 *   detected a frame late or not at all.
 * - `mean`: the mean vy over the last `sustainFrames` intervals ≥ minDownSpeed, the latest interval
 *   ≥ minDownSpeed (still fast now) and no interval in the window below 0.6 × minDownSpeed (no
 *   stall). The same speed over the same duration, averaged instead of tested interval by
 *   interval, so jitter shrinks by √sustainFrames. Everything `strict` accepts, `mean` accepts.
 *
 * Measured on the seeded corpus (seed 20261001; `pnpm test:yoyo:replays` prints the live table):
 * `mean` raises launch recall (96.0 → 98.0 %) and cuts latency (p50 2 → 1 frames, max 4 → 3, 4
 * detections over the bound instead of 6), with 0 launch triggers on long clips under both readings.
 * But its maximum latency stays at 3 frames, above the 2 the adoption rule demands, it fires 2
 * launches on consistent non-events (`strict`: 0), and it multiplies launch triggers on the casual
 * stress set (4 → 11). On Luis's real recording (2026-10-01) it does worse than `strict` too, 15 and
 * 13 of the 19 throws (seated, standing) against 17 and 16, since the stretched intervals of his
 * dropped frames are read by span (see framesSpanned, detectLaunch) rather than by averaging. So
 * `strict` stays the default (`DEFAULT_LAUNCH_READING`); `mean` is selectable for comparison.
 */
export type LaunchReading = 'strict' | 'mean';

export const DEFAULT_LAUNCH_READING: LaunchReading = 'strict';

export interface ClassifierOptions {
  launchReading?: LaunchReading;
}

/** An interval of a `mean`-reading stroke may not stall below this share of launch.minDownSpeed. */
const MEAN_READING_FLOOR = 0.6;

/**
 * Decides, from raw 30 fps samples in image space, whether the hand just launched or tugged.
 * It looks at the hand, never at the simulated string, and never at smoothed positions: a
 * filter would add exactly the lag the gesture has to beat (PRD §4.4).
 *
 * Both detectors fire on the sample whose arrival made the gesture certain, never later, and
 * never across a discontinuity: the history is dropped on every `continuous: false` sample.
 * Time only comes from sample timestamps, so a replay behaves like the live camera.
 *
 * «Frames» in the config (sustainFrames, maxFrames) and the «two frames before» of the tug
 * conditions count samples, as the PRD does at its 30 fps: samples closer than
 * perception.minSampleSpacingMs are dropped, so a faster source (a 60 Hz pointer) is thinned to
 * the rate the thresholds mean.
 *
 * Every threshold, the extra tug evidence included, lives in YoyoConfig and is read on every
 * sample, so `setConfig` applies live.
 */
export class IntentClassifier implements IntentClassifierLike {
  private config: YoyoConfig;
  private ring: SampleRing;
  private lastFireMs = -Infinity;
  private readonly reading: LaunchReading;
  /** Chronological access through the current ring (the ring is replaced when the config resizes it). */
  private readonly at = (index: number): TimedPoint => this.ring.at(index);

  constructor(config: YoyoConfig, options: ClassifierOptions = {}) {
    this.config = config;
    this.reading = options.launchReading ?? DEFAULT_LAUNCH_READING;
    this.ring = new SampleRing(ringCapacity(config));
  }

  /** Live tuning: thresholds apply from the next sample, history is kept (resized if needed). */
  setConfig(config: YoyoConfig) {
    this.config = config;
    const capacity = ringCapacity(config);
    if (capacity !== this.ring.capacity) this.ring = this.ring.resized(capacity);
  }

  /** Forget history and the refractory period: pause, recalibration. */
  reset() {
    this.ring.clear();
    this.lastFireMs = -Infinity;
  }

  /**
   * The tracked hand vanished. A hard throw often carries it out through the bottom edge before
   * a second fast interval exists, so a launch that was underway completes here: the hand left
   * through the bottom, the latest interval is fast (≥ minDownSpeed), points down within
   * launch.maxAngleDeg, and the usual preconditions hold (quiet or wind-up before it). The event
   * carries the absence's timestamps. The refractory timer is kept, so a hand that comes back
   * cannot double-fire, and a launch that fires here also ends the history.
   *
   * Otherwise the history survives a short absence. A fast stroke blurs the hand and the tracker
   * loses it for one to four frames (10 of Luis's 19 throws); if it comes back within
   * perception.strokeGapMs the stroke goes on, and clearing here would throw away exactly the
   * wind-up and first fast interval it needs. Whether the hand that returns continues the history is
   * decided by the extractor's continuity flag on its first sample (`push` clears on `continuous:
   * false`); an absence that outlasts perception.strokeGapMs clears it here, since nothing can follow it.
   * This is called on every frame without the hand, so a long absence gets there one frame at a time.
   */
  absent(timestampMs: number, arrivalMs: number, exitEdge: FrameEdge | undefined, armed: ArmedIntents): IntentEvent | null {
    const event = exitEdge === 'bottom' && armed.launch ? this.launchOnExit(timestampMs, arrivalMs) : null;
    if (event) {
      this.lastFireMs = event.timestampMs;
      this.ring.clear();
    } else {
      const n = this.ring.length;
      if (n === 0 || timestampMs - this.at(n - 1).t > this.config.perception.strokeGapMs) this.ring.clear();
    }
    return event;
  }

  push(sample: AnchorSample, armed: ArmedIntents): IntentEvent | null {
    // Nobody differences across a break in continuity: start a fresh history. Neither can a
    // sample that is not a number be part of one; it would poison every window it entered.
    if (!sample.continuous || !Number.isFinite(sample.timestampMs + sample.x + sample.y)) this.ring.clear();
    if (!Number.isFinite(sample.timestampMs + sample.x + sample.y)) return null;
    const n = this.ring.length;
    // Out of order, duplicated, or closer than a camera frame to the last kept sample: not for us.
    if (n > 0) {
      const gapMs = sample.timestampMs - this.at(n - 1).t;
      if (!(gapMs > 0 && gapMs >= this.config.perception.minSampleSpacingMs)) return null;
    }
    this.ring.push(sample.timestampMs, sample.x, sample.y);

    if (!armed.launch && !armed.tug) return null;
    // Old data may inform the history but must never trigger anything (PRD §4.1).
    if (sample.arrivalMs - sample.timestampMs > this.config.perception.staleMs) return null;
    if (sample.timestampMs - this.lastFireMs < this.config.refractoryMs) return null;

    const event = (armed.launch ? this.detectLaunch(sample) : null) ?? (armed.tug ? this.detectTug(sample) : null);
    if (event) this.lastFireMs = event.timestampMs;
    return event;
  }

  /** Velocity between samples i−1 and i, using their real timestamps so dropped frames are harmless. */
  private interval(i: number): { vx: number; vy: number } {
    const a = this.at(i - 1), b = this.at(i);
    const seconds = (b.t - a.t) / 1000;
    return { vx: (b.x - a.x) / seconds, vy: (b.y - a.y) / seconds };
  }

  /**
   * The window of samples that ends at `end` and reaches back `windowMs`, or null when the
   * history does not cover it properly (right after a discontinuity there is nothing to judge).
   */
  private windowEndingAt(end: number, windowMs: number): { from: number; to: number } | null {
    const tEnd = this.at(end).t;
    const from = firstIndexAtOrAfter(this.at, 0, end, tEnd - windowMs);
    if (end - from + 1 < MIN_STILL_POINTS) return null;
    if (tEnd - this.at(from).t < windowMs * STILL_COVERAGE) return null;
    return { from, to: end + 1 };
  }

  /**
   * Was the hand quiet (robust speed below `speedLimit` over `windowMs`) just before sample
   * `start`? The window may end up to launch.stillEndSlack samples earlier, so the
   * acceleration phase of the stroke itself does not count against the hand. Not more than that:
   * every extra sample of slack lets the slow first 100 ms of a casual sweep pass as «quiet».
   */
  private wasStill(start: number, windowMs: number, speedLimit: number): boolean {
    const maxSlack = Math.max(0, Math.floor(this.config.launch.stillEndSlack));
    for (let slack = 0; slack <= maxSlack; slack++) {
      const end = start - slack;
      if (end < 0) return false;
      const window = this.windowEndingAt(end, windowMs);
      if (!window) continue;
      const fit = fitLine(this.at, window.from, window.to);
      if (fit && Math.hypot(fit.vx, fit.vy) < speedLimit) return true;
    }
    return false;
  }

  /** Height of sample i averaged with its neighbours: a third of the noise, for judging a small rise. */
  private smoothedY(i: number): number {
    return (this.at(i - 1).y + this.at(i).y + this.at(i + 1).y) / 3;
  }

  /**
   * An upward preparation right before the stroke: the hand rose between windupMinUp and
   * windupMaxUp, in a line within windupMaxAngleDeg of vertical, within windupWindowMs, and
   * turned round at the top. Two readings of where the top is, the first that holds wins:
   *
   * - The top is the highest point among the last few samples before the stroke, since the descent
   *   has begun. A stroke that sets off from the apex at once.
   * - Or the highest point of the last WINDUP_TOP_WINDOW_MS: a slow start. Luis's throws take up to
   *   233 ms to go from the apex to the launch speed, so the first reading would take a point of the
   *   slope for the top, and measure a rise too small and a line too slanted. This one is held to a
   *   condition the first does not need: the stroke starts no further below the top than the
   *   wind-up rose (see WINDUP_DROP_SHARE), or any arc that begins slowly would pass for a throw.
   *
   * Either way the top must be the highest point of the whole window (WINDUP_APEX_TOLERANCE), and the
   * hand must be turning round there, not sweeping across it: windupApexFraction says it slows down
   * (the slower interval next to the top), windupSweepSpeed that it does not go sideways at speed
   * (the two intervals next to the top, on average). The upper limit of the rise, 0.5 ih, no longer
   * tells a throw from a casual arc (both rise 0.4 ih), these two do: an arc passes its top at the
   * speed of the arc, 0.8–1.4 ih/s sideways in the synthetic corpus, a throw at 0.0–0.7 in Luis's.
   *
   * Heights are 3-sample means: a single raw sample is ±0.008 ih of jitter, and the
   * highest-versus-lowest comparison of a whole window would inflate a true 0.09 ih rise past
   * a tight limit.
   */
  private hasWindUp(start: number): boolean {
    return this.windUpBefore(start, false) || this.windUpBefore(start, true);
  }

  private windUpBefore(start: number, slowStart: boolean): boolean {
    const { windupMinUp, windupMaxUp, windupWindowMs, windupMaxAngleDeg, windupSweepSpeed, windupApexFraction, minDownSpeed } = this.config.launch;
    const near = Math.max(1, start - WINDUP_TOP_SLACK);
    const earliest = slowStart ? Math.max(1, Math.min(near, firstIndexAtOrAfter(this.at, 1, start, this.at(start).t - WINDUP_TOP_WINDOW_MS))) : near;
    if (slowStart && earliest >= near) return false;
    let top = -1;
    for (let i = earliest; i < start; i++) if (top < 0 || this.smoothedY(i) < this.smoothedY(top)) top = i;
    if (top < 2) return false;
    const apexY = this.smoothedY(top);
    const from = firstIndexAtOrAfter(this.at, 1, top, this.at(top).t - windupWindowMs);
    let origin = -1, rise = 0;
    for (let i = from; i < top; i++) {
      const lift = this.smoothedY(i) - apexY;
      if (lift > rise) { rise = lift; origin = i; }
    }
    if (origin < 0 || rise < windupMinUp || rise > windupMaxUp) return false;
    const windowFrom = firstIndexAtOrAfter(this.at, 1, start, this.at(start).t - windupWindowMs);
    for (let i = windowFrom; i < start; i++) if (apexY - this.smoothedY(i) > WINDUP_APEX_TOLERANCE) return false;
    if (slowStart && this.smoothedY(start) - apexY > WINDUP_DROP_SHARE * rise) return false;
    if (angleFromAxis(this.at(top).x - this.at(origin).x, rise) > windupMaxAngleDeg) return false;
    if ((this.sidewaysSpeedBetween(top - 1, top) + this.sidewaysSpeedBetween(top, top + 1)) / 2 >= windupSweepSpeed) return false;
    return Math.min(this.speedBetween(top - 1, top), this.speedBetween(top, top + 1)) < minDownSpeed * windupApexFraction;
  }

  private sidewaysSpeedBetween(i: number, j: number): number {
    const a = this.at(i), b = this.at(j);
    return Math.abs(b.x - a.x) / ((b.t - a.t) / 1000);
  }

  private speedBetween(i: number, j: number): number {
    const a = this.at(i), b = this.at(j);
    return Math.hypot(b.x - a.x, b.y - a.y) / ((b.t - a.t) / 1000);
  }

  /** Quiet before the stroke, or a small wind-up: what separates a launch from a hand that was already moving. */
  private launchPreconditions(start: number): boolean {
    const { launch } = this.config;
    return this.wasStill(start, launch.stillWindowMs, launch.stillSpeed) || this.hasWindUp(start);
  }

  /** Does the displacement from sample `start` to the newest point down, within launch.maxAngleDeg of vertical? */
  private pointsDown(start: number, n: number): boolean {
    const dx = this.at(n).x - this.at(start).x;
    const dy = this.at(n).y - this.at(start).y;
    return dy > 0 && angleFromAxis(dx, dy) <= this.config.launch.maxAngleDeg;
  }

  /**
   * The run of intervals that ends at sample `end` and covers launch.sustainFrames frames of the
   * 30 fps clock (see framesSpanned: normally that many intervals, fewer when a dropped frame or a
   * blur gap stretched one), if every one of them is a fast descent under the configured reading
   * (see LaunchReading); else null. `start` is the sample before the run, `intervals` how many
   * there are: fewer than launch.sustainFrames means one stretched interval stands for several
   * frames and has no second one to corroborate it.
   */
  private sustainedDescent(end: number): { start: number; peak: number; intervals: number } | null {
    const { minDownSpeed, sustainFrames } = this.config.launch;
    let start = end, frames = 0, peak = 0, lowest = Infinity;
    // Reach back until the run covers the frames asked for, and on to as many intervals as frames if they are fast too: a corroborated stroke.
    while ((frames < sustainFrames || end - start < sustainFrames) && start >= 1) {
      const v = this.interval(start);
      if (this.reading === 'strict' && !(v.vy >= minDownSpeed)) break;
      lowest = Math.min(lowest, v.vy);
      peak = Math.max(peak, Math.hypot(v.vx, v.vy));
      frames += framesSpanned(this.at(start).t - this.at(start - 1).t);
      start--;
    }
    if (frames < sustainFrames) return null;
    if (this.reading === 'mean') {
      const meanVy = (this.at(end).y - this.at(start).y) / ((this.at(end).t - this.at(start).t) / 1000);
      const latest = this.interval(end).vy;
      if (!(meanVy >= minDownSpeed) || !(latest >= minDownSpeed) || !(lowest >= MEAN_READING_FLOOR * minDownSpeed)) return null;
    }
    return { start, peak, intervals: end - start };
  }

  /**
   * One stretched interval is a single observation of the hand, and a tracking glitch is exactly
   * that: one wrong frame that jumps and comes back. A stroke is told from a glitch at both ends of
   * its stretched interval `start`..`end`:
   *
   * - at the end, by the next sample (`newest`): it must still be at least this share of the way
   *   down, not back where it came from;
   * - at the start, by the sample before it: the stroke has to carry the hand away from where it was
   *   resting, not just back from a wrong frame that put `start` above it (a glitch up, then the
   *   hand «falling» back to where it always was, is a stretched fast descent too).
   */
  private isStroke(start: number, end: number, newest: number): boolean {
    const gone = this.at(end).y - this.at(start).y;
    if (!(this.at(newest).y - this.at(start).y >= STRETCHED_HOLD_SHARE * gone)) return false;
    return this.at(end).y - this.at(start - 1).y >= STRETCHED_HOLD_SHARE * gone;
  }

  /**
   * A launch fires on the sample whose arrival made it certain. Two ways to be certain: the newest
   * sample completes a descent of sustainFrames intervals (the PRD's «2 frames», each interval at
   * launch.minDownSpeed), or the sample before it ended a descent that fits in fewer, stretched
   * intervals (a dropped frame, a short absence: a real stroke over 0.2 ih of a 100 ms gap is ONE
   * interval) and the newest sample shows the hand stayed down.
   */
  private detectLaunch(sample: AnchorSample): IntentEvent | null {
    const { launch } = this.config;
    const n = this.ring.length - 1;
    const fire = (peak: number): IntentEvent => ({ kind: 'launch', timestampMs: sample.timestampMs, arrivalMs: sample.arrivalMs, strength: peak });

    const now = this.sustainedDescent(n);
    if (now !== null && now.intervals >= launch.sustainFrames && this.pointsDown(now.start, n) && this.launchPreconditions(now.start)) return fire(now.peak);

    const before = n >= 2 ? this.sustainedDescent(n - 1) : null;
    if (before !== null && before.start >= 1 && before.intervals < launch.sustainFrames && this.isStroke(before.start, n - 1, n)
      && this.pointsDown(before.start, n) && this.launchPreconditions(before.start)) return fire(before.peak);
    return null;
  }

  /**
   * A launch that the hand's exit cut short: the run of fast intervals that ends at the newest
   * sample (at most sustainFrames frames of them; a longer one would have fired already) is the stroke.
   */
  private launchOnExit(timestampMs: number, arrivalMs: number): IntentEvent | null {
    const { launch, perception, refractoryMs } = this.config;
    const n = this.ring.length - 1;
    if (n < 1) return null;
    if (arrivalMs - timestampMs > perception.staleMs || timestampMs - this.lastFireMs < refractoryMs) return null;
    // The stroke must be happening now, not a hand that stopped moving a while before it vanished.
    if (timestampMs - this.at(n).t > perception.maxGapMs) return null;

    let run = 0, frames = 0, peak = 0;
    for (let i = n; i >= 1 && frames < launch.sustainFrames; i--, run++) {
      const v = this.interval(i);
      if (!(v.vy >= launch.minDownSpeed)) break;
      peak = Math.max(peak, Math.hypot(v.vx, v.vy));
      frames += framesSpanned(this.at(i).t - this.at(i - 1).t);
    }
    if (run === 0) return null;
    const start = n - run;
    if (!this.pointsDown(start, n) || !this.launchPreconditions(start)) return null;
    return { kind: 'launch', timestampMs, arrivalMs, strength: peak };
  }

  /**
   * Position the quiet hand sat at just before sample `start`, or null if it was not quiet. Quiet
   * means the PRD's condition (robust speed below tug.stillSpeed over tug.stillBeforeMs), no
   * upward drift beyond tug.longUpVy over that window, and over the last tug.calmWindowMs no
   * upward drift beyond tug.calmUpVy nor downward beyond tug.calmDownVy; all ending at `start`
   * itself: a flick has no «acceleration phase» to forgive, the first sample that has moved is
   * `start`. The baseline is the mean height of the short window: the nearest estimate of where
   * the hand is, with little noise (σ/√n) and little lag, because the hand was calm.
   *
   * Why drift is judged on its own: the PRD's quiet test tolerates 0.35 ih/s in any direction, and
   * a hand drifting up at 0.3 ih/s is three quarters of the way to the 0.04 ih threshold, where
   * jitter finishes the job. Only upward drift looks like the start of a tug, so it gets its own
   * limits (a 200 ms fit is noisier: ±0.044 ih/s, hence the looser limit over the short window
   * than a drift worth rejecting over the long one). A hand swaying sideways (a sleeper's
   * balanceo), or settling downward, can still tug.
   */
  private tugBaseline(start: number): number | null {
    const { tug } = this.config;
    const long = this.windowEndingAt(start, tug.stillBeforeMs);
    const short = this.windowEndingAt(start, tug.calmWindowMs);
    if (!long || !short) return null;
    const longFit = fitLine(this.at, long.from, long.to);
    if (!longFit || Math.hypot(longFit.vx, longFit.vy) >= tug.stillSpeed || -longFit.vy > tug.longUpVy) return null;
    const shortFit = fitLine(this.at, short.from, short.to);
    if (!shortFit || -shortFit.vy > tug.calmUpVy || shortFit.vy > tug.calmDownVy) return null;
    return shortFit.meanY;
  }

  /**
   * Upward flick: ≥ minUpDelta of rise within maxFrames intervals, pointing up, after quiet.
   *
   * Beyond the PRD text. None of it touches a PRD threshold: it asks for more evidence than «0.04 ih
   * in 3 frames after quiet», because jitter (σ ≈ 0.008 ih per sample) and ordinary slow motion
   * (0.4–0.6 ih/s covers 0.04 ih in 3 frames all by itself) satisfy that text far too easily. All of
   * it is needed for «0 false tugs»:
   *
   * - The flick must still be in progress (the latest interval moves up). A noisy sample that
   *   crosses the threshold after the hand has stopped is not a flick, and would fire late.
   * - The hand was not drifting upward before (see tugBaseline), and the rise is also measured
   *   from that calm baseline, which has ~⅓ of a single sample's noise.
   * - The departure is abrupt. The window's first sample must sit within tug.startTolerance of
   *   tug.minUpDelta around the baseline, and so must the sample two frames before the detection
   *   (tug.abruptTolerance): a flick leaves rest abruptly, slow motion has been drifting away for
   *   longer. That also keeps detections fresh (≤ 2 frames after the departure) and so inside Y-S2.
   * - The last three samples climb at tug.minSpeedFactor × the PRD's mean speed (0.4 ih/s with the
   *   defaults, so 0.56 ih/s: 70 % of the 0.8 ih/s flick Y-04 defines). A deliberate flick clears
   *   it; a 0.4 ih/s reposition does not.
   * - It points within tug.angleShare × tug.maxAngleDeg of vertical. The direction of 0.05 ih of
   *   motion is only known to ±11° at this jitter, so a motion 47° off vertical gets past a 45°
   *   limit one time in three; PRD flicks are within 25°.
   * - No single interval exceeds tug.maxStep per reference frame (1/30 s), scaled up for longer
   *   intervals: a one-frame tracking glitch jumps 0.15+ ih in 33 ms, while Luis's real tugs reach
   *   0.124 ih in 33 ms (3.7 ih/s) and 0.25 ih across a 67–133 ms gap where the hand was blurred out.
   *   A fixed per-interval cap rejected those (second real replay, 2026-10-01).
   */
  private detectTug(sample: AnchorSample): IntentEvent | null {
    const { tug } = this.config;
    const n = this.ring.length - 1;
    if (n < 2 || !(this.interval(n).vy < 0)) return null;
    const recent = fitLine(this.at, n - 2, n + 1);
    const minSpeed = (tug.minSpeedFactor * tug.minUpDelta * REFERENCE_FRAME_RATE_HZ) / tug.maxFrames;
    if (!recent || -recent.vy < minSpeed) return null;

    for (let k = 1; k <= Math.min(tug.maxFrames, n); k++) {
      const start = n - k;
      const rise = this.at(start).y - this.at(n).y;
      if (rise < tug.minUpDelta) continue;
      if (angleFromAxis(this.at(n).x - this.at(start).x, rise) > tug.maxAngleDeg * tug.angleShare) continue;

      let peak = 0, plausible = true;
      for (let i = start + 1; i <= n; i++) {
        const v = this.interval(i);
        peak = Math.max(peak, Math.hypot(v.vx, v.vy));
        const frames = Math.max(1, ((this.at(i).t - this.at(i - 1).t) * REFERENCE_FRAME_RATE_HZ) / 1000);
        if (Math.hypot(this.at(i).x - this.at(i - 1).x, this.at(i).y - this.at(i - 1).y) > tug.maxStep * frames) plausible = false;
      }
      if (!plausible) continue;

      const baseline = this.tugBaseline(start);
      if (baseline === null) continue;
      if (Math.abs(baseline - this.at(start).y) > tug.minUpDelta * tug.startTolerance) continue;
      if (baseline - this.at(n).y < tug.minUpDelta) continue;
      if (baseline - this.at(n - 2).y > tug.minUpDelta * tug.abruptTolerance) continue;
      return { kind: 'tug', timestampMs: sample.timestampMs, arrivalMs: sample.arrivalMs, strength: peak };
    }
    return null;
  }
}
