import { describe, it, expect, vi } from 'vitest';
import type { HandFrame } from '../../shared/contracts';
import type { ReplayFile } from '../contracts';
import { createConfig, setConfigValue } from '../config';
import { buildHand } from './handPose';
import { parseReplay, serializeReplay } from './replayFile';
import {
  compareLaunchReadings, evaluateCasualSet, evaluateClip, evaluateCorpus, evaluateReplayFile, evaluateStress, GATE, kindStats, matchDetections,
  literalLaunchLatencyFrames, OTHER_SEEDS, percentiles, prdOracle, quietStats, recallBreakdown, recordedConfig, replayConfig, replayPreset, robustnessSeeds, runFrames, SEED_METRICS, spreadOf, summarizeSeed, summarizeSeeds,
  type Detection, type SeedSummary,
} from './evaluate';
import { buildClip, DEFAULT_SEED, type CleanSample, type Corpus, type DeliveredFrame, type GestureLabel, type SyntheticClip } from './synthetic';

// Building and scoring a corpus takes about a second on a quiet machine and several on a busy one.
vi.setConfig({ testTimeout: 120_000 });

const label = (kind: 'launch' | 'tug', onsetMs: number): GestureLabel => ({ kind, onsetMs, onset10Ms: onsetMs - 20, motionStartMs: onsetMs - 40, peakSpeed: 2 });
const detection = (kind: 'launch' | 'tug', timestampMs: number, sampleIndex = 0): Detection => ({ kind, timestampMs, arrivalMs: timestampMs + 50, strength: 1.5, sampleIndex });

describe('matchDetections', () => {
  it('matches a detection of the same kind inside [onset − 100, onset + 400], edges included', () => {
    for (const t of [900, 1000, 1250, 1400]) {
      const r = matchDetections([label('launch', 1000)], [detection('launch', t)]);
      expect(r.matched).toHaveLength(1);
      expect(r.falsePositives).toEqual([]);
      expect(r.missed).toEqual([]);
    }
  });

  it('calls everything else a false positive, and an unclaimed label a miss', () => {
    const labels = [label('launch', 1000)];
    for (const t of [899.9, 1400.1]) {
      const r = matchDetections(labels, [detection('launch', t)]);
      expect(r.matched).toEqual([]);
      expect(r.falsePositives).toHaveLength(1);
      expect(r.missed).toEqual(labels);
    }
    // A tug in a launch's window is not that launch.
    const wrongKind = matchDetections(labels, [detection('tug', 1050)]);
    expect(wrongKind.falsePositives).toHaveLength(1);
    expect(wrongKind.missed).toEqual(labels);
  });

  it('is one-to-one: a second detection for the same gesture is a false positive', () => {
    const r = matchDetections([label('tug', 1000)], [detection('tug', 1050), detection('tug', 1200)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].detection.timestampMs).toBe(1050);
    expect(r.falsePositives.map(d => d.timestampMs)).toEqual([1200]);
  });

  it('hands each detection to the earliest unclaimed label it fits, whatever the input order', () => {
    const labels = [label('launch', 1300), label('launch', 1000)];
    const detections = [detection('launch', 1350), detection('launch', 1100)];
    const r = matchDetections(labels, detections);
    expect(r.matched).toHaveLength(2);
    const pairs = r.matched.map(m => [m.label.onsetMs, m.detection.timestampMs]);
    // 1100 fits only the label at 1000 (1300 − 100 = 1200 > 1100); 1350 then takes the label at 1300 (1000 + 400 = 1400 would also fit, but is taken).
    expect(pairs).toContainEqual([1000, 1100]);
    expect(pairs).toContainEqual([1300, 1350]);
    expect(r.falsePositives).toEqual([]);
    expect(r.missed).toEqual([]);
  });

  it('reports detections with no labels at all as false positives', () => {
    const r = matchDetections([], [detection('launch', 5), detection('tug', 9)]);
    expect(r.falsePositives).toHaveLength(2);
  });
});

describe('statistics', () => {
  it('computes nearest-rank percentiles and handles nothing to rank', () => {
    expect(percentiles([])).toEqual({ count: 0, p50: NaN, p95: NaN, max: NaN });
    expect(percentiles([4])).toEqual({ count: 1, p50: 4, p95: 4, max: 4 });
    const p = percentiles([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]);
    expect(p).toEqual({ count: 10, p50: 5, p95: 10, max: 10 });
    expect(percentiles(Array.from({ length: 100 }, (_, i) => i + 1)).p95).toBe(95);
  });

  it('defines precision and recall without dividing by zero', () => {
    expect(kindStats(0, 0, 0)).toEqual({ tp: 0, fp: 0, fn: 0, precision: 1, recall: 1 });
    expect(kindStats(9, 1, 3)).toMatchObject({ precision: 0.9, recall: 0.75 });
    expect(kindStats(0, 2, 0).precision).toBe(0);
  });
});

