import type { ArmedIntents, IntentKind, ReplayFile } from '../contracts';
import { createConfig, type Preset, type YoyoConfig } from '../config';
import { AnchorExtractor } from '../perception/AnchorExtractor';
import { IntentClassifier, type ClassifierOptions, type LaunchReading } from '../perception/IntentClassifier';
import { fitLine, MIN_FIT_POINTS } from '../perception/robust';
import { replayFrames } from './replayFile';
import type { CleanSample, Corpus, DeliveredFrame, GestureLabel, SyntheticClip } from './synthetic';

/**
 * Runs the perception stack over replays and scores it against ground truth: the matching rules
 * of PRD Y-S1, the latency of Y-S2. The same code path scores synthetic clips and, once Luis
 * records some, real fixtures with hand-added labels.
 */

/** A detection matches a label of its kind when its capture time lies in [onset − EARLY, onset + LATE]. */
export const MATCH_EARLY_MS = 100;
export const MATCH_LATE_MS = 400;

/** Y-S1 thresholds and the Y-S2 latency bound, straight from the PRD. */
export const GATE = { precision: 0.95, recall: 0.85, maxLatencyFrames: 2 } as const;

export interface EvaluationOptions {
  /** How the classifier under test reads «sustained» (see LaunchReading). Default: the classifier's own default. */
  classifier?: ClassifierOptions;
  /**
   * What a lost hand does to the classifier. true (default): `absent()`, which may complete a
   * launch the exit cut short. false: `reset()`, the behaviour before `absent()` existed, kept
   * so the improvement can be measured against it.
   */
  launchOnExit?: boolean;
  /**
   * Which intents a recorded replay arms (evaluateReplayFile). Default: both, which is not what the app
   * does (it arms a launch while tethered and a tug while sleeping, never both), so a real throw
   * recording is judged launch-only first and with both armed second, to see what each costs.
   */
  armed?: ArmedIntents;
}

export interface Detection {
  kind: IntentKind;
  timestampMs: number;
  arrivalMs: number;
  strength: number;
  /**
   * Position among the delivered frames that carried a hand (0 = the first one). A detection
   * made on an absence (a launch cut short by the hand leaving) counts the absent frame as the
   * delivered frame that follows the last hand frame.
   */
  sampleIndex: number;
}

/**
 * Fresh extractor and classifier over delivered frames, in arrival order. A lost hand goes
 * through `absent()`, as the runtime does: it may complete a launch that the hand's exit cut short.
 */
export function runFrames(frames: readonly DeliveredFrame[], armed: ArmedIntents, config: YoyoConfig, options: EvaluationOptions = {}): Detection[] {
  const extractor = new AnchorExtractor(config);
  const classifier = new IntentClassifier(config, options.classifier);
  const detections: Detection[] = [];
  let sampleIndex = -1;
  for (const { frame, arrivalMs } of frames) {
    if (frame.hands.length > 0) sampleIndex++;
    const observation = extractor.observe(frame, arrivalMs);
    if (!observation) continue;
    if (observation.kind === 'absent') {
      if (options.launchOnExit === false) {
        classifier.reset();
        continue;
      }
      const event = classifier.absent(observation.timestampMs, observation.arrivalMs, observation.exitEdge, armed);
      if (event) detections.push({ kind: event.kind, timestampMs: event.timestampMs, arrivalMs: event.arrivalMs, strength: event.strength, sampleIndex: sampleIndex + (frame.hands.length > 0 ? 0 : 1) });
      continue;
    }
    const event = classifier.push(observation.sample, armed);
    if (event) detections.push({ kind: event.kind, timestampMs: event.timestampMs, arrivalMs: event.arrivalMs, strength: event.strength, sampleIndex });
  }
  return detections;
}

export interface MatchResult {
  /** Detections that matched a label, with the label they matched. */
  matched: Array<{ detection: Detection; label: GestureLabel }>;
  falsePositives: Detection[];
  /** Labels nothing matched. */
  missed: GestureLabel[];
}

/**
 * One-to-one matching in time order: a detection takes the earliest still-unmatched label of its
 * kind whose window contains it; everything else is a false positive, every unclaimed label a miss.
 */
