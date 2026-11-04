import { describe, expect, it } from 'vitest';
import { framingZone } from '../app/framing';
import { DEFAULT_HOME_IMAGE, DEFAULT_TETHER_ZONE } from '../app/TetherDetector';
import { createConfig, setConfigValue } from '../config';
import type { Vec2 } from '../contracts';
import { MouseDriver, runPointerScript, type PointerRect } from '../input/MouseDriver';
import { IMAGE_ASPECT } from './handPose';
import { parseReplay, replayFrames, serializeReplay } from './replayFile';
import {
  buildDemoSession, buildQaCameraSession, DEMO_PHASES, DEMO_PROMISE, DEMO_SEED, demoPhasesOf, demoSessionScene, FOLLOW_THROUGH_TAG, LOST_BELOW_Y,
  pointerScriptFromScene, QA_EVENTS, QA_PHASES, QA_SEED, qaCheckTake, qaSessionScene, renderCleanSession, renderDemoTake, renderQaTake, renderSession, replayClip,
  sessionScene, toReplayFile, walksBothRounds,
  type SessionStep,
} from './sessions';
import { flick, FRAME_MS, labelOf, stroke } from './synthetic';

/**
 * Play-session DSL, SYNTHETIC: scenes, their ground truth, their camera rendering and their mouse
 * script. Whether the runtime does the right thing with them is scenarios.test.ts.
 */

const RECT: PointerRect = { left: 100, top: 50, width: 1280, height: 720 };
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('sessionScene: the path', () => {
  const steps: SessionStep[] = [
    { kind: 'appear', at: [0.6, 0.3], holdMs: 1000 },
    { kind: 'launch', peak: 2, riseMs: 60, plateauMs: 80, fallMs: 100, reboundUp: 0.02 },
    { kind: 'hold', ms: 1500 },
    { kind: 'tug', peak: 1.2, durationMs: 160 },
    { kind: 'hold', ms: 500 },
  ];

  it('is deterministic: the same steps and options give the same path, labels and absences', () => {
    const a = sessionScene(steps, { leadMs: 300 }), b = sessionScene(steps, { leadMs: 300 });
    for (let t = 0; t < a.durationMs; t += 37) expect(a.anchorAt(t)).toEqual(b.anchorAt(t));
    expect(JSON.stringify(a.labels)).toBe(JSON.stringify(b.labels));
    expect(a.absences).toEqual(b.absences);
    expect(a.durationMs).toBe(b.durationMs);
  });

  it('appear fixes where the hand starts and hold keeps it there', () => {
    const scene = sessionScene(steps, { leadMs: 300 });
    for (const t of [0, 300, 700, 1299]) expect(scene.anchorAt(t)).toEqual([0.6, 0.3]);
  });

  it('a launch moves the hand down by the stroke length and back up by the rebound, and labels the stroke', () => {
    const scene = sessionScene(steps, { leadMs: 300 });
    const startMs = 300 + 1000;
    const strokeLength = (2 * (0.5 * 60 + 80 + 0.5 * 100)) / 1000;
    // Stroke ends at start + 240 ms; the rebound starts 20 ms later and takes 160 ms.
    expect(scene.anchorAt(startMs + 240)[1]).toBeCloseTo(0.3 + strokeLength, 9);
    expect(scene.anchorAt(startMs + 240 + 20 + 160)[1]).toBeCloseTo(0.3 + strokeLength - 0.02, 9);
    expect(scene.anchorAt(startMs + 240 + 20 + 160)[0]).toBeCloseTo(0.6, 9);
    const [launch] = scene.labels;
    const reference = labelOf('launch', stroke(startMs, 60, 80, 100, 2, [0, 1]), startMs);
    expect(launch).toEqual(reference);
    expect(launch.peakSpeed).toBe(2);
    expect(launch.onsetMs).toBeGreaterThan(startMs);
    expect(launch.onsetMs).toBeLessThan(startMs + 60);
  });

  it('a tug moves the hand up and is labelled at its onset; labels come out in order', () => {
    const scene = sessionScene(steps, { leadMs: 300 });
    const tugStart = 300 + 1000 + 240 + 20 + 160 + 1500;
    const flickMotion = flick(tugStart, 160, 1.2, [0, -1]);
    const before = scene.anchorAt(tugStart - 1)[1];
    const up = flickMotion.offset(tugStart + 160);
    expect(up[1]).toBeLessThan(-0.05);
    expect(scene.anchorAt(tugStart + 160)[1]).toBeCloseTo(before + up[1], 9);
    expect(scene.labels.map(l => l.kind)).toEqual(['launch', 'tug']);
    expect(scene.labels[1]).toEqual(labelOf('tug', flickMotion, tugStart));
    expect(scene.labels[1].onsetMs).toBeGreaterThan(scene.labels[0].onsetMs);
  });

  it('a wind-up rises first, pauses, and only then does the stroke start', () => {
    const scene = sessionScene([
      { kind: 'appear', at: [0.6, 0.4], holdMs: 500 },
      { kind: 'launch', peak: 2, windup: { rise: 0.05, ms: 200 } },
    ]);
    expect(scene.anchorAt(500 + 200)[1]).toBeCloseTo(0.35, 9);
    // The stroke starts after the wind-up and its pause, so the label's motion start is after both.
    expect(scene.labels[0].motionStartMs).toBeGreaterThan(700);
    expect(scene.anchorAt(scene.labels[0].motionStartMs)[1]).toBeCloseTo(0.35, 9);
  });

  it('move goes to an absolute spot or by an offset; reappear relocates at once, with no frames between', () => {
    const scene = sessionScene([
      { kind: 'appear', at: [0.5, 0.4], holdMs: 100 },
      { kind: 'move', to: [0.8, 0.5], ms: 400 },
      { kind: 'move', delta: [-0.1, 0.05], ms: 400 },
      { kind: 'lose', ms: 300 },
      { kind: 'reappear', offset: [0.2, -0.1] },
      { kind: 'hold', ms: 200 },
    ]);
    expect(scene.anchorAt(500)).toEqual([0.8, 0.5]);
    expect(scene.anchorAt(900)[0]).toBeCloseTo(0.7, 9);
    expect(scene.anchorAt(900)[1]).toBeCloseTo(0.55, 9);
    // During the loss the hand has not moved; the instant it is back, it is 0.2 right and 0.1 up from where it was lost.
    expect(scene.anchorAt(1199)[0]).toBeCloseTo(0.7, 9);
    expect(scene.anchorAt(1200)[0]).toBeCloseTo(0.9, 9);
    expect(scene.anchorAt(1200)[1]).toBeCloseTo(0.45, 9);
    expect(scene.absences).toEqual([{ startMs: 900, endMs: 1200, exit: false }]);
  });

  it('casual motions: a wave returns the hand to its place within its amplitude, a circle keeps its radius, a drift keeps its speed', () => {
    const scene = sessionScene([
      { kind: 'appear', at: [0.6, 0.4], holdMs: 0 },
      { kind: 'casual', motion: 'wave', ms: 2000, amplitude: 0.08, freqHz: 2.5 },
      { kind: 'casual', motion: 'circle', ms: 3000, amplitude: 0.1, freqHz: 0.5 },
      { kind: 'casual', motion: 'drift', ms: 2000, speed: 0.25, angleDeg: 0 },
    ]);
    let waveMax = 0;
    for (let t = 0; t < 2000; t += 5) waveMax = Math.max(waveMax, Math.abs(scene.anchorAt(t)[0] - 0.6));
    expect(waveMax).toBeGreaterThan(0.06);
    expect(waveMax).toBeLessThanOrEqual(0.08 + 1e-9);
    expect(scene.anchorAt(2000)[0]).toBeCloseTo(0.6, 9);
    // Mid-circle (full amplitude): the distance from the centre is the radius.
    expect(dist(scene.anchorAt(3500), [0.6, 0.4])).toBeCloseTo(0.1, 6);
    // The drift covers 0.25 ih/s: after its ramps, 0.25 ih per second.
    const before = scene.anchorAt(5400)[0], after = scene.anchorAt(6400)[0];
    expect(after - before).toBeCloseTo(0.25, 6);
  });

  it('a session with no appear starts at the default home; the lead is an absence', () => {
    const scene = sessionScene([{ kind: 'hold', ms: 500 }], { leadMs: 250 });
    expect(scene.anchorAt(0)).toEqual(DEFAULT_HOME_IMAGE);
    expect(scene.absences).toEqual([{ startMs: 0, endMs: 250, exit: false }]);
    expect(scene.durationMs).toBe(250 + 500 + 300);
  });

  it('sway: the option runs from t = 0, the step starts at the cursor and fades in', () => {
    const swayed = sessionScene([{ kind: 'appear', at: [0.6, 0.4], holdMs: 2000 }], { sway: { amplitude: 0.03, freqHz: 1, phase: Math.PI / 2 } });
    expect(swayed.anchorAt(0)[0]).toBeCloseTo(0.63, 9);
    const fadingIn = sessionScene([
      { kind: 'appear', at: [0.6, 0.4], holdMs: 1000 },
      { kind: 'sway', spec: { amplitude: 0.03, freqHz: 1, phase: Math.PI / 2 } },
      { kind: 'hold', ms: 2000 },
    ]);
    expect(fadingIn.anchorAt(999)[0]).toBe(0.6);
    expect(fadingIn.anchorAt(1000)[0]).toBe(0.6);
    // After the fade-in the sway is in full.
    expect(Math.abs(fadingIn.anchorAt(2000)[0] - 0.6)).toBeGreaterThan(0.025);
  });
});

