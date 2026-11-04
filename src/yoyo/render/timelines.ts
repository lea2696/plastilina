/**
 * Render-only "weight" cues (PRD §6): without haptics the weight of the yoyo is sold by image. They live
 * in the renderer, never in the physics: the model stays deterministic and the snapshot is never altered.
 * Every envelope here is a small pure function of "milliseconds since the event" so it can be unit-tested
 * without a GPU; `WeightCues` bundles them and owns the prefers-reduced-motion switch.
 */

/** The yoyo and its string hold the event-frame pose this long, ms (PRD: hit-stop ≈ 40 ms). */
export const HIT_STOP_MS = 40;
/** Then they ease to the live pose over this long, ms, so the freeze never ends in a visible jump. */
export const HIT_STOP_EASE_MS = 60;
/** Largest string overshoot drawn on a snap, m: a stretch you feel more than see (PRD: ≤ 8 mm). */
export const OVERSHOOT_MAX_M = 0.008;
/** The overshoot reaches its peak this fast, ms: a snap is abrupt. */
export const OVERSHOOT_RISE_MS = 10;
/** The overshoot has fully sprung back by now, ms (PRD: within ~100 ms). */
export const OVERSHOOT_END_MS = 100;
/** Camera shake: largest displacement, m (PRD: minimal, ≤ 4 mm), duration, ms, and frequency, Hz. */
export const SHAKE_MAX_M = 0.004;
export const SHAKE_MS = 150;
export const SHAKE_HZ = 34;

/**
 * The yoyo pops in when it ties on: starts this fraction of its size and settles with a slight overshoot.
 * After a catch it is already in view, so the re-tie only gives a gentle settle from RETETHER_POP_FROM.
 */
export const POP_FROM = 0.55;
export const RETETHER_POP_FROM = 0.92;
export const POP_MS = 220;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Hermite smoothstep on [0, 1]: zero slope at both ends, so envelopes join without a kink. */
export function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Share of the LIVE pose shown `sinceMs` after a hit-stop began: 0 while frozen, then a smooth rise to 1
 * over the ease window, then 1. A negative or non-finite time means "no hit-stop running" (1), so a
 * clock that jumps backwards (restart, replay seek) can never leave the yoyo frozen.
 */
export function liveWeight(sinceMs: number, freezeMs: number = HIT_STOP_MS, easeMs: number = HIT_STOP_EASE_MS): number {
  if (!Number.isFinite(sinceMs) || sinceMs < 0) return 1;
  if (sinceMs < freezeMs) return 0;
  if (easeMs <= 0) return 1;
  return smoothstep01((sinceMs - freezeMs) / easeMs);
}

/**
 * Metres the drawn yoyo is pushed along the string `sinceMs` after a snap: a fast stretch to the peak,
 * held while the hit-stop freezes the frame (the stretch IS the impact), then a smooth spring back.
 * Zero before the snap, after the end, and for non-finite times.
 */
export function overshootOffset(sinceMs: number, amplitude: number = OVERSHOOT_MAX_M): number {
  if (!Number.isFinite(sinceMs) || sinceMs < 0 || sinceMs >= OVERSHOOT_END_MS) return 0;
  if (sinceMs < OVERSHOOT_RISE_MS) return amplitude * smoothstep01(sinceMs / OVERSHOOT_RISE_MS);
  if (sinceMs < HIT_STOP_MS) return amplitude;
  return amplitude * (1 - smoothstep01((sinceMs - HIT_STOP_MS) / (OVERSHOOT_END_MS - HIT_STOP_MS)));
}

/** Decay of the shake: quadratic, exactly zero at SHAKE_MS (a shake that "decays in ~150 ms" must end). */
export function shakeEnvelope(sinceMs: number): number {
  if (!Number.isFinite(sinceMs) || sinceMs < 0 || sinceMs >= SHAKE_MS) return 0;
  const k = 1 - sinceMs / SHAKE_MS;
  return k * k;
}

/**
 * Camera displacement `sinceMs` after an impact, written to `out` (x, y, metres). Mostly vertical, like
 * the jolt of a yoyo hitting the end of its string; the magnitude never exceeds `amplitude`.
 */
export function shakeOffset(sinceMs: number, amplitude: number, out: [number, number]): void {
  const e = amplitude * shakeEnvelope(sinceMs);
  const phase = (2 * Math.PI * SHAKE_HZ * sinceMs) / 1000;
  out[0] = e === 0 ? 0 : 0.3 * e * Math.sin(phase + 1.1);
  out[1] = e === 0 ? 0 : 0.95 * e * Math.cos(phase);
}

/**
 * Size factor of the yoyo `sinceMs` after it ties on (PRD §3: «snap» visual): ease-out-back from `from`
 * (default POP_FROM) to 1, overshooting slightly and settling exactly at 1. 1 for negative or non-finite
 * times, so a yoyo that has been there a while (or a clock that jumped) is never drawn shrunk.
 */
export function popScale(sinceMs: number, from: number = POP_FROM): number {
  if (!Number.isFinite(sinceMs) || sinceMs < 0 || sinceMs >= POP_MS) return 1;
  const t = sinceMs / POP_MS - 1;
  const c = 1.9; // overshoot strength of the back easing: about 6 % of the travel
  const eased = 1 + (c + 1) * t * t * t + c * t * t;
  return from + (1 - from) * eased;
}

