import { describe, expect, it } from 'vitest';
import {
  asBaseContext, asNode, FakeAudioContext, FakeBuffer, FakeBufferSource, FakeFilter, FakeGain, FakeNode, FakeOscillator, FakeParam,
  FakeSource,
} from './fakeAudio';
import { ONE_SHOT_KINDS, type HumCommand, type OneShotKind, type OneShotParams } from './types';
import {
  catchShape, createHumVoice, createNoiseBuffer, HUM_FADE_S, HUM_SMOOTH_S, humTargets, NOISE_SECONDS, scheduleOneShot,
  scheduleSnap, scheduleWhoosh, scheduleZip, snapShape, tetherShape, VOICE_TRIM, whooshShape, zipShape, type VoiceEnv,
} from './voices';

function makeEnv() {
  const context = new FakeAudioContext();
  const destination = new FakeNode('master');
  const noise = createNoiseBuffer(asBaseContext(context));
  const env: VoiceEnv = { context: asBaseContext(context), destination: asNode(destination), noise };
  return { context, destination, env };
}

/** True when `from` reaches `target` through connections. */
function reaches(from: FakeNode, target: FakeNode): boolean {
  const seen = new Set<FakeNode>();
  const queue: FakeNode[] = [from];
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of node.outputs) if (next instanceof FakeNode) queue.push(next);
  }
  return false;
}

const allSources = (context: FakeAudioContext) => context.nodes.filter((n): n is FakeSource => n instanceof FakeSource);

describe('shapes', () => {
  it('sweeps the whoosh down, and makes a harder one brighter and narrower', () => {
    for (let i = 0; i <= 1; i += 0.1) {
      const s = whooshShape(i);
      expect(s.startHz).toBeGreaterThan(s.endHz);
    }
    const soft = whooshShape(0);
    const hard = whooshShape(1);
    expect(hard.startHz).toBeGreaterThan(soft.startHz);
    expect(hard.endHz).toBeGreaterThan(soft.endHz);
    expect(hard.q).toBeGreaterThan(soft.q);
    expect(hard.attackS).toBeLessThan(soft.attackS);
  });

  it('sweeps the zip up, noise and chirp alike', () => {
    for (let i = 0; i <= 1; i += 0.1) {
      const s = zipShape(i);
      expect(s.endHz).toBeGreaterThan(s.startHz);
      expect(s.chirpEndHz).toBeGreaterThan(s.chirpStartHz);
    }
  });

  it('makes the snap, catch and tether brighter with intensity, and the catch thud fall in pitch', () => {
    expect(snapShape(1).tickHz).toBeGreaterThan(snapShape(0).tickHz);
    expect(snapShape(1).clickCutoffHz).toBeGreaterThan(snapShape(0).clickCutoffHz);
    expect(tetherShape(1).pipHz).toBeGreaterThan(tetherShape(0).pipHz);
    for (let i = 0; i <= 1; i += 0.25) expect(catchShape(i).thudEndHz).toBeLessThan(catchShape(i).thudStartHz);
  });

  it('clamps and survives garbage intensities', () => {
    for (const bad of [Number.NaN, -5, 5, Number.POSITIVE_INFINITY]) {
      for (const shape of [whooshShape, zipShape, snapShape, catchShape, tetherShape]) {
        for (const value of Object.values(shape(bad))) expect(Number.isFinite(value) && value > 0).toBe(true);
      }
    }
    expect(whooshShape(9)).toEqual(whooshShape(1));
    expect(whooshShape(-9)).toEqual(whooshShape(0));
  });

  it('lays the hum out on harmonics of the fundamental, brighter noise with brightness', () => {
    const command: HumCommand = { active: true, frequencyHz: 150, gain: 0.1, brightness: 0.5 };
    const t = humTargets(command);
    expect(t.fundamentalHz).toBe(150);
    expect(t.overtoneHz / t.fundamentalHz).toBeGreaterThan(2);
    expect(t.overtoneHz / t.fundamentalHz).toBeLessThan(2.02);
    expect(t.thirdHz).toBe(450);
    expect(t.outputGain).toBe(0.1);
    let previous = 0;
    for (let b = 0; b <= 1; b += 0.1) {
      const noise = humTargets({ ...command, brightness: b });
      expect(noise.noiseCenterHz).toBeGreaterThan(previous);
      previous = noise.noiseCenterHz;
    }
    expect(humTargets({ ...command, active: false }).outputGain).toBe(0);
  });

  it('keeps hum targets finite and inside sane ranges for garbage commands', () => {
    for (const bad of [Number.NaN, -1, 1e9, Number.POSITIVE_INFINITY]) {
      const t = humTargets({ active: true, frequencyHz: bad, gain: bad, brightness: bad });
      for (const value of Object.values(t)) expect(Number.isFinite(value)).toBe(true);
      expect(t.outputGain).toBeGreaterThanOrEqual(0);
      expect(t.outputGain).toBeLessThanOrEqual(1);
      expect(t.fundamentalHz).toBeGreaterThanOrEqual(20);
      expect(t.thirdHz).toBeLessThanOrEqual(2000);
    }
  });
});

