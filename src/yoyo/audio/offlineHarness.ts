import type { YoyoEventKind, YoyoPhase, YoyoSnapshot } from '../contracts';
import { aWeightedRms, dominantFrequency, encodeWav, peakOf, rmsEnvelope, rmsOf, spectralCentroid, toDb } from './analysis';
import { AudioDirector, buildOneShot, HUM_GAIN_MAX, humFrequencyHz, HUM_SPIN_MAX, type AudioDirectorOptions } from './AudioDirector';
import { buildSnapshot } from './snapshots';
import { ONE_SHOT_KINDS, type HumCommand, type OneShotKind, type OneShotParams } from './types';
import { createHumVoice, createNoiseBuffer, scheduleOneShot, type VoiceEnv } from './voices';
import { createMasterChain, DEFAULT_VOLUME, YoyoAudioGraph } from './YoyoAudioGraph';

/**
 * Offline renders for the QA (scripts/yoyo-audio-qa.ts). It drives the very same AudioDirector and
 * YoyoAudioGraph that the live wrapper uses, but on an OfflineAudioContext and a scripted timeline,
 * so what gets measured is the code that runs in the page, minus only the AudioContext lifecycle.
 *
 * Browser-only (OfflineAudioContext); nothing in the app imports this file.
 */

/** 44.1 kHz mono: what the QA reports against. */
export const SAMPLE_RATE = 44100;

/** One state of the scripted yoyo, from `atMs` until the next keyframe. */
export interface ScriptKeyframe {
  atMs: number;
  phase: YoyoPhase;
  spin: number;
  /** Interpolate the spin linearly toward the next keyframe's. Default true. */
  ramp?: boolean;
  /** Events emitted on the first frame at or after atMs. */
  events?: ReadonlyArray<{ kind: YoyoEventKind; strength?: number }>;
  /** False scripts a lost hand (lostMs ≥ the ducking grace). Default true. */
  handPresent?: boolean;
  paused?: boolean;
  /** Exposed string length, m (sizes the zip). Default 0.65. */
  length?: number;
}

/** Window of a render to measure for pitch and brightness (steady-state hum). */
export interface AnalysisWindow {
  fromS: number;
  toS: number;
  minHz?: number;
  maxHz?: number;
}

export interface ScenarioInput {
  name: string;
  durationS: number;
  keyframes: readonly ScriptKeyframe[];
  volume?: number;
  muted?: boolean;
  /** False rehearses a page that never ran unlock(). Default true. */
  unlocked?: boolean;
  /** Frames per second the engine would call update at. Default 60. */
  frameRateHz?: number;
  /** Director settings; the zipper-noise QA renders the same ramp at two hum update rates. */
  directorOptions?: AudioDirectorOptions;
  /** Loudness envelope bin, ms. Default 50. */
  envelopeMs?: number;
  analyze?: AnalysisWindow;
  /** Return the render as a base64 WAV, for listening. */
  wav?: boolean;
}

export interface WindowAnalysis {
  dominantHz: number;
  centroidHz: number;
  rms: number;
  peak: number;
}

