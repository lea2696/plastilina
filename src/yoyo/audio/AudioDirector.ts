import type { YoyoEvent, YoyoPhase, YoyoSnapshot } from '../contracts';
import { clamp, clamp01, finiteOr, lerp } from './math';
import type { DirectorFrame, HumCommand, OneShotCommand, OneShotKind } from './types';

/**
 * The pure half of the yoyo's audio (PRD_YOYO.md §1.3 and §6): given successive snapshots and a
 * clock it decides WHAT should sound, how loud and how long, and leaves HOW it sounds to the voice
 * builders. It knows nothing about Web Audio, so every rule here (mappings, rate limits, voice cap,
 * when the hum is allowed) is unit-tested in Node and the same decisions drive the live graph and
 * the offline QA render.
 *
 * It owns the loudness policy. Every gain it emits is a linear amplitude before the master chain,
 * bounded by the tables below, so a bug upstream (NaN spin, a wild strength) can never ask a voice
 * for more than its ceiling.
 */

// ---------------------------------------------------------------------------------------------
// Spin → hum
// ---------------------------------------------------------------------------------------------

/**
 * Below this spin the hum is silent, rad/s. It is the model's «giro agotado» threshold
 * (config.yoyo.exhaustedSpin): when the model calls the yoyo spent there is nothing left to hear.
 */
export const HUM_SPIN_SILENT = 15;

/**
 * Spin at which the hum reaches its full level, rad/s: the top of the canonical launch band
 * (config.yoyo.launchSpinMax, 750). A launch lands the yoyo at 400–770 rad/s, so a fresh sleeper
 * is at or near full level and the hum gets quieter as the spin decays (τ 4 s), which is the
 * cue that the sleeper is running out.
 */
export const HUM_SPIN_FULL = 750;

/** Spin the pitch mapping stops following, rad/s. The return can spin up to ~1000; this bounds it. */
export const HUM_SPIN_MAX = 1200;

/**
 * Hum fundamental = base + slope × spin. The PRD says «tono ∝ ω»; a strictly proportional pitch
 * would fall below 60 Hz for the last third of the sleeper, which laptop speakers cannot play, and
 * the tail would vanish early. An offset keeps the whole tail audible: 70 Hz at rest, 220 Hz (≈ A3)
 * at 750 rad/s, still strictly increasing with spin.
 */
export const HUM_BASE_HZ = 70;
export const HUM_HZ_PER_RAD = 0.2;

/** Full level of the hum, linear amplitude before the master chain (about −14 dBFS). */
export const HUM_GAIN_MAX = 0.2;

/**
 * Below 1 so the tail of a decaying sleeper stays audible for longer. A fresh sleeper (≈ 700 rad/s)
 * decays to 257 after 4 s and to 95 after 8 s; a straight line in spin would be 9 dB down at the
 * first of those and 19 dB at the second, 0.75 makes it 7 and 14. The hum is then still there while
 * the yoyo visibly spins, and only gives out as it nears the exhausted threshold.
 */
const HUM_GAIN_EXPONENT = 0.75;

/**
 * When the tracked hand has been gone this long the yoyo hangs «atenuado» (PRD §3): the hum is
 * ducked with it. Shorter dropouts are ignored so tracking jitter does not make the hum pump.
 */
export const HAND_LOST_GRACE_MS = 250;
export const HAND_LOST_HUM_FACTOR = 0.3;

/** Phases in which a spinning disc exists and can be heard. «Exhausted» is deliberately absent: it fades. */
const HUM_PHASES: ReadonlySet<YoyoPhase> = new Set<YoyoPhase>(['rolling', 'sleeping', 'returning', 'caught']);

/** Hum fundamental for a spin, Hz. Strictly increasing and bounded. */
export function humFrequencyHz(spin: number): number {
  return HUM_BASE_HZ + HUM_HZ_PER_RAD * clamp(finiteOr(spin, 0), 0, HUM_SPIN_MAX);
}

/**
 * Hum loudness for a spin: exactly 0 up to HUM_SPIN_SILENT, rising to HUM_GAIN_MAX at HUM_SPIN_FULL
 * and flat above it (a hard return does not get louder than a fresh sleeper).
 */
