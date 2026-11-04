import { clamp, clamp01, finiteOr, lerp, Xorshift32 } from './math';
import type { HumCommand, OneShotKind, OneShotParams } from './types';

/**
 * Voice builders: Web Audio graphs for each sound of the yoyo, procedural only (oscillators and
 * filtered noise, no samples, no music).
 *
 * Everything takes a BaseAudioContext and a destination node and schedules against an explicit
 * `when`, so the same code runs live (`when` = currentTime, destination = the master chain) and in
 * an OfflineAudioContext (QA renders a scripted sequence, then measures it). The numbers that
 * decide how a voice sounds live in the small pure `*Shape` functions below, which are unit-tested
 * in Node without any audio.
 *
 * Levels. A voice's `gain` is meant as its approximate peak amplitude before the master chain; each
 * kind carries a trim measured in the offline QA so that holds within a few dB (filtered noise has
 * a peak well below its level, and a narrow band even more so).
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Shared noise buffer length, s. One-shots start at a random offset inside it; the hum loops it. */
export const NOISE_SECONDS = 2;
/** Fixed seed: renders are reproducible, so QA numbers do not wander between runs. */
export const NOISE_SEED = 0x2545f491;

/** Exponential releases stop this far (relative) above silence; the last sliver is then set to 0. */
const ENVELOPE_FLOOR = 1e-3;
/** Exponential ramps need a strictly positive target, whatever the peak. */
const ABSOLUTE_FLOOR = 1e-6;
const MIN_ATTACK_S = 0.0005;
const MIN_DURATION_S = 0.01;

/**
 * Measured solo-voice level corrections (scripts/yoyo-audio-qa.ts prints the evidence), so that a
 * voice's `gain` means what the director thinks it means.
 *
 * Percussive voices (snap, catch, tether) are trimmed so their PEAK equals `gain`: a click is heard
 * by its attack. Sustained noise voices (whoosh, zip) are trimmed by A-weighted rms against the
 * hum: a band-passed noise peaks at only a third of its `gain` (whoosh) to two thirds (zip), so a
 * peak calibration would leave the whoosh 10 dB below the hum it has to cut through.
 */
export const VOICE_TRIM: Readonly<Record<OneShotKind, number>> = {
  whoosh: 3,
  snap: 0.69,
  zip: 1.4,
  catch: 0.75,
  tether: 1.05,
};

/** Time constant with which the hum follows pitch, level and brightness, s. Slow enough to be click-free at 30 Hz updates. */
export const HUM_SMOOTH_S = 0.05;
/** Time constant of the hum's fade to silence (pause, exhausted, mute), s. */
export const HUM_FADE_S = 0.09;
/** Seconds a silent hum voice is kept before its oscillators are released. */
export const HUM_IDLE_STOP_S = 1.5;
/** Extra seconds oscillators run after a hum stop is requested, so the fade finishes before they end. */
const HUM_STOP_TAIL_S = 0.2;

/**
 * Weights of the hum's three partials; they sum to about 1 so the tone's peak stays near the hum's
 * gain. The bearing texture rides on top of it: measured, the hum's peak is 1.0–1.3 × its gain
 * (more at speed, where the texture is stronger).
 */
const HUM_BODY_WEIGHT = 0.6;
const HUM_OVERTONE_WEIGHT = 0.27;
const HUM_THIRD_WEIGHT = 0.11;
/**
 * The second partial is a hair sharp. A fixed ratio makes its beating with the fundamental follow
 * the pitch (0.2–1 Hz): a slow shimmer that makes the hum feel like a spinning thing, not a tone.
 */
const HUM_OVERTONE_DETUNE = 1.0035;
/** Bearing texture: noise band centre at rest and at full speed, Hz. */
const HUM_NOISE_LOW_HZ = 450;
const HUM_NOISE_HIGH_HZ = 2600;
const HUM_NOISE_Q = 1.1;
/**
 * Texture level relative to the hum, at rest and at full speed; see HUM_NOISE_TRIM. It stays high at
 * rest on purpose: when the spin is low the 70–100 Hz fundamental is at the edge of what a laptop
 * speaker plays, and the texture (centred at 450 Hz and up) is what keeps the dying sleeper audible.
 */
