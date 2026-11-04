import { describe, expect, it } from 'vitest';
import { createConfig, setConfigValue } from '../config';
import type { AnchorSample } from '../contracts';
import { fitLine, windowSpread } from '../perception/robust';
import { Random } from '../replay/random';
import { DEFAULT_TETHER_ZONE, TetherDetector, zoneCentre, type StableHand, type TetherZone } from './TetherDetector';

/**
 * Tie-on stability detector, SYNTHETIC samples only: noise-free streams where the exact instant of the
 * first possible tie-on can be computed, and streams with the PRD §8.2 jitter. No camera, no human.
 */

const FRAME_MS = 1000 / 30;
/** PRD jitter: σ = 0.5 % of the image width in both axes, in ih. */
const JITTER = 0.0067;

function sample(t: number, x: number, y: number, extra: Partial<AnchorSample> = {}): AnchorSample {
  return { timestampMs: t, arrivalMs: t + 50, source: 'replay', x, y, palmSize: 0.17, continuous: true, ...extra };
}

/** Feeds a path sampled at 30 fps from t = 0 until `untilMs`; returns the time of the first tie-on, or null. */
function firstTieOn(detector: TetherDetector, path: (tMs: number) => [number, number], untilMs: number, options: { noise?: Random; dropChance?: number } = {}): number | null {
  const drops = options.noise ?? new Random(1);
  for (let i = 0; i * FRAME_MS < untilMs; i++) {
    const t = i * FRAME_MS;
    if (options.dropChance && drops.chance(options.dropChance)) continue;
    const [x, y] = path(t);
    const noise = options.noise;
    const result = detector.push(sample(t, x + (noise ? noise.gaussian(0, JITTER) : 0), y + (noise ? noise.gaussian(0, JITTER) : 0)));
    if (result) return t;
  }
  return null;
}

const still = (x = 0.67, y = 0.4) => (): [number, number] => [x, y];

describe('TetherDetector: a still hand', () => {
  it('ties on at the first sample whose window spans stableMs, never before', () => {
    const config = createConfig();
    const detector = new TetherDetector(config);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = i * FRAME_MS;
      if (detector.push(sample(t, 0.67, 0.4))) times.push(t);
    }
    // The window opens at the newest sample at least stableMs old: sample 0 is old enough at t = 400.
    expect(times[0]).toBeGreaterThanOrEqual(config.tether.stableMs);
    expect(times[0]).toBeLessThan(config.tether.stableMs + 1);
  });

  it('reports the window mean as the rest position', () => {
    const detector = new TetherDetector(createConfig());
    let stable: StableHand | null = null;
    const xs: number[] = [];
    for (let i = 0; i < 14; i++) {
      const x = 0.6 + (i % 2 === 0 ? 0.004 : -0.004);
      xs.push(x);
      stable = detector.push(sample(i * FRAME_MS, x, 0.45)) ?? stable;
    }
    expect(stable).not.toBeNull();
    expect(stable!.x).toBeCloseTo(0.6, 2);
    expect(stable!.y).toBeCloseTo(0.45, 12);
  });

  it('with the PRD jitter it still ties on, within two frames of the earliest instant, in all but a handful of 300 runs', () => {
    const config = createConfig();
    const delays: number[] = [];
    let never = 0;
    for (let seed = 0; seed < 300; seed++) {
      const detector = new TetherDetector(config);
      const t = firstTieOn(detector, still(), 1500, { noise: new Random(seed) });
      if (t === null) never++; else delays.push(t);
    }
    delays.sort((a, b) => a - b);
    expect(never).toBe(0);
    expect(delays[0]).toBeGreaterThanOrEqual(config.tether.stableMs);
    // Median: the first possible frame or the next; the 95th percentile within ~3 frames of it.
    expect(delays[Math.floor(delays.length / 2)]).toBeLessThanOrEqual(config.tether.stableMs + FRAME_MS);
    expect(delays[Math.floor(delays.length * 0.95)]).toBeLessThanOrEqual(config.tether.stableMs + 4 * FRAME_MS);
  });

  it('survives dropped frames: 3 % of frames missing still ties on', () => {
    const config = createConfig();
    let tied = 0;
    for (let seed = 0; seed < 100; seed++) {
      if (firstTieOn(new TetherDetector(config), still(), 2500, { noise: new Random(seed), dropChance: 0.03 }) !== null) tied++;
    }
    expect(tied).toBeGreaterThanOrEqual(98);
  });

  it('a gentle sway (0.015 ih at 0.5 Hz) is still «estable»', () => {
    const t = firstTieOn(new TetherDetector(createConfig()), tMs => [0.67 + 0.015 * Math.sin(2 * Math.PI * 0.5 * (tMs / 1000)), 0.4], 2000, { noise: new Random(5) });
    expect(t).not.toBeNull();
  });

  it('reuses one result object: nothing is allocated per sample', () => {
    const detector = new TetherDetector(createConfig());
    const found: StableHand[] = [];
    for (let i = 0; i < 30; i++) {
      const r = detector.push(sample(i * FRAME_MS, 0.5, 0.5));
      if (r) found.push(r);
    }
    expect(found.length).toBeGreaterThan(2);
    expect(new Set(found).size).toBe(1);
  });
});