export interface ScenarioResult {
  name: string;
  durationS: number;
  peak: number;
  rms: number;
  /** RMS per bin of `envelopeMs`. */
  envelope: number[];
  envelopeMs: number;
  played: Record<OneShotKind, number>;
  rateLimited: number;
  capped: number;
  humCommands: number;
  analysis?: WindowAnalysis;
  wavBase64?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function analyse(samples: Float32Array, window: AnalysisWindow): WindowAnalysis {
  const from = Math.max(0, Math.floor(window.fromS * SAMPLE_RATE));
  const to = Math.min(samples.length, Math.ceil(window.toS * SAMPLE_RATE));
  const slice = samples.subarray(from, to);
  return {
    dominantHz: dominantFrequency(slice, SAMPLE_RATE, window.minHz ?? 40, window.maxHz ?? 2000),
    centroidHz: spectralCentroid(slice, SAMPLE_RATE, window.minHz ?? 40, 12000),
    rms: rmsOf(slice),
    peak: peakOf(slice),
  };
}

/** The snapshot the engine would hand over at `timeMs` for a script, firing each keyframe's events once. */
function snapshotAt(keys: readonly ScriptKeyframe[], timeMs: number, fired: Set<number>): YoyoSnapshot {
  let index = -1;
  for (let i = 0; i < keys.length; i += 1) if (keys[i].atMs <= timeMs) index = i;
  if (index < 0) return buildSnapshot({ timeMs });
  const key = keys[index];
  const next = keys[index + 1];
  const span = next ? next.atMs - key.atMs : 0;
  const spin = next && key.ramp !== false && span > 0 ? key.spin + ((next.spin - key.spin) * (timeMs - key.atMs)) / span : key.spin;
  const events = [];
  for (let i = 0; i <= index; i += 1) {
    if (fired.has(i)) continue;
    fired.add(i);
    for (const e of keys[i].events ?? []) events.push({ kind: e.kind, timeMs, ...(e.strength === undefined ? {} : { strength: e.strength }) });
  }
  const present = key.handPresent !== false;
  return buildSnapshot({
    timeMs,
    phase: key.phase,
    spin,
    events,
    paused: key.paused === true,
    length: key.length ?? 0.65,
    hand: { present, lostMs: present ? 0 : Math.max(400, timeMs - key.atMs), edge: null, landmarks: null, palmWorld: 0 },
  });
}

/** Renders a script through director → graph, the way YoyoAudio.update drives them live. */
async function renderSamples(input: ScenarioInput): Promise<{ samples: Float32Array; director: AudioDirector }> {
  const length = Math.round(input.durationS * SAMPLE_RATE);
  const context = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const graph = new YoyoAudioGraph(context, context.destination);
  const director = new AudioDirector(input.directorOptions);
  const muted = input.muted === true;
  graph.setOutput(input.volume ?? DEFAULT_VOLUME, muted, 0);
  director.setUnlocked(input.unlocked !== false);
  director.setMuted(muted);

  const frameMs = 1000 / (input.frameRateHz ?? 60);
  const fired = new Set<number>();
  for (let t = 0; t < input.durationS * 1000; t += frameMs) {
    graph.apply(director.update(snapshotAt(input.keyframes, t, fired), t), t / 1000);
  }
  return { samples: (await context.startRendering()).getChannelData(0), director };
}

/** Renders a scripted timeline and measures it. */
export async function renderScenario(input: ScenarioInput): Promise<ScenarioResult> {
  const { samples, director } = await renderSamples(input);
  const envelopeMs = input.envelopeMs ?? 50;
  return {
    name: input.name,
    durationS: input.durationS,
    peak: peakOf(samples),
    rms: rmsOf(samples),
    envelope: rmsEnvelope(samples, Math.round((envelopeMs / 1000) * SAMPLE_RATE)),
    envelopeMs,
    played: { ...director.stats.played },
    rateLimited: director.stats.rateLimited,
    capped: director.stats.capped,
    humCommands: director.stats.humCommands,
    analysis: input.analyze ? analyse(samples, input.analyze) : undefined,
    wavBase64: input.wav ? toBase64(encodeWav(samples, SAMPLE_RATE)) : undefined,
  };
}

export interface ConvergenceResult {
  /** Largest and mean gap between the two renders' 20 ms loudness, dB, once the hum has faded in. */
  maxEnvelopeDiffDb: number;
  meanEnvelopeDiffDb: number;
  /** Largest gap between their dominant frequencies, Hz. */
  maxPitchDiffHz: number;
  /** The dominant frequency of each render over time (every `stepS`), Hz. */
  pitchA: number[];
  pitchB: number[];
  stepS: number;
}

/**
 * Renders the same script with two different control rates and compares what you would hear: the
 * loudness over time and the pitch over time. Waveforms cannot be compared sample by sample (a
 * tone's phase drifts apart for a 0.5 Hz difference in trajectory, which no ear can tell), but a
 * hum that steps its pitch or level at the control rate would show it in these two curves. Both
 * renders use the same noise (fixed seed, same call order).
 */
export async function compareControlRates(a: ScenarioInput, b: ScenarioInput, settleS = 0.4, stepS = 0.25): Promise<ConvergenceResult> {
  const first = (await renderSamples(a)).samples;
  const second = (await renderSamples(b)).samples;
  const bin = Math.round(0.02 * SAMPLE_RATE);
  const ea = rmsEnvelope(first, bin);
  const eb = rmsEnvelope(second, bin);
  let maxEnvelopeDiffDb = 0;
  let sumEnvelopeDiffDb = 0;
  let bins = 0;
  for (let i = Math.ceil(settleS / 0.02); i < Math.min(ea.length, eb.length) - 1; i += 1) {
    const gap = Math.abs(toDb(ea[i] / eb[i]));
    maxEnvelopeDiffDb = Math.max(maxEnvelopeDiffDb, gap);
    sumEnvelopeDiffDb += gap;
    bins += 1;
  }
  const window = 8192;
  const pitchA: number[] = [];
  const pitchB: number[] = [];
  for (let t = settleS + window / SAMPLE_RATE; t <= Math.min(first.length, second.length) / SAMPLE_RATE; t += stepS) {
    const end = Math.round(t * SAMPLE_RATE);
    pitchA.push(dominantFrequency(first.subarray(end - window, end), SAMPLE_RATE, 40, 1000, window));
    pitchB.push(dominantFrequency(second.subarray(end - window, end), SAMPLE_RATE, 40, 1000, window));
  }
  const maxPitchDiffHz = Math.max(...pitchA.map((f, i) => Math.abs(f - pitchB[i])));
  return { maxEnvelopeDiffDb, meanEnvelopeDiffDb: bins > 0 ? sumEnvelopeDiffDb / bins : 0, maxPitchDiffHz, pitchA, pitchB, stepS };
}

/** What a solo render of one voice measured, straight from the voice builder (no master chain). */
export interface VoiceResult {
  label: string;
  /** Peak gain asked of the voice. */
  gain: number;
  durationS: number;
  peak: number;
  rms: number;
  /** peak / gain: how far the voice's real peak is from its nominal level (1 = exact). */
  peakOverGain: number;
  /** A-weighted rms over the sound's own length, dBFS: the loudness the voices are balanced on. */
  aWeightedDb: number;
  centroidHz: number;
  dominantHz: number;
  /** Centroid of the first and of the second half of the sound's own length: which way a sweep goes. */
  centroidEarlyHz: number;
  centroidLateHz: number;
  wavBase64?: string;
}

async function renderDirect(
  label: string, gain: number, seconds: number, activeS: number, build: (env: VoiceEnv) => void, wav: boolean, transient: boolean,
): Promise<VoiceResult> {
  const context = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const sink = context.createGain();
  sink.connect(context.destination);
  build({ context, destination: sink, noise: createNoiseBuffer(context) });
  const samples = (await context.startRendering()).getChannelData(0);
  const peak = peakOf(samples);
  return {
    label,
    gain,
    durationS: seconds,
    peak,
    rms: rmsOf(samples),
    peakOverGain: gain > 0 ? peak / gain : 0,
    aWeightedDb: toDb(aWeightedRms(samples, SAMPLE_RATE, Math.round(activeS * SAMPLE_RATE))),
    centroidHz: spectralCentroid(samples, SAMPLE_RATE, 40, 12000, 65536, !transient),
    dominantHz: dominantFrequency(samples, SAMPLE_RATE, 40, 12000, 65536),
    ...halves(samples, activeS),
    wavBase64: wav ? toBase64(encodeWav(samples, SAMPLE_RATE)) : undefined,
  };
}

/** Voices start at 10 ms in the solo renders (see renderVoice); the hum starts at 0. */
function halves(samples: Float32Array, activeS: number, startS = 0.01) {
  const start = Math.round(startS * SAMPLE_RATE);
  const half = Math.round((activeS * SAMPLE_RATE) / 2);
  const centroid = (from: number) => spectralCentroid(samples.subarray(from, from + half), SAMPLE_RATE, 40, 12000, 16384, false);
  return { centroidEarlyHz: centroid(start), centroidLateHz: centroid(start + half) };
}

/** One one-shot on its own, straight into the destination. Start offset into the noise is fixed, so it repeats. */
export function renderVoice(kind: OneShotKind, params: OneShotParams, wav = false): Promise<VoiceResult> {
  const seconds = params.durationS + 0.1;
  return renderDirect(`${kind} @ ${params.intensity}`, params.gain, seconds, params.durationS, (env) => {
    scheduleOneShot(kind, env, params, 0.01, 0.3);
  }, wav, true);
}

/** The hum on its own at a fixed command: pitch, brightness and level, measured on the last 0.74 s of 1.6 s. */
export async function renderHum(command: HumCommand, wav = false): Promise<VoiceResult> {
  return renderDirect(`hum @ ${command.frequencyHz.toFixed(0)} Hz`, command.gain, 1.6, 1.6, (env) => {
    const voice = createHumVoice(env, command, 0, 0.3);
    voice.steer(command, 0);
  }, wav, false);
}

/**
 * Every voice twice at its loudest, plus the hum at its ceiling, through the real master chain at
 * `volume`: more than the director would ever allow at once. The limiter has to keep it inside the
 * destination's range; this is where it earns its place.
 */
export async function renderStress(volume: number): Promise<ScenarioResult> {
  const seconds = 2;
  const context = new OfflineAudioContext(1, seconds * SAMPLE_RATE, SAMPLE_RATE);
  const graph = new YoyoAudioGraph(context, context.destination, { maxVoices: 32 });
  graph.setOutput(volume, false, 0);
  const hum: HumCommand = { active: true, frequencyHz: humFrequencyHz(HUM_SPIN_MAX), gain: HUM_GAIN_MAX, brightness: 1 };
  const loudest = [...ONE_SHOT_KINDS, ...ONE_SHOT_KINDS].map((kind) => buildOneShot(kind, 1));
  for (const at of [0.2, 0.35, 0.5]) graph.apply({ oneShots: loudest, hum }, at);
  for (let at = 0.55; at < seconds; at += 0.033) graph.apply({ oneShots: [], hum }, at);
  const samples = (await context.startRendering()).getChannelData(0);
  return {
    name: 'stress', durationS: seconds, peak: peakOf(samples), rms: rmsOf(samples), envelope: [], envelopeMs: 0,
    played: { whoosh: 3 * 2, snap: 3 * 2, zip: 3 * 2, catch: 3 * 2, tether: 3 * 2 }, rateLimited: 0, capped: 0, humCommands: 0,
  };
}

export interface ChainGainResult {
  inputAmplitude: number;
  outputPeak: number;
  /** Steady-state gain of the whole master chain at this level, dB (master gain forced to 1). */
  gainDb: number;
}

/**
 * How the limiter treats a 440 Hz sine of a given amplitude with the master gain at unity. A
 * DynamicsCompressorNode brings make-up gain of its own, so this measures what the chain really does
 * to quiet and loud signals instead of assuming it is transparent below the threshold.
 */
export async function renderChainGain(amplitude: number): Promise<ChainGainResult> {
  const context = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
  const chain = createMasterChain(context, context.destination);
  chain.input.gain.value = 1;
  const oscillator = context.createOscillator();
  oscillator.frequency.value = 440;
  const level = context.createGain();
  level.gain.value = amplitude;
  oscillator.connect(level);
  level.connect(chain.input);
  oscillator.start(0);
  const samples = (await context.startRendering()).getChannelData(0);
  const tail = samples.subarray(Math.floor(0.7 * SAMPLE_RATE));
  const inputRms = amplitude / Math.SQRT2;
  return { inputAmplitude: amplitude, outputPeak: peakOf(samples), gainDb: 20 * Math.log10(rmsOf(tail) / inputRms) };
}
