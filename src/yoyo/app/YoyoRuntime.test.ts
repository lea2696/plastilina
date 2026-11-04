import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { HandFrame } from '../../shared/contracts';
import { createConfig, setConfigValue, type YoyoConfig } from '../config';
import type { AnchorSample, InputSource, IntentEvent, YoyoEvent, YoyoEventKind, YoyoPhase, YoyoSnapshot } from '../contracts';
import { toWorld } from '../perception/worldMapping';
import { buildHand, DEFAULT_PALM_SIZE, IMAGE_ASPECT } from '../replay/handPose';
import { renderCleanSession, sessionScene } from '../replay/sessions';
import { DEFAULT_HOME_IMAGE, DEFAULT_TETHER_ZONE, MAX_QUEUED_INPUTS, YoyoRuntime, type RuntimeDiagnostics } from './YoyoRuntime';
import { MIN_HAND_LOSS_MS } from './MetricsRecorder';
import { zoneCentre } from './TetherDetector';

/**
 * Runtime unit tests, SYNTHETIC: hand-made noise-free HandFrames and pointer samples, driven at a 60 Hz
 * render cadence. They pin down what the runtime itself decides (queueing, presence, tie-on, arming,
 * pause, recalibration, live tuning); how the whole pipeline behaves on noisy sessions is scenarios.test.ts.
 */

const FRAME_MS = 1000 / 30;
const RENDER_MS = 1000 / 60;
const LATENCY_MS = 50;

/** A noise-free hand whose landmark 9 (the anchor) is at (x, y), mirrored image heights. */
function frameAt(captureMs: number, x: number, y: number): HandFrame {
  return { timestampMs: captureMs, source: 'replay', hands: [buildHand({ anchor: { x: 1 - x / IMAGE_ASPECT, y }, palmSize: DEFAULT_PALM_SIZE })] };
}
const emptyFrame = (captureMs: number): HandFrame => ({ timestampMs: captureMs, source: 'replay', hands: [] });

/** Where the hand is in frame `index`: a position, `null` for a frame without a hand, `undefined` for no frame at all. */
type Path = (captureMs: number, index: number) => readonly [number, number] | null | undefined;

/** A runtime driven at 60 Hz with camera frames delivered 50 ms after their capture. */
class Rig {
  readonly runtime: YoyoRuntime;
  readonly snapshots: YoyoSnapshot[] = [];
  /** Physics steps the model had run after each snapshot. */
  readonly modelSteps: number[] = [];
  readonly intents: Array<{ event: IntentEvent; accepted: boolean }> = [];
  /** Index of the next 60 Hz render frame and of the next 30 fps camera frame. */
  tick = 0;
  frameIndex = 0;

  constructor(readonly config: YoyoConfig = createConfig(), source: InputSource = 'replay') {
    this.runtime = new YoyoRuntime(config, source);
    this.runtime.onIntent = (event, accepted) => this.intents.push({ event, accepted });
  }

  get nowMs(): number {
    return this.tick * RENDER_MS;
  }

  get last(): YoyoSnapshot {
    return this.snapshots[this.snapshots.length - 1];
  }

  /** Delivers camera frames as `path` says and advances the render clock up to `untilMs`. */
  run(untilMs: number, path: Path, latencyMs = LATENCY_MS): void {
    for (; this.nowMs <= untilMs; this.tick++) {
      for (;;) {
        const capture = this.frameIndex * FRAME_MS;
        if (capture + latencyMs > this.nowMs) break;
        const where = path(capture, this.frameIndex);
        if (where === null) this.runtime.pushFrame(emptyFrame(capture), capture + latencyMs);
        else if (where) this.runtime.pushFrame(frameAt(capture, where[0], where[1]), capture + latencyMs);
        this.frameIndex++;
      }
      this.snapshots.push(this.runtime.advance(this.nowMs));
      this.modelSteps.push(this.runtime.model.stepsTaken);
    }
  }

  events(): YoyoEvent[] {
    return this.snapshots.flatMap(s => [...s.events]);
  }

  kinds(): YoyoEventKind[] {
    return this.events().map(e => e.kind).filter(k => k !== 'hand-found' && k !== 'hand-lost');
  }

  phases(): YoyoPhase[] {
    const out: YoyoPhase[] = [];
    for (const s of this.snapshots) if (out[out.length - 1] !== s.phase) out.push(s.phase);
    return out;
  }
}

const still = (x = DEFAULT_HOME_IMAGE[0], y = DEFAULT_HOME_IMAGE[1]): Path => () => [x, y];

/**
 * Where the world puts the image point (x, y) when the world is homed at the image point `home`: the default
 * home before the yoyo ties on, the zone's centre while a zone is set. The geometry comes from the config the
 * runtime was given, never from literals, so moving the world home moves every expectation with it (the world
 * grows upward while the image grows downward).
 */
function worldOf(config: YoyoConfig, x: number, y: number, home: readonly [number, number] = DEFAULT_HOME_IMAGE): [number, number] {
  return [config.world.homeX + config.world.scale * (x - home[0]), config.world.homeY - config.world.scale * (y - home[1])];
}

/** A tethered rig: a still hand for 1.2 s ties the yoyo on. */
function tetheredRig(config = createConfig(), at: readonly [number, number] = [DEFAULT_HOME_IMAGE[0], 0.5]): Rig {
  const rig = new Rig(config);
  rig.run(1200, still(at[0], at[1]));
  expect(rig.last.phase).toBe('tethered');
  return rig;
}

