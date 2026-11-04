import { describe, expect, it } from 'vitest';
import {
  HIT_STOP_EASE_MS, HIT_STOP_MS, HitStop, OVERSHOOT_END_MS, OVERSHOOT_MAX_M, SHAKE_MAX_M, SHAKE_MS, WeightCues,
  POP_FROM, POP_MS, RETETHER_POP_FROM, impactScale, liveWeight, overshootOffset, popScale, shakeEnvelope, shakeOffset, smoothstep01,
} from './timelines';

describe('liveWeight (hit-stop envelope)', () => {
  it('is frozen for 40 ms, eases over 60 ms, then live', () => {
    expect(HIT_STOP_MS).toBe(40);
    expect(HIT_STOP_EASE_MS).toBe(60);
    expect(liveWeight(0)).toBe(0);
    expect(liveWeight(20)).toBe(0);
    expect(liveWeight(HIT_STOP_MS - 0.001)).toBe(0);
    expect(liveWeight(HIT_STOP_MS)).toBe(0);
    expect(liveWeight(HIT_STOP_MS + HIT_STOP_EASE_MS / 2)).toBeCloseTo(0.5, 12);
    expect(liveWeight(HIT_STOP_MS + HIT_STOP_EASE_MS)).toBe(1);
    expect(liveWeight(500)).toBe(1);
  });

  it('rises monotonically and without a jump at the start or end of the ease', () => {
    let previous = 0;
    for (let t = 0; t <= 140; t += 0.5) {
      const w = liveWeight(t);
      expect(w).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(w - previous).toBeLessThan(0.05);
      previous = w;
    }
    expect(previous).toBe(1);
  });

  it('means "not running" for negative or non-finite times so a clock jump cannot freeze the yoyo', () => {
    expect(liveWeight(-1)).toBe(1);
    expect(liveWeight(Number.NaN)).toBe(1);
    expect(liveWeight(Number.NEGATIVE_INFINITY)).toBe(1);
    expect(liveWeight(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('overshootOffset (string stretch on a snap)', () => {
  it('never exceeds 8 mm, starts and ends at zero, and has sprung back within ~100 ms', () => {
    expect(OVERSHOOT_MAX_M).toBeLessThanOrEqual(0.008);
    expect(overshootOffset(0)).toBe(0);
    expect(overshootOffset(-5)).toBe(0);
    expect(overshootOffset(OVERSHOOT_END_MS)).toBe(0);
    expect(overshootOffset(OVERSHOOT_END_MS + 50)).toBe(0);
    let peak = 0;
    for (let t = 0; t <= 140; t += 0.25) {
      const o = overshootOffset(t);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(OVERSHOOT_MAX_M + 1e-12);
      peak = Math.max(peak, o);
    }
    expect(peak).toBeCloseTo(OVERSHOOT_MAX_M, 12);
  });

  it('holds the stretch while the frame is frozen, then springs back smoothly', () => {
    for (let t = 10; t <= HIT_STOP_MS; t += 5) expect(overshootOffset(t)).toBeCloseTo(OVERSHOOT_MAX_M, 12);
    let previous = OVERSHOOT_MAX_M;
    for (let t = HIT_STOP_MS; t <= OVERSHOOT_END_MS; t += 1) {
      const o = overshootOffset(t);
      expect(o).toBeLessThanOrEqual(previous + 1e-12);
      previous = o;
    }
  });

  it('is continuous: no step between 0.5 ms samples larger than a fifth of the amplitude', () => {
    let previous = overshootOffset(0);
    for (let t = 0.5; t < 130; t += 0.5) {
      const o = overshootOffset(t);
      expect(Math.abs(o - previous)).toBeLessThan(OVERSHOOT_MAX_M * 0.2);
      previous = o;
    }
  });

  it('scales with the amplitude and ignores non-finite times', () => {
    expect(overshootOffset(20, 0.004)).toBeCloseTo(0.004, 12);
    expect(overshootOffset(Number.NaN)).toBe(0);
    expect(overshootOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('shake (camera)', () => {
  it('never exceeds 4 mm in magnitude and is exactly zero after 150 ms', () => {
    expect(SHAKE_MAX_M).toBeLessThanOrEqual(0.004);
    expect(SHAKE_MS).toBe(150);
    const out: [number, number] = [0, 0];
    for (let t = -10; t <= 400; t += 0.5) {
      shakeOffset(t, SHAKE_MAX_M, out);
      expect(Math.hypot(out[0], out[1])).toBeLessThanOrEqual(SHAKE_MAX_M + 1e-12);
      if (t >= SHAKE_MS || t < 0) expect(out).toEqual([0, 0]);
    }
  });

  it('decays: the envelope falls monotonically from 1 at the impact to 0 at 150 ms', () => {
    expect(shakeEnvelope(0)).toBe(1);
    expect(shakeEnvelope(SHAKE_MS)).toBe(0);
    let previous = 1;
    for (let t = 0; t <= SHAKE_MS; t += 1) {
      const e = shakeEnvelope(t);
      expect(e).toBeLessThanOrEqual(previous + 1e-12);
      previous = e;
    }
    expect(Number.isNaN(shakeEnvelope(Number.NaN))).toBe(false);
  });

  it('is mostly vertical', () => {
    const out: [number, number] = [0, 0];
    let maxX = 0;
    let maxY = 0;
    for (let t = 0; t < SHAKE_MS; t += 0.5) {
      shakeOffset(t, 1, out);
      maxX = Math.max(maxX, Math.abs(out[0]));
      maxY = Math.max(maxY, Math.abs(out[1]));
    }
    expect(maxY).toBeGreaterThan(maxX * 2);
  });
});

describe('popScale (tether snap)', () => {
  it('starts small, overshoots slightly and settles at exactly 1', () => {
    expect(popScale(0)).toBeCloseTo(POP_FROM, 12);
    expect(popScale(POP_MS)).toBe(1);
    expect(popScale(POP_MS + 1000)).toBe(1);
    let peak = 0;
    for (let t = 0; t < POP_MS; t += 0.5) peak = Math.max(peak, popScale(t));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.1);
  });

  it('is continuous into the settled state and never negative', () => {
    let previous = popScale(0);
    for (let t = 0.5; t <= POP_MS + 20; t += 0.5) {
      const s = popScale(t);
      expect(s).toBeGreaterThan(0);
      expect(Math.abs(s - previous)).toBeLessThan(0.05);
      previous = s;
    }
  });

  it('leaves the yoyo at full size for negative or non-finite times', () => {
    expect(popScale(-1)).toBe(1);
    expect(popScale(Number.NaN)).toBe(1);
    expect(popScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('popScale with a custom start (re-tether settle)', () => {
  it('a re-tie only settles slightly: it never goes below its own start', () => {
    expect(popScale(0, RETETHER_POP_FROM)).toBeCloseTo(RETETHER_POP_FROM, 12);
    expect(popScale(POP_MS, RETETHER_POP_FROM)).toBe(1);
    for (let t = 0; t < POP_MS; t += 1) expect(popScale(t, RETETHER_POP_FROM)).toBeGreaterThanOrEqual(RETETHER_POP_FROM - 1e-9);
    expect(popScale(0, RETETHER_POP_FROM)).toBeGreaterThan(popScale(0));
  });
});

describe('impactScale', () => {
  it('maps impact speed to 0.4..1 and has a default for unknown strength', () => {
    expect(impactScale(0)).toBeCloseTo(0.4, 12);
    expect(impactScale(100)).toBe(1);
    expect(impactScale(undefined)).toBe(0.7);
    expect(impactScale(Number.NaN)).toBe(0.7);
    expect(impactScale(-4)).toBe(0.4);
    expect(impactScale(1.5)).toBeGreaterThan(impactScale(0.5));
  });
});

describe('smoothstep01', () => {
  it('has zero slope at the ends and clamps', () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(2)).toBe(1);
    expect(smoothstep01(0.5)).toBe(0.5);
    expect(smoothstep01(1e-3)).toBeLessThan(1e-5);
  });
});

describe('HitStop', () => {
  const out: [number, number] = [0, 0];

  it('draws the live pose when idle', () => {
    const h = new HitStop();
    h.blend(1000, 0.1, -0.5, out);
    expect(out).toEqual([0.1, -0.5]);
  });

  it('freezes the event-frame pose for 40 ms while the live pose keeps moving', () => {
    const h = new HitStop();
    h.trigger(1000, 0.0, -0.65);
    h.blend(1000, 0.0, -0.65, out);
    expect(out).toEqual([0, -0.65]);
    // The live pose moves on; the drawn one does not.
    h.blend(1030, 0.05, -0.6, out);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(-0.65, 12);
    // Then it eases to the live pose over the next 60 ms and lands exactly.
    h.blend(1070, 0.05, -0.6, out);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(0.05);
    h.blend(1100, 0.05, -0.6, out);
    expect(out[0]).toBeCloseTo(0.05, 12);
    expect(out[1]).toBeCloseTo(-0.6, 12);
  });

  it('never jumps: the drawn pose is continuous even when the live pose runs away', () => {
    const h = new HitStop();
    h.trigger(0, 0, -0.65);
    const liveSpeed = 1.5; // m/s: a brisk yoyo, far more than the relative motion of a taut string
    let previous: [number, number] | null = null;
    for (let t = 0; t <= 200; t += 1) {
      const liveY = -0.65 + liveSpeed * (t / 1000);
      h.blend(t, 0, liveY, out);
      if (previous) {
        // The drawn pose moves at most as fast as the live one plus the peak catch-up speed of the
        // ease (1.5 × gap / duration, the slope of a smoothstep). A jump would blow far past that.
        const gap = Math.abs(liveY - -0.65);
        const bound = (liveSpeed / 1000 + (1.5 * gap) / HIT_STOP_EASE_MS) * 1.05;
        expect(Math.abs(out[1] - previous[1])).toBeLessThanOrEqual(bound + 1e-9);
      }
      previous = [out[0], out[1]];
    }
    // At the instant the freeze ends the drawn pose has not moved at all: no visible pop.
    h.blend(HIT_STOP_MS, 0, -0.65 + (liveSpeed * HIT_STOP_MS) / 1000, out);
    expect(out[1]).toBeCloseTo(-0.65, 12);
  });

  it('a second trigger while the first is easing starts from the pose being drawn, not the live pose', () => {
    const h = new HitStop();
    h.trigger(0, 0, -0.65);
    h.blend(70, 0, -0.5, out); // mid-ease
    const drawnBefore: [number, number] = [out[0], out[1]];
    h.trigger(70, 0, -0.5);
    h.blend(70, 0, -0.5, out);
    expect(out[0]).toBeCloseTo(drawnBefore[0], 12);
    expect(out[1]).toBeCloseTo(drawnBefore[1], 12);
    // Frozen at that pose for another 40 ms.
    h.blend(105, 0, -0.4, out);
    expect(out[1]).toBeCloseTo(drawnBefore[1], 12);
  });

  it('draws the live pose when disabled (reduced motion) and trigger does nothing', () => {
    const h = new HitStop();
    h.enabled = false;
    h.trigger(0, 0, -0.65);
    h.blend(10, 0.2, -0.3, out);
    expect(out).toEqual([0.2, -0.3]);
  });

  it('reset forgets a running freeze', () => {
    const h = new HitStop();
    h.trigger(100, 0, -0.65);
    h.reset();
    h.blend(110, 0.3, -0.2, out);
    expect(out).toEqual([0.3, -0.2]);
  });
});

describe('WeightCues', () => {
  const out: [number, number] = [0, 0];

  it('a snap triggers hit-stop, overshoot and shake together', () => {
    const c = new WeightCues();
    c.snap(500, 3, 0, -0.65);
    expect(c.overshoot(520)).toBeGreaterThan(0);
    c.hitStop.blend(520, 0.02, -0.64, out);
    expect(out[1]).toBeCloseTo(-0.65, 12);
    c.shake(502, out);
    expect(Math.hypot(out[0], out[1])).toBeGreaterThan(0);
    // Everything is over 150 ms later.
    expect(c.overshoot(700)).toBe(0);
    c.shake(700, out);
    expect(out).toEqual([0, 0]);
    c.hitStop.blend(700, 0.02, -0.64, out);
    expect(out).toEqual([0.02, -0.64]);
  });

  it('a catch freezes and shakes but does not stretch the string', () => {
    const c = new WeightCues();
    c.catchYoyo(500, 2, 0, -0.03);
    expect(c.overshoot(510)).toBe(0);
    c.hitStop.blend(520, 0.03, -0.02, out);
    expect(out[1]).toBeCloseTo(-0.03, 12);
    c.shake(505, out);
    expect(Math.hypot(out[0], out[1])).toBeGreaterThan(0);
  });

  it('setReducedMotion(true) switches every cue off, including ones already running', () => {
    const c = new WeightCues();
    c.snap(500, 3, 0, -0.65);
    c.setReducedMotion(true);
    expect(c.reducedMotion).toBe(true);
    expect(c.overshoot(510)).toBe(0);
    c.shake(505, out);
    expect(out).toEqual([0, 0]);
    c.hitStop.blend(510, 0.1, -0.5, out);
    expect(out).toEqual([0.1, -0.5]);
    // New impacts while reduced do nothing.
    c.snap(900, 3, 0, -0.65);
    c.catchYoyo(900, 3, 0, -0.03);
    expect(c.overshoot(910)).toBe(0);
    c.shake(905, out);
    expect(out).toEqual([0, 0]);
    c.hitStop.blend(910, 0.1, -0.5, out);
    expect(out).toEqual([0.1, -0.5]);
  });

  describe('pose (what the renderer draws)', () => {
    it('is the live offset when nothing is running', () => {
      const c = new WeightCues();
      c.pose(1000, 0.02, -0.5, out);
      expect(out).toEqual([0.02, -0.5]);
    });

    it('on a snap the drawn yoyo is pushed along the string by at most 8 mm, held, then sprung back', () => {
      const c = new WeightCues();
      // Taut vertical string, 0.65 m, hanging straight down; the live pose does not change.
      c.snap(100, 3, 0, -0.65);
      let maxPush = 0;
      for (let t = 100; t <= 260; t += 1) {
        c.pose(t, 0, -0.65, out);
        expect(out[0]).toBeCloseTo(0, 12);
        maxPush = Math.max(maxPush, -0.65 - out[1]);
        // Never above the live pose (never shortens the string) and never more than 8 mm longer.
        expect(out[1]).toBeLessThanOrEqual(-0.65 + 1e-12);
        expect(out[1]).toBeGreaterThanOrEqual(-0.65 - OVERSHOOT_MAX_M - 1e-12);
      }
      expect(maxPush).toBeGreaterThan(0.002);
      expect(maxPush).toBeLessThanOrEqual(OVERSHOOT_MAX_M + 1e-12);
      c.pose(260, 0, -0.65, out);
      expect(out[1]).toBeCloseTo(-0.65, 12);
    });

    it('the push follows the string direction, whatever it is', () => {
      const c = new WeightCues();
      const ux = 0.6;
      const uy = -0.8;
      c.snap(0, 3, ux * 0.65, uy * 0.65);
      c.pose(20, ux * 0.65, uy * 0.65, out);
      const push = Math.hypot(out[0] - ux * 0.65, out[1] - uy * 0.65);
      expect(push).toBeGreaterThan(0.001);
      expect((out[0] - ux * 0.65) / push).toBeCloseTo(ux, 9);
      expect((out[1] - uy * 0.65) / push).toBeCloseTo(uy, 9);
    });

    it('is finite when the string has no length', () => {
      const c = new WeightCues();
      c.snap(0, 3, 0, 0);
      c.pose(20, 0, 0, out);
      expect(Number.isFinite(out[0] + out[1])).toBe(true);
    });

    it('is exactly the live offset in reduced motion, impact or not', () => {
      const c = new WeightCues();
      c.setReducedMotion(true);
      c.snap(0, 3, 0, -0.65);
      for (let t = 0; t < 200; t += 5) {
        c.pose(t, 0.01 * t, -0.65, out);
        expect(out).toEqual([0.01 * t, -0.65]);
      }
    });

    it('the drawn pose never jumps between consecutive 60 Hz frames across a snap then a catch', () => {
      const c = new WeightCues();
      let previous: [number, number] | null = null;
      for (let frame = 0; frame < 120; frame++) {
        const t = frame * (1000 / 60);
        // Live pose: hangs at full length (snap at frame 10), climbs 0.65 → 0.03 m over 30 frames from frame
        // 40 (a brisk return, about 1.3 m/s), and is caught at frame 70, when it is back in the hand.
        const live = frame < 40 ? -0.65 : -0.65 + 0.62 * Math.min(1, (frame - 40) / 30);
        if (frame === 10) c.snap(t, 4, 0, live);
        if (frame === 70) c.catchYoyo(t, 2, 0, live);
        c.pose(t, 0, live, out);
        // Between frames the drawn pose moves no faster than the live pose (about 2.1 cm per frame) plus
        // the overshoot's own slope (≤ 8 mm over 10 ms) and the ease's catch-up: a pop would be several cm.
        if (previous) expect(Math.abs(out[1] - previous[1])).toBeLessThan(0.025);
        previous = [out[0], out[1]];
      }
    });
  });

  it('turning reduced motion back off restores the cues', () => {
    const c = new WeightCues();
    c.setReducedMotion(true);
    c.setReducedMotion(false);
    c.snap(100, 3, 0, -0.65);
    expect(c.overshoot(120)).toBeGreaterThan(0);
  });

  it('the overshoot never exceeds 8 mm whatever the impact strength', () => {
    for (const strength of [undefined, 0, 1, 5, 50, Number.NaN]) {
      const c = new WeightCues();
      c.snap(0, strength, 0, -0.65);
      for (let t = 0; t < 150; t += 1) expect(c.overshoot(t)).toBeLessThanOrEqual(OVERSHOOT_MAX_M + 1e-12);
    }
  });
});
