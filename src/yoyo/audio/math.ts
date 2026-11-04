/** Small numeric helpers shared by the audio modules. */

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/**
 * Control data comes from a simulation and a tracker. A NaN or an Infinity must degrade to a
 * default here, because `clamp(NaN)` is still NaN and a NaN written to an AudioParam throws.
 */
export const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * xorshift32: tiny, fast and deterministic. The audio code needs decorrelated noise and start
 * offsets, not statistical quality, and it must never touch Math.random: offline renders are
 * QA evidence, so the same input has to give the same samples on every run.
 */
export class Xorshift32 {
  private state: number;

  constructor(seed: number) {
    // xorshift is stuck at 0 forever, so a zero seed is replaced.
    this.state = (seed | 0) || (0x9e3779b9 | 0);
  }

  /** Next float in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return (x >>> 0) / 4294967296;
  }
}
