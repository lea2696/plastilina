import { describe, expect, it } from 'vitest';
import {
  AdaptiveQuality, BACKOFF_WINDOW_MS, DROP_AFTER_MS, MAX_PIXEL_RATIO, QUALITY_FLOOR, QUALITY_STEP, RECOVER_AFTER_MS,
  STALL_MS, baseRatioFor,
} from './adaptiveQuality';

/** Feeds `ms` of frames of a given interval; returns how many times the ratio changed. */
function run(q: AdaptiveQuality, ms: number, frameMs: number): number {
  let changes = 0;
  for (let t = 0; t < ms; t += frameMs) if (q.sample(frameMs)) changes++;
  return changes;
}

describe('baseRatioFor', () => {
  it('starts at min(devicePixelRatio, 2)', () => {
    expect(baseRatioFor(1)).toBe(1);
    expect(baseRatioFor(1.5)).toBe(1.5);
    expect(baseRatioFor(2)).toBe(2);
    expect(baseRatioFor(3)).toBe(MAX_PIXEL_RATIO);
    expect(baseRatioFor(0)).toBe(1);
    expect(baseRatioFor(Number.NaN)).toBe(1);
    expect(baseRatioFor(-2)).toBe(1);
  });
});

describe('AdaptiveQuality', () => {
  it('exposes the starting ratio', () => {
    expect(new AdaptiveQuality(2).ratio).toBe(2);
    expect(new AdaptiveQuality(3).ratio).toBe(2);
    expect(new AdaptiveQuality(1).ratio).toBe(1);
  });

  it('never drops at a steady 60 fps, nor at 120 fps', () => {
    for (const frameMs of [1000 / 60, 1000 / 120]) {
      const q = new AdaptiveQuality(2);
      expect(run(q, 120000, frameMs)).toBe(0);
      expect(q.ratio).toBe(2);
    }
  });

  it('drops one step only after about 4 s of slow frames', () => {
    const q = new AdaptiveQuality(2);
    run(q, DROP_AFTER_MS - 200, 33);
    expect(q.ratio).toBe(2);
    run(q, 500, 33);
    expect(q.ratio).toBeCloseTo(2 - QUALITY_STEP, 12);
  });

  it('keeps stepping down while slow and stops at the floor', () => {
    const q = new AdaptiveQuality(2);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      run(q, DROP_AFTER_MS + 200, 33);
      seen.push(q.ratio);
    }
    expect(seen[0]).toBeCloseTo(1.75, 12);
    expect(Math.min(...seen)).toBe(QUALITY_FLOOR);
    expect(q.ratio).toBe(QUALITY_FLOOR);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
  });

  it('a 1× device only has one step below it and never goes under the floor', () => {
    const q = new AdaptiveQuality(1);
    run(q, 60000, 40);
    expect(q.ratio).toBe(QUALITY_FLOOR);
  });

  it('a device already below the floor is never reduced', () => {
    const q = new AdaptiveQuality(0.5);
    run(q, 60000, 40);
    expect(q.ratio).toBe(0.5);
  });

  it('does not recover before about 15 s of fast frames, then recovers one step', () => {
    const q = new AdaptiveQuality(2);
    run(q, DROP_AFTER_MS + 200, 33);
    const dropped = q.ratio;
    expect(dropped).toBeLessThan(2);
    run(q, RECOVER_AFTER_MS - 500, 16.7);
    expect(q.ratio).toBe(dropped);
    run(q, 1000, 16.7);
    expect(q.ratio).toBeCloseTo(dropped + QUALITY_STEP, 12);
  });

  it('recovers all the way to the base ratio and no further', () => {
    const q = new AdaptiveQuality(2);
    for (let i = 0; i < 3; i++) run(q, DROP_AFTER_MS + 200, 33);
    expect(q.ratio).toBeLessThan(1.5);
    run(q, 5 * (RECOVER_AFTER_MS + 1000), 16.7);
    expect(q.ratio).toBe(2);
    run(q, 60000, 16.7);
    expect(q.ratio).toBe(2);
  });

  it('isolated hiccups never add up to a drop', () => {
    const q = new AdaptiveQuality(2);
    let changes = 0;
    // One 60 ms frame every second for two minutes.
    for (let s = 0; s < 120; s++) {
      if (q.sample(60)) changes++;
      changes += run(q, 940, 16.7);
    }
    expect(changes).toBe(0);
  });

  it('a mostly-fast mix does not drop, a mostly-slow mix does', () => {
    const fast = new AdaptiveQuality(2);
    let changes = 0;
    for (let i = 0; i < 6000; i++) if (fast.sample(i % 4 === 0 ? 30 : 16.7)) changes++; // 25 % slow
    expect(changes).toBe(0);
    const slow = new AdaptiveQuality(2);
    for (let i = 0; i < 1200; i++) slow.sample(i % 4 === 0 ? 16.7 : 33); // 75 % slow
    expect(slow.ratio).toBeLessThan(2);
  });

  it('ignores stalls (hidden tab, debugger) and garbage intervals', () => {
    const q = new AdaptiveQuality(2);
    for (let i = 0; i < 200; i++) q.sample(STALL_MS + 1);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 5000]) expect(q.sample(bad)).toBe(false);
    expect(q.ratio).toBe(2);
  });

  it('backs off: after a premature recovery the next recovery waits longer', () => {
    const q = new AdaptiveQuality(2);
    run(q, DROP_AFTER_MS + 200, 33);
    expect(q.ratio).toBe(1.75);
    run(q, RECOVER_AFTER_MS + 500, 16.7);
    expect(q.ratio).toBe(2);
    // The recovery was wrong: slow again right away.
    run(q, DROP_AFTER_MS + 200, 33);
    expect(q.ratio).toBe(1.75);
    // The first wait is no longer enough.
    run(q, RECOVER_AFTER_MS + 500, 16.7);
    expect(q.ratio).toBe(1.75);
    run(q, RECOVER_AFTER_MS, 16.7);
    expect(q.ratio).toBe(2);
  });

  it('forgets the back-off after a long quiet spell', () => {
    const q = new AdaptiveQuality(2);
    run(q, DROP_AFTER_MS + 200, 33);
    run(q, RECOVER_AFTER_MS + 500, 16.7);
    run(q, DROP_AFTER_MS + 200, 33); // premature: doubles the wait
    run(q, 2 * RECOVER_AFTER_MS + 2000, 16.7); // recovers, then stays good...
    expect(q.ratio).toBe(2);
    run(q, BACKOFF_WINDOW_MS + 1000, 16.7);
    run(q, DROP_AFTER_MS + 200, 33);
    expect(q.ratio).toBe(1.75);
    // ...so the wait is the normal 15 s again.
    run(q, RECOVER_AFTER_MS + 500, 16.7);
    expect(q.ratio).toBe(2);
  });

  it('reports whether the ratio changed so the caller knows when to resize', () => {
    const q = new AdaptiveQuality(2);
    expect(run(q, DROP_AFTER_MS + 200, 33)).toBe(1);
    expect(run(q, RECOVER_AFTER_MS + 500, 16.7)).toBe(1);
  });

  it('setDeviceRatio follows a monitor change and keeps the quality level', () => {
    const q = new AdaptiveQuality(2);
    run(q, DROP_AFTER_MS + 200, 33);
    expect(q.ratio).toBe(1.75);
    expect(q.setDeviceRatio(1)).toBe(true);
    expect(q.ratio).toBe(QUALITY_FLOOR);
    expect(q.setDeviceRatio(1)).toBe(false);
    q.setDeviceRatio(2);
    expect(q.ratio).toBeLessThanOrEqual(2);
  });
});
