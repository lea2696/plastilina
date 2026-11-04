import { describe, expect, it } from 'vitest';
import {
  TENSION_CLAMP_N, TENSION_FROM_N, TENSION_FULL_N, TENSION_TAU_MS, TensionTint, tensionTintAmount,
} from './tensionTint';

describe('tensionTintAmount', () => {
  it('is 0 up to the threshold, 1 from full tension on, and monotone in between', () => {
    expect(tensionTintAmount(0)).toBe(0);
    expect(tensionTintAmount(TENSION_FROM_N)).toBe(0);
    expect(tensionTintAmount(TENSION_FULL_N)).toBe(1);
    expect(tensionTintAmount(100)).toBe(1);
    let previous = 0;
    for (let n = 0; n <= 8; n += 0.1) {
      const t = tensionTintAmount(n);
      expect(t).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = t;
    }
  });

  it('the weight of a hanging yoyo (0.6 N) only barely tints the string', () => {
    expect(tensionTintAmount(0.6)).toBeLessThan(0.05);
  });
});

describe('TensionTint', () => {
  it('a single-frame spike of tens of newtons produces a subtle, short tint, never the full one', () => {
    const t = new TensionTint();
    for (let i = 0; i < 30; i++) t.step(0.6, 16.7);
    const before = t.step(0.6, 16.7);
    const spike = t.step(60, 16.7);
    expect(spike).toBeGreaterThan(before);
    expect(spike).toBeLessThan(0.6);
    let peak = spike;
    let last = spike;
    for (let i = 0; i < 40; i++) {
      last = t.step(0.6, 16.7);
      peak = Math.max(peak, last);
    }
    expect(peak).toBeLessThan(0.6);
    // And it fades back within a fraction of a second.
    expect(last).toBeLessThan(0.05);
  });

  it('clamps the raw value: 60 N and 8 N spikes look the same', () => {
    const a = new TensionTint();
    const b = new TensionTint();
    expect(a.step(60, 16.7)).toBeCloseTo(b.step(TENSION_CLAMP_N, 16.7), 12);
    expect(a.step(1e9, 16.7)).toBeCloseTo(b.step(TENSION_CLAMP_N, 16.7), 12);
  });

  it('follows a sustained pull and settles at the clamped value', () => {
    const t = new TensionTint();
    let amount = 0;
    for (let i = 0; i < 200; i++) amount = t.step(7, 16.7);
    expect(t.filtered).toBeCloseTo(7, 6);
    expect(amount).toBe(1);
  });

  it('low-pass time constant is ~40 ms: 63 % of a step after one tau', () => {
    expect(TENSION_TAU_MS).toBe(40);
    const t = new TensionTint();
    for (let ms = 0; ms < TENSION_TAU_MS; ms += 1) t.step(4, 1);
    expect(t.filtered / 4).toBeCloseTo(1 - Math.exp(-1), 2);
  });

  it('is frame-rate independent: 4 × 10 ms equals 1 × 40 ms', () => {
    const a = new TensionTint();
    const b = new TensionTint();
    for (let i = 0; i < 4; i++) a.step(5, 10);
    b.step(5, 40);
    expect(a.filtered).toBeCloseTo(b.filtered, 9);
  });

  it('treats slack, negative and non-finite tension as zero and never produces NaN', () => {
    const t = new TensionTint();
    t.step(5, 16.7);
    for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3, 0]) {
      const amount = t.step(raw, 16.7);
      expect(Number.isFinite(amount)).toBe(true);
      expect(Number.isFinite(t.filtered)).toBe(true);
    }
    for (let i = 0; i < 200; i++) t.step(0, 16.7);
    expect(t.filtered).toBeLessThan(1e-3);
  });

  it('survives a zero, negative or non-finite dt without changing state', () => {
    const t = new TensionTint();
    t.step(4, 16.7);
    const before = t.filtered;
    t.step(8, 0);
    t.step(8, -3);
    t.step(8, Number.NaN);
    expect(t.filtered).toBe(before);
    t.reset();
    expect(t.filtered).toBe(0);
  });
});
