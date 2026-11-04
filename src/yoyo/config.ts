import type { Responsiveness } from './contracts';

/**
 * Every tunable of the yoyó in one object, editable live from «Ajustes → Avanzado».
 * Perception thresholds are in image heights (ih) and ih/s on raw 30 fps samples; physics is
 * in SI units. Defaults follow PRD_YOYO.md; departures are recorded in docs/yoyo/DECISIONS.md.
 */
export interface YoyoConfig {
  preset: Preset;
  responsiveness: Responsiveness;
  world: {
    /** Metres of world per image height. 1 keeps image and world velocities equal (1 ih/s = 1 m/s). */
    scale: number;
    /** World point where the calibrated anchor sits. */
    homeX: number;
    homeY: number;
  };
  perception: {
    /** Samples older than this (capture time) apply no force and fire nothing. */
    staleMs: number;
    /**
     * Longest gap between samples that still counts as continuous for the tether detector's steadiness
     * window, for how far the bottom-exit inference carries a vanished hand on, and for how stale the
     * last sample of a launch completed by the hand's exit may be. The extractor's track and the
     * classifier's history survive longer than this inside a stroke: see `strokeGapMs`.
     */
    maxGapMs: number;
    /**
     * Longest time the hand may stay unseen inside a stroke and still be the same hand: past it the
     * track starts over (`continuous: false`) and the classifier forgets what led to the stroke. A
     * fast stroke blurs the hand out of MediaPipe's detection for one to four frames, and it comes
     * back 0.3 ih lower: Luis's gaps are 63–67 ms (three throws), 99–104 ms (four), 131–133 ms (two)
     * and 168 ms (one), against `maxGapMs` 110. The hand has to come back at a plausible speed
     * (`maxSpeed`) over that time, and a launch that rests on such a gap is only fired after the next
     * sample confirms it (see IntentClassifier.detectLaunch).
     */
    strokeGapMs: number;
    /**
     * Anchor speed between consecutive samples above which the sample is a discontinuity, ih/s. It is
     * measured over the real time between the two samples, so a dropped frame or a short absence does
     * not inflate it. Luis's real downstrokes peak at 1.3–7 ih/s (7.2 ih/s over one frame at the
     * fastest), so the limit sits at 8; a jump over `speedSuspectFraction` of it is still held for
     * one frame (a glitch comes back, a stroke goes on).
     */
    maxSpeed: number;
    /** Relative palm-size change between consecutive samples above which the sample is a discontinuity. */
    maxPalmJump: number;
    /** A landmark this close to the frame border flags the edge. */
    edgeMargin: number;
    /**
     * Two hands this close to the last anchor may be told apart only by their distance (see
     * `crossingMargin`), and a frame that follows a held one must lie within this many ih of it to
     * vouch for it. How far the tracked hand may travel between two samples is NOT this fixed gate: it
     * is `maxSpeed` over the real time between them, which grows with a dropped frame or a short
     * absence (a fixed 0.25 ih rejected Luis's fastest strokes after one lost frame).
     */
    identityGate: number;
    /** Two hands inside the gate whose distances to the last anchor differ by less than this cannot be told apart (a crossing), ih. */
    crossingMargin: number;
    /**
     * A sample beyond this share of `maxSpeed` (or of `maxPalmJump`, below) is held for one frame:
     * the next frame confirms it as a real, merely fast, move or drops it as a glitch. A wrong
     * frame often stays just under the hard limits, yet it looks exactly like a flick. With
     * `maxSpeed` 8 the share is 0.5, which keeps the 4 ih/s at which a one-frame glitch (0.15–0.3 ih)
     * has always been held; only the limit beyond which a confirmed move is a relocation moved up.
     */
    speedSuspectFraction: number;
    palmSuspectFraction: number;
    /** A hand lost with its anchor below this height (ih, y grows downward) most likely left through the bottom edge. */
    bottomExitY: number;
    /**
     * Samples closer than this to the last kept one are dropped. The PRD's «frames» are 30 fps
     * camera frames and the windows count samples, so a 60 Hz source is thinned to that rate;
     * a 30 Hz camera (33.3 ms ± 2 ms of jitter) is never touched below 29 ms.
     */
    minSampleSpacingMs: number;
  };
  launch: {
    /** Downward speed that must be sustained over `sustainFrames` consecutive intervals, ih/s. */
    minDownSpeed: number;
    sustainFrames: number;
    /** «Casi quieta»: robust speed below this over `stillWindowMs` before the stroke, ih/s. */
    stillSpeed: number;
    stillWindowMs: number;
    /**
     * Samples before the stroke's first fast interval that the quiet window may end earlier by, so
     * the stroke's own acceleration does not count against the hand. More lets the slow first
     * 100 ms of a casual sweep pass as «quiet» (4 false launches per 3000 casual clips at 2, 1 at 1).
     */
    stillEndSlack: number;
    /**
     * Alternative precondition: an upward wind-up within `windupWindowMs` before the stroke, ih.
     * Tuned on Luis's real throws (tests/fixtures/yoyo/luis-2026-10-01-seated-throws.json): the PRD's
     * «pequeña preparación hacia arriba» is 0.12 ih there, but his 19 real wind-ups rise 0.17–0.43 ih
     * (one 0.08) over 250–400 ms at 1–2.7 ih/s, so `windupMaxUp` is 0.5 and `windupWindowMs` 700.
     * The reversal at the apex (`windupApexFraction`) is what still separates a throw from a casual
     * move; the size of the rise no longer does.
     */
    windupMinUp: number;
    windupMaxUp: number;
    windupWindowMs: number;
    /**
     * The wind-up's own direction, as the angle of its line (lowest point to apex) from vertical, deg.
     * Wider than `maxAngleDeg`: Luis winds up along a diagonal (up and across, then down and back),
     * 1°–48° over his throws. A sweep with a bump in it is more slanted still (the one wind-up of his
     * that is mostly sideways, 0.06 ih up over 0.11 ih across, is 62°).
     */
    windupMaxAngleDeg: number;
    /**
     * A wind-up turns round at its top; it does not sweep across it. The hand's sideways speed in the two
     * intervals next to the apex, on average, stays below this, ih/s (see IntentClassifier.hasWindUp). The
     * one thing, with the apex's slowness (`windupApexFraction`), that tells a throw from a casual arc now
     * that `windupMaxUp` lets a wind-up rise as far as an arc does: Luis's apexes average at most 0.69 ih/s
     * sideways (0.0–0.5 in all but one), the synthetic arcs that fooled the classifier 0.8 and up.
     */
    windupSweepSpeed: number;
    /**
     * A wind-up ends in a reversal: the slower interval next to its apex stays below this share of
     * `minDownSpeed`. A casual arc fast enough to matter passes its top at full speed.
     */
    windupApexFraction: number;
    /** The stroke must point within this angle of straight down. */
    maxAngleDeg: number;
  };
  /**
   * The PRD's tug text («0.04 ih up in 3 frames after quiet») is met by jitter and by ordinary slow
   * motion far too easily, so the classifier asks for more evidence. None of the extras lowers a
   * PRD threshold; they are the `calm…`, `long…`, `…Tolerance`, `minSpeedFactor`, `angleShare`
   * and `maxStep` fields below (the reasoning is in IntentClassifier.detectTug).
   */
  tug: {
    /** Upward displacement within at most `maxFrames` intervals, ih. */
    minUpDelta: number;
    maxFrames: number;
    /** «Relativamente quieta»: robust speed below `stillSpeed` (ih/s) for `stillBeforeMs` before the flick. */
    stillBeforeMs: number;
    stillSpeed: number;
    maxAngleDeg: number;
    /** Upward drift tolerated over the last `calmWindowMs` before the flick, ih/s: a hand drifting up is already half a tug. */
    calmUpVy: number;
    /** Downward settling tolerated over the same window, ih/s: only upward drift looks like the start of a tug. */
    calmDownVy: number;
    /** Upward drift tolerated over the whole `stillBeforeMs` window, ih/s. */
    longUpVy: number;
    /** Window of the second, tighter calm test and of the baseline height, ms. */
    calmWindowMs: number;
    /** The flick's first sample must sit within this share of `minUpDelta` of the calm baseline. */
    startTolerance: number;
    /** And the sample two frames before the detection within this share: a flick leaves rest abruptly, slow motion drifts away. */
    abruptTolerance: number;
    /** Upward speed over the last three samples must be this multiple of the PRD's mean speed (`minUpDelta` over `maxFrames`). */
    minSpeedFactor: number;
    /** The flick must point within this share of `maxAngleDeg` of vertical: the direction of 0.05 ih of motion is only known to ±11° at this jitter. */
    angleShare: number;
    /** No interval of the flick may move more than this per 1/30 s frame (scaled for longer intervals), ih: a one-frame tracking glitch does, a hand cannot. */
    maxStep: number;
  };
  /** Silence after any fired intent, ms. */
  refractoryMs: number;
  tether: {
    /** The hand must stay this long, still and inside the frame, before the yoyo ties on. */
    stableMs: number;
    /** Robust speed and spread limits for «estable», ih/s and ih. */
    stableSpeed: number;
    stableSpread: number;
  };
  pin: {
    /** 1€ filter on the anchor (Casiez 2012), more responsive than Masa's. */
    minCutoff: number;
    beta: number;
    derivativeCutoff: number;
    /** Critically damped spring from filtered target to pivot, rad/s. */
    springOmega: number;
    /** Fraction of the target velocity fed forward (0 = plain spring lag, 1 = no ramp lag). */
    feedForward: number;
    /** Longest extrapolation past a sample's arrival, ms, decaying; then hold. */
    extrapolateMs: number;
    /**
     * After a gap or discontinuity the pivot chases the hand at most this much faster than the
     * hand itself (cap |v_hand| + recoverSpeed), for at least recoverMs, so it never teleports.
     */
    recoverSpeed: number;
    recoverMs: number;
  };
  yoyo: {
    mass: number;
    /** String wraps the axle at this radius. */
    axleRadius: number;
    /** Body radius; inertia is a uniform disc: I = ½·m·R². */
    bodyRadius: number;
    maxLength: number;
    /** Rest distance under the pivot while tethered (short loop on the finger). */
    loopLength: number;
    /** Canonical launch: spin mapped linearly from stroke speed, clamped to the band. */
    launchSpinMin: number;
    launchSpinMax: number;
    launchSpeedLow: number;
    launchSpeedHigh: number;
    /** Spin decay time constant while sleeping (capstan loop + air + walls), s. */
    sleepTau: number;
    /** Gentle bearing loss while rolling, s. */
    rollTau: number;
    /** Below this spin a responsive yoyo returns by itself (or hangs if it cannot). */
    exhaustedSpin: number;
    autoReturn: boolean;
    /** Return spin floor: enough to climb maxLength against gravity with margin. */
    returnSpinMin: number;
    /** Extra return spin per ih/s of tug speed. */
    tugSpinBoost: number;
    /** Ascent speed cap, m/s. */
    maxAscent: number;
    /** Catch when L < catchLength and the yoyo is within catchDistance of the pivot. */
    catchLength: number;
    catchDistance: number;
    /** Radial bounce kept at the end of the string ("snap"). */
    snapRestitution: number;
    /** Linear air damping on the swing, 1/s. */
    airDamping: number;
    /** Tethered follower spring and damping ratio. */
    tetherOmega: number;
    tetherDamping: number;
    /** Length of the catch beat before the yoyo is tethered again, ms. */
    caughtMs: number;
  };
  sim: {
    hz: number;
    maxStepsPerFrame: number;
  };
}