describe('YoyoRuntime: the clock', () => {
  it('starts at the first advance: no step, then exactly four 240 Hz steps per 60 Hz frame', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    const first = runtime.advance(1000);
    expect(first.steps).toBe(0);
    expect(first.timeMs).toBe(1000);
    expect(first.phase).toBe('untethered');
    const second = runtime.advance(1000 + RENDER_MS);
    expect(second.steps).toBe(4);
    expect(second.timeMs).toBeCloseTo(1000 + RENDER_MS, 9);
    expect(runtime.diagnostics.stepsTotal).toBe(4);
  });

  it('a snapshot of a runtime that has seen nothing is plain and complete', () => {
    const config = createConfig();
    const s = new YoyoRuntime(config, 'replay').advance(0);
    expect(s).toMatchObject({
      phase: 'untethered', responsiveness: 'responsive', paused: false, steps: 0, droppedMs: 0, events: [],
      length: 0, maxLength: config.yoyo.maxLength, spin: 0, spinAngle: 0, tension: 0, slack: false,
      // Idle, the pivot waits at the world home.
      pivot: [config.world.homeX, config.world.homeY], pivotVelocity: [0, 0], hand: { present: false, lostMs: 0, edge: null, landmarks: null, palmWorld: 0 },
    });
  });

  it('a stall longer than four steps drops the surplus, keeps the clock on the input timebase and counts it', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    runtime.advance(1000);
    const stalled = runtime.advance(1500);
    const stepMs = 1000 / createConfig().sim.hz;
    expect(stalled.steps).toBe(4);
    // 500 ms is 120 steps owed; four are run, the other 116 are dropped.
    expect(stalled.droppedMs).toBeCloseTo(116 * stepMs, 6);
    expect(runtime.diagnostics.droppedMs).toBeCloseTo(116 * stepMs, 6);
    expect(1500 - stalled.timeMs).toBeLessThan(stepMs);
    expect(runtime.advance(1500 + RENDER_MS).droppedMs).toBe(0);
  });

  it('time that goes backwards, or is not a number, owes nothing and breaks nothing', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    runtime.advance(1000);
    runtime.advance(1100);
    const stepsBefore = runtime.diagnostics.stepsTotal;
    expect(runtime.advance(900).steps).toBe(0);
    expect(runtime.advance(Number.NaN).steps).toBe(0);
    expect(runtime.diagnostics.stepsTotal).toBe(stepsBefore);
    expect(runtime.advance(1100 + RENDER_MS).steps).toBeGreaterThan(0);
  });
});

describe('YoyoRuntime: tying on (Y-01)', () => {
  it('a still hand ties the yoyo on stableMs after it appeared, once, and no physics step ran before', () => {
    const rig = new Rig();
    rig.run(1500, still());
    const k = rig.snapshots.findIndex(s => s.events.some(e => e.kind === 'tether'));
    const tether = rig.snapshots[k].events.find(e => e.kind === 'tether')!;
    expect(rig.events().filter(e => e.kind === 'tether')).toHaveLength(1);
    // The first frame is captured at 0 and arrives at 50 ms; the window needs stableMs of samples.
    expect(tether.timeMs).toBeGreaterThanOrEqual(LATENCY_MS + rig.config.tether.stableMs);
    expect(tether.timeMs).toBeLessThan(LATENCY_MS + rig.config.tether.stableMs + 3 * FRAME_MS);
    // Not a single model step until that very tick (the step that ties it on is the first one the model may take).
    expect(Math.max(...rig.modelSteps.slice(0, k))).toBe(0);
    expect(rig.snapshots.slice(0, k).every(s => s.phase === 'untethered')).toBe(true);
    expect(rig.phases()).toEqual(['untethered', 'tethered']);
  });

  it('re-homes the world at the anchor: wherever the hand rests, the pivot starts at the world home', () => {
    const config = createConfig();
    for (const at of [[0.5, 0.5], [0.9, 0.3], [0.67, 0.7]] as const) {
      const rig = tetheredRig(config, at);
      // The very frame that ties the yoyo on already has the pivot at the home and the yoyo under it: no glide, no leap.
      const first = rig.snapshots.find(s => s.phase === 'tethered')!;
      expect(Math.hypot(first.pivot[0] - config.world.homeX, first.pivot[1] - config.world.homeY)).toBeLessThan(0.005);
      expect(Math.hypot(first.yoyo[0] - config.world.homeX, first.yoyo[1] - (config.world.homeY - config.yoyo.loopLength))).toBeLessThan(0.005);
      expect(rig.last.pivot[0]).toBeCloseTo(config.world.homeX, 2);
      expect(rig.last.pivot[1]).toBeCloseTo(config.world.homeY, 2);
      // The yoyo hangs the loop length under the pivot, tied on within centimetres of the finger.
      expect(rig.last.yoyo[1]).toBeCloseTo(config.world.homeY - config.yoyo.loopLength, 1);
      expect(rig.last.length).toBeCloseTo(config.yoyo.loopLength, 1);
    }
  });

  it('before tie-on the silhouette uses the provisional mapping (home at the default image point); tie-on re-homes it', () => {
    const rig = new Rig();
    const { config } = rig;
    rig.run(300, still(0.9, 0.3));
    const landmark = rig.last.hand.landmarks![9];
    const provisional = worldOf(config, 0.9, 0.3);
    expect(landmark[0]).toBeCloseTo(provisional[0], 9);
    expect(landmark[1]).toBeCloseTo(provisional[1], 9);
    rig.run(1500, still(0.9, 0.3));
    expect(rig.last.phase).toBe('tethered');
    expect(rig.last.hand.landmarks![9][0]).toBeCloseTo(config.world.homeX, 2);
    expect(rig.last.hand.landmarks![9][1]).toBeCloseTo(config.world.homeY, 2);
  });

  it('with a zone the mapping is fixed: tying on inside it moves nothing on screen, and outside it never ties on', () => {
    const rig = new Rig();
    rig.runtime.setTetherZone(DEFAULT_TETHER_ZONE);
    rig.run(2000, still(0.2, 0.4));
    expect(rig.phases()).toEqual(['untethered']);
    expect(rig.runtime.model.stepsTaken).toBe(0);

    const inside = new Rig();
    inside.runtime.setTetherZone(DEFAULT_TETHER_ZONE);
    inside.run(1500, still(0.8, 0.3));
    const k = inside.snapshots.findIndex(s => s.events.some(e => e.kind === 'tether'));
    expect(k).toBeGreaterThan(0);
    const before = inside.snapshots[k - 1].hand.landmarks![9], after = inside.snapshots[k].hand.landmarks![9];
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(0.002);
    // The zone's centre is the home: the hand at (0.8, 0.3) is right of and above it.
    const expected = worldOf(inside.config, 0.8, 0.3, zoneCentre(DEFAULT_TETHER_ZONE));
    expect(after[0]).toBeCloseTo(expected[0], 6);
    expect(after[1]).toBeCloseTo(expected[1], 6);
    expect(after[1]).toBeGreaterThan(inside.config.world.homeY);
  });

  it('an app that repeats the same zone and the same pointer mapping every frame disturbs nothing', () => {
    const control = new Rig();
    control.runtime.setTetherZone(DEFAULT_TETHER_ZONE);
    control.run(2500, still(0.8, 0.3));
    const nagging = new Rig();
    nagging.runtime.setTetherZone({ ...DEFAULT_TETHER_ZONE });
    for (; nagging.nowMs <= 2500; ) {
      // Every render frame the app says it again, with fresh but equal objects.
      nagging.runtime.setTetherZone({ ...DEFAULT_TETHER_ZONE });
      nagging.run(nagging.nowMs, still(0.8, 0.3));
    }
    expect(nagging.last.phase).toBe('tethered');
    expect(JSON.stringify(nagging.snapshots)).toBe(JSON.stringify(control.snapshots));

    const mouse = new YoyoRuntime(createConfig(), 'mouse');
    // Still for a second (the yoyo ties on), then a steady 0.5 ih/s drag: a pivot that re-acquired at every sample would lag it differently.
    const sample = (t: number): AnchorSample => ({ timestampMs: t, arrivalMs: t, source: 'mouse', x: 0.8 + 0.0005 * Math.max(0, t - 1000), y: 0.3, palmSize: 0, continuous: t > 0 });
    const calm = new YoyoRuntime(createConfig(), 'mouse');
    const pointerMapping = { scale: 1.5, homeImage: [0.5, 0.5] as const, homeWorld: [0.1, 0.9] as const };
    for (let k = 0; k * RENDER_MS <= 2500; k++) {
      const now = k * RENDER_MS;
      mouse.setPointerMapping({ scale: pointerMapping.scale, homeImage: [...pointerMapping.homeImage], homeWorld: [...pointerMapping.homeWorld] });
      if (k === 0) calm.setPointerMapping(pointerMapping);
      for (const runtime of [mouse, calm]) {
        if (k % 2 === 0) runtime.pushPointer(sample(now), now);
        runtime.advance(now);
      }
    }
    expect(JSON.stringify(mouse.advance(2600))).toBe(JSON.stringify(calm.advance(2600)));
  });

  it('a hand against the frame edge does not tie on', () => {
    const rig = new Rig();
    rig.run(2000, still(0.67, 0.1));
    expect(rig.phases()).toEqual(['untethered']);
    expect(rig.last.hand.edge).toBe('top');
  });

  it('recalibrate() goes back to untethered with no further physics, and the next tie-on re-homes at the new anchor', () => {
    const rig = tetheredRig(createConfig(), [0.67, 0.5]);
    const steps = rig.runtime.model.stepsTaken;
    rig.runtime.recalibrate();
    rig.run(rig.nowMs + 50, still(0.67, 0.5));
    expect(rig.last.phase).toBe('untethered');
    expect(rig.runtime.model.stepsTaken).toBe(steps);
    rig.run(rig.nowMs + 1500, still(0.4, 0.35));
    expect(rig.last.phase).toBe('tethered');
    expect(rig.last.pivot[0]).toBeCloseTo(rig.config.world.homeX, 2);
    expect(rig.last.pivot[1]).toBeCloseTo(rig.config.world.homeY, 2);
    expect(rig.kinds().filter(k => k === 'tether')).toHaveLength(2);
  });
});

