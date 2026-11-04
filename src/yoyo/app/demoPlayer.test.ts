import { describe, expect, it } from 'vitest';
import type { HandFrame } from '../../shared/contracts';
import { createConfig } from '../config';
import type { YoyoPhase } from '../contracts';
import { buildDemoSession, DEMO_SEED } from '../replay/sessions';
import { DEMO_GAP_MS, DEMO_MAX_PER_POLL, DemoPlayer, type ClipFrame, type DemoClip } from './demoPlayer';
import { YoyoRuntime } from './YoyoRuntime';

/** A bare clip: one empty frame every `frameMs`, arriving `delayMs` after capture. */
function makeClip(count = 30, frameMs = 100, delayMs = 50): DemoClip {
  const frames: ClipFrame[] = Array.from({ length: count }, (_, i) => ({
    frame: { timestampMs: i * frameMs, source: 'replay', hands: [] } satisfies HandFrame,
    arrivalMs: i * frameMs + delayMs,
  }));
  return { frames, durationMs: count * frameMs };
}

/** Everything the player hands out when polled at `hz` from `from` to `to`, tagged with the pass each frame belongs to. */
function playThrough(player: DemoPlayer, from: number, to: number, hz = 60) {
  const delivered: Array<{ at: number; frame: ClipFrame; pass: number }> = [];
  const perPoll: number[] = [];
  const restartedAt: number[] = [];
  let pass = 0;
  for (let now = from; now <= to; now += 1000 / hz) {
    const poll = player.poll(now);
    if (poll.restarted) {
      pass++;
      restartedAt.push(now);
    }
    perPoll.push(poll.frames.length);
    for (const frame of poll.frames) delivered.push({ at: now, frame, pass });
  }
  return { delivered, perPoll, restartedAt };
}

describe('DemoPlayer scheduling', () => {
  it('hands out nothing before it is started', () => {
    const player = new DemoPlayer(makeClip());
    expect(player.poll(0).frames).toHaveLength(0);
    expect(player.poll(100000).frames).toHaveLength(0);
    expect(player.passes).toBe(0);
  });

  it('places the clip on the engine clock: a frame comes out when its arrival is due, shifted by the start time', () => {
    const player = new DemoPlayer(makeClip());
    player.start(1000);
    expect(player.passes).toBe(1);
    expect(player.poll(1049).frames).toHaveLength(0);
    const poll = player.poll(1050);
    expect(poll.frames).toHaveLength(1);
    expect(poll.frames[0].frame.timestampMs).toBe(1000);
    expect(poll.frames[0].arrivalMs).toBe(1050);
    expect(poll.restarted).toBe(false);
    // The next one is 100 ms later.
    expect(player.poll(1149).frames).toHaveLength(0);
    expect(player.poll(1150).frames[0].frame.timestampMs).toBe(1100);
  });

  it('delivers every frame of a pass exactly once, in order, never before it is due', () => {
    const clip = makeClip();
    const player = new DemoPlayer(clip);
    player.start(5000);
    const { delivered } = playThrough(player, 5000, 5000 + clip.durationMs);
    expect(delivered).toHaveLength(clip.frames.length);
    delivered.forEach((d, i) => {
      expect(d.frame.frame.timestampMs).toBe(5000 + i * 100);
      expect(d.frame.arrivalMs).toBe(5000 + i * 100 + 50);
      expect(d.at).toBeGreaterThanOrEqual(d.frame.arrivalMs);
      // At 60 Hz a frame is handed out within one render frame of its due time.
      expect(d.at - d.frame.arrivalMs).toBeLessThan(1000 / 60 + 1e-9);
    });
  });

  it('does not touch the clip it plays', () => {
    const clip = makeClip(5);
    const before = JSON.stringify(clip);
    const player = new DemoPlayer(clip);
    player.start(123);
    playThrough(player, 123, 123 + 10 * clip.durationMs);
    expect(JSON.stringify(clip)).toBe(before);
  });

  it('keeps the hands of a frame as they are (only the times move)', () => {
    const hands = [{ handedness: 'Right' as const, landmarks: [{ x: 0.1, y: 0.2, z: 0.3 }] }];
    const clip: DemoClip = { frames: [{ frame: { timestampMs: 0, source: 'replay', hands }, arrivalMs: 40 }], durationMs: 100 };
    const player = new DemoPlayer(clip);
    player.start(10);
    const out = player.poll(60).frames[0];
    expect(out.frame.hands).toBe(hands);
    expect(out.frame.source).toBe('replay');
  });
});