export function matchDetections(labels: readonly GestureLabel[], detections: readonly Detection[]): MatchResult {
  const taken = new Set<GestureLabel>();
  const matched: MatchResult['matched'] = [];
  const falsePositives: Detection[] = [];
  const ordered = [...detections].sort((a, b) => a.timestampMs - b.timestampMs);
  const byOnset = [...labels].sort((a, b) => a.onsetMs - b.onsetMs);
  for (const detection of ordered) {
    const label = byOnset.find(l => !taken.has(l) && l.kind === detection.kind
      && detection.timestampMs >= l.onsetMs - MATCH_EARLY_MS && detection.timestampMs <= l.onsetMs + MATCH_LATE_MS);
    if (label) { taken.add(label); matched.push({ detection, label }); } else falsePositives.push(detection);
  }
  return { matched, falsePositives, missed: labels.filter(l => !taken.has(l)) };
}

// ---------------------------------------------------------------------------------------------
// Y-S1 consistency oracle
// ---------------------------------------------------------------------------------------------

/** The oracle's windows must reach back their full duration, give or take one 30 fps frame. */
const ORACLE_FRAME_MS = 1000 / 30;

/** Does the clean path already satisfy the PRD's literal rule for each kind? */
export interface PrdVerdict {
  tug: boolean;
  launch: boolean;
}

const angleFromAxis = (dx: number, along: number) => (Math.atan2(Math.abs(dx), along) * 180) / Math.PI;

/** Robust (least-squares) speed over the `windowMs` that end at sample `end`, or null if the track does not reach back that far. */
function speedBefore(track: readonly CleanSample[], end: number, windowMs: number): number | null {
  const tEnd = track[end].t;
  let from = end;
  while (from - 1 >= 0 && track[from - 1].t >= tEnd - windowMs) from--;
  if (end - from + 1 < MIN_FIT_POINTS || track[from].t > tEnd - windowMs + ORACLE_FRAME_MS) return null;
  const fit = fitLine(i => track[i], from, end + 1);
  return fit ? Math.hypot(fit.vx, fit.vy) : null;
}

function literalTug(track: readonly CleanSample[], c: YoyoConfig['tug']): boolean {
  for (let n = 1; n < track.length; n++) {
    for (let k = 1; k <= Math.min(c.maxFrames, n); k++) {
      const start = n - k;
      const rise = track[start].y - track[n].y;
      if (rise < c.minUpDelta || angleFromAxis(track[n].x - track[start].x, rise) > c.maxAngleDeg) continue;
      const quiet = speedBefore(track, start, c.stillBeforeMs);
      if (quiet !== null && quiet < c.stillSpeed) return true;
    }
  }
  return false;
}

/** «A small upward preparation»: within windupWindowMs before the stroke, the hand rose by windupMinUp…windupMaxUp, in a mostly vertical line. */
function literalWindup(track: readonly CleanSample[], start: number, c: YoyoConfig['launch']): boolean {
  let origin = -1, rise = 0;
  for (let i = start - 1; i >= 0 && track[i].t >= track[start].t - c.windupWindowMs; i--) {
    const lift = track[i].y - track[start].y;
    if (lift > rise) { rise = lift; origin = i; }
  }
  if (origin < 0 || rise < c.windupMinUp || rise > c.windupMaxUp) return false;
  return angleFromAxis(track[start].x - track[origin].x, rise) <= c.maxAngleDeg;
}

/** Index of the sample at which the PRD's literal launch rule first holds on a clean track, or -1. */
function firstLiteralLaunch(track: readonly CleanSample[], c: YoyoConfig['launch']): number {
  for (let n = c.sustainFrames; n < track.length; n++) {
    const start = n - c.sustainFrames;
    let fast = true;
    for (let i = start + 1; i <= n && fast; i++) fast = (track[i].y - track[i - 1].y) / ((track[i].t - track[i - 1].t) / 1000) >= c.minDownSpeed;
    if (!fast) continue;
    const dy = track[n].y - track[start].y;
    if (!(dy > 0) || angleFromAxis(track[n].x - track[start].x, dy) > c.maxAngleDeg) continue;
    const quiet = speedBefore(track, start, c.stillWindowMs);
    if ((quiet !== null && quiet < c.stillSpeed) || literalWindup(track, start, c)) return n;
  }
  return -1;
}

const literalLaunch = (track: readonly CleanSample[], c: YoyoConfig['launch']): boolean => firstLiteralLaunch(track, c) >= 0;

