import { describe, it, expect, vi } from 'vitest';
import { createConfig } from '../config';
import { AnchorExtractor } from '../perception/AnchorExtractor';
import { buildHand, DEFAULT_PALM_SIZE, IMAGE_ASPECT, wristToAnchor } from './handPose';
import { matchDetections, runFrames } from './evaluate';
import { Random } from './random';
import {
  buildClip, buildCorpus, CORPUS_SIZE, createScene, DEFAULT_SEED, flick, FRAME_MS, labelOf, move, oscillation, randomPalm, renderScene, stroke, sumOffsets, sway,
  type Corpus, type Scene, type SyntheticClip,
} from './synthetic';

// Building and scoring a corpus takes about a second on a quiet machine and several on a busy one.
vi.setConfig({ testTimeout: 120_000 });

const tagValue = (clip: SyntheticClip, key: string): number => Number(clip.tags.find(t => t.startsWith(`${key}=`))?.slice(key.length + 1));

/** Samples a clip with a fresh extractor and returns the emitted anchors. */
function anchorsOf(clip: SyntheticClip) {
  const extractor = new AnchorExtractor(createConfig());
  const samples = [];
  for (const { frame, arrivalMs } of clip.frames) {
    const o = extractor.observe(frame, arrivalMs);
    if (o?.kind === 'sample') samples.push(o.sample);
  }
  return samples;
}

const std = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

describe('handPose', () => {
  const anchor = { x: 0.4, y: 0.55 };

  it('builds 21 landmarks with landmark 9 exactly on the requested anchor', () => {
    const hand = buildHand({ anchor });
    expect(hand.landmarks).toHaveLength(21);
    expect(hand.landmarks[9].x).toBeCloseTo(anchor.x, 12);
    expect(hand.landmarks[9].y).toBeCloseTo(anchor.y, 12);
  });

  it('has the palm size that was asked for, measured the way the extractor measures it', () => {
    for (const palmSize of [DEFAULT_PALM_SIZE, 0.12, 0.25]) {
      const extractor = new AnchorExtractor(createConfig());
      const o = extractor.observe({ timestampMs: 0, source: 'replay', hands: [buildHand({ anchor, palmSize })] }, 50);
      expect(o?.kind === 'sample' && o.sample.palmSize).toBeCloseTo(palmSize, 9);
    }
  });

  it('looks like a hand held up, palm toward the camera: fingers above the wrist, z in front of it', () => {
    const { landmarks } = buildHand({ anchor });
    for (const tip of [4, 8, 12, 16, 20]) expect(landmarks[tip].y).toBeLessThan(landmarks[0].y);
    expect(landmarks[12].y).toBeLessThan(landmarks[9].y);
    expect(landmarks[0].z).toBe(0);
    for (const p of landmarks.slice(1)) {
      expect(p.z).toBeLessThanOrEqual(-0.005);
      expect(p.z).toBeGreaterThanOrEqual(-0.09);
    }
  });

  it('is mirrored for the other hand: the thumb sits on the opposite side of the wrist', () => {
    const right = buildHand({ anchor, handedness: 'Right' });
    const left = buildHand({ anchor, handedness: 'Left' });
    expect(right.handedness).toBe('Right');
    expect(left.handedness).toBe('Left');
    expect(Math.sign(right.landmarks[4].x - right.landmarks[0].x)).toBe(1);
    expect(Math.sign(left.landmarks[4].x - left.landmarks[0].x)).toBe(-1);
  });

  it('tilts about the wrist: every landmark keeps its distance to it', () => {
    const palmSize = 0.17, tilt = 0.4;
    // Anchor of the tilted hand if the wrist stays where it was at tilt 0.
    const [x0, y0] = wristToAnchor(palmSize, 0);
    const [x1, y1] = wristToAnchor(palmSize, tilt);
    const upright = buildHand({ anchor, palmSize });
    const tilted = buildHand({ anchor: { x: anchor.x + (x1 - x0) / IMAGE_ASPECT, y: anchor.y + (y1 - y0) }, palmSize, tilt });
    expect(tilted.landmarks[0].x).toBeCloseTo(upright.landmarks[0].x, 12);
    expect(tilted.landmarks[0].y).toBeCloseTo(upright.landmarks[0].y, 12);
    const reach = (hand: typeof upright, i: number) => Math.hypot((hand.landmarks[i].x - hand.landmarks[0].x) * IMAGE_ASPECT, hand.landmarks[i].y - hand.landmarks[0].y);
    for (let i = 1; i < 21; i++) expect(reach(tilted, i)).toBeCloseTo(reach(upright, i), 9);
    // Positive tilt tips the fingers toward the image's right.
    expect(tilted.landmarks[12].x).toBeGreaterThan(upright.landmarks[12].x);
  });

  it('wristToAnchor is the real wrist → landmark 9 offset, in ih and unmirrored axes', () => {
    const hand = buildHand({ anchor, palmSize: 0.2, tilt: 0.25 });
    const [dx, dy] = wristToAnchor(0.2, 0.25);
    expect((hand.landmarks[9].x - hand.landmarks[0].x) * IMAGE_ASPECT).toBeCloseTo(dx, 12);
    expect(hand.landmarks[9].y - hand.landmarks[0].y).toBeCloseTo(dy, 12);
  });

  it('applies a depth error to every landmark but the wrist, which inflates the measured palm', () => {
    const base = buildHand({ anchor });
    const deep = buildHand({ anchor, zOffset: -0.06 });
    expect(deep.landmarks[0].z).toBe(0);
    for (let i = 1; i < 21; i++) expect(deep.landmarks[i].z).toBeCloseTo(base.landmarks[i].z - 0.06, 12);
  });
});

