/**
 * String tension → colour (PRD §6: «tinte por tensión»).
 *
 * The model reports the tension of the LAST physics step of a frame, and a snap or a tug makes that a
 * single step of tens of newtons. Mapping it directly would flash the string white-hot for 4 ms and then
 * nothing. So the raw value is clamped (a spike cannot exceed what the tint can show anyway), low-passed
 * with a ~40 ms time constant, and only then mapped through a smoothstep to 0..1.
 */

/** Low-pass time constant, ms: long enough to swallow a single-step spike, short enough to follow a tug. */
export const TENSION_TAU_MS = 40;
/** Raw tension is clamped here, N, before filtering: the hanging yoyo weighs 0.6 N, a hard snap tens of N. */
export const TENSION_CLAMP_N = 8;
/** The tint starts above TENSION_FROM_N and is fully warm at TENSION_FULL_N (filtered), N. */
export const TENSION_FROM_N = 0.3;
export const TENSION_FULL_N = 6;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Maps a filtered tension (N) to the tint amount 0..1 (0 neutral, 1 warm). */
export function tensionTintAmount(filteredN: number): number {
  return smoothstep(TENSION_FROM_N, TENSION_FULL_N, filteredN);
}

export class TensionTint {
  /** Clamped, low-passed tension, N. */
  filtered = 0;

  /** Feed the snapshot's raw tension and the time since the last frame; returns the tint amount 0..1. */
  step(rawN: number, dtMs: number): number {
    // Negative or non-finite tension is no tension: a slack string pulls with nothing.
    const clamped = Number.isFinite(rawN) ? Math.min(TENSION_CLAMP_N, Math.max(0, rawN)) : 0;
    const alpha = Number.isFinite(dtMs) && dtMs > 0 ? 1 - Math.exp(-dtMs / TENSION_TAU_MS) : 0;
    this.filtered += (clamped - this.filtered) * alpha;
    return tensionTintAmount(this.filtered);
  }

  reset(): void {
    this.filtered = 0;
  }
}