/**
 * Applies ONLY the PRD's literal rules, with the config's thresholds, to a clean (noise-free)
 * anchor path sampled at the clip's own frame times. No extra condition, no jitter, no drops, no
 * glitches. A casual clip this flags is a tug or a launch BY DEFINITION: asking a classifier for
 * «0 triggers» on it contradicts the PRD itself, so Y-S1 is judged on the clips it does not flag.
 *
 * - tug: some n and k ≤ tug.maxFrames with y[n−k] − y[n] ≥ tug.minUpDelta, within tug.maxAngleDeg
 *   of vertical, after robust speed < tug.stillSpeed over tug.stillBeforeMs ending at sample n−k.
 * - launch: launch.sustainFrames consecutive intervals with vy ≥ launch.minDownSpeed, the stroke
 *   within launch.maxAngleDeg of vertical, after robust speed < launch.stillSpeed over
 *   launch.stillWindowMs ending at the stroke's first sample, or after a wind-up of
 *   windupMinUp…windupMaxUp within windupWindowMs.
 */
export function prdOracle(track: readonly CleanSample[], config: YoyoConfig): PrdVerdict {
  return { tug: literalTug(track, config.tug), launch: literalLaunch(track, config.launch) };
}

/**
 * Frames after the annotated onset at which the PRD's literal launch rule first fires on the
 * NOISE-FREE path of a launch clip (0 = the first sample at or past the onset), counted on the
 * clip's own 30 fps grid; null if the clip has no launch label or the rule never fires on it.
 * This is the best any classifier that implements the rule as written can do, and so what the
 * Y-S2 latency of the real, noisy runs is to be read against.
 */
export function literalLaunchLatencyFrames(clip: Pick<SyntheticClip, 'clean' | 'labels'>, config: YoyoConfig): number | null {
  const label = clip.labels.find(l => l.kind === 'launch');
  if (!label) return null;
  const n = firstLiteralLaunch(clip.clean, config.launch);
  const first = clip.clean.findIndex(p => p.t >= label.onsetMs);
  return n < 0 || first < 0 ? null : n - first;
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentiles; NaN when there is nothing to rank. */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { count: 0, p50: NaN, p95: NaN, max: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1] };
}

/** Latency of one matched detection. */
export interface Latency {
  /** Delivered frames after the first one at or past the onset (0 = that very frame). */
  frames: number;
  msFromOnset: number;
  msFromOnset10: number;
  /** From the onset to the moment the app could react (arrival of the detecting frame). */
  msToArrival: number;
}

/** Hand-carrying frames' capture times, ascending: the clock the frame counts run on. */
function sampleTimes(frames: readonly DeliveredFrame[]): number[] {
  return frames.filter(f => f.frame.hands.length > 0).map(f => f.frame.timestampMs);
}

function latencyOf(times: readonly number[], detection: Detection, label: GestureLabel): Latency {
  let first = times.findIndex(t => t >= label.onsetMs);
  if (first < 0) first = times.length;
  return {
    frames: detection.sampleIndex - first,
    msFromOnset: detection.timestampMs - label.onsetMs,
    msFromOnset10: detection.timestampMs - label.onset10Ms,
    msToArrival: detection.arrivalMs - label.onsetMs,
  };
}

export interface ClipResult {
  clip: Pick<SyntheticClip, 'id' | 'kind' | 'tags' | 'labels' | 'armed'>;
  detections: Detection[];
  match: MatchResult;
  latencies: Array<Latency & { kind: IntentKind; clipId: string }>;
  /** What the PRD's literal rules say about the clip's clean path; computed for casual clips (non-event, stress, long) only. */
  prd?: PrdVerdict;
}

/** Runs one clip and scores it. */
export function evaluateClip(clip: SyntheticClip, config: YoyoConfig, options: EvaluationOptions = {}): ClipResult {
  const detections = runFrames(clip.frames, clip.armed, config, options);
  const match = matchDetections(clip.labels, detections);
  const times = sampleTimes(clip.frames);
  const latencies = match.matched.map(m => ({ ...latencyOf(times, m.detection, m.label), kind: m.label.kind, clipId: clip.id }));
  const casual = clip.kind !== 'launch' && clip.kind !== 'tug';
  return {
    clip: { id: clip.id, kind: clip.kind, tags: clip.tags, labels: clip.labels, armed: clip.armed },
    detections, match, latencies,
    ...(casual ? { prd: prdOracle(clip.clean, config) } : {}),
  };
}