/** A hand frame at a mirrored anchor, as the extractor test builds them. */
function handFrame(t: number, y: number, withHand = true): DeliveredFrame {
  const frame: HandFrame = { timestampMs: t, source: 'replay', hands: withHand ? [buildHand({ anchor: { x: 0.4, y } })] : [] };
  return { frame, arrivalMs: t + 50 };
}

/** A still hand for 700 ms and then a 200 ms fast stroke down, at 30 fps. */
function strokeFrames(skip: (index: number) => 'drop' | 'gone' | undefined = () => undefined): DeliveredFrame[] {
  const frames: DeliveredFrame[] = [];
  for (let i = 0; i < 45; i++) {
    const t = 1000 + i * (1000 / 30);
    const u = Math.min(1, Math.max(0, (t - 1700) / 200));
    const y = 0.3 + 0.2 * (u * u * u * (10 - 15 * u + 6 * u * u));
    const action = skip(i);
    if (action === 'drop') continue;
    frames.push(handFrame(t, y, action !== 'gone'));
  }
  return frames;
}

describe('runFrames', () => {
  it('feeds a fresh extractor and classifier and reports detections with their position among hand frames', () => {
    const detections = runFrames(strokeFrames(), { launch: true, tug: false }, createConfig());
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('launch');
    expect(detections[0].timestampMs).toBeGreaterThan(1700);
    expect(detections[0].timestampMs).toBeLessThan(1900);
    expect(detections[0].sampleIndex).toBe(Math.round((detections[0].timestampMs - 1000) / (1000 / 30)));
  });

  it('counts only frames with a hand, so lost frames do not inflate latency', () => {
    const lost = (i: number) => (i > 5 && i < 12 ? 'gone' as const : undefined);
    const base = runFrames(strokeFrames(), { launch: true, tug: false }, createConfig())[0];
    const withLoss = runFrames(strokeFrames(lost), { launch: true, tug: false }, createConfig());
    // The hand is lost and found again long before the stroke: the launch is still detected, 6 hand frames earlier in the count.
    expect(withLoss).toHaveLength(1);
    expect(withLoss[0].sampleIndex).toBe(base.sampleIndex - 6);
  });

  it('a hand lost for a frame in the middle of the stroke (a blur) does not break it: the stroke straddles the loss and is still a launch', () => {
    const cut = (i: number) => (i === 25 ? 'gone' as const : undefined);
    const detections = runFrames(strokeFrames(cut), { launch: true, tug: false }, createConfig());
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('launch');
  });

  it('a hand lost for longer than perception.strokeGapMs breaks it: a stroke that straddles that loss is not a launch', () => {
    const config = createConfig();
    // Frames 22 to 29: eight frames, about 270 ms, longer than the 170 ms the track survives.
    const cut = (i: number) => (i >= 22 && i <= 29 ? 'gone' as const : undefined);
    expect(8 * (1000 / 30)).toBeGreaterThan(config.perception.strokeGapMs);
    expect(runFrames(strokeFrames(cut), { launch: true, tug: false }, config)).toEqual([]);
  });

  it('is silent when nothing is armed', () => {
    expect(runFrames(strokeFrames(), { launch: false, tug: false }, createConfig())).toEqual([]);
  });
});

describe('runFrames: a hand that leaves', () => {
  /** A calm hand low in the frame, one fast interval down (3 ih/s), then no hand: a throw that carries the hand out through the bottom. */
  function exitingThrow(): DeliveredFrame[] {
    const frames: DeliveredFrame[] = [];
    for (let i = 0; i < 24; i++) frames.push(handFrame(1000 + i * (1000 / 30), 0.7));
    frames.push(handFrame(1000 + 24 * (1000 / 30), 0.79));
    frames.push(handFrame(1000 + 25 * (1000 / 30), 0.79, false));
    for (let i = 26; i < 30; i++) frames.push(handFrame(1000 + i * (1000 / 30), 0.79, false));
    return frames;
  }

  it('completes the launch on the absence, and counts the absent frame as the next delivered frame', () => {
    const detections = runFrames(exitingThrow(), { launch: true, tug: false }, createConfig());
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('launch');
    expect(detections[0].timestampMs).toBeCloseTo(1000 + 25 * (1000 / 30), 6);
    // 25 frames carried a hand (0..24): the absent frame is the 26th delivered frame.
    expect(detections[0].sampleIndex).toBe(25);
  });

  it('without launchOnExit the same exit only resets the classifier, as before absent() existed', () => {
    expect(runFrames(exitingThrow(), { launch: true, tug: false }, createConfig(), { launchOnExit: false })).toEqual([]);
  });
});

