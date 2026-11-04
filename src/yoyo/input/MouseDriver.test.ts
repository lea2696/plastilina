import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnchorSample } from '../contracts';
import { MAX_CATCH_UP_SAMPLES, MouseDriver, runPointerScript, type PointerScriptStep } from './MouseDriver';

/** An element that does not start at the page origin and is wider than tall, like the game canvas. */
const RECT = { left: 100, top: 50, width: 1280, height: 720 };
const clientX = (vx: number) => RECT.left + vx * RECT.height;
const clientY = (vy: number) => RECT.top + vy * RECT.height;

/** Grid time of sample k for a press at t0, written the same way the driver computes it. */
const gridTime = (t0: number, k: number, hz = 30) => t0 + (k * 1000) / hz;

interface Drag {
  t0: number;
  /** Start position, viewport heights. */
  x: number;
  y0: number;
  /** Vertical speed in vh/s, positive = down the screen. */
  speed: number;
  durationMs: number;
  /** Pointer events per second after the press. */
  eventHz: number;
  /** Shifts the events off the sample grid; 0 puts every Nth event exactly on a grid time. */
  offsetMs?: number;
  release?: boolean;
}

/** A press followed by a straight drag at constant speed: the scripted gesture of the PRD, noise free. */
function dragScript(d: Drag): PointerScriptStep[] {
  const offset = d.offsetMs ?? 0;
  const steps: PointerScriptStep[] = [{ t: d.t0, x: clientX(d.x), y: clientY(d.y0), down: true }];
  // Event times are written like grid times (multiply first) so aligned events land exactly on the grid.
  for (let j = 1; offset + (j * 1000) / d.eventHz <= d.durationMs; j += 1) {
    const t = d.t0 + offset + (j * 1000) / d.eventHz;
    steps.push({ t, x: clientX(d.x), y: clientY(d.y0 + (d.speed * (t - d.t0)) / 1000) });
  }
  if (d.release) steps.push({ t: d.t0 + d.durationMs, x: clientX(d.x), y: clientY(d.y0 + d.speed * (d.durationMs / 1000)), up: true });
  return steps;
}

/** Speeds between consecutive samples in vh/s, as the classifier would difference them. */
function intervalSpeeds(samples: readonly AnchorSample[]): number[] {
  return samples.slice(1).map((s, i) => ((s.y - samples[i].y) * 1000) / (s.timestampMs - samples[i].timestampMs));
}

const timestamps = (samples: readonly AnchorSample[]) => samples.map(s => s.timestampMs);