describe('YoyoRuntime: hand presence', () => {
  it('hand-found on the first sample; a frame without the hand says hand-lost once, and the next sample says hand-found', () => {
    const rig = new Rig();
    rig.run(1500, still());
    rig.run(2000, (_t, i) => (i < 46 ? [0.67, 0.4] : null));
    rig.run(2500, () => [0.67, 0.4]);
    const presence = rig.events().filter(e => e.kind === 'hand-found' || e.kind === 'hand-lost').map(e => e.kind);
    expect(presence).toEqual(['hand-found', 'hand-lost', 'hand-found']);
    expect(rig.last.hand.present).toBe(true);
    expect(rig.last.hand.lostMs).toBe(0);
    expect(rig.last.hand.landmarks).toHaveLength(21);
    expect(rig.last.hand.palmWorld).toBeCloseTo(DEFAULT_PALM_SIZE * createConfig().world.scale, 6);
  });

  it('a camera that goes quiet loses the hand once its data is older than staleMs, and lostMs counts from the last sample', () => {
    const rig = new Rig();
    rig.run(1500, still());
    const lastSampleMs = Math.floor((1500 - LATENCY_MS) / FRAME_MS) * FRAME_MS;
    rig.run(2200, () => undefined);
    const lostAt = rig.events().find(e => e.kind === 'hand-lost')!;
    expect(lostAt.timeMs - lastSampleMs).toBeGreaterThan(rig.config.perception.staleMs);
    expect(lostAt.timeMs - lastSampleMs).toBeLessThan(rig.config.perception.staleMs + RENDER_MS);
    expect(rig.events().filter(e => e.kind === 'hand-lost')).toHaveLength(1);
    expect(rig.last.hand.present).toBe(false);
    expect(rig.last.hand.lostMs).toBeCloseTo(rig.last.timeMs - lastSampleMs, 6);
    // Nothing happened to the yoyo: it hangs where it was.
    expect(rig.last.phase).toBe('tethered');
  });

  it('the exit edge is sticky: a hand that leaves through the bottom keeps edge «bottom» until it is found again', () => {
    const rig = tetheredRig(createConfig(), [0.67, 0.4]);
    // Slowly down to the bottom of the frame (0.3 ih/s: no launch), then out.
    const base = rig.frameIndex;
    rig.run(rig.nowMs + 1800, (_t, i) => [0.67, Math.min(0.9, 0.4 + 0.01 * (i - base))]);
    expect(rig.last.hand.edge).toBe('bottom');
    const resumeAt = rig.frameIndex;
    rig.run(rig.nowMs + 600, () => null);
    expect(rig.last.hand.present).toBe(false);
    expect(rig.last.hand.edge).toBe('bottom');
    rig.run(rig.nowMs + 300, (_t, i) => (i < resumeAt + 25 ? null : [0.67, 0.5]));
    expect(rig.last.hand.present).toBe(true);
    expect(rig.last.hand.edge).toBeNull();
  });

  it('diagnostics.lastSampleAgeMs follows the newest sample', () => {
    const rig = new Rig();
    rig.run(0, still());
    expect(rig.last.hand.present).toBe(false);
    expect(rig.runtime.diagnostics.lastSampleAgeMs).toBe(Infinity);
    rig.run(500, still());
    expect(rig.runtime.diagnostics.lastSampleAgeMs).toBeLessThan(FRAME_MS + LATENCY_MS + RENDER_MS);
    rig.run(800, () => undefined);
    expect(rig.runtime.diagnostics.lastSampleAgeMs).toBeGreaterThan(300);
  });
});