const HUM_NOISE_LEVEL_LOW = 0.55;
const HUM_NOISE_LEVEL_HIGH = 0.8;
/** Measured correction of the noise band's level (a band-passed noise has little energy). */
export const HUM_NOISE_TRIM = 1;
const HUM_MIN_HZ = 20;
const HUM_MAX_HZ = 2000;

// ---------------------------------------------------------------------------------------------
// Shapes: pure functions from intensity to the numbers of each voice
// ---------------------------------------------------------------------------------------------

/** Whoosh: noise through a band-pass that sweeps DOWN, brighter and narrower for a harder throw. */
export function whooshShape(intensity: number) {
  const i = clamp01(finiteOr(intensity, 0));
  return {
    startHz: lerp(900, 2800, i),
    endHz: lerp(240, 560, i),
    q: lerp(0.9, 2, i),
    attackS: lerp(0.05, 0.02, i),
  };
}

/** Zip: noise through a band-pass that sweeps UP, plus a faint chirp that gives the sweep a pitch. */
export function zipShape(intensity: number) {
  const i = clamp01(finiteOr(intensity, 0));
  return {
    startHz: lerp(450, 800, i),
    endHz: lerp(2400, 4200, i),
    q: lerp(2, 3.2, i),
    chirpStartHz: lerp(320, 480, i),
    chirpEndHz: lerp(1100, 1900, i),
    chirpLevel: 0.3,
  };
}

/** Snap: a few ms of high-passed noise (the string going taut) and a short damped «tick». */
export function snapShape(intensity: number) {
  const i = clamp01(finiteOr(intensity, 0));
  return {
    tickHz: lerp(1500, 2600, i),
    clickCutoffHz: lerp(1800, 3200, i),
    clickLevel: 0.9,
    tickLevel: 0.55,
  };
}

/**
 * Catch: a soft thud plus a short click. The thud sits at 100–260 Hz and its octave above, not
 * lower: a laptop speaker does not play below ~120 Hz and the ear is 15–20 dB deaf there at low
 * level, so a deeper thud would take most of the peak headroom and be barely heard. Soft comes from
 * the dropping pitch and the 4 ms attack, not from the sub-bass.
 */
export function catchShape(intensity: number) {
  const i = clamp01(finiteOr(intensity, 0));
  return {
    thudStartHz: lerp(190, 260, i),
    thudEndHz: lerp(100, 120, i),
    thudSweepS: 0.09,
    bodyRatio: 2,
    bodyLevel: 0.7,
    clickHz: lerp(1700, 2600, i),
    clickLevel: 0.7,
  };
}

/** Tether: a small pip with a little tick on top, the loop clicking onto the finger. */
export function tetherShape(intensity: number) {
  const i = clamp01(finiteOr(intensity, 0));
  return {
    pipHz: lerp(900, 1250, i),
    pipDropS: 0.02,
    tickCutoffHz: 2800,
    tickLevel: 0.35,
  };
}

/** Where each part of the hum goes for a command. */
export interface HumTargets {
  fundamentalHz: number;
  overtoneHz: number;
  thirdHz: number;
  noiseCenterHz: number;
  /** Noise level relative to the hum; the amplitude modulation swings it between 0 and this. */
  noiseLevel: number;
  outputGain: number;
}

