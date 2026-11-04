import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig, type Preset } from '../src/yoyo/config';
import type { IntentKind } from '../src/yoyo/contracts';
import { DEFAULT_LAUNCH_READING, type LaunchReading } from '../src/yoyo/perception/IntentClassifier';
import {
  compareLaunchReadings, evaluateCasualSet, evaluateCorpus, evaluateReplayFile, evaluateStress, GATE, literalLaunchLatencyFrames, recallBreakdown, recordedConfig, replayConfig, replayPreset,
  robustnessSeeds, SEED_METRICS, summarizeSeed, summarizeSeeds,
  type ClipResult, type Evaluation, type QuietStats, type ReplayEvaluation, type ReadingSummary, type SeedRobustness,
} from '../src/yoyo/replay/evaluate';
import { parseReplay } from '../src/yoyo/replay/replayFile';
import { buildCorpus, DEFAULT_SEED, type Corpus, type SyntheticClip } from '../src/yoyo/replay/synthetic';

/**
 * Phase 0 perception report (PRD_YOYO.md Y-S1, Y-S2). Builds the seeded synthetic corpus, runs the
 * perception stack over it, prints a summary and writes artifacts/qa/yoyo/replays.json. If real
 * recordings exist in tests/fixtures/yoyo/*.json they are run too (see `realFixtures`): launch-only
 * and with both intents armed, under the preset the file was recorded with, under the standing preset,
 * and under the thresholds as recorded.
 *
 * Evidence is labelled: everything from the corpus is SYNTHETIC. Real fixtures are WEBCAM, and
 * only count as such when they come from the opt-in recorder on a real camera.
 *
 * Y-S1 is judged on the CONSISTENT casual set: a non-event whose noise-free path already satisfies
 * the PRD's own literal rule is a tug or a launch by definition (see prdOracle). The full casual
 * set is printed and written next to it, labelled as including those motions; nothing is dropped.
 *
 * The gates are judged on the gate seed (the default, or --seed=N) alone. Ten fixed seeds are also
 * run on the standing preset (JSON key `seeds`): evidence of how robust the gate seed's numbers
 * are, reported and never gated on.
 *
 * Exit code 1 whenever a PRD gate fails on the gate seed, or a fixture cannot be read, and the
 * last block of the output says so in plain words. A gap that is known and pinned in the unit
 * suite (KNOWN_GAPS) keeps this script red: the unit suite is green so that Masa's `pnpm test`
 * (which runs src/yoyo too) is, and this script is where the gate shows.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const seedArg = process.argv.find(a => a.startsWith('--seed='));
const seed = seedArg ? Number(seedArg.slice('--seed='.length)) : DEFAULT_SEED;
if (!Number.isInteger(seed)) throw new Error(`Bad --seed: ${seedArg}`);

/** The seated preset's movements are this much smaller than standing ones (config.ts SEATED_FACTOR). */
const SEATED_AMPLITUDE = 0.7;

/**
 * Gates that are known to fail and are pinned in src/yoyo/replay/corpus.test.ts (`it.fails`), by
 * gate id. A failing gate that is not listed here is a NEW failure and says so.
 */
const SEED_METRIC_LABELS = SEED_METRICS.map(({ id, label, unit }) => ({ id, label, unit }));

const KNOWN_GAPS: Record<string, string> = {
  'Y-S2 latency': 'KNOWN GAP (pinned in src/yoyo/replay/corpus.test.ts): the PRD launch rule (two consecutive intervals of 1.2 ih/s or more) has no latency margin even without noise, so interval jitter pushes a few launches to 3-4 frames. Closing it needs a PRD decision on the rule or on the onset, not tuning.',
};

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
const num = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');
const line = (text = '') => console.log(text);
const heading = (text: string) => { line(); line(text); line('-'.repeat(text.length)); };