export function humGain(spin: number): number {
  const s = clamp01((finiteOr(spin, 0) - HUM_SPIN_SILENT) / (HUM_SPIN_FULL - HUM_SPIN_SILENT));
  return HUM_GAIN_MAX * Math.pow(s, HUM_GAIN_EXPONENT);
}

/** 0..1 brightness of the bearing texture: duller when slow, airier when fast. */
export function humBrightness(spin: number): number {
  return clamp01(finiteOr(spin, 0) / HUM_SPIN_FULL);
}

/** True once the hand has been missing longer than the grace period. */
export function handLost(hand: YoyoSnapshot['hand']): boolean {
  return !hand.present && hand.lostMs >= HAND_LOST_GRACE_MS;
}

/** Whether the snapshot calls for any hum at all. Cheap and allocation-free: it runs on every frame. */
export function humIsOn(snapshot: Pick<YoyoSnapshot, 'phase' | 'spin' | 'paused'>): boolean {
  if (snapshot.paused || !HUM_PHASES.has(snapshot.phase)) return false;
  return finiteOr(snapshot.spin, 0) > HUM_SPIN_SILENT;
}

/**
 * The hum the snapshot calls for, or null for silence. Silent while paused, with no yoyo, while it
 * only hangs («atado», «giro agotado») and below the spin that can be heard.
 */
export function humTarget(snapshot: Pick<YoyoSnapshot, 'phase' | 'spin' | 'paused' | 'hand'>): HumCommand | null {
  if (!humIsOn(snapshot)) return null;
  const spin = finiteOr(snapshot.spin, 0);
  const duck = handLost(snapshot.hand) ? HAND_LOST_HUM_FACTOR : 1;
  return { active: true, frequencyHz: humFrequencyHz(spin), gain: humGain(spin) * duck, brightness: humBrightness(spin) };
}

// ---------------------------------------------------------------------------------------------
// Event strength → one-shot
// ---------------------------------------------------------------------------------------------

/**
 * Launch stroke speed that maps to intensity 0 and 1, ih/s. 1.2 is the classifier's minimum
 * (config.launch.minDownSpeed); 3.5 is a hard throw (Y-02 scripts 1.5–3 m/s). Weaker is as quiet
 * as a whoosh gets, stronger is clamped: a throw is canonical, the sound only follows its energy.
 */
export const LAUNCH_STRENGTH_LOW = 1.2;
export const LAUNCH_STRENGTH_HIGH = 3.5;

/** Tug speed range, ih/s: the classifier's 0.04 ih in three frames is ≈ 0.4; a hard flick is ≈ 3. */
export const TUG_STRENGTH_LOW = 0.4;
export const TUG_STRENGTH_HIGH = 3;

/** Snap and catch impact speeds, m/s: a launch lands at about 1–2.5 m/s, the return climbs at up to 3. */
export const IMPACT_SPEED_LOW = 0.3;
export const IMPACT_SPEED_HIGH = 3;

/** Used when an event arrives without a usable strength: mid level rather than silent or loud. */
export const DEFAULT_INTENSITY = 0.5;
/** Self-returns and tie-ons carry no strength; they are softer than a deliberate gesture. */
export const AUTO_RETURN_INTENSITY = 0.35;
export const TETHER_INTENSITY = 0.6;
/** The tie-on that follows a catch comes 220 ms after the catch thud: kept small so it does not smear it. */
export const RETETHER_INTENSITY = 0.25;

function normalise(value: number | undefined, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_INTENSITY;
  return clamp01((value - low) / (high - low));
}

/** Launch speed (ih/s) → whoosh intensity 0..1. */
export function launchIntensity(strength: number | undefined): number {
  return normalise(strength, LAUNCH_STRENGTH_LOW, LAUNCH_STRENGTH_HIGH);
}

/** Tug speed (ih/s) → zip intensity 0..1. */
export function tugIntensity(strength: number | undefined): number {
  return normalise(strength, TUG_STRENGTH_LOW, TUG_STRENGTH_HIGH);
}

