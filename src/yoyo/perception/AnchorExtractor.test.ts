import { describe, it, expect } from 'vitest';
import type { HandDetection, HandFrame } from '../../shared/contracts';
import type { AnchorObservation, AnchorSample } from '../contracts';
import { createConfig, setConfigValue, type YoyoConfig } from '../config';
import { buildHand, IMAGE_ASPECT } from '../replay/handPose';
import { Random } from '../replay/random';
import { randomPalm, renderScene, type DeliveredFrame, type Scene } from '../replay/synthetic';
import { AnchorExtractor } from './AnchorExtractor';

const FRAME_MS = 1000 / 30;
const IDENTITY_GATE = createConfig().perception.identityGate;

/** A hand whose anchor sits at the given MIRRORED image position (ih), as the extractor should report it. */
function handAt(xIh: number, y: number, options: { palmSize?: number; zOffset?: number } = {}): HandDetection {
  return buildHand({ anchor: { x: 1 - xIh / IMAGE_ASPECT, y }, ...options });
}

const frame = (t: number, ...hands: HandDetection[]): HandFrame => ({ timestampMs: t, source: 'replay', hands });

function sampleOf(obs: AnchorObservation | null): AnchorSample {
  expect(obs).not.toBeNull();
  expect(obs!.kind).toBe('sample');
  return (obs as { kind: 'sample'; sample: AnchorSample }).sample;
}

/** Feeds hands at 30 fps from t = 1000 and returns the observations. */
function run(extractor: AnchorExtractor, hands: Array<HandDetection[]>, startMs = 1000): Array<AnchorObservation | null> {
  return hands.map((h, i) => extractor.observe(frame(startMs + i * FRAME_MS, ...h), startMs + i * FRAME_MS + 50));
}

describe('AnchorExtractor: reading a frame', () => {
  it('mirrors x exactly once and reports landmark 9 as the anchor', () => {
    const e = new AnchorExtractor(createConfig());
    const hand = buildHand({ anchor: { x: 0.3, y: 0.6 } });
    const s = sampleOf(e.observe(frame(100, hand), 150));
    expect(s.x).toBeCloseTo((1 - 0.3) * (4 / 3), 12);
    expect(s.y).toBeCloseTo(0.6, 12);
    expect(s.timestampMs).toBe(100);
    expect(s.arrivalMs).toBe(150);
    expect(s.source).toBe('replay');
    expect(s.landmarks).toHaveLength(21);
    expect(s.landmarks![9][0]).toBeCloseTo(s.x, 12);
    expect(s.landmarks![9][1]).toBeCloseTo(s.y, 12);
    // Every drawing landmark is mirrored the same way, not just the anchor.
    hand.landmarks.forEach((p, i) => {
      expect(s.landmarks![i][0]).toBeCloseTo((1 - p.x) * (4 / 3), 12);
      expect(s.landmarks![i][1]).toBeCloseTo(p.y, 12);
    });
  });

  it('measures the palm like Masa does: mean wrist→MCP distance with relative z', () => {
    const e = new AnchorExtractor(createConfig());
    expect(sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50)).palmSize).toBeCloseTo(0.17, 9);
    const e2 = new AnchorExtractor(createConfig());
    expect(sampleOf(e2.observe(frame(0, handAt(0.6, 0.5, { palmSize: 0.26 })), 50)).palmSize).toBeCloseTo(0.26, 9);
    // A z error of the whole hand inflates it: depth is part of the measure on purpose.
    const e3 = new AnchorExtractor(createConfig());
    expect(sampleOf(e3.observe(frame(0, handAt(0.6, 0.5, { zOffset: -0.06 })), 50)).palmSize).toBeGreaterThan(0.2);
  });

  it('ignores frames that do not advance the clock, without touching its state', () => {
    const e = new AnchorExtractor(createConfig());
    expect(e.observe(frame(100, handAt(0.6, 0.5)), 150)).not.toBeNull();
    expect(e.observe(frame(100, handAt(0.9, 0.9)), 151)).toBeNull();
    expect(e.observe(frame(90, handAt(0.9, 0.9)), 152)).toBeNull();
    expect(e.observe(frame(Number.NaN, handAt(0.9, 0.9)), 153)).toBeNull();
    const next = sampleOf(e.observe(frame(133, handAt(0.61, 0.5)), 183));
    expect(next.continuous).toBe(true);
  });

  it('counts only hands with 21 finite landmarks', () => {
    const e = new AnchorExtractor(createConfig());
    const short: HandDetection = { ...handAt(0.6, 0.5), landmarks: handAt(0.6, 0.5).landmarks.slice(0, 20) };
    expect(e.observe(frame(0, short), 50)?.kind).toBe('absent');
    const broken = handAt(0.6, 0.5);
    const landmarks = broken.landmarks.map((p, i) => (i === 12 ? { ...p, z: Number.NaN } : p));
    expect(e.observe(frame(33, { ...broken, landmarks }), 83)?.kind).toBe('absent');
    expect(e.observe(frame(66, handAt(0.6, 0.5)), 116)?.kind).toBe('sample');
  });

  it('reports a degenerate hand (no size) as absent', () => {
    const e = new AnchorExtractor(createConfig());
    const dot: HandDetection = { handedness: 'Right', landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })) };
    expect(e.observe(frame(0, dot), 50)?.kind).toBe('absent');
  });
});