describe('sessionScene: losing the hand through the bottom', () => {
  const scene = sessionScene([
    { kind: 'appear', at: [0.6, 0.35], holdMs: 500 },
    { kind: 'lose', ms: 500, exit: { speed: 1, returnMs: 600 } },
    { kind: 'hold', ms: 500 },
  ], { leadMs: 200 });

  it('the hand goes out of the frame, stays out, and comes back to where it was', () => {
    const [, exit] = scene.absences;
    expect(exit.exit).toBe(true);
    expect(scene.anchorAt(exit.startMs + 1)[1]).toBeGreaterThanOrEqual(LOST_BELOW_Y);
    // Out of the frame at the bottom while it waits.
    const waiting = scene.absences[1].startMs + 400;
    expect(scene.anchorAt(waiting)[1]).toBeGreaterThan(1.1);
    expect(scene.anchorAt(scene.durationMs - 1)[1]).toBeCloseTo(0.35, 9);
  });

  it('the absence spans from the hand crossing below the frame to its return, and is longer than the time it waited out', () => {
    const exit = scene.absences[1];
    expect(exit.endMs - exit.startMs).toBeGreaterThan(500);
    expect(scene.anchorAt(exit.startMs - 2)[1]).toBeLessThan(LOST_BELOW_Y);
    expect(scene.anchorAt(exit.endMs)[1]).toBeLessThan(LOST_BELOW_Y);
  });

  it('the camera really loses the hand there: the first hand-less frame is where the absence starts', () => {
    const clip = renderSession(scene, 4);
    const exit = scene.absences[1];
    const firstEmpty = clip.frames.find(f => f.frame.timestampMs > 300 && f.frame.hands.length === 0)!;
    // Both are about where the wrist crosses the bottom of the image; the camera's own rule and the script's differ by the hand's size.
    expect(Math.abs(firstEmpty.frame.timestampMs - exit.startMs)).toBeLessThan(250);
  });
});