describe('YoyoRuntime: bounded input queue', () => {
  it('1000 frames pushed before one advance: the newest 8 are kept, the rest counted, nothing grows', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    for (let i = 0; i < 1000; i++) runtime.pushFrame(frameAt(i * FRAME_MS, 0.67, 0.4), i * FRAME_MS + LATENCY_MS);
    expect(runtime.diagnostics.queuePeak).toBe(MAX_QUEUED_INPUTS);
    expect(runtime.diagnostics.queueDrops).toBe(1000 - MAX_QUEUED_INPUTS);
    const s = runtime.advance(1000 * FRAME_MS + 100);
    expect(s.hand.present).toBe(true);
    // Only the last eight frames were seen: a sample from the 992nd on, never an older one.
    expect(runtime.diagnostics.lastSampleAgeMs).toBeLessThan(100 + 2 * FRAME_MS);
    expect(runtime.diagnostics.queuePeak).toBe(MAX_QUEUED_INPUTS);
  });

  it('the oldest input is the one dropped', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    // Nine frames at 30 fps, then one advance: the first is dropped, so the first sample the runtime sees has t = 33.3.
    for (let i = 0; i < 9; i++) runtime.pushFrame(frameAt(i * FRAME_MS, 0.67, 0.4), i * FRAME_MS + LATENCY_MS);
    expect(runtime.diagnostics.queueDrops).toBe(1);
    const s = runtime.advance(400);
    expect(s.events.some(e => e.kind === 'hand-found')).toBe(true);
    expect(runtime.diagnostics.lastSampleAgeMs).toBeCloseTo(400 - 8 * FRAME_MS, 6);
  });

  it('a long session with frames interleaved with advances never queues more than a couple of inputs', () => {
    const rig = new Rig();
    rig.run(60_000, still());
    expect(rig.runtime.diagnostics.queueDrops).toBe(0);
    expect(rig.runtime.diagnostics.queuePeak).toBeLessThanOrEqual(2);
  });

  it('inputs whose arrival is not a number are ignored (they would block the queue for ever)', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    runtime.pushFrame(frameAt(0, 0.67, 0.4), Number.NaN);
    runtime.pushFrame(frameAt(0, 0.67, 0.4), Infinity);
    expect(runtime.diagnostics.queuePeak).toBe(0);
    runtime.pushFrame(frameAt(0, 0.67, 0.4), 50);
    expect(runtime.advance(100).hand.present).toBe(true);
  });

  it('a camera session ignores pointer samples and a mouse session ignores frames: the two are never mixed', () => {
    const camera = new YoyoRuntime(createConfig(), 'camera');
    const sample: AnchorSample = { timestampMs: 0, arrivalMs: 0, source: 'mouse', x: 0.5, y: 0.5, palmSize: 0, continuous: false };
    camera.pushPointer(sample, 0);
    expect(camera.diagnostics.queuePeak).toBe(0);
    const mouse = new YoyoRuntime(createConfig(), 'mouse');
    mouse.pushFrame(frameAt(0, 0.5, 0.5), 50);
    expect(mouse.diagnostics.queuePeak).toBe(0);
    mouse.pushPointer(sample, 0);
    expect(mouse.diagnostics.queuePeak).toBe(1);
  });
});

describe('YoyoRuntime: pause', () => {
  it('while paused nothing runs and inputs are dropped; on resume no paused time reaches the physics', () => {
    const rig = tetheredRig();
    const stepsBefore = rig.runtime.model.stepsTaken;
    const phaseMsBefore = rig.runtime.model.state.phaseMs;
    const pausedAt = rig.nowMs;
    rig.runtime.pause(true, pausedAt);
    // Frames pushed while paused are discarded, not queued.
    for (let i = 0; i < 20; i++) rig.runtime.pushFrame(frameAt(i, 0.67, 0.5), pausedAt);
    expect(rig.runtime.diagnostics.queueDrops).toBe(0);
    const paused = rig.runtime.advance(pausedAt + 5000);
    expect(paused.paused).toBe(true);
    expect(paused.steps).toBe(0);
    expect(paused.events).toEqual([]);
    expect(rig.runtime.model.stepsTaken).toBe(stepsBefore);

    const resumeAt = pausedAt + 5000;
    rig.runtime.pause(false, resumeAt);
    const resumed = rig.runtime.advance(resumeAt + RENDER_MS);
    expect(resumed.paused).toBe(false);
    expect(resumed.steps).toBe(4);
    expect(resumed.droppedMs).toBe(0);
    expect(rig.runtime.diagnostics.droppedMs).toBe(0);
    expect(rig.runtime.model.stepsTaken).toBe(stepsBefore + 4);
    expect(rig.runtime.model.state.phaseMs - phaseMsBefore).toBeCloseTo(4 * (1000 / 240), 6);
  });

  it('inputs queued before the pause are discarded: they describe a hand that has moved since', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    runtime.advance(0);
    runtime.pushFrame(frameAt(0, 0.67, 0.4), 40);
    runtime.pause(true, 10);
    runtime.pause(false, 20);
    const s = runtime.advance(100);
    expect(s.hand.present).toBe(false);
    expect(s.events).toEqual([]);
  });

  it('after the pause the hand is found again with an event, and the pause itself is not a loss', () => {
    const rig = tetheredRig();
    const lossesBefore = rig.runtime.metrics.snapshot(rig.nowMs).handLosses;
    rig.runtime.pause(true, rig.nowMs);
    // Two seconds of camera frames reach a paused runtime: it drops them.
    rig.run(rig.nowMs + 2000, still(0.67, 0.5));
    expect(rig.last.paused).toBe(true);
    expect(rig.runtime.diagnostics.queueDrops).toBe(0);
    rig.runtime.pause(false, rig.nowMs);
    const eventsBefore = rig.events().length;
    // No frames yet: the hand has to prove itself again, and that is not a loss.
    rig.run(rig.nowMs + 150, () => undefined);
    expect(rig.events().slice(eventsBefore).filter(e => e.kind === 'hand-lost')).toHaveLength(0);
    rig.run(rig.nowMs + 600, still(0.67, 0.5));
    expect(rig.events().slice(eventsBefore).filter(e => e.kind === 'hand-found')).toHaveLength(1);
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(lossesBefore);
    expect(rig.last.phase).toBe('tethered');
  });

  it('pausing before the first advance is harmless', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    runtime.pause(true, 0);
    expect(runtime.advance(500)).toMatchObject({ paused: true, steps: 0, timeMs: 500 });
    runtime.pause(false, 600);
    expect(runtime.advance(600).steps).toBe(0);
    expect(runtime.advance(600 + RENDER_MS).steps).toBe(4);
  });
});

