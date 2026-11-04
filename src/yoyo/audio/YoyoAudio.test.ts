import { describe, expect, it } from 'vitest';
import type { YoyoEvent, YoyoSnapshot } from '../contracts';
import { asAudioContext, FakeAudioContext, FakeBufferSource, FakeCompressor, FakeGain, FakeOscillator } from './fakeAudio';
import { buildSnapshot } from './snapshots';
import { masterGainFor } from './YoyoAudioGraph';
import { YoyoAudio, type YoyoAudioOptions } from './YoyoAudio';

/** A rig that records every context the audio creates and every failure it reports. */
function makeAudio(configure?: (context: FakeAudioContext) => void, options: Partial<YoyoAudioOptions> = {}) {
  const contexts: FakeAudioContext[] = [];
  const failures: unknown[] = [];
  const audio = new YoyoAudio({
    createContext: () => {
      const context = new FakeAudioContext();
      configure?.(context);
      contexts.push(context);
      return asAudioContext(context);
    },
    onFailure: (error) => failures.push(error),
    ...options,
  });
  return { audio, contexts, failures, context: () => contexts[0] };
}

const launch = (t: number, spin = 600, events: YoyoEvent[] = [{ kind: 'launch', timeMs: t, strength: 2.4 }]): YoyoSnapshot =>
  buildSnapshot({ timeMs: t, phase: 'rolling', spin, events });

const master = (context: FakeAudioContext) => context.ofKind<FakeGain>('gain')[0];
const sourceCount = (context: FakeAudioContext) => context.ofKind('oscillator').length + context.ofKind('buffer-source').length;

describe('before unlock', () => {
  it('is locked and silent: nothing is created, whatever the page does', () => {
    const { audio, contexts } = makeAudio();
    expect(audio.status).toBe('locked');
    audio.update(launch(0), 0);
    audio.setMuted(false);
    audio.setVolume(0.5);
    audio.suspend();
    audio.resume();
    audio.update(launch(100), 100);
    expect(contexts).toHaveLength(0);
    expect(audio.status).toBe('locked');
    expect(audio.stats.played.whoosh).toBe(0);
  });

  it('does not play what happened before the unlock when it finally comes', () => {
    const { audio, context } = makeAudio();
    audio.update(launch(0), 0);
    audio.unlock();
    audio.update(buildSnapshot({ timeMs: 50, phase: 'sleeping', spin: 0 }), 50);
    expect(audio.stats.played.whoosh).toBe(0);
    expect(sourceCount(context())).toBe(0);
  });
});

describe('unlock', () => {
  it('creates one running context with the master chain, and stays ready', () => {
    const { audio, contexts } = makeAudio();
    audio.unlock();
    expect(contexts).toHaveLength(1);
    expect(audio.status).toBe('ready');
    const [context] = contexts;
    expect(context.ofKind<FakeGain>('gain')).toHaveLength(1);
    expect(context.ofKind<FakeCompressor>('compressor')).toHaveLength(1);
    expect(context.ofKind<FakeGain>('gain')[0].outputs).toContain(context.ofKind('compressor')[0]);
    expect(context.ofKind('compressor')[0].outputs).toContain(context.destination);
  });

  it('is idempotent: later gestures reuse the context', () => {
    const { audio, contexts } = makeAudio();
    audio.unlock();
    audio.unlock();
    audio.unlock();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resumeCalls).toBe(0);
  });

  it('resumes a context that starts suspended', () => {
    const { audio, context } = makeAudio((c) => {
      c.state = 'suspended';
    });
    audio.unlock();
    expect(context().resumeCalls).toBe(1);
    expect(context().state).toBe('running');
  });

  it('stays silent while the browser refuses to start the context, and plays once a later gesture succeeds', () => {
    const { audio, context } = makeAudio((c) => {
      c.state = 'suspended';
      c.allowResume = false;
    });
    audio.unlock();
    audio.update(launch(0), 0);
    audio.update(launch(100, 600, []), 100);
    expect(context().state).toBe('suspended');
    expect(sourceCount(context())).toBe(0);
    expect(audio.stats.played.whoosh).toBe(0);
    context().allowResume = true;
    audio.unlock();
    audio.update(launch(400), 400);
    expect(sourceCount(context())).toBeGreaterThan(0);
    expect(audio.stats.played.whoosh).toBe(1);
  });

  it('swallows a refused resume() instead of leaving an unhandled rejection', async () => {
    const { audio, context } = makeAudio((c) => {
      c.state = 'suspended';
      c.resume = () => Promise.reject(new Error('NotAllowedError'));
    });
    expect(() => audio.unlock()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context().state).toBe('suspended');
  });
});