describe('synthetic clips', () => {
  it('are deterministic in (kind, seed, index) and independent of each other', () => {
    const a = buildClip('launch', DEFAULT_SEED, 7);
    const b = buildClip('launch', DEFAULT_SEED, 7);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(buildClip('launch', DEFAULT_SEED, 8))).not.toBe(JSON.stringify(a));
    expect(JSON.stringify(buildClip('launch', DEFAULT_SEED + 1, 7))).not.toBe(JSON.stringify(a));
    expect(JSON.stringify(buildClip('tug', DEFAULT_SEED, 7))).not.toBe(JSON.stringify(a));
  });

  it('deliver frames as the camera path would: increasing capture times, strictly increasing arrival 50–60 ms later', () => {
    for (const kind of ['launch', 'tug', 'non-event'] as const) {
      for (let i = 0; i < 12; i++) {
        const { frames } = buildClip(kind, DEFAULT_SEED, i);
        for (let j = 0; j < frames.length; j++) {
          const { frame, arrivalMs } = frames[j];
          expect(arrivalMs - frame.timestampMs).toBeGreaterThanOrEqual(50);
          expect(arrivalMs - frame.timestampMs).toBeLessThanOrEqual(60.01);
          if (j > 0) {
            expect(frame.timestampMs).toBeGreaterThan(frames[j - 1].frame.timestampMs);
            expect(arrivalMs).toBeGreaterThan(frames[j - 1].arrivalMs);
          }
        }
      }
    }
  });

  it('run at 30 fps with random phase and ±2 ms of timestamp jitter', () => {
    const firsts: number[] = [];
    const steps: number[] = [];
    for (let i = 0; i < 80; i++) {
      const { frames } = buildClip('tug', DEFAULT_SEED, i);
      firsts.push(frames[0].frame.timestampMs);
      for (let j = 1; j < frames.length; j++) steps.push(frames[j].frame.timestampMs - frames[j - 1].frame.timestampMs);
    }
    // The grid phase is spread over the whole frame period.
    expect(Math.min(...firsts)).toBeLessThan(FRAME_MS * 0.25);
    expect(Math.max(...firsts)).toBeGreaterThan(FRAME_MS * 0.75);
    // Gaps are whole frames ± the jitter of two timestamps (≤ 4 ms).
    for (const step of steps) {
      const frames = Math.round(step / FRAME_MS);
      expect(Math.abs(step - frames * FRAME_MS)).toBeLessThanOrEqual(4.01);
    }
    expect(steps.filter(s => s < FRAME_MS + 4.01).length / steps.length).toBeGreaterThan(0.9);
  });

  it('lose about 5 % of frames, in iid drops and bursts of two', () => {
    const clip = buildClip('long-tug-still', DEFAULT_SEED, 0);
    const drops = tagValue(clip, 'drops');
    const rate = drops / (drops + clip.frames.length);
    expect(rate).toBeGreaterThan(0.035);
    expect(rate).toBeLessThan(0.07);
    let doubles = 0;
    for (let j = 1; j < clip.frames.length; j++) {
      if (clip.frames[j].frame.timestampMs - clip.frames[j - 1].frame.timestampMs > 2.5 * FRAME_MS) doubles++;
    }
    expect(doubles).toBeGreaterThan(5);
  });

  it('carry the PRD jitter: σ ≈ 0.5 % of the width on the anchor, ≈ 2 % on the palm', () => {
    const clip = buildClip('long-tug-still', DEFAULT_SEED, 1);
    const samples = anchorsOf(clip);
    expect(samples.length).toBeGreaterThan(1500);
    const sx = std(samples.map(s => s.x)), sy = std(samples.map(s => s.y));
    // 0.0067 ih common-mode, plus 0.15 % per landmark and the palm scaling acting on landmark 9.
    expect(sx).toBeGreaterThan(0.006);
    expect(sx).toBeLessThan(0.009);
    expect(sy).toBeGreaterThan(0.0065);
    expect(sy).toBeLessThan(0.0105);
    const palms = samples.map(s => s.palmSize);
    const relative = std(palms) / (palms.reduce((a, b) => a + b, 0) / palms.length);
    expect(relative).toBeGreaterThan(0.012);
    expect(relative).toBeLessThan(0.04);
  });

  it('only contain hands with 21 landmarks in the unmirrored image, and none once the hand has left through the bottom', () => {
    for (let i = 0; i < 60; i++) {
      const { frames } = buildClip('launch', DEFAULT_SEED, i);
      for (const { frame } of frames) {
        expect(frame.source).toBe('replay');
        for (const hand of frame.hands) {
          expect(hand.landmarks).toHaveLength(21);
          expect(hand.landmarks[9].y).toBeLessThanOrEqual(0.97);
          expect(hand.landmarks[0].y).toBeLessThanOrEqual(1.02);
          expect(hand.landmarks.every(p => Number.isFinite(p.x + p.y + p.z))).toBe(true);
        }
      }
    }
  });
});

