/**
 * Adaptive pixel ratio (PRD §7: render ≤ 8 ms, frame p95 ≤ 16.8 ms). Resolution is the one lever that
 * costs the renderer nothing in behaviour: physics, tracking and the scene never change, only how many
 * pixels are filled. Reimplemented for the yoyó (Masa has its own governor, not imported on purpose).
 *
 * It looks at the interval between rendered frames, not at the CPU cost of render(): a GPU-bound frame
 * costs almost no CPU but still arrives late, and the interval is the only thing the browser exposes.
 */

/** Never render above this many device pixels per CSS pixel: 4× on a retina canvas buys nothing visible. */
export const MAX_PIXEL_RATIO = 2;
/** Pixel-ratio step, and the lowest ratio reached unless the device itself is below it. */
export const QUALITY_STEP = 0.25;
export const QUALITY_FLOOR = 0.75;
/** A frame slower than this counts as slow (≈ below 45 fps); faster than FAST_FRAME_MS counts as fast. */
export const SLOW_FRAME_MS = 22;
export const FAST_FRAME_MS = 18.5;
/** Time of slow frames before dropping a step, and of fast frames before recovering one, ms. */
export const DROP_AFTER_MS = 4000;
export const RECOVER_AFTER_MS = 15000;
/** Frames longer than this are stalls (hidden tab, debugger, GC): they say nothing about the GPU. */
export const STALL_MS = 250;
/**
 * A drop within this long after a recovery means the recovery was premature; the wait before the next
 * recovery doubles, up to MAX_RECOVER_AFTER_MS, so quality does not oscillate every 19 seconds.
 */
export const BACKOFF_WINDOW_MS = 30000;
export const MAX_RECOVER_AFTER_MS = 120000;

/** Ratio the page may use at most for a device ratio: capped, and never zero or non-finite. */
export function baseRatioFor(deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return 1;
  return Math.min(deviceRatio, MAX_PIXEL_RATIO);
}

export class AdaptiveQuality {
  private base: number;
  private level = 0;
  private slowMs = 0;
  private fastMs = 0;
  private clockMs = 0;
  private lastRecoveryMs = Number.NEGATIVE_INFINITY;
  private recoverAfterMs = RECOVER_AFTER_MS;

  constructor(deviceRatio: number) {
    this.base = baseRatioFor(deviceRatio);
  }

  /** Pixel ratio to render at now. */
  get ratio(): number {
    return Math.max(this.floor(), this.base - this.level * QUALITY_STEP);
  }

  /** The device ratio changed (window moved to another monitor). Keeps the current quality level. */
  setDeviceRatio(deviceRatio: number): boolean {
    const before = this.ratio;
    this.base = baseRatioFor(deviceRatio);
    this.level = Math.min(this.level, this.maxLevel());
    return this.ratio !== before;
  }

  /**
   * Feed the interval since the previous rendered frame, ms. Returns true when the ratio changed and
   * the caller must resize the drawing buffer.
   */
  sample(frameMs: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > STALL_MS) return false;
    this.clockMs += frameMs;
    if (this.clockMs - this.lastRecoveryMs > BACKOFF_WINDOW_MS) this.recoverAfterMs = RECOVER_AFTER_MS;

    if (frameMs > SLOW_FRAME_MS) {
      this.slowMs += frameMs;
      this.fastMs = 0;
    } else if (frameMs < FAST_FRAME_MS) {
      this.fastMs += frameMs;
      // Fast frames pay back slow time twice as fast, so isolated hiccups never add up to a drop.
      this.slowMs = Math.max(0, this.slowMs - 2 * frameMs);
    }

    if (this.slowMs >= DROP_AFTER_MS) {
      this.slowMs = 0;
      this.fastMs = 0;
      if (this.level < this.maxLevel()) {
        this.level++;
        if (this.clockMs - this.lastRecoveryMs < BACKOFF_WINDOW_MS) {
          this.recoverAfterMs = Math.min(this.recoverAfterMs * 2, MAX_RECOVER_AFTER_MS);
        }
        return true;
      }
      return false;
    }
    if (this.fastMs >= this.recoverAfterMs && this.level > 0) {
      this.level--;
      this.fastMs = 0;
      this.slowMs = 0;
      this.lastRecoveryMs = this.clockMs;
      return true;
    }
    return false;
  }

  private floor(): number {
    return Math.min(this.base, QUALITY_FLOOR);
  }

  private maxLevel(): number {
    return Math.max(0, Math.ceil((this.base - this.floor()) / QUALITY_STEP - 1e-9));
  }
}
