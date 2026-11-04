import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { YoyoEvent, YoyoEventKind } from '../contracts';
import { MetricsRecorder, MIN_HAND_LOSS_MS } from './MetricsRecorder';

const event = (kind: YoyoEventKind, timeMs: number): YoyoEvent => ({ kind, timeMs });

/** Feeds events with increasing times so tests read as a sequence of what happened. */
function feed(recorder: MetricsRecorder, kinds: YoyoEventKind[], startMs = 1000): void {
  kinds.forEach((kind, i) => recorder.onEvent(event(kind, startMs + i * 100)));
}

describe('MetricsRecorder', () => {
  it('counts the kinds of event that feed a metric', () => {
    const metrics = new MetricsRecorder();
    metrics.start(0);
    feed(metrics, ['launch', 'launch', 'launch', 'tug', 'tug', 'catch', 'auto-return', 'exhausted', 'exhausted']);
    // Four losses of half a second each.
    for (let i = 0; i < 4; i += 1) {
      metrics.onEvent(event('hand-lost', 2000 + i * 1000));
      metrics.onEvent(event('hand-found', 2500 + i * 1000));
    }
    const m = metrics.snapshot(7000);
    expect(m.launches).toBe(3);
    expect(m.tugs).toBe(2);
    expect(m.catches).toBe(1);
    expect(m.autoReturns).toBe(1);
    expect(m.exhausted).toBe(2);
    expect(m.handLosses).toBe(4);
  });

  it('does not count events that feed no metric', () => {
    const metrics = new MetricsRecorder();
    metrics.start(0);
    feed(metrics, ['tether', 'snap', 'retether', 'return-failed', 'hand-found']);
    expect(metrics.snapshot(1000)).toEqual({
      sessionMs: 1000,
      firstLaunchMs: null,
      launches: 0,
      tugs: 0,
      catches: 0,
      autoReturns: 0,
      exhausted: 0,
      tugSuccessRate: Number.NaN,
      ignoredIntents: 0,
      handLosses: 0,
      reactionLatencyMs: [],
    });
  });

  it('counts ignored intents', () => {
    const metrics = new MetricsRecorder();
    metrics.start(0);
    metrics.onIgnoredIntent();
    metrics.onIgnoredIntent();
    metrics.onIgnoredIntent();
    expect(metrics.snapshot(10).ignoredIntents).toBe(3);
  });

  describe('hand losses', () => {
    const lost = (metrics: MetricsRecorder, atMs: number, lastsMs: number): void => {
      metrics.onEvent(event('hand-lost', atMs));
      metrics.onEvent(event('hand-found', atMs + lastsMs));
    };

    it('counts only a loss that lasts at least MIN_HAND_LOSS_MS: a flicker is not a loss', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      expect(MIN_HAND_LOSS_MS).toBe(300);
      // Three dropped frames: the hand is «lost» for a frame and found again.
      lost(metrics, 1000, 8);
      lost(metrics, 2000, 16.7);
      lost(metrics, 3000, MIN_HAND_LOSS_MS - 0.1);
      expect(metrics.snapshot(5000).handLosses).toBe(0);
      lost(metrics, 6000, MIN_HAND_LOSS_MS);
      expect(metrics.snapshot(8000).handLosses).toBe(1);
      lost(metrics, 9000, 5000);
      expect(metrics.snapshot(20_000).handLosses).toBe(2);
    });

    it('counts a loss that is still going on once it has lasted long enough, and only once', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      metrics.onEvent(event('hand-lost', 1000));
      expect(metrics.snapshot(1000).handLosses).toBe(0);
      expect(metrics.snapshot(1000 + MIN_HAND_LOSS_MS - 1).handLosses).toBe(0);
      expect(metrics.snapshot(1000 + MIN_HAND_LOSS_MS).handLosses).toBe(1);
      expect(metrics.snapshot(60_000).handLosses).toBe(1);
      // The hand comes back: the loss is stored, not counted again.
      metrics.onEvent(event('hand-found', 60_500));
      expect(metrics.snapshot(60_500).handLosses).toBe(1);
      expect(metrics.snapshot(90_000).handLosses).toBe(1);
    });

    it('a short loss that is over is never counted later, whenever it is asked about', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      lost(metrics, 1000, 40);
      for (const nowMs of [1020, 1040, 1100, 5000, 600_000]) expect(metrics.snapshot(nowMs).handLosses).toBe(0);
    });

    it('a second hand-lost with no hand-found between is the same loss; a hand-found with no loss is nothing', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      metrics.onEvent(event('hand-found', 500));
      metrics.onEvent(event('hand-lost', 1000));
      metrics.onEvent(event('hand-lost', 1200));
      metrics.onEvent(event('hand-found', 1400));
      // 400 ms from the first lost, not 200 ms from the second.
      expect(metrics.snapshot(2000).handLosses).toBe(1);
    });

    it('ignores losses with a time that is not a number instead of counting NaN', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      metrics.onEvent(event('hand-lost', Number.NaN));
      metrics.onEvent(event('hand-found', 5000));
      expect(metrics.snapshot(6000).handLosses).toBe(0);
      expect(metrics.snapshot(Number.NaN).handLosses).toBe(0);
    });

    it('the minimum is configurable and must make sense', () => {
      const strict = new MetricsRecorder(8, 1000);
      strict.start(0);
      lost(strict, 100, 900);
      lost(strict, 2000, 1000);
      expect(strict.snapshot(5000).handLosses).toBe(1);
      const everything = new MetricsRecorder(8, 0);
      everything.start(0);
      lost(everything, 100, 1);
      expect(everything.snapshot(5000).handLosses).toBe(1);
      expect(() => new MetricsRecorder(8, -1)).toThrow(RangeError);
      expect(() => new MetricsRecorder(8, Number.NaN)).toThrow(RangeError);
    });

    it('reset forgets a loss that was going on; events before the session starts are ignored', () => {
      const metrics = new MetricsRecorder();
      lost(metrics, 100, 1000);
      metrics.start(0);
      expect(metrics.snapshot(5000).handLosses).toBe(0);
      metrics.onEvent(event('hand-lost', 1000));
      metrics.reset(2000);
      metrics.onEvent(event('hand-found', 9000));
      expect(metrics.snapshot(10_000).handLosses).toBe(0);
    });
  });

  describe('time', () => {
    it('measures the session and the first launch from the start time', () => {
      const metrics = new MetricsRecorder();
      metrics.start(5000);
      expect(metrics.snapshot(5000).firstLaunchMs).toBeNull();
      expect(metrics.snapshot(7000).sessionMs).toBe(2000);
      metrics.onEvent(event('launch', 7500));
      expect(metrics.snapshot(8000).firstLaunchMs).toBe(2500);
      // Only the first launch defines it.
      metrics.onEvent(event('launch', 9000));
      expect(metrics.snapshot(10_000).firstLaunchMs).toBe(2500);
      expect(metrics.snapshot(10_000).sessionMs).toBe(5000);
    });

    it('never reports a negative session or launch time', () => {
      const metrics = new MetricsRecorder();
      metrics.start(1000);
      metrics.onEvent(event('launch', 900));
      const m = metrics.snapshot(500);
      expect(m.firstLaunchMs).toBe(0);
      expect(m.sessionMs).toBe(0);
    });
  });

  describe('tug success rate', () => {
    it('is NaN before the first tug, even after launches and catches', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      expect(metrics.snapshot(0).tugSuccessRate).toBeNaN();
      feed(metrics, ['launch', 'auto-return', 'catch']);
      expect(metrics.snapshot(1000).tugSuccessRate).toBeNaN();
    });

    it('counts a tug followed by a catch', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      feed(metrics, ['launch', 'tug']);
      // Still on its way home: not a success yet.
      expect(metrics.snapshot(1000).tugSuccessRate).toBe(0);
      feed(metrics, ['catch'], 2000);
      expect(metrics.snapshot(3000).tugSuccessRate).toBe(1);
    });

    it('does not count a tug that no catch followed before the next launch', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      feed(metrics, ['launch', 'tug', 'launch', 'tug', 'catch']);
      const m = metrics.snapshot(1000);
      expect(m.tugs).toBe(2);
      expect(m.tugSuccessRate).toBe(0.5);
    });

    it('lets a later catch vouch for a tug still waiting, as long as no launch came in between', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      // The first tug is vouched for by the first catch; the second has no catch after it yet.
      feed(metrics, ['launch', 'tug', 'catch', 'tug']);
      expect(metrics.snapshot(1000).tugSuccessRate).toBe(0.5);
      // The next catch (no launch in between) vouches for it too.
      feed(metrics, ['catch'], 2000);
      expect(metrics.snapshot(3000).tugSuccessRate).toBe(1);
    });

    it('credits every tug before a catch within the same launch (PRD wording: followed by a catch)', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      feed(metrics, ['launch', 'tug', 'tug', 'catch']);
      expect(metrics.snapshot(1000).tugSuccessRate).toBe(1);
    });

    it('ignores catches that no tug caused', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      feed(metrics, ['launch', 'auto-return', 'catch', 'launch', 'tug', 'launch']);
      const m = metrics.snapshot(1000);
      expect(m.catches).toBe(1);
      expect(m.tugs).toBe(1);
      expect(m.tugSuccessRate).toBe(0);
    });

    it('stays within [0, 1] over a long mixed session', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      const kinds: YoyoEventKind[] = ['launch', 'tug', 'catch', 'launch', 'tug', 'tug', 'launch', 'exhausted', 'tug', 'catch', 'hand-lost', 'hand-found'];
      for (let round = 0; round < 50; round += 1) {
        feed(metrics, kinds, round * 10_000);
        const rate = metrics.snapshot(round * 10_000 + 5000).tugSuccessRate;
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('reaction latencies', () => {
    it('keeps the newest latencies, oldest first, in a bounded ring', () => {
      const metrics = new MetricsRecorder(4);
      metrics.start(0);
      for (let i = 1; i <= 3; i += 1) metrics.onReaction(i * 10);
      expect(metrics.snapshot(0).reactionLatencyMs).toEqual([10, 20, 30]);
      for (let i = 4; i <= 10; i += 1) metrics.onReaction(i * 10);
      expect(metrics.snapshot(0).reactionLatencyMs).toEqual([70, 80, 90, 100]);
    });

    it('stays bounded at its default capacity however many reactions arrive', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      for (let i = 0; i < 10_000; i += 1) metrics.onReaction(i);
      const latencies = metrics.snapshot(0).reactionLatencyMs;
      expect(latencies).toHaveLength(256);
      expect(latencies[0]).toBe(10_000 - 256);
      expect(latencies[255]).toBe(9999);
    });

    it('drops values that cannot be a latency instead of clamping them', () => {
      const metrics = new MetricsRecorder(8);
      metrics.start(0);
      metrics.onReaction(Number.NaN);
      metrics.onReaction(-5);
      metrics.onReaction(Number.POSITIVE_INFINITY);
      metrics.onReaction(0);
      metrics.onReaction(42);
      expect(metrics.snapshot(0).reactionLatencyMs).toEqual([0, 42]);
    });

    it('rejects a capacity that is not a positive integer', () => {
      for (const capacity of [0, -1, 2.5, Number.NaN]) expect(() => new MetricsRecorder(capacity)).toThrow(RangeError);
    });

    it('works with a capacity of one', () => {
      const metrics = new MetricsRecorder(1);
      metrics.start(0);
      metrics.onReaction(5);
      metrics.onReaction(6);
      expect(metrics.snapshot(0).reactionLatencyMs).toEqual([6]);
    });
  });

  describe('snapshot', () => {
    it('is a copy: neither editing it nor later events change what was handed out', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      feed(metrics, ['launch', 'tug']);
      metrics.onReaction(30);
      const first = metrics.snapshot(1000);

      (first.reactionLatencyMs as number[]).push(999);
      (first as { launches: number }).launches = 99;
      const second = metrics.snapshot(1000);
      expect(second).not.toBe(first);
      expect(second.reactionLatencyMs).toEqual([30]);
      expect(second.launches).toBe(1);

      feed(metrics, ['catch', 'launch'], 2000);
      metrics.onReaction(40);
      expect(second.launches).toBe(1);
      expect(second.catches).toBe(0);
      expect(second.reactionLatencyMs).toEqual([30]);
      expect(metrics.snapshot(3000).reactionLatencyMs).toEqual([30, 40]);
    });
  });

  describe('lifecycle', () => {
    it('reset clears every counter and restarts the session at the given time', () => {
      const metrics = new MetricsRecorder(4);
      metrics.start(0);
      feed(metrics, ['launch', 'tug', 'catch', 'auto-return', 'exhausted', 'hand-lost']);
      metrics.onIgnoredIntent();
      metrics.onReaction(20);

      metrics.reset(9000);
      expect(metrics.snapshot(9000)).toEqual({
        sessionMs: 0,
        firstLaunchMs: null,
        launches: 0,
        tugs: 0,
        catches: 0,
        autoReturns: 0,
        exhausted: 0,
        tugSuccessRate: Number.NaN,
        ignoredIntents: 0,
        handLosses: 0,
        reactionLatencyMs: [],
      });
      metrics.onEvent(event('launch', 9400));
      expect(metrics.snapshot(9500).firstLaunchMs).toBe(400);
      // The tug bookkeeping restarts too: a stale pending tug must not leak into the new session.
      feed(metrics, ['tug', 'catch'], 9500);
      expect(metrics.snapshot(10_000).tugSuccessRate).toBe(1);
    });

    it('start begins a clean session', () => {
      const metrics = new MetricsRecorder();
      metrics.start(0);
      feed(metrics, ['launch']);
      metrics.start(5000);
      expect(metrics.snapshot(5000).launches).toBe(0);
      expect(metrics.snapshot(6000).sessionMs).toBe(1000);
    });

    it('ignores everything reported before the session starts', () => {
      const metrics = new MetricsRecorder();
      feed(metrics, ['launch', 'tug', 'catch']);
      metrics.onIgnoredIntent();
      metrics.onReaction(10);
      const m = metrics.snapshot(1000);
      expect(m.launches).toBe(0);
      expect(m.ignoredIntents).toBe(0);
      expect(m.reactionLatencyMs).toEqual([]);
      expect(m.sessionMs).toBe(0);
    });

    it('stays inactive when started with a non-finite time instead of reporting NaN', () => {
      const metrics = new MetricsRecorder();
      metrics.start(Number.NaN);
      feed(metrics, ['launch']);
      const m = metrics.snapshot(1000);
      expect(m.launches).toBe(0);
      expect(m.sessionMs).toBe(0);
      expect(m.firstLaunchMs).toBeNull();
    });

    it('tolerates a non-finite time in an event or a snapshot', () => {
      const metrics = new MetricsRecorder();
      metrics.start(100);
      metrics.onEvent(event('launch', Number.NaN));
      const m = metrics.snapshot(Number.NaN);
      expect(m.launches).toBe(1);
      expect(m.firstLaunchMs).toBeNull();
      expect(m.sessionMs).toBe(0);
    });
  });

  it('gives the same metrics for the same event stream (determinism)', () => {
    const run = () => {
      const metrics = new MetricsRecorder(8);
      metrics.start(1234);
      feed(metrics, ['launch', 'tug', 'catch', 'launch', 'hand-lost', 'tug'], 2000);
      [12, 18, 25].forEach(l => metrics.onReaction(l));
      return metrics.snapshot(9000);
    };
    expect(run()).toEqual(run());
  });

  it('reads no ambient clock or randomness (determinism rule)', () => {
    const source = readFileSync(new URL('./MetricsRecorder.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random/);
  });
});