describe('AnchorExtractor: choosing the hand', () => {
  it('starts with the hand that has the largest palm', () => {
    const e = new AnchorExtractor(createConfig());
    const far = handAt(0.4, 0.5, { palmSize: 0.12 });
    const near = handAt(1.0, 0.5, { palmSize: 0.2 });
    const s = sampleOf(e.observe(frame(0, far, near), 50));
    expect(s.x).toBeCloseTo(1.0, 9);
    expect(s.palmSize).toBeCloseTo(0.2, 9);
  });

  it('then follows the hand nearest the last anchor, whatever the array order', () => {
    const e = new AnchorExtractor(createConfig());
    const a = (x: number) => handAt(x, 0.5, { palmSize: 0.2 });
    const b = (x: number) => handAt(x, 0.5, { palmSize: 0.12 });
    sampleOf(e.observe(frame(0, a(1.0), b(0.3)), 50));
    const s1 = sampleOf(e.observe(frame(33, b(0.3), a(1.01)), 83));
    expect(s1.x).toBeCloseTo(1.01, 9);
    expect(s1.continuous).toBe(true);
    // The tracked hand keeps being followed even when the other grows bigger.
    const s2 = sampleOf(e.observe(frame(66, handAt(0.3, 0.5, { palmSize: 0.3 }), a(1.02)), 116));
    expect(s2.x).toBeCloseTo(1.02, 9);
    expect(s2.continuous).toBe(true);
  });

  it('breaks continuity when the two nearest hands cannot be told apart (crossing)', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.7, 0.5)), 50));
    const crossing = sampleOf(e.observe(frame(33, handAt(0.74, 0.5), handAt(0.76, 0.5)), 83));
    expect(crossing.continuous).toBe(false);
    expect(crossing.x).toBeCloseTo(0.74, 9);
    // Clearly separated hands do not.
    const e2 = new AnchorExtractor(createConfig());
    sampleOf(e2.observe(frame(0, handAt(0.7, 0.5)), 50));
    expect(sampleOf(e2.observe(frame(33, handAt(0.71, 0.5), handAt(1.0, 0.5)), 83)).continuous).toBe(true);
  });

  it('treats a far-away hand as an identity change, confirmed one frame later and discontinuous', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.4, 0.5)), 50));
    expect(e.observe(frame(33, handAt(0.4 + IDENTITY_GATE + 0.1, 0.5)), 83)).toBeNull();
    const s = sampleOf(e.observe(frame(66, handAt(0.4 + IDENTITY_GATE + 0.11, 0.5)), 116));
    expect(s.x).toBeCloseTo(0.4 + IDENTITY_GATE + 0.11, 9);
    expect(s.continuous).toBe(false);
  });
});

describe('AnchorExtractor: continuity', () => {
  it('first sample is discontinuous, a normal follow-up is continuous', () => {
    const e = new AnchorExtractor(createConfig());
    const [a, b] = run(e, [[handAt(0.6, 0.5)], [handAt(0.61, 0.5)]]).map(sampleOf);
    expect(a.continuous).toBe(false);
    expect(b.continuous).toBe(true);
  });

  it('allows fast but plausible strokes (3 ih/s) and dropped frames', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, 0.3)), 50));
    expect(sampleOf(e.observe(frame(FRAME_MS, handAt(0.6, 0.4)), 83)).continuous).toBe(true);
    // One dropped frame: 66 ms later, 0.2 ih lower = 3 ih/s.
    expect(sampleOf(e.observe(frame(FRAME_MS * 3, handAt(0.6, 0.6)), 150)).continuous).toBe(true);
  });

  it('breaks continuity after a gap longer than perception.strokeGapMs, and not before it', () => {
    const config = createConfig();
    const e = new AnchorExtractor(config);
    sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50));
    // Longer than maxGapMs (110) but within strokeGapMs (170): a hand that blurred out of the detection for a few frames is still the same hand.
    expect(config.perception.strokeGapMs).toBeGreaterThan(config.perception.maxGapMs);
    expect(sampleOf(e.observe(frame(config.perception.maxGapMs + 1, handAt(0.6, 0.5)), 200)).continuous).toBe(true);
    const late = sampleOf(e.observe(frame(config.perception.maxGapMs + 1 + config.perception.strokeGapMs + 1, handAt(0.6, 0.5)), 400));
    expect(late.continuous).toBe(false);
  });

  it('applies live config changes without losing the track', () => {
    const config = createConfig();
    const e = new AnchorExtractor(config);
    sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50));
    const tight = createConfig();
    tight.perception.strokeGapMs = 40;
    e.setConfig(tight);
    expect(sampleOf(e.observe(frame(60, handAt(0.6, 0.5)), 110)).continuous).toBe(false);
    e.setConfig(config);
    expect(sampleOf(e.observe(frame(93, handAt(0.6, 0.5)), 143)).continuous).toBe(true);
  });

  it('judges how far the hand went by speed over the real time, not by a fixed distance: a dropped frame stretches what is plausible', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, 0.3)), 50));
    // 0.32 ih in 100 ms (3.2 ih/s): a downstroke over three frames; the old 0.25 ih identity gate called it another hand.
    const s = sampleOf(e.observe(frame(100, handAt(0.6, 0.62)), 150));
    expect(s.continuous).toBe(true);
    // The same distance in one frame is 9.6 ih/s: not a hand.
    const quick = new AnchorExtractor(createConfig());
    sampleOf(quick.observe(frame(0, handAt(0.6, 0.3)), 50));
    expect(quick.observe(frame(FRAME_MS, handAt(0.6, 0.62)), 83)).toBeNull();
  });

  it('counts a frame held as a suspect as the hand being seen: holding one frame does not stretch the gap past strokeGapMs', () => {
    const config = createConfig();
    const e = new AnchorExtractor(config);
    sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50));
    // At the camera's slow moments (90 ms frames) a held frame puts the next one 180 ms after the last emitted sample.
    expect(e.observe(frame(90, handAt(0.6, 0.9)), 140)).toBeNull();
    const s = sampleOf(e.observe(frame(180, handAt(0.6, 0.97)), 230));
    expect(180).toBeGreaterThan(config.perception.strokeGapMs);
    expect(s.continuous).toBe(true);
  });
});