export type Preset = 'standing' | 'seated';

const STANDING: YoyoConfig = {
  preset: 'standing',
  responsiveness: 'responsive',
  world: { scale: 1, homeX: 0, homeY: 0.95 },
  perception: {
    staleMs: 180, maxGapMs: 110, strokeGapMs: 170, maxSpeed: 8, maxPalmJump: 0.3, edgeMargin: 0.04,
    identityGate: 0.25, crossingMargin: 0.035, speedSuspectFraction: 0.5, palmSuspectFraction: 0.5,
    bottomExitY: 0.85, minSampleSpacingMs: 25,
  },
  launch: {
    minDownSpeed: 1.2, sustainFrames: 2,
    stillSpeed: 0.1, stillWindowMs: 250, stillEndSlack: 1,
    windupMinUp: 0.015, windupMaxUp: 0.5, windupWindowMs: 700, windupMaxAngleDeg: 55, windupSweepSpeed: 0.75, windupApexFraction: 0.75,
    maxAngleDeg: 40,
  },
  tug: {
    // stillSpeed, calmDownVy, maxAngleDeg and maxStep tuned on Luis's second real replay (2026-10-01): he dips the hand
    // 0.04–0.22 ih at up to ~0.7 ih/s before the jerk, tugs up to ~70° off vertical and up to 3.9 ih/s (0.124 ih per
    // 33 ms frame); maxStep is per 1/30 s frame and scales with longer intervals (blur gaps).
    minUpDelta: 0.04, maxFrames: 3, stillBeforeMs: 300, stillSpeed: 0.8, maxAngleDeg: 70,
    calmUpVy: 0.1, calmDownVy: 0.8, longUpVy: 0.12, calmWindowMs: 200,
    startTolerance: 0.6, abruptTolerance: 0.45, minSpeedFactor: 1.4, angleShare: 0.9, maxStep: 0.14,
  },
  refractoryMs: 400,
  tether: { stableMs: 400, stableSpeed: 0.15, stableSpread: 0.04 },
  pin: {
    minCutoff: 2, beta: 6, derivativeCutoff: 1,
    springOmega: 30, feedForward: 1,
    extrapolateMs: 33, recoverSpeed: 2.4, recoverMs: 400,
  },
  yoyo: {
    mass: 0.06, axleRadius: 0.003, bodyRadius: 0.029, maxLength: 0.65, loopLength: 0.025,
    launchSpinMin: 380, launchSpinMax: 750, launchSpeedLow: 1.2, launchSpeedHigh: 3,
    sleepTau: 4, rollTau: 90,
    exhaustedSpin: 15, autoReturn: true,
    returnSpinMin: 300, tugSpinBoost: 120, maxAscent: 3,
    catchLength: 0.05, catchDistance: 0.1,
    snapRestitution: 0.15, airDamping: 0.25,
    tetherOmega: 18, tetherDamping: 0.8,
    caughtMs: 220,
  },
  sim: { hz: 240, maxStepsPerFrame: 4 },
};

