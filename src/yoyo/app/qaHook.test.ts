import { describe, expect, it } from 'vitest';
import type { HandDetection, HandFrame } from '../../shared/contracts';
import { createConfig } from '../config';
import type { FrameEdge, YoyoPhase } from '../contracts';
import { Random } from '../replay/random';
import { buildQaCameraSession, QA_PHASES, QA_SEED } from '../replay/sessions';
import { framingZone } from './framing';
import { createQaReplay, qaFramesFor, QA_CAMERA_REPLAY, QA_MAX_PER_TAKE, qaModeFromSearch, QaReplay } from './qaHook';
import { YoyoRuntime } from './YoyoRuntime';

const hand = (marker: number): HandDetection => ({
  handedness: 'Right',
  landmarks: Array.from({ length: 21 }, () => ({ x: marker, y: marker, z: 0 })),
});

/** A session frame at `t` ms from the start of the session; `marker` tells hands apart, null means no hand in view. */
const sessionFrame = (t: number, marker: number | null) => ({
  frame: { timestampMs: t, source: 'replay' as const, hands: marker === null ? [] : [hand(marker)] },
});

/** A frame of the real camera, captured at `t` ms on its own clock. */
const cameraFrame = (t: number): HandFrame => ({ timestampMs: t, source: 'camera', hands: [] });

describe('qaModeFromSearch', () => {
  it('turns the hook on for exactly the documented value', () => {
    expect(QA_CAMERA_REPLAY).toBe('camera-replay');
    expect(qaModeFromSearch('?qa=camera-replay')).toBe('camera-replay');
    expect(qaModeFromSearch('?foo=1&qa=camera-replay&bar=2')).toBe('camera-replay');
    expect(qaModeFromSearch('qa=camera-replay')).toBe('camera-replay');
  });

  it('does nothing for a page without it, and ignores anything else', () => {
    expect(qaModeFromSearch('')).toBeNull();
    expect(qaModeFromSearch('?')).toBeNull();
    expect(qaModeFromSearch('?qa=')).toBeNull();
    expect(qaModeFromSearch('?qa=combined-two-hands')).toBeNull();
    expect(qaModeFromSearch('?qa=camera-replay2')).toBeNull();
    expect(qaModeFromSearch('?QA=camera-replay')).toBeNull();
    expect(qaModeFromSearch('?mode=camera-replay')).toBeNull();
  });
});

describe('QaReplay', () => {
  const frames = [sessionFrame(0, null), sessionFrame(33, 1), sessionFrame(67, 2), sessionFrame(100, 3), sessionFrame(133, 4)];

  it('knows how long the session is and starts unfinished', () => {
    const r = new QaReplay(frames);
    expect(r.durationMs).toBe(133);
    expect(r.finished).toBe(false);
    expect(new QaReplay([]).durationMs).toBe(0);
    expect(new QaReplay([]).finished).toBe(true);
  });

  it('hands out the frames captured by the elapsed time, oldest first, each once', () => {
    const r = new QaReplay(frames);
    expect(r.takeDue(-5)).toEqual([]);
    expect(r.takeDue(0).map(f => f.timestampMs)).toEqual([0]);
    expect(r.takeDue(10)).toEqual([]);
    expect(r.takeDue(70).map(f => f.timestampMs)).toEqual([33, 67]);
    expect(r.takeDue(70)).toEqual([]);
    expect(r.takeDue(1000).map(f => f.timestampMs)).toEqual([100, 133]);
    expect(r.finished).toBe(true);
    expect(r.takeDue(5000)).toEqual([]);
  });

  it('counts a frame captured exactly at the elapsed time as due', () => {
    const r = new QaReplay(frames);
    expect(r.takeDue(33).map(f => f.timestampMs)).toEqual([0, 33]);
  });

  it('keeps each frame\'s own hands, and nothing for a frame without a hand', () => {
    const r = new QaReplay(frames);
    const all = r.takeDue(1000);
    expect(all[0].hands).toEqual([]);
    expect(all[1].hands).toBe(frames[1].frame.hands);
    expect(all.map(f => f.hands.length)).toEqual([0, 1, 1, 1, 1]);
  });

  it('sorts a session given in another order by capture time', () => {
    const shuffled = [frames[3], frames[0], frames[4], frames[2], frames[1]];
    const r = new QaReplay(shuffled);
    expect(r.takeDue(1000).map(f => f.timestampMs)).toEqual([0, 33, 67, 100, 133]);
  });

  it('does not touch the session it was given', () => {
    const before = JSON.stringify(frames);
    new QaReplay(frames).takeDue(1000);
    expect(JSON.stringify(frames)).toBe(before);
  });

  it('skips the oldest when too many are due at once (a stalled page), keeping the newest, and never hands them out later', () => {
    const many = Array.from({ length: 20 }, (_, i) => sessionFrame(i * 33, i));
    const r = new QaReplay(many, 4);
    const got = r.takeDue(1000);
    expect(got).toHaveLength(4);
    expect(got.map(f => f.timestampMs)).toEqual([16 * 33, 17 * 33, 18 * 33, 19 * 33]);
    expect(r.finished).toBe(true);
    expect(r.takeDue(5000)).toEqual([]);
    expect(QA_MAX_PER_TAKE).toBe(8);
  });

  it('ignores a time that is not a number', () => {
    const r = new QaReplay(frames);
    expect(r.takeDue(Number.NaN)).toEqual([]);
    expect(r.takeDue(Infinity)).toEqual([]);
    expect(r.finished).toBe(false);
  });

  it('starts over on reset', () => {
    const r = new QaReplay(frames);
    r.takeDue(1000);
    r.reset();
    expect(r.finished).toBe(false);
    expect(r.takeDue(0).map(f => f.timestampMs)).toEqual([0]);
  });

  it('rejects a take size that is not a positive integer', () => {
    expect(() => new QaReplay(frames, 0)).toThrow(RangeError);
    expect(() => new QaReplay(frames, 1.5)).toThrow(RangeError);
  });
});