describe('AnchorExtractor: one-frame glitches', () => {
  it('never emits a one-frame jump and keeps the track going', () => {
    const e = new AnchorExtractor(createConfig());
    const glitch = handAt(0.6, 0.5 + 0.2);
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [glitch], [handAt(0.6, 0.5)], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    const samples = [out[0], out[1], out[3], out[4]].map(sampleOf);
    expect(samples.map(s => s.continuous)).toEqual([false, true, true, true]);
    for (const s of samples) expect(Math.abs(s.y - 0.5)).toBeLessThan(1e-9);
  });

  it('treats a palm-size spike like a jump', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.5, { palmSize: 0.17 * 1.5 })], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    expect(sampleOf(out[3]).continuous).toBe(true);
  });

  it('treats a z jump of the whole hand as a size jump too', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.5, { zOffset: -0.12 })], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    expect(sampleOf(out[3]).continuous).toBe(true);
  });

  it('emits a relocation confirmed by the next frame, discontinuous, at the new place', () => {
    const e = new AnchorExtractor(createConfig());
    // 0.4 ih in one frame is 12 ih/s: over the 8 ih/s limit, so a relocation, not a stroke.
    const out = run(e, [[handAt(0.6, 0.45)], [handAt(0.6, 0.45)], [handAt(0.6, 0.85)], [handAt(0.6, 0.86)], [handAt(0.6, 0.86)]]);
    expect(out[2]).toBeNull();
    const confirmed = sampleOf(out[3]);
    expect(confirmed.continuous).toBe(false);
    expect(confirmed.y).toBeCloseTo(0.86, 9);
    expect(sampleOf(out[4]).continuous).toBe(true);
  });

  it('a fast stroke (7 ih/s) confirmed by the next frame moving the same way stays continuous: Luis\'s fastest downstroke is not a relocation', () => {
    const e = new AnchorExtractor(createConfig());
    // 0.233 ih in one frame is 7 ih/s: held for one frame (a glitch looks the same), then the next frame goes on down.
    const out = run(e, [[handAt(0.6, 0.2)], [handAt(0.6, 0.2)], [handAt(0.6, 0.433)], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    const confirmed = sampleOf(out[3]);
    expect(confirmed.continuous).toBe(true);
    expect(confirmed.y).toBeCloseTo(0.5, 9);
  });

  it('a one-frame jump of 7 ih/s that comes back is still a glitch: it is dropped and the track goes on', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.2)], [handAt(0.6, 0.2)], [handAt(0.6, 0.433)], [handAt(0.6, 0.2)]]);
    expect(out[2]).toBeNull();
    const back = sampleOf(out[3]);
    expect(back.continuous).toBe(true);
    expect(back.y).toBeCloseTo(0.2, 9);
  });

  it('a glitch right after dropped frames is still caught when the speed gives it away', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50));
    sampleOf(e.observe(frame(FRAME_MS, handAt(0.6, 0.5)), 83));
    // 0.3 ih in 33 ms: 9 ih/s.
    expect(e.observe(frame(FRAME_MS * 2, handAt(0.6, 0.8)), 116)).toBeNull();
    expect(sampleOf(e.observe(frame(FRAME_MS * 3, handAt(0.6, 0.5)), 150)).continuous).toBe(true);
  });

  it('holds a spike that stays under the hard palm limit too (+20 %), and drops it when the track resumes', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.5, { palmSize: 0.17 * 1.2 })], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    expect(sampleOf(out[3]).continuous).toBe(true);
  });

  it('a soft jump confirmed by the next frame is a real change of size: emitted, and still continuous', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.5, { palmSize: 0.17 * 1.2 })], [handAt(0.6, 0.5, { palmSize: 0.17 * 1.2 })]]);
    expect(out[2]).toBeNull();
    const s = sampleOf(out[3]);
    expect(s.continuous).toBe(true);
    expect(s.palmSize).toBeCloseTo(0.17 * 1.2, 9);
  });

  it('holds a single-frame jump of 4.5 ih/s, over the 4 ih/s a frame is held at and well under the 8 ih/s hard limit, and drops it', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.5 - 0.15)], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    expect(sampleOf(out[3]).continuous).toBe(true);
  });

  it('does not hold a fast but plausible stroke (3.5 ih/s)', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.2)], [handAt(0.6, 0.3)], [handAt(0.6, 0.417)], [handAt(0.6, 0.534)]]);
    expect(out.every(o => o !== null)).toBe(true);
    expect(out.slice(1).every(o => sampleOf(o).continuous)).toBe(true);
  });

  it('two different wrong frames in a row (palm up, then palm down) never vouch for each other', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.45, { palmSize: 0.17 * 1.3 })], [handAt(0.6, 0.55, { palmSize: 0.17 * 0.7 })], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
    expect(sampleOf(out[4]).continuous).toBe(true);
  });

  it('two different glitches in a row never confirm each other', () => {
    const e = new AnchorExtractor(createConfig());
    const out = run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.85)], [handAt(1.2, 0.15)], [handAt(0.6, 0.5)]]);
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
    expect(sampleOf(out[4]).continuous).toBe(true);
  });
});

