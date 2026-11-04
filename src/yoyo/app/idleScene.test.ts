import { describe, expect, it } from 'vitest';
import type { WorldRect, YoyoSnapshot } from '../contracts';
import { computeFraming } from '../render/framing';
import { idleSnapshot } from './idleScene';

/** What the renderer shows on a landscape and a phone-sized canvas: its own framing, so the fixtures follow it when it moves. */
const LANDSCAPE: WorldRect = computeFraming(1280 / 800).rect;
const PORTRAIT: WorldRect = computeFraming(390 / 844).rect;

function numbers(s: YoyoSnapshot): number[] {
  return [s.timeMs, ...s.pivot, ...s.pivotVelocity, ...s.yoyo, ...s.yoyoVelocity, s.length, s.maxLength, s.spin, s.spinAngle, s.tension, s.hand.lostMs, s.hand.palmWorld, s.steps, s.droppedMs];
}

describe('idleSnapshot', () => {
  it.each([['landscape', LANDSCAPE], ['portrait', PORTRAIT]])('is finite and a tied, sleeping yoyo with no hand (%s)', (_n, view) => {
    for (let t = 0; t < 20_000; t += 137) {
      const s = idleSnapshot(t, view);
      expect(numbers(s).every(Number.isFinite)).toBe(true);
      // Tied (the renderer draws the yoyo, string and shadow), nobody holds it, nothing pending.
      expect(s.phase).toBe('sleeping');
      expect(s.hand.present).toBe(false);
      expect(s.hand.landmarks).toBeNull();
      expect(s.hand.edge).toBeNull();
      expect(s.paused).toBe(false);
      expect(s.events).toHaveLength(0);
      expect(s.slack).toBe(false);
    }
  });

  it('hangs from above the top edge, so no pivot or marker shows', () => {
    const s = idleSnapshot(1234, LANDSCAPE);
    expect(s.pivot[1]).toBeGreaterThan(LANDSCAPE.top);
    expect(s.pivot[0]).toBeCloseTo(0, 12);
  });

  it('keeps the yoyo inside the screen, a little above its middle, centred', () => {
    for (const view of [LANDSCAPE, PORTRAIT]) {
      const middle = (view.top + view.bottom) / 2;
      for (let t = 0; t < 9000; t += 250) {
        const s = idleSnapshot(t, view);
        expect(s.yoyo[1]).toBeGreaterThan(middle);
        expect(s.yoyo[1]).toBeLessThan(view.top);
        expect(Math.abs(s.yoyo[0])).toBeLessThan(0.02);
        // Never below the floor or the bottom of the view.
        expect(s.yoyo[1]).toBeGreaterThan(Math.max(0, view.bottom));
      }
    }
  });

  it('keeps the string taut: the distance from pivot to yoyo is the string length', () => {
    for (let t = 0; t < 9000; t += 111) {
      const s = idleSnapshot(t, LANDSCAPE);
      expect(Math.hypot(s.yoyo[0] - s.pivot[0], s.yoyo[1] - s.pivot[1])).toBeCloseTo(s.length, 9);
      expect(s.maxLength).toBeCloseTo(s.length, 12);
    }
  });

  it('sways gently and periodically, and spins at a constant rate', () => {
    const xs = Array.from({ length: 200 }, (_, i) => idleSnapshot(i * 50, LANDSCAPE).yoyo[0]);
    expect(Math.max(...xs)).toBeGreaterThan(0.005);
    expect(Math.max(...xs)).toBeLessThan(0.02);
    expect(Math.min(...xs)).toBeLessThan(-0.005);
    const a = idleSnapshot(1000, LANDSCAPE);
    const b = idleSnapshot(1000 + 4200, LANDSCAPE);
    expect(b.yoyo[0]).toBeCloseTo(a.yoyo[0], 9);
    expect(a.spin).toBe(b.spin);
    expect(a.spin).toBeGreaterThan(200);
    expect(a.spinAngle).toBeGreaterThanOrEqual(0);
    expect(a.spinAngle).toBeLessThan(2 * Math.PI);
  });

  it('hangs still and turns slowly under prefers-reduced-motion', () => {
    const xs = Array.from({ length: 100 }, (_, i) => idleSnapshot(i * 90, LANDSCAPE, true).yoyo[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-12);
    const s = idleSnapshot(500, LANDSCAPE, true);
    expect(s.spin).toBeLessThan(100);
    expect(s.yoyoVelocity).toEqual([0, 0]);
    expect(numbers(s).every(Number.isFinite)).toBe(true);
    // The motion version is the default.
    expect(idleSnapshot(500, LANDSCAPE).spin).toBeGreaterThan(200);
  });

  it('survives a view that has no layout yet and a bad clock', () => {
    const degenerate = idleSnapshot(Number.NaN, { left: 0, right: 0, bottom: 0, top: 0 });
    expect(numbers(degenerate).every(Number.isFinite)).toBe(true);
    const nan = idleSnapshot(5, { left: Number.NaN, right: 1, bottom: 0, top: 1 });
    expect(numbers(nan).every(Number.isFinite)).toBe(true);
  });

  it('is a pure function of its inputs', () => {
    expect(idleSnapshot(777, LANDSCAPE)).toEqual(idleSnapshot(777, LANDSCAPE));
  });
});