function printGates(ev: Evaluation) {
  for (const g of ev.gates) line(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id.padEnd(24)} ${g.description.padEnd(48)} ${g.value}`);
}

function printLatency(ev: Evaluation) {
  line('  kind    frames p50/p95/max   ms from onset p50/p95/max   ms from 10 % onset p50   ms to arrival p50   over bound');
  for (const k of ['launch', 'tug', 'all'] as const) {
    const l = ev.latency[k];
    line(`  ${k.padEnd(7)} ${`${num(l.frames.p50, 0)}/${num(l.frames.p95, 0)}/${num(l.frames.max, 0)}`.padEnd(20)} ${`${num(l.msFromOnset.p50, 0)}/${num(l.msFromOnset.p95, 0)}/${num(l.msFromOnset.max, 0)}`.padEnd(27)} ${num(l.msFromOnset10.p50, 0).padEnd(20)} ${num(l.msToArrival.p50, 0).padEnd(19)} ${l.overBound}/${l.frames.count}`);
  }
}

/** False triggers of the non-event set, attributed to the casual part the hand was performing. */
function triggersByPart(corpus: Corpus, ev: Evaluation) {
  const byId = new Map<string, SyntheticClip>(corpus.nonEvent.map(c => [c.id, c]));
  const table: Record<string, { parts: number; triggers: number }> = {};
  for (const clip of corpus.nonEvent) for (const s of clip.segments ?? []) (table[s.tag] ??= { parts: 0, triggers: 0 }).parts++;
  for (const r of ev.results.nonEvent) {
    const clip = byId.get(r.clip.id)!;
    for (const d of r.detections) {
      const seg = clip.segments?.find(s => d.timestampMs >= s.startMs - 50 && d.timestampMs <= s.endMs + 400);
      (table[seg?.tag ?? 'other'] ??= { parts: 0, triggers: 0 }).triggers++;
    }
  }
  return table;
}

/**
 * Share of casual parts that draw a trigger, by kind of part and peak speed: the decision
 * boundary in the corpus. A part «draws» a trigger if one lands inside it or within 150 ms after.
 */
function triggerRateByPeak(corpus: Corpus, ev: Evaluation) {
  const byId = new Map<string, SyntheticClip>(corpus.nonEvent.map(c => [c.id, c]));
  const table: Record<string, { parts: number; hit: number }> = {};
  for (const r of ev.results.nonEvent) {
    const clip = byId.get(r.clip.id)!;
    for (const seg of clip.segments ?? []) {
      if (seg.peak === undefined) continue;
      const lo = Math.floor(seg.peak * 5) / 5;
      const entry = (table[`${seg.tag} ${lo.toFixed(1)}–${(lo + 0.2).toFixed(1)} ih/s`] ??= { parts: 0, hit: 0 });
      entry.parts++;
      if (r.detections.some(d => d.timestampMs >= seg.startMs - 30 && d.timestampMs <= seg.endMs + 150)) entry.hit++;
    }
  }
  return table;
}

function printFailures(ev: Evaluation, limit = 6) {
  for (const problem of ['false-positive', 'missed', 'late'] as const) {
    const cases = ev.failures.filter(f => f.problem === problem);
    if (!cases.length) continue;
    const ambiguous = cases.filter(f => f.prdAmbiguous === true).length;
    line(`  ${problem}: ${cases.length}${problem === 'false-positive' ? ` (${cases.length - ambiguous} count against the gates, ${ambiguous} on clips the PRD rule flags: tugs by definition)` : ''}`);
    // Cases that count come first.
    const ordered = [...cases.filter(f => f.prdAmbiguous !== true), ...cases.filter(f => f.prdAmbiguous === true)];
    for (const f of ordered.slice(0, limit)) line(`    ${f.clipId}  ${f.detail}  [${f.tags.filter(t => !t.startsWith('glitchAt')).join(' ')}]${f.prdAmbiguous ? '  (PRD-ambiguous)' : ''}`);
    if (cases.length > limit) line(`    … ${cases.length - limit} more in the JSON`);
  }
}

function printCasual(label: string, q: QuietStats, minutes?: number) {
  const rate = minutes ? `, ${(q.triggers / minutes).toFixed(2)} per minute of casual motion` : '';
  line(`  ${label}: ${q.triggers} triggers in ${q.clipsWithTriggers}/${q.clips} clips${rate}  (launch ${q.byKind.launch}, tug ${q.byKind.tug})`);
  for (const kind of ['launch', 'tug'] as const) {
    line(`    ${kind.padEnd(6)} PRD-ambiguous clips ${String(q.ambiguousClips[kind]).padStart(3)}/${q.clips}   triggers on ambiguous ${String(q.onAmbiguous[kind]).padStart(3)}   triggers on consistent ${String(q.onConsistent[kind]).padStart(3)}`);
  }
}

function printReadings(strict: ReadingSummary, mean: ReadingSummary) {
  const row = (name: string, a: string, b: string) => line(`  ${name.padEnd(46)} ${a.padEnd(18)} ${b}`);
  row('', 'strict (literal)', 'mean (noise-robust)');
  row('launch precision', pct(strict.launchPrecision), pct(mean.launchPrecision));
  row('launch recall', pct(strict.launchRecall), pct(mean.launchRecall));
  const frames = (s: ReadingSummary) => `${num(s.latency.frames.p50, 0)}/${num(s.latency.frames.p95, 0)}/${num(s.latency.frames.max, 0)}`;
  row('latency frames p50/p95/max', frames(strict), frames(mean));
  row('ms from onset p50/p95/max', `${num(strict.latency.msFromOnset.p50, 0)}/${num(strict.latency.msFromOnset.p95, 0)}/${num(strict.latency.msFromOnset.max, 0)}`, `${num(mean.latency.msFromOnset.p50, 0)}/${num(mean.latency.msFromOnset.p95, 0)}/${num(mean.latency.msFromOnset.max, 0)}`);
  row('matched detections over 2 frames', `${strict.latency.overBound}/${strict.latency.frames.count}`, `${mean.latency.overBound}/${mean.latency.frames.count}`);
  row('launch triggers, consistent non-events', String(strict.launchTriggers.nonEventConsistent), String(mean.launchTriggers.nonEventConsistent));
  row('launch triggers, PRD-ambiguous non-events', String(strict.launchTriggers.nonEventAmbiguous), String(mean.launchTriggers.nonEventAmbiguous));
  row('launch triggers, stress set (consistent)', String(strict.launchTriggers.stressConsistent), String(mean.launchTriggers.stressConsistent));
  row('launch triggers, long clips', String(strict.launchTriggers.long), String(mean.launchTriggers.long));
}

/** Rows of the multi-seed table: one per seed, then the minimum, mean and maximum of each column. */
function printSeeds(r: SeedRobustness, gateSeed: number) {
  const count = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const widths = [16, 16, 12, 5, 18, 10];
  const row = (label: string, cells: string[]) => line(`  ${label.padEnd(20)} ${cells.map((c, i) => c.padEnd(widths[i])).join('  ')}`);
  row('seed', ['launch P / R', 'tug P / R', 'consist. L/T', 'long', 'latency max (L, T)', 'over bound']);
  for (const s of r.seeds) {
    row(`${s.seed}${s.seed === gateSeed ? ' (gate seed)' : ''}`, [
      `${num(s.launch.precision * 100)} / ${num(s.launch.recall * 100)} %`,
      `${num(s.tug.precision * 100)} / ${num(s.tug.recall * 100)} %`,
      `${s.consistentTriggers.launch} / ${s.consistentTriggers.tug}`,
      String(s.longTriggers),
      `${num(s.latency.all.maxFrames, 0)} (${num(s.latency.launch.maxFrames, 0)}, ${num(s.latency.tug.maxFrames, 0)})`,
      `${s.latency.all.overBound}/${s.latency.all.matched}`,
    ]);
  }
  for (const pick of ['min', 'mean', 'max'] as const) {
    const at = (id: keyof SeedRobustness['spread']) => r.spread[id][pick];
    row(pick, [
      `${num(at('launchPrecision') * 100)} / ${num(at('launchRecall') * 100)} %`,
      `${num(at('tugPrecision') * 100)} / ${num(at('tugRecall') * 100)} %`,
      `${count(at('consistentLaunchTriggers'))} / ${count(at('consistentTugTriggers'))}`,
      count(at('longTriggers')),
      `${count(at('latencyMaxFrames'))} (${count(at('launchLatencyMaxFrames'))}, ${count(at('tugLatencyMaxFrames'))})`,
      count(at('overBound')),
    ]);
  }
  const n = r.seeds.length;
  line(`  gates that pass, of ${n} seeds: ${Object.entries(r.gatesPassing).map(([id, passing]) => `${id} ${passing}`).join(', ')}`);
}

const peakBucket = (r: ClipResult) => {
  const p = r.clip.labels[0]?.peakSpeed;
  return p === undefined ? undefined : `${(Math.floor(p * 5) / 5).toFixed(1)}-${(Math.floor(p * 5) / 5 + 0.2).toFixed(1)} ih/s`;
};

/** One way of running a real recording: which thresholds, which intents armed. */
interface FixtureRun {
  config: 'file-preset' | 'standing' | 'recorded';
  /** What the thresholds are, for the printout. */
  label: string;
  armed: 'launch-only' | 'both armed';
  result: ReplayEvaluation;
}

/**
 * Real recordings (WEBCAM evidence), each run launch-only and with both intents armed (the app never
 * arms both at once, so launch-only is the number that says whether throws register; both armed shows
 * what a wind-up looks like to the tug classifier) under
 *
 * - the preset the file was recorded with, at today's thresholds (the file's own «seated» config),
 * - the standing preset, which is what the synthetic gates are judged with,
 * - the thresholds the file was recorded with, on today's code (only when they differ from the
 *   first): how much of the gain is the tuning and how much the code.
 */
function realFixtures() {
  const dir = join(root, 'tests', 'fixtures', 'yoyo');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(name => {
    const path = join(dir, name);
    try {
      const file = parseReplay(readFileSync(path, 'utf8'));
      const preset = replayPreset(file);
      const configs: Array<Pick<FixtureRun, 'config' | 'label'> & { value: ReturnType<typeof createConfig> }> = [
        { config: 'file-preset', label: `${preset} preset (the file's own), today's thresholds`, value: replayConfig(file) },
        ...(preset === 'standing' ? [] : [{ config: 'standing' as const, label: 'standing preset, today\'s thresholds', value: createConfig('standing') }]),
      ];
      const recorded = recordedConfig(file);
      if (JSON.stringify(recorded) !== JSON.stringify(configs[0].value)) configs.push({ config: 'recorded', label: `${preset} thresholds as recorded, today's code`, value: recorded });
      const runs: FixtureRun[] = configs.flatMap(c => ([['launch-only', { launch: true, tug: false }], ['both armed', { launch: true, tug: true }]] as const)
        .map(([armed, intents]) => ({ config: c.config, label: c.label, armed, result: evaluateReplayFile(file, c.value, { armed: intents }) })));
      return { name, frames: file.frames.length, note: file.note, labelled: Boolean(file.labels?.length), runs, error: undefined as string | undefined };
    } catch (error) {
      return { name, frames: 0, note: undefined, labelled: false, runs: [] as FixtureRun[], error: String(error instanceof Error ? error.message : error) };
    }
  });
}