/** Impact speed (m/s) → snap or catch intensity 0..1. */
export function impactIntensity(speed: number | undefined): number {
  return normalise(speed, IMPACT_SPEED_LOW, IMPACT_SPEED_HIGH);
}

/** Axle radius, m (config.yoyo.axleRadius): winding speed = spin × radius. */
const AXLE_RADIUS_M = 0.003;
export const ZIP_DEFAULT_S = 0.45;
export const ZIP_MIN_S = 0.25;
export const ZIP_MAX_S = 0.8;

/**
 * How long the zip lasts: the time the yoyo needs to climb the exposed string at the spin the
 * tug just gave it (0.65 m at 300–1000 rad/s is 0.7–0.2 s), bounded. Sized to the real ascent so
 * the sweep ends about when the catch thud lands.
 */
export function zipDurationS(length: number, spin: number): number {
  const ascent = finiteOr(spin, 0) * AXLE_RADIUS_M;
  const out = finiteOr(length, 0);
  if (!(ascent > 0) || !(out > 0)) return ZIP_DEFAULT_S;
  return clamp(out / ascent, ZIP_MIN_S, ZIP_MAX_S);
}

// ---------------------------------------------------------------------------------------------
// Per-kind policy
// ---------------------------------------------------------------------------------------------

/** Level, length and spacing of one one-shot kind. Gains are linear peaks before the master chain. */
export interface OneShotProfile {
  /** Same-kind commands closer than this are dropped: no machine-gunning from a flapping signal. */
  minIntervalMs: number;
  /** Peak gain at intensity 0 and 1. */
  gainMin: number;
  gainMax: number;
  /** Duration at intensity 0 and 1, s. A stronger whoosh is shorter and snappier. */
  durationAtMinS: number;
  durationAtMaxS: number;
}

/**
 * Levels, measured solo before the master chain (scripts/yoyo-audio-qa.ts prints them). The whoosh
 * and the catch are the loudest at a hard throw (peak 0.5); the whoosh is the first thing of a throw
 * and has to cut through the hum that starts with it, so at full strength it sits ~4 dB (A-weighted)
 * over the hum at its full level. The zip is about level with the hum, the string tick a few dB
 * under it (it is meant to be tiny), the tie-on click a whisper.
 */
export const ONE_SHOT_PROFILES: Readonly<Record<OneShotKind, OneShotProfile>> = {
  whoosh: { minIntervalMs: 250, gainMin: 0.12, gainMax: 0.5, durationAtMinS: 0.36, durationAtMaxS: 0.22 },
  snap: { minIntervalMs: 120, gainMin: 0.12, gainMax: 0.3, durationAtMinS: 0.045, durationAtMaxS: 0.045 },
  zip: { minIntervalMs: 250, gainMin: 0.08, gainMax: 0.26, durationAtMinS: ZIP_DEFAULT_S, durationAtMaxS: ZIP_DEFAULT_S },
  catch: { minIntervalMs: 120, gainMin: 0.22, gainMax: 0.5, durationAtMinS: 0.24, durationAtMaxS: 0.3 },
  tether: { minIntervalMs: 100, gainMin: 0.08, gainMax: 0.18, durationAtMinS: 0.07, durationAtMaxS: 0.07 },
};

/** At most this many one-shots sound at once; a fifth would only smear the others. */
export const MAX_ONE_SHOT_VOICES = 4;

/** Hum updates are sent at most this often while it is active, ms (30 Hz): enough for smooth pitch, cheap to schedule. */
export const HUM_UPDATE_INTERVAL_MS = 33;

/**
 * An event this much older than its snapshot is not played. Events are normally within one frame
 * of the snapshot, so older ones only appear after a stall; a late whoosh for a throw that
 * happened a second ago would be a bug, not feedback.
 */
export const STALE_EVENT_MS = 250;

/** Voices cannot outlast this, ms. A recorded end further away than it means the clock jumped back. */
const LONGEST_VOICE_MS = 1000;

