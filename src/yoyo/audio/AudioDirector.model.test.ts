import { describe, expect, it } from 'vitest';
import { createConfig } from '../config';
import type { PinState, YoyoEvent, YoyoSnapshot } from '../contracts';
import { YoyoModel } from '../sim/YoyoModel';
import {
  AudioDirector, HUM_GAIN_MAX, HUM_SPIN_FULL, humFrequencyHz, humGain, MAX_ONE_SHOT_VOICES, ONE_SHOT_PROFILES,
} from './AudioDirector';
import { buildSnapshot } from './snapshots';
import type { DirectorFrame, OneShotKind } from './types';

/**
 * The director against the real reduced model: the spin range it assumes (a fresh sleeper lands at
 * 400–770 rad/s and decays with τ 4 s) and the events it reacts to come from YoyoModel, not from
 * numbers typed into a test. If the model's launch band or event set changes, this is what says the
 * audio mapping needs another look.
 */

const STEP_S = 1 / 240;
const STEPS_PER_FRAME = 4;
const PIVOT: PinState = { x: 0, y: 0.85, vx: 0, vy: 0 };

interface Frame {
  timeMs: number;
  snapshot: YoyoSnapshot;
  out: DirectorFrame;
}

/** Drives a model and a director the way the engine would: 60 Hz frames, events delivered once. */
function run(launchStrength: number, tugStrength: number, sleepSeconds: number) {
  const model = new YoyoModel(createConfig());
  const director = new AudioDirector();
  director.setUnlocked(true);
  const frames: Frame[] = [];
  const events: YoyoEvent[] = [];
  let timeMs = 0;

  const frame = () => {
    const state = model.state;
    const snapshot = buildSnapshot({
      timeMs, phase: state.phase, spin: state.spin, length: state.length, events: events.splice(0, events.length),
    });
    frames.push({ timeMs, snapshot, out: director.update(snapshot, timeMs) });
  };
  const advance = (seconds: number, until?: () => boolean) => {
    for (let i = 0; i < Math.round(seconds * 60); i += 1) {
      for (let k = 0; k < STEPS_PER_FRAME; k += 1) {
        timeMs += STEP_S * 1000;
        model.step(STEP_S, { pin: PIVOT, handPresent: true }, timeMs, events);
      }
      frame();
      if (until?.()) return;
    }
  };

  model.tether(PIVOT, timeMs, events);
  frame();
  advance(0.5);
  model.launch(launchStrength, timeMs, timeMs, events);
  advance(2, () => model.state.phase === 'sleeping');
  const snapAt = frames.length - 1;
  advance(sleepSeconds);
  model.tug(tugStrength, timeMs, timeMs, events);
  advance(3, () => model.state.phase === 'tethered');
  advance(0.3);
  return { frames, snapAt, director };
}

const soundsOf = (frames: Frame[]): OneShotKind[] => frames.flatMap((f) => f.out.oneShots.map((c) => c.kind));

