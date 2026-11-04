import { OneEuroFilter } from '../../interaction/OneEuro';
import type { YoyoConfig } from '../config';
import type { PinState } from '../contracts';

/** One anchor target, already mapped to world metres. */
export interface PinSample {
  x: number;
  y: number;
  /** Capture time of the frame or pointer sample. */
  timestampMs: number;
  /** When the app received it (capture + tracking latency). */
  arrivalMs: number;
  /** False when it does not continue the previous sample (first, identity change, jump, gap). */
  continuous: boolean;
}

/**
 * Cap on the filtered velocity that feeds the extrapolation, m/s. A finite difference of two
 * outputs 1 ms apart is mostly numerical noise; without a cap one such pair would shoot the
 * target metres ahead. Above any real hand speed (launch strokes reach ~3 m/s).
 */
const MAX_FILTERED_SPEED = 4;

/**
 * Longest step the spring is integrated in one go, s. The runtime always steps at 1/240; this only
 * protects the semi-implicit Euler spring (stable while ω·dt < ~1) from a stray huge dt, which
 * would otherwise fling the pivot away.
 */
const MAX_STEP_S = 1 / 120;

/** Recovery is over once the pivot is this close to its target, m. */
const RECOVERY_CONVERGED_M = 0.01;
/**
 * After the hold the speed cap eases off over this long, ms, instead of vanishing: the feed-forward
 * comes back with it. A pivot that was kept behind a moving hand would otherwise leap the moment the
 * cap lifted.
 */
const RELEASE_RAMP_MS = 150;
/** At the end of the ease-off the cap has grown to this multiple of its holding value; then it is dropped. */
const RELEASE_CAP_FACTOR = 4;

/** Recovery after a gap or discontinuity: the cap holds, eases off, and is gone. */
type Recovery = 'none' | 'holding' | 'releasing';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Turns the noisy, late, 30 Hz anchor samples into a pivot the physics can trust (PRD §4.2).
 *
 * Three stages, each answering one problem:
 * 1. A 1€ filter on the samples at their capture times removes tracking jitter while the hand is
 *    still and lets fast strokes through.
 * 2. A bounded, decaying extrapolation from the last arrival hides part of the tracking latency
 *    without ever running away if the data stops.
 * 3. A critically damped spring with velocity feed-forward turns that stepwise target (it jumps at
 *    every arrival) into smooth motion. Nothing rigid ever sees raw or extrapolated data.
 *
 * Data that is too old applies no force: the pivot freezes with exactly zero velocity. The first
 * sample after a freeze or a discontinuity restarts the filter at the new place (no blending from
 * the old one) and the pivot glides there at a capped speed, so recovering a hand never teleports.
 * The cap is relative to the hand: the pivot may move at the hand's own filtered speed plus
 * recoverSpeed, so a hand that reappears moving fast is chased at a bounded closing speed instead of
 * being left behind and then leapt at once the cap lifts. It holds until the pivot has caught up with
 * its target (or a maximum time has passed) and then eases off over 150 ms.
 *
 * Responsiveness is set by config.pin, not by this class; PinStabilizer.test.ts states what the
 * shipped tuning achieves and why the PRD's design cannot reach a lower lag.
 *
 * Deterministic: time only enters through arguments; no clocks, no randomness.
 */
export class PinStabilizer {
  /** The pivot handed to the physics. One object, mutated in place by `step`. */
  readonly state: PinState = { x: 0, y: 0, vx: 0, vy: 0 };

  private config: YoyoConfig;
  private filter: OneEuroFilter;
  private readonly input = new Float64Array(2);
  /** Filtered position and velocity as of the last accepted sample (p_f, v_f). */
  private readonly filteredState: PinState = { x: 0, y: 0, vx: 0, vy: 0 };
  private hasSample = false;
  private lastTimestampMs = 0;
  private lastArrivalMs = 0;
  /** A step found the data stale. The next sample must restart instead of continuing. */
  private frozen = false;
  private recovery: Recovery = 'none';
  /** The hold ends by this time even if the pivot never caught up (a hand faster than the cap). */
  private holdUntilMs = 0;
  private releaseStartMs = 0;
  private lastStepFresh = false;

  constructor(config: YoyoConfig) {
    this.config = config;
    this.filter = this.createFilter();
    this.reset();
  }

  /** Last step used data younger than perception.staleMs. False before any sample and while frozen. */
  get fresh(): boolean {
    return this.lastStepFresh;
  }