const started = Date.now();
const corpus = buildCorpus(seed);
const built = Date.now();
const standing = evaluateCorpus(corpus, createConfig('standing'));
const beforeExit = evaluateCorpus(corpus, createConfig('standing'), { launchOnExit: false });
const readings = compareLaunchReadings(corpus, createConfig('standing'));
const stressSet = evaluateCasualSet(corpus.stress, createConfig('standing'));
const casualMinutes = corpus.nonEvent.reduce((sum, c) => sum + c.durationMs, 0) / 60_000;
const seatedCorpus = buildCorpus(seed, SEATED_AMPLITUDE);
const seated = evaluateCorpus(seatedCorpus, createConfig('seated' satisfies Preset));
const stress = evaluateStress(corpus.stress, createConfig('standing'));
const evaluated = Date.now();
// The gate seed's evaluation is reused; the other nine seeds are built and scored one at a time.
const seedList = robustnessSeeds(seed);
const robustness = summarizeSeeds(seedList.map(s => (s === seed ? summarizeSeed(s, standing) : summarizeSeed(s, evaluateCorpus(buildCorpus(s), createConfig('standing'))))));
const seedsDone = Date.now();
const framesTotal = [...corpus.launch, ...corpus.tug, ...corpus.nonEvent, ...corpus.long, ...corpus.stress].reduce((n, c) => n + c.frames.length, 0);

