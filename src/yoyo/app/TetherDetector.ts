import type { YoyoConfig } from '../config';
import type { AnchorSample, Vec2 } from '../contracts';
import { SampleRing } from '../perception/IntentClassifier';
import { firstIndexAtOrAfter, fitLine, windowSpread, type LineFit, type TimedPoint } from '../perception/robust';

/** Rectangle of the image, in image heights (ih): where the anchor must be for the yoyo to tie on. */
export interface TetherZone { x0: number; y0: number; x1: number; y1: number }

/**
 * Where the hand is assumed to rest before the yoyo ties on, ih: the horizontal middle of a 4:3
 * frame and 40 % of its height. High enough that a launch stroke (about 0.3 ih down) and the hand
 * that follows it (the wrist trails the anchor by ~0.17 ih) stay inside the frame.
 */
export const DEFAULT_HOME_IMAGE: Vec2 = [2 / 3, 0.4];

/** Half-sizes of the default zone around the default home, ih. The anchor may be anywhere in it. */
const DEFAULT_ZONE_HALF_WIDTH = 0.25;
const DEFAULT_ZONE_HALF_HEIGHT = 0.2;

/** The framing zone the guided calibration shows by default. */
export const DEFAULT_TETHER_ZONE: Readonly<TetherZone> = {
  x0: DEFAULT_HOME_IMAGE[0] - DEFAULT_ZONE_HALF_WIDTH,
  y0: DEFAULT_HOME_IMAGE[1] - DEFAULT_ZONE_HALF_HEIGHT,
  x1: DEFAULT_HOME_IMAGE[0] + DEFAULT_ZONE_HALF_WIDTH,
  y1: DEFAULT_HOME_IMAGE[1] + DEFAULT_ZONE_HALF_HEIGHT,
};

/** Centre of a zone, ih. */
export function zoneCentre(zone: Readonly<TetherZone>): Vec2 {
  return [(zone.x0 + zone.x1) / 2, (zone.y0 + zone.y1) / 2];
}

/**
 * The steady hand's rest position, ih: the mean of the window that proved it steady. Reused between
 * calls (the detector allocates nothing per sample): copy what you need before the next `push`.
 */
export interface StableHand { x: number; y: number }

/**
 * Spare ring slots on top of what the window needs: a burst of samples must not push the oldest one
 * (the one that proves the window really spans stableMs) out of the ring.
 */
const RING_EXTRA_SLOTS = 4;
/** Nobody streams anchors faster than the 240 Hz physics steps: floors the spacing used to size the ring, ms. */
const MIN_SPACING_FLOOR_MS = 1000 / 240;
/** Fraction of the window each half covers: the window is judged whole and in two equal halves. */
const HALF = 0.5;

const speedOf = (fit: LineFit): number => Math.hypot(fit.vx, fit.vy);

/**
 * Decides when the hand has been steady long enough for the yoyo to tie on (PRD §3 step 3: «estable
 * ~400 ms dentro del encuadre»; Y-01: tied on no later than a second after the hand becomes
 * stable, and never before).
 *
 * «Steady» is a property of a window, not of a sample: the robust (least-squares) speed over the
 * last tether.stableMs must be below tether.stableSpeed and its spread below tether.stableSpread.
 * Frame-to-frame speed cannot do this job: with the PRD jitter a perfectly still hand already
 * differences to σ ≈ 0.28 ih/s (see robust.ts). Three details keep «never before» honest:
 *
 * - The window must really span stableMs. It opens at the newest sample that is at least stableMs
 *   old, and a ring that does not reach back that far (the hand appeared a moment ago, or the
 *   history was just cleared) answers «not yet». It is never stretched or shortened to fit.
 * - A sample that breaks the conditions (touches a frame edge, lies outside the zone, does not
 *   continue the previous sample, follows a gap longer than perception.maxGapMs) throws the whole
 *   history away. Steadiness has to be continuous.
 * - The slope is also checked on each half of the window. The whole-window slope and the spread
 *   alone let a hand that was still for 250 ms and then drifted 0.05 ih through (slope 0.125 ih/s,
 *   spread 0.03 ih): it would tie on while moving. The late half exposes the drift (0.05 ih in
 *   200 ms is 0.25 ih/s), and the early half exposes the tail of a hand that is only now settling.
 *
 * Deterministic: time comes only from sample timestamps. Memory is one fixed ring, sized from the
 * config, so a hand held still for an hour costs what a hand held still for a second does.
 */