describe('prdOracle: the PRD literal rules on a clean path', () => {
  const FRAME = 1000 / 30;
  const config = createConfig();
  /** A clean track at 30 fps from a path function. */
  const track = (path: (tMs: number) => { x: number; y: number }, durationMs = 2000, phase = 0): CleanSample[] => {
    const out: CleanSample[] = [];
    for (let t = phase; t < durationMs; t += FRAME) out.push({ t, ...path(t) });
    return out;
  };
  const minJerk = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));
  const move = (t0: number, durationMs: number, dy: number, base = 0.4) => (t: number) => ({ x: 0.7, y: base + dy * minJerk((t - t0) / durationMs) });

  it('flags nothing on a still hand', () => {
    expect(prdOracle(track(() => ({ x: 0.7, y: 0.4 })), config)).toEqual({ tug: false, launch: false });
  });

  it('flags a tug: a quick flick up after a calm hand', () => {
    expect(prdOracle(track(move(1000, 150, -0.09)), config)).toEqual({ tug: true, launch: false });
  });

  it('flags a launch: a fast stroke down after a calm hand, and one after a small wind-up', () => {
    expect(prdOracle(track(move(1000, 200, 0.25)), config)).toEqual({ tug: false, launch: true });
    // 0.06 ih up over 250 ms starting 700 ms in; the stroke starts at 1000 ms: the quiet window before it is not quiet, the wind-up counts.
    const windup = (t: number) => ({ x: 0.7, y: 0.4 - 0.06 * minJerk((t - 700) / 250) + 0.31 * minJerk((t - 1000) / 220) });
    expect(prdOracle(track(windup), config).launch).toBe(true);
  });

  it('does not flag slow motion: a reposition below the PRD threshold, or one that is not preceded by quiet', () => {
    // 0.25 ih up over 1.2 s (peak 0.39 ih/s): 0.04 ih in 3 frames is never reached.
    expect(prdOracle(track(move(500, 1200, -0.25)), config).tug).toBe(false);
    // Fast enough, but the hand was drifting up at 0.9 ih/s before: robust speed over the quiet window is above
    // tug.stillSpeed (0.8 since the second real replay; a dip DOWN is allowed, a hand already rising is not quiet).
    // The drift starts with the clip, so no quiet window precedes it either.
    const drifting = (t: number) => ({ x: 0.7, y: 0.95 - 0.9 * (Math.min(t, 1000) / 1000) - 0.09 * minJerk((t - 1000) / 150) });
    expect(prdOracle(track(drifting), config).tug).toBe(false);
    // The original 0.5 ih/s drift is still rejected when quiet means < 0.35 ih/s.
    const slowDrift = (t: number) => ({ x: 0.7, y: 0.4 - 0.5 * (Math.min(t, 1000) / 1000) - 0.09 * minJerk((t - 1000) / 150) });
    expect(prdOracle(track(slowDrift), setConfigValue(config, 'tug.stillSpeed', 0.35)).tug).toBe(false);
  });

  it('needs the history: a gesture in the first 300 ms has no quiet window behind it', () => {
    expect(prdOracle(track(move(100, 150, -0.09)), config).tug).toBe(false);
    expect(prdOracle(track(move(100, 200, 0.25)), config).launch).toBe(false);
  });

  it('respects direction: a flick that points sideways, or a stroke that points up, is not flagged', () => {
    // 76° off vertical: past tug.maxAngleDeg (70° since the second real replay, where diagonal tugs reached ~69°).
    expect(prdOracle(track(t => ({ x: 0.7 + 0.2 * minJerk((t - 1000) / 150), y: 0.4 - 0.05 * minJerk((t - 1000) / 150) })), config).tug).toBe(false);
    expect(prdOracle(track(move(1000, 200, -0.25)), config).launch).toBe(false);
  });

  it('uses the config it is given, thresholds included', () => {
    const flick = track(move(1000, 150, -0.09));
    expect(prdOracle(flick, setConfigValue(config, 'tug.minUpDelta', 0.12)).tug).toBe(false);
    expect(prdOracle(flick, setConfigValue(config, 'tug.minUpDelta', 0.02)).tug).toBe(true);
  });
});