describe('ground truth', () => {
  /** Noise-free speed of the scene's anchor at t, ih/s, by a symmetric difference. */
  const speedAt = (anchorAt: (t: number) => readonly [number, number], t: number) => {
    const h = 0.5;
    const a = anchorAt(t - h), b = anchorAt(t + h);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / (2 * h / 1000);
  };

  function checkLabels(kind: 'launch' | 'tug', windowAfterStart: (label: { motionStartMs: number; onsetMs: number }) => number) {
    let checked = 0;
    for (let i = 0; checked < 40; i++) {
      const scene = createScene(kind, DEFAULT_SEED, i);
      // A swaying hand adds its own speed to the anchor; the label is about the gesture alone.
      if (scene.tags.includes('sway')) continue;
      checked++;
      expect(scene.labels).toHaveLength(1);
      const label = scene.labels[0];
      expect(label.kind).toBe(kind);
      expect(label.motionStartMs).toBeLessThanOrEqual(label.onset10Ms);
      expect(label.onset10Ms).toBeLessThan(label.onsetMs);

      let peak = 0;
      for (let t = label.motionStartMs; t <= windowAfterStart(label); t += 0.25) peak = Math.max(peak, speedAt(scene.anchorAt, t));
      expect(peak).toBeCloseTo(label.peakSpeed, 1);
      // At the labelled instants the speed is 50 % / 10 % of the peak, and just before it was still below: first crossings.
      expect(speedAt(scene.anchorAt, label.onsetMs) / peak).toBeCloseTo(0.5, 2);
      expect(speedAt(scene.anchorAt, label.onset10Ms) / peak).toBeCloseTo(0.1, 2);
      expect(speedAt(scene.anchorAt, label.onsetMs - 3)).toBeLessThan(0.5 * peak);
      expect(speedAt(scene.anchorAt, label.onset10Ms - 3)).toBeLessThan(0.1 * peak);
    }
  }

  it('onsets of launches are where the noise-free speed first reaches 50 % and 10 % of its peak', () => {
    checkLabels('launch', l => l.onsetMs + 120);
  });

  it('onsets of tugs are where the noise-free speed first reaches 50 % and 10 % of its peak', () => {
    checkLabels('tug', l => l.motionStartMs + 200);
  });
});