describe('playing', () => {
  it('plays the launch whoosh and starts the hum from the same snapshot', () => {
    const { audio, context } = makeAudio();
    audio.unlock();
    audio.update(launch(0), 0);
    const c = context();
    expect(audio.stats.played.whoosh).toBe(1);
    expect(c.ofKind('oscillator')).toHaveLength(3);
    expect(c.ofKind<FakeBufferSource>('buffer-source').some((s) => !s.loop)).toBe(true);
    expect(c.ofKind<FakeBufferSource>('buffer-source').some((s) => s.loop)).toBe(true);
  });

  it('runs a whole throw: tether, launch, snap, tug, catch, retether', () => {
    const { audio } = makeAudio();
    audio.unlock();
    const steps: Array<[number, YoyoSnapshot]> = [
      [0, buildSnapshot({ timeMs: 0, phase: 'tethered', events: [{ kind: 'tether', timeMs: 0 }] })],
      [600, launch(600)],
      [1000, buildSnapshot({ timeMs: 1000, phase: 'sleeping', spin: 700, events: [{ kind: 'snap', timeMs: 1000, strength: 1.9 }] })],
      [3000, buildSnapshot({ timeMs: 3000, phase: 'returning', spin: 600, events: [{ kind: 'tug', timeMs: 3000, strength: 1.6 }] })],
      [3500, buildSnapshot({ timeMs: 3500, phase: 'caught', spin: 100, events: [{ kind: 'catch', timeMs: 3500, strength: 1.4 }] })],
      [3800, buildSnapshot({ timeMs: 3800, phase: 'tethered', events: [{ kind: 'retether', timeMs: 3800 }] })],
    ];
    for (const [t, snapshot] of steps) audio.update(snapshot, t);
    expect(audio.stats.played).toEqual({ whoosh: 1, snap: 1, zip: 1, catch: 1, tether: 2 });
    expect(audio.stats.rateLimited).toBe(0);
    expect(audio.stats.capped).toBe(0);
  });

  it('never schedules more than four one-shots at once', () => {
    const { audio } = makeAudio();
    audio.unlock();
    const events: YoyoEvent[] = [
      { kind: 'launch', timeMs: 0, strength: 3 }, { kind: 'snap', timeMs: 0, strength: 2 }, { kind: 'tug', timeMs: 0, strength: 2 },
      { kind: 'catch', timeMs: 0, strength: 2 }, { kind: 'tether', timeMs: 0 },
    ];
    audio.update(buildSnapshot({ timeMs: 0, events }), 0);
    expect(Object.values(audio.stats.played).reduce((a, b) => a + b, 0)).toBe(4);
    expect(audio.stats.capped).toBe(1);
  });
});