describe('literalLaunchLatencyFrames: what the PRD rule itself can do without noise', () => {
  const FRAME = 1000 / 30;
  const config = createConfig();
  const minJerk = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));
  const clip = (path: (t: number) => number, onsetMs: number): Pick<SyntheticClip, 'clean' | 'labels'> => ({
    clean: Array.from({ length: 90 }, (_, i) => ({ t: i * FRAME, x: 0.7, y: path(i * FRAME) })),
    labels: [{ kind: 'launch', onsetMs, onset10Ms: onsetMs - 20, motionStartMs: onsetMs - 40, peakSpeed: 2 }],
  });

  it('counts the frames from the first sample at or past the onset to the one that completes two fast intervals', () => {
    // Steady 1.5 ih/s from 1000 ms on (0.05 ih per frame): the first fast interval ends at the first frame past 1000, the second one frame later.
    const steady = clip(t => 0.3 + (t > 1000 ? (1.5 * (t - 1000)) / 1000 : 0), 1000);
    expect(literalLaunchLatencyFrames(steady, config)).toBe(2);
    // An onset annotated one frame later is the same detection, one frame sooner.
    expect(literalLaunchLatencyFrames({ ...steady, labels: [{ ...steady.labels[0], onsetMs: 1000 + FRAME }] }, config)).toBe(1);
  });

  it('is null when the rule never fires, or the clip has no launch label', () => {
    expect(literalLaunchLatencyFrames(clip(() => 0.3, 1000), config)).toBeNull();
    expect(literalLaunchLatencyFrames({ clean: clip(() => 0.3, 1000).clean, labels: [] }, config)).toBeNull();
    // Too slow: 0.6 ih/s never reaches 1.2.
    expect(literalLaunchLatencyFrames(clip(t => 0.3 + 0.6 * minJerk((t - 1000) / 1500) * 1.5, 1000), config)).toBeNull();
  });

  it('follows the config like the oracle does', () => {
    const steady = clip(t => 0.3 + (t > 1000 ? (1.5 * (t - 1000)) / 1000 : 0), 1000);
    expect(literalLaunchLatencyFrames(steady, setConfigValue(config, 'launch.minDownSpeed', 2))).toBeNull();
    expect(literalLaunchLatencyFrames(steady, setConfigValue(config, 'launch.sustainFrames', 3))).toBe(3);
  });
});

describe('evaluateClip', () => {
  it('scores a synthetic clip and measures latency in delivered frames from the first at or after the onset', () => {
    let matchedAny = false;
    for (let i = 0; i < 25; i++) {
      const clip = buildClip('launch', DEFAULT_SEED, i);
      const result = evaluateClip(clip, createConfig());
      expect(result.clip.id).toBe(clip.id);
      expect(result.match.matched.length + result.match.missed.length).toBe(1);
      for (const l of result.latencies) {
        matchedAny = true;
        const hands = clip.frames.filter(f => f.frame.hands.length > 0).map(f => f.frame.timestampMs);
        const detected = result.match.matched[0].detection;
        const first = hands.findIndex(t => t >= clip.labels[0].onsetMs);
        expect(l.frames).toBe(hands.indexOf(detected.timestampMs) - first);
        expect(l.msFromOnset).toBeCloseTo(detected.timestampMs - clip.labels[0].onsetMs, 9);
        expect(l.msFromOnset10).toBeCloseTo(detected.timestampMs - clip.labels[0].onset10Ms, 9);
        expect(l.msToArrival - l.msFromOnset).toBeCloseTo(detected.arrivalMs - detected.timestampMs, 9);
        expect(l.msFromOnset10).toBeGreaterThan(l.msFromOnset);
        expect(l.kind).toBe('launch');
      }
    }
    expect(matchedAny).toBe(true);
  });

  it('attributes detections in a clip with no labels to false positives', () => {
    const clip = buildClip('launch', DEFAULT_SEED, 3);
    const unlabelled: SyntheticClip = { ...clip, labels: [] };
    const result = evaluateClip(unlabelled, createConfig());
    expect(result.match.matched).toEqual([]);
    expect(result.match.falsePositives.length).toBe(result.detections.length);
  });
});