describe('AnchorExtractor: frame edges', () => {
  const margin = createConfig().perception.edgeMargin;

  /** A hand whose wrist (landmark 0) is moved to a given normalized position, others follow. */
  function shifted(dx: number, dy: number): HandDetection {
    const hand = handAt(0.67, 0.5);
    return { ...hand, landmarks: hand.landmarks.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  }

  it('flags no edge for a hand well inside the frame', () => {
    const e = new AnchorExtractor(createConfig());
    expect(sampleOf(e.observe(frame(0, handAt(0.67, 0.5)), 50)).edge).toBeUndefined();
  });

  it('flags the border a landmark touches, with bottom, top, left, right priority', () => {
    const lowest = (hand: HandDetection) => Math.max(...hand.landmarks.map(p => p.y));
    const highest = (hand: HandDetection) => Math.min(...hand.landmarks.map(p => p.y));
    const hand = handAt(0.67, 0.5);

    const bottom = new AnchorExtractor(createConfig());
    expect(sampleOf(bottom.observe(frame(0, shifted(0, 1 - margin / 2 - lowest(hand))), 50)).edge).toBe('bottom');

    const top = new AnchorExtractor(createConfig());
    expect(sampleOf(top.observe(frame(0, shifted(0, margin / 2 - highest(hand))), 50)).edge).toBe('top');

    // Mirrored x < margin means unmirrored x > 1 − margin·0.75.
    const left = new AnchorExtractor(createConfig());
    const farRight = Math.max(...hand.landmarks.map(p => p.x));
    expect(sampleOf(left.observe(frame(0, shifted(1 - (margin * 0.75) / 2 - farRight, 0)), 50)).edge).toBe('left');

    const right = new AnchorExtractor(createConfig());
    const farLeft = Math.min(...hand.landmarks.map(p => p.x));
    expect(sampleOf(right.observe(frame(0, shifted((margin * 0.75) / 2 - farLeft, 0)), 50)).edge).toBe('right');

    // Touching the bottom and the left at once reports the bottom.
    const both = new AnchorExtractor(createConfig());
    const corner = shifted(1 - (margin * 0.75) / 2 - farRight, 1 - margin / 2 - lowest(hand));
    expect(sampleOf(both.observe(frame(0, corner), 50)).edge).toBe('bottom');
  });
});

describe('AnchorExtractor: absence', () => {
  it('reports a frame without hands as absent; a hand back within perception.strokeGapMs at a plausible place continues the track', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50));
    const gone = e.observe(frame(33), 83);
    expect(gone).toEqual({ kind: 'absent', timestampMs: 33, arrivalMs: 83, source: 'replay' });
    expect(sampleOf(e.observe(frame(66, handAt(0.6, 0.5)), 116)).continuous).toBe(true);
  });

  it('a stroke that loses the hand for a frame or two and finds it 0.3 ih lower is one stroke: the track survives the absence', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, 0.3)), 50));
    sampleOf(e.observe(frame(FRAME_MS, handAt(0.6, 0.34)), 83));
    expect(e.observe(frame(FRAME_MS * 2), 116)?.kind).toBe('absent');
    expect(e.observe(frame(FRAME_MS * 3), 150)?.kind).toBe('absent');
    // 0.32 ih lower, 100 ms after the last sample (3.2 ih/s over the whole gap).
    const back = sampleOf(e.observe(frame(FRAME_MS * 4, handAt(0.6, 0.66)), 183));
    expect(back.continuous).toBe(true);
    expect(back.y).toBeCloseTo(0.66, 9);
  });

  it('an absence longer than perception.strokeGapMs ends the track: the hand that comes back is a new one', () => {
    const config = createConfig();
    const e = new AnchorExtractor(config);
    sampleOf(e.observe(frame(0, handAt(0.6, 0.5)), 50));
    for (let t = FRAME_MS; t < config.perception.strokeGapMs + FRAME_MS; t += FRAME_MS) expect(e.observe(frame(t), t + 50)?.kind).toBe('absent');
    expect(sampleOf(e.observe(frame(config.perception.strokeGapMs + 2 * FRAME_MS, handAt(0.6, 0.5)), 400)).continuous).toBe(false);
  });

  it('a hand that comes back at an impossible speed after an absence is not the same hand', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.2, 0.5)), 50));
    expect(e.observe(frame(33), 83)?.kind).toBe('absent');
    // 1 ih across the frame in 100 ms is 10 ih/s: held, then a confirmed relocation, discontinuous.
    expect(e.observe(frame(100, handAt(1.2, 0.5)), 150)).toBeNull();
    const s = sampleOf(e.observe(frame(133, handAt(1.2, 0.5)), 183));
    expect(s.continuous).toBe(false);
    expect(s.x).toBeCloseTo(1.2, 9);
  });

  it('names the exit edge: the last sample\'s edge, else bottom for a low anchor, else none', () => {
    const margin = createConfig().perception.edgeMargin;
    const low = new AnchorExtractor(createConfig());
    sampleOf(low.observe(frame(0, handAt(0.6, 0.9)), 50));
    expect(low.observe(frame(33), 83)).toMatchObject({ kind: 'absent', exitEdge: 'bottom' });

    const high = new AnchorExtractor(createConfig());
    sampleOf(high.observe(frame(0, handAt(0.6, 0.5)), 50));
    expect(high.observe(frame(33), 83)).toEqual({ kind: 'absent', timestampMs: 33, arrivalMs: 83, source: 'replay' });

    const edge = new AnchorExtractor(createConfig());
    const hand = handAt(0.6, 0.5);
    const rightmost = Math.max(...hand.landmarks.map(p => p.x));
    const atLeft: HandDetection = { ...hand, landmarks: hand.landmarks.map(p => ({ ...p, x: p.x + 1 - margin * 0.75 / 2 - rightmost })) };
    expect(sampleOf(edge.observe(frame(0, atLeft), 50)).edge).toBe('left');
    expect(edge.observe(frame(33), 83)).toMatchObject({ kind: 'absent', exitEdge: 'left' });
  });

  /** Anchor height that puts the hand's lowest landmark (the wrist) at `lowest`. */
  const anchorForLowest = (lowest: number) => lowest - (handAt(0.6, 0.5).landmarks[0].y - 0.5);

  it('names a bottom exit for a hand heading out fast, though its last sample is far from the edge', () => {
    // The wrist goes 0.82 → 0.92 in one frame (3 ih/s): next frame it is at 1.02, outside, and the hand is gone.
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, anchorForLowest(0.82))), 50));
    const last = sampleOf(e.observe(frame(FRAME_MS, handAt(0.6, anchorForLowest(0.92))), 83));
    expect(last.edge).toBeUndefined();
    expect(last.y).toBeLessThan(0.85);
    expect(e.observe(frame(FRAME_MS * 2), 116)).toMatchObject({ kind: 'absent', exitEdge: 'bottom' });
  });

  it('does not call it a bottom exit when the hand was slow, going up, or vanished long after its last sample', () => {
    const run = (from: number, to: number, absenceAfterMs = FRAME_MS) => {
      const e = new AnchorExtractor(createConfig());
      sampleOf(e.observe(frame(0, handAt(0.6, anchorForLowest(from))), 50));
      sampleOf(e.observe(frame(FRAME_MS, handAt(0.6, anchorForLowest(to))), 83));
      return e.observe(frame(FRAME_MS + absenceAfterMs), 83 + absenceAfterMs);
    };
    // Slow: 0.3 ih/s down, would still be 0.93 at the next frame.
    expect(run(0.91, 0.92)).toEqual({ kind: 'absent', timestampMs: FRAME_MS * 2, arrivalMs: 83 + FRAME_MS, source: 'replay' });
    // Fast but upward.
    expect(run(0.92, 0.82)).not.toHaveProperty('exitEdge');
    // Fast and downward, but the hand only vanishes 200 ms later: no longer evidence of an exit.
    expect(run(0.82, 0.92, 200)).not.toHaveProperty('exitEdge');
  });

  it('keeps naming the exit edge while the hand stays away', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(0, handAt(0.6, 0.92)), 50));
    for (let i = 1; i <= 5; i++) expect(e.observe(frame(i * 33), i * 33 + 50)).toMatchObject({ kind: 'absent', exitEdge: 'bottom' });
  });

  it('drops a pending suspect when the hand disappears: a frame after the absence cannot be confirmed by it', () => {
    const e = new AnchorExtractor(createConfig());
    // A jump of 0.45 ih in one frame (13.6 ih/s) is held as a suspect, and then the hand is gone.
    expect(run(e, [[handAt(0.6, 0.5)], [handAt(0.6, 0.5)], [handAt(0.6, 0.95)]])[2]).toBeNull();
    expect(e.observe(frame(1000 + 3 * FRAME_MS), 1200)?.kind).toBe('absent');
    // The same place again, 100 ms after the last sample (4.5 ih/s): had the suspect survived it would vouch for this frame at once.
    // Judged on its own against the track it is only a fast move, held for one frame like any other.
    expect(e.observe(frame(1000 + 4 * FRAME_MS, handAt(0.6, 0.95)), 1250)).toBeNull();
  });
});