/** Hand still at y = 0.6 until frame 47, then one fast frame (y = 0.72, 3.6 ih/s), then `after`. */
const strokePath = (after: (index: number) => readonly [number, number] | null, x = 0.667): Path => (_t, i) => {
  if (i <= 47) return [x, 0.6];
  if (i === 48) return [x, 0.72];
  return i < 80 ? after(i) : undefined;
};

describe('YoyoRuntime: intents', () => {
  it('a launch completes when the hand leaves through the bottom: the absence is the second fast interval', () => {
    const rig = new Rig();
    rig.run(3000, strokePath(() => null));
    const launch = rig.events().find(e => e.kind === 'launch')!;
    expect(launch).toBeDefined();
    // Caused by the frame without a hand (index 49), fired when it arrived.
    expect(launch.causeMs).toBeCloseTo(49 * FRAME_MS, 6);
    expect(launch.timeMs).toBeGreaterThanOrEqual(49 * FRAME_MS + LATENCY_MS);
    expect(launch.timeMs).toBeLessThan(49 * FRAME_MS + LATENCY_MS + 2 * RENDER_MS);
    expect(launch.strength).toBeCloseTo(3.6, 1);
    expect(rig.intents).toHaveLength(1);
    expect(rig.intents[0]).toMatchObject({ accepted: true, event: { kind: 'launch' } });
    expect(rig.phases().slice(0, 3)).toEqual(['untethered', 'tethered', 'rolling']);
    expect(rig.runtime.metrics.snapshot(3000).launches).toBe(1);
  });

  it('the same stroke with the hand staying in view is only one fast interval: no launch', () => {
    const rig = new Rig();
    rig.run(3000, strokePath(() => [0.667, 0.72]));
    expect(rig.kinds()).toEqual(['tether']);
    expect(rig.intents).toHaveLength(0);
    expect(rig.last.phase).toBe('tethered');
  });

  it('times the reaction from capture to the frame that shows it', () => {
    const rig = new Rig();
    rig.run(3000, strokePath(() => null));
    const k = rig.snapshots.findIndex(s => s.events.some(e => e.kind === 'launch'));
    const launch = rig.snapshots[k].events.find(e => e.kind === 'launch')!;
    const [latency] = rig.runtime.metrics.snapshot(3000).reactionLatencyMs;
    expect(latency).toBeCloseTo(k * RENDER_MS - launch.causeMs!, 6);
    expect(latency).toBeGreaterThanOrEqual(LATENCY_MS);
    expect(latency).toBeLessThan(LATENCY_MS + 2 * RENDER_MS);
  });

  it('an intent the model refuses is counted as ignored and still reported', () => {
    const rig = new Rig();
    vi.spyOn(rig.runtime.model, 'launch').mockReturnValue(false);
    rig.run(3000, strokePath(() => null));
    expect(rig.intents).toHaveLength(1);
    expect(rig.intents[0].accepted).toBe(false);
    expect(rig.runtime.metrics.snapshot(3000).ignoredIntents).toBe(1);
    expect(rig.kinds()).toEqual(['tether']);
    expect(rig.last.phase).toBe('tethered');
  });

  it('while untethered no intent is armed: the stroke that launches a tethered yoyo does nothing to one that never tied on', () => {
    // Inside the zone the yoyo ties on and the stroke launches it…
    const inside = new Rig();
    inside.runtime.setTetherZone(DEFAULT_TETHER_ZONE);
    inside.run(3000, strokePath(() => null));
    expect(inside.kinds()).toContain('launch');
    // …outside it never does, so the very same stroke, with the same quiet before it, is not even classified.
    const outside = new Rig();
    outside.runtime.setTetherZone(DEFAULT_TETHER_ZONE);
    outside.run(3000, strokePath(() => null, 0.2));
    expect(outside.intents).toHaveLength(0);
    expect(outside.kinds()).toEqual([]);
    expect(outside.last.phase).toBe('untethered');
    expect(outside.runtime.model.stepsTaken).toBe(0);
  });

  /**
   * The same four frames of a downward stroke, delivered promptly or ten frames late. The extractor judges
   * continuity by capture time, so the late ones are a perfectly good continuation of the still hand; only
   * their age tells them apart.
   */
  function strokeDeliveredAfter(delayMs: number): Rig {
    const rig = new Rig();
    rig.run(1500, still(0.667, 0.5));
    expect(rig.last.phase).toBe('tethered');
    const first = rig.frameIndex;
    // Frames `first` … `first + 3`: still, fast, fast, stopped.
    const ys = [0.5, 0.62, 0.74, 0.74];
    ys.forEach((y, k) => {
      const capture = (first + k) * FRAME_MS;
      rig.runtime.pushFrame(frameAt(capture, 0.667, y), capture + delayMs);
    });
    rig.frameIndex = first + ys.length;
    rig.run(3000, () => undefined);
    return rig;
  }

  it('control: the stroke delivered with the normal delay launches', () => {
    const rig = strokeDeliveredAfter(LATENCY_MS);
    expect(rig.kinds()).toContain('launch');
  });

  it('stale data never arms an intent: the same stroke arriving 600 ms late fires nothing and moves nothing', () => {
    const rig = strokeDeliveredAfter(600);
    expect(rig.intents).toHaveLength(0);
    expect(rig.kinds()).toEqual(['tether']);
    expect(rig.last.phase).toBe('tethered');
    // Old data never makes the hand present, not even for the instant it is handled: the only hand-found is the first one.
    expect(rig.events().filter(e => e.kind === 'hand-found')).toHaveLength(1);
    // The data was already old on arrival: the hand never counts as present while it is processed, and the pivot gets no force.
    const late = rig.snapshots.filter(s => s.timeMs > 2100 && s.timeMs < 2300);
    expect(late.length).toBeGreaterThan(5);
    for (const s of late) {
      expect(s.hand.present).toBe(false);
      expect(s.pivotVelocity).toEqual([0, 0]);
    }
  });

  it('after the hand was lost, a fresh stroke cannot launch at once: the first sample is a new start with no history', () => {
    const rig = tetheredRig(createConfig(), [0.667, 0.5]);
    const start = rig.frameIndex;
    rig.run(rig.nowMs + 600, () => undefined);
    const back = rig.frameIndex;
    expect(back - start).toBeGreaterThan(10);
    rig.run(rig.nowMs + 1000, (_t, i) => [0.667, Math.min(0.78, 0.5 + 0.12 * (i - back))]);
    expect(rig.intents).toHaveLength(0);
    expect(rig.last.phase).toBe('tethered');
  });
});