line(`Yoyó phase 0: perception on SYNTHETIC replays (seed ${seed}; PRD §8.2 noise; no webcam, no human)`);
line(`corpus: ${corpus.launch.length} launch, ${corpus.tug.length} tug, ${corpus.nonEvent.length} non-event, ${corpus.long.length} long, ${corpus.stress.length} stress clips, ${framesTotal} frames; built in ${built - started} ms, evaluated in ${evaluated - built} ms, ${seedList.length} seeds in ${seedsDone - evaluated} ms`);

heading('Gates, standing preset (Y-S1, Y-S2)');
printGates(standing);

heading('Detection latency, matched detections (frames of delivered samples after the first one at or past the onset)');
printLatency(standing);

heading('Where the Y-S2 gap comes from: the PRD launch rule itself, on the NOISE-FREE path (the best a classifier that implements it as written can do)');
const literalFrames = corpus.launch.map(c => literalLaunchLatencyFrames(c, createConfig('standing')));
const literalHistogram: Record<string, number> = {};
for (const f of literalFrames) {
  const key = f === null ? 'never fires' : f >= GATE.maxLatencyFrames + 1 ? `${GATE.maxLatencyFrames + 1} or more` : `${f} frame${f === 1 ? '' : 's'}`;
  literalHistogram[key] = (literalHistogram[key] ?? 0) + 1;
}
line(`  frames after the annotated onset at which the literal rule first fires, over ${corpus.launch.length} launch clips: ${Object.entries(literalHistogram).sort().map(([k, v]) => `${k}: ${v}`).join(', ')}`);
line(`  so ${literalHistogram[`${GATE.maxLatencyFrames} frames`] ?? 0} clips sit exactly on the ${GATE.maxLatencyFrames}-frame bound before any noise; with the PRD §8.2 noise ${standing.latency.launch.overBound} of ${standing.latency.launch.frames.count} matched launches come later (max ${num(standing.latency.launch.frames.max, 0)} frames).`);