/** Scales the cues with the impact speed (m/s, as reported by the event): a soft touch must not jolt. */
export function impactScale(strength: number | undefined): number {
  if (strength === undefined || !Number.isFinite(strength)) return 0.7;
  return Math.min(1, Math.max(0.4, 0.4 + strength / 3));
}

/**
 * Holds the pose of the yoyo relative to the pivot during a hit-stop.
 *
 * Why relative to the pivot: the hand keeps moving (it is live tracking; freezing it would feel like lag),
 * and a yoyo frozen in absolute world position would be left behind by it. Frozen relative to the pivot,
 * the string and yoyo move rigidly with the hand and only their internal motion stops.
 *
 * A trigger that arrives while a previous freeze is still easing freezes the pose being DRAWN at that
 * instant, not the live one, so the displayed pose is continuous at every moment.
 */
export class HitStop {
  /** When false (reduced motion) the live pose is always drawn. */
  enabled = true;
  private frozenX = 0;
  private frozenY = 0;
  private startedMs = Number.NEGATIVE_INFINITY;

  /** Writes the pose to draw (offset of the yoyo from the pivot, m) given the live offset. */
  blend(nowMs: number, liveX: number, liveY: number, out: [number, number]): void {
    const w = this.enabled ? liveWeight(nowMs - this.startedMs) : 1;
    out[0] = this.frozenX * (1 - w) + liveX * w;
    out[1] = this.frozenY * (1 - w) + liveY * w;
  }

  /** Start (or restart) a freeze at nowMs, holding the pose that is currently drawn. */
  trigger(nowMs: number, liveX: number, liveY: number): void {
    if (!this.enabled) return;
    const drawn: [number, number] = [0, 0];
    this.blend(nowMs, liveX, liveY, drawn);
    this.frozenX = drawn[0];
    this.frozenY = drawn[1];
    this.startedMs = nowMs;
  }

  /** Forget the freeze: restart, replay seek. */
  reset(): void {
    this.startedMs = Number.NEGATIVE_INFINITY;
  }
}

/**
 * All render-only impact cues behind one switch. `setReducedMotion(true)` (prefers-reduced-motion) turns
 * the hit-stop, the string overshoot and the camera shake off together.
 */
export class WeightCues {
  readonly hitStop = new HitStop();
  private reduced = false;
  private snapMs = Number.NEGATIVE_INFINITY;
  private snapScale = 0;
  private shakeMs = Number.NEGATIVE_INFINITY;
  private shakeScale = 0;

  get reducedMotion(): boolean {
    return this.reduced;
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    this.hitStop.enabled = !reduced;
    if (reduced) {
      this.hitStop.reset();
      this.snapMs = Number.NEGATIVE_INFINITY;
      this.shakeMs = Number.NEGATIVE_INFINITY;
    }
  }

  /** The yoyo hit the end of its string: hit-stop, overshoot and shake. `liveX/Y`: yoyo − pivot, m. */
  snap(nowMs: number, strength: number | undefined, liveX: number, liveY: number): void {
    if (this.reduced) return;
    const scale = impactScale(strength);
    this.hitStop.trigger(nowMs, liveX, liveY);
    this.snapMs = nowMs;
    this.snapScale = scale;
    this.shakeMs = nowMs;
    this.shakeScale = scale;
  }

  /** The hand caught the yoyo: hit-stop and shake, no overshoot (nothing stretches). */
  catchYoyo(nowMs: number, strength: number | undefined, liveX: number, liveY: number): void {
    if (this.reduced) return;
    this.hitStop.trigger(nowMs, liveX, liveY);
    this.shakeMs = nowMs;
    this.shakeScale = impactScale(strength);
  }

  /**
   * Offset of the yoyo from the pivot to DRAW, m: the live offset (yoyo − pivot) held by the hit-stop and
   * stretched along the string by the snap overshoot. The pivot itself is never moved.
   */
  pose(nowMs: number, liveX: number, liveY: number, out: [number, number]): void {
    this.hitStop.blend(nowMs, liveX, liveY, out);
    const stretch = this.overshoot(nowMs);
    if (stretch <= 0) return;
    const len = Math.hypot(out[0], out[1]);
    // A string of no length has no direction; hang it down like the rest of the renderer does.
    out[0] += len > 1e-6 ? (out[0] / len) * stretch : 0;
    out[1] += len > 1e-6 ? (out[1] / len) * stretch : -stretch;
  }

  /** Metres to push the drawn yoyo along the string (0 when reduced). */
  overshoot(nowMs: number): number {
    return this.reduced ? 0 : overshootOffset(nowMs - this.snapMs, OVERSHOOT_MAX_M * this.snapScale);
  }

  /** Camera displacement for this frame (zero when reduced). */
  shake(nowMs: number, out: [number, number]): void {
    if (this.reduced) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    shakeOffset(nowMs - this.shakeMs, SHAKE_MAX_M * this.shakeScale, out);
  }
}