describe('YoyoRuntime: the whole round trip on a perfect camera', () => {
  it('walks tethered → rolling → sleeping → returning → caught → tethered and counts what happened', () => {
    const scene = sessionScene([
      { kind: 'appear', at: [0.667, 0.32], holdMs: 1100 },
      { kind: 'launch', peak: 2.5 },
      { kind: 'hold', ms: 2500 },
      { kind: 'tug', peak: 1.3 },
      { kind: 'hold', ms: 2800 },
    ], { leadMs: 300 });
    const clip = renderCleanSession(scene);
    const rig = new Rig();
    let next = 0;
    for (; rig.nowMs <= clip.durationMs + 600; rig.tick++) {
      while (next < clip.frames.length && clip.frames[next].arrivalMs <= rig.nowMs) rig.runtime.pushFrame(clip.frames[next].frame, clip.frames[next++].arrivalMs);
      rig.snapshots.push(rig.runtime.advance(rig.nowMs));
    }
    expect(rig.phases()).toEqual(['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'tethered']);
    expect(rig.kinds()).toEqual(['tether', 'launch', 'snap', 'tug', 'catch', 'retether']);
    const m = rig.runtime.metrics.snapshot(rig.nowMs);
    expect(m).toMatchObject({ launches: 1, tugs: 1, catches: 1, tugSuccessRate: 1, ignoredIntents: 0 });
    expect(m.reactionLatencyMs).toHaveLength(2);
    for (const latency of m.reactionLatencyMs) {
      expect(latency).toBeGreaterThanOrEqual(LATENCY_MS);
      expect(latency).toBeLessThan(LATENCY_MS + 3 * FRAME_MS);
    }
  });
});

describe('YoyoRuntime: hand losses in the metrics', () => {
  /** Frames `from`…`to` (inclusive) are missing from the camera; the rest show the hand. */
  const withoutFrames = (from: number, to: number): Path => (_t, i) => (i >= from && i <= to ? undefined : [0.667, 0.5]);

  it('a camera stall flickers the hand (events) but is not a loss (metrics): physics stops, the count does not move', () => {
    const rig = tetheredRig();
    const gapFrom = rig.frameIndex + 5;
    // Five frames in a row go missing: the newest sample is older than perception.staleMs when the next arrives.
    rig.run(rig.nowMs + 1500, withoutFrames(gapFrom, gapFrom + 4));
    const flicker = rig.events().filter(e => e.kind === 'hand-lost' || e.kind === 'hand-found').map(e => e.kind);
    expect(flicker).toEqual(['hand-found', 'hand-lost', 'hand-found']);
    const lost = rig.events().find(e => e.kind === 'hand-lost')!, found = rig.events().filter(e => e.kind === 'hand-found')[1];
    expect(found.timeMs - lost.timeMs).toBeLessThan(MIN_HAND_LOSS_MS / 2);
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(0);
    // Physics behaved: for those frames the pivot was frozen with exactly zero velocity.
    expect(rig.snapshots.some(s => !s.hand.present && s.pivotVelocity[0] === 0 && s.pivotVelocity[1] === 0)).toBe(true);
  });

  it('a real loss counts once it has lasted MIN_HAND_LOSS_MS, while it is still going on, and stays one when the hand comes back', () => {
    const rig = tetheredRig();
    const lostFrom = rig.frameIndex + 3;
    const backAt = lostFrom + 45; // 1.5 s without a hand
    const lostMs = lostFrom * FRAME_MS + LATENCY_MS;
    rig.run(lostMs + 100, (_t, i) => (i >= lostFrom ? null : [0.667, 0.5]));
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(0);
    rig.run(lostMs + MIN_HAND_LOSS_MS + 100, (_t, i) => (i >= lostFrom ? null : [0.667, 0.5]));
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(1);
    rig.run(lostMs + 1200, (_t, i) => (i >= lostFrom ? null : [0.667, 0.5]));
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(1);
    rig.run(lostMs + 3000, (_t, i) => (i >= lostFrom && i < backAt ? null : [0.667, 0.5]));
    expect(rig.last.hand.present).toBe(true);
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(1);
  });

  it('losses and flickers mix: only the real losses are counted, the events still report every one', () => {
    const rig = tetheredRig();
    const at = rig.frameIndex;
    const path: Path = (_t, i) => {
      if (i >= at + 5 && i <= at + 9) return undefined; // flicker
      if (i >= at + 30 && i < at + 60) return null; // 1 s without the hand
      if (i >= at + 90 && i <= at + 94) return undefined; // flicker
      if (i >= at + 120 && i < at + 126) return null; // 0.2 s: still a flicker for the count
      return [0.667, 0.5];
    };
    rig.run(rig.nowMs + 6000, path);
    expect(rig.events().filter(e => e.kind === 'hand-lost').length).toBe(4);
    expect(rig.runtime.metrics.snapshot(rig.nowMs).handLosses).toBe(1);
  });
});

describe('YoyoRuntime: peak yoyo speed of the last advance', () => {
  it('is 0 while the yoyo is not tied on, while paused and when no step ran; it is part of the diagnostics but not of the panel contract', () => {
    const rig = new Rig();
    rig.run(300, still());
    expect(rig.runtime.diagnostics.lastAdvancePeakSpeed).toBe(0);
    const panel: RuntimeDiagnostics = rig.runtime.diagnostics;
    expect(panel.queueDrops).toBe(0);
    const stepless = rig.runtime.advance(rig.last.timeMs + 1);
    expect(stepless.steps).toBe(0);
    expect(rig.runtime.diagnostics.lastAdvancePeakSpeed).toBe(0);
    rig.runtime.pause(true, rig.nowMs);
    rig.runtime.advance(rig.nowMs + 1000);
    expect(rig.runtime.diagnostics.lastAdvancePeakSpeed).toBe(0);
  });

  /** A perfect-camera session that throws and lets the yoyo sleep: the frames where the yoyo moves fast. */
  const throwClip = () => renderCleanSession(sessionScene([
    { kind: 'appear', at: [0.667, 0.32], holdMs: 1100 },
    { kind: 'launch', peak: 2.5 },
    { kind: 'hold', ms: 1500 },
  ], { leadMs: 300 }));

  it('is the fastest the yoyo moved at any physics step of the frame: the same as stepping one 240 Hz step at a time', () => {
    const clip = throwClip();
    const coarse = new YoyoRuntime(createConfig(), 'replay');
    const fine = new YoyoRuntime(createConfig(), 'replay');
    const stepMs = 1000 / 240;
    let nextCoarse = 0, nextFine = 0;
    let fineMs = 0;
    let previousSpeed = 0;
    let checked = 0, insideFrame = 0;
    for (let k = 0; k * RENDER_MS <= clip.durationMs + 300; k++) {
      const now = k * RENDER_MS;
      while (nextCoarse < clip.frames.length && clip.frames[nextCoarse].arrivalMs <= now) coarse.pushFrame(clip.frames[nextCoarse].frame, clip.frames[nextCoarse++].arrivalMs);
      const endCoarse = coarse.advance(now);
      const peak = coarse.diagnostics.lastAdvancePeakSpeed;

      // The same frame, one step per advance (asked a hair past each step boundary, so exactly one step is due):
      // its largest speed is the peak, counting the speed it started with.
      let expected = previousSpeed;
      if (k === 0) fine.advance(0);
      for (let j = 1; j <= 4 && k > 0; j++) {
        const t = fineMs + stepMs * 1.0000001;
        while (nextFine < clip.frames.length && clip.frames[nextFine].arrivalMs <= t) fine.pushFrame(clip.frames[nextFine].frame, clip.frames[nextFine++].arrivalMs);
        const s = fine.advance(t);
        expect(s.steps).toBe(1);
        fineMs = s.timeMs;
        expected = Math.max(expected, Math.hypot(s.yoyoVelocity[0], s.yoyoVelocity[1]));
      }
      if (k > 0 && endCoarse.steps === 4) {
        expect(peak).toBeCloseTo(expected, 9);
        checked++;
        // The point of the diagnostic: somewhere the speed peaks inside a frame, above both of its end speeds.
        if (peak > Math.max(previousSpeed, Math.hypot(endCoarse.yoyoVelocity[0], endCoarse.yoyoVelocity[1])) + 1e-6) insideFrame++;
      }
      previousSpeed = Math.hypot(endCoarse.yoyoVelocity[0], endCoarse.yoyoVelocity[1]);
    }
    expect(checked).toBeGreaterThan(100);
    expect(insideFrame).toBeGreaterThan(0);
  });

  it('bounds how far the yoyo moves between two snapshots: peak × the time of the frame\'s steps, to a millimetre, through a throw, the snap and the sleep', () => {
    const clip = throwClip();
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    let next = 0;
    let previous: YoyoSnapshot | null = null;
    let worst = -Infinity;
    for (let k = 0; k * RENDER_MS <= clip.durationMs + 300; k++) {
      const now = k * RENDER_MS;
      while (next < clip.frames.length && clip.frames[next].arrivalMs <= now) runtime.pushFrame(clip.frames[next].frame, clip.frames[next++].arrivalMs);
      const s = runtime.advance(now);
      if (previous && previous.phase !== 'untethered' && s.phase !== 'untethered') {
        const moved = Math.hypot(s.yoyo[0] - previous.yoyo[0], s.yoyo[1] - previous.yoyo[1]);
        worst = Math.max(worst, moved - runtime.diagnostics.lastAdvancePeakSpeed * (s.steps / createConfig().sim.hz));
      }
      previous = s;
    }
    expect(worst).toBeLessThanOrEqual(0.001);
  });
});

describe('YoyoRuntime: the mouse path', () => {
  const mapping = { scale: 1.5, homeImage: [0.5, 0.5] as const, homeWorld: [0.1, 0.9] as const };

  /** 30 Hz pointer samples, as the driver delivers them. */
  function pointerSample(t: number, x: number, y: number, continuous: boolean): AnchorSample {
    return { timestampMs: t, arrivalMs: t, source: 'mouse', x, y, palmSize: 0, continuous };
  }

  it('ties on with the pointer mapping (never re-homed) and has no landmarks', () => {
    const runtime = new YoyoRuntime(createConfig(), 'mouse');
    runtime.setPointerMapping(mapping);
    let s!: YoyoSnapshot;
    let next = 0;
    for (let k = 0; k * RENDER_MS <= 1500; k++) {
      const now = k * RENDER_MS;
      for (; next * FRAME_MS <= now; next++) runtime.pushPointer(pointerSample(next * FRAME_MS, 0.8, 0.3, next > 0), next * FRAME_MS);
      s = runtime.advance(now);
    }
    expect(s.phase).toBe('tethered');
    // With the app's pointer mapping the pivot is where that mapping puts the pointer, not at the world home.
    const world = toWorld(mapping, 0.8, 0.3);
    expect(s.pivot[0]).toBeCloseTo(world[0], 2);
    expect(s.pivot[1]).toBeCloseTo(world[1], 2);
    expect(Math.hypot(s.pivot[0] - createConfig().world.homeX, s.pivot[1] - createConfig().world.homeY)).toBeGreaterThan(0.3);
    expect(s.hand.landmarks).toBeNull();
    expect(s.hand.palmWorld).toBe(0);
    expect(s.hand.edge).toBeNull();
  });

  it('a released button is an absent hand', () => {
    const runtime = new YoyoRuntime(createConfig(), 'mouse');
    runtime.pushPointer(pointerSample(0, 0.5, 0.5, false), 0);
    expect(runtime.advance(16).hand.present).toBe(true);
    runtime.pushPointer(null, 40);
    const s = runtime.advance(60);
    expect(s.hand.present).toBe(false);
    expect(s.events.map(e => e.kind)).toEqual(['hand-lost']);
  });
});
describe('YoyoRuntime: live tuning', () => {
  it('a shorter staleMs loses a silent hand sooner', () => {
    const lostAfter = (config: YoyoConfig): number => {
      const rig = new Rig(config);
      rig.run(1000, still());
      const lastSample = Math.floor((1000 - LATENCY_MS) / FRAME_MS) * FRAME_MS;
      rig.run(2000, () => undefined);
      return rig.events().find(e => e.kind === 'hand-lost')!.timeMs - lastSample;
    };
    expect(lostAfter(setConfigValue(createConfig(), 'perception.staleMs', 80))).toBeLessThan(lostAfter(createConfig()) - 90);
  });

  it('setConfig reaches the running parts: a new step rate changes the steps per frame without a jump in time', () => {
    const rig = tetheredRig();
    const before = rig.last;
    expect(before.steps).toBe(4);
    const faster = createConfig();
    faster.sim.hz = 120;
    rig.runtime.setConfig(faster);
    rig.run(rig.nowMs + 100, still(0.667, 0.5));
    expect(rig.last.steps).toBe(2);
    expect(rig.last.timeMs).toBeGreaterThan(before.timeMs);
    expect(rig.last.timeMs).toBeLessThanOrEqual(rig.nowMs);
  });

  it('a config that cannot work throws before changing anything', () => {
    const rig = tetheredRig();
    const broken = setConfigValue(createConfig(), 'world.scale', 0);
    expect(() => rig.runtime.setConfig(broken)).toThrow(RangeError);
    const slow = createConfig();
    slow.sim.hz = 0;
    expect(() => rig.runtime.setConfig(slow)).toThrow(RangeError);
    rig.run(rig.nowMs + 200, still(0.667, 0.5));
    expect(rig.last.phase).toBe('tethered');
    expect(rig.last.steps).toBe(4);
    expect(rig.runtime.advance(rig.nowMs).responsiveness).toBe('responsive');
  });

  it('a tuning edit that does not touch the world leaves the pivot alone', () => {
    const control = tetheredRig();
    const tuned = tetheredRig();
    tuned.runtime.setConfig(setConfigValue(createConfig(), 'launch.minDownSpeed', 1.5));
    control.run(control.nowMs + 600, still(0.667, 0.5));
    tuned.run(tuned.nowMs + 600, still(0.667, 0.5));
    expect(Math.hypot(tuned.last.pivot[0] - control.last.pivot[0], tuned.last.pivot[1] - control.last.pivot[1])).toBeLessThan(0.002);
  });

  it('responsiveness is read live: an unresponsive yoyo does not arm the tug', () => {
    const rig = new Rig(createConfig());
    expect(rig.runtime.advance(0).responsiveness).toBe('responsive');
    const unresponsive = createConfig();
    unresponsive.responsiveness = 'unresponsive';
    rig.runtime.setConfig(unresponsive);
    expect(rig.runtime.advance(RENDER_MS).responsiveness).toBe('unresponsive');
  });
});

describe('YoyoRuntime: snapshots and determinism', () => {
  it('a snapshot never changes after it is returned', () => {
    const rig = new Rig();
    rig.run(1500, still());
    const k = rig.snapshots.findIndex(s => s.events.some(e => e.kind === 'tether'));
    const early = rig.snapshots[k];
    const frozen = JSON.stringify(early);
    rig.run(4000, (_t, i) => [0.67 + 0.001 * i, 0.4]);
    expect(JSON.stringify(early)).toBe(frozen);
  });

  it('the same inputs give bit-identical snapshots', () => {
    const run = () => {
      const rig = new Rig();
      rig.run(3000, (_t, i) => (i < 60 ? [0.667, 0.5] : i === 60 ? [0.667, 0.62] : [0.667, 0.74]));
      return JSON.stringify(rig.snapshots);
    };
    expect(run()).toBe(run());
  });

  it('metrics start with the session: the first advance is its origin', () => {
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    runtime.advance(5000);
    runtime.advance(6000);
    expect(runtime.metrics.snapshot(6000).sessionMs).toBe(1000);
  });
});

describe('the core reads no clock and draws no random numbers', () => {
  for (const file of ['YoyoRuntime.ts', 'TetherDetector.ts', '../replay/sessions.ts']) {
    it(`${file}: all time comes in as an argument`, () => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/Math\.random|Date\.now|performance\.now|new Date\(/);
    });
  }
});