describe('renderSession and renderCleanSession', () => {
  const scene = sessionScene([
    { kind: 'appear', at: [0.6, 0.35], holdMs: 800 },
    { kind: 'lose', ms: 400 },
    { kind: 'hold', ms: 800 },
    { kind: 'launch', peak: 2.2 },
    { kind: 'hold', ms: 500 },
  ], { leadMs: 300, palmSize: 0.2, handedness: 'Left' });

  it('is deterministic in (scene, seed) and the seed changes the noise', () => {
    const a = renderSession(scene, 11), b = renderSession(scene, 11), c = renderSession(scene, 12);
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
    expect(JSON.stringify(c.frames)).not.toBe(JSON.stringify(a.frames));
    expect(a.labels).toEqual(scene.labels);
    expect(a.durationMs).toBe(scene.durationMs);
  });

  it('frames inside an absence carry no hand, the others exactly one, and arrivals follow the PRD delay', () => {
    const clip = renderSession(scene, 5);
    for (const { frame, arrivalMs } of clip.frames) {
      const absent = scene.absences.some(a => frame.timestampMs >= a.startMs && frame.timestampMs < a.endMs);
      expect(frame.hands.length).toBe(absent ? 0 : 1);
      expect(arrivalMs - frame.timestampMs).toBeGreaterThanOrEqual(50);
      expect(arrivalMs - frame.timestampMs).toBeLessThanOrEqual(60.01);
    }
    expect(clip.frames.some(f => f.frame.hands.length === 0)).toBe(true);
  });

  it('the noise-free camera is exact: 30 fps, a constant 50 ms delay, landmark 9 on the mirrored anchor, the hand it was told to be', () => {
    const clip = renderCleanSession(scene);
    clip.frames.forEach(({ frame, arrivalMs }, i) => {
      expect(frame.timestampMs).toBeCloseTo(i * FRAME_MS, 9);
      expect(arrivalMs - frame.timestampMs).toBeCloseTo(50, 9);
      const absent = scene.absences.some(a => frame.timestampMs >= a.startMs && frame.timestampMs < a.endMs);
      expect(frame.hands.length).toBe(absent ? 0 : 1);
      if (frame.hands.length) {
        const [x, y] = scene.anchorAt(frame.timestampMs);
        expect(frame.hands[0].landmarks[9].x).toBeCloseTo(1 - x / IMAGE_ASPECT, 12);
        expect(frame.hands[0].landmarks[9].y).toBeCloseTo(y, 12);
        expect(frame.hands[0].handedness).toBe('Left');
      }
    });
    expect(clip.labels).toEqual(scene.labels);
    expect(clip.frames.length).toBe(Math.ceil(scene.durationMs / FRAME_MS));
  });
});

describe('sessionScene: tracking glitches', () => {
  it('are scattered outside the gestures and the absences, apart from each other, and deterministic', () => {
    const make = (seed: number) => sessionScene([
      { kind: 'appear', at: [0.6, 0.3], holdMs: 1500 },
      { kind: 'launch', peak: 2.2 },
      { kind: 'hold', ms: 2500 },
      { kind: 'lose', ms: 500 },
      { kind: 'hold', ms: 1500 },
      { kind: 'tug', peak: 1.2 },
      { kind: 'hold', ms: 1500 },
    ], { leadMs: 300, glitches: { count: 8, seed } });
    const scene = make(3);
    expect(scene.glitches.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(make(3).glitches)).toBe(JSON.stringify(scene.glitches));
    expect(JSON.stringify(make(4).glitches)).not.toBe(JSON.stringify(scene.glitches));
    for (const g of scene.glitches) {
      for (const label of scene.labels) expect(g.atMs < label.motionStartMs - 100 || g.atMs > label.onsetMs + 160).toBe(true);
      for (const a of scene.absences) expect(g.atMs < a.startMs || g.atMs > a.endMs).toBe(true);
    }
    const times = scene.glitches.map(g => g.atMs);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100);
    expect(scene.glitchGuards).toHaveLength(2);
  });
});