  /** Filtered anchor (p_f) and its finite-difference velocity (v_f), for diagnostics and tests. Read only. */
  get filtered(): Readonly<PinState> {
    return this.filteredState;
  }

  /** True from a restart until the speed cap has fully eased off. */
  get recovering(): boolean {
    return this.recovery !== 'none';
  }

  /**
   * Applies new tunables. The 1€ filter has no setters, so it is rebuilt and re-seeded at the
   * current filtered position: the pivot keeps going instead of jumping to the next raw sample.
   */
  setConfig(config: YoyoConfig): void {
    this.config = config;
    this.filter = this.createFilter();
    if (this.hasSample) {
      this.input[0] = this.filteredState.x;
      this.input[1] = this.filteredState.y;
      this.filter.filter(this.input, this.lastTimestampMs);
    }
  }

  /**
   * Forgets every sample and puts the pivot at `at` (default: the world home) at rest. Used when
   * the yoyo ties on, on pause and on recalibration. The next sample restarts the filter.
   */
  reset(at?: PinState): void {
    this.filter = this.createFilter();
    this.hasSample = false;
    this.frozen = false;
    this.recovery = 'none';
    this.lastStepFresh = false;
    const s = this.state;
    s.x = at?.x ?? this.config.world.homeX;
    s.y = at?.y ?? this.config.world.homeY;
    s.vx = at?.vx ?? 0;
    s.vy = at?.vy ?? 0;
  }

  /** Accepts a new target. Samples with non-finite numbers, or that run time backwards inside a continuous run, are dropped. */
  push(sample: PinSample): void {
    if (!Number.isFinite(sample.x + sample.y + sample.timestampMs + sample.arrivalMs)) return;
    if (this.mustRestart(sample)) {
      this.restart(sample);
    } else if (sample.timestampMs > this.lastTimestampMs) {
      this.follow(sample);
    } else {
      return;
    }
    this.hasSample = true;
    this.lastTimestampMs = sample.timestampMs;
    this.lastArrivalMs = sample.arrivalMs;
  }

  /** Advances the pivot to `timeMs` (simulation clock). Returns the reused state object. */
  step(dt: number, timeMs: number): PinState {
    const s = this.state;
    if (!this.hasSample) {
      this.lastStepFresh = false;
      return s;
    }
    if (timeMs - this.lastTimestampMs > this.config.perception.staleMs) {
      // Old data applies no force: hold the position and report zero velocity, exactly.
      this.lastStepFresh = false;
      this.frozen = true;
      s.vx = 0;
      s.vy = 0;
      return s;
    }
    this.lastStepFresh = true;
    if (dt > 0) this.integrate(Math.min(dt, MAX_STEP_S), timeMs);
    return s;
  }

  private createFilter(): OneEuroFilter {
    const { minCutoff, beta, derivativeCutoff } = this.config.pin;
    return new OneEuroFilter(2, minCutoff, beta, derivativeCutoff);
  }

  /**
   * A sample restarts the filter when it does not continue the last one, when it is the first, or
   * when the pivot already froze for lack of data. The arrival-gap test also catches a stream
   * that stalled for longer than staleMs without anybody stepping in between.
   */
  private mustRestart(sample: PinSample): boolean {
    return !sample.continuous
      || !this.hasSample
      || this.frozen
      || sample.arrivalMs - this.lastTimestampMs > this.config.perception.staleMs;
  }

  /**
   * Reseeds the 1€ filter at the new place and starts (or extends) the capped-speed recovery.
   * The hold lasts at most recoverMs, or twice the time to cross the jump at the capped closing
   * speed if that is longer: a hand that reappears across the whole frame must still be crossed at
   * the cap. It usually ends sooner, as soon as the pivot has caught up (see `advanceRecovery`).
   */
  private restart(sample: PinSample): void {
    this.filter = this.createFilter();
    this.input[0] = sample.x;
    this.input[1] = sample.y;
    this.filter.filter(this.input, sample.timestampMs);
    const f = this.filteredState;
    const { pin } = this.config;
    const jump = Math.hypot(sample.x - this.state.x, sample.y - this.state.y);
    f.x = sample.x;
    f.y = sample.y;
    // Nobody differences across a discontinuity: its velocity is unknown, so it is zero.
    f.vx = 0;
    f.vy = 0;
    this.frozen = false;
    const crossingMs = (jump / pin.recoverSpeed) * 1000;
    const until = sample.arrivalMs + Math.max(pin.recoverMs, 2 * crossingMs);
    this.holdUntilMs = this.recovery === 'holding' ? Math.max(this.holdUntilMs, until) : until;
    this.recovery = 'holding';
  }