export class TetherDetector {
  private config: YoyoConfig;
  private zone: TetherZone | null = null;
  private ring: SampleRing;
  private readonly stable: StableHand = { x: 0, y: 0 };
  /** Chronological access through the current ring (the ring is replaced when the config resizes it). */
  private readonly at = (index: number): TimedPoint => this.ring.at(index);

  constructor(config: YoyoConfig) {
    this.config = config;
    this.ring = new SampleRing(this.capacityFor(config));
  }

  /** Live tuning: thresholds apply from the next sample, history is kept (resized if needed). */
  setConfig(config: YoyoConfig): void {
    this.config = config;
    const capacity = this.capacityFor(config);
    if (capacity !== this.ring.capacity) this.ring = this.ring.resized(capacity);
  }

  /**
   * Restricts tie-on to an anchor inside `zone` (null: anywhere in the frame). Whatever was
   * gathered so far was judged against the old zone, so it is forgotten.
   */
  setZone(zone: Readonly<TetherZone> | null): void {
    this.zone = zone === null ? null : normalized(zone);
    this.ring.clear();
  }

  /** Forget the history: the hand was lost, the app paused or recalibrated. */
  reset(): void {
    this.ring.clear();
  }

  /**
   * Feeds one fresh sample. Returns the hand's rest position when it has been steady for
   * tether.stableMs (the object is reused), otherwise null. Samples whose time does not advance,
   * or that come closer than perception.minSampleSpacingMs to the last kept one, are ignored.
   */
  push(sample: AnchorSample): StableHand | null {
    const { timestampMs: t, x, y } = sample;
    if (!Number.isFinite(t + x + y)) {
      this.ring.clear();
      return null;
    }
    if (!sample.continuous) this.ring.clear();
    const n = this.ring.length;
    if (n > 0) {
      const sinceLast = t - this.at(n - 1).t;
      // Out of order, duplicated or closer than a camera frame: not for us, and no reason to forget the window.
      if (!(sinceLast >= this.config.perception.minSampleSpacingMs)) return null;
      // A hole in the data: whatever sat in it could have been motion.
      if (sinceLast > this.config.perception.maxGapMs) this.ring.clear();
    }
    if (sample.edge !== undefined || !this.inside(x, y)) {
      this.ring.clear();
      return null;
    }
    this.ring.push(t, x, y);
    return this.evaluate();
  }

  /** Slots for stableMs of samples at the fastest rate the spacing lets through, plus spares. */
  private capacityFor(config: YoyoConfig): number {
    const spacing = Math.max(MIN_SPACING_FLOOR_MS, config.perception.minSampleSpacingMs);
    return Math.ceil(config.tether.stableMs / spacing) + RING_EXTRA_SLOTS;
  }

  private inside(x: number, y: number): boolean {
    const zone = this.zone;
    return zone === null || (x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1);
  }

  private evaluate(): StableHand | null {
    const { stableMs, stableSpeed, stableSpread } = this.config.tether;
    const last = this.ring.length - 1;
    const now = this.at(last).t;
    // The window opens at the newest sample at least stableMs old: it spans stableMs or more.
    let from = last - 1;
    while (from >= 0 && this.at(from).t > now - stableMs) from--;
    if (from < 0) return null;
    const to = last + 1;
    const middle = firstIndexAtOrAfter(this.at, from, last, now - stableMs * HALF);

    // fitLine answers null for fewer than three points: no evidence of stillness is never stillness.
    const whole = fitLine(this.at, from, to);
    const early = fitLine(this.at, from, middle);
    const late = fitLine(this.at, middle, to);
    if (!whole || !early || !late) return null;
    if (!(speedOf(whole) < stableSpeed && speedOf(early) < stableSpeed && speedOf(late) < stableSpeed)) return null;
    if (!(windowSpread(this.at, from, to) < stableSpread)) return null;

    this.stable.x = whole.meanX;
    this.stable.y = whole.meanY;
    return this.stable;
  }
}

/** A zone with its corners in order, whichever way round they were given; the caller's object is not kept. */
function normalized(zone: Readonly<TetherZone>): TetherZone {
  return {
    x0: Math.min(zone.x0, zone.x1), y0: Math.min(zone.y0, zone.y1),
    x1: Math.max(zone.x0, zone.x1), y1: Math.max(zone.y0, zone.y1),
  };
}
