import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Random } from '../replay/random';
import { FixedStep } from './FixedStep';

const HZ = 240;
const MAX_STEPS = 4;
const FRAME_60HZ_MS = 1000 / 60;
const TEN_MINUTES_FRAMES = 60 * 60 * 10;

/** One render frame as the engine runs it: ask what is due, then account every step taken. */
function runFrame(clock: FixedStep, nowMs: number) {
  const budget = clock.due(nowMs);
  const ends: number[] = [];
  for (let i = 0; i < budget.steps; i += 1) ends.push(clock.advanceOne());
  return { ...budget, ends };
}

describe('FixedStep', () => {
  it('exposes the step length in milliseconds and seconds', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    expect(clock.stepMs).toBeCloseTo(1000 / 240, 12);
    expect(clock.dt).toBeCloseTo(1 / 240, 12);
    expect(clock.dt * 1000).toBeCloseTo(clock.stepMs, 12);
  });

  it('rejects a nonsensical rate or cap', () => {
    for (const hz of [0, -240, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new FixedStep(hz, MAX_STEPS)).toThrow(RangeError);
    for (const cap of [0, -1, 1.5, Number.NaN]) expect(() => new FixedStep(HZ, cap)).toThrow(RangeError);
  });

  it('owes nothing and refuses to step before the clock is started', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    expect(clock.due(1000)).toEqual({ steps: 0, droppedMs: 0 });
    expect(clock.timeMs).toBe(0);
    expect(() => clock.advanceOne()).toThrow();
  });

  it('starts the clock at t without taking a step', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(5000);
    expect(clock.timeMs).toBe(5000);
    expect(clock.due(5000)).toEqual({ steps: 0, droppedMs: 0 });
    // Less than one step later is still not a full step.
    expect(clock.due(5000 + clock.stepMs * 0.99)).toEqual({ steps: 0, droppedMs: 0 });
    expect(() => clock.start(Number.NaN)).toThrow(RangeError);
  });

  it('reports each step end time on the fixed grid', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(1000);
    const frame = runFrame(clock, 1000 + 3.5 * clock.stepMs);
    expect(frame.steps).toBe(3);
    expect(frame.ends).toHaveLength(3);
    frame.ends.forEach((end, i) => expect(end).toBeCloseTo(1000 + (i + 1) * clock.stepMs, 9));
    expect(clock.timeMs).toBe(frame.ends[2]);
  });

  it('keeps the sub-step remainder for the next frame instead of dropping it', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(0);
    expect(runFrame(clock, 0.9 * clock.stepMs).steps).toBe(0);
    // 0.9 + 0.9 = 1.8 steps of real time: one step now, the 0.8 remainder carries over.
    expect(runFrame(clock, 1.8 * clock.stepMs).steps).toBe(1);
    expect(runFrame(clock, 2.2 * clock.stepMs).steps).toBe(1);
    expect(runFrame(clock, 3.1 * clock.stepMs).steps).toBe(1);
  });

  it('takes exactly 4 steps per 60 Hz frame for ten minutes, with no drift and nothing dropped', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    const start = 123456.789;
    clock.start(start);
    let totalSteps = 0;
    let totalDropped = 0;
    for (let i = 1; i <= TEN_MINUTES_FRAMES; i += 1) {
      const now = start + (i * 1000) / 60;
      const frame = runFrame(clock, now);
      expect(frame.steps).toBe(4);
      totalSteps += frame.steps;
      totalDropped += frame.droppedMs;
    }
    expect(totalSteps).toBe(HZ * 600);
    expect(totalDropped).toBe(0);
    // The clock is an integer step count times the step length: no accumulated rounding error.
    expect(clock.timeMs).toBeCloseTo(start + 600_000, 6);
  });

  it('takes 1 or 2 steps per 144 Hz frame and never drops anything', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(0);
    let totalSteps = 0;
    const frames = 144 * 60;
    for (let i = 1; i <= frames; i += 1) {
      const frame = runFrame(clock, (i * 1000) / 144);
      expect([1, 2]).toContain(frame.steps);
      expect(frame.droppedMs).toBe(0);
      totalSteps += frame.steps;
    }
    expect(totalSteps).toBe(HZ * 60);
  });

  it('turns a 1 s stall into exactly 4 steps and ~983 ms dropped, then carries on normally', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    const start = 50_000;
    clock.start(start);
    let now = start;
    for (let i = 0; i < 30; i += 1) {
      now += FRAME_60HZ_MS;
      expect(runFrame(clock, now).steps).toBe(4);
    }
    const before = clock.timeMs;
    now += 1000;
    const stall = runFrame(clock, now);
    expect(stall.steps).toBe(4);
    expect(stall.droppedMs).toBeCloseTo(1000 - 4 * clock.stepMs, 3);
    expect(stall.droppedMs).toBeGreaterThan(983);
    expect(stall.droppedMs).toBeLessThan(984);
    // The clock jumped over the dropped stretch: it is back on the wall clock, not 1 s behind.
    expect(clock.timeMs - before).toBeCloseTo(1000, 3);
    expect(now - clock.timeMs).toBeLessThan(clock.stepMs);

    for (let i = 0; i < 30; i += 1) {
      now += FRAME_60HZ_MS;
      const frame = runFrame(clock, now);
      expect(frame.steps).toBe(4);
      expect(frame.droppedMs).toBe(0);
    }
  });

  it('drops only whole steps, never a fraction, so the grid phase survives a stall', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(0);
    // 101 ms = 24.24 steps: 4 taken, 20 whole steps dropped, 0.24 step stays owed.
    const stall = runFrame(clock, 101);
    expect(stall.steps).toBe(4);
    expect(stall.droppedMs).toBeCloseTo(20 * clock.stepMs, 9);
    expect(clock.timeMs).toBeCloseTo(100, 9);
    expect(runFrame(clock, 105.5).steps).toBe(1);
  });

  it('applies the clock jump on the first ask, so asking again in the same frame reports nothing dropped', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(0);
    const first = clock.due(1000);
    expect(first.steps).toBe(MAX_STEPS);
    expect(first.droppedMs).toBeGreaterThan(900);
    // The dropped stretch is already skipped: what is left is exactly the 4 steps still to take.
    expect(clock.due(1000)).toEqual({ steps: MAX_STEPS, droppedMs: 0 });
    for (let i = 0; i < MAX_STEPS; i += 1) clock.advanceOne();
    expect(clock.timeMs).toBeCloseTo(1000, 6);
    expect(clock.due(1000)).toEqual({ steps: 0, droppedMs: 0 });
  });

  it('runs a slow display in slow motion at constant cost, not as a spiral', () => {
    // 30 fps wants 8 steps per frame; the cap holds it at 4 and drops the other 4 every time.
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(0);
    for (let i = 1; i <= 100; i += 1) {
      const frame = runFrame(clock, (i * 1000) / 30);
      expect(frame.steps).toBe(MAX_STEPS);
      expect(frame.droppedMs).toBeCloseTo(4 * clock.stepMs, 6);
    }
  });

  it('owes the same steps for the same frame sequence, however irregular', () => {
    const run = (seed: number) => {
      const random = new Random(seed);
      const clock = new FixedStep(HZ, MAX_STEPS);
      clock.start(1000);
      let now = 1000;
      const log: Array<{ steps: number; droppedMs: number; ends: number[] }> = [];
      for (let i = 0; i < 5000; i += 1) {
        // Mostly 60 Hz with jitter, plus occasional fast frames and stalls.
        const dt = random.chance(0.02) ? random.range(30, 400) : random.range(0.5, 25);
        now += dt;
        log.push(runFrame(clock, now));
      }
      return log;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it('keeps the invariants for any frame sequence: capped, non-negative, finite, on the wall clock', () => {
    const random = new Random(2026);
    const clock = new FixedStep(HZ, MAX_STEPS);
    const start = 777;
    clock.start(start);
    let now = start;
    let totalSteps = 0;
    let totalDropped = 0;
    let previousTime = clock.timeMs;
    // Violations are collected instead of asserted in the loop: tens of thousands of frames, and a
    // failure should name the frame, not just say "expected true".
    const violations: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      now += random.chance(0.01) ? random.range(100, 5000) : random.range(0, 40);
      const frame = runFrame(clock, now);
      const behind = now - clock.timeMs;
      if (!Number.isInteger(frame.steps) || frame.steps < 0 || frame.steps > MAX_STEPS) violations.push(`frame ${i}: steps ${frame.steps}`);
      if (!Number.isFinite(frame.droppedMs) || frame.droppedMs < 0) violations.push(`frame ${i}: dropped ${frame.droppedMs}`);
      if (!(clock.timeMs >= previousTime)) violations.push(`frame ${i}: clock went back to ${clock.timeMs}`);
      // After taking the steps, less than one step of real time is still owed.
      if (!(behind > -1e-6 && behind < clock.stepMs + 1e-6)) violations.push(`frame ${i}: ${behind} ms behind the wall clock`);
      previousTime = clock.timeMs;
      totalSteps += frame.steps;
      totalDropped += frame.droppedMs;
    }
    expect(violations).toEqual([]);
    // Time is conserved: what was stepped plus what was dropped is what passed.
    expect(clock.timeMs - start).toBeCloseTo(totalSteps * clock.stepMs + totalDropped, 4);
  });

  it('survives hostile input without moving the clock or producing NaN', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(1000);
    runFrame(clock, 1100);
    const time = clock.timeMs;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clock.due(bad)).toEqual({ steps: 0, droppedMs: 0 });
    }
    // Time going backwards, or standing still, owes nothing.
    expect(clock.due(500)).toEqual({ steps: 0, droppedMs: 0 });
    expect(clock.due(time)).toEqual({ steps: 0, droppedMs: 0 });
    expect(clock.timeMs).toBe(time);
    // An hour-long stall is a constant-time jump, not a loop.
    const hour = runFrame(clock, time + 3_600_000);
    expect(hour.steps).toBe(MAX_STEPS);
    expect(hour.droppedMs).toBeCloseTo(3_600_000 - MAX_STEPS * clock.stepMs, 2);
    expect(Number.isFinite(clock.timeMs)).toBe(true);
  });

  it('can be restarted: starting again begins a fresh clock with no steps owed', () => {
    const clock = new FixedStep(HZ, MAX_STEPS);
    clock.start(0);
    runFrame(clock, 50);
    clock.start(10_000);
    expect(clock.timeMs).toBe(10_000);
    expect(clock.due(10_000)).toEqual({ steps: 0, droppedMs: 0 });
    expect(runFrame(clock, 10_000 + FRAME_60HZ_MS).steps).toBe(4);
  });

  it('reads no ambient clock or randomness (determinism rule)', () => {
    const source = readFileSync(new URL('./FixedStep.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random/);
  });
});
