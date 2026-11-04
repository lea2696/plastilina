import { describe, expect, it } from 'vitest';
import { FpsMeter, RollingWindow, roundOrNull } from './stats';

describe('RollingWindow', () => {
  it('answers NaN while empty', () => {
    const w = new RollingWindow(4);
    expect(w.count).toBe(0);
    expect(w.percentile(0.5)).toBeNaN();
    expect(w.latest).toBeNaN();
  });

  it('uses nearest-rank percentiles, like the QA scripts', () => {
    const w = new RollingWindow(100);
    for (let i = 1; i <= 100; i++) w.push(i);
    expect(w.percentile(0.5)).toBe(50);
    expect(w.percentile(0.95)).toBe(95);
    expect(w.percentile(1)).toBe(100);
    expect(w.percentile(0)).toBe(1);
  });

  it('ranks a handful of samples the same way', () => {
    const w = new RollingWindow(8);
    for (const v of [4, 1, 3, 2]) w.push(v);
    expect(w.percentile(0.5)).toBe(2);
    expect(w.percentile(0.95)).toBe(4);
  });

  it('keeps only the newest `capacity` samples and stays correct after wrapping', () => {
    const w = new RollingWindow(5);
    for (let i = 1; i <= 12; i++) w.push(i);
    expect(w.count).toBe(5);
    expect(w.latest).toBe(12);
    // Window holds 8..12.
    expect(w.percentile(0)).toBe(8);
    expect(w.percentile(1)).toBe(12);
    expect(w.percentile(0.5)).toBe(10);
  });

  it('does not change its contents when asked for percentiles (it sorts a copy)', () => {
    const w = new RollingWindow(4);
    for (const v of [9, 1, 5, 3]) w.push(v);
    w.percentile(0.5);
    expect(w.latest).toBe(3);
    w.push(7);
    expect(w.latest).toBe(7);
    // The 9 was the oldest of four and is gone.
    expect(w.percentile(1)).toBe(7);
    expect(w.percentile(0)).toBe(1);
  });

  it('ignores non-finite samples instead of poisoning the window', () => {
    const w = new RollingWindow(4);
    w.push(Number.NaN);
    w.push(Infinity);
    w.push(-Infinity);
    w.push(2);
    expect(w.count).toBe(1);
    expect(w.percentile(0.95)).toBe(2);
  });

  it('answers NaN for a percentile that is not a number', () => {
    const w = new RollingWindow(2);
    w.push(1);
    expect(w.percentile(Number.NaN)).toBeNaN();
  });

  it('clears', () => {
    const w = new RollingWindow(3);
    w.push(1);
    w.push(2);
    w.clear();
    expect(w.count).toBe(0);
    expect(w.percentile(0.5)).toBeNaN();
    w.push(7);
    expect(w.percentile(0.5)).toBe(7);
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new RollingWindow(0)).toThrow(RangeError);
    expect(() => new RollingWindow(1.5)).toThrow(RangeError);
    expect(() => new RollingWindow(Number.NaN)).toThrow(RangeError);
  });

  it('holds the same memory however many samples go through (fixed rings)', () => {
    const w = new RollingWindow(64);
    for (let i = 0; i < 100_000; i++) w.push(i % 17);
    expect(w.count).toBe(64);
    expect(w.capacity).toBe(64);
  });
});

describe('FpsMeter', () => {
  it('reports 0 until a window completes, then the rate of that window', () => {
    const m = new FpsMeter(1000);
    let t = 0;
    expect(m.tick(t)).toBe(0);
    while (m.fps === 0 && t < 5000) {
      t += 1000 / 60;
      m.tick(t);
    }
    // The first window closes at the first frame at or after one second.
    expect(t).toBeGreaterThanOrEqual(1000 - 1e-6);
    expect(t).toBeLessThan(1000 + 1000 / 60 + 1e-6);
    expect(m.fps).toBeCloseTo(60, 0);
  });

  it('follows a change of rate after the next window', () => {
    const m = new FpsMeter(500);
    let t = 0;
    m.tick(t);
    while (t < 600) m.tick((t += 1000 / 60));
    expect(m.fps).toBeGreaterThan(55);
    const start = t;
    while (t < start + 1100) m.tick((t += 1000 / 30));
    expect(m.fps).toBeCloseTo(30, 0);
  });

  it('ignores non-finite times and can be reset', () => {
    const m = new FpsMeter(100);
    m.tick(0);
    m.tick(Number.NaN);
    for (let t = 16; t <= 200; t += 16) m.tick(t);
    expect(m.fps).toBeGreaterThan(0);
    m.reset();
    expect(m.fps).toBe(0);
  });

  it('rejects a window that is not positive', () => {
    expect(() => new FpsMeter(0)).toThrow(RangeError);
  });
});

describe('roundOrNull', () => {
  it('rounds to the requested decimals', () => {
    expect(roundOrNull(1.2345, 2)).toBe(1.23);
    expect(roundOrNull(1.2355, 2)).toBe(1.24);
    expect(roundOrNull(16.84, 1)).toBe(16.8);
    expect(roundOrNull(7, 0)).toBe(7);
  });

  it('turns what JSON cannot say into null', () => {
    expect(roundOrNull(Number.NaN)).toBeNull();
    expect(roundOrNull(Infinity)).toBeNull();
    expect(roundOrNull(-Infinity)).toBeNull();
  });
});