/**
 * «Sentado, antebrazo apoyado»: smaller amplitude, larger gain. The launch speed and the smallest
 * wind-up shrink and world scale grows by the same factor, so a smaller wrist motion still swings a
 * full yoyo. The tug rise does not shrink, and neither does the largest wind-up (see createConfig).
 */
const SEATED_FACTOR = 0.7;

/** Fresh config for a preset. Panel edits apply on top; switching preset starts from here again. */
export function createConfig(preset: Preset = 'standing'): YoyoConfig {
  const c = structuredClone(STANDING);
  if (preset === 'seated') {
    const k = SEATED_FACTOR;
    c.preset = 'seated';
    c.world.scale /= k;
    c.launch.minDownSpeed *= k;
    c.launch.windupMinUp *= k;
    // launch.windupMaxUp is NOT scaled: it is a ceiling that tells a wind-up from a sweep, and Luis's real wind-ups
    // (0.17–0.43 ih) were recorded with this preset on; ×0.7 (0.35 ih) would have rejected most of them.
    // tug.minUpDelta is NOT scaled: ×0.7 (0.028 ih) falls under the jitter floor and fires on noise alone (13 false tugs on jitter-only clips).
    c.yoyo.launchSpeedLow *= k;
    c.yoyo.launchSpeedHigh *= k;
  }
  return c;
}