describe('clean track', () => {
  it('is the noise-free anchor at every slot of the clip\'s own frame grid, dropped frames included', () => {
    for (const kind of ['launch', 'tug', 'non-event'] as const) {
      for (let i = 0; i < 6; i++) {
        const clip = buildClip(kind, DEFAULT_SEED, i);
        const scene = createScene(kind, DEFAULT_SEED, i);
        const drops = tagValue(clip, 'drops');
        expect(clip.clean).toHaveLength(clip.frames.length + drops);
        // Every delivered frame's time is a grid slot, and the grid is increasing.
        const slots = new Set(clip.clean.map(p => p.t));
        for (const { frame } of clip.frames) expect(slots.has(frame.timestampMs)).toBe(true);
        clip.clean.forEach((p, j) => {
          if (j > 0) expect(p.t).toBeGreaterThan(clip.clean[j - 1].t);
          const [x, y] = scene.anchorAt(p.t);
          expect(p.x).toBe(x);
          expect(p.y).toBe(y);
        });
      }
    }
  });

  it('carries no landmark noise: on a still clip every slot has the same position', () => {
    const clip = buildClip('long-launch-still', DEFAULT_SEED, 0);
    expect(new Set(clip.clean.map(p => `${p.x}|${p.y}`)).size).toBe(1);
  });
});

