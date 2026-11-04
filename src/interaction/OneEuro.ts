/**
 * 1€ filter (Casiez, Roussel & Vogel, CHI 2012) over a fixed-length vector: a low-pass whose
 * cutoff rises with speed. Still hands are smoothed hard (no jitter), fast motion passes
 * through with little lag. The standard filter for MediaPipe landmarks.
 */
export class OneEuroFilter {
  private value?: Float64Array;
  private derivative: Float64Array;
  private lastMs = 0;

  /**
   * @param minCutoff Hz of smoothing at rest; lower = steadier.
   * @param beta Hz added per unit/s of speed; higher = less lag when moving.
   * @param derivativeCutoff Hz used to smooth the speed estimate itself.
   */
  constructor(readonly size: number, private minCutoff: number, private beta: number, private derivativeCutoff = 1) {
    this.derivative = new Float64Array(size);
  }

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Filters `input` in place-free fashion and returns the filtered vector (owned by the filter). */
  filter(input: ArrayLike<number>, timestampMs: number): Float64Array {
    if (!this.value) {
      this.value = Float64Array.from(input);
      this.lastMs = timestampMs;
      return this.value;
    }
    const dt = Math.max(1 / 240, (timestampMs - this.lastMs) / 1000);
    this.lastMs = timestampMs;
    const derivativeAlpha = OneEuroFilter.alpha(this.derivativeCutoff, dt);
    // One cutoff for the whole vector, driven by its fastest component: a hand moves as a whole,
    // and per-coordinate cutoffs would let fingers lag their own palm.
    let speed = 0;
    for (let i = 0; i < this.size; i++) {
      const raw = (input[i] - this.value[i]) / dt;
      this.derivative[i] += (raw - this.derivative[i]) * derivativeAlpha;
      speed = Math.max(speed, Math.abs(this.derivative[i]));
    }
    const alpha = OneEuroFilter.alpha(this.minCutoff + this.beta * speed, dt);
    for (let i = 0; i < this.size; i++) this.value[i] += (input[i] - this.value[i]) * alpha;
    return this.value;
  }
}