describe('TetherDetector: a hand that moves never ties on', () => {
  const config = createConfig();
  const movers: Array<[string, (tMs: number) => [number, number]]> = [
    ['drifting at 0.3 ih/s', tMs => [0.3 + 0.0003 * tMs, 0.4]],
    ['waving 0.1 ih at 1 Hz', tMs => [0.67 + 0.1 * Math.sin(2 * Math.PI * (tMs / 1000)), 0.4]],
    ['circling at 0.7 Hz, r = 0.08', tMs => [0.67 + 0.08 * Math.cos(2 * Math.PI * 0.7 * (tMs / 1000)), 0.4 + 0.08 * Math.sin(2 * Math.PI * 0.7 * (tMs / 1000))]],
    ['zigzagging 0.3 ih every 0.4 s', tMs => [0.5 + 0.3 * Math.abs(((tMs / 400) % 2) - 1), 0.4]],
  ];
  for (const [name, path] of movers) {
    it(`${name}: 5 s without a tie-on (clean and with jitter)`, () => {
      expect(firstTieOn(new TetherDetector(config), path, 5000)).toBeNull();
      expect(firstTieOn(new TetherDetector(config), path, 5000, { noise: new Random(2) })).toBeNull();
    });
  }

  it('ties on stableMs after the hand stops, not before (an abrupt stop at 1 s)', () => {
    const stopMs = 1000;
    const path = (tMs: number): [number, number] => [0.3 + 0.0005 * Math.min(tMs, stopMs), 0.4];
    const t = firstTieOn(new TetherDetector(config), path, 3000);
    expect(t).not.toBeNull();
    // The window opens at the newest sample at least stableMs old; a sample up to one frame before the stop is
    // allowed in it (it is within a centimetre of where the hand ends up).
    expect(t!).toBeGreaterThanOrEqual(stopMs + config.tether.stableMs - FRAME_MS);
    expect(t!).toBeLessThanOrEqual(stopMs + config.tether.stableMs + 2 * FRAME_MS);
  });

  it('a hand that was still and then drifts 0.05 ih is not steady yet: the half windows catch what the whole window lets through', () => {
    const detector = new TetherDetector(config);
    // Still until 250 ms, then 0.05 ih in 200 ms (0.25 ih/s), then still again.
    const path = (tMs: number): [number, number] => [0.6 + 0.05 * Math.min(1, Math.max(0, (tMs - 250) / 200)), 0.4];
    const samples: Array<{ t: number; x: number; y: number }> = [];
    const tied: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = i * FRAME_MS, [x, y] = path(t);
      samples.push({ t, x, y });
      if (detector.push(sample(t, x, y))) tied.push(t);
    }
    // The whole 400 ms window at t ≈ 467 ms passes the slope and spread limits on its own…
    const end = samples.findIndex(s => s.t >= 450);
    const from = end - 12;
    const whole = fitLine(i => samples[i], from, end + 1)!;
    expect(Math.hypot(whole.vx, whole.vy)).toBeLessThan(config.tether.stableSpeed);
    expect(windowSpread(i => samples[i], from, end + 1)).toBeLessThan(config.tether.stableSpread);
    // …but the hand was still moving in the second half of it, so it does not tie on until that half is quiet too.
    expect(tied[0]).toBeGreaterThanOrEqual(450 + config.tether.stableMs / 2 - FRAME_MS);
  });
});