describe('DemoPlayer looping', () => {
  it('loops, flags each new pass once, and keeps capture and arrival times strictly increasing', () => {
    const clip = makeClip(20, 100, 50);
    const player = new DemoPlayer(clip);
    player.start(0);
    const passMs = clip.durationMs + 50 + DEMO_GAP_MS;
    const { delivered, restartedAt } = playThrough(player, 0, 5 * passMs);
    expect(player.passes).toBeGreaterThanOrEqual(5);

    const stamps = delivered.map(d => d.frame.frame.timestampMs);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    const arrivals = delivered.map(d => d.frame.arrivalMs);
    for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]).toBeGreaterThanOrEqual(arrivals[i - 1]);

    // Every pass after the first is flagged exactly once, and the flag is the last thing before its frames.
    expect(restartedAt.length).toBe(player.passes - 1);
    for (let k = 1; k < restartedAt.length; k++) expect(restartedAt[k]).toBeGreaterThan(restartedAt[k - 1]);
    // Each pass delivers the clip from its first frame to its last.
    const byPass = new Map<number, number[]>();
    for (const d of delivered) byPass.set(d.pass, [...(byPass.get(d.pass) ?? []), d.frame.frame.timestampMs]);
    for (let pass = 0; pass < player.passes - 1; pass++) {
      const times = byPass.get(pass)!;
      expect(times).toHaveLength(clip.frames.length);
      expect(times[times.length - 1] - times[0]).toBe(19 * 100);
    }
  });

  it('waits a gap between passes with nothing to deliver', () => {
    const clip = makeClip(10, 100, 50);
    const player = new DemoPlayer(clip, { gapMs: 600 });
    player.start(0);
    const { delivered } = playThrough(player, 0, 3000);
    const lastOfFirst = delivered[9];
    const firstOfSecond = delivered[10];
    expect(firstOfSecond.pass).toBe(1);
    expect(lastOfFirst.pass).toBe(0);
    // The second pass starts after the first one's last frame plus the gap.
    expect(firstOfSecond.frame.frame.timestampMs - lastOfFirst.frame.frame.timestampMs).toBeGreaterThanOrEqual(600);
    // And nothing is handed out in between.
    expect(firstOfSecond.at - lastOfFirst.at).toBeGreaterThanOrEqual(600 - 1000 / 60);
  });

  it('plays the shipped demo for many loops with strictly increasing times and bounded pushes per frame', () => {
    const clip = buildDemoSession(DEMO_SEED);
    const player = new DemoPlayer(clip);
    player.start(20_000);
    const { delivered, perPoll } = playThrough(player, 20_000, 20_000 + 5 * (clip.durationMs + 1000));
    expect(player.passes).toBeGreaterThanOrEqual(5);
    expect(Math.max(...perPoll)).toBeLessThanOrEqual(DEMO_MAX_PER_POLL);
    const stamps = delivered.map(d => d.frame.frame.timestampMs);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    // At 60 Hz nothing is skipped: every frame of every completed pass comes out.
    const completed = player.passes - 1;
    expect(delivered.length).toBeGreaterThanOrEqual(completed * clip.frames.length);
  });
});

