import { describe, expect, it } from 'vitest';
import type { YoyoEvent, YoyoEventKind, YoyoPhase, YoyoSnapshot } from '../contracts';
import {
  AudioDirector, AUTO_RETURN_INTENSITY, buildOneShot, commandForEvent, DEFAULT_INTENSITY, handLost, HAND_LOST_GRACE_MS,
  HAND_LOST_HUM_FACTOR, humBrightness, humFrequencyHz, humGain, HUM_BASE_HZ, HUM_GAIN_MAX, HUM_HZ_PER_RAD,
  HUM_SPIN_FULL, HUM_SPIN_MAX, HUM_SPIN_SILENT, HUM_UPDATE_INTERVAL_MS, humTarget, impactIntensity, launchIntensity,
  MAX_ONE_SHOT_VOICES, ONE_SHOT_PROFILES, RETETHER_INTENSITY, SILENCE, STALE_EVENT_MS, TETHER_INTENSITY, tugIntensity,
  ZIP_DEFAULT_S, ZIP_MAX_S, ZIP_MIN_S, zipDurationS,
} from './AudioDirector';
import { Xorshift32 } from './math';
import { buildSnapshot } from './snapshots';
import { ONE_SHOT_KINDS, type OneShotKind } from './types';

const event = (kind: YoyoEventKind, timeMs: number, strength?: number): YoyoEvent =>
  strength === undefined ? { kind, timeMs } : { kind, timeMs, strength };

/** A snapshot at `timeMs` carrying events stamped at that same time, like a frame the engine just ran. */
const frameWith = (timeMs: number, events: YoyoEvent[], over: Partial<YoyoSnapshot> = {}) =>
  buildSnapshot({ timeMs, events, ...over });

const spinning = (spin: number, phase: YoyoPhase = 'sleeping', over: Partial<YoyoSnapshot> = {}) =>
  buildSnapshot({ phase, spin, ...over });

function unlockedDirector(options?: ConstructorParameters<typeof AudioDirector>[0]) {
  const director = new AudioDirector(options);
  director.setUnlocked(true);
  return director;
}