describe('mute and volume', () => {
  it('mutes immediately with a hard set and plays nothing while muted', () => {
    const { audio, context } = makeAudio();
    audio.unlock();
    audio.setMuted(true);
    const calls = master(context()).gain.calls;
    expect(calls[calls.length - 1].method).toBe('setValueAtTime');
    expect(calls[calls.length - 1].args[0]).toBe(0);
    const before = sourceCount(context());
    audio.update(launch(0), 0);
    expect(sourceCount(context())).toBe(before);
    expect(audio.stats.played.whoosh).toBe(0);
  });

  it('winds the hum down when muted mid-sleeper and brings it back on unmute', () => {
    const { audio, context } = makeAudio();
    audio.unlock();
    audio.update(buildSnapshot({ timeMs: 0, phase: 'sleeping', spin: 600 }), 0);
    expect(context().ofKind('oscillator')).toHaveLength(3);
    const body = context().ofKind<FakeOscillator>('oscillator')[0];
    const hum = context().ofKind<FakeGain>('gain')[1];
    audio.setMuted(true);
    audio.update(buildSnapshot({ timeMs: 100, phase: 'sleeping', spin: 590 }), 100);
    expect(hum.gain.calls[hum.gain.calls.length - 1].args[0]).toBe(0);
    audio.setMuted(false);
    audio.update(buildSnapshot({ timeMs: 700, phase: 'sleeping', spin: 560 }), 700);
    expect(hum.gain.calls[hum.gain.calls.length - 1].args[0]).toBeGreaterThan(0);
    expect(body.stoppedAt).toBeNull();
  });

  it('applies a volume set before unlock when the context is created', () => {
    const { audio, context } = makeAudio();
    audio.setVolume(0.4);
    audio.unlock();
    const last = master(context()).gain.calls.filter((c) => c.method === 'setTargetAtTime').pop()!;
    expect(last.args[0]).toBeCloseTo(masterGainFor(0.4, false), 12);
  });

  it('applies a mute set before unlock when the context is created', () => {
    const { audio, context } = makeAudio();
    audio.setMuted(true);
    audio.unlock();
    const calls = master(context()).gain.calls;
    expect(calls[calls.length - 1]).toEqual({ method: 'setValueAtTime', args: [0, 0] });
  });

  it('clamps the volume and ignores values that are not numbers', () => {
    const { audio, context } = makeAudio();
    audio.unlock();
    audio.setVolume(5);
    const target = () => master(context()).gain.calls.filter((c) => c.method === 'setTargetAtTime').pop()!.args[0];
    expect(target()).toBeCloseTo(masterGainFor(1, false), 12);
    audio.setVolume(-5);
    expect(target()).toBe(0);
    audio.setVolume(0.3);
    audio.setVolume(Number.NaN);
    expect(target()).toBeCloseTo(masterGainFor(0.3, false), 12);
  });
});

describe('suspend, resume and close', () => {
  it('suspends the context, plays nothing while suspended and carries on after resume', () => {
    const { audio, context } = makeAudio();
    audio.unlock();
    audio.suspend();
    expect(context().suspendCalls).toBe(1);
    expect(audio.status).toBe('suspended');
    audio.update(launch(0), 0);
    expect(sourceCount(context())).toBe(0);
    audio.resume();
    expect(context().resumeCalls).toBe(1);
    expect(audio.status).toBe('ready');
    audio.update(launch(500), 500);
    expect(audio.stats.played.whoosh).toBe(1);
  });

  it('is terminal on close: releases the context once, then ignores every call', () => {
    const { audio, contexts, failures } = makeAudio();
    audio.unlock();
    audio.update(launch(0), 0);
    audio.close();
    expect(audio.status).toBe('closed');
    expect(contexts[0].closeCalls).toBe(1);
    expect(contexts[0].ofKind<FakeGain>('gain')[0].disconnected).toBe(true);
    expect(() => {
      audio.close();
      audio.update(launch(1000), 1000);
      audio.unlock();
      audio.setMuted(true);
      audio.setVolume(0.2);
      audio.suspend();
      audio.resume();
    }).not.toThrow();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].closeCalls).toBe(1);
    expect(audio.status).toBe('closed');
    expect(failures).toHaveLength(0);
  });

  it('closes cleanly even when never unlocked', () => {
    const { audio, contexts } = makeAudio();
    expect(() => audio.close()).not.toThrow();
    expect(audio.status).toBe('closed');
    expect(contexts).toHaveLength(0);
  });

  it('recovers when the browser closes the context under it: no throw, locked again until the next gesture', () => {
    const { audio, contexts } = makeAudio();
    audio.unlock();
    contexts[0].state = 'closed';
    expect(() => audio.update(launch(0), 0)).not.toThrow();
    expect(audio.status).toBe('locked');
    audio.unlock();
    expect(contexts).toHaveLength(2);
    expect(audio.status).toBe('ready');
  });
});