describe('DemoPlayer under stalls and pauses', () => {
  it('bounds what one poll hands out after a short stall and keeps the newest, in order', () => {
    const player = new DemoPlayer(makeClip(60, 33.3333, 50), { maxPerPoll: 8 });
    player.start(0);
    player.poll(100);
    // 700 ms without a poll: ~21 frames are due, under the resync limit.
    const poll = player.poll(800);
    expect(poll.restarted).toBe(false);
    expect(poll.frames).toHaveLength(8);
    const stamps = poll.frames.map(f => f.frame.timestampMs);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    // They are the newest due ones: the last is the last frame due at 800.
    expect(poll.frames[7].arrivalMs).toBeLessThanOrEqual(800);
    expect(poll.frames[7].arrivalMs + 33.3333).toBeGreaterThan(800);
    // And nothing is owed afterwards: the next poll starts from there.
    expect(player.poll(801).frames.length).toBeLessThanOrEqual(1);
  });

  it('starts over after a stall too long to be a late frame', () => {
    const clip = makeClip(60, 100, 50);
    const player = new DemoPlayer(clip, { resyncMs: 1500 });
    player.start(0);
    player.poll(1000);
    const poll = player.poll(10_000);
    expect(poll.restarted).toBe(true);
    expect(player.passes).toBe(2);
    // Nothing of the old pass is replayed: the first frame of the new one is not due yet.
    expect(poll.frames).toHaveLength(0);
    const next = player.poll(10_050);
    expect(next.restarted).toBe(false);
    expect(next.frames).toHaveLength(1);
    // The pass restarts from now with the clip's first frame, later than everything handed out before.
    expect(next.frames[0].frame.timestampMs).toBe(10_000);
    expect(next.frames[0].arrivalMs).toBe(10_050);
  });

  it('also starts the next pass from now when the page slept through the gap', () => {
    const clip = makeClip(10, 100, 50);
    const player = new DemoPlayer(clip, { gapMs: 200, resyncMs: 1000 });
    player.start(0);
    playThrough(player, 0, 1000);
    const poll = player.poll(60_000);
    expect(poll.restarted).toBe(true);
    expect(poll.frames).toHaveLength(0);
    const next = player.poll(60_050);
    expect(next.frames).toHaveLength(1);
    expect(next.frames[0].frame.timestampMs).toBe(60_000);
  });

  it('freezes while held and resumes where it was, without a burst', () => {
    const player = new DemoPlayer(makeClip(30, 100, 50));
    player.start(0);
    const before = playThrough(player, 0, 1000).delivered;
    expect(before.length).toBeGreaterThan(5);
    player.hold(1000);
    expect(player.poll(1500).frames).toHaveLength(0);
    expect(player.poll(30_000).frames).toHaveLength(0);
    player.release(31_000);
    const after = playThrough(player, 31_000, 32_000).delivered;
    // 1 s later in play time, a normal trickle of about ten frames, not 300 ms · 30 of backlog.
    expect(after.length).toBeLessThanOrEqual(11);
    expect(after.length).toBeGreaterThan(5);
    const all = [...before, ...after].map(d => d.frame.frame.timestampMs);
    for (let i = 1; i < all.length; i++) expect(all[i]).toBeGreaterThan(all[i - 1]);
    // The clip continued from its next frame, only later on the clock.
    expect(after[0].frame.frame.timestampMs - before[before.length - 1].frame.frame.timestampMs).toBeGreaterThanOrEqual(30_000);
  });

  it('start() begins again at the new time', () => {
    const player = new DemoPlayer(makeClip(10, 100, 50));
    player.start(0);
    playThrough(player, 0, 500);
    player.start(10_000);
    const poll = player.poll(10_050);
    expect(poll.frames).toHaveLength(1);
    expect(poll.frames[0].frame.timestampMs).toBeGreaterThan(400);
    expect(poll.frames[0].frame.timestampMs).toBe(10_000);
  });

  it('ignores non-finite poll times', () => {
    const player = new DemoPlayer(makeClip());
    player.start(0);
    expect(player.poll(Number.NaN).frames).toHaveLength(0);
    expect(player.poll(Infinity).frames).toHaveLength(0);
  });

  it('refuses a clip without frames and nonsense options', () => {
    expect(() => new DemoPlayer({ frames: [], durationMs: 0 })).toThrow(RangeError);
    expect(() => new DemoPlayer(makeClip(), { gapMs: -1 })).toThrow(RangeError);
    expect(() => new DemoPlayer(makeClip(), { maxPerPoll: 0 })).toThrow(RangeError);
    expect(() => new DemoPlayer(makeClip(), { resyncMs: 0 })).toThrow(RangeError);
  });
});

describe('DemoPlayer through the runtime', () => {
  const FULL: readonly YoyoPhase[] = ['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught'];

  it('walks every phase in each pass when the engine re-calibrates at every restart', () => {
    const clip = buildDemoSession(DEMO_SEED);
    const player = new DemoPlayer(clip);
    const runtime = new YoyoRuntime(createConfig(), 'replay');
    const start = 7000;
    player.start(start);
    const passes: Array<Set<YoyoPhase>> = [new Set()];
    const launches: number[] = [0];
    for (let now = start; now < start + 3 * (clip.durationMs + 1000); now += 1000 / 60) {
      const poll = player.poll(now);
      if (poll.restarted) {
        runtime.recalibrate();
        passes.push(new Set());
        launches.push(0);
      }
      for (const f of poll.frames) runtime.pushFrame(f.frame, f.arrivalMs);
      const snapshot = runtime.advance(now);
      passes[passes.length - 1].add(snapshot.phase);
      launches[launches.length - 1] += snapshot.events.filter(e => e.kind === 'launch').length;
    }
    expect(passes.length).toBeGreaterThanOrEqual(3);
    // Two complete passes: the demo throws twice per pass and every phase shows up each time.
    for (const pass of passes.slice(0, 2)) {
      for (const phase of FULL) expect(pass.has(phase)).toBe(true);
    }
    expect(launches[0]).toBe(2);
    expect(launches[1]).toBe(2);
  });
});