describe('AudioDirector on the real YoyoModel', () => {
  const { frames, snapAt, director } = run(2.4, 1.5, 3);

  it('plays the throw in order: tie-on, whoosh, snap, zip, catch, tie-on', () => {
    expect(soundsOf(frames)).toEqual(['tether', 'whoosh', 'snap', 'zip', 'catch', 'tether']);
    expect(director.stats.rateLimited).toBe(0);
    expect(director.stats.capped).toBe(0);
    expect(director.stats.stale).toBe(0);
  });

  it('puts every sound on the frame of its event', () => {
    for (const f of frames) {
      const kinds = f.out.oneShots.map((c) => c.kind);
      if (f.snapshot.events.some((e) => e.kind === 'launch')) expect(kinds).toContain('whoosh');
      if (f.snapshot.events.some((e) => e.kind === 'snap')) expect(kinds).toContain('snap');
      if (f.snapshot.events.some((e) => e.kind === 'catch')) expect(kinds).toContain('catch');
      if (f.snapshot.events.length === 0) expect(kinds).toEqual([]);
    }
  });

  it('hums while the yoyo spins free, and not while it hangs on the finger', () => {
    const humFrames = frames.filter((f) => f.out.hum !== null);
    const firstHum = humFrames[0];
    const launch = frames.find((f) => f.snapshot.events.some((e) => e.kind === 'launch'))!;
    expect(firstHum.timeMs).toBe(launch.timeMs);
    expect(firstHum.out.hum?.active).toBe(true);
    // Every frame before the launch is silent, and the hum is switched off once it is back on the finger.
    for (const f of frames.filter((x) => x.timeMs < launch.timeMs)) expect(f.out.hum).toBeNull();
    const last = humFrames[humFrames.length - 1];
    expect(last.out.hum?.active).toBe(false);
    expect(last.snapshot.phase === 'caught' || last.snapshot.phase === 'tethered').toBe(true);
    expect(humFrames.filter((f) => f.out.hum?.active === false)).toHaveLength(1);
  });

  it('puts the fresh sleeper where the mapping expects it: at or near the full hum level and the A3 range', () => {
    const snap = frames[snapAt];
    expect(snap.snapshot.spin).toBeGreaterThan(380);
    expect(snap.snapshot.spin).toBeLessThan(800);
    expect(humGain(snap.snapshot.spin)).toBeGreaterThan(0.85 * HUM_GAIN_MAX);
    const hz = humFrequencyHz(snap.snapshot.spin);
    expect(hz).toBeGreaterThan(humFrequencyHz(380));
    expect(hz).toBeLessThan(humFrequencyHz(HUM_SPIN_FULL) + 10);
  });

  it('lets the sleeper hum fall in pitch and level as its spin decays', () => {
    const sleeping = frames.filter((f) => f.snapshot.phase === 'sleeping' && f.out.hum?.active === true);
    expect(sleeping.length).toBeGreaterThan(50);
    for (let i = 1; i < sleeping.length; i += 1) {
      expect(sleeping[i].out.hum!.frequencyHz).toBeLessThanOrEqual(sleeping[i - 1].out.hum!.frequencyHz);
      expect(sleeping[i].out.hum!.gain).toBeLessThanOrEqual(sleeping[i - 1].out.hum!.gain);
    }
    expect(sleeping[sleeping.length - 1].out.hum!.frequencyHz).toBeLessThan(sleeping[0].out.hum!.frequencyHz - 5);
  });

  it('never asks for more than a voice ceiling, and never more than the cap at once', () => {
    for (const f of frames) {
      expect(f.out.oneShots.length).toBeLessThanOrEqual(MAX_ONE_SHOT_VOICES);
      for (const c of f.out.oneShots) expect(c.gain).toBeLessThanOrEqual(ONE_SHOT_PROFILES[c.kind].gainMax);
      if (f.out.hum) expect(f.out.hum.gain).toBeLessThanOrEqual(HUM_GAIN_MAX);
    }
  });

  it('sizes the zip to the ascent the model then performs', () => {
    const tugFrame = frames.find((f) => f.snapshot.events.some((e) => e.kind === 'tug'))!;
    const catchFrame = frames.find((f) => f.snapshot.events.some((e) => e.kind === 'catch'))!;
    const zip = tugFrame.out.oneShots.find((c) => c.kind === 'zip')!;
    const climbS = (catchFrame.timeMs - tugFrame.timeMs) / 1000;
    // The sweep is within a factor of two of the real climb: it ends about when the catch lands.
    expect(zip.durationS).toBeGreaterThan(climbS / 2);
    expect(zip.durationS).toBeLessThan(climbS * 2);
  });
});

describe('AudioDirector on the real model: other throws', () => {
  it('follows throw strength: a hard throw whooshes louder than a soft one', () => {
    const gainOf = (strength: number) => run(strength, 1.5, 0.5).frames.flatMap((f) => f.out.oneShots).find((c) => c.kind === 'whoosh')!.gain;
    expect(gainOf(3.2)).toBeGreaterThan(gainOf(1.3));
  });

  it('stays quiet and silent through a model that is never thrown: 10 s tied on', () => {
    const model = new YoyoModel(createConfig());
    const director = new AudioDirector();
    director.setUnlocked(true);
    const events: YoyoEvent[] = [];
    model.tether(PIVOT, 0, events);
    let timeMs = 0;
    let commands = 0;
    for (let i = 0; i < 600; i += 1) {
      for (let k = 0; k < STEPS_PER_FRAME; k += 1) {
        timeMs += STEP_S * 1000;
        model.step(STEP_S, { pin: PIVOT, handPresent: true }, timeMs, events);
      }
      const snapshot = buildSnapshot({ timeMs, phase: model.state.phase, spin: model.state.spin, events: events.splice(0, events.length) });
      const out = director.update(snapshot, timeMs);
      commands += out.oneShots.length + (out.hum ? 1 : 0);
    }
    // Only the tie-on click, played once; no hum.
    expect(commands).toBe(1);
  });
});