describe('TetherDetector: what restarts the window', () => {
  const config = createConfig();

  it('a sample touching the frame edge throws the history away', () => {
    const detector = new TetherDetector(config);
    let tied: number | null = null;
    for (let i = 0; i < 40 && tied === null; i++) {
      const t = i * FRAME_MS;
      if (detector.push(sample(t, 0.67, 0.4, i === 9 ? { edge: 'top' } : {}))) tied = t;
    }
    // The edge sample is sample 9 (t = 300 ms); the window restarts at sample 10 and needs stableMs more.
    expect(tied).not.toBeNull();
    expect(tied!).toBeGreaterThanOrEqual(10 * FRAME_MS + config.tether.stableMs);
  });

  it('a hand that stays at the edge never ties on', () => {
    const detector = new TetherDetector(config);
    for (let i = 0; i < 90; i++) expect(detector.push(sample(i * FRAME_MS, 0.67, 0.1, { edge: 'top' }))).toBeNull();
  });

  it('a sample that does not continue the previous one (identity change, jump, gap) restarts it', () => {
    const detector = new TetherDetector(config);
    let tied: number | null = null;
    for (let i = 0; i < 40 && tied === null; i++) {
      const t = i * FRAME_MS;
      if (detector.push(sample(t, 0.67, 0.4, { continuous: i !== 8 }))) tied = t;
    }
    expect(tied!).toBeGreaterThanOrEqual(8 * FRAME_MS + config.tether.stableMs);
  });

  it('a hole in the data longer than perception.maxGapMs restarts it', () => {
    const detector = new TetherDetector(config);
    const times = [...Array.from({ length: 8 }, (_, i) => i * FRAME_MS), 8 * FRAME_MS + config.perception.maxGapMs + 20];
    let tied: number | null = null;
    for (let i = 0; tied === null; i++) {
      const t = i < times.length ? times[i] : times[times.length - 1] + (i - times.length + 1) * FRAME_MS;
      if (detector.push(sample(t, 0.67, 0.4))) tied = t;
      if (i > 60) break;
    }
    expect(tied!).toBeGreaterThanOrEqual(times[times.length - 1] + config.tether.stableMs);
  });

  it('two dropped frames in a row are not a hole (100 ms between neighbours); three are (133 ms)', () => {
    const tieOnWithout = (dropped: readonly number[]): number | null => {
      const detector = new TetherDetector(config);
      for (let i = 0; i < 60; i++) {
        if (dropped.includes(i)) continue;
        if (detector.push(sample(i * FRAME_MS, 0.67, 0.4))) return i * FRAME_MS;
      }
      return null;
    };
    expect(3 * FRAME_MS).toBeLessThan(config.perception.maxGapMs);
    expect(4 * FRAME_MS).toBeGreaterThan(config.perception.maxGapMs);
    // Frames 5 and 6 missing: the window is untouched and ties on at the earliest instant.
    expect(tieOnWithout([5, 6])!).toBeLessThan(config.tether.stableMs + FRAME_MS);
    // Frames 5, 6 and 7 missing: sample 8 starts a new window, which needs stableMs of its own.
    expect(tieOnWithout([5, 6, 7])!).toBeGreaterThanOrEqual(8 * FRAME_MS + config.tether.stableMs);
  });

  it('out-of-order, duplicated and too-close samples are ignored without forgetting the window', () => {
    const detector = new TetherDetector(config);
    let tied: number | null = null;
    for (let i = 0; i < 30 && tied === null; i++) {
      const t = i * FRAME_MS;
      if (detector.push(sample(t, 0.67, 0.4))) tied = t;
      expect(detector.push(sample(t, 0.67, 0.4))).toBeNull(); // duplicate
      expect(detector.push(sample(t - 100, 0.9, 0.9))).toBeNull(); // out of order
      expect(detector.push(sample(t + 5, 0.9, 0.9))).toBeNull(); // closer than a frame
    }
    expect(tied!).toBeLessThan(config.tether.stableMs + FRAME_MS);
  });

  it('non-finite samples restart it instead of poisoning it', () => {
    const detector = new TetherDetector(config);
    let tied: number | null = null;
    for (let i = 0; i < 40 && tied === null; i++) {
      const t = i * FRAME_MS;
      if (i === 5) { expect(detector.push(sample(t, Number.NaN, 0.4))).toBeNull(); continue; }
      if (detector.push(sample(t, 0.67, 0.4))) tied = t;
    }
    expect(tied!).toBeGreaterThanOrEqual(6 * FRAME_MS + config.tether.stableMs);
  });

  it('reset() forgets everything', () => {
    const detector = new TetherDetector(config);
    for (let i = 0; i < 11; i++) detector.push(sample(i * FRAME_MS, 0.67, 0.4));
    detector.reset();
    expect(detector.push(sample(11 * FRAME_MS, 0.67, 0.4))).toBeNull();
    expect(detector.push(sample(12 * FRAME_MS, 0.67, 0.4))).toBeNull();
  });
});