describe('failures never reach the render loop', () => {
  it('survives a broken context: updates never throw, and audio gives up after repeated failures', () => {
    const { audio, context, failures } = makeAudio();
    audio.unlock();
    context().throwOn.add('createOscillator');
    for (let i = 0; i < 30; i += 1) {
      const t = i * 16.7;
      expect(() => audio.update(buildSnapshot({ timeMs: t, phase: 'sleeping', spin: 600 }), t)).not.toThrow();
    }
    expect(audio.status).toBe('failed');
    expect(failures).toHaveLength(1);
    expect(context().closeCalls).toBe(1);
    const created = context().nodes.length;
    audio.update(launch(5000), 5000);
    audio.unlock();
    expect(context().nodes.length).toBe(created);
  });

  it('forgives an isolated failure', () => {
    const { audio, context, failures } = makeAudio();
    audio.unlock();
    context().throwOn.add('createOscillator');
    audio.update(buildSnapshot({ timeMs: 0, phase: 'sleeping', spin: 600 }), 0);
    context().throwOn.clear();
    for (let i = 1; i < 120; i += 1) {
      const t = i * 16.7;
      audio.update(buildSnapshot({ timeMs: t, phase: 'sleeping', spin: 600 }), t);
    }
    expect(audio.status).toBe('ready');
    expect(failures).toHaveLength(0);
    expect(context().ofKind('oscillator')).toHaveLength(3);
  });

  it('forgives failures that are far apart in time', () => {
    const { audio, context, failures } = makeAudio();
    audio.unlock();
    for (let i = 0; i < 6; i += 1) {
      context().throwOn.add('createBufferSource');
      audio.update(launch(i * 10000), i * 10000);
      context().throwOn.clear();
      audio.update(buildSnapshot({ timeMs: i * 10000 + 5000, phase: 'untethered' }), i * 10000 + 5000);
    }
    expect(audio.status).toBe('ready');
    expect(failures).toHaveLength(0);
  });

  it('stays locked and silent when the context cannot be created, reports once and retries on the next gesture', () => {
    let attempts = 0;
    const failures: unknown[] = [];
    const audio = new YoyoAudio({
      createContext: () => {
        attempts += 1;
        throw new Error('NotSupportedError');
      },
      onFailure: (error) => failures.push(error),
    });
    expect(() => audio.unlock()).not.toThrow();
    expect(audio.status).toBe('locked');
    expect(() => audio.update(launch(0), 0)).not.toThrow();
    audio.unlock();
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(1);
  });

  it('does not leak a context whose graph could not be built', () => {
    const { audio, contexts, failures } = makeAudio((c) => c.throwOn.add('createDynamicsCompressor'));
    expect(() => audio.unlock()).not.toThrow();
    expect(audio.status).toBe('locked');
    expect(contexts[0].closeCalls).toBe(1);
    expect(failures).toHaveLength(1);
  });

  it('degrades to silent if the master gain cannot be set, instead of throwing from setMuted', () => {
    const { audio, context, failures } = makeAudio();
    audio.unlock();
    master(context()).gain.cancelScheduledValues = () => {
      throw new Error('broken param');
    };
    expect(() => audio.setMuted(true)).not.toThrow();
    expect(audio.status).toBe('failed');
    expect(failures).toHaveLength(1);
  });

  it('shrugs off a malformed snapshot', () => {
    const { audio } = makeAudio();
    audio.unlock();
    expect(() => audio.update({} as YoyoSnapshot, 0)).not.toThrow();
    expect(() => audio.update(null as unknown as YoyoSnapshot, 16)).not.toThrow();
  });

  it('is not undone by a reporter that throws', () => {
    const audio = new YoyoAudio({
      createContext: () => {
        throw new Error('no audio');
      },
      onFailure: () => {
        throw new Error('reporter bug');
      },
    });
    expect(() => audio.unlock()).not.toThrow();
  });
});