export interface KindStats {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

export function kindStats(tp: number, fp: number, fn: number): KindStats {
  return { tp, fp, fn, precision: tp + fp === 0 ? 1 : tp / (tp + fp), recall: tp + fn === 0 ? 1 : tp / (tp + fn) };
}

export interface LatencySummary {
  frames: Percentiles;
  msFromOnset: Percentiles;
  msFromOnset10: Percentiles;
  msToArrival: Percentiles;
  /** Matched detections later than the Y-S2 bound. */
  overBound: number;
}

export function summarizeLatency(latencies: readonly Latency[]): LatencySummary {
  return {
    frames: percentiles(latencies.map(l => l.frames)),
    msFromOnset: percentiles(latencies.map(l => l.msFromOnset)),
    msFromOnset10: percentiles(latencies.map(l => l.msFromOnset10)),
    msToArrival: percentiles(latencies.map(l => l.msToArrival)),
    overBound: latencies.filter(l => l.frames > GATE.maxLatencyFrames).length,
  };
}

export interface Gate {
  id: string;
  description: string;
  value: string;
  pass: boolean;
}

/** One misbehaving clip, with enough context to reproduce it from the seed. */
export interface FailureCase {
  clipId: string;
  problem: 'false-positive' | 'missed' | 'late';
  kind: IntentKind;
  detail: string;
  tags: string[];
  /** For a trigger on a casual clip: the PRD's literal rule flags that clip for this kind, so the trigger is consistent with the PRD. */
  prdAmbiguous?: boolean;
}

/**
 * Detections over a set of casual clips (they should produce none), split by what the PRD's
 * literal rules say about each clip's clean path. «Ambiguous» clips are tugs or launches by the
 * PRD's own definition, so a trigger there is not a classifier error.
 */
export interface QuietStats {
  clips: number;
  clipsWithTriggers: number;
  triggers: number;
  byKind: Record<IntentKind, number>;
  /** Clips whose clean path satisfies the PRD's literal rule for that kind. */
  ambiguousClips: Record<IntentKind, number>;
  /** Triggers of a kind on clips flagged for that kind, and on clips that are not. */
  onAmbiguous: Record<IntentKind, number>;
  onConsistent: Record<IntentKind, number>;
}

const perKind = <T>(make: () => T): Record<IntentKind, T> => ({ launch: make(), tug: make() });

export function quietStats(results: readonly ClipResult[]): QuietStats {
  const stats: QuietStats = {
    clips: results.length, clipsWithTriggers: 0, triggers: 0,
    byKind: perKind(() => 0), ambiguousClips: perKind(() => 0), onAmbiguous: perKind(() => 0), onConsistent: perKind(() => 0),
  };
  for (const r of results) {
    if (r.detections.length) stats.clipsWithTriggers++;
    for (const kind of ['launch', 'tug'] as const) if (r.prd?.[kind]) stats.ambiguousClips[kind]++;
    for (const d of r.detections) {
      stats.triggers++;
      stats.byKind[d.kind]++;
      (r.prd?.[d.kind] ? stats.onAmbiguous : stats.onConsistent)[d.kind]++;
    }
  }
  return stats;
}

/** Runs a set of casual clips (stress, or any other that should stay quiet) and tallies the triggers. */
export function evaluateCasualSet(clips: readonly SyntheticClip[], config: YoyoConfig, options: EvaluationOptions = {}): QuietStats {
  return quietStats(clips.map(c => evaluateClip(c, config, options)));
}

export interface Evaluation {
  /**
   * The Y-S1 numbers. Precision counts a kind's event clips AND the non-event clips the PRD's
   * literal rule does not flag for that kind: a trigger on such a clip is a false positive.
   * Recall is over the event clips' labels.
   */
  perKind: Record<IntentKind, KindStats>;
  /** Where each kind's false positives in `perKind` came from. */
  falsePositives: Record<IntentKind, { eventClips: number; consistentNonEvent: number }>;
  /** The same counts with precision over the event clips alone: a trigger on any non-event is not counted. */
  perKindEventClips: Record<IntentKind, KindStats>;
  /** FULL casual set, includes motions that are tugs or launches by the PRD definition (see `ambiguousClips`). */
  nonEvent: QuietStats;
  long: QuietStats;
  latency: Record<IntentKind | 'all', LatencySummary>;
  gates: Gate[];
  failures: FailureCase[];
  results: { launch: ClipResult[]; tug: ClipResult[]; nonEvent: ClipResult[]; long: ClipResult[] };
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;

function failuresOf(results: readonly ClipResult[], quiet: boolean): FailureCase[] {
  const out: FailureCase[] = [];
  for (const r of results) {
    for (const d of r.match.falsePositives) {
      out.push({
        clipId: r.clip.id, problem: 'false-positive', kind: d.kind, tags: r.clip.tags,
        detail: `${d.kind} at ${d.timestampMs.toFixed(0)} ms, strength ${d.strength.toFixed(2)}${quiet ? '' : ', no label in window'}`,
        ...(r.prd ? { prdAmbiguous: r.prd[d.kind] } : {}),
      });
    }
    for (const l of r.match.missed) {
      out.push({ clipId: r.clip.id, problem: 'missed', kind: l.kind, detail: `onset ${l.onsetMs.toFixed(0)} ms, peak ${l.peakSpeed.toFixed(2)} ih/s`, tags: r.clip.tags });
    }
    for (const lat of r.latencies) {
      if (lat.frames > GATE.maxLatencyFrames) {
        out.push({ clipId: r.clip.id, problem: 'late', kind: lat.kind, detail: `${lat.frames} frames (${lat.msFromOnset.toFixed(0)} ms) after onset`, tags: r.clip.tags });
      }
    }
  }
  return out;
}

/** Scores a corpus against the Y-S1 and Y-S2 gates. */
export function evaluateCorpus(corpus: Corpus, config: YoyoConfig, options: EvaluationOptions = {}): Evaluation {
  const run = (clips: readonly SyntheticClip[]) => clips.map(c => evaluateClip(c, config, options));
  const results = { launch: run(corpus.launch), tug: run(corpus.tug), nonEvent: run(corpus.nonEvent), long: run(corpus.long) };
  const nonEvent = quietStats(results.nonEvent);
  const long = quietStats(results.long);

  const eventClips = (kind: IntentKind) => ({
    tp: results[kind].reduce((n, r) => n + r.match.matched.length, 0),
    fp: results[kind].reduce((n, r) => n + r.match.falsePositives.length, 0),
    fn: results[kind].reduce((n, r) => n + r.match.missed.length, 0),
  });
  const counts = { launch: eventClips('launch'), tug: eventClips('tug') };
  const falsePositives = perKind(() => ({ eventClips: 0, consistentNonEvent: 0 }));
  const stats = perKind(() => kindStats(0, 0, 0));
  const eventOnly = perKind(() => kindStats(0, 0, 0));
  for (const kind of ['launch', 'tug'] as const) {
    const { tp, fp, fn } = counts[kind];
    falsePositives[kind] = { eventClips: fp, consistentNonEvent: nonEvent.onConsistent[kind] };
    stats[kind] = kindStats(tp, fp + nonEvent.onConsistent[kind], fn);
    eventOnly[kind] = kindStats(tp, fp, fn);
  }

  const allLatencies = [...results.launch, ...results.tug].flatMap(r => r.latencies);
  const latency = {
    launch: summarizeLatency(results.launch.flatMap(r => r.latencies)),
    tug: summarizeLatency(results.tug.flatMap(r => r.latencies)),
    all: summarizeLatency(allLatencies),
  };

  const gates: Gate[] = [];
  for (const kind of ['launch', 'tug'] as const) {
    const s = stats[kind], fpb = falsePositives[kind];
    gates.push({
      id: `Y-S1 ${kind} precision`,
      description: `precision ≥ ${GATE.precision}, over ${kind} clips + non-event clips the PRD rule does not flag as a ${kind}`,
      value: `${pct(s.precision)} (TP ${s.tp}, FP ${s.fp} = ${fpb.eventClips} in ${kind} clips + ${fpb.consistentNonEvent} in consistent non-events)`,
      pass: s.precision >= GATE.precision,
    });
    gates.push({ id: `Y-S1 ${kind} recall`, description: `recall ≥ ${GATE.recall}, over the ${kind} clips' labels`, value: `${pct(s.recall)} (TP ${s.tp}, FN ${s.fn})`, pass: s.recall >= GATE.recall });
  }
  const consistentTriggers = nonEvent.onConsistent.launch + nonEvent.onConsistent.tug;
  gates.push({
    id: 'Y-S1 quiet',
    description: '0 triggers on consistent non-event clips (the PRD rule does not flag them for that kind) and on long clips',
    value: `${consistentTriggers + long.triggers} (consistent non-event ${consistentTriggers}, long ${long.triggers})`,
    pass: consistentTriggers + long.triggers === 0,
  });
  gates.push({
    id: 'Y-S2 latency',
    description: `every matched detection ≤ ${GATE.maxLatencyFrames} frames after onset (50 % of peak speed)`,
    value: `max ${latency.all.frames.max}, p95 ${latency.all.frames.p95}, over ${latency.all.overBound}/${latency.all.frames.count}`,
    pass: latency.all.overBound === 0,
  });

  const failures = [...failuresOf(results.launch, false), ...failuresOf(results.tug, false), ...failuresOf(results.nonEvent, true), ...failuresOf(results.long, true)];
  return { perKind: stats, falsePositives, perKindEventClips: eventOnly, nonEvent, long, latency, gates, failures, results };
}

// ---------------------------------------------------------------------------------------------
// Launch reading comparison (strict vs mean)
// ---------------------------------------------------------------------------------------------

/** What one reading of «sustained» (see LaunchReading) does on a corpus, side by side with the other. */
export interface ReadingSummary {
  reading: LaunchReading;
  launchPrecision: number;
  launchRecall: number;
  latency: LatencySummary;
  /** Launch triggers on casual clips: the ones the PRD rule flags as launches and the ones it does not. */
  launchTriggers: {
    nonEventConsistent: number;
    nonEventAmbiguous: number;
    stressConsistent: number;
    stressAmbiguous: number;
    long: number;
  };
}

export function summarizeReading(reading: LaunchReading, ev: Evaluation, stress: QuietStats): ReadingSummary {
  return {
    reading,
    launchPrecision: ev.perKind.launch.precision,
    launchRecall: ev.perKind.launch.recall,
    latency: ev.latency.launch,
    launchTriggers: {
      nonEventConsistent: ev.nonEvent.onConsistent.launch,
      nonEventAmbiguous: ev.nonEvent.onAmbiguous.launch,
      stressConsistent: stress.onConsistent.launch,
      stressAmbiguous: stress.onAmbiguous.launch,
      long: ev.long.byKind.launch,
    },
  };
}

/** Evaluates the corpus under each reading of «sustained» and summarizes the launch side of both. */
export function compareLaunchReadings(corpus: Corpus, config: YoyoConfig): Record<LaunchReading, { summary: ReadingSummary; evaluation: Evaluation }> {
  const one = (reading: LaunchReading) => {
    const options: EvaluationOptions = { classifier: { launchReading: reading } };
    const evaluation = evaluateCorpus(corpus, config, options);
    return { summary: summarizeReading(reading, evaluation, evaluateCasualSet(corpus.stress, config, options)), evaluation };
  };
  return { strict: one('strict'), mean: one('mean') };
}

// ---------------------------------------------------------------------------------------------
// Robustness across seeds
// ---------------------------------------------------------------------------------------------

/**
 * Seeds the robustness block runs besides the gate seed: fixed, so two runs of the script are
 * comparable. One more than needed, so a gate seed that is itself on the list can be skipped.
 */
export const OTHER_SEEDS: readonly number[] = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111];

/** The gate seed first, then the first nine of OTHER_SEEDS that differ from it: ten seeds. */
export function robustnessSeeds(gateSeed: number): number[] {
  return [gateSeed, ...OTHER_SEEDS.filter(s => s !== gateSeed).slice(0, 9)];
}

/** One seed's Y-S1 and Y-S2 numbers, small enough to tabulate ten of them. */
export interface SeedSummary {
  seed: number;
  /** Precision (over the kind's event clips + consistent non-events, as in the gates) and recall. */
  launch: { precision: number; recall: number };
  tug: { precision: number; recall: number };
  /** Triggers on non-event clips whose clean path the PRD's literal rule does not flag for that kind. */
  consistentTriggers: Record<IntentKind, number>;
  /** Triggers on the long clips (stillness, jitter, sway, glitches). */
  longTriggers: number;
  /** Matched detections, the slowest one and how many are later than the Y-S2 bound. */
  latency: Record<IntentKind | 'all', { matched: number; maxFrames: number; overBound: number }>;
  /** Which gates this seed passes: informational, the gates are judged on the gate seed alone. */
  gates: Record<string, boolean>;
}

export function summarizeSeed(seed: number, ev: Evaluation): SeedSummary {
  const lat = (l: LatencySummary) => ({ matched: l.frames.count, maxFrames: l.frames.max, overBound: l.overBound });
  return {
    seed,
    launch: { precision: ev.perKind.launch.precision, recall: ev.perKind.launch.recall },
    tug: { precision: ev.perKind.tug.precision, recall: ev.perKind.tug.recall },
    consistentTriggers: { launch: ev.nonEvent.onConsistent.launch, tug: ev.nonEvent.onConsistent.tug },
    longTriggers: ev.long.triggers,
    latency: { launch: lat(ev.latency.launch), tug: lat(ev.latency.tug), all: lat(ev.latency.all) },
    gates: Object.fromEntries(ev.gates.map(g => [g.id, g.pass])),
  };
}

export interface Spread {
  min: number;
  mean: number;
  max: number;
}

/** Minimum, mean and maximum of the finite values; NaN across the board when there are none. */
export function spreadOf(values: readonly number[]): Spread {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: NaN, mean: NaN, max: NaN };
  return { min: Math.min(...finite), mean: finite.reduce((a, b) => a + b, 0) / finite.length, max: Math.max(...finite) };
}

