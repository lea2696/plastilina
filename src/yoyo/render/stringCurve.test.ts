import { describe, expect, it } from 'vitest';
import { SLACK_DEADBAND, SlackSmoother, parabolaBow, sampleString } from './stringCurve';

const POINTS = 42;

function polylineLength(p: number[]): number {
  let total = 0;
  for (let i = 2; i < p.length; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return total;
}

function sample(ax: number, ay: number, bx: number, by: number, length: number, hint = 0, floor = -Infinity): { p: number[]; sign: number } {
  const p = new Array<number>(POINTS * 2).fill(0);
  const sign = sampleString(p, POINTS, ax, ay, bx, by, length, hint, floor);
  return { p, sign };
}

/** Deterministic pseudo-random sequence so a failing case can be reproduced. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('parabolaBow', () => {
  it('is zero for a taut or over-stretched string', () => {
    expect(parabolaBow(0.5, 0.5)).toBe(0);
    expect(parabolaBow(0.5, 0.4)).toBe(0);
  });

  it('matches the small-slack series: h ≈ (d/4)·√(6(ρ − 1))', () => {
    const d = 0.6;
    const rho = 1.001;
    expect(parabolaBow(d, rho * d)).toBeCloseTo((d / 4) * Math.sqrt(6 * (rho - 1)), 4);
  });

  it('grows monotonically with the slack', () => {
    let previous = 0;
    for (let s = 0.51; s <= 0.65; s += 0.01) {
      const h = parabolaBow(0.5, s);
      expect(h).toBeGreaterThan(previous);
      previous = h;
    }
  });

  it('is finite for degenerate input', () => {
    expect(parabolaBow(0, 0.3)).toBeCloseTo(0.15, 12);
    expect(parabolaBow(1e-12, 0.3)).toBeCloseTo(0.15, 12);
    expect(parabolaBow(0.5, 0)).toBe(0);
    expect(parabolaBow(Number.NaN, 0.5)).toBe(0);
    expect(parabolaBow(0.5, Number.POSITIVE_INFINITY)).toBe(0);
    expect(parabolaBow(-1, 0.5)).toBeCloseTo(0.25, 12);
    expect(Number.isFinite(parabolaBow(1e-6, 0.65))).toBe(true);
    // Never more than the fully doubled-back string.
    for (const chord of [1e-6, 1e-3, 0.02, 0.2]) expect(parabolaBow(chord, 0.65)).toBeLessThanOrEqual(0.325 + 1e-12);
  });
});

describe('sampleString', () => {
  it('writes both endpoints exactly', () => {
    const { p } = sample(0.1, 0.85, -0.2, 0.3, 0.7);
    expect(p[0]).toBe(0.1);
    expect(p[1]).toBe(0.85);
    expect(p[2 * (POINTS - 1)]).toBe(-0.2);
    expect(p[2 * (POINTS - 1) + 1]).toBe(0.3);
  });

  it('is a straight, evenly spaced line when taut', () => {
    const { p } = sample(0, 0.85, 0.12, 0.2, 0.66);
    const chord = Math.hypot(0.12, 0.65);
    expect(polylineLength(p)).toBeCloseTo(chord, 9);
    const step = chord / (POINTS - 1);
    for (let i = 2; i < p.length; i += 2) expect(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])).toBeCloseTo(step, 9);
    // Collinear: the cross product of every point (relative to A) with the chord (0.12, −0.65) is zero.
    for (let i = 0; i < POINTS; i++) {
      const cross = p[2 * i] * -0.65 - (p[2 * i + 1] - 0.85) * 0.12;
      expect(Math.abs(cross)).toBeLessThan(1e-12);
    }
  });

  it('slack strings have an arc length within 3 % of the string length (typically far better)', () => {
    const random = lcg(7);
    for (let trial = 0; trial < 600; trial++) {
      const length = 0.05 + random() * 0.6;
      const chord = length * (0.15 + random() * 0.84);
      const angle = random() * Math.PI * 2;
      const ax = (random() - 0.5) * 0.6;
      const ay = 0.3 + random() * 0.6;
      const bx = ax + Math.cos(angle) * chord;
      const by = ay + Math.sin(angle) * chord;
      const { p } = sample(ax, ay, bx, by, length, 1);
      const measured = polylineLength(p);
      expect(Math.abs(measured - length) / length).toBeLessThan(0.03);
      expect(p.every(Number.isFinite)).toBe(true);
    }
  });

  it('is accurate to a fraction of a percent for the cases the game produces', () => {
    for (const [chord, length] of [[0.4, 0.45], [0.55, 0.65], [0.3, 0.65], [0.05, 0.1]] as const) {
      const { p } = sample(0, 0.85, 0.3 * chord, 0.85 - 0.95 * chord, length, 1);
      expect(Math.abs(polylineLength(p) - length) / length).toBeLessThan(0.005);
    }
  });

  it('bows downward for a non-vertical chord and does not rise above the straight line', () => {
    const { p } = sample(-0.2, 0.5, 0.3, 0.5, 0.6);
    const middleY = p[2 * Math.floor(POINTS / 2) + 1];
    expect(middleY).toBeLessThan(0.5);
    for (let i = 0; i < POINTS; i++) expect(p[2 * i + 1]).toBeLessThanOrEqual(0.5 + 1e-12);
  });

  it('keeps a stable side for a vertical chord by honouring the hint', () => {
    const right = sample(0, 0.85, 0, 0.4, 0.6, 1);
    const left = sample(0, 0.85, 0, 0.4, 0.6, -1);
    expect(right.sign).toBe(1);
    expect(left.sign).toBe(-1);
    const mid = Math.floor(POINTS / 2);
    expect(right.p[2 * mid]).toBeGreaterThan(0.01);
    expect(left.p[2 * mid]).toBeLessThan(-0.01);
    // A clearly tilted chord overrides the hint: gravity decides.
    const tilted = sample(0, 0.85, 0.3, 0.4, 0.6, -1);
    expect(tilted.sign).toBe(-1);
    const tiltedOther = sample(0, 0.85, -0.3, 0.4, 0.6, -1);
    expect(tiltedOther.sign).toBe(1);
  });

  it('does not sink under the floor: interior points are clamped, endpoints stay exact', () => {
    const floor = 0.003;
    const { p } = sample(-0.3, 0.05, 0.3, 0.05, 0.9, 1, floor);
    for (let i = 1; i < POINTS - 1; i++) expect(p[2 * i + 1]).toBeGreaterThanOrEqual(floor);
    expect(p[1]).toBe(0.05);
    expect(p[2 * (POINTS - 1) + 1]).toBe(0.05);
    expect(Math.min(...p.filter((_, i) => i % 2 === 1))).toBeCloseTo(floor, 12);
  });

  it('is finite and exact at the ends for degenerate chords', () => {
    const cases: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [0, 0.8, 0, 0.8, 0.5], // coincident ends
      [0, 0.8, 1e-12, 0.8, 0.65],
      [0, 0.8, 0, 0.2, 0], // zero length
      [0, 0.8, 0, 0.2, Number.NaN],
      [0, 0.8, 0, 0.2, -3],
      [0, 0.8, 0.5, 0.8, 0.1], // string shorter than the chord
    ];
    for (const [ax, ay, bx, by, length] of cases) {
      const { p } = sample(ax, ay, bx, by, length, 1, 0.003);
      expect(p.every(Number.isFinite)).toBe(true);
      expect(p[0]).toBe(ax);
      expect(p[1]).toBe(ay);
      expect(p[2 * (POINTS - 1)]).toBe(bx);
      expect(p[2 * (POINTS - 1) + 1]).toBe(by);
    }
  });

  it('a coincident pair still produces a string of the right length (doubled back)', () => {
    const { p } = sample(0, 0.8, 0, 0.8, 0.2, 1);
    expect(Math.abs(polylineLength(p) - 0.2) / 0.2).toBeLessThan(0.03);
  });

  it('can write after other points in a shared buffer (first index) without touching them', () => {
    const buffer = new Array<number>(2 * (3 + POINTS)).fill(-7);
    sampleString(buffer, POINTS, 0, 0.85, 0.1, 0.3, 0.7, 0, -Infinity, 3);
    expect(buffer.slice(0, 6)).toEqual([-7, -7, -7, -7, -7, -7]);
    expect(buffer[6]).toBe(0);
    expect(buffer[7]).toBe(0.85);
    expect(buffer[2 * (3 + POINTS - 1)]).toBe(0.1);
    expect(buffer[2 * (3 + POINTS - 1) + 1]).toBe(0.3);
    const alone = new Array<number>(2 * POINTS).fill(0);
    sampleString(alone, POINTS, 0, 0.85, 0.1, 0.3, 0.7, 0, -Infinity);
    expect(buffer.slice(6)).toEqual(alone);
  });

  it('works on a Float32Array and with a single point', () => {
    const out = new Float32Array(POINTS * 2);
    sampleString(out, POINTS, 0, 1, 0.5, 0.2, 1, 0, -Infinity);
    expect(Array.from(out).every(Number.isFinite)).toBe(true);
    const one = [9, 9];
    sampleString(one, 1, 0.25, 0.5, 1, 1, 2, 0, -Infinity);
    expect(one).toEqual([1, 1]);
    expect(() => sampleString([], 0, 0, 0, 1, 1, 2, 0, 0)).not.toThrow();
  });
});

describe('SlackSmoother', () => {
  it('ignores slack inside the deadband and is continuous just above it', () => {
    const s = new SlackSmoother();
    for (let i = 0; i < 100; i++) s.step(SLACK_DEADBAND * 0.9, 16);
    expect(s.value).toBe(0);
    for (let i = 0; i < 400; i++) s.step(SLACK_DEADBAND + 0.001, 16);
    expect(s.value).toBeCloseTo(0.001, 6);
  });

  it('rises and falls smoothly, without jumping to the target', () => {
    const s = new SlackSmoother();
    const first = s.step(0.1, 16);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.1 - SLACK_DEADBAND);
    for (let i = 0; i < 200; i++) s.step(0.1, 16);
    expect(s.value).toBeCloseTo(0.1 - SLACK_DEADBAND, 5);
    const fall = s.step(0, 16);
    expect(fall).toBeLessThan(0.1 - SLACK_DEADBAND);
    expect(fall).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) s.step(0, 16);
    expect(s.value).toBe(0);
  });

  it('is robust to non-finite input and stalls', () => {
    const s = new SlackSmoother();
    expect(s.step(Number.NaN, 16)).toBe(0);
    expect(s.step(0.1, Number.NaN)).toBe(0);
    expect(s.step(0.1, -5)).toBe(0);
    expect(Number.isFinite(s.step(0.1, 1e9))).toBe(true);
    s.reset();
    expect(s.value).toBe(0);
  });
});
