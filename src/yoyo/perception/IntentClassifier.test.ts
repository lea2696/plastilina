import { describe, it, expect } from 'vitest';
import type { AnchorSample, ArmedIntents, IntentEvent } from '../contracts';
import { CONFIG_FIELDS, createConfig, getConfigValue, setConfigValue } from '../config';
import { Random } from '../replay/random';
import { framesSpanned, IntentClassifier, ringCapacity, SampleRing } from './IntentClassifier';

const FRAME = 1000 / 30;
const LAUNCH_ONLY: ArmedIntents = { launch: true, tug: false };
const TUG_ONLY: ArmedIntents = { launch: false, tug: true };
const BOTH: ArmedIntents = { launch: true, tug: true };
/** PRD §8.2 jitter: σ = 0.5 % of the image width in both axes, which is 0.0067 ih in x and y. */
const JITTER = 0.005 * (4 / 3);

type Path = (tMs: number) => { x: number; y: number };

const minJerk = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));

/** Rest at `base`, then a minimum-jerk move by `delta` starting at t0 and lasting `durationMs`. */
function moveAt(base: { x: number; y: number }, t0: number, durationMs: number, delta: { x: number; y: number }): Path {
  return t => {
    const s = minJerk((t - t0) / durationMs);
    return { x: base.x + delta.x * s, y: base.y + delta.y * s };
  };
}

function sampleAt(t: number, p: { x: number; y: number }, extra: Partial<AnchorSample> = {}): AnchorSample {
  return { timestampMs: t, arrivalMs: t + 50, source: 'replay', x: p.x, y: p.y, palmSize: 0.17, continuous: true, ...extra };
}

interface RunOptions {
  from?: number;
  to: number;
  /** Seeded jitter; omitted means noise-free samples. */
  rng?: Random;
  /** Capture-time offset of the first frame inside the 33 ms grid. */
  phase?: number;
  /** Sample period, ms; a camera is 33.3, a pointer may be faster. */
  periodMs?: number;
  /** Timestamp jitter, ms, uniform in ±jitterMs (needs rng). */
  jitterMs?: number;
}

/** Samples a path at 30 fps; the first sample is discontinuous, as after a reset. */
function samplesOf(path: Path, o: RunOptions): AnchorSample[] {
  const out: AnchorSample[] = [];
  const period = o.periodMs ?? FRAME;
  for (let nominal = (o.from ?? 0) + (o.phase ?? 0), i = 0; nominal < o.to; nominal += period, i++) {
    const t = o.rng && o.jitterMs ? nominal + o.rng.range(-o.jitterMs, o.jitterMs) : nominal;
    const p = path(t);
    const noisy = o.rng ? { x: p.x + o.rng.gaussian(0, JITTER), y: p.y + o.rng.gaussian(0, JITTER) } : p;
    out.push(sampleAt(t, noisy, { continuous: i > 0 }));
  }
  return out;
}

function feed(classifier: IntentClassifier, samples: readonly AnchorSample[], armed: ArmedIntents): IntentEvent[] {
  const events: IntentEvent[] = [];
  for (const s of samples) {
    const e = classifier.push(s, armed);
    if (e) events.push(e);
  }
  return events;
}

const HOME = { x: 0.7, y: 0.3 };

/** Where throws start: low enough in the frame for the biggest wind-up the tests use to stay inside it. */
const BASE = { x: 0.7, y: 0.9 };

interface ThrowShape {
  /** Height of the wind-up, ih. */
  rise: number;
  /** How long the wind-up takes, ms. Short enough, and with no dwell at the top, that the 250 ms before the stroke are not «quiet»: a wind-up that goes up and straight back down cancels in the quiet test's slope. */
  riseMs?: number;
  /** Time at the apex before the hand sets off, ms. */
  dwellMs?: number;
  /** A slow start: the hand drifts `slowDrop` ih down the apex over `slowMs` before the stroke itself. */
  slowMs?: number;
  slowDrop?: number;
  /** The stroke: `strokeLen` ih down in `strokeMs`. */
  strokeLen?: number;
  strokeMs?: number;
  /** Sideways travel of the wind-up, ih to the right: a diagonal wind-up; the stroke then goes straight down from the apex. */
  slant?: number;
  /** The hand drifts sideways at this speed (ih/s) from the start of the wind-up to a moment after the stroke begins: it sweeps across its top. */
  sweep?: number;
}

/**
 * A throw as Luis makes it (tests/fixtures/yoyo/luis-2026-10-01-seated-throws.json): the hand rests at
 * BASE, rises `rise` ih (0.17–0.43 in the real ones) in a quarter of a second, pauses at the top for a
 * moment, may start down slowly, and then comes down fast. `riseStartMs` is when the wind-up begins.
 */
function throwPath(shape: ThrowShape, riseStartMs = 500): Path {
  const { rise, riseMs = 150, dwellMs = 0, slowMs = 0, slowDrop = 0, strokeLen = 0.25, strokeMs = 160, slant = 0, sweep = 0 } = shape;
  const apexMs = riseStartMs + riseMs;
  const slowStartMs = apexMs + dwellMs;
  const strokeStartMs = slowStartMs + slowMs;
  return t => {
    const up = minJerk((t - riseStartMs) / riseMs);
    const slow = slowMs > 0 ? minJerk((t - slowStartMs) / slowMs) : 0;
    const stroke = minJerk((t - strokeStartMs) / strokeMs);
    const y = BASE.y - rise * up + slowDrop * slow + strokeLen * stroke;
    const sweepX = (sweep * (Math.min(Math.max(t, riseStartMs), strokeStartMs + 60) - riseStartMs)) / 1000;
    return { x: BASE.x + slant * up + sweepX, y };
  };
}