describe('AnchorExtractor: a hand that leaves through the bottom', () => {
  /** Anchor height that puts the hand's lowest landmark (the wrist) at `lowest`. */
  const anchorForLowest = (lowest: number) => lowest - (handAt(0.6, 0.5).landmarks[0].y - 0.5);
  /**
   * A hand going down at `speed` ih/s, one sample per frame, the last one with its lowest landmark at
   * `lastLowest` (and no landmark within the bottom margin). Returns the capture time of that sample.
   */
  function descend(e: AnchorExtractor, speed: number, lastLowest: number, samples = 5, startMs = 1000): number {
    const step = (speed * FRAME_MS) / 1000;
    for (let i = 0; i < samples; i++) {
      const t = startMs + i * FRAME_MS;
      sampleOf(e.observe(frame(t, handAt(0.6, anchorForLowest(lastLowest - (samples - 1 - i) * step))), t + 50));
    }
    return startMs + (samples - 1) * FRAME_MS;
  }
  /** What the extractor says on `count` consecutive frames without a hand, the first one `gapFrames` frames after `lastMs`. */
  function absences(e: AnchorExtractor, lastMs: number, gapFrames: number, count = 16): AnchorObservation[] {
    return Array.from({ length: count }, (_, k) => {
      const t = lastMs + (gapFrames + k) * FRAME_MS;
      const o = e.observe(frame(t), t + 50);
      expect(o?.kind).toBe('absent');
      return o!;
    });
  }
  const named = (observations: AnchorObservation[]) => observations.map(o => (o.kind === 'absent' ? o.exitEdge : 'sample'));

  it('names the bottom on every frame of the absence for a fast exit, with 0, 1 or 2 dropped frames', () => {
    // 1.5 ih/s: 0.05 ih a frame. The last sample has its lowest landmark at 0.943: nothing within the 0.04 margin,
    // anchor at 0.79, so only the hand's speed says it is going out.
    for (const dropped of [0, 1, 2]) {
      const e = new AnchorExtractor(createConfig());
      const lastMs = descend(e, 1.5, 0.943);
      const edges = named(absences(e, lastMs, 1 + dropped));
      expect(edges, `${dropped} dropped frames`).toEqual(Array(edges.length).fill('bottom'));
    }
  });

  it('decides once, on the first frame without the hand, and repeats it: the edge neither blinks out nor appears later', () => {
    // Named: still named half a second on, far beyond the gap that justified it.
    const exit = new AnchorExtractor(createConfig());
    const lastExit = descend(exit, 1.5, 0.943);
    const exitEdges = named(absences(exit, lastExit, 1, 20));
    expect(exitEdges[0]).toBe('bottom');
    expect(exitEdges[exitEdges.length - 1]).toBe('bottom');
    // Not named: a hand at 3 ih/s at 0.80 would be at 1.1 after 100 ms, but the first frame without it came after 33 ms (0.90):
    // the frames that follow do not reopen the question.
    const mid = new AnchorExtractor(createConfig());
    const lastMid = descend(mid, 3, 0.8);
    const midEdges = named(absences(mid, lastMid, 1, 20));
    expect(midEdges).toEqual(Array(20).fill(undefined));
  });

  it('does not name an edge for a hand that vanishes mid-frame, however fast it was going and however many frames were dropped', () => {
    // Lowest landmark of the last sample and speed: still at 0.7, slow at 0.7, 1.5 ih/s at 0.6, 3 ih/s at 0.5.
    for (const [speed, lowest] of [[0, 0.7], [0.5, 0.7], [1.5, 0.6], [3, 0.5]] as const) {
      for (const dropped of [0, 1, 2]) {
        const e = new AnchorExtractor(createConfig());
        const lastMs = descend(e, speed, lowest);
        const edges = named(absences(e, lastMs, 1 + dropped));
        expect(edges, `${speed} ih/s from ${lowest}, ${dropped} dropped`).toEqual(Array(edges.length).fill(undefined));
      }
    }
  });

  it('does not name the bottom for a hand that was going up, or that had stopped before it vanished', () => {
    const up = new AnchorExtractor(createConfig());
    const lastUp = descend(up, -1.5, 0.93);
    expect(named(absences(up, lastUp, 2))).toEqual(Array(16).fill(undefined));
    // Fast, then three samples at rest at 0.9: the fit and the last interval both say it is not moving down any more.
    const stopped = new AnchorExtractor(createConfig());
    let lastStopped = descend(stopped, 1.5, 0.9, 3);
    for (let i = 1; i <= 3; i++) {
      const t = lastStopped + FRAME_MS;
      sampleOf(stopped.observe(frame(t, handAt(0.6, anchorForLowest(0.9))), t + 50));
      lastStopped = t;
    }
    expect(named(absences(stopped, lastStopped, 1))).toEqual(Array(16).fill(undefined));
  });

  it('needs a history of the motion: a last sample that broke continuity says nothing about speed', () => {
    const e = new AnchorExtractor(createConfig());
    const first = sampleOf(e.observe(frame(1000, handAt(0.6, anchorForLowest(0.943))), 1050));
    expect(first.continuous).toBe(false);
    expect(first.edge).toBeUndefined();
    expect(named(absences(e, 1000, 1))).toEqual(Array(16).fill(undefined));
  });

  it('forgets the motion when a hand reappears and is lost again, and on reset()', () => {
    const e = new AnchorExtractor(createConfig());
    const lastMs = descend(e, 1.5, 0.943);
    expect(named(absences(e, lastMs, 1, 3))).toEqual(['bottom', 'bottom', 'bottom']);
    // Back, still, mid-frame, and gone again: a new last sample, a new decision.
    const back = lastMs + 20 * FRAME_MS;
    sampleOf(e.observe(frame(back, handAt(0.6, anchorForLowest(0.5))), back + 50));
    sampleOf(e.observe(frame(back + FRAME_MS, handAt(0.6, anchorForLowest(0.5))), back + FRAME_MS + 50));
    expect(named(absences(e, back + FRAME_MS, 1, 3))).toEqual([undefined, undefined, undefined]);
    e.reset();
    expect(named(absences(e, back + 100 * FRAME_MS, 1, 2))).toEqual([undefined, undefined]);
  });

  it('applies perception.staleMs, maxGapMs and edgeMargin live', () => {
    // 1.5 ih/s, lowest 0.943: with a gap of 4 frames (133 ms) the first frame without the hand is older than maxGapMs but fresh.
    const fresh = () => {
      const e = new AnchorExtractor(createConfig());
      return { e, lastMs: descend(e, 1.5, 0.943) };
    };
    const retuned = (key: string, value: number) => {
      const { e, lastMs } = fresh();
      e.setConfig(setConfigValue(createConfig(), key, value));
      return named(absences(e, lastMs, 4, 3));
    };
    const { e: base, lastMs: baseMs } = fresh();
    expect(named(absences(base, baseMs, 4, 3))).toEqual(['bottom', 'bottom', 'bottom']);
    // Data older than staleMs is no evidence of where the hand was heading.
    expect(retuned('perception.staleMs', 120)).toEqual([undefined, undefined, undefined]);
    // The extrapolation is capped at maxGapMs of travel: 0.80 at 1.5 ih/s needs 107 ms to reach the margin, so a 50 ms cap falls short.
    const slow = () => {
      const e = new AnchorExtractor(createConfig());
      return { e, lastMs: descend(e, 1.5, 0.8) };
    };
    const { e: wide, lastMs: wideMs } = slow();
    expect(named(absences(wide, wideMs, 4, 2))).toEqual(['bottom', 'bottom']);
    const { e: capped, lastMs: cappedMs } = slow();
    capped.setConfig(setConfigValue(createConfig(), 'perception.maxGapMs', 50));
    expect(named(absences(capped, cappedMs, 4, 2))).toEqual([undefined, undefined]);
    // The zone a vanished hand must reach is the one a visible hand flags as the bottom edge: edgeMargin sets both.
    const margin = () => {
      const e = new AnchorExtractor(createConfig());
      return { e, lastMs: descend(e, 1, 0.88) };
    };
    const { e: narrow, lastMs: narrowMs } = margin();
    expect(named(absences(narrow, narrowMs, 1, 2))).toEqual([undefined, undefined]);
    const { e: broad, lastMs: broadMs } = margin();
    broad.setConfig(setConfigValue(createConfig(), 'perception.edgeMargin', 0.1));
    expect(named(absences(broad, broadMs, 1, 2))).toEqual(['bottom', 'bottom']);
  });

  describe('with the camera noise of the PRD (§8.2) and its dropped frames', () => {
    /** Delivered frames of a hand whose anchor height follows `height(t)`; it is gone from `lostAfterMs` on, or once `lost(y)` says so. */
    function noisyHand(seed: number, height: (tMs: number) => number, isLost: (anchorY: number, tMs: number) => boolean): DeliveredFrame[] {
      const rng = new Random(seed);
      const x = rng.range(0.55, 0.8);
      const scene: Scene = {
        durationMs: 3200,
        anchorAt: t => [x, height(t)],
        tiltAt: () => 0, palmSize: randomPalm(rng), handedness: 'Right',
        labels: [], glitches: [], glitchGuards: [], tags: [],
      };
      const clip = renderScene(scene, rng, { id: `noisy-${seed}`, kind: 'long', armed: { launch: false, tug: false } });
      return clip.frames.map(f => (isLost(scene.anchorAt(f.frame.timestampMs)[1], f.frame.timestampMs) ? { ...f, frame: { ...f.frame, hands: [] } } : f));
    }
    /** Edges named by the frames without a hand that follow the hand, or null if it never vanished. */
    function absenceEdges(frames: readonly DeliveredFrame[]): Array<string | undefined> | null {
      const e = new AnchorExtractor(createConfig());
      const out: Array<string | undefined> = [];
      let seenSample = false;
      for (const { frame: f, arrivalMs } of frames) {
        const o = e.observe(f, arrivalMs);
        if (o?.kind === 'sample') seenSample = true;
        else if (o?.kind === 'absent' && seenSample) out.push(o.exitEdge);
      }
      return out.length ? out : null;
    }

    it('names the bottom on every frame of the absence in 95 % or more of fast exits (1 to 3 ih/s, lost once the anchor passes 0.85)', () => {
      const runs = 60;
      for (const speed of [1, 1.5, 2, 3]) {
        let complete = 0, total = 0;
        for (let seed = 1; seed <= runs; seed++) {
          const rng = new Random(seed);
          const y0 = rng.range(0.28, 0.36);
          const edges = absenceEdges(noisyHand(1000 * speed + seed, t => y0 + (Math.max(0, t - 800) * speed) / 1000, y => y >= 0.85));
          if (!edges) continue;
          total++;
          if (edges.every(edge => edge === 'bottom')) complete++;
        }
        expect(total, `${speed} ih/s: runs where the hand vanished`).toBe(runs);
        expect(complete / total, `${speed} ih/s: ${complete}/${total} named on every frame`).toBeGreaterThanOrEqual(0.95);
      }
    });

    it('names no edge in 98 % or more of the hands that vanish mid-frame (still or slow at anchor 0.6, 1.5 ih/s at 0.5, a 3 ih/s stroke at 0.45)', () => {
      const runs = 60;
      // Anchor height at which the hand vanishes, and how long it moved down before that (a 3 ih/s stroke is short: it starts at the top).
      for (const [speed, lostAt, movingMs] of [[0, 0.6, 0], [0.5, 0.6, 600], [1.5, 0.5, 400], [3, 0.45, 100]] as const) {
        let falseExit = 0, total = 0;
        for (let seed = 1; seed <= runs; seed++) {
          const lostMs = 1600;
          const height = (t: number) => lostAt - (speed * (lostMs - Math.max(lostMs - movingMs, Math.min(t, lostMs)))) / 1000;
          const edges = absenceEdges(noisyHand(7000 * (speed + 1) + seed, height, (_y, t) => t >= lostMs));
          if (!edges) continue;
          total++;
          if (edges.some(edge => edge === 'bottom')) falseExit++;
        }
        expect(total, `${speed} ih/s: runs where the hand vanished`).toBe(runs);
        expect(falseExit / total, `${speed} ih/s lost at ${lostAt}: ${falseExit}/${total} called an exit`).toBeLessThanOrEqual(0.02);
      }
    });
  });
});