heading('FULL casual set (all non-event clips): includes motions that are tugs by the PRD definition');
printCasual('non-event clips', standing.nonEvent, casualMinutes);
line('  The PRD-ambiguous clips (noise-free path satisfies the PRD rule) are tugs by definition: a trigger there is not an error.');
line('  The gate counts only the consistent ones. Long clips are always counted: they are plain stillness and sway.');
printCasual('long clips', standing.long);
printCasual('stress set (informational)', stressSet);

heading('Launch on exit: absent() completes a throw that carried the hand out through the bottom');
const exitOf = (ev: Evaluation) => recallBreakdown(ev.results.launch, r => (r.clip.tags.includes('exit') ? 'exit' : 'other'));
const exitBefore = exitOf(beforeExit), exitAfter = exitOf(standing);
line(`  launch recall on exit clips: ${pct(exitBefore.exit.recall)} before (${exitBefore.exit.missed} missed of ${exitBefore.exit.clips}) -> ${pct(exitAfter.exit.recall)} after (${exitAfter.exit.missed} missed)`);
line(`  launch recall overall: ${pct(beforeExit.perKind.launch.recall)} -> ${pct(standing.perKind.launch.recall)}; other clips ${pct(exitBefore.other.recall)} -> ${pct(exitAfter.other.recall)}`);
line(`  new false launches: event clips ${beforeExit.falsePositives.launch.eventClips} -> ${standing.falsePositives.launch.eventClips}; non-event ${beforeExit.nonEvent.byKind.launch} -> ${standing.nonEvent.byKind.launch}; long ${beforeExit.long.byKind.launch} -> ${standing.long.byKind.launch}`);