describe('IntentClassifier: launch', () => {
  it('fires within a few frames of a fast downward stroke that starts from stillness', () => {
    const path = moveAt(HOME, 700, 200, { x: 0.01, y: 0.2 });
    const events = feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1500 }), LAUNCH_ONLY);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.kind).toBe('launch');
    expect(e.timestampMs - 700).toBeLessThan(150);
    expect(e.arrivalMs - e.timestampMs).toBe(50);
    // Strength is the peak interval speed of the detection window: fast, never below the threshold.
    expect(e.strength).toBeGreaterThanOrEqual(1.2);
    expect(e.strength).toBeLessThan(2.2);
  });

  it('also fires from a small upward wind-up, even though the hand was moving just before', () => {
    const windup = moveAt(HOME, 600, 250, { x: 0, y: -0.06 });
    const down = moveAt({ x: HOME.x, y: HOME.y - 0.06 }, 900, 200, { x: 0.01, y: 0.2 });
    const path: Path = t => (t < 880 ? windup(t) : down(t));
    const events = feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1600 }), LAUNCH_ONLY);
    expect(events.map(e => e.kind)).toEqual(['launch']);
    expect(events[0].timestampMs).toBeGreaterThan(900);
  });

  it('fires from a big wind-up, as Luis makes them: 0.17 to 0.43 ih up, then a fast stroke down', () => {
    for (const rise of [0.17, 0.3, 0.43]) {
      const samples = samplesOf(throwPath({ rise }), { to: 1700 });
      const events = feed(new IntentClassifier(createConfig()), samples, LAUNCH_ONLY);
      expect(events.map(e => e.kind), `rise ${rise}`).toEqual(['launch']);
      // The stroke starts at 650 ms (500 + 150 rise): detected within a few frames of it, not before.
      expect(events[0].timestampMs, `rise ${rise}`).toBeGreaterThan(650);
      expect(events[0].timestampMs, `rise ${rise}`).toBeLessThan(650 + 200);
      // It is the wind-up that carries it, not a quiet hand: with the old 0.12 ih ceiling the same throw does not fire.
      expect(feed(new IntentClassifier(setConfigValue(createConfig(), 'launch.windupMaxUp', 0.12)), samples, LAUNCH_ONLY), `old ceiling, rise ${rise}`).toEqual(rise <= 0.12 ? expect.anything() : []);
    }
    // The same with the seated preset, whose wind-up ceiling is NOT scaled by 0.7 (0.35 ih would reject the biggest).
    for (const rise of [0.3, 0.43]) {
      expect(feed(new IntentClassifier(createConfig('seated')), samplesOf(throwPath({ rise }), { to: 1700 }), LAUNCH_ONLY).map(e => e.kind), `seated rise ${rise}`).toEqual(['launch']);
    }
  });

  it('does not fire from a wind-up that is too big (more than 0.5 ih), or from sweeping motion that never slows down', () => {
    expect(feed(new IntentClassifier(createConfig()), samplesOf(throwPath({ rise: 0.6 }), { to: 1700 }), LAUNCH_ONLY)).toEqual([]);

    // A circle at 1.8 ih/s: its descending side is fast and was preceded by a rise, but it never pauses.
    const circle: Path = t => {
      const angle = (1.8 / 0.15) * (t / 1000);
      return { x: 0.7 + 0.15 * Math.cos(angle), y: 0.4 + 0.15 * Math.sin(angle) };
    };
    expect(feed(new IntentClassifier(createConfig()), samplesOf(circle, { to: 3000 }), LAUNCH_ONLY)).toEqual([]);
  });

  it('a wind-up that sweeps across its top is an arc, not a throw: the hand must turn round, not go sideways at speed', () => {
    // The same rise and the same stroke; only the hand's sideways speed across the top differs.
    const arc = (sweep: number) => samplesOf(throwPath({ rise: 0.3, sweep }), { to: 1700 });
    expect(feed(new IntentClassifier(createConfig()), arc(0), LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
    expect(feed(new IntentClassifier(createConfig()), arc(0.4), LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
    expect(feed(new IntentClassifier(createConfig()), arc(1.2), LAUNCH_ONLY)).toEqual([]);
  });

  it('a diagonal wind-up (Luis winds up along a slant: up to 48° from vertical) still counts, a flat sweep with a bump in it does not', () => {
    const slanted = (slant: number) => feed(new IntentClassifier(createConfig()), samplesOf(throwPath({ rise: 0.3, slant }), { to: 1700 }), LAUNCH_ONLY).map(e => e.kind);
    expect(slanted(0.3 * Math.tan((48 * Math.PI) / 180))).toEqual(['launch']);
    expect(slanted(0.3 * Math.tan((70 * Math.PI) / 180))).toEqual([]);
  });

  it('a throw that sets off down slowly (up to a quarter of a second from the apex to the launch speed) still counts, one that began lower down does not', () => {
    const slow = (slowDrop: number, slowMs: number) => feed(new IntentClassifier(createConfig()), samplesOf(throwPath({ rise: 0.25, slowMs, slowDrop }), { to: 2000 }), LAUNCH_ONLY).map(e => e.kind);
    // 0.1 ih down in 250 ms (0.4 ih/s, under the launch speed), then the stroke: 0.4 of the rise below the apex.
    expect(slow(0.1, 250)).toEqual(['launch']);
    // 0.3 ih below the apex before the stroke begins: further than the wind-up rose, so not a wind-up at all.
    expect(slow(0.3, 600)).toEqual([]);
  });

  it('the top must be the top of the wind-up window: a bounce below a higher point of the last 700 ms is not a wind-up', () => {
    // The hand ends up at y = 0.5 and sets off from there after a small rise (0.1 ih, 0.6 to 0.5)...
    const bounce = (higher: boolean): Path => t => {
      const first = higher ? 0.45 * minJerk((t - 400) / 300) : 0;
      const down = higher ? 0.15 * minJerk((t - 800) / 400) : 0;
      const small = 0.1 * minJerk((t - 1450) / 100);
      return { x: BASE.x, y: (higher ? 0.9 : 0.6) - first + down - small + 0.25 * minJerk((t - 1550) / 160) };
    };
    expect(feed(new IntentClassifier(createConfig()), samplesOf(bounce(false), { to: 2200 }), LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
    // ...but if it had been up at 0.45 a moment before, the 0.5 is a point of a descent, not the top of a wind-up.
    expect(feed(new IntentClassifier(createConfig()), samplesOf(bounce(true), { to: 2200 }), LAUNCH_ONLY)).toEqual([]);
  });

  it('needs the speed sustained: one fast interval is not a launch', () => {
    // 0.07 ih in one frame (2.1 ih/s) and then nothing: a single outlier-like jerk.
    const path: Path = t => ({ x: HOME.x, y: HOME.y + (t >= 800 ? 0.07 : 0) });
    expect(feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1500 }), LAUNCH_ONLY)).toEqual([]);
  });

  it('needs the stroke to point down: sideways and upward strokes do not fire', () => {
    const sideways = moveAt(HOME, 700, 200, { x: 0.2, y: 0.08 });
    expect(feed(new IntentClassifier(createConfig()), samplesOf(sideways, { to: 1500 }), LAUNCH_ONLY)).toEqual([]);
    const upward = moveAt(HOME, 700, 200, { x: 0, y: -0.2 });
    expect(feed(new IntentClassifier(createConfig()), samplesOf(upward, { to: 1500 }), LAUNCH_ONLY)).toEqual([]);
  });

  it('needs a quiet hand before the stroke: a stroke out of a slow drift does not fire', () => {
    // Drifting down at 0.5 ih/s for a second, then accelerating.
    const drift = moveAt(HOME, 0, 3000, { x: 0, y: 1.0 });
    const path: Path = t => {
      const d = drift(t);
      return { x: d.x, y: d.y + (t > 900 ? 0.2 * minJerk((t - 900) / 200) : 0) };
    };
    const events = feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1500 }), LAUNCH_ONLY);
    expect(events).toEqual([]);
  });

  it('is robust to jitter: seeded noise still launches, a still hand never does', () => {
    const rng = new Random(5);
    let hits = 0;
    const runs = 60;
    for (let i = 0; i < runs; i++) {
      const path = moveAt(HOME, 700, 190, { x: 0.01, y: 0.24 });
      const events = feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1400, rng, phase: rng.range(0, FRAME) }), LAUNCH_ONLY);
      if (events.length === 1) hits++;
      expect(events.length).toBeLessThanOrEqual(1);
    }
    expect(hits / runs).toBeGreaterThan(0.9);

    const still = samplesOf(() => HOME, { to: 60_000, rng });
    expect(feed(new IntentClassifier(createConfig()), still, LAUNCH_ONLY)).toEqual([]);
  });
});