describe('AnchorExtractor: thresholds come from YoyoConfig.perception and apply live', () => {
  /** An extractor that starts on the default config and is retuned after its first frame, as the advanced panel does. */
  const retuned = (key: string, value: number, firstFrame: HandFrame, firstArrivalMs = 50) => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(firstFrame, firstArrivalMs));
    e.setConfig(setConfigValue(createConfig(), key, value));
    return e;
  };
  const untouched = (firstFrame: HandFrame, firstArrivalMs = 50) => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(firstFrame, firstArrivalMs));
    return e;
  };

  it('identityGate: how near the last anchor a second hand must be to be taken for a crossing, and how near a held sample a frame must be to vouch for it', () => {
    // Two hands 0.04 and 0.06 ih from the last anchor, 0.02 apart (inside crossingMargin): a crossing while both are inside the gate.
    const first = frame(0, handAt(0.7, 0.5));
    const pair = frame(33, handAt(0.74, 0.5), handAt(0.76, 0.5));
    expect(sampleOf(untouched(first).observe(pair, 83)).continuous).toBe(false);
    expect(sampleOf(retuned('perception.identityGate', 0.05, first).observe(pair, 83)).continuous).toBe(true);

    // A 0.45 ih jump is held; the frame after it goes on 0.1 ih: near enough to vouch with the default gate, not with 0.05.
    const play = (config: YoyoConfig) => run(new AnchorExtractor(config), [[handAt(0.6, 0.45)], [handAt(0.6, 0.45)], [handAt(0.6, 0.9)], [handAt(0.6, 0.97)]]);
    expect(sampleOf(play(createConfig())[3]).continuous).toBe(false);
    expect(play(setConfigValue(createConfig(), 'perception.identityGate', 0.05))[3]).toBeNull();
  });

  it('maxSpeed: how fast the anchor may go between two samples before the sample is a relocation, over the real time between them', () => {
    // 0.3 ih in 33 ms is 9 ih/s: held, and confirmed as a relocation (discontinuous) at the default 8 ih/s.
    const play = (config: YoyoConfig) => run(new AnchorExtractor(config), [[handAt(0.6, 0.3)], [handAt(0.6, 0.3)], [handAt(0.6, 0.6)], [handAt(0.6, 0.62)]]);
    expect(sampleOf(play(createConfig())[3]).continuous).toBe(false);
    // At 10 ih/s it is a fast stroke: still held (over the 4 ih/s a frame is held at), but confirmed as continuous.
    expect(sampleOf(play(setConfigValue(createConfig(), 'perception.maxSpeed', 10))[3]).continuous).toBe(true);
  });

  it('crossingMargin: how close the two nearest hands must be to be taken for a crossing', () => {
    const first = frame(0, handAt(0.7, 0.5));
    // Distances 0.04 and 0.06 from the last anchor: 0.02 apart.
    const pair = frame(33, handAt(0.74, 0.5), handAt(0.76, 0.5));
    expect(sampleOf(untouched(first).observe(pair, 83)).continuous).toBe(false);
    expect(sampleOf(retuned('perception.crossingMargin', 0.01, first).observe(pair, 83)).continuous).toBe(true);
  });

  it('speedSuspectFraction: how near the speed limit a single frame is held for confirmation', () => {
    // 0.15 ih in one frame is 4.5 ih/s: under the 8 ih/s hard limit, over half of it.
    const first = frame(0, handAt(0.6, 0.5));
    const fast = frame(FRAME_MS, handAt(0.6, 0.35));
    expect(untouched(first).observe(fast, 83)).toBeNull();
    const relaxed = retuned('perception.speedSuspectFraction', 1, first).observe(fast, 83);
    expect(sampleOf(relaxed).continuous).toBe(true);
    expect(sampleOf(relaxed).y).toBeCloseTo(0.35, 9);
  });

  it('palmSuspectFraction: how large a size change is held for confirmation', () => {
    // +20 % palm size: under the 30 % hard limit, over half of it.
    const first = frame(0, handAt(0.6, 0.5));
    const bigger = frame(FRAME_MS, handAt(0.6, 0.5, { palmSize: 0.17 * 1.2 }));
    expect(untouched(first).observe(bigger, 83)).toBeNull();
    expect(sampleOf(retuned('perception.palmSuspectFraction', 1, first).observe(bigger, 83)).continuous).toBe(true);
  });

  it('the suspect fractions also set how far a frame may move on from a held sample and still vouch for it', () => {
    const play = (config: YoyoConfig, frames: HandDetection[]) => run(new AnchorExtractor(config), frames.map(h => [h]));
    const relaxed = (key: string) => setConfigValue(createConfig(), key, 1);

    // Speed: 0.35 ih in one frame (10.5 ih/s) breaks the hard limit and is held; the next frame goes on 0.2 ih (6 ih/s) from it.
    const run1 = [handAt(0.6, 0.2), handAt(0.6, 0.2), handAt(0.6, 0.55), handAt(0.6, 0.75)];
    expect(play(createConfig(), run1)[3]).toBeNull();
    expect(sampleOf(play(relaxed('perception.speedSuspectFraction'), run1)[3]).continuous).toBe(false);

    // Size: a +40 % palm is held; the next frame is another +20 % on top of it.
    const big = 0.17 * 1.4;
    const run2 = [handAt(0.6, 0.5), handAt(0.6, 0.5), handAt(0.6, 0.5, { palmSize: big }), handAt(0.6, 0.5, { palmSize: big * 1.2 })];
    expect(play(createConfig(), run2)[3]).toBeNull();
    expect(sampleOf(play(relaxed('perception.palmSuspectFraction'), run2)[3]).continuous).toBe(false);
  });

  it('bottomExitY: how low the anchor of a vanished hand must be for the exit to be called bottom', () => {
    // A small hand whose lowest landmark (the wrist) stays clear of the border margin, so only the anchor's height can say «bottom».
    const low = frame(0, handAt(0.6, 0.88, { palmSize: 0.06 }));
    const probe = sampleOf(untouched(low).observe(frame(FRAME_MS, handAt(0.6, 0.88, { palmSize: 0.06 })), 83));
    expect(probe.edge).toBeUndefined();
    expect(probe.y).toBeGreaterThan(createConfig().perception.bottomExitY);
    expect(untouched(low).observe(frame(FRAME_MS), 83)).toMatchObject({ kind: 'absent', exitEdge: 'bottom' });
    expect(retuned('perception.bottomExitY', 0.95, low).observe(frame(FRAME_MS), 83)).not.toHaveProperty('exitEdge');
  });
});

describe('AnchorExtractor: reset and determinism', () => {
  it('forgets everything on reset, including the clock', () => {
    const e = new AnchorExtractor(createConfig());
    sampleOf(e.observe(frame(5000, handAt(0.6, 0.5)), 5050));
    e.reset();
    const s = sampleOf(e.observe(frame(10, handAt(0.9, 0.3)), 60));
    expect(s.continuous).toBe(false);
    expect(s.x).toBeCloseTo(0.9, 9);
  });

  it('gives identical output for identical input', () => {
    const frames = Array.from({ length: 40 }, (_, i) => [handAt(0.6 + 0.002 * Math.sin(i), 0.5 + (i === 20 ? 0.3 : 0.001 * i))]);
    const a = run(new AnchorExtractor(createConfig()), frames);
    const b = run(new AnchorExtractor(createConfig()), frames);
    expect(a).toEqual(b);
  });
});