/** What the robustness block reports per seed, and in which unit: ratios print as percentages, counts as numbers. */
export const SEED_METRICS = [
  { id: 'launchPrecision', label: 'launch precision', unit: 'ratio', read: (s: SeedSummary) => s.launch.precision },
  { id: 'launchRecall', label: 'launch recall', unit: 'ratio', read: (s: SeedSummary) => s.launch.recall },
  { id: 'tugPrecision', label: 'tug precision', unit: 'ratio', read: (s: SeedSummary) => s.tug.precision },
  { id: 'tugRecall', label: 'tug recall', unit: 'ratio', read: (s: SeedSummary) => s.tug.recall },
  { id: 'consistentLaunchTriggers', label: 'launch triggers on consistent non-events', unit: 'count', read: (s: SeedSummary) => s.consistentTriggers.launch },
  { id: 'consistentTugTriggers', label: 'tug triggers on consistent non-events', unit: 'count', read: (s: SeedSummary) => s.consistentTriggers.tug },
  { id: 'longTriggers', label: 'triggers on long clips', unit: 'count', read: (s: SeedSummary) => s.longTriggers },
  { id: 'latencyMaxFrames', label: 'latency max, frames', unit: 'count', read: (s: SeedSummary) => s.latency.all.maxFrames },
  { id: 'launchLatencyMaxFrames', label: 'launch latency max, frames', unit: 'count', read: (s: SeedSummary) => s.latency.launch.maxFrames },
  { id: 'tugLatencyMaxFrames', label: 'tug latency max, frames', unit: 'count', read: (s: SeedSummary) => s.latency.tug.maxFrames },
  { id: 'overBound', label: 'matched detections over the 2-frame bound', unit: 'count', read: (s: SeedSummary) => s.latency.all.overBound },
  { id: 'launchOverBound', label: 'launch detections over the bound', unit: 'count', read: (s: SeedSummary) => s.latency.launch.overBound },
  { id: 'tugOverBound', label: 'tug detections over the bound', unit: 'count', read: (s: SeedSummary) => s.latency.tug.overBound },
] as const;