describe('evaluateCorpus', () => {
  const clips = (kind: 'launch' | 'tug' | 'non-event' | 'long-tug-still' | 'long-launch-still', n: number) => Array.from({ length: n }, (_, i) => buildClip(kind, DEFAULT_SEED, i));
  const small: Corpus = {
    seed: DEFAULT_SEED,
    amplitude: 1,
    launch: clips('launch', 12),
    tug: clips('tug', 12),
    nonEvent: clips('non-event', 6),
    long: [...clips('long-launch-still', 3)],
    stress: [],
  };

  it('tallies each kind, the quiet clips and the latency, and states the six gates', () => {
    const ev = evaluateCorpus(small, createConfig());
    expect(ev.perKind.launch.tp + ev.perKind.launch.fn).toBe(12);
    expect(ev.perKind.tug.tp + ev.perKind.tug.fn).toBe(12);
    expect(ev.nonEvent.clips).toBe(6);
    expect(ev.long.clips).toBe(3);
    expect(ev.gates.map(g => g.id)).toEqual([
      'Y-S1 launch precision', 'Y-S1 launch recall', 'Y-S1 tug precision', 'Y-S1 tug recall', 'Y-S1 quiet', 'Y-S2 latency',
    ]);
    expect(ev.latency.all.frames.count).toBe(ev.perKind.launch.tp + ev.perKind.tug.tp);
    expect(ev.gates.find(g => g.id === 'Y-S1 launch recall')!.pass).toBe(ev.perKind.launch.recall >= GATE.recall);
    expect(ev.long.triggers).toBe(0);
  });

  /** A launch clip posing as a non-event: its stroke is a launch by the PRD's own rule, so a trigger on it is no error. */
  const asNonEvent = (clip: SyntheticClip, clean: CleanSample[] = clip.clean): SyntheticClip => ({ ...clip, kind: 'non-event', labels: [], armed: { launch: true, tug: true }, clean });
  /** The same frames, but the clean path says the hand never moved: the stroke is then tracking noise, and a trigger is a false positive. */
  const stillTrack = (clip: SyntheticClip): CleanSample[] => clip.clean.map(p => ({ ...p, y: clip.clean[0].y, x: clip.clean[0].x }));

  it('does not count a trigger on a casual clip the PRD rule flags, and counts one it does not flag', () => {
    const stroke = buildClip('launch', DEFAULT_SEED, 0);
    const flagged: Corpus = { ...small, nonEvent: [asNonEvent(stroke)] };
    const ev = evaluateCorpus(flagged, createConfig());
    expect(ev.nonEvent.ambiguousClips.launch).toBe(1);
    expect(ev.nonEvent.onAmbiguous.launch).toBeGreaterThanOrEqual(1);
    expect(ev.nonEvent.onConsistent.launch).toBe(0);
    expect(ev.gates.find(g => g.id === 'Y-S1 quiet')!.pass).toBe(true);
    // The full casual set still reports the trigger, labelled: nothing disappears.
    expect(ev.nonEvent.triggers).toBeGreaterThanOrEqual(1);

    const unflagged: Corpus = { ...small, nonEvent: [asNonEvent(stroke, stillTrack(stroke))] };
    const bad = evaluateCorpus(unflagged, createConfig());
    expect(bad.nonEvent.ambiguousClips.launch).toBe(0);
    expect(bad.nonEvent.onConsistent.launch).toBeGreaterThanOrEqual(1);
    expect(bad.gates.find(g => g.id === 'Y-S1 quiet')!.pass).toBe(false);
    expect(bad.failures.some(f => f.problem === 'false-positive' && f.prdAmbiguous === false)).toBe(true);
  });

  it('counts triggers on consistent non-events as false positives of the kind, and says so in the gate', () => {
    const stroke = buildClip('launch', DEFAULT_SEED, 0);
    const base = evaluateCorpus(small, createConfig());
    const bad = evaluateCorpus({ ...small, nonEvent: [asNonEvent(stroke, stillTrack(stroke))] }, createConfig());
    expect(bad.perKind.launch.fp).toBe(base.perKind.launch.fp + bad.nonEvent.onConsistent.launch);
    expect(bad.falsePositives.launch.consistentNonEvent).toBe(bad.nonEvent.onConsistent.launch);
    expect(bad.perKind.launch.precision).toBeLessThan(base.perKind.launch.precision);
    // The old definition (event clips only) is kept next to it.
    expect(bad.perKindEventClips.launch.fp).toBe(base.perKindEventClips.launch.fp);
    const gate = bad.gates.find(g => g.id === 'Y-S1 launch precision')!;
    expect(gate.description).toMatch(/launch clips \+ non-event clips the PRD rule does not flag/);
    expect(gate.value).toMatch(/in consistent non-events/);
    // Per kind: a launch trigger never counts against tug precision.
    expect(bad.perKind.tug.fp).toBe(base.perKind.tug.fp);
  });

  it('fails the latency gate on a late detection', () => {
    const ev = evaluateCorpus(small, createConfig());
    const gate = ev.gates.find(g => g.id === 'Y-S2 latency')!;
    expect(gate.pass).toBe(ev.latency.all.overBound === 0);
  });

  it('lists misses and late detections as failure cases with the clip that caused them', () => {
    const ev = evaluateCorpus(small, createConfig());
    for (const f of ev.failures) {
      expect(['false-positive', 'missed', 'late']).toContain(f.problem);
      expect(f.clipId).toMatch(/^(launch|tug|non-event|long-)/);
      expect(f.tags.length).toBeGreaterThan(0);
    }
    const lateCount = ev.failures.filter(f => f.problem === 'late').length;
    expect(lateCount).toBe(ev.latency.all.overBound);
  });
});