heading('Launch reading of «≥ minDownSpeed sustained over sustainFrames»: strict versus mean, same corpus');
printReadings(readings.strict.summary, readings.mean.summary);
const meanQualifies = readings.mean.summary.launchTriggers.nonEventConsistent === 0 && readings.mean.summary.launchTriggers.long === 0 && readings.mean.summary.latency.frames.max <= GATE.maxLatencyFrames;
line(`  adoption rule: 0 launch triggers on consistent non-events and long clips AND max latency ≤ ${GATE.maxLatencyFrames} frames -> mean ${meanQualifies ? 'qualifies' : `does not qualify (max ${num(readings.mean.summary.latency.frames.max, 0)} frames)`}; default stays ${DEFAULT_LAUNCH_READING satisfies LaunchReading}`);

heading('Y-S1 by clip type: recall');
const launchByType = recallBreakdown(standing.results.launch, r => `${r.clip.tags.includes('windup') ? 'wind-up' : 'still'}${r.clip.tags.includes('exit') ? ' + exits through the bottom' : ''}`);
const tugByType = recallBreakdown(standing.results.tug, r => (r.clip.tags.includes('sway') ? 'swaying' : 'still'));
for (const [name, v] of Object.entries(launchByType).sort()) line(`  launch ${name.padEnd(34)} ${pct(v.recall)} of ${v.clips} clips (${v.missed} missed)`);
for (const [name, v] of Object.entries(tugByType).sort()) line(`  tug    ${name.padEnd(34)} ${pct(v.recall)} of ${v.clips} clips (${v.missed} missed)`);
for (const kind of ['launch', 'tug'] as const) {
  const split = recallBreakdown(standing.results[kind], peakBucket);
  line(`  ${kind} by peak speed: ` + Object.entries(split).sort().map(([k, v]) => `${k} ${pct(v.recall)}`).join(', '));
}

heading('Non-event triggers by what the hand was doing (full casual set)');
const byPart = triggersByPart(corpus, standing);
line(`  non-event clips with a trigger: ${standing.nonEvent.clipsWithTriggers}/${standing.nonEvent.clips}  (launch ${standing.nonEvent.byKind.launch}, tug ${standing.nonEvent.byKind.tug});  long clips: ${standing.long.triggers} triggers over ${standing.long.clips} clips`);
for (const [part, v] of Object.entries(byPart).sort()) line(`  ${part.padEnd(10)} ${String(v.triggers).padStart(3)} triggers in ${v.parts} parts`);

const rateByPeak = triggerRateByPeak(corpus, standing);
line();
line('  share of casual parts that draw a trigger, by peak speed:');
for (const [part, v] of Object.entries(rateByPeak).sort()) line(`    ${part.padEnd(22)} ${String(v.hit).padStart(3)}/${String(v.parts).padEnd(3)} ${pct(v.hit / v.parts)}`);

heading('Stress set (casual motions up to 1.2 ih/s): where the boundary lies. Informational, no gate.');
for (const b of stress) line(`  fastest casual motion ${b.from.toFixed(1)}–${Number.isFinite(b.to) ? b.to.toFixed(1) : '∞'} ih/s: ${b.clipsWithTriggers}/${b.clips} clips trigger (${b.triggers} triggers)`);

heading('Failing cases (rebuild with buildClip(kind, seed, index))');
printFailures(standing);

heading(`Robustness: ${robustness.seeds.length} fixed seeds, standing preset, SYNTHETIC (P = precision, R = recall, L = launch, T = tug; consist. = triggers on consistent non-events). Evidence, not a gate.`);
printSeeds(robustness, seed);
line('  The gates above are judged on the gate seed alone; this block says how far its numbers can be trusted on fresh draws of the same corpus.');

heading('Seated preset on a seated-amplitude corpus (movements ×0.7; launch thresholds and gain ×0.7, the tug rise NOT scaled: ×0.7 is under the jitter floor). Informational, no gate.');
printGates(seated);