describe('hum mapping', () => {
  it('raises the pitch strictly with spin and keeps it bounded', () => {
    let previous = humFrequencyHz(0);
    expect(previous).toBe(HUM_BASE_HZ);
    for (let spin = 1; spin <= HUM_SPIN_MAX; spin += 1) {
      const f = humFrequencyHz(spin);
      expect(f).toBeGreaterThan(previous);
      previous = f;
    }
    const ceiling = HUM_BASE_HZ + HUM_HZ_PER_RAD * HUM_SPIN_MAX;
    expect(humFrequencyHz(HUM_SPIN_MAX)).toBeCloseTo(ceiling, 9);
    // Past the cap the pitch stops following: a hard return does not whistle.
    expect(humFrequencyHz(5000)).toBeCloseTo(ceiling, 9);
  });

  it('puts the top of the canonical launch band at A3 and keeps the sleeper range audible on laptop speakers', () => {
    expect(humFrequencyHz(750)).toBeCloseTo(220, 6);
    // The whole band of a fresh sleeper (400–770 rad/s) stays above 140 Hz.
    expect(humFrequencyHz(400)).toBeGreaterThan(140);
    expect(humFrequencyHz(770)).toBeLessThan(230);
  });

  it('is silent up to the exhausted spin and rises monotonically after it', () => {
    expect(humGain(0)).toBe(0);
    expect(humGain(HUM_SPIN_SILENT)).toBe(0);
    expect(humGain(HUM_SPIN_SILENT + 1)).toBeGreaterThan(0);
    let previous = 0;
    for (let spin = 0; spin <= 1500; spin += 1) {
      const g = humGain(spin);
      expect(g).toBeGreaterThanOrEqual(previous);
      if (spin > HUM_SPIN_SILENT && spin <= HUM_SPIN_FULL) expect(g).toBeGreaterThan(previous);
      previous = g;
    }
  });

  it('is moderate at ~700 rad/s, softer at 300 and flat above the full-level spin', () => {
    expect(humGain(700)).toBeGreaterThan(0.85 * HUM_GAIN_MAX);
    expect(humGain(700)).toBeLessThanOrEqual(HUM_GAIN_MAX);
    expect(humGain(300)).toBeLessThan(0.55 * HUM_GAIN_MAX);
    expect(humGain(100)).toBeLessThan(0.25 * HUM_GAIN_MAX);
    expect(humGain(HUM_SPIN_FULL)).toBeCloseTo(HUM_GAIN_MAX, 12);
    expect(humGain(1000)).toBe(humGain(HUM_SPIN_FULL));
    // The steps are audible: about 5-6 dB from 300 to 700.
    const db = 20 * Math.log10(humGain(700) / humGain(300));
    expect(db).toBeGreaterThan(4.5);
    expect(db).toBeLessThan(12);
  });

  it('keeps a decaying sleeper audible for most of its life: under 8 dB down after 4 s, under 16 after 8 s', () => {
    const level = (seconds: number) => 20 * Math.log10(humGain(750 * Math.exp(-seconds / 4)) / HUM_GAIN_MAX);
    expect(level(4)).toBeGreaterThan(-8);
    expect(level(8)).toBeGreaterThan(-16);
    expect(level(12)).toBeLessThan(-16);
  });

  it('keeps brightness in 0..1, rising with spin', () => {
    expect(humBrightness(0)).toBe(0);
    expect(humBrightness(HUM_SPIN_FULL)).toBe(1);
    expect(humBrightness(5000)).toBe(1);
    expect(humBrightness(300)).toBeLessThan(humBrightness(500));
  });

  it('survives garbage spin: always finite and inside the ceilings', () => {
    for (const spin of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50, -1e9, 1e9, 1e300]) {
      const f = humFrequencyHz(spin);
      const g = humGain(spin);
      const b = humBrightness(spin);
      expect(Number.isFinite(f) && Number.isFinite(g) && Number.isFinite(b)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(HUM_BASE_HZ);
      expect(f).toBeLessThanOrEqual(HUM_BASE_HZ + HUM_HZ_PER_RAD * HUM_SPIN_MAX);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(HUM_GAIN_MAX);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });
});

describe('humTarget', () => {
  const hand = buildSnapshot().hand;

  it('is on for every phase with a spinning disc and off for the others', () => {
    const on: YoyoPhase[] = ['rolling', 'sleeping', 'returning', 'caught'];
    const off: YoyoPhase[] = ['untethered', 'tethered', 'exhausted'];
    for (const phase of on) expect(humTarget({ phase, spin: 500, paused: false, hand })?.active, phase).toBe(true);
    for (const phase of off) expect(humTarget({ phase, spin: 500, paused: false, hand }), phase).toBeNull();
  });

  it('is off while paused and below the exhausted spin', () => {
    expect(humTarget({ phase: 'sleeping', spin: 500, paused: true, hand })).toBeNull();
    expect(humTarget({ phase: 'sleeping', spin: HUM_SPIN_SILENT, paused: false, hand })).toBeNull();
    expect(humTarget({ phase: 'sleeping', spin: 0, paused: false, hand })).toBeNull();
    expect(humTarget({ phase: 'sleeping', spin: Number.NaN, paused: false, hand })).toBeNull();
    expect(humTarget({ phase: 'sleeping', spin: HUM_SPIN_SILENT + 0.5, paused: false, hand })?.active).toBe(true);
  });

  it('carries the mapping of the spin', () => {
    const target = humTarget({ phase: 'rolling', spin: 600, paused: false, hand });
    expect(target).toEqual({ active: true, frequencyHz: humFrequencyHz(600), gain: humGain(600), brightness: humBrightness(600) });
  });

  it('ducks the hum once the hand has been gone past the grace period, never raising it', () => {
    const present = humTarget({ phase: 'sleeping', spin: 600, paused: false, hand })!;
    const blink = humTarget({ phase: 'sleeping', spin: 600, paused: false, hand: { ...hand, present: false, lostMs: HAND_LOST_GRACE_MS - 1 } })!;
    const gone = humTarget({ phase: 'sleeping', spin: 600, paused: false, hand: { ...hand, present: false, lostMs: HAND_LOST_GRACE_MS } })!;
    expect(blink.gain).toBe(present.gain);
    expect(gone.gain).toBeCloseTo(present.gain * HAND_LOST_HUM_FACTOR, 12);
    expect(gone.gain).toBeLessThan(present.gain);
    expect(gone.frequencyHz).toBe(present.frequencyHz);
    expect(handLost({ ...hand, present: true, lostMs: 5000 })).toBe(false);
  });
});

describe('strength mappings', () => {
  it('maps the launch stroke range onto 0..1, monotonic and clamped', () => {
    expect(launchIntensity(1.2)).toBe(0);
    expect(launchIntensity(3.5)).toBe(1);
    expect(launchIntensity(2.35)).toBeCloseTo(0.5, 12);
    expect(launchIntensity(0.1)).toBe(0);
    expect(launchIntensity(40)).toBe(1);
    let previous = -1;
    for (let strength = 0; strength <= 6; strength += 0.05) {
      const i = launchIntensity(strength);
      expect(i).toBeGreaterThanOrEqual(previous);
      previous = i;
    }
  });

  it('falls back to the middle for a missing or non-finite strength', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(launchIntensity(bad)).toBe(DEFAULT_INTENSITY);
      expect(tugIntensity(bad)).toBe(DEFAULT_INTENSITY);
      expect(impactIntensity(bad)).toBe(DEFAULT_INTENSITY);
    }
  });

  it('maps tug and impact speeds onto 0..1', () => {
    expect(tugIntensity(0.4)).toBe(0);
    expect(tugIntensity(3)).toBe(1);
    expect(tugIntensity(1.7)).toBeCloseTo(0.5, 12);
    expect(impactIntensity(0.3)).toBe(0);
    expect(impactIntensity(3)).toBe(1);
    expect(impactIntensity(-1)).toBe(0);
  });

  it('sizes the zip to the climb: faster spin, shorter sweep, always bounded', () => {
    expect(zipDurationS(0.65, 600)).toBeCloseTo(0.65 / (600 * 0.003), 12);
    expect(zipDurationS(0.65, 900)).toBeLessThan(zipDurationS(0.65, 500));
    expect(zipDurationS(0.65, 100000)).toBe(ZIP_MIN_S);
    expect(zipDurationS(0.65, 1)).toBe(ZIP_MAX_S);
    for (const [length, spin] of [[0, 600], [0.65, 0], [Number.NaN, 600], [0.65, Number.NaN], [-1, -1]]) {
      expect(zipDurationS(length, spin)).toBe(ZIP_DEFAULT_S);
    }
  });
});