export type SeedMetricId = (typeof SEED_METRICS)[number]['id'];

/** The per-seed numbers together with their spread over the seeds. Evidence of robustness, never a gate. */
export interface SeedRobustness {
  seeds: SeedSummary[];
  spread: Record<SeedMetricId, Spread>;
  /** On how many of the seeds each gate passes. */
  gatesPassing: Record<string, number>;
}

export function summarizeSeeds(summaries: readonly SeedSummary[]): SeedRobustness {
  const spread = Object.fromEntries(SEED_METRICS.map(m => [m.id, spreadOf(summaries.map(m.read))])) as Record<SeedMetricId, Spread>;
  const gatesPassing: Record<string, number> = {};
  for (const s of summaries) for (const [id, pass] of Object.entries(s.gates)) gatesPassing[id] = (gatesPassing[id] ?? 0) + (pass ? 1 : 0);
  return { seeds: [...summaries], spread, gatesPassing };
}

// ---------------------------------------------------------------------------------------------
// Stress set, breakdowns, real recordings
// ---------------------------------------------------------------------------------------------

export interface StressBucket {
  /** Peak casual speed range, ih/s. */
  from: number;
  to: number;
  clips: number;
  clipsWithTriggers: number;
  triggers: number;
  /** Clips the PRD's literal rules flag as a tug or launch, and triggers on the clips they do not flag. */
  ambiguousClips: number;
  triggersOnConsistent: number;
}