/** Inertia of a uniform disc, kg·m². */
export function inertia(y: YoyoConfig['yoyo']) { return 0.5 * y.mass * y.bodyRadius * y.bodyRadius; }

/** Numeric fields the advanced panel exposes. Keys are dotted paths into YoyoConfig. */
export interface ConfigField { key: string; label: string; unit: string; min: number; max: number; step: number }

export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: 'launch.minDownSpeed', label: 'Lanzar: velocidad hacia abajo', unit: 'ih/s', min: 0.4, max: 3, step: 0.05 },
  { key: 'launch.sustainFrames', label: 'Lanzar: frames sostenidos', unit: 'frames', min: 1, max: 4, step: 1 },
  { key: 'launch.stillSpeed', label: 'Lanzar: quietud previa', unit: 'ih/s', min: 0.03, max: 0.5, step: 0.01 },
  { key: 'launch.stillWindowMs', label: 'Lanzar: duración de quietud', unit: 'ms', min: 100, max: 600, step: 10 },
  { key: 'launch.maxAngleDeg', label: 'Lanzar: desvío máximo de la vertical', unit: '°', min: 10, max: 80, step: 1 },
  { key: 'launch.windupMaxUp', label: 'Lanzar: subida máxima de la preparación', unit: 'ih', min: 0.1, max: 0.8, step: 0.05 },
  { key: 'launch.windupMaxAngleDeg', label: 'Lanzar: desvío máximo de la preparación', unit: '°', min: 20, max: 80, step: 1 },
  { key: 'launch.windupSweepSpeed', label: 'Lanzar: barrido lateral máximo en el ápice', unit: 'ih/s', min: 0.3, max: 3, step: 0.05 },
  { key: 'tug.minUpDelta', label: 'Tirón: subida mínima', unit: 'ih', min: 0.01, max: 0.15, step: 0.005 },
  { key: 'tug.maxFrames', label: 'Tirón: frames máximos', unit: 'frames', min: 1, max: 5, step: 1 },
  { key: 'tug.stillBeforeMs', label: 'Tirón: quietud previa', unit: 'ms', min: 0, max: 800, step: 10 },
  { key: 'tug.stillSpeed', label: 'Tirón: velocidad de «quieta»', unit: 'ih/s', min: 0.05, max: 1, step: 0.01 },
  { key: 'tug.minSpeedFactor', label: 'Tirón: velocidad mínima (× la del PRD)', unit: '×', min: 0.5, max: 2.5, step: 0.05 },
  { key: 'tug.calmUpVy', label: 'Tirón: deriva hacia arriba tolerada', unit: 'ih/s', min: 0.02, max: 0.3, step: 0.01 },
  { key: 'tug.calmWindowMs', label: 'Tirón: ventana de calma', unit: 'ms', min: 150, max: 400, step: 10 },
  { key: 'refractoryMs', label: 'Refractario tras disparo', unit: 'ms', min: 100, max: 1000, step: 10 },
  { key: 'perception.staleMs', label: 'Datos viejos tras', unit: 'ms', min: 80, max: 400, step: 10 },
  { key: 'perception.minSampleSpacingMs', label: 'Muestras: separación mínima', unit: 'ms', min: 5, max: 29, step: 1 },
  { key: 'perception.strokeGapMs', label: 'Mano perdida en pleno golpe (máx.)', unit: 'ms', min: 100, max: 300, step: 10 },
  { key: 'tether.stableMs', label: 'Atado: mano estable', unit: 'ms', min: 200, max: 1000, step: 10 },
  { key: 'pin.minCutoff', label: 'Ancla: corte 1€ en reposo', unit: 'Hz', min: 0.5, max: 6, step: 0.1 },
  { key: 'pin.beta', label: 'Ancla: beta 1€', unit: 'Hz por m/s', min: 0, max: 8, step: 0.05 },
  { key: 'pin.springOmega', label: 'Ancla: resorte', unit: 'rad/s', min: 8, max: 60, step: 1 },
  { key: 'world.scale', label: 'Escala del mundo', unit: 'm/ih', min: 0.6, max: 2, step: 0.05 },
  { key: 'yoyo.launchSpinMin', label: 'Giro de lanzamiento mínimo', unit: 'rad/s', min: 30, max: 1000, step: 10 },
  { key: 'yoyo.launchSpinMax', label: 'Giro de lanzamiento máximo', unit: 'rad/s', min: 60, max: 1200, step: 10 },
  { key: 'yoyo.sleepTau', label: 'Duración del giro (τ)', unit: 's', min: 1, max: 12, step: 0.5 },
  { key: 'yoyo.exhaustedSpin', label: 'Giro agotado bajo', unit: 'rad/s', min: 5, max: 200, step: 5 },
  { key: 'yoyo.returnSpinMin', label: 'Giro mínimo de retorno', unit: 'rad/s', min: 180, max: 900, step: 10 },
  { key: 'yoyo.maxAscent', label: 'Subida máxima', unit: 'm/s', min: 0.5, max: 4, step: 0.1 },
];

/** Reads a dotted numeric path. */
export function getConfigValue(config: YoyoConfig, key: string): number {
  let node: unknown = config;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  if (typeof node !== 'number') throw new Error(`No numeric config field ${key}`);
  return node;
}

/** Returns a copy with one dotted numeric path replaced; the original is untouched. */
export function setConfigValue(config: YoyoConfig, key: string, value: number): YoyoConfig {
  if (!Number.isFinite(value)) throw new Error(`Non-finite value for ${key}`);
  getConfigValue(config, key);
  const next = structuredClone(config);
  const parts = key.split('.');
  let node = next as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  node[parts[parts.length - 1]] = value;
  return next;
}
