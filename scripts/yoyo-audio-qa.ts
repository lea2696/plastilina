/**
 * Yoyó audio QA (PRD_YOYO.md §1.3, §6). SYNTHETIC evidence: the real director and graph rendered
 * offline (OfflineAudioContext, 44.1 kHz mono) in headless Chrome through a Vite dev server, then
 * measured. It proves what can be measured: silence when it must be silent, no clipping, the hum's
 * pitch and level following spin, every sound present where its event is, smooth steering, and the
 * level balance between voices.
 *
 * What it cannot say, and is left to a human with real speakers: whether it sounds good, whether
 * the loudness is right on a laptop, whether the hum feels like it follows the yoyo. WAV files of
 * the scripted sequence, the decaying sleeper and every voice are written next to the report so a
 * person can listen.
 *
 * A short real-time smoke then runs the real YoyoAudio on a real AudioContext (after a real click):
 * silent and context-free before unlock, running after it, sound flowing, mute immediate, suspend,
 * resume and close, with the output read from a tap before the destination.
 *
 * Writes artifacts/qa/yoyo/audio-qa.json and artifacts/qa/yoyo/audio/*.wav; exits 1 on any failed check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';
import {
  buildOneShot, HUM_GAIN_MAX, HUM_SPIN_SILENT, humFrequencyHz, humGain, launchIntensity, MAX_ONE_SHOT_VOICES, ZIP_MAX_S,
} from '../src/yoyo/audio/AudioDirector';
import type { LiveSmokeResult } from '../src/yoyo/audio/liveHarness';
import type {
  ChainGainResult, ConvergenceResult, ScenarioInput, ScenarioResult, ScriptKeyframe, VoiceResult,
} from '../src/yoyo/audio/offlineHarness';
import { ONE_SHOT_KINDS, type OneShotKind } from '../src/yoyo/audio/types';
import { DEFAULT_VOLUME, LIMITER, MASTER_FULL_SCALE } from '../src/yoyo/audio/YoyoAudioGraph';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(root, 'artifacts', 'qa', 'yoyo');
const wavDir = join(outDir, 'audio');

// ---------------------------------------------------------------------------------------------
// Gates: numbers a failure would cross on purpose, not on rounding
// ---------------------------------------------------------------------------------------------

/** Peaks must stay under this: 0.98 leaves a hair under full scale. */
const CLIP_CEILING = 0.98;
/** A render that is supposed to be silent must be exactly that, give or take float dust. */
const SILENCE_EPS = 1e-9;
/** The hum's measured pitch must match the director's mapping within this share. */
const PITCH_TOLERANCE = 0.02;
/** A solo voice's peak may sit this far (linear) from its nominal gain: roughly ±3 dB. */
const GAIN_BAND: readonly [number, number] = [0.7, 1.45];
/** No solo voice peaks above this before the master chain. */
const VOICE_PEAK_CEILING = 0.6;
/**
 * The same hum ramp steered at 30 Hz (what the director sends) and at 240 Hz (near-continuous) must
 * sound the same. Loudness: the mean gap between the two 20 ms envelopes stays under
 * CONVERGENCE_MEAN_DB (stepping the controls would open a gap everywhere), the worst bin under
 * CONVERGENCE_MAX_DB (looser: the noise texture's own variance moves single bins by about a dB).
 * Pitch: within CONVERGENCE_HZ at every quarter second (a 16 ms steering lag on an 80 Hz/s ramp is 1.3 Hz).
 */
const CONVERGENCE_MEAN_DB = 0.4;
const CONVERGENCE_MAX_DB = 2;
const CONVERGENCE_HZ = 1.5;
/** The hum has to be this far down (dB) 0.3 s and 0.8 s after it is told to stop. */
const FADE_DB: readonly [number, number] = [-20, -40];
/** A sound has to start within this long of its event: one frame (17 ms) plus the voice's own attack. */
const ONSET_LIMIT_S = 0.04;
/** Mute must silence the live output within this long, ms. The tap itself holds ~43 ms of audio. */
const LIVE_MUTE_LIMIT_MS = 150;

// ---------------------------------------------------------------------------------------------
// Checks and formatting
// ---------------------------------------------------------------------------------------------

interface Check {
  id: string;
  description: string;
  pass: boolean;
  value: string;
}
const checks: Check[] = [];
const check = (id: string, description: string, pass: boolean, value: string) => {
  checks.push({ id, description, pass, value });
};

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY);
const fmt = (x: number, digits = 3) => (Number.isFinite(x) ? x.toFixed(digits) : String(x));
const dbfs = (x: number) => `${fmt(db(x), 1)} dBFS`;
/** Exact silence reads as -Infinity dB; say so in words (JSON would turn Infinity into null). */
const fmtDb = (x: number, digits = 1) => (x === Number.NEGATIVE_INFINITY ? 'silent' : `${x.toFixed(digits)} dB`);
const dbFloor = (x: number) => Math.max(-200, x);
const monotonic = (values: number[]) => values.every((v, i) => i === 0 || v > values[i - 1]);
const hz = (x: number) => `${Math.round(x)} Hz`;

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