describe('stress and breakdowns', () => {
  it('buckets stress clips by their fastest casual motion', () => {
    const clips = Array.from({ length: 12 }, (_, i) => buildClip('stress', DEFAULT_SEED, i));
    const buckets = evaluateStress(clips, createConfig());
    expect(buckets.map(b => [b.from, b.to])).toEqual([[0.6, 0.8], [0.8, 1.0], [1.0, 1.2], [1.2, Infinity]]);
    expect(buckets.reduce((n, b) => n + b.clips, 0)).toBe(clips.length);
    for (const b of buckets) {
      expect(b.clipsWithTriggers).toBeLessThanOrEqual(b.clips);
      expect(b.triggers).toBeGreaterThanOrEqual(b.clipsWithTriggers);
    }
  });

  it('splits recall by a grouping function and skips clips the function drops', () => {
    const results = Array.from({ length: 30 }, (_, i) => evaluateClip(buildClip('launch', DEFAULT_SEED, i), createConfig()));
    const split = recallBreakdown(results, r => (r.clip.tags.includes('windup') ? 'windup' : 'still'));
    expect(Object.keys(split).sort()).toEqual(['still', 'windup']);
    expect(split.still.clips + split.windup.clips).toBe(30);
    expect(split.still.recall).toBeGreaterThan(0.5);
    const none = recallBreakdown(results, () => undefined);
    expect(none).toEqual({});
  });
});

describe('launch reading comparison and casual sets', () => {
  const mini: Corpus = {
    seed: DEFAULT_SEED, amplitude: 1,
    launch: Array.from({ length: 40 }, (_, i) => buildClip('launch', DEFAULT_SEED, i)),
    tug: [], nonEvent: Array.from({ length: 12 }, (_, i) => buildClip('non-event', DEFAULT_SEED, i)),
    long: [buildClip('long-launch-still', DEFAULT_SEED, 0)], stress: Array.from({ length: 10 }, (_, i) => buildClip('stress', DEFAULT_SEED, i)),
  };

  it('evaluates both readings and summarizes the launch side of each', () => {
    const cmp = compareLaunchReadings(mini, createConfig());
    expect(Object.keys(cmp).sort()).toEqual(['mean', 'strict']);
    for (const reading of ['strict', 'mean'] as const) {
      const { summary } = cmp[reading];
      expect(summary.reading).toBe(reading);
      expect(summary.latency.frames.count).toBeGreaterThan(30);
      expect(Object.keys(summary.launchTriggers).sort()).toEqual(['long', 'nonEventAmbiguous', 'nonEventConsistent', 'stressAmbiguous', 'stressConsistent']);
    }
    // The mean reading accepts everything the strict one accepts, so it can only find more, and sooner.
    expect(cmp.mean.summary.launchRecall).toBeGreaterThanOrEqual(cmp.strict.summary.launchRecall);
    expect(cmp.mean.summary.latency.frames.p50).toBeLessThanOrEqual(cmp.strict.summary.latency.frames.p50);
  });

  it('tallies a casual set with the oracle split, and quietStats agrees with evaluateCasualSet', () => {
    const stats = evaluateCasualSet(mini.stress, createConfig());
    expect(stats.clips).toBe(10);
    expect(stats.triggers).toBe(stats.onAmbiguous.launch + stats.onAmbiguous.tug + stats.onConsistent.launch + stats.onConsistent.tug);
    const results = mini.stress.map(c => evaluateClip(c, createConfig()));
    expect(quietStats(results)).toEqual(stats);
  });
});

