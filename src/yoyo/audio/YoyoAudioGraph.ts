import { MAX_ONE_SHOT_VOICES } from './AudioDirector';
import { clamp, finiteOr, Xorshift32 } from './math';
import type { DirectorFrame, HumCommand, OneShotCommand } from './types';
import {
  createHumVoice, createNoiseBuffer, HUM_IDLE_STOP_S, scheduleOneShot,
  type HumVoice, type OneShotVoice, type VoiceEnv,
} from './voices';

/**
 * Level at the master gain for volume 1, linear. The limiter after it adds +3.4 dB of make-up gain
 * to everything under its threshold (measured in Chrome; the QA prints it as «Master chain»), so
 * 0.7 × 1.47 is about unity: at volume 1 the voices play at the levels the director asks for, and the
 * loudest of them (a catch or a hard whoosh, peak 0.5) lands around −6 dBFS.
 */
export const MASTER_FULL_SCALE = 0.7;

/**
 * The volume control is quadratic in amplitude: 50 % is −12 dB, 25 % is −24 dB. A linear amplitude
 * control spends nearly all of its audible range in the bottom tenth of the slider; this one is
 * close to even in dB, which is how loudness is heard.
 */
export const VOLUME_TAPER = 2;

/**
 * Volume used until the page sets one. «Moderate» (PRD §1.3): at 0.8 the master is −4 dB, so the
 * loudest sounds peak around −10 dBFS and the hum at its full level reads about −24 dBFS rms
 * (QA, scripted throw: peak −9.4 dBFS, rms −27.8 dBFS).
 */
export const DEFAULT_VOLUME = 0.8;

/** Time constants of master-gain moves, s. Mute itself is never smoothed: it must be immediate. */
const VOLUME_SMOOTH_S = 0.02;

/**
 * Limiter. The sounds are mixed well under it; it is the net for overlaps (a catch thud, a snap and a
 * hum at once) so nothing reaches the clipping point of the destination. A DynamicsCompressorNode
 * has no hard ceiling and adds make-up gain of its own, so the QA measures its real behaviour
 * instead of trusting these numbers: a +12 dBFS sine comes out at 0.92, and ten of the loudest
 * one-shots plus the hum at volume 1 peak at 0.96.
 */
export const LIMITER = { threshold: -10, knee: 10, ratio: 12, attack: 0.003, release: 0.15 } as const;

/** Master gain (linear) for a volume and mute state. */
export function masterGainFor(volume: number, muted: boolean): number {
  if (muted) return 0;
  return MASTER_FULL_SCALE * Math.pow(clamp(finiteOr(volume, DEFAULT_VOLUME), 0, 1), VOLUME_TAPER);
}

export interface MasterChain {
  /** Voices connect here: the gain node that carries volume × mute. */
  readonly input: GainNode;
  readonly limiter: DynamicsCompressorNode;
  dispose(): void;
}

/** Master gain (volume × mute) → limiter → destination. */
export function createMasterChain(context: BaseAudioContext, destination: AudioNode): MasterChain {
  const input = context.createGain();
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  input.connect(limiter);
  limiter.connect(destination);
  return {
    input,
    limiter,
    dispose(): void {
      for (const node of [input, limiter]) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected.
        }
      }
    },
  };
}

export interface YoyoAudioGraphOptions {
  /**
   * Backstop cap on simultaneous one-shots. The director already caps by the voices' nominal
   * lengths; this one counts what was actually scheduled, in case a caller feeds frames the
   * director did not produce.
   */
  maxVoices?: number;
}

/** Seconds of noise left unused at the end of the buffer when picking a start offset. */
const NOISE_OFFSET_MARGIN_S = 0.02;

/**
 * The impure half of the audio, still free of any real clock: master chain, noise, the live
 * one-shots and the hum voice, all driven by `apply(frame, when)`. The live wrapper calls it with
 * `context.currentTime`; the offline QA calls it with the scripted time, so what is measured is the
 * code that runs in the page.
 */
export class YoyoAudioGraph {
  private readonly chain: MasterChain;
  private readonly env: VoiceEnv;
  private readonly maxVoices: number;
  /** Start offsets into the noise buffer, from a fixed seed so renders repeat. */
  private readonly offsets = new Xorshift32(0x1f123bb5);
  private voices: OneShotVoice[] = [];
  private hum: HumVoice | null = null;
  private humSilentSince: number | null = null;
  private disposed = false;

  constructor(readonly context: BaseAudioContext, destination: AudioNode, options: YoyoAudioGraphOptions = {}) {
    this.chain = createMasterChain(context, destination);
    this.env = { context, destination: this.chain.input, noise: createNoiseBuffer(context) };
    this.maxVoices = Math.max(1, Math.floor(finiteOr(options.maxVoices, MAX_ONE_SHOT_VOICES)));
    this.chain.input.gain.value = masterGainFor(DEFAULT_VOLUME, false);
  }

  /** One-shots that have not reached their end yet, as of the last `apply`. */
  get voiceCount(): number {
    return this.voices.length;
  }

  get humRunning(): boolean {
    return this.hum !== null;
  }

  /**
   * Volume and mute onto the master gain. Mute is a hard set to 0 (silence within one render
   * quantum, ~3 ms); everything else eases in, so dragging a slider or unmuting never clicks.
   */
  setOutput(volume: number, muted: boolean, when: number = this.context.currentTime): void {
    if (this.disposed) return;
    const param = this.chain.input.gain;
    param.cancelScheduledValues(when);
    if (muted) param.setValueAtTime(0, when);
    else param.setTargetAtTime(masterGainFor(volume, false), when, VOLUME_SMOOTH_S);
  }

  /** Starts the frame's one-shots and steers the hum, all at `when` (context time, s). */
  apply(frame: DirectorFrame, when: number): void {
    if (this.disposed) return;
    this.pruneVoices(when);
    for (const command of frame.oneShots) this.startOneShot(command, when);
    if (frame.hum !== null) this.steerHum(frame.hum, when);
    this.retireIdleHum(when);
  }

  /** Releases everything. The graph is dead afterwards; further calls do nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices) voice.stop();
    this.voices = [];
    if (this.hum !== null) {
      try {
        this.hum.stop(this.context.currentTime);
      } catch {
        // The context may already be closed; closing it releases the nodes anyway.
      }
      this.hum = null;
    }
    this.chain.dispose();
  }

  private startOneShot(command: OneShotCommand, when: number): void {
    if (this.voices.length >= this.maxVoices) return;
    const room = Math.max(0, this.env.noise.duration - command.durationS - NOISE_OFFSET_MARGIN_S);
    this.voices.push(scheduleOneShot(command.kind, this.env, command, when, this.offsets.next() * room));
  }

  private steerHum(target: HumCommand, when: number): void {
    if (target.active) {
      this.hum ??= createHumVoice(this.env, target, when, this.offsets.next() * this.env.noise.duration);
      this.hum.steer(target, when);
      this.humSilentSince = null;
    } else if (this.hum !== null) {
      this.hum.steer(target, when);
      this.humSilentSince ??= when;
    }
  }

  /** A hum that stayed silent for HUM_IDLE_STOP_S is released: no oscillators running for nobody. */
  private retireIdleHum(when: number): void {
    if (this.hum === null || this.humSilentSince === null || when - this.humSilentSince < HUM_IDLE_STOP_S) return;
    this.hum.stop(when);
    this.hum = null;
    this.humSilentSince = null;
  }

  private pruneVoices(when: number): void {
    let kept = 0;
    for (const voice of this.voices) {
      if (voice.endTime > when) this.voices[kept++] = voice;
    }
    this.voices.length = kept;
  }
}