/** Builds the command for an intensity: gain and duration interpolated from the kind's profile, both bounded. */
export function buildOneShot(kind: OneShotKind, intensity: number, durationS?: number): OneShotCommand {
  const profile = ONE_SHOT_PROFILES[kind];
  const i = clamp01(finiteOr(intensity, DEFAULT_INTENSITY));
  return {
    kind,
    intensity: i,
    gain: lerp(profile.gainMin, profile.gainMax, i),
    durationS: durationS ?? lerp(profile.durationAtMinS, profile.durationAtMaxS, i),
  };
}

/** What each event kind sounds like. Events without a sound (exhausted, hand-lost, …) return null. */
export function commandForEvent(event: YoyoEvent, snapshot: Pick<YoyoSnapshot, 'length' | 'spin'>): OneShotCommand | null {
  switch (event.kind) {
    case 'launch':
      return buildOneShot('whoosh', launchIntensity(event.strength));
    case 'snap':
      return buildOneShot('snap', impactIntensity(event.strength));
    case 'tug':
      return buildOneShot('zip', tugIntensity(event.strength), zipDurationS(snapshot.length, snapshot.spin));
    case 'auto-return':
      return buildOneShot('zip', AUTO_RETURN_INTENSITY, zipDurationS(snapshot.length, snapshot.spin));
    case 'catch':
      return buildOneShot('catch', impactIntensity(event.strength));
    case 'tether':
      return buildOneShot('tether', TETHER_INTENSITY);
    case 'retether':
      return buildOneShot('tether', RETETHER_INTENSITY);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The director
// ---------------------------------------------------------------------------------------------

export interface AudioDirectorOptions {
  /** Concurrent one-shot cap. */
  maxVoices?: number;
  /** Minimum spacing of hum updates while active, ms. */
  humIntervalMs?: number;
}

/** Counters for diagnostics and tests: why sounds were or were not played. */
export interface DirectorStats {
  played: Record<OneShotKind, number>;
  /** Dropped by the per-kind rate limit. */
  rateLimited: number;
  /** Dropped because the voice cap was reached. */
  capped: number;
  /** Dropped because the event was too old. */
  stale: number;
  humCommands: number;
}

const NO_ONE_SHOTS: readonly OneShotCommand[] = Object.freeze([]);

/** Nothing to do this frame. Shared, so an idle frame allocates nothing. */
export const SILENCE: DirectorFrame = Object.freeze({ oneShots: NO_ONE_SHOTS, hum: null });

/**
 * Stateful policy: rate limits, voice cap, hum cadence, unlock and mute gating. Deterministic: its
 * only clock is the `nowMs` it is given, and it never reads the real one.
 *
 * Gating. Until `setUnlocked(true)` and while muted it is silent: events that arrive meanwhile are
 * dropped, not queued, so unmuting never replays old sounds. When muted mid-hum it asks the hum to
 * fade once, so the voice can wind down and be released instead of running for nobody.
 */
export class AudioDirector {
  readonly stats: DirectorStats = {
    played: { whoosh: 0, snap: 0, zip: 0, catch: 0, tether: 0 },
    rateLimited: 0,
    capped: 0,
    stale: 0,
    humCommands: 0,
  };

  private readonly maxVoices: number;
  private readonly humIntervalMs: number;
  private unlocked = false;
  private muted = false;
  private readonly lastFiredMs: Record<OneShotKind, number> = {
    whoosh: Number.NEGATIVE_INFINITY, snap: Number.NEGATIVE_INFINITY, zip: Number.NEGATIVE_INFINITY,
    catch: Number.NEGATIVE_INFINITY, tether: Number.NEGATIVE_INFINITY,
  };
  /** When each sounding one-shot ends, ms on the caller's clock. Kept compact, at most maxVoices long. */
  private readonly voiceEnds: number[] = [];
  private humActive = false;
  private humLastMs = Number.NEGATIVE_INFINITY;
  private humLast: HumCommand = { active: false, frequencyHz: HUM_BASE_HZ, gain: 0, brightness: 0 };

  constructor(options: AudioDirectorOptions = {}) {
    this.maxVoices = Math.max(1, Math.floor(finiteOr(options.maxVoices, MAX_ONE_SHOT_VOICES)));
    this.humIntervalMs = Math.max(0, finiteOr(options.humIntervalMs, HUM_UPDATE_INTERVAL_MS));
  }

  /** The user gesture happened: from now on sounds may play. Never undone except by `reset`. */
  setUnlocked(unlocked: boolean): void {
    this.unlocked = unlocked;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Forgets rate limits, voices and the hum state (restart, recalibration). Unlock and mute stay. */
  reset(): void {
    for (const kind of Object.keys(this.lastFiredMs) as OneShotKind[]) this.lastFiredMs[kind] = Number.NEGATIVE_INFINITY;
    this.voiceEnds.length = 0;
    this.humActive = false;
    this.humLastMs = Number.NEGATIVE_INFINITY;
  }

  /** One call per rendered frame with the latest snapshot. */
  update(snapshot: YoyoSnapshot, nowMs: number): DirectorFrame {
    if (!Number.isFinite(nowMs)) return SILENCE;
    const audible = this.unlocked && !this.muted;
    const oneShots = audible && !snapshot.paused && snapshot.events.length > 0 ? this.collect(snapshot, nowMs) : null;
    const hum = this.steerHum(audible && humIsOn(snapshot) ? snapshot : null, nowMs);
    if (oneShots === null && hum === null) return SILENCE;
    return { oneShots: oneShots ?? NO_ONE_SHOTS, hum };
  }

  private collect(snapshot: YoyoSnapshot, nowMs: number): OneShotCommand[] | null {
    let out: OneShotCommand[] | null = null;
    for (const event of snapshot.events) {
      if (snapshot.timeMs - event.timeMs > STALE_EVENT_MS) {
        this.stats.stale += 1;
        continue;
      }
      const command = commandForEvent(event, snapshot);
      if (command === null || !this.admit(command, nowMs)) continue;
      (out ??= []).push(command);
    }
    return out;
  }

  /** Rate limit first (cheap, per kind), then the voice cap (shared). */
  private admit(command: OneShotCommand, nowMs: number): boolean {
    const since = nowMs - this.lastFiredMs[command.kind];
    // A negative `since` is a clock that went backwards: treat the limit as expired instead of muting for good.
    if (since >= 0 && since < ONE_SHOT_PROFILES[command.kind].minIntervalMs) {
      this.stats.rateLimited += 1;
      return false;
    }
    this.pruneVoices(nowMs);
    if (this.voiceEnds.length >= this.maxVoices) {
      this.stats.capped += 1;
      return false;
    }
    this.lastFiredMs[command.kind] = nowMs;
    this.voiceEnds.push(nowMs + command.durationS * 1000);
    this.stats.played[command.kind] += 1;
    return true;
  }

  /** Drops voices that have ended, and any whose end lies impossibly far ahead (the clock jumped back). */
  private pruneVoices(nowMs: number): void {
    let kept = 0;
    for (const end of this.voiceEnds) {
      if (end > nowMs && end - nowMs <= LONGEST_VOICE_MS) this.voiceEnds[kept++] = end;
    }
    this.voiceEnds.length = kept;
  }

  /**
   * Active hum: one command per interval. Going quiet: exactly one inactive command (with the last
   * pitch, so the fade glides instead of dropping to the base), then nothing until it is active again.
   * `snapshot` is null when the hum is off; the target is only built when a command is really sent,
   * so frames the cadence discards allocate nothing.
   */
  private steerHum(snapshot: YoyoSnapshot | null, nowMs: number): HumCommand | null {
    if (snapshot === null) {
      if (!this.humActive) return null;
      this.humActive = false;
      this.humLastMs = nowMs;
      this.stats.humCommands += 1;
      return { active: false, frequencyHz: this.humLast.frequencyHz, gain: 0, brightness: this.humLast.brightness };
    }
    const since = nowMs - this.humLastMs;
    if (this.humActive && since >= 0 && since < this.humIntervalMs) return null;
    const target = humTarget(snapshot);
    if (target === null) return null;
    this.humActive = true;
    this.humLastMs = nowMs;
    this.humLast = target;
    this.stats.humCommands += 1;
    return target;
  }
}