async function inPage<T>(page: Page, call: string): Promise<T> {
  const code = `(async () => { const h = await import('/src/yoyo/audio/offlineHarness.ts'); return await ${call}; })()`;
  return (await page.evaluate(code)) as T;
}

const renderScenario = (page: Page, input: ScenarioInput) =>
  inPage<ScenarioResult>(page, `h.renderScenario(${JSON.stringify(input)})`);

function saveWav(name: string, base64: string | undefined) {
  if (base64 === undefined) return;
  mkdirSync(wavDir, { recursive: true });
  writeFileSync(join(wavDir, name), Buffer.from(base64, 'base64'));
}

/** RMS of a result's envelope between two times, s. */
function rmsBetween(result: ScenarioResult, fromS: number, toS: number): number {
  const bin = result.envelopeMs / 1000;
  const first = Math.max(0, Math.floor(fromS / bin));
  const last = Math.min(result.envelope.length, Math.ceil(toS / bin));
  let energy = 0;
  for (let i = first; i < last; i += 1) energy += result.envelope[i] * result.envelope[i];
  return last > first ? Math.sqrt(energy / (last - first)) : 0;
}

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------

/** A whole throw, as the model would report it: tie on, launch, spin-up, snap, sleeper, tug, catch, tie on again. */
const THROW: readonly ScriptKeyframe[] = [
  { atMs: 0, phase: 'tethered', spin: 0 },
  { atMs: 200, phase: 'tethered', spin: 0, events: [{ kind: 'tether' }] },
  { atMs: 900, phase: 'rolling', spin: 300, events: [{ kind: 'launch', strength: 2.4 }] },
  { atMs: 1300, phase: 'rolling', spin: 500 },
  { atMs: 1700, phase: 'rolling', spin: 700 },
  { atMs: 2100, phase: 'sleeping', spin: 700, events: [{ kind: 'snap', strength: 1.9 }] },
  { atMs: 3100, phase: 'sleeping', spin: 520 },
  { atMs: 4100, phase: 'sleeping', spin: 380 },
  { atMs: 4300, phase: 'returning', spin: 520, events: [{ kind: 'tug', strength: 1.6 }] },
  { atMs: 4750, phase: 'caught', spin: 380, events: [{ kind: 'catch', strength: 1.4 }] },
  { atMs: 4950, phase: 'tethered', spin: 0, events: [{ kind: 'retether' }] },
  { atMs: 5600, phase: 'tethered', spin: 0 },
];
const THROW_S = 6;

const withoutEvents = (keys: readonly ScriptKeyframe[]): ScriptKeyframe[] =>
  keys.map((key) => {
    const copy = { ...key };
    delete copy.events;
    return copy;
  });

/**
 * Same timeline and same reported spin (the zip is sized from it), but in a phase that never hums,
 * so what is left of the render is the one-shots alone.
 */
const withoutHum = (keys: readonly ScriptKeyframe[]): ScriptKeyframe[] =>
  keys.map((key) => ({ ...key, phase: 'tethered' }));

/** The sleeper as the model decays it: 750 rad/s, τ = 4 s, until it is spent. */
function sleeperKeys(): ScriptKeyframe[] {
  const keys: ScriptKeyframe[] = [{ atMs: 0, phase: 'sleeping', spin: 750 }];
  for (let t = 0.5; t <= 14; t += 0.5) {
    keys.push({ atMs: t * 1000, phase: t < 13.5 ? 'sleeping' : 'exhausted', spin: 750 * Math.exp(-t / 4) });
  }
  return keys;
}

/** A sleeper at a constant spin, long enough for the hum to settle before it is measured. */
const steady = (name: string, spin: number, extra: Partial<ScenarioInput> = {}): ScenarioInput => ({
  name, durationS: 2, keyframes: [{ atMs: 0, phase: 'sleeping', spin }], envelopeMs: 20, ...extra,
});