describe('buildOneShot', () => {
  it('interpolates gain between the profile bounds, monotonic in intensity', () => {
    for (const kind of ONE_SHOT_KINDS) {
      const profile = ONE_SHOT_PROFILES[kind];
      expect(buildOneShot(kind, 0).gain).toBeCloseTo(profile.gainMin, 12);
      expect(buildOneShot(kind, 1).gain).toBeCloseTo(profile.gainMax, 12);
      let previous = 0;
      for (let i = 0; i <= 1; i += 0.05) {
        const gain = buildOneShot(kind, i).gain;
        expect(gain).toBeGreaterThanOrEqual(previous);
        expect(gain).toBeGreaterThanOrEqual(profile.gainMin);
        expect(gain).toBeLessThanOrEqual(profile.gainMax);
        previous = gain;
      }
    }
  });

  it('makes a harder whoosh louder and shorter', () => {
    const soft = buildOneShot('whoosh', 0);
    const hard = buildOneShot('whoosh', 1);
    expect(hard.gain).toBeGreaterThan(soft.gain);
    expect(hard.durationS).toBeLessThan(soft.durationS);
  });

  it('never asks a voice for more than its ceiling, whatever the intensity', () => {
    for (const kind of ONE_SHOT_KINDS) {
      for (const bad of [Number.NaN, -3, 7, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const command = buildOneShot(kind, bad);
        expect(command.intensity).toBeGreaterThanOrEqual(0);
        expect(command.intensity).toBeLessThanOrEqual(1);
        expect(command.gain).toBeLessThanOrEqual(ONE_SHOT_PROFILES[kind].gainMax);
        expect(command.gain).toBeGreaterThanOrEqual(ONE_SHOT_PROFILES[kind].gainMin);
        expect(command.durationS).toBeGreaterThan(0);
      }
    }
    // All one-shot ceilings together stay below the hum's order of magnitude plus a few dB.
    for (const kind of ONE_SHOT_KINDS) expect(ONE_SHOT_PROFILES[kind].gainMax).toBeLessThanOrEqual(0.5);
  });
});

describe('commandForEvent', () => {
  const rest = { length: 0.65, spin: 600 };

  it('turns launch, snap, tug, auto-return, catch, tether and retether into their sounds', () => {
    expect(commandForEvent(event('launch', 0, 2.4), rest)?.kind).toBe('whoosh');
    expect(commandForEvent(event('snap', 0, 1.9), rest)?.kind).toBe('snap');
    expect(commandForEvent(event('tug', 0, 1.5), rest)?.kind).toBe('zip');
    expect(commandForEvent(event('auto-return', 0), rest)?.kind).toBe('zip');
    expect(commandForEvent(event('catch', 0, 1.2), rest)?.kind).toBe('catch');
    expect(commandForEvent(event('tether', 0), rest)?.kind).toBe('tether');
    expect(commandForEvent(event('retether', 0), rest)?.kind).toBe('tether');
  });

  it('keeps exhausted, return-failed, hand-lost and hand-found silent', () => {
    for (const kind of ['exhausted', 'return-failed', 'hand-lost', 'hand-found'] as const) {
      expect(commandForEvent(event(kind, 0), rest), kind).toBeNull();
    }
  });

  it('follows the launch strength: louder and brighter as the throw gets harder', () => {
    const strengths = [1.2, 1.8, 2.4, 3, 3.5];
    const commands = strengths.map((s) => commandForEvent(event('launch', 0, s), rest)!);
    for (let i = 1; i < commands.length; i += 1) {
      expect(commands[i].gain).toBeGreaterThan(commands[i - 1].gain);
      expect(commands[i].intensity).toBeGreaterThan(commands[i - 1].intensity);
    }
    expect(commands[0].intensity).toBe(0);
    expect(commands[commands.length - 1].intensity).toBe(1);
    // A hard throw beyond the range is the same as the top of it.
    expect(commandForEvent(event('launch', 0, 9), rest)!.gain).toBe(commands[commands.length - 1].gain);
  });

  it('gives a self-return a soft zip and the tie-ons their fixed softness', () => {
    expect(commandForEvent(event('auto-return', 0), rest)!.intensity).toBe(AUTO_RETURN_INTENSITY);
    expect(commandForEvent(event('tether', 0), rest)!.intensity).toBe(TETHER_INTENSITY);
    expect(commandForEvent(event('retether', 0), rest)!.intensity).toBe(RETETHER_INTENSITY);
    expect(commandForEvent(event('retether', 0), rest)!.gain).toBeLessThan(commandForEvent(event('tether', 0), rest)!.gain);
  });

  it('sizes the zip from the string that has to be wound', () => {
    const fast = commandForEvent(event('tug', 0, 2), { length: 0.65, spin: 900 })!;
    const slow = commandForEvent(event('tug', 0, 2), { length: 0.65, spin: 400 })!;
    expect(fast.durationS).toBeLessThan(slow.durationS);
    expect(slow.durationS).toBeLessThanOrEqual(ZIP_MAX_S);
  });
});

describe('AudioDirector gating', () => {
  it('stays silent before unlock, whatever happens, and allocates nothing for it', () => {
    const director = new AudioDirector();
    for (let i = 0; i < 120; i += 1) {
      const t = i * 16.7;
      const frame = director.update(
        frameWith(t, [event('launch', t, 3), event('snap', t, 2), event('catch', t, 2)], { phase: 'rolling', spin: 700 }),
        t,
      );
      expect(frame).toBe(SILENCE);
    }
    expect(director.stats.played).toEqual({ whoosh: 0, snap: 0, zip: 0, catch: 0, tether: 0 });
    expect(director.stats.humCommands).toBe(0);
  });

  it('plays after unlock, and does not replay what happened before it', () => {
    const director = new AudioDirector();
    expect(director.update(frameWith(0, [event('launch', 0, 2)], { phase: 'rolling', spin: 600 }), 0)).toBe(SILENCE);
    director.setUnlocked(true);
    const after = director.update(spinning(600, 'rolling', { timeMs: 16 }), 16);
    expect(after.oneShots).toHaveLength(0);
    expect(after.hum?.active).toBe(true);
    const launched = director.update(frameWith(300, [event('launch', 300, 2)], { phase: 'rolling', spin: 600 }), 300);
    expect(launched.oneShots.map((c) => c.kind)).toEqual(['whoosh']);
  });

  it('is silent while muted, fades the hum exactly once, and does not queue events for the unmute', () => {
    const director = unlockedDirector();
    expect(director.update(spinning(600), 0).hum?.active).toBe(true);
    director.setMuted(true);
    const fade = director.update(frameWith(100, [event('snap', 100, 2)], { phase: 'sleeping', spin: 600 }), 100);
    expect(fade.oneShots).toHaveLength(0);
    expect(fade.hum).toMatchObject({ active: false, gain: 0 });
    for (let i = 1; i <= 30; i += 1) {
      const t = 100 + i * 16.7;
      expect(director.update(frameWith(t, [event('launch', t, 3)], { phase: 'rolling', spin: 700 }), t)).toBe(SILENCE);
    }
    director.setMuted(false);
    const back = director.update(spinning(600, 'sleeping', { timeMs: 700 }), 700);
    expect(back.oneShots).toHaveLength(0);
    expect(back.hum?.active).toBe(true);
  });

  it('plays no one-shots and no hum while paused, even with events in the snapshot', () => {
    const director = unlockedDirector();
    director.update(spinning(600), 0);
    const paused = director.update(frameWith(50, [event('launch', 50, 3)], { phase: 'rolling', spin: 600, paused: true }), 50);
    expect(paused.oneShots).toHaveLength(0);
    expect(paused.hum).toMatchObject({ active: false });
    expect(director.update(buildSnapshot({ phase: 'rolling', spin: 600, paused: true, timeMs: 80 }), 80)).toBe(SILENCE);
  });

  it('ignores frames whose clock is not a number', () => {
    const director = unlockedDirector();
    expect(director.update(frameWith(0, [event('launch', 0, 2)], { phase: 'rolling', spin: 600 }), Number.NaN)).toBe(SILENCE);
    expect(director.update(frameWith(0, [event('launch', 0, 2)], { phase: 'rolling', spin: 600 }), Number.POSITIVE_INFINITY)).toBe(SILENCE);
    expect(director.stats.played.whoosh).toBe(0);
  });

  it('does not play events that are too old for their snapshot', () => {
    const director = unlockedDirector();
    const stale = director.update(frameWith(1000, [event('launch', 1000 - STALE_EVENT_MS - 1, 3)]), 1000);
    expect(stale.oneShots).toHaveLength(0);
    expect(director.stats.stale).toBe(1);
    const fresh = director.update(frameWith(2000, [event('launch', 2000 - STALE_EVENT_MS, 3)]), 2000);
    expect(fresh.oneShots).toHaveLength(1);
  });

  it('reset forgets rate limits and voices but keeps the unlock', () => {
    const director = unlockedDirector();
    expect(director.update(frameWith(0, [event('launch', 0, 2)]), 0).oneShots).toHaveLength(1);
    expect(director.update(frameWith(10, [event('launch', 10, 2)]), 10).oneShots).toHaveLength(0);
    director.reset();
    expect(director.update(frameWith(20, [event('launch', 20, 2)]), 20).oneShots).toHaveLength(1);
  });
});

describe('one-shot rate limits', () => {
  it.each(ONE_SHOT_KINDS)('drops a second %s inside its minimum interval and allows it after', (kind: OneShotKind) => {
    const sourceEvent: Record<OneShotKind, YoyoEventKind> = { whoosh: 'launch', snap: 'snap', zip: 'tug', catch: 'catch', tether: 'tether' };
    const gap = ONE_SHOT_PROFILES[kind].minIntervalMs;
    const director = unlockedDirector();
    const play = (t: number) => director.update(frameWith(t, [event(sourceEvent[kind], t, 2)]), t).oneShots.length;
    expect(play(1000)).toBe(1);
    expect(play(1000 + gap - 1)).toBe(0);
    expect(play(1000 + gap)).toBe(1);
    expect(director.stats.rateLimited).toBe(1);
  });

  it('limits kinds independently, and counts a tug and an auto-return as the same zip', () => {
    const director = unlockedDirector();
    const kinds = director.update(frameWith(0, [event('launch', 0, 2), event('snap', 0, 2)]), 0).oneShots.map((c) => c.kind);
    expect(kinds).toEqual(['whoosh', 'snap']);
    expect(director.update(frameWith(20, [event('tug', 20, 2)]), 20).oneShots).toHaveLength(1);
    expect(director.update(frameWith(40, [event('auto-return', 40)]), 40).oneShots).toHaveLength(0);
  });

  it('collapses a burst of the same event inside one snapshot to one sound', () => {
    const director = unlockedDirector();
    const burst = Array.from({ length: 6 }, (_, i) => event('snap', i, 2));
    expect(director.update(frameWith(5, burst), 5).oneShots).toHaveLength(1);
    expect(director.stats.rateLimited).toBe(5);
  });

  it('recovers from a clock that jumps backwards instead of staying muted', () => {
    const director = unlockedDirector();
    expect(director.update(frameWith(100000, [event('catch', 100000, 2)]), 100000).oneShots).toHaveLength(1);
    expect(director.update(frameWith(50, [event('catch', 50, 2)]), 50).oneShots).toHaveLength(1);
  });
});

describe('voice cap', () => {
  const allKinds = (t: number) => [event('launch', t, 2), event('snap', t, 2), event('tug', t, 2), event('catch', t, 2), event('tether', t)];

  it('lets at most four one-shots sound at once and drops the rest', () => {
    expect(MAX_ONE_SHOT_VOICES).toBe(4);
    const director = unlockedDirector();
    const frame = director.update(frameWith(0, allKinds(0)), 0);
    expect(frame.oneShots.map((c) => c.kind)).toEqual(['whoosh', 'snap', 'zip', 'catch']);
    expect(director.stats.capped).toBe(1);
    expect(director.stats.played.tether).toBe(0);
  });

  it('frees voices as they end', () => {
    const director = unlockedDirector();
    director.update(frameWith(0, allKinds(0)), 0);
    // 80 ms later the short snap is over (45 ms), so a tether fits again.
    expect(director.update(frameWith(80, [event('tether', 80)]), 80).oneShots).toHaveLength(1);
  });

  it('honours a custom cap', () => {
    const director = unlockedDirector({ maxVoices: 2 });
    expect(director.update(frameWith(0, allKinds(0)), 0).oneShots.map((c) => c.kind)).toEqual(['whoosh', 'snap']);
    expect(director.stats.capped).toBe(3);
  });

  it('drops voices recorded impossibly far in the future when the clock goes back', () => {
    const director = unlockedDirector({ maxVoices: 1 });
    expect(director.update(frameWith(50000, [event('launch', 50000, 2)]), 50000).oneShots).toHaveLength(1);
    // Back at t = 100 ms the recorded end (50.36 s) cannot be real; the voice does not block for 50 s.
    expect(director.update(frameWith(100, [event('snap', 100, 2)]), 100).oneShots).toHaveLength(1);
  });

  it('never exceeds the cap in a long random storm of events', () => {
    const director = unlockedDirector();
    const random = new Xorshift32(7);
    const kinds: YoyoEventKind[] = ['launch', 'snap', 'tug', 'auto-return', 'catch', 'tether', 'retether'];
    const active: number[] = [];
    let admitted = 0;
    for (let i = 0; i < 6000; i += 1) {
      const t = i * (1000 / 60);
      const events: YoyoEvent[] = [];
      const count = Math.floor(random.next() * 4);
      for (let k = 0; k < count; k += 1) events.push(event(kinds[Math.floor(random.next() * kinds.length)], t, random.next() * 4));
      const frame = director.update(frameWith(t, events), t);
      for (let n = active.length - 1; n >= 0; n -= 1) if (active[n] <= t) active.splice(n, 1);
      for (const command of frame.oneShots) {
        active.push(t + command.durationS * 1000);
        admitted += 1;
      }
      expect(active.length).toBeLessThanOrEqual(MAX_ONE_SHOT_VOICES);
    }
    expect(admitted).toBeGreaterThan(100);
  });
});

describe('hum steering', () => {
  it('sends the hum at most every update interval while active, and every frame at slower frame rates', () => {
    const director = unlockedDirector();
    const sent: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      const t = i * (1000 / 60);
      if (director.update(spinning(600, 'sleeping', { timeMs: t }), t).hum) sent.push(t);
    }
    // One second at 60 fps: 30–31 updates, never closer than the interval.
    expect(sent.length).toBeGreaterThanOrEqual(29);
    expect(sent.length).toBeLessThanOrEqual(31);
    for (let i = 1; i < sent.length; i += 1) expect(sent[i] - sent[i - 1]).toBeGreaterThanOrEqual(HUM_UPDATE_INTERVAL_MS);

    const slow = unlockedDirector();
    let slowSent = 0;
    for (let i = 0; i < 30; i += 1) if (slow.update(spinning(600), i * 50).hum) slowSent += 1;
    expect(slowSent).toBe(30);
  });

  it('hands back the shared silent frame on frames the cadence skips, so a steady hum allocates nothing between updates', () => {
    const director = unlockedDirector();
    expect(director.update(spinning(600), 0).hum).not.toBeNull();
    expect(director.update(spinning(600), 16.7)).toBe(SILENCE);
    expect(director.update(spinning(600), 33.4).hum).not.toBeNull();
    expect(director.update(spinning(600), 50.1)).toBe(SILENCE);
  });

  it('starts at once and stops with exactly one fading command that keeps the last pitch', () => {
    const director = unlockedDirector();
    const first = director.update(spinning(640), 0);
    expect(first.hum).toMatchObject({ active: true, frequencyHz: humFrequencyHz(640), gain: humGain(640) });
    director.update(spinning(630), 40);
    const off = director.update(spinning(0, 'exhausted'), 60);
    expect(off.hum).toEqual({ active: false, frequencyHz: humFrequencyHz(630), gain: 0, brightness: humBrightness(630) });
    for (let i = 1; i < 120; i += 1) expect(director.update(spinning(0, 'exhausted'), 60 + i * 16.7)).toBe(SILENCE);
    // And back on, immediately, without waiting for the update interval.
    expect(director.update(spinning(500), 60 + 120 * 16.7).hum?.active).toBe(true);
  });

  it('goes silent in the phases and conditions that must not hum', () => {
    const cases: Array<[string, Partial<YoyoSnapshot>]> = [
      ['untethered', { phase: 'untethered', spin: 600 }],
      ['tethered', { phase: 'tethered', spin: 600 }],
      ['exhausted', { phase: 'exhausted', spin: 600 }],
      ['paused', { phase: 'sleeping', spin: 600, paused: true }],
      ['no spin', { phase: 'sleeping', spin: 0 }],
    ];
    for (const [name, over] of cases) {
      const director = unlockedDirector();
      for (let i = 0; i < 30; i += 1) expect(director.update(buildSnapshot(over), i * 16.7), name).toBe(SILENCE);
      expect(director.stats.humCommands, name).toBe(0);
    }
  });

  it('keeps a decaying sleeper smooth: pitch and level only ever fall, in small steps, then one fade', () => {
    const director = unlockedDirector();
    const trace: Array<{ f: number; g: number; active: boolean }> = [];
    for (let i = 0; i < 17 * 60; i += 1) {
      const t = i * (1000 / 60);
      const spin = 750 * Math.exp(-t / 4000);
      const hum = director.update(spinning(spin, 'sleeping', { timeMs: t }), t).hum;
      if (hum) trace.push({ f: hum.frequencyHz, g: hum.gain, active: hum.active });
    }
    const last = trace[trace.length - 1];
    expect(last.active).toBe(false);
    expect(trace.filter((c) => !c.active)).toHaveLength(1);
    const live = trace.filter((c) => c.active);
    expect(live.length).toBeGreaterThan(300);
    for (let i = 1; i < live.length; i += 1) {
      expect(live[i].f).toBeLessThanOrEqual(live[i - 1].f);
      expect(live[i].g).toBeLessThanOrEqual(live[i - 1].g);
      expect(live[i - 1].f - live[i].f).toBeLessThan(3);
      expect(live[i - 1].g - live[i].g).toBeLessThan(0.01);
    }
  });

  it('ducks the hum when the hand is lost and brings it back when it returns', () => {
    const director = unlockedDirector();
    const present = director.update(spinning(600), 0).hum!;
    const gone = director.update(spinning(600, 'sleeping', { hand: { ...buildSnapshot().hand, present: false, lostMs: 400 } }), 100).hum!;
    expect(gone.gain).toBeCloseTo(present.gain * HAND_LOST_HUM_FACTOR, 12);
    const found = director.update(spinning(600), 200).hum!;
    expect(found.gain).toBeCloseTo(present.gain, 12);
  });
});