  /** Filters a continuous sample and differences the filtered outputs to get v_f. */
  private follow(sample: PinSample): void {
    this.input[0] = sample.x;
    this.input[1] = sample.y;
    const out = this.filter.filter(this.input, sample.timestampMs);
    const f = this.filteredState;
    const dtSeconds = (sample.timestampMs - this.lastTimestampMs) / 1000;
    let vx = (out[0] - f.x) / dtSeconds;
    let vy = (out[1] - f.y) / dtSeconds;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > MAX_FILTERED_SPEED) {
      vx *= MAX_FILTERED_SPEED / speed;
      vy *= MAX_FILTERED_SPEED / speed;
    }
    f.x = out[0];
    f.y = out[1];
    f.vx = vx;
    f.vy = vy;
  }

  /**
   * One spring step toward the extrapolated target.
   *
   * Extrapolation: from the last arrival the target slides ahead along v_f, decaying with time
   * constant τ = extrapolateMs and stopping after τ, so the pivot can lead the data by at most one
   * tracking interval. Once the window is over the target velocity is exactly zero («después,
   * mantener posición»): carrying on with a leftover v_t would park the pivot ahead of its target.
   */
  private integrate(dt: number, timeMs: number): void {
    const { pin } = this.config;
    const s = this.state;
    const f = this.filteredState;
    const tau = pin.extrapolateMs;
    const sinceArrival = timeMs - this.lastArrivalMs;
    const elapsed = clamp(sinceArrival, 0, tau);
    // e^(−h/τ): how much of v_f is left, and how far (of its τ·v_f reach) the target has slid.
    const decay = tau > 0 ? Math.exp(-elapsed / tau) : 1;
    const lead = (tau / 1000) * (1 - decay);
    const targetVelocityShare = tau > 0 && sinceArrival < tau ? decay : 0;
    const targetX = f.x + f.vx * lead;
    const targetY = f.y + f.vy * lead;
    const errorX = targetX - s.x;
    const errorY = targetY - s.y;

    const share = this.advanceRecovery(timeMs, errorX * errorX + errorY * errorY);
    const omega = pin.springOmega;
    // Feed-forward is off while holding (a velocity pushed into a restarted filter is a guess) and
    // comes back with the same ramp that lifts the cap.
    const feedForward = pin.feedForward * share * targetVelocityShare;
    const ax = omega * omega * errorX + 2 * omega * (feedForward * f.vx - s.vx);
    const ay = omega * omega * errorY + 2 * omega * (feedForward * f.vy - s.vy);
    s.vx += ax * dt;
    s.vy += ay * dt;
    if (share < 1) this.capSpeed((Math.hypot(f.vx, f.vy) + pin.recoverSpeed) * (1 + (RELEASE_CAP_FACTOR - 1) * share));
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }

  /**
   * Moves the recovery along and returns how much of normal behaviour is back: 0 while the cap
   * holds, 1 when recovery is over, in between while it eases off.
   *
   * The hold ends once the pivot is within a centimetre of its target (it has caught the hand), or
   * when its maximum time is up (a hand moving fast enough keeps the spring's own lag above a
   * centimetre, so it times out). Lifting the cap at a fixed time instead would let a pivot that was
   * held behind the hand cross the remaining gap at spring speed in a few frames; easing it off over
   * RELEASE_RAMP_MS bounds how fast that can happen.
   */
  private advanceRecovery(timeMs: number, errorSquared: number): number {
    if (this.recovery === 'none') return 1;
    if (this.recovery === 'holding') {
      const converged = errorSquared < RECOVERY_CONVERGED_M * RECOVERY_CONVERGED_M;
      if (!converged && timeMs < this.holdUntilMs) return 0;
      this.recovery = 'releasing';
      this.releaseStartMs = timeMs;
    }
    const share = (timeMs - this.releaseStartMs) / RELEASE_RAMP_MS;
    if (share >= 1) {
      this.recovery = 'none';
      return 1;
    }
    return share;
  }

  /** Scales the pivot's velocity down to `cap` m/s if it is faster, keeping its direction. */
  private capSpeed(cap: number): void {
    const s = this.state;
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    if (speed > cap) {
      s.vx *= cap / speed;
      s.vy *= cap / speed;
    }
  }
}
