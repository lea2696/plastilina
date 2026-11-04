/**
 * Fixed-size window over the newest samples with percentile queries (diagnostics: frame interval,
 * physics and render cost, reaction latency, capture→arrival delay).
 *
 * Why a ring and not an array: the page runs for hours and these are pushed every frame, so memory
 * must be the same at minute one and at hour three, and a push must not allocate. Percentiles are
 * only asked for a few times per second while the diagnostics panel is open, so sorting a copy
 * of at most `capacity` numbers then is cheap.
 */
export class RollingWindow {
  private readonly values: Float64Array;
  private readonly sorted: Float64Array;
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.values = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  /** Samples currently held, never more than `capacity`. */
  get count(): number {
    return this.size;
  }

  /** The newest sample, NaN when empty. */
  get latest(): number {
    return this.size === 0 ? Number.NaN : this.values[(this.head - 1 + this.capacity) % this.capacity];
  }

  /**
   * Adds a sample, dropping the oldest when full. Non-finite values are ignored: a NaN would
   * poison every percentile until it scrolled out, and none of the measured quantities can be NaN.
   */
  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /**
   * Nearest-rank percentile, `q` in [0, 1] (the same definition replay/evaluate.ts reports, so
   * numbers from the app and from the QA scripts are comparable). NaN when there is nothing to rank.
   */
  percentile(q: number): number {
    const n = this.size;
    if (n === 0 || !Number.isFinite(q)) return Number.NaN;
    const copy = this.sorted.subarray(0, n);
    // While the ring has not wrapped its samples are values[0..n); once wrapped it is all of it, in rotated order (order is irrelevant to a rank).
    copy.set(n === this.capacity ? this.values : this.values.subarray(0, n));
    copy.sort();
    return copy[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
  }
}

/**
 * Frames per second over consecutive windows of `windowMs`. It reports the last completed window
 * rather than an instantaneous 1/Δt, which would jump around with every frame's jitter.
 */
export class FpsMeter {
  private windowStart = Number.NaN;
  private frames = 0;
  private value = 0;

  constructor(private readonly windowMs = 1000) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be positive');
  }

  /** Frames per second of the last completed window; 0 until the first one ends. */
  get fps(): number {
    return this.value;
  }

  /** Counts one rendered frame at `nowMs` and returns the current estimate. */
  tick(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return this.value;
    if (Number.isNaN(this.windowStart)) {
      this.windowStart = nowMs;
      return this.value;
    }
    this.frames++;
    const elapsed = nowMs - this.windowStart;
    if (elapsed >= this.windowMs) {
      this.value = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.windowStart = nowMs;
    }
    return this.value;
  }

  /** Starts over, e.g. after the tab was hidden and the gap would read as a dip to 0 fps. */
  reset(): void {
    this.windowStart = Number.NaN;
    this.frames = 0;
    this.value = 0;
  }
}

/** Rounds to `digits` decimals; null for NaN and ±Infinity so the value survives JSON (which would write null anyway, but silently). */
export function roundOrNull(value: number, digits = 1): number | null {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
