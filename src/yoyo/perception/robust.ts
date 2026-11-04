/**
 * Window statistics over timed image-space points.
 *
 * Why this file exists: frame-to-frame velocity of a perfectly still hand is mostly noise. With
 * the PRD jitter (σ ≈ 0.5 % of the image width ≈ 0.0067 ih) the difference of two consecutive
 * samples already has σ ≈ 0.0094 ih, i.e. σ ≈ 0.28 ih/s at 30 fps, so «< 0.1 ih/s» is meaningless
 * as an instantaneous velocity. The same noise averaged by a least-squares line over ~250 ms
 * shrinks to σ ≈ 0.03 ih/s per axis, which makes the PRD's quietness threshold testable. Every
 * «still», «relatively still» and «stable» judgement therefore goes through these functions.
 *
 * Pure and deterministic: no clocks, no allocation beyond the returned values.
 */

/** One raw observation: capture time in ms and the mirrored image position in ih. */
export interface TimedPoint {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** Random access to points in chronological order (0 is the oldest). */
export type PointAt = (index: number) => TimedPoint;

/**
 * Fewest points whose fitted slope means anything. Two points always fit a line exactly, so
 * their «slope» is just one noisy difference and says nothing about stillness.
 */
export const MIN_FIT_POINTS = 3;

export interface Velocity {
  /** ih/s */
  readonly vx: number;
  readonly vy: number;
}

/** A least-squares line through a window: its centroid in time and space plus its velocity. */
export interface LineFit extends Velocity {
  readonly meanT: number;
  readonly meanX: number;
  readonly meanY: number;
}

/**
 * Least-squares line through the points `from ≤ i < to`.
 *
 * Time is centred on the window mean before accumulating, which keeps the sums well conditioned
 * for the large timestamps a long session produces. Returns null when there is no usable fit.
 */
export function fitLine(at: PointAt, from: number, to: number): LineFit | null {
  const count = to - from;
  if (count < MIN_FIT_POINTS) return null;
  let meanT = 0, meanX = 0, meanY = 0;
  for (let i = from; i < to; i++) {
    const p = at(i);
    meanT += p.t; meanX += p.x; meanY += p.y;
  }
  meanT /= count; meanX /= count; meanY /= count;
  let stt = 0, stx = 0, sty = 0;
  for (let i = from; i < to; i++) {
    const p = at(i);
    const dt = p.t - meanT;
    stt += dt * dt;
    stx += dt * (p.x - meanX);
    sty += dt * (p.y - meanY);
  }
  if (stt <= 0) return null;
  // ms → s: the slope of ih over ms times 1000 is ih/s.
  return { meanT, meanX, meanY, vx: (stx / stt) * 1000, vy: (sty / stt) * 1000 };
}

/** Where the fitted line says the point is at time `t` (ms); the fit's own noise is lower than any single sample's. */
export function fittedPosition(fit: LineFit, t: number): { x: number; y: number } {
  const dtSeconds = (t - fit.meanT) / 1000;
  return { x: fit.meanX + fit.vx * dtSeconds, y: fit.meanY + fit.vy * dtSeconds };
}

/** Least-squares velocity of the points `from ≤ i < to`, or null without a usable fit. */
export function leastSquaresVelocity(at: PointAt, from: number, to: number): Velocity | null {
  return fitLine(at, from, to);
}

/**
 * Robust speed of a window, ih/s: the magnitude of its least-squares velocity.
 *
 * Returns Infinity when the window has no usable fit. A comparison «speed < limit» then fails
 * safe: no evidence of stillness is never taken as stillness.
 */
export function robustSpeed(at: PointAt, from: number, to: number): number {
  const v = leastSquaresVelocity(at, from, to);
  return v === null ? Infinity : Math.hypot(v.vx, v.vy);
}

/**
 * Spread of a window, ih: the largest distance of any point from the window centroid. Unlike
 * the slope it also catches a hand that wanders and comes back, which is not «estable».
 * Returns Infinity for an empty window.
 */
export function windowSpread(at: PointAt, from: number, to: number): number {
  const count = to - from;
  if (count < 1) return Infinity;
  let cx = 0, cy = 0;
  for (let i = from; i < to; i++) {
    const p = at(i);
    cx += p.x; cy += p.y;
  }
  cx /= count; cy /= count;
  let worst = 0;
  for (let i = from; i < to; i++) {
    const p = at(i);
    worst = Math.max(worst, Math.hypot(p.x - cx, p.y - cy));
  }
  return worst;
}

/**
 * First index in `[lo, hi]` whose time is at least `t`, or hi + 1 when none is. Points are
 * chronological, so a linear scan from the end of a short window beats a binary search.
 */
export function firstIndexAtOrAfter(at: PointAt, lo: number, hi: number, t: number): number {
  let i = hi + 1;
  while (i - 1 >= lo && at(i - 1).t >= t) i--;
  return i;
}