describe('composing scenes from the exported builders', () => {
  /** tether → launch → sleep (swaying) → tug → rest: the kind of session the next stage will assemble. */
  function session(seed: number): Scene {
    const rng = new Random(seed);
    const launchDir: [number, number] = [0.05, 0.99];
    const down = stroke(900, 60, 80, 90, 2.4, launchDir);
    const pull = flick(4200, 150, 1.3, [0.03, -1]);
    const motions = [
      down,
      // The hand only sways once the yoyo sleeps; before the throw it is tethered and still.
      oscillation(1500, 2600, 0.6, 0.04, [1, 0.1], 0.5, 300),
      pull,
      move(5200, 700, [0, 0.1]),
      oscillation(6000, 600, 3, 0.01, [1, 0], 0, 100),
    ];
    const rest = sumOffsets(motions);
    return {
      durationMs: 7000,
      anchorAt: t => { const o = rest(t); return [0.9 + o[0], 0.2 + o[1]]; },
      tiltAt: () => 0,
      palmSize: randomPalm(rng),
      handedness: 'Right',
      labels: [labelOf('launch', down, 900), labelOf('tug', pull, 4200)],
      glitches: [],
      glitchGuards: [],
      tags: ['session'],
    };
  }

  it('exports every builder a session needs', () => {
    for (const builder of [stroke, flick, move, sway, oscillation, labelOf, randomPalm, sumOffsets, renderScene]) expect(typeof builder).toBe('function');
    // A motion is zero before it starts; strokes, flicks and moves hold their final displacement, sway and oscillation do not stop at all / return to zero.
    const f = flick(500, 150, 1.2, [0, -1]);
    expect(Math.hypot(...f.offset(400))).toBe(0);
    expect(f.offset(2000)[1]).toBeCloseTo(-(1.2 * 0.15) / 1.875, 12);
    expect(oscillation(500, 400, 2, 0.05, [1, 0], 0, 100).offset(2000)).toEqual([0, 0]);
  });

  it('renders to a clip with the same noise model, and its labels are the ground truth', () => {
    const scene = session(3);
    const clip = renderScene(scene, new Random(11), { id: 'session-0', kind: 'non-event', armed: { launch: true, tug: true } });
    expect(clip.labels.map(l => l.kind)).toEqual(['launch', 'tug']);
    expect(clip.clean).toHaveLength(clip.frames.length + tagValue(clip, 'drops'));
    expect(clip.frames.length).toBeGreaterThan(190);
    // The motion builders keep their promises: the stroke starts when it says and the flick's onset lies inside it.
    expect(scene.labels[0].motionStartMs).toBe(900);
    expect(scene.labels[1].onsetMs).toBeGreaterThan(4200);
    expect(scene.labels[1].onsetMs).toBeLessThan(4350);
  });

  it('is deterministic, and the stack finds the launch and the tug in it, in that order, near their onsets', () => {
    const render = () => renderScene(session(3), new Random(11), { id: 'session-0', kind: 'non-event', armed: { launch: true, tug: true } });
    expect(JSON.stringify(render())).toBe(JSON.stringify(render()));
    const clip = render();
    const detections = runFrames(clip.frames, clip.armed, createConfig());
    const match = matchDetections(clip.labels, detections);
    expect(match.matched.map(m => m.label.kind)).toEqual(['launch', 'tug']);
    expect(match.falsePositives).toEqual([]);
  });
});

describe('amplitude (seated preset)', () => {
  it('scales how far and how fast the hand moves, not when, and not the noise', () => {
    for (const kind of ['launch', 'tug', 'non-event'] as const) {
      const full = createScene(kind, DEFAULT_SEED, 9);
      const seated = createScene(kind, DEFAULT_SEED, 9, 0.7);
      const origin = full.anchorAt(0);
      for (const t of [0, 300, 800, 1200, 2500]) {
        const a = full.anchorAt(t), b = seated.anchorAt(t);
        expect(b[0] - origin[0]).toBeCloseTo(0.7 * (a[0] - origin[0]), 12);
        expect(b[1] - origin[1]).toBeCloseTo(0.7 * (a[1] - origin[1]), 12);
      }
      expect(seated.durationMs).toBe(full.durationMs);
      full.labels.forEach((l, i) => {
        expect(seated.labels[i].onsetMs).toBe(l.onsetMs);
        expect(seated.labels[i].peakSpeed).toBeCloseTo(0.7 * l.peakSpeed, 12);
      });
    }
    // Same random stream, so the frame timing and the jitter are those of the standing clip.
    const a = buildClip('tug', DEFAULT_SEED, 4), b = buildClip('tug', DEFAULT_SEED, 4, 0.7);
    expect(b.frames.map(f => f.frame.timestampMs)).toEqual(a.frames.map(f => f.frame.timestampMs));
    expect(b.frames.map(f => f.arrivalMs)).toEqual(a.frames.map(f => f.arrivalMs));
    expect(buildCorpus(7, 0.7).amplitude).toBe(0.7);
  });

  it('leaves amplitude 1 untouched', () => {
    expect(JSON.stringify(buildClip('launch', DEFAULT_SEED, 3, 1))).toBe(JSON.stringify(buildClip('launch', DEFAULT_SEED, 3)));
  });
});