heading('Real fixtures (WEBCAM evidence): tests/fixtures/yoyo/*.json');
const fixtures = realFixtures();
if (!fixtures.length) line('  no real fixtures yet');
for (const f of fixtures) {
  if (f.error) { line(`  ${f.name}: UNREADABLE: ${f.error}`); continue; }
  line(`  ${f.name}: ${f.frames} frames${f.note ? ` ("${f.note}")` : ''}`);
  line('  The thresholds were tuned on this very recording (see docs/yoyo/DECISIONS.md): a regression check of that tuning, not an independent measurement.');
  for (const r of f.runs) {
    const kinds = (k: IntentKind) => r.result.detections.filter(d => d.kind === k).length;
    line(`    [${r.label}] ${r.armed}: ${kinds('launch')} launch, ${kinds('tug')} tug detections`);
    const scored = r.result.scored;
    if (scored) {
      for (const k of ['launch', 'tug'] as const) {
        const s = scored.perKind[k];
        line(`      ${k}: TP ${s.tp} FP ${s.fp} FN ${s.fn}  precision ${pct(s.precision)}  recall ${pct(s.recall)}${k === 'tug' && r.armed === 'both armed' && s.fp ? '  (a wind-up is a yank up to the tug classifier: expected, not fought)' : ''}`);
      }
      line(`      latency frames p50/p95/max ${num(scored.latency.frames.p50, 0)}/${num(scored.latency.frames.p95, 0)}/${num(scored.latency.frames.max, 0)}; ms from labelled onset p50/p95/max ${num(scored.latency.msFromOnset.p50, 0)}/${num(scored.latency.msFromOnset.p95, 0)}/${num(scored.latency.msFromOnset.max, 0)}`);
      if (r.armed === 'launch-only' && scored.match.missed.length) line(`      missed onsets (ms): ${scored.match.missed.map(m => m.onsetMs.toFixed(0)).join(', ')}`);
    } else {
      line('      no labels in the file: detections only, no precision/recall');
    }
  }
}

// The verdict, in plain words: printed last and written to the JSON, so nobody has to read the tables to learn the gates are red.
const failedGates = standing.gates.filter(g => !g.pass);
const unreadable = fixtures.filter(f => f.error);
const newFailures = failedGates.filter(g => !(g.id in KNOWN_GAPS));
const resultLines: string[] = [];
if (!failedGates.length && !unreadable.length) {
  resultLines.push(`RESULT: all PRD gates pass on the gate seed (${seed}). Synthetic evidence only: no webcam, no human.`);
} else {
  resultLines.push(`RESULT: NOT ALL PRD GATES PASS. ${failedGates.length} of ${standing.gates.length} gates fail on the gate seed (${seed}), so this script exits with code 1.`);
  for (const g of standing.gates) resultLines.push(`  ${g.pass ? 'pass' : 'FAIL'}  ${g.id}: ${g.value}`);
  for (const g of failedGates) resultLines.push(`  ${g.id}: ${KNOWN_GAPS[g.id] ?? 'NEW FAILURE, not a documented gap: see the tables above.'}`);
  if (unreadable.length) resultLines.push(`  Unreadable fixtures: ${unreadable.map(f => f.name).join(', ')}`);
  resultLines.push(newFailures.length || unreadable.length
    ? '  The unit suite (pnpm test:yoyo, which pnpm test also runs) fails on every gate that is not a known gap.'
    : '  The unit suite (pnpm test:yoyo, which pnpm test also runs) is green on purpose: it pins the known gap as `it.fails` and bounds the near miss, so Masa\'s suite stays green. The gate stays red here until the gap is closed.');
}
const seedsFailing = Object.entries(robustness.gatesPassing).filter(([, passing]) => passing < robustness.seeds.length);
resultLines.push(`  Across ${robustness.seeds.length} seeds (evidence, not a gate): ${seedsFailing.length ? seedsFailing.map(([id, passing]) => `${id} passes on ${passing}/${robustness.seeds.length}`).join('; ') : 'every gate passes on every seed'}.`);