describe('TetherDetector: the zone', () => {
  const config = createConfig();
  const zone: TetherZone = { x0: 0.5, y0: 0.3, x1: 0.8, y1: 0.5 };

  it('a still hand outside the zone never ties on; inside it does', () => {
    const outside = new TetherDetector(config);
    outside.setZone(zone);
    expect(firstTieOn(outside, still(0.2, 0.4), 3000)).toBeNull();
    expect(firstTieOn(outside, still(0.67, 0.6), 3000)).toBeNull();
    const inside = new TetherDetector(config);
    inside.setZone(zone);
    expect(firstTieOn(inside, still(0.65, 0.4), 3000)).not.toBeNull();
  });

  it('the zone edge is inclusive, and a corner given the wrong way round is put in order', () => {
    const detector = new TetherDetector(config);
    detector.setZone({ x0: 0.8, y0: 0.5, x1: 0.5, y1: 0.3 });
    expect(firstTieOn(detector, still(0.5, 0.3), 1000)).not.toBeNull();
    detector.setZone({ x0: 0.8, y0: 0.5, x1: 0.5, y1: 0.3 });
    expect(firstTieOn(detector, still(0.5, 0.2999), 1000)).toBeNull();
  });

  it('leaving the zone restarts the window, entering it starts a new one', () => {
    const detector = new TetherDetector(config);
    detector.setZone(zone);
    const path = (tMs: number): [number, number] => (tMs < 300 ? [0.65, 0.4] : tMs < 600 ? [0.2, 0.4] : [0.65, 0.4]);
    const t = firstTieOn(detector, path, 3000);
    // Back inside at ~600 ms: the earliest tie-on is stableMs after the first sample that is back inside.
    expect(t!).toBeGreaterThanOrEqual(600 + config.tether.stableMs);
  });

  it('setZone forgets what was gathered under the old zone; null lifts the restriction', () => {
    const detector = new TetherDetector(config);
    for (let i = 0; i < 11; i++) detector.push(sample(i * FRAME_MS, 0.67, 0.4));
    detector.setZone(zone);
    expect(detector.push(sample(11 * FRAME_MS, 0.67, 0.4))).toBeNull();
    detector.setZone(null);
    expect(firstTieOn(detector, still(0.1, 0.9), 1000)).not.toBeNull();
  });

  it('the default zone is centred on the default home and wide enough for a hand to land in it', () => {
    const centre = zoneCentre(DEFAULT_TETHER_ZONE);
    expect(centre[0]).toBeCloseTo(2 / 3, 12);
    expect(centre[1]).toBeCloseTo(0.4, 12);
    expect(DEFAULT_TETHER_ZONE.x1 - DEFAULT_TETHER_ZONE.x0).toBeGreaterThan(0.3);
    expect(DEFAULT_TETHER_ZONE.y1 - DEFAULT_TETHER_ZONE.y0).toBeGreaterThan(0.2);
  });
});