describe('corpus', () => {
  // One build shared by the checks below (≈ 0.6 s).
  let corpus: Corpus | undefined;
  const get = () => (corpus ??= buildCorpus());

  it('has the sizes of the spec and clips equal to the individually built ones', () => {
    const c = get();
    expect(c.seed).toBe(DEFAULT_SEED);
    expect(c.launch).toHaveLength(400);
    expect(c.tug).toHaveLength(400);
    expect(c.nonEvent).toHaveLength(300);
    expect(c.stress).toHaveLength(CORPUS_SIZE.stress);
    expect(c.long).toHaveLength(CORPUS_SIZE.longTugStill + CORPUS_SIZE.longTugSway + CORPUS_SIZE.longTugGlitchy + CORPUS_SIZE.longLaunchStill);
    expect(JSON.stringify(c.tug[123])).toBe(JSON.stringify(buildClip('tug', DEFAULT_SEED, 123)));
    expect(JSON.stringify(c.nonEvent[299])).toBe(JSON.stringify(buildClip('non-event', DEFAULT_SEED, 299)));
  });

  it('is identical for the same seed and different for another', () => {
    const again = buildCorpus();
    const checksum = (c: Corpus) => [...c.launch, ...c.tug, ...c.nonEvent, ...c.long, ...c.stress]
      .reduce((sum, clip) => sum + clip.frames.reduce((s, f) => s + f.frame.timestampMs + f.arrivalMs + f.frame.hands.reduce((h, d) => h + d.landmarks[9].x * 1e3 + d.landmarks[9].y * 1e3, 0), 0), 0);
    expect(checksum(again)).toBe(checksum(get()));
    expect(checksum(buildCorpus(7))).not.toBe(checksum(get()));
  });

  it('arms what each kind of clip is about', () => {
    const c = get();
    for (const clip of c.launch) expect(clip.armed).toEqual({ launch: true, tug: false });
    for (const clip of c.tug) expect(clip.armed).toEqual({ launch: false, tug: true });
    for (const clip of [...c.nonEvent, ...c.stress]) expect(clip.armed).toEqual({ launch: true, tug: true });
    const longTug = c.long.filter(l => l.tags.includes('still-60s') || l.tags.includes('sway'));
    expect(longTug).toHaveLength(8);
    for (const clip of longTug) {
      expect(clip.armed).toEqual({ launch: false, tug: true });
      expect(clip.durationMs).toBe(60_000);
      expect(clip.labels).toEqual([]);
    }
    const longLaunch = c.long.filter(l => l.tags.includes('still-5s'));
    expect(longLaunch).toHaveLength(10);
    for (const clip of longLaunch) expect(clip.armed).toEqual({ launch: true, tug: false });
  });

  it('launch clips follow the spec: peak 1.5–3.0 ih/s, within ±25° of vertical, 20 % leaving through the bottom', () => {
    const c = get();
    for (const clip of c.launch) {
      expect(clip.labels).toHaveLength(1);
      expect(clip.labels[0].peakSpeed).toBeGreaterThanOrEqual(1.5);
      expect(clip.labels[0].peakSpeed).toBeLessThanOrEqual(3.0);
      expect(Math.abs(tagValue(clip, 'angle'))).toBeLessThanOrEqual(25.5);
      expect(clip.tags.includes('windup') || clip.tags.includes('still')).toBe(true);
      if (clip.tags.includes('windup')) {
        const up = tagValue(clip, 'windup');
        expect(up).toBeGreaterThanOrEqual(0.02);
        expect(up).toBeLessThanOrEqual(0.1);
      }
    }
    const exits = c.launch.filter(clip => clip.tags.includes('exit'));
    expect(exits.length / c.launch.length).toBeGreaterThan(0.14);
    expect(exits.length / c.launch.length).toBeLessThan(0.26);
    for (const clip of exits) {
      expect(tagValue(clip, 'goneFrames')).toBeGreaterThan(0);
      expect(clip.frames.some(f => f.frame.hands.length === 0)).toBe(true);
    }
  });

  it('tug clips follow the spec: peak 0.8–1.6 ih/s in 100–200 ms, within ±25° of vertical, swaying or still', () => {
    const c = get();
    let swaying = 0;
    for (const clip of c.tug) {
      expect(clip.labels).toHaveLength(1);
      expect(clip.labels[0].peakSpeed).toBeGreaterThanOrEqual(0.8);
      expect(clip.labels[0].peakSpeed).toBeLessThanOrEqual(1.6);
      expect(tagValue(clip, 'dur')).toBeGreaterThanOrEqual(100);
      expect(tagValue(clip, 'dur')).toBeLessThanOrEqual(200);
      expect(Math.abs(tagValue(clip, 'angle'))).toBeLessThanOrEqual(25.5);
      expect(clip.tags.includes('sway') || clip.tags.includes('still')).toBe(true);
      if (clip.tags.includes('sway')) {
        swaying++;
        expect(tagValue(clip, 'swayAmp')).toBeLessThanOrEqual(0.06);
        expect(tagValue(clip, 'swayHz')).toBeGreaterThanOrEqual(0.3);
        expect(tagValue(clip, 'swayHz')).toBeLessThanOrEqual(1.2);
      }
    }
    expect(swaying / c.tug.length).toBeGreaterThan(0.4);
    expect(swaying / c.tug.length).toBeLessThan(0.6);
  });

  it('non-event clips last 4–8 s, mix two or three behaviours and carry no labels', () => {
    for (const clip of get().nonEvent) {
      expect(clip.labels).toEqual([]);
      expect(clip.durationMs).toBeGreaterThanOrEqual(4000);
      expect(clip.durationMs).toBeLessThanOrEqual(8000);
      const kinds = new Set((clip.segments ?? []).map(s => s.tag));
      expect(kinds.size).toBeGreaterThanOrEqual(2);
      expect(kinds.size).toBeLessThanOrEqual(3);
      for (const seg of clip.segments ?? []) {
        if (seg.tag === 'readjust' || seg.tag === 'scratch') expect(seg.peak!).toBeLessThanOrEqual(0.6 + 1e-9);
        if (seg.tag === 'arc') {
          expect(seg.peak!).toBeGreaterThanOrEqual(0.5);
          expect(seg.peak!).toBeLessThanOrEqual(1.8);
        }
      }
    }
  });

  it('stress clips go faster than the gate set: casual peaks of 0.6–1.2 ih/s', () => {
    const peaks = get().stress.map(s => s.casualPeak!);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(Math.max(...peaks)).toBeGreaterThan(1.0);
  });

  it('puts glitches in a quarter of the gesture clips and never inside the window where the gesture is detected', () => {
    const gestures = [...get().launch, ...get().tug];
    const glitchy = gestures.filter(clip => tagValue(clip, 'glitched') > 0);
    expect(glitchy.length / gestures.length).toBeGreaterThan(0.15);
    expect(glitchy.length / gestures.length).toBeLessThan(0.35);
    for (const clip of glitchy) {
      const [label] = clip.labels;
      for (const tag of clip.tags.filter(t => t.startsWith('glitchAt='))) {
        const at = Number(tag.slice('glitchAt='.length));
        const inside = at >= label.motionStartMs - 100 && at <= label.onsetMs + 160;
        expect(inside).toBe(false);
      }
    }
  });

  it('runs 60 s for the long clips and 5 s for the Y-02 stillness clips', () => {
    for (const clip of get().long) {
      const expected = clip.tags.includes('still-5s') ? 5000 : 60_000;
      expect(clip.durationMs).toBe(expected);
      expect(clip.frames.length).toBeGreaterThan((expected / FRAME_MS) * 0.85);
    }
  });
});
