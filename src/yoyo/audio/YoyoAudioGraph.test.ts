import { describe, expect, it } from 'vitest';
import { SILENCE } from './AudioDirector';
import { asBaseContext, asNode, FakeAudioContext, FakeBufferSource, FakeCompressor, FakeGain, FakeNode, FakeOscillator } from './fakeAudio';
import type { DirectorFrame, HumCommand, OneShotCommand } from './types';
import { HUM_IDLE_STOP_S } from './voices';
import { createMasterChain, DEFAULT_VOLUME, LIMITER, MASTER_FULL_SCALE, masterGainFor, VOLUME_TAPER, YoyoAudioGraph } from './YoyoAudioGraph';

function makeGraph(options?: ConstructorParameters<typeof YoyoAudioGraph>[2]) {
  const context = new FakeAudioContext();
  const destination = new FakeNode('destination');
  const graph = new YoyoAudioGraph(asBaseContext(context), asNode(destination), options);
  const master = context.ofKind<FakeGain>('gain')[0];
  return { context, destination, graph, master };
}

const oneShot = (kind: OneShotCommand['kind'], durationS = 0.3): OneShotCommand => ({ kind, gain: 0.3, intensity: 0.5, durationS });
const framesOf = (oneShots: OneShotCommand[], hum: HumCommand | null = null): DirectorFrame => ({ oneShots, hum });
const hum = (over: Partial<HumCommand> = {}): HumCommand => ({ active: true, frequencyHz: 180, gain: 0.15, brightness: 0.6, ...over });

describe('master gain', () => {
  it('is volume squared at the full scale, and zero when muted', () => {
    expect(VOLUME_TAPER).toBe(2);
    expect(masterGainFor(1, false)).toBeCloseTo(MASTER_FULL_SCALE, 12);
    expect(masterGainFor(0.5, false)).toBeCloseTo(MASTER_FULL_SCALE * 0.25, 12);
    expect(masterGainFor(0, false)).toBe(0);
    expect(masterGainFor(1, true)).toBe(0);
  });

  it('is monotonic in volume and bounded, and clamps garbage to the default or the ends', () => {
    let previous = -1;
    for (let v = 0; v <= 1; v += 0.01) {
      const g = masterGainFor(v, false);
      expect(g).toBeGreaterThanOrEqual(previous);
      previous = g;
    }
    expect(masterGainFor(7, false)).toBe(masterGainFor(1, false));
    expect(masterGainFor(-7, false)).toBe(0);
    expect(masterGainFor(Number.NaN, false)).toBe(masterGainFor(DEFAULT_VOLUME, false));
    expect(MASTER_FULL_SCALE).toBeLessThan(1);
  });
});

describe('master chain', () => {
  it('wires gain → limiter → destination, with the limiter configured', () => {
    const context = new FakeAudioContext();
    const destination = new FakeNode('destination');
    const chain = createMasterChain(asBaseContext(context), asNode(destination));
    const input = chain.input as unknown as FakeGain;
    const limiter = chain.limiter as unknown as FakeCompressor;
    expect(input.outputs).toEqual([limiter]);
    expect(limiter.outputs).toEqual([destination]);
    expect(limiter.threshold.value).toBe(LIMITER.threshold);
    expect(limiter.knee.value).toBe(LIMITER.knee);
    expect(limiter.ratio.value).toBe(LIMITER.ratio);
    expect(limiter.attack.value).toBe(LIMITER.attack);
    expect(limiter.release.value).toBe(LIMITER.release);
    chain.dispose();
    expect(input.disconnected && limiter.disconnected).toBe(true);
    expect(() => chain.dispose()).not.toThrow();
  });

  it('starts at the default volume', () => {
    const { master } = makeGraph();
    expect(master.gain.value).toBeCloseTo(masterGainFor(DEFAULT_VOLUME, false), 12);
  });
});

describe('setOutput', () => {
  it('mutes with a hard set to 0 right now, not a ramp', () => {
    const { graph, master } = makeGraph();
    graph.setOutput(0.7, true, 4);
    expect(master.gain.calls).toEqual([
      { method: 'cancelScheduledValues', args: [4] },
      { method: 'setValueAtTime', args: [0, 4] },
    ]);
  });

  it('eases volume changes and unmutes without a click', () => {
    const { graph, master } = makeGraph();
    graph.setOutput(0.5, false, 2);
    const call = master.gain.calls[1];
    expect(call.method).toBe('setTargetAtTime');
    expect(call.args[0]).toBeCloseTo(masterGainFor(0.5, false), 12);
    expect(call.args[1]).toBe(2);
    expect(call.args[2]).toBeGreaterThan(0);
    expect(call.args[2]).toBeLessThanOrEqual(0.05);
    graph.setOutput(0.5, true, 3);
    graph.setOutput(0.5, false, 4);
    const last = master.gain.calls[master.gain.calls.length - 1];
    expect(last.method).toBe('setTargetAtTime');
    expect(last.args[1]).toBe(4);
  });

  it('never writes the master value directly after construction', () => {
    const { graph, master } = makeGraph();
    const initial = master.gain.value;
    graph.setOutput(0.2, false, 1);
    graph.setOutput(0.2, true, 2);
    expect(master.gain.value).toBe(initial);
  });
});