/** Stress clips bucketed by their fastest casual motion: shows the speed at which triggers begin. */
export function evaluateStress(clips: readonly SyntheticClip[], config: YoyoConfig, edges: readonly number[] = [0.6, 0.8, 1.0, 1.2, Infinity], options: EvaluationOptions = {}): StressBucket[] {
  const buckets: StressBucket[] = [];
  for (let i = 0; i + 1 < edges.length; i++) buckets.push({ from: edges[i], to: edges[i + 1], clips: 0, clipsWithTriggers: 0, triggers: 0, ambiguousClips: 0, triggersOnConsistent: 0 });
  for (const clip of clips) {
    const peak = clip.casualPeak ?? 0;
    const bucket = buckets.find(b => peak >= b.from && peak < b.to);
    if (!bucket) continue;
    const r = evaluateClip(clip, config, options);
    bucket.clips++;
    if (r.detections.length) bucket.clipsWithTriggers++;
    bucket.triggers += r.detections.length;
    if (r.prd && (r.prd.tug || r.prd.launch)) bucket.ambiguousClips++;
    bucket.triggersOnConsistent += r.detections.filter(d => !r.prd?.[d.kind]).length;
  }
  return buckets;
}

/** Recall of a set of clips split by a labelling function: where the misses concentrate. */
export function recallBreakdown(results: readonly ClipResult[], group: (r: ClipResult) => string | undefined): Record<string, { clips: number; recall: number; missed: number }> {
  const acc: Record<string, { hit: number; total: number; clips: number }> = {};
  for (const r of results) {
    const key = group(r);
    if (key === undefined) continue;
    const entry = (acc[key] ??= { hit: 0, total: 0, clips: 0 });
    entry.clips++;
    entry.total += r.clip.labels.length;
    entry.hit += r.match.matched.length;
  }
  const out: Record<string, { clips: number; recall: number; missed: number }> = {};
  for (const [key, e] of Object.entries(acc)) out[key] = { clips: e.clips, recall: e.total ? e.hit / e.total : 1, missed: e.total - e.hit };
  return out;
}