describe('MouseDriver', () => {
  describe('sample shape', () => {
    it('emits camera-path samples: source mouse, palmSize 0, arrival equal to capture, no edge or landmarks', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 1000, RECT);
      const [sample] = driver.poll(1000);
      expect(sample).toEqual({ timestampMs: 1000, arrivalMs: 1000, source: 'mouse', x: 0.5, y: 0.5, palmSize: 0, continuous: false });
      // The optional fields are absent, not undefined: the mouse has neither.
      expect(Object.keys(sample).sort()).toEqual(['arrivalMs', 'continuous', 'palmSize', 'source', 'timestampMs', 'x', 'y']);
    });

    it('maps client pixels to viewport heights with y growing downward and no mirroring', () => {
      const driver = new MouseDriver();
      driver.down(RECT.left, RECT.top, 0, RECT);
      driver.move(RECT.left + RECT.height, RECT.top + RECT.height, 10);
      driver.move(RECT.left + 0.25 * RECT.height, RECT.top + 0.75 * RECT.height, 40);
      const [a, b, c] = [...driver.poll(0), ...driver.poll(34), ...driver.poll(67)];
      expect([a.x, a.y]).toEqual([0, 0]);
      expect([b.x, b.y]).toEqual([1, 1]);
      expect(c.x).toBeCloseTo(0.25, 12);
      expect(c.y).toBeCloseTo(0.75, 12);
      // The element is 16:9: x is measured in heights too, so the right edge is 16/9, not 1.
      const wide = new MouseDriver();
      wide.down(RECT.left + RECT.width, RECT.top, 0, RECT);
      expect(wide.poll(0)[0].x).toBeCloseTo(RECT.width / RECT.height, 12);
    });
  });

  describe('cadence', () => {
    it('gives a still press samples at exactly 30 Hz from the press, with zero displacement', () => {
      const t0 = 5000.25;
      const driver = new MouseDriver();
      driver.down(clientX(0.9), clientY(0.5), t0, RECT);
      const samples: AnchorSample[] = [];
      // The app polls once per 60 Hz render frame for one second.
      for (let i = 0; i <= 60; i += 1) samples.push(...driver.poll(t0 + (i * 1000) / 60));

      expect(samples).toHaveLength(31);
      samples.forEach((sample, k) => {
        expect(sample.timestampMs).toBeCloseTo(t0 + k * (1000 / 30), 6);
        expect(sample.arrivalMs).toBe(sample.timestampMs);
        expect(sample.x).toBe(samples[0].x);
        expect(sample.y).toBe(samples[0].y);
        expect(sample.continuous).toBe(k > 0);
      });
      expect(samples[0].x).toBeCloseTo(0.9, 12);
      expect(samples[0].y).toBeCloseTo(0.5, 12);
      for (const interval of timestamps(samples).slice(1).map((t, i) => t - samples[i].timestampMs)) expect(interval).toBeCloseTo(1000 / 30, 9);
    });

    it('only produces a sample once its grid time is reached, and exactly at it', () => {
      const driver = new MouseDriver();
      driver.down(0, 0, 100, { ...RECT, left: 0, top: 0 });
      expect(driver.poll(100)).toHaveLength(1);
      expect(driver.poll(100 + 33.3)).toHaveLength(0);
      expect(driver.poll(gridTime(100, 1))).toHaveLength(1);
      expect(driver.poll(gridTime(100, 1))).toHaveLength(0);
      expect(driver.poll(gridTime(100, 3))).toHaveLength(2);
      // Polling before the press time yields nothing and breaks nothing.
      expect(new MouseDriver().poll(50)).toEqual([]);
    });

    it('does not depend on how often the app polls', () => {
      const script = dragScript({ t0: 2000, x: 0.5, y0: 0.2, speed: 1.5, durationMs: 800, eventHz: 90, offsetMs: 2.5, release: true });
      const fast = runPointerScript(new MouseDriver(), script, RECT, 2);
      const frame = runPointerScript(new MouseDriver(), script, RECT, 1000 / 60);
      const slow = runPointerScript(new MouseDriver(), script, RECT, 50);
      expect(fast.length).toBeGreaterThan(20);
      expect(frame).toEqual(fast);
      expect(slow).toEqual(fast);
    });

    it('gives the same sample grid whether the pointer reports at 60, 120 or 1000 Hz', () => {
      const speed = 2;
      const run = (eventHz: number) => runPointerScript(new MouseDriver(), dragScript({ t0: 800, x: 0.5, y0: 0.1, speed, durationMs: 1000, eventHz, release: true }), RECT);
      const at60 = run(60);
      const at120 = run(120);
      const at1000 = run(1000);

      expect(timestamps(at60)).toEqual(timestamps(at120));
      expect(timestamps(at1000)).toEqual(timestamps(at120));
      expect(at120).toHaveLength(31);
      at120.forEach((sample, k) => expect(sample.timestampMs).toBeCloseTo(gridTime(800, k), 6));
      // Same gesture, so the positions agree to within what one pointer period can move.
      for (const [samples, eventHz] of [[at60, 60], [at1000, 1000]] as const) {
        samples.forEach((sample, k) => expect(Math.abs(sample.y - at120[k].y)).toBeLessThanOrEqual(speed / eventHz + 1e-9));
      }
    });

    it('honours a different sample rate', () => {
      const driver = new MouseDriver(60);
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      const samples = driver.poll(100);
      expect(samples).toHaveLength(7);
      samples.forEach((sample, k) => expect(sample.timestampMs).toBeCloseTo((k * 1000) / 60, 9));
    });

    it('rejects a non-positive or non-finite sample rate', () => {
      for (const hz of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new MouseDriver(hz)).toThrow(RangeError);
    });
  });

  describe('sample-and-hold', () => {
    it('takes the latest position at or before each grid time, never one from the future', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.2), 0, RECT);
      driver.move(clientX(0.5), clientY(0.3), 10);
      driver.move(clientX(0.5), clientY(0.4), 30);
      // An event exactly at the grid time of sample 1 counts for that sample.
      driver.move(clientX(0.5), clientY(0.5), gridTime(0, 1));
      driver.move(clientX(0.5), clientY(0.6), 40);
      // The latest event before sample 2 (66.7 ms)...
      driver.move(clientX(0.5), clientY(0.8), 66);
      // ...and one after it, which must not leak back into sample 2.
      driver.move(clientX(0.5), clientY(0.9), 70);
      const samples = driver.poll(100);

      expect(timestamps(samples)).toEqual([0, gridTime(0, 1), gridTime(0, 2), gridTime(0, 3)]);
      expect(samples.map(s => s.y)).toEqual([
        expect.closeTo(0.2, 12), // k=0: only the press had happened
        expect.closeTo(0.5, 12), // k=1: the event exactly at 33.3 ms, not the 40 ms one
        expect.closeTo(0.8, 12), // k=2: the 66 ms event, not the 70 ms one
        expect.closeTo(0.9, 12), // k=3: the 70 ms event
      ]);
    });

    it('never runs ahead of the true position on a steady drag, lagging by at most one pointer period', () => {
      const speed = 2;
      const eventHz = 100;
      const samples = runPointerScript(new MouseDriver(), dragScript({ t0: 0, x: 0.5, y0: 0.1, speed, durationMs: 1000, eventHz, offsetMs: 3, release: true }), RECT);
      samples.forEach((sample, k) => {
        const trueY = 0.1 + (speed * gridTime(0, k)) / 1000;
        expect(sample.y).toBeLessThanOrEqual(trueY + 1e-9);
        expect(trueY - sample.y).toBeLessThanOrEqual(speed / eventHz + 1e-9);
      });
    });

    it('treats an event with a stale timestamp as simultaneous with the last one, never as time travel', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.2), 0, RECT);
      driver.move(clientX(0.5), clientY(0.4), 50);
      const afterOne = driver.poll(50);
      expect(afterOne.map(s => s.y)).toEqual([expect.closeTo(0.2, 12), expect.closeTo(0.2, 12)]);
      // A stale timestamp is treated as simultaneous with the last event: the position updates
      // for samples from now on, but the two already produced are untouched.
      driver.move(clientX(0.5), clientY(0.7), 10);
      const later = driver.poll(100);
      expect(later.map(s => s.timestampMs)).toEqual([gridTime(0, 2), gridTime(0, 3)]);
      expect(later.every(s => s.y === later[0].y && Math.abs(s.y - 0.7) < 1e-12)).toBe(true);
    });
  });

  describe('scripted drags', () => {
    it('drag down at 2 vh/s yields interval speeds of 2 vh/s', () => {
      const samples = runPointerScript(new MouseDriver(), dragScript({ t0: 1000, x: 0.5, y0: 0.1, speed: 2, durationMs: 1000, eventHz: 120, release: true }), RECT);
      expect(samples).toHaveLength(31);
      const speeds = intervalSpeeds(samples);
      expect(speeds).toHaveLength(30);
      for (const speed of speeds) expect(speed).toBeCloseTo(2, 6);
      // Straight down: x never moves.
      expect(samples.every(s => s.x === samples[0].x)).toBe(true);
      expect(samples[30].y).toBeCloseTo(2.1, 9);
    });

    it('drag up at 2 vh/s yields interval speeds of -2 vh/s', () => {
      const samples = runPointerScript(new MouseDriver(), dragScript({ t0: 1000, x: 0.5, y0: 0.9, speed: -2, durationMs: 400, eventHz: 120, release: true }), RECT);
      const speeds = intervalSpeeds(samples);
      expect(speeds.length).toBeGreaterThanOrEqual(11);
      for (const speed of speeds) expect(speed).toBeCloseTo(-2, 6);
    });

    it('keeps the mean speed of an unaligned drag at 2 vh/s even though single intervals wobble', () => {
      const samples = runPointerScript(new MouseDriver(), dragScript({ t0: 0, x: 0.5, y0: 0.1, speed: 2, durationMs: 1000, eventHz: 100, offsetMs: 3.7, release: true }), RECT);
      const mean = ((samples[samples.length - 1].y - samples[0].y) * 1000) / (samples[samples.length - 1].timestampMs - samples[0].timestampMs);
      expect(mean).toBeCloseTo(2, 1);
      // Each single interval is off by at most one pointer period of motion (10 ms of 33.3 ms).
      for (const speed of intervalSpeeds(samples)) expect(Math.abs(speed - 2)).toBeLessThanOrEqual((2 * 10) / (1000 / 30) + 1e-6);
    });

    it('marks only the first sample after a press as not continuous', () => {
      const samples = runPointerScript(new MouseDriver(), dragScript({ t0: 0, x: 0.5, y0: 0.1, speed: 1, durationMs: 500, eventHz: 60, release: true }), RECT);
      expect(samples[0].continuous).toBe(false);
      expect(samples.slice(1).every(s => s.continuous)).toBe(true);
    });
  });

  describe('release', () => {
    it('stops the stream: nothing is due after up, and the hand is no longer pressed', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      expect(driver.pressed).toBe(true);
      driver.poll(50);
      driver.up(125);
      expect(driver.pressed).toBe(false);

      // Whatever was due up to the release is still handed over, once...
      expect(driver.poll(130).map(s => s.timestampMs)).toEqual([gridTime(0, 2), gridTime(0, 3)]);
      // ...and from then on the driver is silent, however long it is polled or moved.
      expect(driver.poll(200)).toEqual([]);
      driver.move(clientX(0.9), clientY(0.9), 210);
      expect(driver.poll(5000)).toEqual([]);
    });

    it('delivers a sample due exactly at the release instant (the hand was down for it)', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      driver.up(gridTime(0, 3));
      expect(driver.poll(1000).map(s => s.timestampMs)).toEqual([0, gridTime(0, 1), gridTime(0, 2), gridTime(0, 3)]);
    });

    it('never produces a sample later than the release time', () => {
      const samples = runPointerScript(new MouseDriver(), dragScript({ t0: 0, x: 0.5, y0: 0.1, speed: 1, durationMs: 777, eventHz: 100, release: true }), RECT, 5);
      expect(Math.max(...timestamps(samples))).toBeLessThanOrEqual(777);
    });

    it('starts a fresh grid on the next press, whose first sample is not continuous', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      driver.poll(100);
      driver.up(100);
      driver.poll(100);

      driver.down(clientX(0.3), clientY(0.4), 500, RECT);
      const samples = driver.poll(570);
      expect(timestamps(samples)).toEqual([500, gridTime(500, 1), gridTime(500, 2)]);
      expect(samples.map(s => s.continuous)).toEqual([false, true, true]);
      expect(samples[0].x).toBeCloseTo(0.3, 12);
    });

    it('treats a press while already pressed (a lost pointerup) as a clean restart', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      driver.poll(40);
      driver.down(clientX(0.1), clientY(0.1), 1000, RECT);
      const samples = driver.poll(1000);
      expect(samples).toHaveLength(1);
      expect(samples[0].continuous).toBe(false);
      expect(samples[0].timestampMs).toBe(1000);
    });

    it('does nothing on up or move when not pressed', () => {
      const driver = new MouseDriver();
      driver.move(1, 1, 10);
      driver.up(20);
      expect(driver.pressed).toBe(false);
      expect(driver.poll(100)).toEqual([]);
    });
  });

  describe('late polls (bounded catch-up)', () => {
    it('returns at most the 8 newest due samples and flags the first one as not continuous', () => {
      const t0 = 1000;
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), t0, RECT);
      expect(driver.poll(t0)).toHaveLength(1);

      // The app stalls for a second; the pointer keeps reporting at 120 Hz, one pixel at a time.
      const baseY = clientY(0.5);
      for (let j = 1; j <= 120; j += 1) driver.move(clientX(0.5), baseY + j, t0 + (j * 1000) / 120);
      const late = driver.poll(t0 + 1000);

      expect(MAX_CATCH_UP_SAMPLES).toBe(8);
      expect(late).toHaveLength(8);
      expect(timestamps(late)).toEqual([23, 24, 25, 26, 27, 28, 29, 30].map(k => gridTime(t0, k)));
      expect(late.map(s => s.continuous)).toEqual([false, true, true, true, true, true, true, true]);
      // Skipping must not shift the samples: each still holds the position that was true at its grid time.
      late.forEach((sample, i) => expect(sample.y).toBeCloseTo((baseY + 4 * (23 + i) - RECT.top) / RECT.height, 9));
      // Nothing is left over, and the stream carries on from where it was.
      expect(driver.poll(t0 + 1000)).toEqual([]);
      driver.move(clientX(0.5), baseY + 121, t0 + 1000 + 8);
      const next = driver.poll(gridTime(t0, 31));
      expect(timestamps(next)).toEqual([gridTime(t0, 31)]);
      expect(next[0].continuous).toBe(true);
    });

    it('catches up the same way when the pointer is still, with no events to trigger production', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.4), clientY(0.6), 0, RECT);
      driver.poll(0);
      const late = driver.poll(10_000);
      expect(late).toHaveLength(8);
      expect(timestamps(late)).toEqual([293, 294, 295, 296, 297, 298, 299, 300].map(k => gridTime(0, k)));
      expect(late[0].continuous).toBe(false);
      expect(late.slice(1).every(s => s.continuous)).toBe(true);
      expect(late.every(s => Math.abs(s.x - 0.4) < 1e-12)).toBe(true);
    });

    it('does not flag a poll that is merely a little late, as long as nothing was skipped', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      driver.poll(0);
      const samples = driver.poll(gridTime(0, 8));
      expect(samples).toHaveLength(8);
      expect(samples.every(s => s.continuous)).toBe(true);
    });

    it('stays bounded however long the app goes without polling', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      // Five minutes of 1 kHz pointer events with nobody polling.
      for (let t = 1; t <= 300_000; t += 1) driver.move(clientX(0.5), clientY(0.5) + (t % 100), t);
      const samples = driver.poll(300_000);
      expect(samples.length).toBeLessThanOrEqual(MAX_CATCH_UP_SAMPLES);
      expect(samples[0].continuous).toBe(false);
      expect(driver.poll(300_000)).toEqual([]);
    });

    it('keeps the unpolled backlog capped when events arrive before the poll', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      for (let j = 1; j <= 30; j += 1) driver.move(clientX(0.5), clientY(0.5) + j, j * 100);
      const samples = driver.poll(3000);
      expect(samples).toHaveLength(MAX_CATCH_UP_SAMPLES);
      expect(samples[0].continuous).toBe(false);
      expect(samples.slice(1).every(s => s.continuous)).toBe(true);
    });
  });

  describe('hostile input', () => {
    it('ignores a press that cannot be mapped instead of emitting NaN', () => {
      const driver = new MouseDriver();
      driver.down(Number.NaN, 10, 0, RECT);
      driver.down(10, Number.POSITIVE_INFINITY, 0, RECT);
      driver.down(10, 10, Number.NaN, RECT);
      driver.down(10, 10, 0, { ...RECT, height: 0 });
      driver.down(10, 10, 0, { ...RECT, height: -5 });
      driver.down(10, 10, 0, { ...RECT, left: Number.NaN });
      expect(driver.pressed).toBe(false);
      expect(driver.poll(1000)).toEqual([]);
    });

    it('ignores non-finite moves and keeps holding the last good position', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      driver.move(Number.NaN, 1, 10);
      driver.move(1, Number.NaN, 20);
      driver.move(1, 1, Number.NaN);
      const samples = driver.poll(100);
      expect(samples).toHaveLength(4);
      for (const sample of samples) {
        expect(sample.x).toBeCloseTo(0.5, 12);
        expect(sample.y).toBeCloseTo(0.5, 12);
      }
    });

    it('ignores absurd times instead of hanging', () => {
      const driver = new MouseDriver();
      driver.down(clientX(0.5), clientY(0.5), 0, RECT);
      driver.move(1, 1, 1e300);
      expect(driver.poll(1e300)).toEqual([]);
      expect(driver.poll(Number.POSITIVE_INFINITY)).toEqual([]);
      expect(driver.poll(Number.NaN)).toEqual([]);
      driver.up(Number.NaN);
      expect(driver.pressed).toBe(false);
      const stillPressed = new MouseDriver();
      stillPressed.down(1, 1, 1e300, RECT);
      expect(stillPressed.pressed).toBe(false);
    });
  });

  describe('runPointerScript', () => {
    it('returns every sample of a long quiet gap, not just the last 8', () => {
      const script: PointerScriptStep[] = [
        { t: 0, x: clientX(0.2), y: clientY(0.2), down: true },
        { t: 2000, x: clientX(0.8), y: clientY(0.8) },
        { t: 2100, x: clientX(0.8), y: clientY(0.8), up: true },
      ];
      const samples = runPointerScript(new MouseDriver(), script, RECT);
      // 0..2100 ms on a 33.3 ms grid: k = 0..63.
      expect(samples).toHaveLength(64);
      expect(samples.slice(1).every(s => s.continuous)).toBe(true);
      expect(samples[59].y).toBeCloseTo(0.2, 12);
      // The event at exactly 2000 ms is the latest at or before the sample at 2000 ms.
      expect(samples[60].timestampMs).toBeCloseTo(2000, 9);
      expect(samples[60].y).toBeCloseTo(0.8, 12);
    });

    it('returns nothing for an empty script or one that never presses', () => {
      expect(runPointerScript(new MouseDriver(), [], RECT)).toEqual([]);
      expect(runPointerScript(new MouseDriver(), [{ t: 0, x: 1, y: 1 }, { t: 500, x: 2, y: 2 }], RECT)).toEqual([]);
    });

    it('rejects scripts that go back in time, mix down and up, or poll at a non-positive cadence', () => {
      const back: PointerScriptStep[] = [{ t: 100, x: 0, y: 0, down: true }, { t: 50, x: 0, y: 0 }];
      expect(() => runPointerScript(new MouseDriver(), back, RECT)).toThrow(/time order/);
      const both: PointerScriptStep[] = [{ t: 0, x: 0, y: 0, down: true, up: true }];
      expect(() => runPointerScript(new MouseDriver(), both, RECT)).toThrow(/one event/);
      for (const pollMs of [0, -1, Number.NaN]) expect(() => runPointerScript(new MouseDriver(), [], RECT, pollMs)).toThrow(RangeError);
    });

    it('replays identically every time (a mouse script is a deterministic replay)', () => {
      const script = dragScript({ t0: 321.5, x: 0.4, y0: 0.15, speed: 1.7, durationMs: 900, eventHz: 125, offsetMs: 1.3, release: true });
      expect(runPointerScript(new MouseDriver(), script, RECT)).toEqual(runPointerScript(new MouseDriver(), script, RECT));
    });
  });

  it('reads no ambient clock or randomness (determinism rule)', () => {
    const source = readFileSync(new URL('./MouseDriver.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random/);
  });
});