/** Events of a hostile hour: every kind, every 100 ms, the yoyo spun up to its ceiling. */
function stormKeys(): ScriptKeyframe[] {
  const keys: ScriptKeyframe[] = [];
  for (let t = 200; t <= 3000; t += 100) {
    keys.push({
      atMs: t,
      phase: 'returning',
      spin: 1000,
      events: [
        { kind: 'launch', strength: 5 }, { kind: 'snap', strength: 3 }, { kind: 'tug', strength: 3 },
        { kind: 'catch', strength: 3 }, { kind: 'tether' }, { kind: 'retether' },
      ],
    });
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Sections. Each renders what it needs, records its checks and returns what the report keeps.
// ---------------------------------------------------------------------------------------------

/** (a) and (c): idle, muted, never unlocked, paused and the phases that must not hum are exactly silent. */
async function silenceGates(page: Page) {
  const idle = await renderScenario(page, {
    name: 'idle', durationS: 1, keyframes: [{ atMs: 0, phase: 'untethered', spin: 0 }],
  });
  check('a-idle', 'idle render has peak exactly 0', idle.peak === 0, `peak ${idle.peak}`);

  const muted = await renderScenario(page, { name: 'muted', durationS: THROW_S, keyframes: THROW, muted: true });
  check('c-muted', 'muted render has peak exactly 0', muted.peak === 0, `peak ${muted.peak}`);

  const locked = await renderScenario(page, { name: 'locked', durationS: THROW_S, keyframes: THROW, unlocked: false });
  check('c-locked', 'a page that never unlocked is exactly silent',
    locked.peak === 0 && locked.humCommands === 0, `peak ${locked.peak}, hum commands ${locked.humCommands}`);

  const paused = await renderScenario(page, {
    name: 'paused', durationS: 1.5, keyframes: [{ atMs: 0, phase: 'sleeping', spin: 600, paused: true }],
  });
  check('c-paused', 'a paused sleeper does not hum', paused.peak === 0, `peak ${paused.peak}`);

  for (const phase of ['tethered', 'untethered', 'exhausted'] as const) {
    const result = await renderScenario(page, {
      name: phase, durationS: 1.5, keyframes: [{ atMs: 0, phase, spin: 600 }],
    });
    check(`c-${phase}-silent`, `${phase} does not hum even with spin reported`, result.peak === 0, `peak ${result.peak}`);
  }

  const lowSpin = await renderScenario(page, steady('spin-at-threshold', HUM_SPIN_SILENT));
  check('c-near-zero-silent', `the hum is silent at the exhausted spin (${HUM_SPIN_SILENT} rad/s)`,
    lowSpin.peak === 0, `peak ${lowSpin.peak}`);

  return { idle, muted, locked };
}

/** (b): the scripted throw, as events alone, hum alone and both together. */
async function scriptedThrow(page: Page) {
  const eventsOnly = await renderScenario(page, {
    name: 'events-only', durationS: THROW_S, keyframes: withoutHum(THROW), envelopeMs: 10,
  });
  const humOnly = await renderScenario(page, {
    name: 'hum-only', durationS: THROW_S, keyframes: withoutEvents(THROW), envelopeMs: 10,
  });
  const sequence = await renderScenario(page, {
    name: 'sequence', durationS: THROW_S, keyframes: THROW, envelopeMs: 10, wav: true,
  });
  saveWav('sequence.wav', sequence.wavBase64);

  check('b-sequence-peak', 'scripted launch→hum→snap→zip→catch peaks below clipping',
    sequence.peak < CLIP_CEILING, `peak ${fmt(sequence.peak)} (${dbfs(sequence.peak)})`);
  check('b-sequence-audible', 'the sequence has energy (rms > 0)',
    sequence.rms > 1e-3, `rms ${fmt(sequence.rms, 4)} (${dbfs(sequence.rms)})`);

  const expected: Record<OneShotKind, number> = { whoosh: 1, snap: 1, zip: 1, catch: 1, tether: 2 };
  const eachOnce = JSON.stringify(sequence.played) === JSON.stringify(expected)
    && sequence.rateLimited === 0 && sequence.capped === 0;
  check('b-sequence-events', 'each event of the throw produced exactly one sound, none dropped',
    eachOnce, JSON.stringify(sequence.played));

  // Where each event lands, and how long its voice lasts.
  const windows = [
    { id: 'tether', fromS: 0.2, toS: 0.2 + buildOneShot('tether', 0.6).durationS },
    { id: 'whoosh', fromS: 0.9, toS: 0.9 + buildOneShot('whoosh', launchIntensity(2.4)).durationS },
    { id: 'snap', fromS: 2.1, toS: 2.1 + buildOneShot('snap', 0.7).durationS },
    { id: 'zip', fromS: 4.3, toS: 4.3 + Math.min(ZIP_MAX_S, 0.65 / (520 * 0.003)) },
    { id: 'catch', fromS: 4.75, toS: 4.75 + buildOneShot('catch', 0.4).durationS },
    { id: 'retether', fromS: 4.95, toS: 4.95 + buildOneShot('tether', 0.25).durationS },
  ];
  const windowReport: Record<string, { rmsDb: number }> = {};
  for (const w of windows) {
    // One frame (17 ms) of latency before the event is applied, plus the voice's own length.
    const rms = rmsBetween(eventsOnly, w.fromS, w.toS + 0.02);
    windowReport[w.id] = { rmsDb: dbFloor(db(rms)) };
    check(`b-event-${w.id}`, `${w.id} is audible in its window (events-only render)`, rms > 1e-3, `rms ${dbfs(rms)}`);
  }

  // Silent between events: no stray sound or tail outside the windows (+ 50 ms for the last frame and the limiter).
  const bin = eventsOnly.envelopeMs / 1000;
  const inWindow = (i: number) => windows.some((w) => i * bin >= w.fromS - 0.001 && i * bin <= w.toS + 0.05);
  const strays = eventsOnly.envelope.filter((value, i) => value > SILENCE_EPS && !inWindow(i));
  check('b-silent-between-events', 'events-only render is exactly silent outside the event windows',
    strays.length === 0, `${strays.length} non-silent 10 ms bins outside the windows`);

  // Latency: how long after its event each sound starts.
  const onsets: Record<string, number> = {};
  for (const w of windows) {
    const first = Math.floor(w.fromS / bin);
    const last = Math.ceil((w.toS + 0.02) / bin);
    const loudest = Math.max(...eventsOnly.envelope.slice(first, last));
    const at = eventsOnly.envelope.findIndex((v, i) => i >= first && v > Math.max(1e-4, 0.03 * loudest));
    onsets[w.id] = at < 0 ? Number.POSITIVE_INFINITY : at * bin - w.fromS;
  }
  const slowest = Object.entries(onsets).reduce((a, b) => (b[1] > a[1] ? b : a));
  const onsetList = Object.entries(onsets).map(([k, v]) => `${k} ${fmt(v * 1000, 0)}`).join(', ');
  check('b-onset-latency', `every sound starts within ${ONSET_LIMIT_S * 1000} ms of its event (one frame plus the attack)`,
    slowest[1] <= ONSET_LIMIT_S, `slowest: ${slowest[0]} ${fmt(slowest[1] * 1000, 0)} ms; ${onsetList} ms`);

  // The hum on its own: only while spinning, and louder as the descent spins up.
  const lead = rmsBetween(humOnly, 0, 0.85);
  const tail = rmsBetween(humOnly, 5.6, THROW_S);
  check('b-hum-only-while-spinning', 'the hum is silent while tethered, before the launch and after the catch',
    lead < SILENCE_EPS && tail < 1e-4, `before ${fmtDb(db(lead))}, after ${fmtDb(db(tail))}`);
  const spinUp = [rmsBetween(humOnly, 0.95, 1.1), rmsBetween(humOnly, 1.35, 1.5), rmsBetween(humOnly, 1.75, 1.9)];
  check('b-hum-follows-spin-up', 'the hum gets louder as the spin climbs 300→500→700 during the descent',
    monotonic(spinUp), `${spinUp.map((v) => fmt(db(v), 1)).join(' < ')} dBFS`);

  return { sequence, windowReport, onsets };
}

/** (d): the hum's pitch, level and brightness against spin, steady state. */
async function humAgainstSpin(page: Page) {
  const rows: Array<{ spin: number; modelHz: number; measuredHz: number; centroidHz: number; rmsDb: number }> = [];
  for (const spin of [150, 300, 500, 700, 1000]) {
    const window = { fromS: 1, toS: 1.95, minHz: 40, maxHz: 1000 };
    const r = await renderScenario(page, steady(`hum-${spin}`, spin, { analyze: window }));
    const a = r.analysis!;
    rows.push({ spin, modelHz: humFrequencyHz(spin), measuredHz: a.dominantHz, centroidHz: a.centroidHz, rmsDb: db(a.rms) });
  }
  const list = (pick: (r: (typeof rows)[number]) => string) => rows.map((r) => `${r.spin}→${pick(r)}`).join(', ');

  check('d-hum-pitch-rises', "the hum's dominant frequency increases with spin (FFT, 150/300/500/700/1000 rad/s)",
    monotonic(rows.map((r) => r.measuredHz)), list((r) => `${fmt(r.measuredHz, 1)} Hz`));
  const worst = Math.max(...rows.map((r) => Math.abs(r.measuredHz - r.modelHz) / r.modelHz));
  check('d-hum-pitch-matches-model', `the measured pitch is the director's mapping within ${PITCH_TOLERANCE * 100} %`,
    worst <= PITCH_TOLERANCE, `worst error ${fmt(worst * 100, 2)} %`);
  check('d-hum-louder-with-spin', 'the hum gets louder with spin (rms)',
    monotonic(rows.map((r) => r.rmsDb)), list((r) => `${fmt(r.rmsDb, 1)} dBFS`));
  check('d-hum-brighter-with-spin', 'the hum gets brighter with spin (spectral centroid)',
    monotonic(rows.map((r) => r.centroidHz)), list((r) => hz(r.centroidHz)));
  const measuredRatio = rows[3].measuredHz / rows[1].measuredHz;
  const modelRatio = humFrequencyHz(700) / humFrequencyHz(300);
  check('d-hum-ratio', "pitch ratio 700:300 rad/s is the model's (not a fixed tone)",
    Math.abs(measuredRatio - modelRatio) < 0.03, `${fmt(measuredRatio, 3)} vs ${fmt(modelRatio, 3)}`);
  return rows;
}

/** (h): a fast spin ramp steered at the real 30 Hz sounds the same as at 240 Hz, and its pitch climbs steadily. */
async function steeringSmoothness(page: Page) {
  const keyframes: ScriptKeyframe[] = [
    { atMs: 0, phase: 'sleeping', spin: 100 },
    { atMs: 1500, phase: 'sleeping', spin: 700 },
    { atMs: 2200, phase: 'sleeping', spin: 700 },
  ];
  const slow = JSON.stringify({ name: 'ramp-30hz', durationS: 2.2, keyframes });
  const fast = JSON.stringify({
    name: 'ramp-240hz', durationS: 2.2, keyframes, frameRateHz: 240, directorOptions: { humIntervalMs: 0 },
  });
  const c = await inPage<ConvergenceResult>(page, `h.compareControlRates(${slow}, ${fast})`);

  check('h-no-zipper-loudness',
    `a 100→700 rad/s ramp at 30 Hz and at 240 Hz differ by under ${CONVERGENCE_MEAN_DB} dB on average `
      + `and ${CONVERGENCE_MAX_DB} dB at worst in loudness (20 ms bins)`,
    c.meanEnvelopeDiffDb < CONVERGENCE_MEAN_DB && c.maxEnvelopeDiffDb < CONVERGENCE_MAX_DB,
    `mean ${fmt(c.meanEnvelopeDiffDb, 2)} dB, max ${fmt(c.maxEnvelopeDiffDb, 2)} dB`);
  check('h-no-zipper-pitch', `...and by under ${CONVERGENCE_HZ} Hz in pitch`,
    c.maxPitchDiffHz < CONVERGENCE_HZ, `max ${fmt(c.maxPitchDiffHz, 2)} Hz`);
  const steps = c.pitchA.slice(1).map((f, i) => f - c.pitchA[i]);
  check('h-pitch-glides-up', 'during the ramp the pitch only rises, in small steps (no jumps, no backsliding)',
    steps.every((d) => d > -1 && d < 40), `track ${c.pitchA.map((f) => fmt(f, 0)).join(' → ')} Hz`);
  return c;
}

/** (i): stopping the hum fades it, then the voice is released. */
async function fadeAndRelease(page: Page) {
  const fade = await renderScenario(page, {
    name: 'fade', durationS: 5, envelopeMs: 20,
    keyframes: [
      { atMs: 0, phase: 'sleeping', spin: 700 },
      { atMs: 1500, phase: 'sleeping', spin: 700, paused: true },
    ],
  });
  const before = rmsBetween(fade, 1.2, 1.5);
  const fadeAt = (fromS: number, toS: number) => dbFloor(db(rmsBetween(fade, fromS, toS) / before));
  const profile = { after100ms: fadeAt(1.6, 1.7), after300ms: fadeAt(1.8, 1.9), after800ms: fadeAt(2.3, 2.5) };
  const later = rmsBetween(fade, 4.0, 5.0);

  check('i-fade-out', `after pause the hum is ${-FADE_DB[0]} dB down at +0.3 s and ${-FADE_DB[1]} dB at +0.8 s`,
    profile.after300ms < FADE_DB[0] && profile.after800ms < FADE_DB[1],
    `+0.1 s ${fmtDb(profile.after100ms)}, +0.3 s ${fmtDb(profile.after300ms)}, +0.8 s ${fmtDb(profile.after800ms)}`);
  check('i-released', 'a long-silent hum voice is released: exact silence afterwards', later < SILENCE_EPS, `rms ${later}`);
  return profile;
}

/** (g): each voice solo, before the master chain: nominal level, balance against the hum, strength mapping and sweep direction. */
async function soloVoices(page: Page) {
  const voices: Record<string, VoiceResult> = {};
  for (const kind of ONE_SHOT_KINDS) {
    for (const intensity of [0, 0.5, 1]) {
      const c = buildOneShot(kind, intensity);
      const params = JSON.stringify({ gain: c.gain, intensity, durationS: c.durationS });
      const wav = intensity === 0 || intensity === 1;
      const r = await inPage<VoiceResult>(page, `h.renderVoice(${JSON.stringify(kind)}, ${params}, ${wav})`);
      saveWav(`voice-${kind}-${intensity === 0 ? 'soft' : 'hard'}.wav`, r.wavBase64);
      delete r.wavBase64;
      voices[`${kind}@${intensity}`] = r;
    }
  }

  const offBand = Object.entries(voices).filter(([, r]) => r.peakOverGain < GAIN_BAND[0] || r.peakOverGain > GAIN_BAND[1]);
  check('g-voice-levels', "every voice's peak is within ±3 dB of its nominal gain", offBand.length === 0,
    offBand.length === 0 ? 'all within' : offBand.map(([k, r]) => `${k} ${fmt(r.peakOverGain, 2)}`).join(', '));
  const loudest = Math.max(...Object.values(voices).map((r) => r.peak));
  check('g-voice-ceiling', `no voice peaks above ${VOICE_PEAK_CEILING} before the master chain`,
    loudest <= VOICE_PEAK_CEILING, `loudest ${fmt(loudest)}`);

  for (const kind of ONE_SHOT_KINDS) {
    const levels = [0, 0.5, 1].map((i) => voices[`${kind}@${i}`].aWeightedDb);
    check(`g-${kind}-dynamics`, `${kind} gets louder with its strength`,
      monotonic(levels), `${levels.map((l) => fmt(l, 1)).join(' < ')} dBA`);
  }
  const whooshCentroids = [0, 0.5, 1].map((i) => voices[`whoosh@${i}`].centroidHz);
  check('g-whoosh-brighter', 'a harder throw sounds brighter',
    monotonic(whooshCentroids), whooshCentroids.map(hz).join(' < '));

  const sweep = (key: string, fromTo: 'down' | 'up') => {
    const v = voices[key];
    const rose = v.centroidLateHz > v.centroidEarlyHz;
    return { pass: fromTo === 'up' ? rose : !rose, text: `${hz(v.centroidEarlyHz)} → ${hz(v.centroidLateHz)}` };
  };
  const whoosh = sweep('whoosh@0.5', 'down');
  check('g-whoosh-sweeps-down', 'the whoosh sweeps down (first half brighter than the second)', whoosh.pass, whoosh.text);
  const zip = sweep('zip@0.5', 'up');
  check('g-zip-sweeps-up', 'the zip sweeps up (second half brighter than the first)', zip.pass, zip.text);
  const thud = sweep('catch@0.5', 'down');
  check('g-catch-pitch-falls', 'the catch thud drops in pitch', thud.pass, thud.text);

  // The reference for balance: the hum at the top of the canonical launch band.
  const humCommand = { active: true, frequencyHz: humFrequencyHz(750), gain: humGain(750), brightness: 1 };
  const hum = await inPage<VoiceResult>(page, `h.renderHum(${JSON.stringify(humCommand)})`);
  return { voices, hum };
}

/** (e) and (f): the worst cases through the real master chain, and what the limiter does to a clean tone. */
async function headroom(page: Page) {
  const stressFull = await inPage<ScenarioResult>(page, 'h.renderStress(1)');
  const stressDefault = await inPage<ScenarioResult>(page, `h.renderStress(${DEFAULT_VOLUME})`);
  check('e-stress-full', 'ten loudest one-shots + hum at its ceiling, volume 1: peak below clipping',
    stressFull.peak < CLIP_CEILING, `peak ${fmt(stressFull.peak)} (${dbfs(stressFull.peak)})`);
  check('e-stress-default', `same at the default volume (${DEFAULT_VOLUME}): peak below clipping`,
    stressDefault.peak < CLIP_CEILING, `peak ${fmt(stressDefault.peak)} (${dbfs(stressDefault.peak)})`);

  // Whatever the rate limits and the voice cap let through of a hostile event stream must not clip either.
  const storm = await renderScenario(page, { name: 'storm', durationS: 3.4, keyframes: stormKeys(), volume: 1 });
  check('e-storm-director',
    'an event storm through the director (volume 1, spin 1000) stays below clipping and within the voice cap',
    storm.peak < CLIP_CEILING && storm.rateLimited + storm.capped > 0,
    `peak ${fmt(storm.peak)} (${dbfs(storm.peak)}), played ${JSON.stringify(storm.played)}, `
      + `rate-limited ${storm.rateLimited}, capped ${storm.capped}`);

  const chain: ChainGainResult[] = [];
  for (const amplitude of [0.01, 0.1, 0.3, 0.5, 1, 2, 4]) {
    chain.push(await inPage<ChainGainResult>(page, `h.renderChainGain(${amplitude})`));
  }
  check('f-limiter-ceiling', 'the limiter keeps even a +12 dBFS tone below clipping',
    chain.every((c) => c.outputPeak < CLIP_CEILING), `peak at 4.0 in: ${fmt(chain[chain.length - 1].outputPeak)}`);
  return { stressFull, stressDefault, storm, chain };
}

/** (j): the long listen. A decaying sleeper from 750 rad/s with τ = 4 s, until it is spent. */
async function sleeperDecay(page: Page) {
  const sleeper = await renderScenario(page, {
    name: 'sleeper', durationS: 15, keyframes: sleeperKeys(), envelopeMs: 50, wav: true,
  });
  saveWav('sleeper-decay.wav', sleeper.wavBase64);
  const levels = [0.5, 4, 8, 12].map((t) => ({ t, rmsDb: db(rmsBetween(sleeper, t - 0.3, t + 0.3)) }));
  const endsSilent = sleeper.envelope[sleeper.envelope.length - 1] < 1e-4;
  check('j-sleeper-decays', 'a decaying sleeper gets quieter over time and ends silent',
    monotonic(levels.map((l) => -l.rmsDb)) && endsSilent, levels.map((l) => `${l.t}s ${fmt(l.rmsDb, 1)} dBFS`).join(', '));
  return levels;
}

/** (k): the real YoyoAudio on a real AudioContext, in real time, after a real click. */
async function liveSmoke(page: Page, pageProblems: string[]) {
  await page.mouse.click(5, 5);
  const code = "(async () => { const h = await import('/src/yoyo/audio/liveHarness.ts'); return await h.runLiveSmoke(); })()";
  const live = (await page.evaluate(code)) as LiveSmokeResult;

  check('k-live-silent-before-unlock',
    'before unlock(): no AudioContext exists, status locked, output exactly silent',
    live.contextsBeforeUnlock === 0 && live.statusBeforeUnlock === 'locked' && live.peakBeforeUnlock === 0,
    `contexts ${live.contextsBeforeUnlock}, status ${live.statusBeforeUnlock}, peak ${live.peakBeforeUnlock}`);
  check('k-live-unlock-runs', 'unlock() after a click leaves a running context and status ready',
    live.stateAfterUnlock === 'running' && live.statusAfterUnlock === 'ready',
    `context ${live.stateAfterUnlock}, status ${live.statusAfterUnlock}`);
  check('k-live-plays', 'a launch and a hum come out of the real AudioContext',
    live.peakWhilePlaying > 0.01 && live.playedWhilePlaying.whoosh === 1,
    `tap peak ${fmt(live.peakWhilePlaying)} (${dbfs(live.peakWhilePlaying)}), whoosh played ${live.playedWhilePlaying.whoosh}`);
  check('k-live-mute-immediate',
    `setMuted(true) silences the live output within ${LIVE_MUTE_LIMIT_MS} ms (the tap itself holds ~43 ms)`,
    live.muteSettleMs <= LIVE_MUTE_LIMIT_MS && live.peakAfterMute === 0,
    `silent after ${fmt(live.muteSettleMs, 0)} ms, peak after ${live.peakAfterMute}`);
  check('k-live-unmute', 'setMuted(false) brings the hum back', live.peakAfterUnmute > 0.01, `tap peak ${fmt(live.peakAfterUnmute)}`);
  check('k-live-suspend', 'suspend() suspends the context and plays nothing while hidden',
    live.stateAfterSuspend === 'suspended' && live.statusAfterSuspend === 'suspended' && live.playedWhileSuspended === 0,
    `context ${live.stateAfterSuspend}, status ${live.statusAfterSuspend}, played while suspended ${live.playedWhileSuspended}`);
  check('k-live-resume', 'resume() runs the context again', live.stateAfterResume === 'running', `context ${live.stateAfterResume}`);
  check('k-live-close', 'close() closes the context and the audio is terminal',
    live.stateAfterClose === 'closed' && live.statusAfterClose === 'closed',
    `context ${live.stateAfterClose}, status ${live.statusAfterClose}`);
  check('k-live-no-throw',
    `nothing threw out of ${live.updates} real-time updates and calls, and audio never reported giving up`,
    live.thrown.length === 0 && pageProblems.length === 0, live.thrown.concat(pageProblems).join('; ') || 'clean');
  return live;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'warn',
  // The audio modules import nothing bare: no dependency pre-bundling, no file watching, no HMR socket.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 5193, hmr: false, watch: null },
});
await server.listen();
const origin = (server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5193/').replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const page = await browser.newPage();
  const pageProblems: string[] = [];
  page.on('pageerror', (error) => {
    pageProblems.push(error.message);
    console.error('[page error]', error.message);
  });
  // YoyoAudio reports giving up with a console warning: that must not happen in a healthy run.
  page.on('console', (message) => {
    if (message.text().startsWith('[yoyo-audio]')) pageProblems.push(message.text());
  });
  // A bare page on the dev server's origin: the modules are imported from it, the Masa app is not loaded.
  await page.route(`${origin}/__yoyo_audio_qa__`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>yoyo audio qa</title>' }));
  await page.goto(`${origin}/__yoyo_audio_qa__`);
  const chromeVersion = browser.version();

  const { idle, muted, locked } = await silenceGates(page);
  const { sequence, windowReport, onsets } = await scriptedThrow(page);
  const hums = await humAgainstSpin(page);
  const converge = await steeringSmoothness(page);
  const fadeProfile = await fadeAndRelease(page);
  const { voices, hum: hum750 } = await soloVoices(page);
  const { stressFull, stressDefault, storm, chain } = await headroom(page);
  const sleeperLevels = await sleeperDecay(page);
  const live = await liveSmoke(page, pageProblems);

  // Report ------------------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass);
  const humDb = hum750.aWeightedDb;
  const report = {
    kind: 'yoyo-offline-web-audio-44.1kHz-mono',
    evidence: {
      type: 'synthetic',
      how: 'real AudioDirector + YoyoAudioGraph, scripted snapshots, OfflineAudioContext, headless Chrome (channel chrome); '
        + 'plus a real-time YoyoAudio smoke on a real AudioContext',
      browser: chromeVersion,
      notEvidenceOf: [
        'how it sounds', 'loudness on real speakers', 'whether the hum feels tied to the yoyo',
      ],
      humanListening: 'pending: listen to artifacts/qa/yoyo/audio/*.wav',
    },
    pass: failed.length === 0,
    config: {
      sampleRate: 44100, masterFullScale: MASTER_FULL_SCALE, defaultVolume: DEFAULT_VOLUME, limiter: LIMITER,
      humGainMax: HUM_GAIN_MAX, maxOneShotVoices: MAX_ONE_SHOT_VOICES,
    },
    checks,
    idle: { peak: idle.peak, rms: idle.rms },
    sequence: {
      peak: sequence.peak, peakDb: db(sequence.peak), rms: sequence.rms, rmsDb: db(sequence.rms),
      played: sequence.played, humCommands: sequence.humCommands, eventWindows: windowReport,
    },
    onsetsMs: Object.fromEntries(Object.entries(onsets).map(([k, v]) => [k, v * 1000])),
    muted: { peak: muted.peak, rms: muted.rms },
    locked: { peak: locked.peak },
    hum: hums,
    humAt750: { aWeightedDb: humDb, peak: hum750.peak },
    voices: Object.fromEntries(Object.entries(voices).map(([key, r]) => [key, {
      gain: r.gain, peak: r.peak, peakOverGain: r.peakOverGain, aWeightedDb: r.aWeightedDb,
      relativeToHumDb: r.aWeightedDb - humDb, centroidHz: r.centroidHz,
      centroidEarlyHz: r.centroidEarlyHz, centroidLateHz: r.centroidLateHz,
    }])),
    zipper: {
      loudnessMeanDiffDb: converge.meanEnvelopeDiffDb, loudnessMaxDiffDb: converge.maxEnvelopeDiffDb,
      pitchDiffHz: converge.maxPitchDiffHz, pitchTrack30Hz: converge.pitchA, pitchTrack240Hz: converge.pitchB,
    },
    fade: fadeProfile,
    storm: {
      peak: storm.peak, peakDb: db(storm.peak), played: storm.played, rateLimited: storm.rateLimited, capped: storm.capped,
    },
    stress: {
      volume1: { peak: stressFull.peak, peakDb: db(stressFull.peak) },
      default: { volume: DEFAULT_VOLUME, peak: stressDefault.peak, peakDb: db(stressDefault.peak) },
    },
    limiter: chain,
    sleeper: sleeperLevels,
    live,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'audio-qa.json'), `${JSON.stringify(report, null, 2)}\n`);

  const line = (text = '') => console.log(text);
  line('Yoyo audio QA (SYNTHETIC: offline render in headless Chrome, plus a real-time smoke)');
  line('-'.repeat(78));
  for (const c of checks) line(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(28)} ${c.value}`);
  line();
  line('Hum: pitch and level against spin');
  line('  spin   model Hz   measured Hz   centroid Hz   rms dBFS');
  for (const h of hums) {
    line(`  ${String(h.spin).padStart(4)}   ${fmt(h.modelHz, 1).padStart(8)}   ${fmt(h.measuredHz, 1).padStart(11)}`
      + `   ${String(Math.round(h.centroidHz)).padStart(11)}   ${fmt(h.rmsDb, 1).padStart(8)}`);
  }
  line();
  line(`Voices, solo, before the master chain (hum at 750 rad/s = ${fmt(humDb, 1)} dBA)`);
  line('  voice            gain   peak   peak/gain   dBA    vs hum   centroid');
  for (const [key, r] of Object.entries(voices)) {
    line(`  ${key.padEnd(15)} ${fmt(r.gain, 2).padStart(6)} ${fmt(r.peak, 3).padStart(6)} ${fmt(r.peakOverGain, 2).padStart(10)}`
      + ` ${fmt(r.aWeightedDb, 1).padStart(7)} ${fmt(r.aWeightedDb - humDb, 1).padStart(7)} ${hz(r.centroidHz).padStart(10)}`);
  }
  line();
  line(`Master chain: ${chain.map((c) => `${c.inputAmplitude}→${fmt(c.gainDb, 1)} dB`).join(', ')}`);
  line(`Sequence: peak ${fmt(sequence.peak)} (${dbfs(sequence.peak)}), rms ${fmt(sequence.rms, 4)} (${dbfs(sequence.rms)}); `
    + `idle peak ${idle.peak}; muted peak ${muted.peak}`);
  line(`Stress: volume 1 peak ${fmt(stressFull.peak)}, default volume peak ${fmt(stressDefault.peak)}; `
    + `storm peak ${fmt(storm.peak)}`);
  line('Report: artifacts/qa/yoyo/audio-qa.json; listen: artifacts/qa/yoyo/audio/*.wav');
  line(failed.length === 0
    ? `\nPASS: ${checks.length} checks`
    : `\nFAIL: ${failed.length} of ${checks.length} checks failed (${failed.map((c) => c.id).join(', ')})`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