/** Result of running a recorded replay file through the stack. */
export interface ReplayEvaluation {
  detections: Detection[];
  /** Present only when the file carries labels. */
  scored?: { perKind: Record<IntentKind, KindStats>; latency: LatencySummary; match: MatchResult };
}

/**
 * The preset a recording was made with, from the config the recorder stored in it: «seated» if it
 * says so, else «standing» (also when the file carries no config).
 */
export function replayPreset(file: ReplayFile): Preset {
  const preset = (file.config as { preset?: unknown } | null | undefined)?.preset;
  return preset === 'seated' ? 'seated' : 'standing';
}

/** The CURRENT thresholds of the preset the recording was made with: how the classifier does on it today. */
export const replayConfig = (file: ReplayFile): YoyoConfig => createConfig(replayPreset(file));

/**
 * The thresholds the recording was made with: the config stored in the file laid over the current
 * preset, field by field, so a field that did not exist yet when it was recorded keeps its current
 * value. How the classifier of today does with the thresholds of that day, to tell what the code and
 * what the tuning each changed.
 */
export function recordedConfig(file: ReplayFile): YoyoConfig {
  const config = replayConfig(file);
  const overlay = (target: Record<string, unknown>, source: unknown): void => {
    if (typeof source !== 'object' || source === null) return;
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      if (typeof current === 'number' && typeof value === 'number' && Number.isFinite(value)) target[key] = value;
      else if (typeof current === 'object' && current !== null) overlay(current as Record<string, unknown>, value);
    }
  };
  overlay(config as unknown as Record<string, unknown>, file.config);
  return config;
}

/**
 * Runs a recorded replay, with both intents armed unless `options.armed` says otherwise. With
 * hand-added labels it also computes precision, recall and latency, exactly as for synthetic clips.
 */
export function evaluateReplayFile(file: ReplayFile, config: YoyoConfig, options: EvaluationOptions = {}): ReplayEvaluation {
  const frames = replayFrames(file);
  const detections = runFrames(frames, options.armed ?? { launch: true, tug: true }, config, options);
  if (!file.labels?.length) return { detections };

  const labels: GestureLabel[] = file.labels.map(l => ({ kind: l.kind, onsetMs: l.onsetMs, onset10Ms: l.onsetMs, motionStartMs: l.onsetMs, peakSpeed: NaN }));
  const match = matchDetections(labels, detections);
  const times = sampleTimes(frames);
  const latency = summarizeLatency(match.matched.map(m => latencyOf(times, m.detection, m.label)));
  const stats = (kind: IntentKind) => kindStats(
    match.matched.filter(m => m.label.kind === kind).length,
    match.falsePositives.filter(d => d.kind === kind).length,
    match.missed.filter(l => l.kind === kind).length,
  );
  return { detections, scored: { perKind: { launch: stats('launch'), tug: stats('tug') }, latency, match } };
}