const outDir = join(root, 'artifacts', 'qa', 'yoyo');
mkdirSync(outDir, { recursive: true });
const summarize = (ev: Evaluation) => ({
  perKind: ev.perKind, falsePositives: ev.falsePositives, perKindEventClipsOnly: ev.perKindEventClips,
  nonEvent: ev.nonEvent, long: ev.long, latency: ev.latency, gates: ev.gates,
  failures: ev.failures.slice(0, 300), failureCount: ev.failures.length,
});
writeFileSync(join(outDir, 'replays.json'), JSON.stringify({
  evidence: 'synthetic',
  generatedBy: 'pnpm test:yoyo:replays',
  seed,
  corpus: { launch: corpus.launch.length, tug: corpus.tug.length, nonEvent: corpus.nonEvent.length, long: corpus.long.length, stress: corpus.stress.length, frames: framesTotal },
  precisionDefinition: 'precision per kind = TP / (TP + FP); FP counts the kind\'s false positives in its own event clips plus its triggers on non-event clips the PRD literal rule does not flag for that kind (consistent non-events). Long clips are gated separately (0 triggers).',
  result: {
    allPrdGatesPass: failedGates.length === 0 && unreadable.length === 0,
    exitCode: failedGates.length || unreadable.length ? 1 : 0,
    failedGates: failedGates.map(g => ({ id: g.id, value: g.value, knownGap: g.id in KNOWN_GAPS })),
    summary: resultLines,
  },
  standing: summarize(standing),
  literalLaunchRule: {
    note: 'frames after the annotated onset at which the PRD launch rule, as written, first fires on the NOISE-FREE path of each launch clip: the best any classifier can do',
    histogram: literalHistogram,
  },
  seeds: {
    note: `${robustness.seeds.length} fixed seeds on the standing preset; evidence of robustness, NOT a gate (the gates are judged on the gate seed alone)`,
    gateSeed: seed,
    list: seedList,
    metrics: SEED_METRIC_LABELS,
    perSeed: robustness.seeds,
    spread: robustness.spread,
    gatesPassing: robustness.gatesPassing,
  },
  fullCasualSet: {
    label: 'full casual set, includes motions that are tugs by the PRD definition',
    minutes: casualMinutes,
    triggersPerMinute: standing.nonEvent.triggers / casualMinutes,
    ...standing.nonEvent,
  },
  stressSet: { label: 'informational', ...stressSet },
  launchOnExit: {
    before: { exitClips: exitBefore.exit, otherClips: exitBefore.other, launchRecall: beforeExit.perKind.launch.recall, nonEventLaunchTriggers: beforeExit.nonEvent.byKind.launch, longLaunchTriggers: beforeExit.long.byKind.launch },
    after: { exitClips: exitAfter.exit, otherClips: exitAfter.other, launchRecall: standing.perKind.launch.recall, nonEventLaunchTriggers: standing.nonEvent.byKind.launch, longLaunchTriggers: standing.long.byKind.launch },
  },
  launchReadings: { default: DEFAULT_LAUNCH_READING, meanQualifies, strict: readings.strict.summary, mean: readings.mean.summary },
  recall: { launchByType, tugByType },
  triggersByPart: byPart,
  triggerRateByPeak: rateByPeak,
  stress,
  seated: { note: 'seated preset (launch thresholds and gain x0.7, tug rise not scaled: x0.7 is under the jitter floor) on a corpus with movements scaled by 0.7, same noise; informational', amplitude: SEATED_AMPLITUDE, ...summarize(seated) },
  realFixtures: fixtures.map(f => ({
    name: f.name, evidence: 'webcam', note: 'thresholds tuned on this recording: regression of the tuning, not an independent measurement', frames: f.frames, labelled: f.labelled, error: f.error,
    runs: f.runs.map(r => ({
      config: r.config, label: r.label, armed: r.armed, detections: r.result.detections,
      scored: r.result.scored && { perKind: r.result.scored.perKind, latency: r.result.scored.latency, missedOnsetsMs: r.result.scored.match.missed.map(m => m.onsetMs), falsePositives: r.result.scored.match.falsePositives },
    })),
  })),
}, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value), 2));
line();
line(`wrote ${join('artifacts', 'qa', 'yoyo', basename('replays.json'))}`);

heading('Result');
for (const text of resultLines) line(text);
if (failedGates.length || unreadable.length) process.exitCode = 1;