describe('apply: one-shots', () => {
  it('starts one voice per command, all reaching the master chain', () => {
    const { context, graph } = makeGraph();
    graph.apply(framesOf([oneShot('whoosh'), oneShot('snap', 0.045)]), 1);
    expect(graph.voiceCount).toBe(2);
    const sources = context.nodes.filter((n) => n instanceof FakeOscillator || n instanceof FakeBufferSource);
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const source of sources) expect((source as FakeOscillator).startedAt).toBe(1);
  });

  it('forgets voices once their end time has passed', () => {
    const { graph } = makeGraph();
    graph.apply(framesOf([oneShot('whoosh', 0.3)]), 1);
    expect(graph.voiceCount).toBe(1);
    graph.apply(SILENCE, 1.29);
    expect(graph.voiceCount).toBe(1);
    graph.apply(SILENCE, 1.31);
    expect(graph.voiceCount).toBe(0);
  });

  it('keeps a backstop cap of its own', () => {
    const { graph } = makeGraph({ maxVoices: 3 });
    graph.apply(framesOf(['whoosh', 'snap', 'zip', 'catch', 'tether'].map((k) => oneShot(k as OneShotCommand['kind']))), 0);
    expect(graph.voiceCount).toBe(3);
  });

  it('is deterministic: the same frames start the noise at the same offsets', () => {
    const offsets = () => {
      const { context, graph } = makeGraph();
      graph.apply(framesOf([oneShot('whoosh'), oneShot('catch'), oneShot('zip')]), 0);
      graph.apply(framesOf([oneShot('whoosh')]), 2);
      return context.ofKind<FakeBufferSource>('buffer-source').map((s) => s.startOffset);
    };
    expect(offsets()).toEqual(offsets());
  });
});

describe('apply: hum lifecycle', () => {
  const oscillatorCount = (context: FakeAudioContext) => context.ofKind('oscillator').length;

  it('creates no hum voice for silent frames', () => {
    const { context, graph } = makeGraph();
    for (let i = 0; i < 100; i += 1) graph.apply(SILENCE, i * 0.016);
    graph.apply(framesOf([], hum({ active: false })), 2);
    expect(graph.humRunning).toBe(false);
    expect(oscillatorCount(context)).toBe(0);
  });

  it('creates the voice on the first active command and then only steers it', () => {
    const { context, graph } = makeGraph();
    graph.apply(framesOf([], hum()), 1);
    expect(graph.humRunning).toBe(true);
    expect(oscillatorCount(context)).toBe(3);
    const nodes = context.nodes.length;
    graph.apply(framesOf([], hum({ frequencyHz: 190 })), 1.033);
    graph.apply(framesOf([], hum({ frequencyHz: 200 })), 1.066);
    expect(context.nodes.length).toBe(nodes);
    const body = context.ofKind<FakeOscillator>('oscillator')[0];
    expect(body.frequency.calls.map((c) => c.args[0])).toEqual([180, 190, 200]);
    expect(body.frequency.calls.every((c) => c.method === 'setTargetAtTime')).toBe(true);
  });

  it('fades on an inactive command, releases the voice after the idle time and builds a new one on return', () => {
    const { context, graph } = makeGraph();
    graph.apply(framesOf([], hum()), 1);
    const [first] = context.ofKind<FakeOscillator>('oscillator');
    graph.apply(framesOf([], hum({ active: false, gain: 0 })), 2);
    expect(graph.humRunning).toBe(true);
    graph.apply(SILENCE, 2 + HUM_IDLE_STOP_S - 0.01);
    expect(graph.humRunning).toBe(true);
    expect(first.stoppedAt).toBeNull();
    graph.apply(SILENCE, 2 + HUM_IDLE_STOP_S);
    expect(graph.humRunning).toBe(false);
    expect(first.stoppedAt).toBeGreaterThan(2 + HUM_IDLE_STOP_S);
    graph.apply(framesOf([], hum()), 10);
    expect(graph.humRunning).toBe(true);
    expect(oscillatorCount(context)).toBe(6);
  });

  it('keeps the voice when the hum comes back before the idle time is up', () => {
    const { context, graph } = makeGraph();
    graph.apply(framesOf([], hum()), 1);
    graph.apply(framesOf([], hum({ active: false, gain: 0 })), 2);
    graph.apply(framesOf([], hum()), 2.5);
    graph.apply(SILENCE, 2 + HUM_IDLE_STOP_S + 1);
    expect(graph.humRunning).toBe(true);
    expect(oscillatorCount(context)).toBe(3);
  });
});

describe('dispose', () => {
  it('releases the voices, the hum and the master chain, and then ignores everything', () => {
    const { context, graph } = makeGraph();
    graph.apply(framesOf([oneShot('whoosh'), oneShot('catch')], hum()), 1);
    graph.dispose();
    expect(graph.voiceCount).toBe(0);
    expect(graph.humRunning).toBe(false);
    const gains = context.ofKind<FakeGain>('gain');
    expect(gains[0].disconnected).toBe(true);
    const nodes = context.nodes.length;
    graph.apply(framesOf([oneShot('whoosh')], hum()), 2);
    graph.setOutput(1, false, 2);
    expect(context.nodes.length).toBe(nodes);
    expect(() => graph.dispose()).not.toThrow();
  });

  it('survives a context that is already closed', () => {
    const { context, graph } = makeGraph();
    graph.apply(framesOf([], hum()), 1);
    for (const osc of context.ofKind<FakeOscillator>('oscillator')) {
      osc.stop = () => {
        throw new Error('InvalidStateError');
      };
    }
    expect(() => graph.dispose()).not.toThrow();
  });
});