describe('TetherDetector: live tuning', () => {
  it('a longer stableMs is honoured from the next sample and keeps the history', () => {
    const detector = new TetherDetector(createConfig());
    for (let i = 0; i < 10; i++) expect(detector.push(sample(i * FRAME_MS, 0.67, 0.4))).toBeNull();
    detector.setConfig(setConfigValue(createConfig(), 'tether.stableMs', 800));
    let tied: number | null = null;
    for (let i = 10; i < 60 && tied === null; i++) if (detector.push(sample(i * FRAME_MS, 0.67, 0.4))) tied = i * FRAME_MS;
    // The first ten samples were kept: the window needs 800 ms from sample 0, not from the change.
    expect(tied!).toBeGreaterThanOrEqual(800);
    expect(tied!).toBeLessThan(800 + FRAME_MS);
  });

  it('a shorter stableMs shrinks the ring without losing the newest samples', () => {
    const detector = new TetherDetector(createConfig());
    for (let i = 0; i < 10; i++) expect(detector.push(sample(i * FRAME_MS, 0.67, 0.4))).toBeNull();
    detector.setConfig(setConfigValue(createConfig(), 'tether.stableMs', 200));
    // 10 samples (300 ms) are already there: the very next one makes a window of 200 ms.
    expect(detector.push(sample(10 * FRAME_MS, 0.67, 0.4))).not.toBeNull();
  });

  it('a shorter stableMs ties on sooner', () => {
    const detector = new TetherDetector(setConfigValue(createConfig(), 'tether.stableMs', 200));
    expect(firstTieOn(detector, still(), 1000)).toBeLessThan(200 + FRAME_MS);
  });

  it('tighter limits are honoured: a hand that passes at the default speed limit fails a stricter one', () => {
    const slowDrift = (tMs: number): [number, number] => [0.4 + 0.00008 * tMs, 0.4]; // 0.08 ih/s
    expect(firstTieOn(new TetherDetector(createConfig()), slowDrift, 2000)).not.toBeNull();
    expect(firstTieOn(new TetherDetector(setConfigValue(createConfig(), 'tether.stableSpeed', 0.05)), slowDrift, 2000)).toBeNull();
  });
});

describe('TetherDetector: determinism and bounds', () => {
  it('the same stream gives the same answers, and a long still hand costs a fixed amount of memory', () => {
    const run = () => {
      const detector = new TetherDetector(createConfig());
      const rng = new Random(9);
      const out: Array<number | null> = [];
      for (let i = 0; i < 20_000; i++) {
        const r = detector.push(sample(i * FRAME_MS, 0.67 + rng.gaussian(0, JITTER), 0.4 + rng.gaussian(0, JITTER)));
        out.push(r ? r.x : null);
      }
      return out;
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a.filter(v => v !== null).length).toBeGreaterThan(19_000);
  });
});