describe('IntentClassifier: a stroke over stretched intervals (dropped frames, a hand lost for a moment)', () => {
  /** Calm for 600 ms, then the samples given as [ms after the last calm sample, ih below HOME]. */
  function calmThen(points: ReadonlyArray<readonly [number, number]>): { samples: AnchorSample[]; t0: number } {
    const calm = samplesOf(() => HOME, { to: 600 });
    const t0 = calm[calm.length - 1].timestampMs;
    return { samples: [...calm, ...points.map(([dt, dy]) => sampleAt(t0 + dt, { x: HOME.x, y: HOME.y + dy }))], t0 };
  }
  const run = (samples: AnchorSample[]) => feed(new IntentClassifier(createConfig()), samples, LAUNCH_ONLY);

  it('counts frames of the 30 fps clock: one interval stands for as many frames as it spans', () => {
    expect([10, 25, 33.3, 41, 49].map(framesSpanned)).toEqual([1, 1, 1, 1, 1]);
    expect([50, 66.7, 83].map(framesSpanned)).toEqual([2, 2, 2]);
    expect([84, 100, 116].map(framesSpanned)).toEqual([3, 3, 3]);
    expect(framesSpanned(133)).toBe(4);
  });

  it('a stroke that is one 100 ms interval (0.2 ih, 2 ih/s) fires on the sample after it, which shows the hand stayed down', () => {
    const { samples, t0 } = calmThen([[100, 0.2], [133, 0.205], [166, 0.205]]);
    const events = run(samples);
    expect(events.map(e => e.kind)).toEqual(['launch']);
    // Not on the stretched interval itself: one observation of the hand is what a glitch looks like too.
    expect(events[0].timestampMs).toBeCloseTo(t0 + 133, 6);
    expect(events[0].strength).toBeGreaterThan(1.9);
  });

  it('the same jump that comes straight back is a glitch, not a stroke', () => {
    const { samples } = calmThen([[100, 0.2], [133, 0], [166, 0], [200, 0]]);
    expect(run(samples)).toEqual([]);
  });

  it('a wrong frame that put the hand 0.2 ih ABOVE where it rests, and the hand «falling» back to it, is not a stroke either', () => {
    const { samples } = calmThen([[33, -0.2], [133, 0], [166, 0], [200, 0]]);
    expect(run(samples)).toEqual([]);
  });

  it('a stroke that straddles a hand lost for two frames, with a calm hand behind it, still fires (the history survives a short absence)', () => {
    const c = new IntentClassifier(createConfig());
    const calm = samplesOf(() => HOME, { to: 600 });
    feed(c, calm, LAUNCH_ONLY);
    const t0 = calm[calm.length - 1].timestampMs;
    expect(c.absent(t0 + 33, t0 + 83, undefined, LAUNCH_ONLY)).toBeNull();
    expect(c.absent(t0 + 67, t0 + 117, undefined, LAUNCH_ONLY)).toBeNull();
    // It comes back 0.2 ih lower after 100 ms, and stays there.
    const events = feed(c, [sampleAt(t0 + 100, { x: HOME.x, y: HOME.y + 0.2 }), sampleAt(t0 + 133, { x: HOME.x, y: HOME.y + 0.205 })], LAUNCH_ONLY);
    expect(events.map(e => e.kind)).toEqual(['launch']);
  });

  it('a hand lost for longer than perception.strokeGapMs takes the history with it: what came before cannot help a stroke after', () => {
    const c = new IntentClassifier(createConfig());
    const calm = samplesOf(() => HOME, { to: 600 });
    feed(c, calm, LAUNCH_ONLY);
    const t0 = calm[calm.length - 1].timestampMs;
    const limit = createConfig().perception.strokeGapMs;
    for (let t = 33; t < limit + 40; t += 33) expect(c.absent(t0 + t, t0 + t + 50, undefined, LAUNCH_ONLY)).toBeNull();
    // Two fast intervals right after, flagged continuous (as an extractor that lost the track would not): with the calm history gone there is no quiet window behind them.
    const tb = t0 + limit + 80;
    const fast = [1, 2, 3].map(i => sampleAt(tb + FRAME * i, { x: HOME.x, y: HOME.y + 0.06 * i }));
    expect(feed(c, fast, LAUNCH_ONLY)).toEqual([]);
  });

  it('perception.strokeGapMs applies live: a 40 ms limit forgets the history at the second lost frame', () => {
    const calm = samplesOf(() => HOME, { to: 600 });
    const t0 = calm[calm.length - 1].timestampMs;
    const lose = (config: ReturnType<typeof createConfig>) => {
      const c = new IntentClassifier(createConfig());
      feed(c, calm, LAUNCH_ONLY);
      c.setConfig(config);
      c.absent(t0 + 33, t0 + 83, undefined, LAUNCH_ONLY);
      c.absent(t0 + 67, t0 + 117, undefined, LAUNCH_ONLY);
      return feed(c, [sampleAt(t0 + 100, { x: HOME.x, y: HOME.y + 0.2 }), sampleAt(t0 + 133, { x: HOME.x, y: HOME.y + 0.205 })], LAUNCH_ONLY);
    };
    expect(lose(createConfig())).toHaveLength(1);
    expect(lose(setConfigValue(createConfig(), 'perception.strokeGapMs', 40))).toEqual([]);
  });
});

describe('IntentClassifier: tug', () => {
  const flick = (start = 800, peakDy = -0.09, durationMs = 150) => moveAt(HOME, start, durationMs, { x: 0.005, y: peakDy });

  it('fires within two frames of a quick upward flick after a calm hand', () => {
    const events = feed(new IntentClassifier(createConfig()), samplesOf(flick(), { to: 1800 }), TUG_ONLY);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('tug');
    expect(events[0].timestampMs - 800).toBeLessThan(110);
    expect(events[0].strength).toBeGreaterThan(0.5);
  });

  it('fires through jitter and while the hand sways sideways', () => {
    const rng = new Random(9);
    const swayAndFlick = (f: number, amp: number): Path => t => {
      const fl = flick()(t);
      return { x: fl.x + amp * Math.sin(2 * Math.PI * f * (t / 1000)), y: fl.y };
    };
    let hits = 0;
    const runs = 80;
    for (let i = 0; i < runs; i++) {
      const path = i % 2 ? swayAndFlick(0.8, 0.05) : flick();
      hits += feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1800, rng, phase: rng.range(0, FRAME) }), TUG_ONLY).length > 0 ? 1 : 0;
    }
    expect(hits / runs).toBeGreaterThan(0.85);
  });

  it('does not fire for a flick that is too small, pointing sideways or going down', () => {
    expect(feed(new IntentClassifier(createConfig()), samplesOf(flick(800, -0.03), { to: 1800 }), TUG_ONLY)).toEqual([]);
    const sideways = moveAt(HOME, 800, 150, { x: 0.1, y: -0.05 });
    expect(feed(new IntentClassifier(createConfig()), samplesOf(sideways, { to: 1800 }), TUG_ONLY)).toEqual([]);
    expect(feed(new IntentClassifier(createConfig()), samplesOf(flick(800, 0.09), { to: 1800 }), TUG_ONLY)).toEqual([]);
  });

  it('needs a calm hand: slow upward repositioning is not a tug, however far it goes', () => {
    const rng = new Random(21);
    for (const peak of [0.3, 0.45]) {
      const durationMs = (1.875 * 0.25 * 1000) / peak;
      const path = moveAt({ x: 0.7, y: 0.6 }, 700, durationMs, { x: 0, y: -0.25 });
      for (let i = 0; i < 10; i++) {
        expect(feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 2800, rng, phase: rng.range(0, FRAME) }), TUG_ONLY)).toEqual([]);
      }
    }
  });

  it('needs the hand not to be drifting up: a flick out of a steady upward drift does not fire', () => {
    // 0.25 ih/s of upward drift (inside the PRD's 0.35 ih/s «relatively still») that stops only when the flick starts.
    const drift = (rate: number): Path => t => ({ x: HOME.x, y: HOME.y + 0.5 - rate * (Math.min(t, 850) - 250) / 1000 });
    const flick = moveAt({ x: 0, y: 0 }, 850, 150, { x: 0, y: -0.09 });
    const withFlick = (rate: number): Path => t => {
      const d = drift(rate)(t), f = flick(t);
      return { x: d.x, y: d.y + f.y };
    };
    expect(feed(new IntentClassifier(createConfig()), samplesOf(withFlick(0.25), { to: 1600 }), TUG_ONLY)).toEqual([]);
    // Control: the same flick from a hand that was still all along fires.
    expect(feed(new IntentClassifier(createConfig()), samplesOf(moveAt(HOME, 850, 150, { x: 0, y: -0.09 }), { to: 1600 }), TUG_ONLY)).toHaveLength(1);
  });

  it('a hand settling downward can still tug: only upward drift looks like the start of a tug', () => {
    const settle: Path = t => ({ x: HOME.x, y: HOME.y + 0.1 * (1 - Math.exp(-(t - 200) / 300)) * (t > 200 ? 1 : 0) });
    const flick = moveAt({ x: 0, y: 0 }, 1100, 150, { x: 0, y: -0.09 });
    const path: Path = t => {
      const d = settle(t), f = flick(t);
      return { x: d.x, y: d.y + f.y };
    };
    expect(feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1900 }), TUG_ONLY)).toHaveLength(1);
  });

  it('never fires on 60 s of pure jitter or of a sleeper swaying', () => {
    const rng = new Random(33);
    expect(feed(new IntentClassifier(createConfig()), samplesOf(() => HOME, { to: 60_000, rng }), TUG_ONLY)).toEqual([]);
    const sway: Path = t => ({ x: HOME.x + 0.05 * Math.sin(2 * Math.PI * 0.8 * (t / 1000)), y: HOME.y + 0.012 * Math.sin(2 * Math.PI * 0.5 * (t / 1000)) });
    expect(feed(new IntentClassifier(createConfig()), samplesOf(sway, { to: 60_000, rng }), TUG_ONLY)).toEqual([]);
  });

  it('ignores a one-frame jump even if the extractor let it through', () => {
    // 0.15 ih up for one frame, then back: a tracking glitch, not a hand.
    const rng = new Random(2);
    const samples = samplesOf(() => HOME, { to: 1600, rng });
    const glitch = samples.findIndex(s => s.timestampMs > 900);
    samples[glitch] = { ...samples[glitch], y: samples[glitch].y - 0.15 };
    expect(feed(new IntentClassifier(createConfig()), samples, TUG_ONLY)).toEqual([]);
  });
});