describe('qaFramesFor: the time alignment of the hook', () => {
  const READY = 50_000;

  it('puts the session on the camera\'s clock: capture time is the moment the camera was ready plus the frame\'s time', () => {
    const r = new QaReplay([sessionFrame(0, null), sessionFrame(33, 1), sessionFrame(67, 2)]);
    const out = qaFramesFor(r, cameraFrame(READY + 40), READY);
    expect(out.map(f => f.timestampMs)).toEqual([READY, READY + 33]);
    expect(out[1].hands).toHaveLength(1);
    expect(out[0].hands).toHaveLength(0);
    expect(out.every(f => f.source === 'camera')).toBe(true);
  });

  it('delivers nothing for a camera frame that only tells the time (no session frame is due) or comes before the session', () => {
    const r = new QaReplay([sessionFrame(100, 1), sessionFrame(133, 2)]);
    expect(qaFramesFor(r, cameraFrame(READY - 20), READY)).toEqual([]);
    expect(qaFramesFor(r, cameraFrame(READY + 99), READY)).toEqual([]);
    expect(qaFramesFor(r, cameraFrame(READY + 100), READY).map(f => f.timestampMs)).toEqual([READY + 100]);
    expect(qaFramesFor(r, cameraFrame(READY + 110), READY)).toEqual([]);
  });

  it('catches up: a camera slower than the session still delivers every session frame, in order', () => {
    const session = Array.from({ length: 30 }, (_, i) => sessionFrame(i * 33.3333, i));
    const r = new QaReplay(session);
    const delivered: number[] = [];
    // A 12 fps camera against a 30 fps session (about a second long): the last camera frame is the first one past its end.
    for (let t = 0; t < 1000; t += 83.3) {
      for (const f of qaFramesFor(r, cameraFrame(READY + t), READY)) delivered.push(f.timestampMs - READY);
    }
    expect(delivered).toHaveLength(30);
    expect(delivered).toEqual(session.map(s => s.frame.timestampMs).map(t => expect.closeTo(t, 9)));
  });

  it('never delivers a session frame before its capture time, twice, or out of order, at any camera cadence', () => {
    const rng = new Random(7);
    const session = Array.from({ length: 200 }, (_, i) => sessionFrame(i * 33.3333 + rng.range(-2, 2), i));
    for (const fps of [10, 15, 20, 25, 30, 45, 60]) {
      const r = new QaReplay(session);
      const delivered: Array<{ at: number; t: number }> = [];
      for (let t = rng.range(0, 40); t < 8000; t += 1000 / fps + rng.range(-3, 3)) {
        for (const f of qaFramesFor(r, cameraFrame(READY + t), READY)) delivered.push({ at: READY + t, t: f.timestampMs });
      }
      const times = delivered.map(d => d.t);
      for (let i = 1; i < times.length; i++) expect(times[i], `fps ${fps}`).toBeGreaterThan(times[i - 1]);
      // Captured no later than the camera frame that delivered it.
      for (const d of delivered) expect(d.t).toBeLessThanOrEqual(d.at);
      // The whole session, and then the camera's own empty frames.
      const sessionOnes = delivered.filter(d => d.t - READY <= r.durationMs + 1e-9 && session.some(s => Math.abs(s.frame.timestampMs - (d.t - READY)) < 1e-9));
      expect(sessionOnes).toHaveLength(session.length);
    }
  });

  it('keeps hands as they are, including the empty frames of an absence', () => {
    const r = new QaReplay([sessionFrame(0, 1), sessionFrame(33, null), sessionFrame(67, 2)]);
    const out = qaFramesFor(r, cameraFrame(READY + 70), READY);
    expect(out.map(f => f.hands.length)).toEqual([1, 0, 1]);
  });

  it('goes on delivering camera frames without hands after the session ends, strictly after its last frame', () => {
    const r = new QaReplay([sessionFrame(0, 1), sessionFrame(33, 2)]);
    expect(qaFramesFor(r, cameraFrame(READY + 40), READY)).toHaveLength(2);
    // Same instant as the last session frame: nothing (times must increase).
    expect(qaFramesFor(r, cameraFrame(READY + 33), READY)).toEqual([]);
    const after = qaFramesFor(r, cameraFrame(READY + 80), READY);
    expect(after).toEqual([{ timestampMs: READY + 80, source: 'camera', hands: [] }]);
    const later = qaFramesFor(r, cameraFrame(READY + 120), READY);
    expect(later).toEqual([{ timestampMs: READY + 120, source: 'camera', hands: [] }]);
  });

  it('keeps the camera\'s own frame (timestamp and source) after the session, only emptying its hands', () => {
    const r = new QaReplay([sessionFrame(0, 1)]);
    qaFramesFor(r, cameraFrame(READY + 5), READY);
    const real: HandFrame = { timestampMs: READY + 200, source: 'camera', hands: [hand(9)] };
    const [out] = qaFramesFor(r, real, READY);
    expect(out.timestampMs).toBe(real.timestampMs);
    expect(out.hands).toEqual([]);
    // The camera's frame is not modified.
    expect(real.hands).toHaveLength(1);
  });

  it('handles an empty session: no hands ever, the camera\'s frames pass with `hands: []`', () => {
    const r = new QaReplay([]);
    expect(qaFramesFor(r, cameraFrame(READY + 10), READY)).toEqual([{ timestampMs: READY + 10, source: 'camera', hands: [] }]);
    expect(qaFramesFor(r, cameraFrame(READY - 10), READY)).toEqual([]);
  });
});

