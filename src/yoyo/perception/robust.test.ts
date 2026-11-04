import { describe, it, expect } from 'vitest';
import { Random } from '../replay/random';
import { firstIndexAtOrAfter, leastSquaresVelocity, MIN_FIT_POINTS, robustSpeed, windowSpread, type TimedPoint } from './robust';

const FRAME_MS = 1000 / 30;

/** Points on a straight line at constant velocity, `n` frames long, starting at t0. */
function line(n: number, vx: number, vy: number, t0 = 0): TimedPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = t0 + i * FRAME_MS;
    return { t, x: 0.5 + (vx * (t - t0)) / 1000, y: 0.4 + (vy * (t - t0)) / 1000 };
  });
}

const view = (pts: TimedPoint[]) => (i: number) => pts[i];

describe('leastSquaresVelocity', () => {
  it('recovers the exact velocity of a noiseless line', () => {
    const pts = line(9, 0.6, -1.4);
    const v = leastSquaresVelocity(view(pts), 0, pts.length);
    expect(v).not.toBeNull();
    expect(v!.vx).toBeCloseTo(0.6, 9);
    expect(v!.vy).toBeCloseTo(-1.4, 9);
  });

  it('is unaffected by huge timestamps and by a sub-range', () => {
    const pts = line(12, 0.2, 0.9, 7_200_000);
    const v = leastSquaresVelocity(view(pts), 3, 11);
    expect(v!.vx).toBeCloseTo(0.2, 6);
    expect(v!.vy).toBeCloseTo(0.9, 6);
  });

  it('handles unevenly spaced timestamps (dropped frames)', () => {
    const pts = line(10, 0.3, 0.3).filter((_, i) => i !== 3 && i !== 4 && i !== 7);
    const v = leastSquaresVelocity(view(pts), 0, pts.length);
    expect(v!.vx).toBeCloseTo(0.3, 9);
    expect(v!.vy).toBeCloseTo(0.3, 9);
  });

  it('refuses windows too short or degenerate to fit', () => {
    const pts = line(MIN_FIT_POINTS - 1, 1, 1);
    expect(leastSquaresVelocity(view(pts), 0, pts.length)).toBeNull();
    const same: TimedPoint[] = [{ t: 5, x: 0, y: 0 }, { t: 5, x: 1, y: 1 }, { t: 5, x: 2, y: 2 }];
    expect(leastSquaresVelocity(view(same), 0, 3)).toBeNull();
  });
});

describe('robustSpeed', () => {
  it('is the magnitude of the fitted velocity and Infinity without a fit', () => {
    const pts = line(9, 0.3, 0.4);
    expect(robustSpeed(view(pts), 0, pts.length)).toBeCloseTo(0.5, 9);
    expect(robustSpeed(view(pts), 0, 2)).toBe(Infinity);
  });

  it('turns PRD-level jitter into a testable stillness statistic', () => {
    // σ = 0.5 % of the image width: 0.005 · 4/3 ih per axis. Frame-to-frame velocity of a still
    // hand is then ≈ 0.28 ih/s (hopeless against «< 0.1 ih/s»), the 250 ms fit is not.
    const rng = new Random(11);
    const sigma = 0.005 * (4 / 3);
    const pts: TimedPoint[] = Array.from({ length: 3000 }, (_, i) => ({ t: i * FRAME_MS, x: 0.7 + rng.gaussian(0, sigma), y: 0.5 + rng.gaussian(0, sigma) }));
    const window = 8;
    let slow = 0, windows = 0, pairFast = 0;
    for (let end = window; end <= pts.length; end++) {
      windows++;
      if (robustSpeed(view(pts), end - window, end) < 0.1) slow++;
      const a = pts[end - 1], b = pts[end - 2];
      if (Math.hypot(a.x - b.x, a.y - b.y) / ((a.t - b.t) / 1000) >= 0.1) pairFast++;
    }
    expect(slow / windows).toBeGreaterThan(0.98);
    expect(pairFast / windows).toBeGreaterThan(0.6);
  });

  it('is large for a real movement inside the window', () => {
    const pts = line(8, 0, 0.5);
    expect(robustSpeed(view(pts), 0, 8)).toBeGreaterThan(0.45);
  });
});

describe('windowSpread', () => {
  it('is the largest distance from the centroid', () => {
    const pts: TimedPoint[] = [
      { t: 0, x: 0, y: 0 }, { t: 33, x: 2, y: 0 }, { t: 66, x: 1, y: 0 },
    ];
    expect(windowSpread(view(pts), 0, 3)).toBeCloseTo(1, 9);
    expect(windowSpread(view(pts), 0, 0)).toBe(Infinity);
  });

  it('sees a hand that wanders and returns even though its slope is ~0', () => {
    const pts: TimedPoint[] = [0, 1, 2, 3, 4, 5, 6].map(i => ({ t: i * FRAME_MS, x: 0.5, y: 0.5 + 0.1 * Math.sin((i / 6) * Math.PI) * (i === 3 ? 1 : 0) }));
    expect(robustSpeed(view(pts), 0, pts.length)).toBeLessThan(0.1);
    expect(windowSpread(view(pts), 0, pts.length)).toBeGreaterThan(0.08);
  });
});

describe('firstIndexAtOrAfter', () => {
  const pts = line(10, 0, 0);
  it('finds the first point not before t, or one past the end', () => {
    expect(firstIndexAtOrAfter(view(pts), 0, 9, 0)).toBe(0);
    expect(firstIndexAtOrAfter(view(pts), 0, 9, FRAME_MS * 4 + 0.1)).toBe(5);
    expect(firstIndexAtOrAfter(view(pts), 0, 9, 1e9)).toBe(10);
    expect(firstIndexAtOrAfter(view(pts), 3, 9, -5)).toBe(3);
  });
});