describe('«Ver demo»', () => {
  it('is deterministic in its seed, take by take', () => {
    expect(JSON.stringify(buildDemoSession(7))).toBe(JSON.stringify(buildDemoSession(7)));
    expect(JSON.stringify(buildDemoSession(8))).not.toBe(JSON.stringify(buildDemoSession(7)));
    expect(JSON.stringify(renderDemoTake(7, 2))).toBe(JSON.stringify(renderDemoTake(7, 2)));
  });

  it('lasts 12–15 s and holds two throws and two tugs, each at least as fast as the demo promises', () => {
    const scene = demoSessionScene(DEMO_SEED);
    expect(scene.durationMs).toBeGreaterThanOrEqual(12_000);
    expect(scene.durationMs).toBeLessThanOrEqual(15_000);
    expect(scene.labels.map(l => l.kind)).toEqual(['launch', 'tug', 'launch', 'tug']);
    for (const l of scene.labels) expect(l.peakSpeed).toBeGreaterThanOrEqual(l.kind === 'launch' ? DEMO_PROMISE.minThrowPeak : DEMO_PROMISE.minTugPeak);
    // About 3 s between a throw and its tug: the follow-through, the gentle sway, the calm.
    expect(scene.labels[1].onsetMs - scene.labels[0].onsetMs).toBeGreaterThan(2800);
    expect(scene.labels[1].onsetMs - scene.labels[0].onsetMs).toBeLessThan(3600);
  });

  it('every gesture starts from a hand that has been perfectly still: ≥ 500 ms before each throw, and ≥ 500 ms with no sway before each tug', () => {
    for (const seed of [1, 2, 3, DEMO_SEED, 50, 199]) {
      const scene = demoSessionScene(seed);
      for (const label of scene.labels) {
        const calmMs = label.kind === 'tug' ? DEMO_PROMISE.minCalmMs : 500;
        const from = label.motionStartMs - calmMs;
        const resting = scene.anchorAt(label.motionStartMs);
        for (let t = from; t <= label.motionStartMs; t += 5) {
          const here = scene.anchorAt(t);
          // The noise-free path does not move at all: no sway, no drift, no tail of the previous motion.
          expect(Math.hypot(here[0] - resting[0], here[1] - resting[1]), `seed ${seed}, ${label.kind} at ${label.onsetMs.toFixed(0)}, t = ${t}`).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('the hand appears inside the default zone and holds still for 0.8 s before anything else', () => {
    const clip = buildDemoSession(DEMO_SEED);
    const withHand = clip.frames.filter(f => f.frame.hands.length > 0);
    const firstMs = withHand[0].frame.timestampMs;
    expect(firstMs).toBeGreaterThan(250);
    const scene = demoSessionScene(DEMO_SEED);
    for (const { frame } of withHand.filter(f => f.frame.timestampMs < firstMs + 800)) {
      const [x, y] = scene.anchorAt(frame.timestampMs);
      expect(x).toBeGreaterThanOrEqual(DEFAULT_TETHER_ZONE.x0);
      expect(x).toBeLessThanOrEqual(DEFAULT_TETHER_ZONE.x1);
      expect(y).toBeGreaterThanOrEqual(DEFAULT_TETHER_ZONE.y0);
      expect(y).toBeLessThanOrEqual(DEFAULT_TETHER_ZONE.y1);
    }
    // The hold is 0.8 s from the moment the scene brings the hand in; the first frame that sees it comes up to a frame later.
    expect(scene.labels[0].motionStartMs - scene.absences[0].endMs).toBe(800);
    expect(scene.labels[0].motionStartMs - firstMs).toBeGreaterThanOrEqual(800 - FRAME_MS);
  });

  it('the hand stays inside the frame the whole time, whatever the seed: no edge touched, never lost', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const scene = demoSessionScene(seed);
      // Even a big palm's wrist (0.21 ih below the anchor) stays inside the 0.96 ih edge limit, its fingertips (0.19 above) the 0.04 ih one.
      for (let t = scene.absences[0].endMs; t < scene.durationMs; t += 10) {
        const y = scene.anchorAt(t)[1];
        expect(y + 0.21, `seed ${seed}, t = ${t}`).toBeLessThan(0.96);
        expect(y - 0.19, `seed ${seed}, t = ${t}`).toBeGreaterThan(0.04);
      }
      expect(scene.absences).toHaveLength(1);
    }
  });

  it('after each throw the hand comes back up by 60–75 % of the stroke over 0.4–0.6 s, while the yoyo is still going down, and then holds', () => {
    for (const seed of [1, 2, 3, DEMO_SEED, 50, 199]) {
      const scene = demoSessionScene(seed);
      const follows = scene.tags.filter(tag => tag.startsWith(FOLLOW_THROUGH_TAG)).map(tag => {
        const [share, ms] = tag.slice(FOLLOW_THROUGH_TAG.length).split('/');
        return { share: Number(share), ms: Number(ms.replace('ms', '')) };
      });
      const throws = scene.labels.filter(l => l.kind === 'launch');
      expect(follows, `seed ${seed}`).toHaveLength(2);
      expect(throws).toHaveLength(2);
      follows.forEach((follow, i) => {
        expect(follow.share).toBeGreaterThanOrEqual(DEMO_PROMISE.followThroughShare[0]);
        expect(follow.share).toBeLessThanOrEqual(DEMO_PROMISE.followThroughShare[1]);
        expect(follow.ms).toBeGreaterThanOrEqual(DEMO_PROMISE.followThroughMs[0]);
        expect(follow.ms).toBeLessThanOrEqual(DEMO_PROMISE.followThroughMs[1]);
        // The path does what the tag says. The hand is lowest where the stroke ends…
        const startY = scene.anchorAt(throws[i].motionStartMs - 1)[1];
        let lowestY = -Infinity, lowestAt = 0;
        for (let t = throws[i].motionStartMs; t < throws[i].motionStartMs + 600; t++) {
          const y = scene.anchorAt(t)[1];
          if (y > lowestY) { lowestY = y; lowestAt = t; }
        }
        const strokeIh = lowestY - startY;
        expect(strokeIh, `seed ${seed}`).toBeGreaterThan(0.2);
        expect(lowestAt - throws[i].motionStartMs, 'the stroke is over in 0.2 s').toBeLessThan(200);
        // …and by the time the follow-through ends it has come back up by that share (the sway that follows is at most 0.04 ih).
        const settledY = scene.anchorAt(lowestAt + follow.ms)[1];
        expect(Math.abs(lowestY - settledY - follow.share * strokeIh), `seed ${seed}, round ${i}`).toBeLessThan(0.045);
        // While the yoyo is still going down: it rises from the very end of the stroke, not after the string has gone taut.
        expect(scene.anchorAt(lowestAt + 100)[1], `seed ${seed}, round ${i}`).toBeLessThan(lowestY);
      });
    }
  });

  it('the sleeper stays on the screen: at least 5 cm above the floor in every sleeping phase, with the world re-homed (the demo) and with a framing zone', () => {
    const FLOOR_Y = 0, CLEARANCE_M = 0.05;
    let lowest = Infinity;
    for (const seed of [DEMO_SEED, ...Array.from({ length: 40 }, (_, i) => i + 1)]) {
      const clip = buildDemoSession(seed);
      for (const zone of [null, framingZone('standing')]) {
        const sleeping = replayClip(clip, { zone }).filter(s => s.phase === 'sleeping');
        // Two sleeps of at least 2 s each, at 60 Hz.
        expect(sleeping.length, `seed ${seed}`).toBeGreaterThan(2 * 120);
        const low = Math.min(...sleeping.map(s => s.yoyo[1]));
        expect(low - FLOOR_Y, `seed ${seed}, zone ${zone === null ? 'none' : 'standing'}`).toBeGreaterThanOrEqual(CLEARANCE_M);
        lowest = Math.min(lowest, low);
      }
    }
    if (process.env.YOYO_REPORT === '1') console.info(`[demo] lowest sleeping yoyo over 41 seeds: ${lowest.toFixed(3)} m above the floor`);
  });

  it('that is what the follow-through is for: a throw that leaves the hand at the bottom of its stroke hangs the sleeper a whole stroke lower', () => {
    const config = createConfig();
    // The stroke the demo used to have, 0.4 ih, and nothing after it.
    const old = { peak: 2.6, riseMs: 50, plateauMs: 80, fallMs: 100 };
    const oldStroke = stroke(0, old.riseMs, old.plateauMs, old.fallMs, old.peak, [0, 1]);
    const strokeM = oldStroke.offset(oldStroke.endMs)[1] * config.world.scale;
    expect(strokeM).toBeGreaterThan(0.38);
    const scene = sessionScene([
      { kind: 'appear', at: [DEFAULT_HOME_IMAGE[0], 0.3], holdMs: 800 },
      { kind: 'launch', ...old, reboundUp: 0 },
      { kind: 'hold', ms: 2500 },
    ], { leadMs: 300 });
    const sleeping = replayClip(renderCleanSession(scene), { config }).filter(s => s.phase === 'sleeping');
    expect(sleeping.length).toBeGreaterThan(120);
    // The pivot stays a stroke under the home and the string is at its full length: the geometry puts the sleeper there
    // (to 3 cm of slack), which at the home the world has is under the floor, and off the screen.
    const hangs = config.world.homeY - strokeM - config.yoyo.maxLength;
    expect(Math.min(...sleeping.map(s => s.yoyo[1]))).toBeLessThan(hangs + 0.03);
  });

  it('the shipped seed walks both rounds through a fresh runtime: tie-on, throw, sleep, tug, catch, twice', () => {
    const clip = buildDemoSession(DEMO_SEED);
    expect(demoPhasesOf(clip)).toEqual(DEMO_PHASES);
    expect(walksBothRounds(clip)).toBe(true);
    expect(clip.durationMs).toBe(demoSessionScene(DEMO_SEED).durationMs);
  });

  it('EVERY seed works: the demo is the first take that walks both rounds, so it never depends on the luck of the camera noise', () => {
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    let firstTakeWorks = 0;
    const takes: number[] = [];
    for (const seed of seeds) {
      if (walksBothRounds(renderDemoTake(seed, 0))) firstTakeWorks++;
      const clip = buildDemoSession(seed);
      expect(walksBothRounds(clip), `seed ${seed}`).toBe(true);
      takes.push(Number(clip.tags.find(tag => tag.startsWith('take='))!.slice('take='.length)));
    }
    if (process.env.YOYO_REPORT === '1') console.info(`[demo] first take works on ${firstTakeWorks}/${seeds.length} seeds; takes needed: max ${Math.max(...takes)}`);
    // The gestures are as firm as they can be, so most first takes work and a few retakes cover the rest.
    expect(firstTakeWorks / seeds.length).toBeGreaterThan(0.8);
    expect(Math.max(...takes)).toBeLessThanOrEqual(8);
  });

  it('a take is the same scene under another draw of the noise; the first take is the demo when it works, a later one when it does not', () => {
    const seed = Array.from({ length: 100 }, (_, i) => i + 1).find(s => !walksBothRounds(renderDemoTake(s, 0)));
    expect(seed, 'some seed among the first 100 needs a retake').toBeDefined();
    const first = renderDemoTake(seed!, 0), second = renderDemoTake(seed!, 1);
    expect(first.labels).toEqual(second.labels);
    expect(JSON.stringify(first.frames)).not.toBe(JSON.stringify(second.frames));
    expect(first.tags).toContain('take=0');
    expect(second.tags).toContain('take=1');
    // That seed's demo is not its first take…
    const built = buildDemoSession(seed!);
    expect(built.tags).not.toContain('take=0');
    expect(walksBothRounds(built)).toBe(true);
    // …while a seed whose first take works is returned as that very take.
    const lucky = Array.from({ length: 100 }, (_, i) => i + 1).find(s => walksBothRounds(renderDemoTake(s, 0)))!;
    expect(JSON.stringify(buildDemoSession(lucky))).toBe(JSON.stringify(renderDemoTake(lucky, 0)));
  });

  it('walksBothRounds tells a demo that stops halfway from one that does not', () => {
    // A throw and nothing else: the yoyo sleeps and stays asleep.
    const halfway = renderCleanSession(sessionScene([
      { kind: 'appear', at: [0.667, 0.3], holdMs: 800 },
      { kind: 'launch', peak: 2.6 },
      { kind: 'hold', ms: 2500 },
    ], { leadMs: 300 }));
    expect(demoPhasesOf(halfway)).toEqual(['untethered', 'tethered', 'rolling', 'sleeping']);
    expect(walksBothRounds(halfway)).toBe(false);
    // A tighter setting that a flick cannot satisfy: the same demo no longer completes.
    const stricter = setConfigValue(createConfig(), 'tug.minUpDelta', 0.15);
    expect(walksBothRounds(renderCleanSession(demoSessionScene(DEMO_SEED)), createConfig())).toBe(true);
    expect(walksBothRounds(renderCleanSession(demoSessionScene(DEMO_SEED)), stricter)).toBe(false);
  });
});

describe('the browser QA camera session', () => {
  const session = buildQaCameraSession(QA_SEED);
  const scene = qaSessionScene(QA_SEED);
  const exit = session.absences.find(a => a.exit)!;

  it('is deterministic in its seed, take by take, and the seeds differ', () => {
    expect(JSON.stringify(buildQaCameraSession(5))).toBe(JSON.stringify(buildQaCameraSession(5)));
    expect(JSON.stringify(buildQaCameraSession(6))).not.toBe(JSON.stringify(buildQaCameraSession(5)));
    expect(JSON.stringify(renderQaTake(5, 2))).toBe(JSON.stringify(renderQaTake(5, 2)));
    // Not the demo of the same seed.
    expect(JSON.stringify(renderQaTake(5, 0).labels)).not.toBe(JSON.stringify(renderDemoTake(5, 0).labels));
  });

  it('lasts about 20 s: a throw, a tug and a catch with the hand in view, then the same with the hand out through the bottom for about 0.6 s', () => {
    expect(scene.durationMs).toBeGreaterThanOrEqual(19_000);
    expect(scene.durationMs).toBeLessThanOrEqual(21_000);
    expect(session.durationMs).toBe(scene.durationMs);
    expect(scene.labels.map(l => l.kind)).toEqual(['launch', 'tug', 'launch', 'tug']);
    for (const l of scene.labels) expect(l.peakSpeed).toBeGreaterThanOrEqual(l.kind === 'launch' ? DEMO_PROMISE.minThrowPeak : DEMO_PROMISE.minTugPeak);
    // Two absences: the hand coming in, and the exit, which sits between the second throw and the second tug.
    expect(session.absences).toHaveLength(2);
    expect(session.absences[0].exit).toBe(false);
    expect(exit.endMs - exit.startMs).toBeGreaterThanOrEqual(500);
    expect(exit.endMs - exit.startMs).toBeLessThanOrEqual(750);
    expect(exit.startMs).toBeGreaterThan(scene.labels[2].onsetMs + 2000);
    expect(exit.endMs).toBeLessThan(scene.labels[3].motionStartMs - DEMO_PROMISE.minCalmMs);
    // It leaves through the bottom and is back where it was.
    expect(scene.anchorAt(exit.startMs + 1)[1]).toBeGreaterThanOrEqual(LOST_BELOW_Y);
    expect(scene.anchorAt(exit.endMs + 600)[1]).toBeLessThan(LOST_BELOW_Y);
  });

  it('the hand comes in and holds inside the default standing framing zone, at its centre (x = 2/3 ih, y = 0.40 ih) give or take a few centimetres, until the first throw', () => {
    const zone = framingZone('standing');
    for (const seed of [QA_SEED, 2, 3, 4, 5, 6, 7, 8]) {
      const s = qaSessionScene(seed);
      const first = s.absences[0].endMs;
      const throwAt = s.labels[0].motionStartMs;
      // Held for 2.5 s: the yoyo ties on after about 0.45 s of it, and a page has time to show it tethered.
      expect(throwAt - first, `seed ${seed}`).toBeGreaterThanOrEqual(2000);
      for (let t = first; t <= throwAt; t += 20) {
        const [x, y] = s.anchorAt(t);
        expect(x).toBeGreaterThanOrEqual(zone.x0);
        expect(x).toBeLessThanOrEqual(zone.x1);
        expect(y).toBeGreaterThanOrEqual(zone.y0);
        expect(y).toBeLessThanOrEqual(zone.y1);
        expect(Math.abs(x - 2 / 3), `seed ${seed}`).toBeLessThanOrEqual(0.0301);
        expect(Math.abs(y - 0.4), `seed ${seed}`).toBeLessThanOrEqual(0.0201);
      }
      // The path is perfectly still while it waits to tie on, so nothing but the tie-on rule decides when that happens.
      expect(dist(s.anchorAt(first), s.anchorAt(throwAt - 1))).toBeLessThan(1e-9);
    }
  });

  it('the hand touches no edge except on the way out: even a big palm stays inside the frame, whatever the seed', () => {
    for (const seed of [QA_SEED, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const s = qaSessionScene(seed);
      const out = s.absences.find(a => a.exit)!;
      for (let t = s.absences[0].endMs; t < s.durationMs; t += 10) {
        // The way out and back is the exit; the 0.3 s around it are where an edge may be flagged (see qaCheckTake).
        if (t >= out.startMs - 300 && t <= out.endMs + 300) continue;
        const y = s.anchorAt(t)[1];
        expect(y + 0.21, `seed ${seed}, t = ${t}`).toBeLessThan(0.96);
        expect(y - 0.19, `seed ${seed}, t = ${t}`).toBeGreaterThan(0.04);
      }
    }
  });

  it('delivers frames like the demo: capture and arrival times in ms from 0, in order, 50–60 ms apart, an empty hand list while the hand is out, one hand otherwise', () => {
    expect(session.frames.length).toBeGreaterThan(450);
    expect(session.frames[0].frame.timestampMs).toBeGreaterThanOrEqual(0);
    expect(session.frames[0].frame.timestampMs).toBeLessThan(FRAME_MS + 0.5);
    expect(session.frames[session.frames.length - 1].frame.timestampMs).toBeGreaterThan(session.durationMs - 3 * FRAME_MS);
    let previous = -Infinity;
    for (const { frame, arrivalMs } of session.frames) {
      expect(frame.timestampMs).toBeGreaterThan(previous);
      previous = frame.timestampMs;
      expect(arrivalMs - frame.timestampMs).toBeGreaterThanOrEqual(50 - 1e-6);
      expect(arrivalMs - frame.timestampMs).toBeLessThanOrEqual(60 + 1e-6);
      const out = session.absences.some(a => frame.timestampMs >= a.startMs && frame.timestampMs < a.endMs);
      // Around the exit the camera model may lose the hand a frame or two before the scene's absence starts (its wrist leaves first).
      const nearExit = frame.timestampMs >= exit.startMs - 300 && frame.timestampMs <= exit.endMs + 300;
      if (out) expect(frame.hands.length).toBe(0);
      else if (!nearExit) expect(frame.hands.length).toBe(1);
      for (const hand of frame.hands) expect(hand.landmarks).toHaveLength(21);
    }
    expect(session.tags).toContain('qa');
    expect(session.tags.some(tag => tag.startsWith('take='))).toBe(true);
    expect(session.labels).toEqual(scene.labels);
  });

  it('says what a page that plays it must see: the phases of the two rounds in order, the events, and the bottom edge while the hand is out', () => {
    const { phases, events, edges } = session.timeline;
    expect(phases.map(p => p.phase)).toEqual(QA_PHASES);
    expect(QA_PHASES).toEqual(DEMO_PHASES);
    // The spans tile the app clock: each starts where the previous ended, the first at 0.
    expect(phases[0].fromMs).toBe(0);
    for (let i = 1; i < phases.length; i++) expect(phases[i].fromMs).toBe(phases[i - 1].toMs);
    expect(phases[phases.length - 1].toMs).toBeGreaterThan(session.durationMs);
    expect(events.map(e => e.kind)).toEqual(QA_EVENTS);
    for (let i = 1; i < events.length; i++) expect(events[i].atMs).toBeGreaterThanOrEqual(events[i - 1].atMs);
    // Each gesture is seen shortly after its labelled onset (capture time + the tracking delay + the intent decision).
    const at = (kind: string, n: number) => events.filter(e => e.kind === kind)[n].atMs;
    expect(at('launch', 0) - scene.labels[0].onsetMs).toBeGreaterThan(50);
    expect(at('launch', 0) - scene.labels[0].onsetMs).toBeLessThan(250);
    expect(at('tug', 1) - scene.labels[3].onsetMs).toBeGreaterThan(50);
    expect(at('tug', 1) - scene.labels[3].onsetMs).toBeLessThan(250);
    // The yoyo keeps sleeping while the hand is out: no phase boundary falls inside the exit.
    const sleep = phases.filter(p => p.phase === 'sleeping')[1];
    expect(sleep.fromMs).toBeLessThan(exit.startMs);
    expect(sleep.toMs).toBeGreaterThan(exit.endMs);
    // One vignette, at the bottom, around the exit and nowhere else.
    expect(edges).toHaveLength(1);
    expect(edges[0].edge).toBe('bottom');
    expect(edges[0].fromMs).toBeGreaterThanOrEqual(exit.startMs - 300);
    expect(edges[0].fromMs).toBeLessThanOrEqual(exit.startMs + 300);
    expect(edges[0].toMs).toBeGreaterThanOrEqual(exit.endMs);
    expect(edges[0].toMs).toBeLessThanOrEqual(exit.endMs + 300);
  });

  it('what it promises is what a fresh runtime does with it: the timeline is the one qaCheckTake draws from the very frames', () => {
    const check = qaCheckTake(session, scene);
    expect(check.problems).toEqual([]);
    expect(check.walks).toBe(true);
    expect(JSON.stringify(check.timeline)).toBe(JSON.stringify(session.timeline));
  });

  it('the sleeper stays on the screen except while the hand is out: at least 5 cm above the floor, with the framing zone the camera mode sets', () => {
    for (const seed of [QA_SEED, 2, 3, 4, 5, 6, 7, 8]) {
      const built = buildQaCameraSession(seed);
      const out = built.absences.find(a => a.exit)!;
      // Out through the bottom the hand pulls the pivot down with it: for that second the yoyo hangs below the floor. It is the point of the exit.
      const sleeping = replayClip(built, { zone: framingZone('standing') })
        .filter(s => s.phase === 'sleeping' && (s.timeMs < out.startMs - 300 || s.timeMs > out.endMs + 1500));
      expect(sleeping.length, `seed ${seed}`).toBeGreaterThan(2 * 120);
      expect(Math.min(...sleeping.map(s => s.yoyo[1])), `seed ${seed}`).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('EVERY seed works: it is the first take whose replay walks the promised phases and edge, so it never depends on the luck of the camera noise', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
    let firstTakeWorks = 0;
    const takes: number[] = [];
    for (const seed of seeds) {
      if (qaCheckTake(renderQaTake(seed, 0), qaSessionScene(seed)).walks) firstTakeWorks++;
      const built = buildQaCameraSession(seed);
      expect(qaCheckTake(built, qaSessionScene(seed)).walks, `seed ${seed}`).toBe(true);
      expect(built.seed).toBe(seed);
      takes.push(built.take);
      expect(built.tags).toContain(`take=${built.take}`);
    }
    if (process.env.YOYO_REPORT === '1') console.info(`[qa] first take works on ${firstTakeWorks}/${seeds.length} seeds; takes needed: max ${Math.max(...takes)}`);
    expect(firstTakeWorks / seeds.length).toBeGreaterThan(0.7);
    expect(Math.max(...takes)).toBeLessThanOrEqual(8);
  });

  it('a take is the same scene under another draw of the noise; the first take is the session when it works, a later one when it does not', () => {
    const seed = Array.from({ length: 100 }, (_, i) => i + 1).find(s => !qaCheckTake(renderQaTake(s, 0), qaSessionScene(s)).walks);
    expect(seed, 'some seed among the first 100 needs a retake').toBeDefined();
    const first = renderQaTake(seed!, 0), second = renderQaTake(seed!, 1);
    expect(first.labels).toEqual(second.labels);
    expect(JSON.stringify(first.frames)).not.toBe(JSON.stringify(second.frames));
    expect(buildQaCameraSession(seed!).take).toBeGreaterThan(0);
    const lucky = Array.from({ length: 100 }, (_, i) => i + 1).find(s => qaCheckTake(renderQaTake(s, 0), qaSessionScene(s)).walks)!;
    expect(buildQaCameraSession(lucky).take).toBe(0);
    expect(JSON.stringify(buildQaCameraSession(lucky).frames)).toBe(JSON.stringify(renderQaTake(lucky, 0).frames));
  });

  it('qaCheckTake tells a session that stops halfway, or that has no exit, from one that does not, and says why', () => {
    // The first round only: the yoyo sleeps and stays asleep, and nobody leaves.
    const halfScene = sessionScene([
      { kind: 'appear', at: DEFAULT_HOME_IMAGE, holdMs: 1500 },
      { kind: 'launch', peak: 2.6, riseMs: 50, plateauMs: 50, fallMs: 50, reboundUp: 0 },
      { kind: 'hold', ms: 3000 },
    ], { leadMs: 400 });
    const half = qaCheckTake(renderCleanSession(halfScene), halfScene);
    expect(half.walks).toBe(false);
    expect(half.problems.join(' | ')).toMatch(/phases untethered > tethered > rolling > sleeping/);
    expect(half.problems.join(' | ')).toMatch(/no exit/);
    // The real take with a scene that does not know about the exit: the flags it sees are strays.
    const unaware = qaCheckTake(session, { ...scene, absences: scene.absences.filter(a => !a.exit) });
    expect(unaware.walks).toBe(false);
    expect(unaware.problems.join(' | ')).toMatch(/no exit/);
    expect(unaware.problems.join(' | ')).toMatch(/flag an edge outside the exit/);
  });
});

describe('pointerScriptFromScene', () => {
  const scene = sessionScene([
    { kind: 'appear', at: [0.6, 0.3], holdMs: 600 },
    { kind: 'launch', peak: 2 },
    { kind: 'hold', ms: 400 },
    { kind: 'lose', ms: 300 },
    { kind: 'reappear', offset: [0.1, 0.05] },
    { kind: 'hold', ms: 500 },
  ], { leadMs: 200 });
  const script = pointerScriptFromScene(scene, RECT);

  it('presses where the hand appears, releases where it is lost, presses again where it comes back, and does not release at the end', () => {
    const downs = script.filter(s => s.down), ups = script.filter(s => s.up);
    expect(downs.map(s => s.t)).toEqual([200, scene.absences[1].endMs]);
    expect(ups.map(s => s.t)).toEqual([scene.absences[1].startMs]);
    expect(script[script.length - 1].up).toBeUndefined();
    expect(script[0].down).toBe(true);
  });

  it('events are in time order and as dense as asked', () => {
    for (let i = 1; i < script.length; i++) expect(script[i].t).toBeGreaterThanOrEqual(script[i - 1].t);
    const dense = pointerScriptFromScene(scene, RECT, { eventHz: 240 });
    expect(dense.length).toBeGreaterThan(script.length * 1.8);
  });

  it('positions are client pixels of the same anchor path: the viewport and the mirrored image share their axes', () => {
    for (const step of script.filter(s => !s.up)) {
      const [x, y] = scene.anchorAt(step.t);
      expect((step.x - RECT.left) / RECT.height).toBeCloseTo(x, 9);
      expect((step.y - RECT.top) / RECT.height).toBeCloseTo(y, 9);
    }
  });

  it('through the MouseDriver it reproduces the anchor path at 30 Hz, only where the hand is present', () => {
    const exact = pointerScriptFromScene(scene, RECT, { eventHz: 1000 });
    const samples = runPointerScript(new MouseDriver(), exact, RECT);
    expect(samples.length).toBeGreaterThan(40);
    for (const s of samples) {
      // The sample at the very instant of the release is still the hand's: the release comes after it.
      expect(scene.absences.some(a => s.timestampMs > a.startMs && s.timestampMs < a.endMs)).toBe(false);
      // Sample-and-hold of 1 kHz events: at most a millisecond of the fastest motion (about 3 ih/s) behind the path.
      expect(dist([s.x, s.y], scene.anchorAt(s.timestampMs))).toBeLessThan(0.004);
      expect(s.source).toBe('mouse');
    }
    // The first sample after each press is a fresh start.
    expect(samples.filter(s => !s.continuous)).toHaveLength(2);
  });
});

describe('toReplayFile', () => {
  const clip = buildDemoSession(DEMO_SEED);

  it('writes a valid replay that reads back as the same frames, and carries the labels', () => {
    const file = toReplayFile(clip, 'demo');
    expect(file.schema).toBe('yoyo-replay/1');
    expect(file.note).toBe('demo');
    expect(file.labels).toEqual(clip.labels.map(l => ({ kind: l.kind, onsetMs: l.onsetMs })));
    const back = replayFrames(parseReplay(serializeReplay(file)));
    expect(back).toHaveLength(clip.frames.length);
    back.forEach((frame, i) => {
      expect(frame.arrivalMs).toBe(clip.frames[i].arrivalMs);
      expect(frame.frame.timestampMs).toBe(clip.frames[i].frame.timestampMs);
      expect(frame.frame.hands).toEqual(clip.frames[i].frame.hands);
    });
  });

  it('holds landmarks and nothing else: no images, no personal fields', () => {
    const file = toReplayFile(clip);
    expect(Object.keys(file).sort()).toEqual(['frames', 'labels', 'schema']);
    for (const f of file.frames) expect(Object.keys(f).sort()).toEqual(['a', 'hands', 't']);
  });
});