describe('evaluateReplayFile', () => {
  /** What the opt-in recorder would write for a synthetic clip: normalized landmarks, capture and arrival times. */
  function fileOf(clip: SyntheticClip, labels?: ReplayFile['labels']): ReplayFile {
    return {
      schema: 'yoyo-replay/1',
      frames: clip.frames.map(({ frame, arrivalMs }) => ({
        t: frame.timestampMs,
        a: arrivalMs,
        hands: frame.hands.map(h => ({ h: h.handedness, lm: h.landmarks.map(p => [p.x, p.y, p.z] as [number, number, number]) })),
      })),
      ...(labels ? { labels } : {}),
    };
  }

  it('runs a recorded file with both intents armed, and without labels only reports detections', () => {
    const clip = buildClip('launch', DEFAULT_SEED, 0);
    const out = evaluateReplayFile(fileOf(clip), createConfig());
    expect(out.scored).toBeUndefined();
    expect(out.detections.some(d => d.kind === 'launch')).toBe(true);
  });

  it('scores precision, recall and latency when the file carries labels, through the file format round trip', () => {
    const clip = buildClip('launch', DEFAULT_SEED, 0);
    const onset = clip.labels[0].onsetMs;
    const file = parseReplay(serializeReplay(fileOf(clip, [{ kind: 'launch', onsetMs: onset }])));
    const out = evaluateReplayFile(file, createConfig());
    expect(out.scored).toBeDefined();
    expect(out.scored!.perKind.launch).toMatchObject({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
    expect(out.scored!.latency.frames.count).toBe(1);
    expect(out.scored!.latency.frames.max).toBeLessThanOrEqual(GATE.maxLatencyFrames + 2);
  });

  it('counts a label nothing matches as a miss and an unlabelled detection as a false positive', () => {
    const clip = buildClip('launch', DEFAULT_SEED, 0);
    const file = fileOf(clip, [{ kind: 'tug', onsetMs: clip.labels[0].onsetMs }]);
    const out = evaluateReplayFile(file, createConfig());
    expect(out.scored!.perKind.tug).toMatchObject({ tp: 0, fn: 1 });
    expect(out.scored!.perKind.launch.fp).toBeGreaterThanOrEqual(1);
  });

  it('arms only what options.armed says: a launch-only run reports no tug, a tug-only run no launch', () => {
    const clip = buildClip('launch', DEFAULT_SEED, 0);
    const file = fileOf(clip);
    const launchOnly = evaluateReplayFile(file, createConfig(), { armed: { launch: true, tug: false } });
    expect(launchOnly.detections.some(d => d.kind === 'launch')).toBe(true);
    expect(launchOnly.detections.every(d => d.kind === 'launch')).toBe(true);
    expect(evaluateReplayFile(file, createConfig(), { armed: { launch: false, tug: true } }).detections.some(d => d.kind === 'launch')).toBe(false);
    expect(evaluateReplayFile(file, createConfig(), { armed: { launch: false, tug: false } }).detections).toEqual([]);
  });
});

describe('the config a recording is judged with', () => {
  const file = (config: unknown): ReplayFile => ({ schema: 'yoyo-replay/1', frames: [], ...(config === undefined ? {} : { config }) });

  it('is the preset the file names, and standing when it names none', () => {
    expect(replayPreset(file({ preset: 'seated' }))).toBe('seated');
    expect(replayPreset(file({ preset: 'standing' }))).toBe('standing');
    for (const config of [undefined, null, 'seated', 42, {}, { preset: 'kneeling' }]) expect(replayPreset(file(config))).toBe('standing');
  });

  it('is that preset at today\'s thresholds', () => {
    expect(replayConfig(file({ preset: 'seated' }))).toEqual(createConfig('seated'));
    expect(replayConfig(file(undefined))).toEqual(createConfig('standing'));
  });

  it('can also be the thresholds the file was recorded with, laid over today\'s preset field by field', () => {
    const recorded = file({ preset: 'seated', launch: { minDownSpeed: 0.5, windupMaxUp: 0.084 }, perception: { maxSpeed: 5 }, refractoryMs: 123, unknownField: 7 });
    const config = recordedConfig(recorded);
    expect(config.preset).toBe('seated');
    expect(config.launch.minDownSpeed).toBe(0.5);
    expect(config.launch.windupMaxUp).toBe(0.084);
    expect(config.perception.maxSpeed).toBe(5);
    expect(config.refractoryMs).toBe(123);
    // What the file does not say keeps today's value, including fields that did not exist when it was recorded.
    expect(config.launch.windupWindowMs).toBe(createConfig('seated').launch.windupWindowMs);
    expect(config.perception.strokeGapMs).toBe(createConfig('seated').perception.strokeGapMs);
    expect(config).not.toHaveProperty('unknownField');
    // Nothing numeric from the file may be NaN or non-numeric: a bad value is ignored.
    const bad = recordedConfig(file({ launch: { minDownSpeed: 'fast', sustainFrames: null }, perception: { maxSpeed: Number.NaN } }));
    expect(bad).toEqual(createConfig('standing'));
  });

  it('never changes the config it started from: every call returns a fresh object', () => {
    const a = replayConfig(file({ preset: 'seated' }));
    a.launch.minDownSpeed = 99;
    expect(replayConfig(file({ preset: 'seated' })).launch.minDownSpeed).toBe(createConfig('seated').launch.minDownSpeed);
  });
});

describe('robustness across seeds', () => {
  const clips = (kind: 'launch' | 'tug' | 'non-event' | 'long-launch-still', n: number, seed = DEFAULT_SEED) => Array.from({ length: n }, (_, i) => buildClip(kind, seed, i));
  const tiny = (seed: number): Corpus => ({ seed, amplitude: 1, launch: clips('launch', 8, seed), tug: clips('tug', 8, seed), nonEvent: clips('non-event', 4, seed), long: clips('long-launch-still', 2, seed), stress: [] });

  it('lists ten distinct seeds, the gate seed first, whatever the gate seed is', () => {
    expect(robustnessSeeds(DEFAULT_SEED)).toEqual([DEFAULT_SEED, 11, 22, 33, 44, 55, 66, 77, 88, 99]);
    for (const gate of [DEFAULT_SEED, 11, 99, 111, 5]) {
      const list = robustnessSeeds(gate);
      expect(list).toHaveLength(10);
      expect(new Set(list).size).toBe(10);
      expect(list[0]).toBe(gate);
      expect(list.slice(1).every(seed => OTHER_SEEDS.includes(seed))).toBe(true);
    }
  });

  it('takes the minimum, mean and maximum of the finite values only', () => {
    expect(spreadOf([4, 1, 7])).toEqual({ min: 1, mean: 4, max: 7 });
    expect(spreadOf([2, Number.NaN, 4])).toEqual({ min: 2, mean: 3, max: 4 });
    const none = spreadOf([]);
    expect([none.min, none.mean, none.max].every(Number.isNaN)).toBe(true);
  });

  it('summarizes an evaluation without changing a single number of it', () => {
    const ev = evaluateCorpus(tiny(DEFAULT_SEED), createConfig());
    const s = summarizeSeed(DEFAULT_SEED, ev);
    expect(s.seed).toBe(DEFAULT_SEED);
    for (const kind of ['launch', 'tug'] as const) {
      expect(s[kind]).toEqual({ precision: ev.perKind[kind].precision, recall: ev.perKind[kind].recall });
      expect(s.consistentTriggers[kind]).toBe(ev.nonEvent.onConsistent[kind]);
      expect(s.latency[kind].matched).toBe(ev.latency[kind].frames.count);
      expect(s.latency[kind].maxFrames).toBe(ev.latency[kind].frames.max);
      expect(s.latency[kind].overBound).toBe(ev.latency[kind].overBound);
    }
    expect(s.longTriggers).toBe(ev.long.triggers);
    expect(s.latency.all).toEqual({ matched: ev.latency.all.frames.count, maxFrames: ev.latency.all.frames.max, overBound: ev.latency.all.overBound });
    expect(s.latency.launch.overBound + s.latency.tug.overBound).toBe(s.latency.all.overBound);
    expect(s.gates).toEqual(Object.fromEntries(ev.gates.map(g => [g.id, g.pass])));
  });

  it('spreads every metric over the seeds and counts the seeds that pass each gate', () => {
    const seed = (n: number, over: Partial<SeedSummary>): SeedSummary => ({
      seed: n,
      launch: { precision: 1, recall: 0.9 }, tug: { precision: 0.96, recall: 0.8 },
      consistentTriggers: { launch: 0, tug: 2 }, longTriggers: 0,
      latency: { launch: { matched: 10, maxFrames: 3, overBound: 1 }, tug: { matched: 10, maxFrames: 2, overBound: 0 }, all: { matched: 20, maxFrames: 3, overBound: 1 } },
      gates: { 'Y-S1 quiet': true, 'Y-S2 latency': false },
      ...over,
    });
    const a = seed(1, {});
    const b = seed(2, { launch: { precision: 0.5, recall: 1 }, consistentTriggers: { launch: 1, tug: 6 }, longTriggers: 4, gates: { 'Y-S1 quiet': false, 'Y-S2 latency': false } });
    const r = summarizeSeeds([a, b]);
    expect(r.seeds.map(x => x.seed)).toEqual([1, 2]);
    expect(r.spread.launchPrecision).toEqual({ min: 0.5, mean: 0.75, max: 1 });
    expect(r.spread.launchRecall.max).toBe(1);
    expect(r.spread.tugPrecision).toEqual({ min: 0.96, mean: 0.96, max: 0.96 });
    expect(r.spread.consistentTugTriggers).toEqual({ min: 2, mean: 4, max: 6 });
    expect(r.spread.consistentLaunchTriggers).toEqual({ min: 0, mean: 0.5, max: 1 });
    expect(r.spread.longTriggers).toEqual({ min: 0, mean: 2, max: 4 });
    expect(r.spread.latencyMaxFrames).toEqual({ min: 3, mean: 3, max: 3 });
    expect(r.spread.tugLatencyMaxFrames.max).toBe(2);
    expect(r.spread.overBound).toEqual({ min: 1, mean: 1, max: 1 });
    expect(r.gatesPassing).toEqual({ 'Y-S1 quiet': 1, 'Y-S2 latency': 0 });
    expect(Object.keys(r.spread).sort()).toEqual(SEED_METRICS.map(m => m.id).sort());
    expect(new Set(SEED_METRICS.map(m => m.id)).size).toBe(SEED_METRICS.length);
  });
});