export function humTargets(command: HumCommand): HumTargets {
  const brightness = clamp01(finiteOr(command.brightness, 0));
  const fundamental = clamp(finiteOr(command.frequencyHz, HUM_MIN_HZ), HUM_MIN_HZ, HUM_MAX_HZ / 3);
  return {
    fundamentalHz: fundamental,
    overtoneHz: 2 * fundamental * HUM_OVERTONE_DETUNE,
    thirdHz: 3 * fundamental,
    noiseCenterHz: lerp(HUM_NOISE_LOW_HZ, HUM_NOISE_HIGH_HZ, brightness),
    noiseLevel: lerp(HUM_NOISE_LEVEL_LOW, HUM_NOISE_LEVEL_HIGH, brightness) * HUM_NOISE_TRIM,
    outputGain: command.active ? clamp(finiteOr(command.gain, 0), 0, 1) : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/** What every builder needs from the graph. */
export interface VoiceEnv {
  context: BaseAudioContext;
  /** Where voices connect: the master chain's input. */
  destination: AudioNode;
  /** Shared white-noise buffer from createNoiseBuffer. */
  noise: AudioBuffer;
}

/** A scheduled one-shot. Its nodes are released when its last source ends. */
export interface OneShotVoice {
  /** Context time at which the voice has fallen silent. */
  readonly endTime: number;
  /** Fires once, after the nodes were disconnected. Assign before the end time. */
  onEnded: (() => void) | null;
  /** Releases the voice now (graph teardown); idempotent. */
  stop(): void;
}

/**
 * White noise from a fixed seed. Generated procedurally, so no sample ships with the app and an
 * offline render of the same graph is bit-for-bit repeatable.
 */
export function createNoiseBuffer(context: BaseAudioContext, seconds: number = NOISE_SECONDS, seed: number = NOISE_SEED): AudioBuffer {
  const length = Math.max(1, Math.round(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = new Float32Array(length);
  const random = new Xorshift32(seed);
  for (let i = 0; i < length; i += 1) data[i] = random.next() * 2 - 1;
  buffer.copyToChannel(data, 0);
  return buffer;
}

/**
 * Keeps a voice's nodes together so they can be released as a unit: disconnecting every node when
 * the last source has ended lets the browser free them (an AudioContext otherwise keeps finished
 * voices' nodes alive as long as anything references them).
 */
class VoiceNodes implements OneShotVoice {
  endTime = 0;
  onEnded: (() => void) | null = null;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private running = 0;
  private released = false;

  node<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  source<T extends AudioScheduledSourceNode>(source: T): T {
    this.nodes.push(source);
    this.sources.push(source);
    return source;
  }

  /** Release when every source has ended. Call after the sources were started. */
  watch(): void {
    this.running = this.sources.length;
    for (const source of this.sources) {
      source.onended = () => {
        this.running -= 1;
        if (this.running <= 0) this.release();
      };
    }
  }

  stopSourcesAt(time: number): void {
    for (const source of this.sources) {
      try {
        source.stop(time);
      } catch {
        // Already stopped: nothing left to schedule.
      }
    }
  }

  /** One-shot lifecycle: all sources stop together at endTime. */
  finish(endTime: number): this {
    this.endTime = endTime;
    this.watch();
    this.stopSourcesAt(endTime);
    return this;
  }

  stop(): void {
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    const done = this.onEnded;
    this.onEnded = null;
    done?.();
  }
}

/**
 * Attack then exponential release. An exponential ramp cannot start or end at 0, so the release
 * stops at a floor 60 dB under the peak and the last sliver is then set to 0 (inaudible, −60 dB).
 */
function pluckEnvelope(param: AudioParam, when: number, peak: number, attackS: number, durationS: number): void {
  const attack = clamp(attackS, MIN_ATTACK_S, durationS * 0.5);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.exponentialRampToValueAtTime(Math.max(peak * ENVELOPE_FLOOR, ABSOLUTE_FLOOR), when + durationS);
  param.setValueAtTime(0, when + durationS);
}

/** Fraction of the peak the zip starts at, when it reaches its peak, as shares of the duration. */
const ZIP_START_LEVEL = 0.35;
const ZIP_ATTACK_S = 0.03;
const ZIP_PEAK_AT = 0.8;

/** Swell instead of pluck: the zip grows as the yoyo nears the hand and is cut by the catch. */
function swellEnvelope(param: AudioParam, when: number, peak: number, durationS: number): void {
  const attack = Math.min(ZIP_ATTACK_S, durationS * 0.2);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak * ZIP_START_LEVEL, when + attack);
  param.linearRampToValueAtTime(peak, when + durationS * ZIP_PEAK_AT);
  param.exponentialRampToValueAtTime(Math.max(peak * ENVELOPE_FLOOR, ABSOLUTE_FLOOR), when + durationS);
  param.setValueAtTime(0, when + durationS);
}

function noiseSource(voice: VoiceNodes, env: VoiceEnv, loop = false): AudioBufferSourceNode {
  const source = voice.source(env.context.createBufferSource());
  source.buffer = env.noise;
  source.loop = loop;
  return source;
}

/** Keeps a one-shot's slice of the noise buffer inside the buffer, so the voice never reaches its end. */
function safeOffset(env: VoiceEnv, durationS: number, offsetS: number): number {
  return clamp(finiteOr(offsetS, 0), 0, Math.max(0, env.noise.duration - durationS - 0.01));
}

function oscillator(voice: VoiceNodes, env: VoiceEnv, type: OscillatorType, hz: number): OscillatorNode {
  const osc = voice.source(env.context.createOscillator());
  osc.type = type;
  osc.frequency.value = hz;
  return osc;
}

function gainNode(voice: VoiceNodes, env: VoiceEnv, value = 0): GainNode {
  const node = voice.node(env.context.createGain());
  node.gain.value = value;
  return node;
}

function filterNode(voice: VoiceNodes, env: VoiceEnv, type: BiquadFilterType, hz: number, q: number): BiquadFilterNode {
  const node = voice.node(env.context.createBiquadFilter());
  node.type = type;
  node.frequency.value = hz;
  node.Q.value = q;
  return node;
}

// ---------------------------------------------------------------------------------------------
// One-shots
// ---------------------------------------------------------------------------------------------

/** Launch: a whoosh. Filtered-noise burst, band-pass sweeping down; brighter, louder and shorter when harder. */
export function scheduleWhoosh(env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS = 0): OneShotVoice {
  const d = Math.max(MIN_DURATION_S, params.durationS);
  const shape = whooshShape(params.intensity);
  const voice = new VoiceNodes();
  const source = noiseSource(voice, env);
  const band = filterNode(voice, env, 'bandpass', shape.startHz, shape.q);
  band.frequency.setValueAtTime(shape.startHz, when);
  band.frequency.exponentialRampToValueAtTime(shape.endHz, when + d);
  const out = gainNode(voice, env);
  pluckEnvelope(out.gain, when, params.gain * VOICE_TRIM.whoosh, shape.attackS, d);
  source.connect(band);
  band.connect(out);
  out.connect(env.destination);
  source.start(when, safeOffset(env, d, noiseOffsetS));
  return voice.finish(when + d);
}

/** End of the string: a tiny click and tick. */
export function scheduleSnap(env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS = 0): OneShotVoice {
  const d = Math.max(MIN_DURATION_S, params.durationS);
  const shape = snapShape(params.intensity);
  const peak = params.gain * VOICE_TRIM.snap;
  const voice = new VoiceNodes();

  const source = noiseSource(voice, env);
  const highpass = filterNode(voice, env, 'highpass', shape.clickCutoffHz, 0.7);
  const click = gainNode(voice, env);
  pluckEnvelope(click.gain, when, peak * shape.clickLevel, 0.0008, d * 0.3);
  source.connect(highpass);
  highpass.connect(click);
  click.connect(env.destination);
  source.start(when, safeOffset(env, d, noiseOffsetS));

  const tick = oscillator(voice, env, 'sine', shape.tickHz);
  tick.frequency.setValueAtTime(shape.tickHz * 1.15, when);
  tick.frequency.exponentialRampToValueAtTime(shape.tickHz * 0.85, when + d * 0.8);
  const tickGain = gainNode(voice, env);
  pluckEnvelope(tickGain.gain, when, peak * shape.tickLevel, 0.0006, d * 0.9);
  tick.connect(tickGain);
  tickGain.connect(env.destination);
  tick.start(when);

  return voice.finish(when + d);
}

/** Return: a rising noise sweep with a faint chirp, swelling toward the catch. */
export function scheduleZip(env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS = 0): OneShotVoice {
  const d = Math.max(MIN_DURATION_S, params.durationS);
  const shape = zipShape(params.intensity);
  const peak = params.gain * VOICE_TRIM.zip;
  const voice = new VoiceNodes();

  const source = noiseSource(voice, env);
  const band = filterNode(voice, env, 'bandpass', shape.startHz, shape.q);
  band.frequency.setValueAtTime(shape.startHz, when);
  band.frequency.exponentialRampToValueAtTime(shape.endHz, when + d);
  const noiseOut = gainNode(voice, env);
  swellEnvelope(noiseOut.gain, when, peak, d);
  source.connect(band);
  band.connect(noiseOut);
  noiseOut.connect(env.destination);
  source.start(when, safeOffset(env, d, noiseOffsetS));

  const chirp = oscillator(voice, env, 'triangle', shape.chirpStartHz);
  chirp.frequency.setValueAtTime(shape.chirpStartHz, when);
  chirp.frequency.exponentialRampToValueAtTime(shape.chirpEndHz, when + d);
  const chirpOut = gainNode(voice, env);
  swellEnvelope(chirpOut.gain, when, peak * shape.chirpLevel, d);
  chirp.connect(chirpOut);
  chirpOut.connect(env.destination);
  chirp.start(when);

  return voice.finish(when + d);
}

/** Catch: a soft thud (pitch dropping, two partials) and a short click. */
export function scheduleCatch(env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS = 0): OneShotVoice {
  const d = Math.max(MIN_DURATION_S, params.durationS);
  const shape = catchShape(params.intensity);
  const peak = params.gain * VOICE_TRIM.catch;
  const voice = new VoiceNodes();
  const sweepEnd = when + Math.min(shape.thudSweepS, d * 0.8);

  const thud = oscillator(voice, env, 'sine', shape.thudStartHz);
  thud.frequency.setValueAtTime(shape.thudStartHz, when);
  thud.frequency.exponentialRampToValueAtTime(shape.thudEndHz, sweepEnd);
  const thudGain = gainNode(voice, env);
  pluckEnvelope(thudGain.gain, when, peak, 0.004, d * 0.9);
  thud.connect(thudGain);
  thudGain.connect(env.destination);
  thud.start(when);

  const body = oscillator(voice, env, 'sine', shape.thudStartHz * shape.bodyRatio);
  body.frequency.setValueAtTime(shape.thudStartHz * shape.bodyRatio, when);
  body.frequency.exponentialRampToValueAtTime(shape.thudEndHz * shape.bodyRatio, sweepEnd);
  const bodyGain = gainNode(voice, env);
  pluckEnvelope(bodyGain.gain, when, peak * shape.bodyLevel, 0.003, d * 0.5);
  body.connect(bodyGain);
  bodyGain.connect(env.destination);
  body.start(when);

  const source = noiseSource(voice, env);
  const band = filterNode(voice, env, 'bandpass', shape.clickHz, 1.1);
  const click = gainNode(voice, env);
  pluckEnvelope(click.gain, when, peak * shape.clickLevel, 0.0008, 0.02);
  source.connect(band);
  band.connect(click);
  click.connect(env.destination);
  source.start(when, safeOffset(env, d, noiseOffsetS));

  return voice.finish(when + d);
}

/** Tie-on: a soft click. */
export function scheduleTether(env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS = 0): OneShotVoice {
  const d = Math.max(MIN_DURATION_S, params.durationS);
  const shape = tetherShape(params.intensity);
  const peak = params.gain * VOICE_TRIM.tether;
  const voice = new VoiceNodes();

  const pip = oscillator(voice, env, 'sine', shape.pipHz);
  pip.frequency.setValueAtTime(shape.pipHz * 1.15, when);
  pip.frequency.exponentialRampToValueAtTime(shape.pipHz, when + shape.pipDropS);
  const pipGain = gainNode(voice, env);
  pluckEnvelope(pipGain.gain, when, peak * 0.8, 0.001, d * 0.8);
  pip.connect(pipGain);
  pipGain.connect(env.destination);
  pip.start(when);

  const source = noiseSource(voice, env);
  const highpass = filterNode(voice, env, 'highpass', shape.tickCutoffHz, 0.7);
  const tick = gainNode(voice, env);
  pluckEnvelope(tick.gain, when, peak * shape.tickLevel, 0.0006, 0.008);
  source.connect(highpass);
  highpass.connect(tick);
  tick.connect(env.destination);
  source.start(when, safeOffset(env, d, noiseOffsetS));

  return voice.finish(when + d);
}

const SCHEDULERS: Readonly<Record<OneShotKind, (env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS?: number) => OneShotVoice>> = {
  whoosh: scheduleWhoosh,
  snap: scheduleSnap,
  zip: scheduleZip,
  catch: scheduleCatch,
  tether: scheduleTether,
};

export function scheduleOneShot(kind: OneShotKind, env: VoiceEnv, params: OneShotParams, when: number, noiseOffsetS = 0): OneShotVoice {
  return SCHEDULERS[kind](env, params, when, noiseOffsetS);
}

// ---------------------------------------------------------------------------------------------
// Hum
// ---------------------------------------------------------------------------------------------

/** The continuous rolling hum. One voice for as long as the yoyo spins audibly. */
export interface HumVoice {
  /**
   * Steers the voice toward `target` from `when` on. Every change goes through setTargetAtTime, an
   * exponential approach, so nothing ever steps: no zipper noise whatever the update rate.
   * An inactive target only fades the level out and leaves the pitch where it was.
   */
  steer(target: HumCommand, when: number): void;
  /** Fades out and releases the oscillators shortly after `when`. */
  stop(when: number): void;
}

/**
 * Hum: three partials on the spin's pitch (a sine body, a slightly sharp second and a third) plus
 * a band-passed noise «bearing» texture whose amplitude is modulated at the rotation pitch, so it
 * buzzes once per turn. Brighter and louder as the spin rises. Starts silent and fades in.
 */
export function createHumVoice(env: VoiceEnv, initial: HumCommand, when: number, noiseOffsetS = 0): HumVoice {
  const t = humTargets({ ...initial, active: true });
  const voice = new VoiceNodes();

  const out = gainNode(voice, env, 0);
  out.connect(env.destination);

  const body = oscillator(voice, env, 'sine', t.fundamentalHz);
  const overtone = oscillator(voice, env, 'sine', t.overtoneHz);
  const third = oscillator(voice, env, 'sine', t.thirdHz);
  for (const [osc, weight] of [[body, HUM_BODY_WEIGHT], [overtone, HUM_OVERTONE_WEIGHT], [third, HUM_THIRD_WEIGHT]] as const) {
    const level = gainNode(voice, env, weight);
    osc.connect(level);
    level.connect(out);
  }

  // Texture: noise → band-pass → amplitude modulator → out. The modulator's gain is its own value
  // plus the body oscillator scaled by `modDepth`, so it swings between 0 and noiseLevel.
  const noise = noiseSource(voice, env, true);
  const band = filterNode(voice, env, 'bandpass', t.noiseCenterHz, HUM_NOISE_Q);
  const modulated = gainNode(voice, env, t.noiseLevel / 2);
  const modDepth = gainNode(voice, env, t.noiseLevel / 2);
  noise.connect(band);
  band.connect(modulated);
  modulated.connect(out);
  body.connect(modDepth);
  modDepth.connect(modulated.gain);

  const start = Math.max(0, when);
  body.start(start);
  overtone.start(start);
  third.start(start);
  noise.start(start, clamp(finiteOr(noiseOffsetS, 0), 0, env.noise.duration * 0.99));
  voice.watch();

  return {
    steer(target: HumCommand, at: number): void {
      const g = humTargets(target);
      if (!target.active) {
        out.gain.setTargetAtTime(0, at, HUM_FADE_S);
        return;
      }
      body.frequency.setTargetAtTime(g.fundamentalHz, at, HUM_SMOOTH_S);
      overtone.frequency.setTargetAtTime(g.overtoneHz, at, HUM_SMOOTH_S);
      third.frequency.setTargetAtTime(g.thirdHz, at, HUM_SMOOTH_S);
      band.frequency.setTargetAtTime(g.noiseCenterHz, at, HUM_SMOOTH_S);
      modulated.gain.setTargetAtTime(g.noiseLevel / 2, at, HUM_SMOOTH_S);
      modDepth.gain.setTargetAtTime(g.noiseLevel / 2, at, HUM_SMOOTH_S);
      out.gain.setTargetAtTime(g.outputGain, at, HUM_SMOOTH_S);
    },
    stop(at: number): void {
      out.gain.setTargetAtTime(0, at, HUM_FADE_S / 3);
      voice.stopSourcesAt(at + HUM_STOP_TAIL_S);
    },
  };
}