describe('determinism and robustness', () => {
  function script(): Array<[YoyoSnapshot, number]> {
    const random = new Xorshift32(99);
    const phases: YoyoPhase[] = ['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'exhausted'];
    const kinds: YoyoEventKind[] = ['tether', 'launch', 'snap', 'tug', 'auto-return', 'catch', 'retether', 'exhausted', 'return-failed', 'hand-lost', 'hand-found'];
    const out: Array<[YoyoSnapshot, number]> = [];
    for (let i = 0; i < 2000; i += 1) {
      const t = i * 16.7;
      const events: YoyoEvent[] = [];
      if (random.next() < 0.3) events.push(event(kinds[Math.floor(random.next() * kinds.length)], t - random.next() * 100, random.next() * 4));
      out.push([
        frameWith(t, events, { phase: phases[Math.floor(random.next() * phases.length)], spin: random.next() * 900, paused: random.next() < 0.05 }),
        t,
      ]);
    }
    return out;
  }

  it('gives the same commands for the same input', () => {
    const run = () => {
      const director = unlockedDirector();
      return script().map(([snapshot, t]) => director.update(snapshot, t));
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('never throws and never emits an out-of-range or non-finite value, even for garbage', () => {
    const random = new Xorshift32(2024);
    const director = unlockedDirector();
    const garbage = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1e12, -1e12, 2.5];
    const pick = () => garbage[Math.floor(random.next() * garbage.length)];
    const phases: YoyoPhase[] = ['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'exhausted'];
    const kinds: YoyoEventKind[] = ['tether', 'launch', 'snap', 'tug', 'auto-return', 'catch', 'retether', 'exhausted', 'return-failed', 'hand-lost', 'hand-found'];
    let t = 0;
    for (let i = 0; i < 5000; i += 1) {
      t += random.next() * 40;
      const events: YoyoEvent[] = [];
      const count = Math.floor(random.next() * 3);
      for (let k = 0; k < count; k += 1) events.push({ kind: kinds[Math.floor(random.next() * kinds.length)], timeMs: random.next() < 0.5 ? t : pick(), strength: random.next() < 0.5 ? pick() : undefined });
      const snapshot = frameWith(random.next() < 0.1 ? pick() : t, events, {
        phase: phases[Math.floor(random.next() * phases.length)],
        spin: random.next() < 0.5 ? pick() : random.next() * 1000,
        length: pick(),
      });
      const frame = director.update(snapshot, t);
      for (const c of frame.oneShots) {
        expect(Number.isFinite(c.gain) && Number.isFinite(c.intensity) && Number.isFinite(c.durationS)).toBe(true);
        expect(c.gain).toBeGreaterThanOrEqual(ONE_SHOT_PROFILES[c.kind].gainMin);
        expect(c.gain).toBeLessThanOrEqual(ONE_SHOT_PROFILES[c.kind].gainMax);
        expect(c.intensity).toBeGreaterThanOrEqual(0);
        expect(c.intensity).toBeLessThanOrEqual(1);
        expect(c.durationS).toBeGreaterThan(0);
        expect(c.durationS).toBeLessThanOrEqual(1);
      }
      if (frame.hum) {
        expect(Number.isFinite(frame.hum.frequencyHz) && Number.isFinite(frame.hum.gain) && Number.isFinite(frame.hum.brightness)).toBe(true);
        expect(frame.hum.gain).toBeGreaterThanOrEqual(0);
        expect(frame.hum.gain).toBeLessThanOrEqual(HUM_GAIN_MAX);
      }
    }
  });
});