describe('createNoiseBuffer', () => {
  it('fills the buffer with zero-mean noise inside [-1, 1)', () => {
    const { env } = makeEnv();
    const data = (env.noise as unknown as FakeBuffer).data;
    expect(data.length).toBe(Math.round(48000 * NOISE_SECONDS));
    let sum = 0;
    let min = 1;
    let max = -1;
    for (const x of data) {
      sum += x;
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThan(1);
    expect(max - min).toBeGreaterThan(1.9);
    expect(Math.abs(sum / data.length)).toBeLessThan(0.01);
  });

  it('is identical on every run (a fixed seed, never Math.random)', () => {
    const a = (makeEnv().env.noise as unknown as FakeBuffer).data;
    const b = (makeEnv().env.noise as unknown as FakeBuffer).data;
    expect(Array.from(a.subarray(0, 4096))).toEqual(Array.from(b.subarray(0, 4096)));
    expect(a[0]).not.toBe(a[1]);
  });
});

describe.each(ONE_SHOT_KINDS)('one-shot %s', (kind: OneShotKind) => {
  const WHEN = 2.5;
  const EXPONENTIAL_FLOOR = 1.0000001e-6;
  const cases: OneShotParams[] = [
    { gain: 0.1, intensity: 0, durationS: 0.2 },
    { gain: 0.3, intensity: 0.5, durationS: 0.36 },
    { gain: 0.46, intensity: 1, durationS: 0.8 },
    { gain: 0.0001, intensity: 0.3, durationS: 0.05 },
    { gain: 0, intensity: 0.3, durationS: 0.05 },
  ];

  it.each(cases)('builds a valid, bounded, audible-path graph for %j', (params) => {
    const { context, destination, env } = makeEnv();
    const voice = scheduleOneShot(kind, env, params, WHEN, 0.4);
    const end = WHEN + params.durationS;
    expect(voice.endTime).toBeCloseTo(end, 12);

    const sources = allSources(context);
    expect(sources.length).toBeGreaterThanOrEqual(1);
    for (const source of sources) {
      expect(source.startedAt).toBe(WHEN);
      expect(source.stoppedAt).toBeCloseTo(end, 12);
      expect(reaches(source, destination), `${source.kind} reaches the master`).toBe(true);
    }

    // A voice's own trim is part of its level: it is what makes `gain` mean the voice's peak.
    const ceiling = params.gain * VOICE_TRIM[kind];
    for (const gain of context.ofKind<FakeGain>('gain')) {
      // Static level is 0 (or a fixed weight) and every automated value is within [0, ceiling].
      expect(gain.gain.value).toBeLessThanOrEqual(ceiling + 1e-12);
      expect(gain.gain.calls.length).toBeGreaterThan(0);
      for (const call of gain.gain.calls) {
        expect(call.args[0]).toBeGreaterThanOrEqual(0);
        // Exponential ramps need a positive target, so a gain of 0 still ramps to a −120 dB floor.
        expect(call.args[0]).toBeLessThanOrEqual(ceiling * 1.0001 + EXPONENTIAL_FLOOR);
        expect(call.args[1]).toBeGreaterThanOrEqual(WHEN);
        expect(call.args[1]).toBeLessThanOrEqual(end + 1e-9);
      }
      // Every envelope closes at silence.
      const last = gain.gain.calls[gain.gain.calls.length - 1];
      expect(last.method).toBe('setValueAtTime');
      expect(last.args[0]).toBe(0);
    }

    for (const node of [...context.ofKind<FakeFilter>('biquad'), ...context.ofKind<FakeOscillator>('oscillator')]) {
      const param = node instanceof FakeFilter ? node.frequency : (node as FakeOscillator).frequency;
      expect(param.value).toBeGreaterThan(0);
      for (const call of param.calls) {
        expect(call.args[0]).toBeGreaterThan(0);
        expect(call.args[1]).toBeGreaterThanOrEqual(WHEN);
        expect(call.args[1]).toBeLessThanOrEqual(end + 1e-9);
      }
    }
  });

  it('keeps its slice of the noise buffer inside the buffer', () => {
    const { context, env } = makeEnv();
    scheduleOneShot(kind, env, { gain: 0.3, intensity: 0.5, durationS: 0.8 }, 0, 99);
    for (const source of context.ofKind<FakeBufferSource>('buffer-source')) {
      expect(source.startOffset! + 0.8).toBeLessThanOrEqual(env.noise.duration);
      expect(source.loop).toBe(false);
    }
    const { context: c2, env: e2 } = makeEnv();
    scheduleOneShot(kind, e2, { gain: 0.3, intensity: 0.5, durationS: 0.8 }, 0, Number.NaN);
    for (const source of c2.ofKind<FakeBufferSource>('buffer-source')) expect(source.startOffset).toBe(0);
  });

  it('releases every node once its last source has ended, exactly once', () => {
    const { context, env } = makeEnv();
    const voice = scheduleOneShot(kind, env, { gain: 0.3, intensity: 0.5, durationS: 0.3 }, 0, 0);
    let ended = 0;
    voice.onEnded = () => {
      ended += 1;
    };
    const sources = allSources(context);
    sources.slice(0, -1).forEach((s) => s.end());
    expect(ended).toBe(0);
    expect(context.nodes.every((n) => !n.disconnected)).toBe(true);
    sources[sources.length - 1].end();
    expect(ended).toBe(1);
    expect(context.nodes.every((n) => n.disconnected)).toBe(true);
    sources[0].end();
    expect(ended).toBe(1);
  });

  it('can be cut short: stop() disconnects at once and is idempotent', () => {
    const { context, env } = makeEnv();
    const voice = scheduleOneShot(kind, env, { gain: 0.3, intensity: 0.5, durationS: 0.3 }, 0, 0);
    let ended = 0;
    voice.onEnded = () => {
      ended += 1;
    };
    voice.stop();
    voice.stop();
    expect(context.nodes.every((n) => n.disconnected)).toBe(true);
    expect(ended).toBe(1);
    allSources(context).forEach((s) => s.end());
    expect(ended).toBe(1);
  });

  it('still builds for a degenerate duration instead of throwing a RangeError into the render loop', () => {
    const { env } = makeEnv();
    for (const durationS of [0, -1, 1e-6]) {
      expect(() => scheduleOneShot(kind, env, { gain: 0.3, intensity: 0.5, durationS }, 0, 0)).not.toThrow();
    }
  });
});

describe('voice character', () => {
  it('whoosh: one band-pass noise path sweeping from the shape start to its end, over the duration', () => {
    const { context, env } = makeEnv();
    const params: OneShotParams = { gain: 0.3, intensity: 0.8, durationS: 0.3 };
    scheduleWhoosh(env, params, 1, 0);
    const [filter] = context.ofKind<FakeFilter>('biquad');
    const shape = whooshShape(0.8);
    expect(filter.type).toBe('bandpass');
    expect(filter.Q.value).toBeCloseTo(shape.q, 12);
    expect(filter.frequency.calls[0]).toEqual({ method: 'setValueAtTime', args: [shape.startHz, 1] });
    expect(filter.frequency.calls[1].method).toBe('exponentialRampToValueAtTime');
    expect(filter.frequency.calls[1].args[0]).toBeCloseTo(shape.endHz, 9);
    expect(filter.frequency.calls[1].args[1]).toBeCloseTo(1.3, 12);
    expect(context.ofKind('oscillator')).toHaveLength(0);
  });

  it('zip: band-pass noise and a chirp, both rising', () => {
    const { context, env } = makeEnv();
    scheduleZip(env, { gain: 0.2, intensity: 0.5, durationS: 0.45 }, 0, 0);
    const [filter] = context.ofKind<FakeFilter>('biquad');
    const [chirp] = context.ofKind<FakeOscillator>('oscillator');
    expect(filter.frequency.calls[1].args[0]).toBeGreaterThan(filter.frequency.calls[0].args[0]);
    expect(chirp.frequency.calls[1].args[0]).toBeGreaterThan(chirp.frequency.calls[0].args[0]);
  });

  it('snap: short enough to be a tick', () => {
    const { env } = makeEnv();
    const voice = scheduleSnap(env, { gain: 0.2, intensity: 1, durationS: 0.045 }, 0, 0);
    expect(voice.endTime).toBeLessThanOrEqual(0.05);
  });

  it('catch: a falling thud on two partials plus a click', () => {
    const { context, env } = makeEnv();
    scheduleOneShot('catch', env, { gain: 0.4, intensity: 0.7, durationS: 0.28 }, 0, 0);
    const oscillators = context.ofKind<FakeOscillator>('oscillator');
    expect(oscillators).toHaveLength(2);
    for (const osc of oscillators) {
      expect(osc.frequency.calls[1].method).toBe('exponentialRampToValueAtTime');
      expect(osc.frequency.calls[1].args[0]).toBeLessThan(osc.frequency.calls[0].args[0]);
    }
    expect(context.ofKind('buffer-source')).toHaveLength(1);
  });
});

describe('hum voice', () => {
  const initial: HumCommand = { active: true, frequencyHz: 180, gain: 0.15, brightness: 0.6 };
  const WHEN = 3;

  function setup() {
    const rig = makeEnv();
    const hum = createHumVoice(rig.env, initial, WHEN, 0.7);
    const oscillators = rig.context.ofKind<FakeOscillator>('oscillator');
    const [noise] = rig.context.ofKind<FakeBufferSource>('buffer-source');
    const filters = rig.context.ofKind<FakeFilter>('biquad');
    const gains = rig.context.ofKind<FakeGain>('gain');
    return { ...rig, hum, oscillators, noise, filter: filters[0], gains, out: gains[0] };
  }

  it('builds three sine partials on 1x, 2x and 3x of the pitch and a looping noise texture, all started together', () => {
    const { oscillators, noise, filter, destination, out } = setup();
    const t = humTargets(initial);
    expect(oscillators).toHaveLength(3);
    expect(oscillators.map((o) => o.type)).toEqual(['sine', 'sine', 'sine']);
    expect(oscillators.map((o) => o.frequency.value)).toEqual([t.fundamentalHz, t.overtoneHz, t.thirdHz]);
    expect(noise.loop).toBe(true);
    expect(noise.startOffset).toBeCloseTo(0.7, 12);
    expect(filter.type).toBe('bandpass');
    for (const source of [...oscillators, noise]) expect(source.startedAt).toBe(WHEN);
    expect(out.outputs).toContain(destination);
  });

  it('starts silent: the fade-in is the first steer, never a jump', () => {
    const { out } = setup();
    expect(out.gain.value).toBe(0);
    expect(out.gain.calls).toHaveLength(0);
  });

  it('modulates the texture at the rotation pitch: body oscillator → depth gain → texture gain param', () => {
    const { oscillators, gains, filter, out } = setup();
    const depth = gains.filter((g) => g.outputs.some((o) => o instanceof FakeParam));
    expect(depth).toHaveLength(1);
    const modulatedParam = depth[0].outputs.find((o): o is FakeParam => o instanceof FakeParam)!;
    const texture = gains.find((g) => g.gain === modulatedParam)!;
    // noise → band-pass → texture gain → output, with the body oscillator driving its gain.
    expect(filter.outputs).toContain(texture);
    expect(texture.outputs).toContain(out);
    expect(oscillators[0].outputs).toContain(depth[0]);
    // Base level and swing are equal, so the texture's gain goes between 0 and its level, never negative.
    expect(depth[0].gain.value).toBeCloseTo(texture.gain.value, 12);
  });

  it('steers pitch, texture and level only with setTargetAtTime: no step can click', () => {
    const { hum, oscillators, filter, gains, out } = setup();
    const params = [...oscillators.map((o) => o.frequency), filter.frequency, ...gains.map((g) => g.gain)];
    const before = params.map((p) => p.value);
    hum.steer({ active: true, frequencyHz: 200, gain: 0.18, brightness: 0.9 }, WHEN + 1);
    hum.steer({ active: true, frequencyHz: 205, gain: 0.17, brightness: 0.88 }, WHEN + 1.033);
    expect(params.map((p) => p.value)).toEqual(before);
    const t = humTargets({ active: true, frequencyHz: 200, gain: 0.18, brightness: 0.9 });
    for (const [osc, target] of [[oscillators[0], t.fundamentalHz], [oscillators[1], t.overtoneHz], [oscillators[2], t.thirdHz]] as const) {
      expect(osc.frequency.calls.map((c) => c.method)).toEqual(['setTargetAtTime', 'setTargetAtTime']);
      expect(osc.frequency.calls[0].args).toEqual([target, WHEN + 1, HUM_SMOOTH_S]);
    }
    expect(filter.frequency.calls[0].args).toEqual([t.noiseCenterHz, WHEN + 1, HUM_SMOOTH_S]);
    expect(out.gain.calls[0].args).toEqual([0.18, WHEN + 1, HUM_SMOOTH_S]);
    for (const p of params) for (const call of p.calls) expect(call.method).toBe('setTargetAtTime');
  });

  it('fades only the level on an inactive command and leaves the pitch where it was', () => {
    const { hum, oscillators, filter, out } = setup();
    hum.steer({ active: false, frequencyHz: 180, gain: 0, brightness: 0.6 }, WHEN + 2);
    expect(out.gain.calls).toEqual([{ method: 'setTargetAtTime', args: [0, WHEN + 2, HUM_FADE_S] }]);
    for (const p of [...oscillators.map((o) => o.frequency), filter.frequency]) expect(p.calls).toHaveLength(0);
  });

  it('stops after a fade and releases its nodes when the oscillators end', () => {
    const { hum, context, oscillators, noise, out } = setup();
    hum.stop(WHEN + 5);
    expect(out.gain.calls[0].method).toBe('setTargetAtTime');
    expect(out.gain.calls[0].args[0]).toBe(0);
    for (const source of [...oscillators, noise]) {
      expect(source.stoppedAt).toBeGreaterThan(WHEN + 5);
      expect(source.stoppedAt).toBeLessThan(WHEN + 6);
    }
    expect(context.nodes.every((n) => !n.disconnected)).toBe(true);
    [...oscillators, noise].forEach((s) => s.end());
    expect(context.nodes.every((n) => n.disconnected)).toBe(true);
  });

  it('survives a stray NaN or Infinity in the command without throwing into the render loop', () => {
    const { hum } = setup();
    expect(() => hum.steer({ active: true, frequencyHz: Number.NaN, gain: Number.POSITIVE_INFINITY, brightness: Number.NaN }, WHEN + 1)).not.toThrow();
  });
});