describe('IntentClassifier: arming, refractory, freshness, continuity', () => {
  const stroke = moveAt(HOME, 700, 200, { x: 0.01, y: 0.2 });
  const flick = moveAt(HOME, 800, 150, { x: 0, y: -0.09 });

  it('stays silent for intents that are not armed', () => {
    expect(feed(new IntentClassifier(createConfig()), samplesOf(stroke, { to: 1500 }), TUG_ONLY)).toEqual([]);
    expect(feed(new IntentClassifier(createConfig()), samplesOf(flick, { to: 1500 }), LAUNCH_ONLY)).toEqual([]);
    expect(feed(new IntentClassifier(createConfig()), samplesOf(stroke, { to: 1500 }), { launch: false, tug: false })).toEqual([]);
    expect(feed(new IntentClassifier(createConfig()), samplesOf(stroke, { to: 1500 }), BOTH).map(e => e.kind)).toEqual(['launch']);
  });

  it('keeps history while unarmed: arming mid-calm still allows a tug at once', () => {
    const c = new IntentClassifier(createConfig());
    const samples = samplesOf(flick, { to: 1600 });
    const events: IntentEvent[] = [];
    for (const s of samples) {
      const e = c.push(s, s.timestampMs < 700 ? { launch: false, tug: false } : TUG_ONLY);
      if (e) events.push(e);
    }
    expect(events.map(e => e.kind)).toEqual(['tug']);
  });

  it('is silent for the refractory period after any event, then listens again', () => {
    // Two clean strokes 800 ms apart, the second out of a long calm.
    const first = moveAt(HOME, 700, 200, { x: 0, y: 0.2 });
    const second = moveAt({ x: HOME.x, y: HOME.y + 0.2 }, 1500, 200, { x: 0, y: 0.2 });
    const path: Path = t => (t < 1499 ? first(t) : second(t));
    const samples = samplesOf(path, { to: 2400 });

    const normal = feed(new IntentClassifier(createConfig()), samples, LAUNCH_ONLY);
    expect(normal.map(e => e.kind)).toEqual(['launch', 'launch']);

    // With a refractory longer than the gap, the second stroke (≈ 800 ms after the first event) is swallowed.
    const slow = feed(new IntentClassifier(setConfigValue(createConfig(), 'refractoryMs', 1200)), samples, LAUNCH_ONLY);
    expect(slow.map(e => e.kind)).toEqual(['launch']);
  });

  it('applies the refractory to every kind: a tug right after a launch is swallowed', () => {
    const down = moveAt(HOME, 700, 200, { x: 0, y: 0.2 });
    const up = moveAt({ x: HOME.x, y: HOME.y + 0.2 }, 1500, 150, { x: 0, y: -0.09 });
    const path: Path = t => (t < 1499 ? down(t) : up(t));
    const samples = samplesOf(path, { to: 2400 });
    expect(feed(new IntentClassifier(createConfig()), samples, BOTH).map(e => e.kind)).toEqual(['launch', 'tug']);
    expect(feed(new IntentClassifier(setConfigValue(createConfig(), 'refractoryMs', 1200)), samples, BOTH).map(e => e.kind)).toEqual(['launch']);
  });

  it('never fires on a sample older than perception.staleMs, but still learns from it', () => {
    const c = new IntentClassifier(createConfig());
    const samples = samplesOf(stroke, { to: 1500 }).map(s => ({ ...s, arrivalMs: s.timestampMs + 181 }));
    expect(feed(c, samples, LAUNCH_ONLY)).toEqual([]);
    // Fresh samples right after resume firing: the hand is still mid-stroke, so history was kept.
    const fresh = moveAt(HOME, 2000, 200, { x: 0, y: 0.2 });
    const events = feed(new IntentClassifier(createConfig()), samplesOf(fresh, { from: 1500, to: 2800 }).map((s, i) => ({ ...s, continuous: i > 0 })), LAUNCH_ONLY);
    expect(events).toHaveLength(1);
  });

  it('forgets history on a discontinuity: a stroke cut in two does not fire', () => {
    const samples = samplesOf(stroke, { to: 1500 });
    const cut = samples.findIndex(s => s.timestampMs > 760);
    samples[cut] = { ...samples[cut], continuous: false };
    expect(feed(new IntentClassifier(createConfig()), samples, LAUNCH_ONLY)).toEqual([]);
  });

  it('needs fresh quiet history after a discontinuity before it can launch again', () => {
    // A break and, only 100 ms later, a stroke: there is no quiet window to prove the hand was still.
    const path = moveAt(HOME, 800, 200, { x: 0, y: 0.2 });
    const samples = samplesOf(path, { to: 1500 });
    const i = samples.findIndex(s => s.timestampMs > 700);
    samples[i] = { ...samples[i], continuous: false };
    expect(feed(new IntentClassifier(createConfig()), samples, LAUNCH_ONLY)).toEqual([]);
  });

  it('treats a sample that is not a number as a break: no throw, no event, history dropped', () => {
    const c = new IntentClassifier(createConfig());
    const samples = samplesOf(stroke, { to: 1500 });
    const poisoned = samples.map((s, i) => (i === 10 ? { ...s, y: Number.NaN } : i === 11 ? { ...s, timestampMs: Number.NaN } : i === 12 ? { ...s, x: Infinity } : s));
    const events = feed(c, poisoned, LAUNCH_ONLY);
    // The stroke at 700 ms comes long after the bad samples: it still launches from a fresh calm history.
    expect(events.map(e => e.kind)).toEqual(['launch']);
    for (const e of events) expect(Number.isFinite(e.strength)).toBe(true);
    expect(() => feed(new IntentClassifier(createConfig()), [sampleAt(0, { x: Number.NaN, y: Number.NaN })], BOTH)).not.toThrow();
  });

  it('ignores samples that do not advance the clock', () => {
    const c = new IntentClassifier(createConfig());
    const samples = samplesOf(stroke, { to: 1500 });
    const withDuplicates = samples.flatMap(s => [s, s]);
    expect(feed(c, withDuplicates, LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
  });

  it('reset() forgets history and the refractory period', () => {
    const c = new IntentClassifier(createConfig());
    expect(feed(c, samplesOf(stroke, { to: 1500 }), LAUNCH_ONLY)).toHaveLength(1);
    c.reset();
    expect(feed(c, samplesOf(stroke, { to: 1500 }), LAUNCH_ONLY)).toHaveLength(1);
  });

  it('is deterministic', () => {
    const run = () => feed(new IntentClassifier(createConfig()), samplesOf(stroke, { to: 1500, rng: new Random(7) }), BOTH);
    expect(run()).toEqual(run());
  });

  it('applies live configuration changes', () => {
    const c = new IntentClassifier(createConfig());
    c.setConfig(setConfigValue(createConfig(), 'launch.minDownSpeed', 2.6));
    expect(feed(c, samplesOf(stroke, { to: 1500 }), LAUNCH_ONLY)).toEqual([]);
    const lenient = new IntentClassifier(createConfig());
    lenient.setConfig(setConfigValue(createConfig(), 'launch.minDownSpeed', 0.8));
    expect(feed(lenient, samplesOf(stroke, { to: 1500 }), LAUNCH_ONLY)).toHaveLength(1);
  });
});

describe('IntentClassifier: absent()', () => {
  const STALE = 180;
  /** A calm hand at HOME, then one fast downward interval (`dy` ih in a frame), as a throw that is about to leave the frame. */
  function throwSamples(dy: number, options: { dx?: number; windup?: boolean } = {}): AnchorSample[] {
    const calm = samplesOf(() => HOME, { to: 600 });
    const out = [...calm];
    let t = calm[calm.length - 1].timestampMs;
    let y = HOME.y;
    if (options.windup) {
      // 0.06 ih up over 6 frames, then the fast interval: no quiet window of 250 ms right before.
      for (let i = 1; i <= 6; i++) { t += FRAME; y -= 0.01; out.push(sampleAt(t, { x: HOME.x, y })); }
    }
    t += FRAME;
    out.push(sampleAt(t, { x: HOME.x + (options.dx ?? 0), y: y + dy }));
    return out;
  }
  const lastOf = (samples: AnchorSample[]) => samples[samples.length - 1];
  const exitAt = (samples: AnchorSample[], gapMs = FRAME) => ({ t: lastOf(samples).timestampMs + gapMs, a: lastOf(samples).timestampMs + gapMs + 50 });

  it('completes a launch the hand left through the bottom: one fast interval from stillness, then gone', () => {
    const c = new IntentClassifier(createConfig());
    const samples = throwSamples(0.06);
    expect(feed(c, samples, LAUNCH_ONLY)).toEqual([]);
    const gone = exitAt(samples);
    const event = c.absent(gone.t, gone.a, 'bottom', LAUNCH_ONLY);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('launch');
    // The event carries the absence's timestamps, and the strength of the stroke that was underway.
    expect(event!.timestampMs).toBe(gone.t);
    expect(event!.arrivalMs).toBe(gone.a);
    expect(event!.strength).toBeGreaterThan(1.7);
    expect(event!.strength).toBeLessThan(1.9);
  });

  it('also from a wind-up, where there is no quiet window right before the stroke', () => {
    const c = new IntentClassifier(createConfig());
    const samples = throwSamples(0.07, { windup: true });
    feed(c, samples, LAUNCH_ONLY);
    const gone = exitAt(samples);
    expect(c.absent(gone.t, gone.a, 'bottom', LAUNCH_ONLY)?.kind).toBe('launch');
  });

  it('needs the hand to have left through the bottom, and launch to be armed', () => {
    for (const edge of [undefined, 'left', 'right', 'top'] as const) {
      const c = new IntentClassifier(createConfig());
      const samples = throwSamples(0.06);
      feed(c, samples, LAUNCH_ONLY);
      const gone = exitAt(samples);
      expect(c.absent(gone.t, gone.a, edge, LAUNCH_ONLY)).toBeNull();
    }
    for (const armed of [TUG_ONLY, { launch: false, tug: false }]) {
      const c = new IntentClassifier(createConfig());
      const samples = throwSamples(0.06);
      feed(c, samples, armed);
      const gone = exitAt(samples);
      expect(c.absent(gone.t, gone.a, 'bottom', armed)).toBeNull();
    }
  });

  it('needs the stroke to be fast, to point down and to come out of quiet', () => {
    const slow = new IntentClassifier(createConfig());
    const s1 = throwSamples(0.03);
    feed(slow, s1, LAUNCH_ONLY);
    expect(slow.absent(exitAt(s1).t, exitAt(s1).a, 'bottom', LAUNCH_ONLY)).toBeNull();

    const sideways = new IntentClassifier(createConfig());
    const s2 = throwSamples(0.06, { dx: 0.09 });
    feed(sideways, s2, LAUNCH_ONLY);
    expect(sideways.absent(exitAt(s2).t, exitAt(s2).a, 'bottom', LAUNCH_ONLY)).toBeNull();

    // A hand already drifting down at 0.5 ih/s (no wind-up either): moving, not about to throw.
    const moving = new IntentClassifier(createConfig());
    const drift = samplesOf(t => ({ x: HOME.x, y: HOME.y + 0.5 * (t / 1000) }), { to: 800 });
    const last = lastOf(drift);
    const burst = sampleAt(last.timestampMs + FRAME, { x: HOME.x, y: last.y + 0.06 });
    feed(moving, [...drift, burst], LAUNCH_ONLY);
    expect(moving.absent(burst.timestampMs + FRAME, burst.arrivalMs + FRAME, 'bottom', LAUNCH_ONLY)).toBeNull();
  });

  it('is silent when the evidence is stale, or when the stroke ended long before the hand vanished', () => {
    const stale = new IntentClassifier(createConfig());
    const samples = throwSamples(0.06);
    feed(stale, samples, LAUNCH_ONLY);
    const gone = exitAt(samples);
    expect(stale.absent(gone.t, gone.t + STALE + 1, 'bottom', LAUNCH_ONLY)).toBeNull();

    const late = new IntentClassifier(createConfig());
    feed(late, samples, LAUNCH_ONLY);
    const much = exitAt(samples, createConfig().perception.maxGapMs + 20);
    expect(late.absent(much.t, much.a, 'bottom', LAUNCH_ONLY)).toBeNull();
  });

  it('keeps the motion history through a short absence: the calm hand before it still stands behind a stroke after it', () => {
    const c = new IntentClassifier(createConfig());
    const calm = samplesOf(() => HOME, { to: 600 });
    feed(c, calm, LAUNCH_ONLY);
    const t0 = lastOf(calm).timestampMs;
    expect(c.absent(t0 + FRAME, t0 + FRAME + 50, undefined, LAUNCH_ONLY)).toBeNull();
    // Two fast intervals right after, continuous: the quiet window of the hand that was there before the lost frame is the precondition.
    const fast = [1, 2, 3].map(i => sampleAt(t0 + FRAME * (1 + i), { x: HOME.x, y: HOME.y + 0.06 * i }));
    expect(feed(c, fast, LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
  });

  it('forgets it when the extractor says the hand that came back does not continue it (continuous: false), and when a long absence outlasted it', () => {
    const c = new IntentClassifier(createConfig());
    const calm = samplesOf(() => HOME, { to: 600 });
    feed(c, calm, LAUNCH_ONLY);
    const t0 = lastOf(calm).timestampMs;
    expect(c.absent(t0 + FRAME, t0 + FRAME + 50, undefined, LAUNCH_ONLY)).toBeNull();
    const fast = [1, 2, 3].map(i => sampleAt(t0 + FRAME * (1 + i), { x: HOME.x, y: HOME.y + 0.06 * i }, { continuous: i > 1 }));
    expect(feed(c, fast, LAUNCH_ONLY)).toEqual([]);
  });

  it('a launch that fires on the exit ends the history: the hand that comes back starts from nothing', () => {
    const c = new IntentClassifier(createConfig());
    const samples = throwSamples(0.06);
    feed(c, samples, LAUNCH_ONLY);
    const gone = exitAt(samples);
    expect(c.absent(gone.t, gone.a, 'bottom', LAUNCH_ONLY)?.kind).toBe('launch');
    // Past the refractory, with no quiet window and no wind-up behind them, two fast intervals are not a launch.
    const tb = gone.t + createConfig().refractoryMs + 100;
    const fast = [0, 1, 2].map(i => sampleAt(tb + FRAME * i, { x: HOME.x, y: HOME.y + 0.06 * i }, { continuous: true }));
    expect(feed(c, fast, LAUNCH_ONLY)).toEqual([]);
  });

  it('keeps the refractory timer: a hand that comes back cannot fire again within refractoryMs, and reset() forgets it', () => {
    // First throw leaves the frame; 700 ms later the hand is back, calm for 600 ms, and throws again.
    function twoThrows(config: ReturnType<typeof createConfig>, resetBetween = false) {
      const c = new IntentClassifier(config);
      const first = throwSamples(0.06);
      feed(c, first, LAUNCH_ONLY);
      const gone = exitAt(first);
      const fired = c.absent(gone.t, gone.a, 'bottom', LAUNCH_ONLY);
      if (resetBetween) c.reset();
      const back = samplesOf(() => HOME, { from: gone.t + 100, to: gone.t + 700 });
      feed(c, back, LAUNCH_ONLY);
      const again = sampleAt(lastOf(back).timestampMs + FRAME, { x: HOME.x, y: HOME.y + 0.06 });
      feed(c, [again], LAUNCH_ONLY);
      const second = c.absent(again.timestampMs + FRAME, again.arrivalMs + FRAME, 'bottom', LAUNCH_ONLY);
      return { fired, second };
    }
    const normal = twoThrows(createConfig());
    expect(normal.fired?.kind).toBe('launch');
    expect(normal.second?.kind).toBe('launch');

    const long = setConfigValue(createConfig(), 'refractoryMs', 1000);
    const blocked = twoThrows(long);
    expect(blocked.fired?.kind).toBe('launch');
    expect(blocked.second).toBeNull();
    // reset() clears the refractory timer along with the history; absent() alone does not.
    expect(twoThrows(long, true).second?.kind).toBe('launch');
  });

  it('does not fire twice for one throw: a launch already fired by push() leaves nothing for the absence', () => {
    const c = new IntentClassifier(createConfig());
    const calm = samplesOf(() => HOME, { to: 600 });
    const t0 = lastOf(calm).timestampMs;
    const stroke = [1, 2].map(i => sampleAt(t0 + FRAME * i, { x: HOME.x, y: HOME.y + 0.06 * i }));
    expect(feed(c, [...calm, ...stroke], LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
    const t = lastOf(stroke).timestampMs + FRAME;
    expect(c.absent(t, t + 50, 'bottom', LAUNCH_ONLY)).toBeNull();
  });
});

describe('IntentClassifier: launch reading', () => {
  /** A stroke given directly as interval displacements (ih) from a calm hand: lets a test script exact velocities. */
  function strokeOf(steps: number[]): AnchorSample[] {
    const calm = samplesOf(() => HOME, { to: 600 });
    const out = [...calm];
    let t = lastOf(calm).timestampMs, y = HOME.y;
    for (const dy of steps) { t += FRAME; y += dy; out.push(sampleAt(t, { x: HOME.x, y })); }
    return out;
  }
  const lastOf = (samples: AnchorSample[]) => samples[samples.length - 1];
  const speed = (ihPerSecond: number) => (ihPerSecond * FRAME) / 1000;

  it('strict is the default, and fires only when every interval is fast', () => {
    const c = new IntentClassifier(createConfig());
    expect(feed(c, strokeOf([speed(1.0), speed(1.5)]), LAUNCH_ONLY)).toEqual([]);
    expect(feed(new IntentClassifier(createConfig(), { launchReading: 'strict' }), strokeOf([speed(1.3), speed(1.5)]), LAUNCH_ONLY).map(e => e.kind)).toEqual(['launch']);
  });

  it('mean accepts a stroke whose average is fast and whose latest interval is fast, though an interval is below the threshold', () => {
    const mean = new IntentClassifier(createConfig(), { launchReading: 'mean' });
    const events = feed(mean, strokeOf([speed(1.0), speed(1.5)]), LAUNCH_ONLY);
    expect(events.map(e => e.kind)).toEqual(['launch']);
    expect(events[0].strength).toBeCloseTo(1.5, 6);
  });

  it('mean rejects a stall (the latest interval slow) and a window with an interval below 0.6 × the threshold', () => {
    const stall = new IntentClassifier(createConfig(), { launchReading: 'mean' });
    expect(feed(stall, strokeOf([speed(1.8), speed(1.1)]), LAUNCH_ONLY)).toEqual([]);
    const dip = new IntentClassifier(createConfig(), { launchReading: 'mean' });
    expect(feed(dip, strokeOf([speed(0.5), speed(1.9)]), LAUNCH_ONLY)).toEqual([]);
  });

  it('mean accepts everything strict accepts, on the same samples', () => {
    const rng = new Random(41);
    for (let i = 0; i < 40; i++) {
      const path = moveAt(HOME, 700, rng.range(150, 260), { x: rng.range(-0.05, 0.05), y: rng.range(0.15, 0.3) });
      const samples = samplesOf(path, { to: 1500, rng, phase: rng.range(0, FRAME) });
      const strict = feed(new IntentClassifier(createConfig(), { launchReading: 'strict' }), samples, LAUNCH_ONLY);
      const mean = feed(new IntentClassifier(createConfig(), { launchReading: 'mean' }), samples, LAUNCH_ONLY);
      if (strict.length) {
        expect(mean).toHaveLength(1);
        expect(mean[0].timestampMs).toBeLessThanOrEqual(strict[0].timestampMs);
      }
    }
  });
});

describe('IntentClassifier: sample rate', () => {
  const stroke = moveAt(HOME, 700, 200, { x: 0.01, y: 0.2 });
  const flick = moveAt(HOME, 800, 150, { x: 0.005, y: -0.09 });

  it('detects the same gestures from a 60 Hz or 100 Hz pointer as from a 30 Hz camera', () => {
    for (const [path, armed, kind] of [[stroke, LAUNCH_ONLY, 'launch'], [flick, TUG_ONLY, 'tug']] as const) {
      const camera = feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1800 }), armed);
      expect(camera.map(e => e.kind)).toEqual([kind]);
      for (const periodMs of [1000 / 60, 10]) {
        const fast = feed(new IntentClassifier(createConfig()), samplesOf(path, { to: 1800, periodMs }), armed);
        expect(fast.map(e => e.kind)).toEqual([kind]);
        // Thinned to about the camera rate, so the event lands within a couple of frames of the camera's.
        expect(Math.abs(fast[0].timestampMs - camera[0].timestampMs)).toBeLessThan(2 * FRAME);
      }
    }
  });

  it('never thins a camera: frames with ±2 ms of timestamp jitter all count', () => {
    const rng = new Random(77);
    let hits = 0;
    const runs = 60;
    for (let i = 0; i < runs; i++) {
      const events = feed(new IntentClassifier(createConfig()), samplesOf(flick, { to: 1800, rng, jitterMs: 2, phase: rng.range(0, FRAME) }), TUG_ONLY);
      hits += events.length > 0 ? 1 : 0;
    }
    // Same detection rate as the jittered-position runs of the tug tests, i.e. nothing is lost to spacing.
    expect(hits / runs).toBeGreaterThan(0.85);
  });
});

describe('IntentClassifier: every threshold comes from YoyoConfig and applies live', () => {
  const fresh = () => new IntentClassifier(createConfig());
  /** A classifier that starts on the defaults and is retuned through setConfig, the way the advanced panel does it. */
  const retuned = (key: string, value: number) => {
    const c = fresh();
    c.setConfig(setConfigValue(createConfig(), key, value));
    return c;
  };

  const flick = moveAt(HOME, 800, 150, { x: 0.005, y: -0.09 });
  /** The default flick on top of a hand that is also doing something else, given as the extra height at time t. */
  const flickWith = (extraY: (t: number) => number): Path => t => {
    const f = flick(t);
    return { x: f.x, y: f.y + extraY(t) };
  };
  const leaningFlick = (deg: number) => moveAt(HOME, 800, 150, { x: 0.09 * Math.tan((deg * Math.PI) / 180), y: -0.09 });
  /** Hand settling downward at `rate` ih/s until the flick starts. */
  const settling = (rate: number) => flickWith(t => (rate * Math.min(t, 800)) / 1000);
  /** Hand drifting upward at `rate` ih/s until the flick starts. */
  const drifting = (rate: number) => flickWith(t => 0.5 - (rate * Math.min(t, 800)) / 1000);
  /** Upward drift at `rate` ih/s between 300 and 600 ms, then 200 ms of calm before the flick. */
  const driftedEarlier = (rate: number) => flickWith(t => 0.5 - (rate * Math.max(0, Math.min(t, 600) - 300)) / 1000);
  /** Upward drift at `rate` ih/s only over the last 150 ms before the flick. */
  const driftingLately = (rate: number) => flickWith(t => 0.5 - (rate * Math.max(0, Math.min(t, 800) - 650)) / 1000);
  const tug = (path: Path, options: { periodMs?: number } = {}) => samplesOf(path, { to: 1800, ...options });

  /** A calm hand and then a stroke given directly as per-frame displacements (ih). */
  function strokeOf(steps: number[]): AnchorSample[] {
    const out = samplesOf(() => HOME, { to: 600 });
    let t = out[out.length - 1].timestampMs, y = HOME.y;
    for (const dy of steps) { t += FRAME; y += dy; out.push(sampleAt(t, { x: HOME.x, y })); }
    return out;
  }
  /** A fast down-stroke (1.35, 1.5, 1.65 ih/s) to follow the steps that lead up to it. */
  const STROKE = [0.045, 0.05, 0.055];

  interface Case { name: string; key: string; value: number; samples: AnchorSample[]; armed: ArmedIntents }
  /** With the default config the samples give exactly one event; with `key` set to `value` they give none. */
  const rejectedWhenRetuned: Case[] = [
    { name: 'a flick must climb at 2.5 × the PRD mean speed', key: 'tug.minSpeedFactor', value: 2.5, samples: tug(flick), armed: TUG_ONLY },
    { name: 'a flick 35° off vertical must stay within half the angle limit', key: 'tug.angleShare', value: 0.5, samples: tug(leaningFlick(35)), armed: TUG_ONLY },
    { name: 'no interval of the flick may move more than 0.03 ih', key: 'tug.maxStep', value: 0.03, samples: tug(flick), armed: TUG_ONLY },
    { name: 'the sample two frames before must sit within 0.1 of the rise around the baseline', key: 'tug.abruptTolerance', value: 0.1, samples: tug(flick), armed: TUG_ONLY },
    { name: 'the first sample must sit within 0.1 of the rise around the baseline of a hand settling at 0.18 ih/s', key: 'tug.startTolerance', value: 0.1, samples: tug(settling(0.18)), armed: TUG_ONLY },
    { name: 'a hand settling downward at 0.15 ih/s is no longer calm at a 0.05 ih/s limit', key: 'tug.calmDownVy', value: 0.05, samples: tug(settling(0.15)), armed: TUG_ONLY },
    { name: 'a hand drifting up at 0.05 ih/s is no longer calm at a 0.02 ih/s limit', key: 'tug.calmUpVy', value: 0.02, samples: tug(drifting(0.05)), armed: TUG_ONLY },
    { name: 'a hand drifting up at 0.08 ih/s breaks a 0.06 ih/s limit over the whole window', key: 'tug.longUpVy', value: 0.06, samples: tug(drifting(0.08)), armed: TUG_ONLY },
    { name: 'a 400 ms calm window reaches back into a drift that the 200 ms one never sees', key: 'tug.calmWindowMs', value: 400, samples: tug(driftedEarlier(0.3)), armed: TUG_ONLY },
    { name: 'a 60 Hz pointer is no longer thinned to 30 Hz, so «3 frames» become 50 ms', key: 'perception.minSampleSpacingMs', value: 5, samples: tug(flick, { periodMs: 1000 / 60 }), armed: TUG_ONLY },
    // Two slow frames, then 1.35 ih/s: the quiet window only passes if it may stop one sample before the stroke.
    { name: 'the quiet window may not end before the stroke (no slack)', key: 'launch.stillEndSlack', value: 0, samples: strokeOf([0.03, 0.03, ...STROKE]), armed: LAUNCH_ONLY },
    // A 0.1 ih wind-up that turns at 0.06 ih/s: there is no quiet window, so the wind-up must carry the launch.
    { name: 'a wind-up must slow to 2 % of the launch speed at its top', key: 'launch.windupApexFraction', value: 0.02, samples: strokeOf([...Array(6).fill(-0.016), -0.002, 0.002, ...STROKE]), armed: LAUNCH_ONLY },
    { name: 'a 0.3 ih wind-up is over a 0.2 ih ceiling', key: 'launch.windupMaxUp', value: 0.2, samples: samplesOf(throwPath({ rise: 0.3 }), { to: 1700 }), armed: LAUNCH_ONLY },
    { name: 'a wind-up along a 45° slant is over a 30° limit', key: 'launch.windupMaxAngleDeg', value: 30, samples: samplesOf(throwPath({ rise: 0.3, slant: 0.3 }), { to: 1700 }), armed: LAUNCH_ONLY },
    { name: 'an apex swept at 0.5 ih/s sideways is over a 0.3 ih/s limit', key: 'launch.windupSweepSpeed', value: 0.3, samples: samplesOf(throwPath({ rise: 0.3, sweep: 0.5 }), { to: 1700 }), armed: LAUNCH_ONLY },
  ];
  /** The other way round: the default config gives no event, the retuned one gives exactly one. */
  const acceptedWhenRetuned: Case[] = [
    { name: 'a drift of 0.11 ih/s up passes a 0.3 ih/s limit', key: 'tug.calmUpVy', value: 0.3, samples: tug(drifting(0.11)), armed: TUG_ONLY },
    { name: 'a drift over the last 150 ms is diluted by a 300 ms calm window', key: 'tug.calmWindowMs', value: 300, samples: tug(driftingLately(0.11)), armed: TUG_ONLY },
    // (Faster than 0.9 ih/s sideways it would still be stopped by the apex's slowness: windupApexFraction × the launch speed.)
    { name: 'an apex swept at 0.8 ih/s sideways goes through a 1.2 ih/s limit', key: 'launch.windupSweepSpeed', value: 1.2, samples: samplesOf(throwPath({ rise: 0.3, sweep: 0.8 }), { to: 1700 }), armed: LAUNCH_ONLY },
    { name: 'a 0.6 ih wind-up goes through a 0.7 ih ceiling', key: 'launch.windupMaxUp', value: 0.7, samples: samplesOf(throwPath({ rise: 0.6 }), { to: 1700 }), armed: LAUNCH_ONLY },
  ];

  for (const c of rejectedWhenRetuned) {
    it(`${c.key} = ${c.value}: ${c.name}`, () => {
      expect(feed(fresh(), c.samples, c.armed), 'default config').toHaveLength(1);
      expect(feed(retuned(c.key, c.value), c.samples, c.armed), 'retuned live').toEqual([]);
      // setConfig and the constructor read the same field.
      expect(feed(new IntentClassifier(setConfigValue(createConfig(), c.key, c.value)), c.samples, c.armed)).toEqual([]);
    });
  }
  for (const c of acceptedWhenRetuned) {
    it(`${c.key} = ${c.value}: ${c.name}`, () => {
      expect(feed(fresh(), c.samples, c.armed), 'default config').toEqual([]);
      expect(feed(retuned(c.key, c.value), c.samples, c.armed), 'retuned live').toHaveLength(1);
    });
  }

  it('the wind-up scenario really is carried by the wind-up, and the slack scenario by the slack', () => {
    const windup = strokeOf([...Array(6).fill(-0.016), -0.002, 0.002, ...STROKE]);
    expect(feed(retuned('launch.windupMinUp', 0.5), windup, LAUNCH_ONLY)).toEqual([]);
    // With room for slack the quiet window can end earlier still; at 0 it never gets there.
    expect(feed(retuned('launch.stillEndSlack', 2), strokeOf([0.03, 0.03, ...STROKE]), LAUNCH_ONLY)).toHaveLength(1);
  });

  it('a retune in mid-stream applies from the next sample on, keeping the history', () => {
    const c = fresh();
    const samples = tug(flick);
    const cut = samples.findIndex(s => s.timestampMs > 700);
    expect(feed(c, samples.slice(0, cut), TUG_ONLY)).toEqual([]);
    c.setConfig(setConfigValue(createConfig(), 'tug.minSpeedFactor', 2.5));
    expect(feed(c, samples.slice(cut), TUG_ONLY)).toEqual([]);
    // Back to the defaults before the flick has gone by: the history of the calm hand is still there.
    const d = fresh();
    expect(feed(d, samples.slice(0, cut), TUG_ONLY)).toEqual([]);
    d.setConfig(setConfigValue(createConfig(), 'tug.minSpeedFactor', 2.5));
    d.setConfig(createConfig());
    expect(feed(d, samples.slice(cut), TUG_ONLY)).toHaveLength(1);
  });

  it('a zero sample spacing still ignores duplicated and out-of-order timestamps', () => {
    const c = new IntentClassifier(setConfigValue(createConfig(), 'perception.minSampleSpacingMs', 0));
    const samples = samplesOf(moveAt(HOME, 700, 200, { x: 0.01, y: 0.2 }), { to: 1500 });
    const events = feed(c, samples.flatMap(s => [s, { ...s, timestampMs: s.timestampMs - 1 }]), LAUNCH_ONLY);
    expect(events.map(e => e.kind)).toEqual(['launch']);
    expect(Number.isFinite(events[0].strength)).toBe(true);
  });

  it('sizes its ring for the spacing that is configured and for the calm window', () => {
    const base = createConfig();
    expect(ringCapacity(setConfigValue(base, 'perception.minSampleSpacingMs', 5))).toBeGreaterThan(ringCapacity(base));
    // Never unbounded: below 1 ms of spacing the ring stops growing (240 Hz).
    expect(ringCapacity(setConfigValue(base, 'perception.minSampleSpacingMs', 0))).toBe(ringCapacity(setConfigValue(base, 'perception.minSampleSpacingMs', 1)));
    // The calm window counts too once it is the longest one.
    let short = base;
    for (const key of ['launch.stillWindowMs', 'launch.windupWindowMs', 'tug.stillBeforeMs']) short = setConfigValue(short, key, 100);
    expect(ringCapacity(setConfigValue(short, 'tug.calmWindowMs', 400))).toBeGreaterThan(ringCapacity(setConfigValue(short, 'tug.calmWindowMs', 200)));
    // The longest default look-back is the wind-up window, 700 ms (it was 450: 46 slots), plus the stroke at 60 Hz.
    expect(ringCapacity(base)).toBe(61);
  });

  it('the panel fields that tune it exist, and every field of the panel starts inside its range in both presets', () => {
    const keys = CONFIG_FIELDS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ['tug.minSpeedFactor', 'tug.calmUpVy', 'tug.calmWindowMs', 'perception.minSampleSpacingMs']) expect(keys).toContain(key);
    // The thresholds tuned on Luis's real throws are in the panel too, so he can iterate on them live.
    for (const key of ['launch.windupMaxUp', 'launch.windupMaxAngleDeg', 'launch.windupSweepSpeed', 'perception.strokeGapMs']) expect(keys).toContain(key);
    for (const preset of ['standing', 'seated'] as const) {
      const config = createConfig(preset);
      for (const f of CONFIG_FIELDS) {
        const v = getConfigValue(config, f.key);
        expect(f.min < f.max && f.step > 0, `${f.key} range`).toBe(true);
        expect(v >= f.min && v <= f.max, `${preset} ${f.key} = ${v} outside [${f.min}, ${f.max}]`).toBe(true);
      }
    }
  });
});

describe('SampleRing and sizing', () => {
  it('keeps only its capacity of newest samples, in chronological order', () => {
    const ring = new SampleRing(5);
    for (let i = 0; i < 12; i++) ring.push(i * 10, i, -i);
    expect(ring.length).toBe(5);
    expect([0, 1, 2, 3, 4].map(i => ring.at(i).t)).toEqual([70, 80, 90, 100, 110]);
    ring.clear();
    expect(ring.length).toBe(0);
  });

  it('can be resized keeping the newest samples that fit', () => {
    const ring = new SampleRing(6);
    for (let i = 0; i < 6; i++) ring.push(i, i, i);
    const smaller = ring.resized(3);
    expect([0, 1, 2].map(i => smaller.at(i).t)).toEqual([3, 4, 5]);
    const bigger = ring.resized(10);
    expect(bigger.length).toBe(6);
    expect(bigger.at(0).t).toBe(0);
  });

  it('is sized for the longest window at up to 60 Hz and stays that size under a flood of samples', () => {
    const config = createConfig();
    const capacity = ringCapacity(config);
    const longestMs = Math.max(config.launch.stillWindowMs, config.launch.windupWindowMs, config.tug.stillBeforeMs);
    expect(capacity).toBeGreaterThanOrEqual(Math.ceil((longestMs * 60) / 1000) + 4);
    expect(capacity).toBeLessThan(100);

    const c = new IntentClassifier(config);
    for (let i = 0; i < 100_000; i++) c.push(sampleAt(i * 16.7, { x: 0.5, y: 0.5 }, { continuous: i > 0 }), BOTH);
    // Memory cannot be probed directly; the ring contract above plus the loop finishing quickly is the guarantee.
    expect(new SampleRing(capacity).capacity).toBe(capacity);
  });

  it('grows its ring when a longer window is configured, without losing history', () => {
    const c = new IntentClassifier(createConfig());
    const config = setConfigValue(createConfig(), 'tug.stillBeforeMs', 800);
    expect(ringCapacity(config)).toBeGreaterThan(ringCapacity(createConfig()));
    feed(c, samplesOf(() => HOME, { to: 600 }), BOTH);
    c.setConfig(config);
    // After the resize the classifier keeps working on the history it had.
    const events = feed(c, samplesOf(moveAt(HOME, 2400, 200, { x: 0, y: 0.2 }), { from: 600, to: 3200 }).map(s => ({ ...s, continuous: true })), LAUNCH_ONLY);
    expect(events).toHaveLength(1);
  });
});