describe('the QA session through the hook and a real runtime', () => {
  /** Plays the session as the page would: a camera of `fps` frames per second as the clock, the runtime fed what the hook delivers. */
  function play(fps: number, phaseMs: number, latencyMs: number) {
    const replay = createQaReplay();
    const runtime = new YoyoRuntime(createConfig(), 'camera');
    runtime.setTetherZone(framingZone('standing'));
    const ORIGIN = 100_000;
    const arrivals: Array<{ at: number; frame: HandFrame }> = [];
    const phases: YoyoPhase[] = [];
    const edges = new Set<FrameEdge>();
    const rng = new Random(Math.round(fps * 1000 + phaseMs));
    let k = 0;
    const end = buildQaCameraSession(QA_SEED).durationMs + 1500;
    for (let now = 0; now <= end; now += 1000 / 60) {
      for (;;) {
        const capture = phaseMs + k * (1000 / fps) + rng.range(-2, 2);
        if (capture + latencyMs > now) break;
        for (const frame of qaFramesFor(replay, cameraFrame(ORIGIN + capture), ORIGIN)) arrivals.push({ at: ORIGIN + capture + latencyMs, frame });
        k++;
      }
      while (arrivals.length > 0 && arrivals[0].at <= ORIGIN + now) {
        const a = arrivals.shift()!;
        runtime.pushFrame(a.frame, a.at);
      }
      const snapshot = runtime.advance(ORIGIN + now);
      if (phases[phases.length - 1] !== snapshot.phase) phases.push(snapshot.phase);
      if (snapshot.hand.edge !== null) edges.add(snapshot.hand.edge);
    }
    return { phases, edges, metrics: runtime.metrics.snapshot(ORIGIN + end) };
  }

  it.each([
    [30, 0, 25],
    [20, 7.3, 40],
    [15, 13.1, 55],
  ])('walks the promised phases and flags the bottom edge, whatever the camera rate (%s fps)', (fps, phaseMs, latencyMs) => {
    const { phases, edges, metrics } = play(fps, phaseMs, latencyMs);
    expect(phases).toEqual([...QA_PHASES]);
    expect([...edges]).toEqual(['bottom']);
    // Two throws, two tugs, and the hand was lost and found again around the exit.
    expect(metrics.launches).toBe(2);
    expect(metrics.tugs).toBe(2);
    expect(metrics.handLosses).toBeGreaterThanOrEqual(1);
  });

  it('is the camera\'s clock, not the camera\'s content, that drives it: the hands of the camera frames are never used', () => {
    const replay = createQaReplay();
    const real: HandFrame = { timestampMs: 5_000, source: 'camera', hands: [hand(0.123)] };
    const out = qaFramesFor(replay, real, 5_000 - 600);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(f => f.hands.every(h => h.landmarks[0].x !== 0.123))).toBe(true);
  });
});
