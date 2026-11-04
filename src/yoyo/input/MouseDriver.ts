import type { AnchorSample } from '../contracts';

/** Element rectangle in client pixels, as `getBoundingClientRect()` returns it. */
export interface PointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One pointer event of a script, in client pixels. A step is exactly one event: down, up or move. */
export interface PointerScriptStep {
  t: number;
  x: number;
  y: number;
  down?: boolean;
  up?: boolean;
}

/** The camera path delivers 30 fps samples; the mouse resamples to the same cadence so the classifier thresholds carry over. */
export const MOUSE_SAMPLE_HZ = 30;

/**
 * Most samples one `poll` hands over, and the most the driver keeps waiting. A late poll (hidden
 * tab, long frame) delivers only the newest ones: the classifiers read a few frames of history, so
 * older samples carry nothing, and a backlog would make the app react late to where the hand is
 * now (DECISIONS.md: pending samples are bounded at 8, oldest dropped).
 */
export const MAX_CATCH_UP_SAMPLES = 8;

const MS_PER_SECOND = 1000;

/** Default cadence at which `runPointerScript` polls between script steps: one render frame at 60 Hz, ms. */
const SCRIPT_POLL_MS = MS_PER_SECOND / 60;

/** Times beyond this (ms) are garbage: the grid index arithmetic would stop being exact. */
const MAX_TIME_MS = Number.MAX_SAFE_INTEGER;

/** The floored grid index can be one off in floating point; two nudges settle it against the exact grid. */
const GRID_SETTLE_STEPS = 2;

const isTime = (t: number): boolean => Number.isFinite(t) && Math.abs(t) <= MAX_TIME_MS;

/**
 * Mouse as the yoyo's hand (PRD_YOYO.md §4.5). The button held is the hand present, a fast drag
 * down is a launch intent and a fast drag up is a tug. The pointer drives the anchor directly, in
 * viewport heights (x = (clientX − left) / height, y downward, no mirroring: the mouse is already
 * in screen space), and the driver emits the same `AnchorSample` stream the camera path does, so
 * the same IntentClassifier runs unchanged and a mouse script is a replay without tracking noise.
 *
 * Samples sit on a fixed grid `t0 + k·(1000 / sampleHz)` from the press, so their cadence does
 * not depend on how often the app polls or how fast the mouse reports. Each takes the latest
 * pointer position at or before its grid time (sample-and-hold, causal, like a camera exposure).
 * A pointer event exactly at a grid time counts for that sample. Grid times are computed as
 * `t0 + k·1000 / hz` (multiply first) so exact multiples stay exact in floating point.
 *
 * Unlike the camera path there is no jump rejection (`perception.maxSpeed`): that guards against
 * tracking glitches, and the mouse has none, so a very fast flick is real motion and must reach
 * the classifier. `continuous` is false only for the first sample after a press and after a skip.
 *
 * Event times and poll times must come from one monotonic clock. Samples are produced as time
 * passes (on `move`, `up` and `poll`), never from a growing history, so memory is bounded
 * whatever the pointer rate; `poll(t)` should come after the events with timestamps up to `t`.
 * The element rectangle is captured at the press: a drag is pointer-captured, so the element
 * does not meaningfully move or resize under it.
 */
export class MouseDriver {
  private isDown = false;
  private rect: PointerRect = { left: 0, top: 0, width: 0, height: 1 };
  private startMs = 0;
  private lastEventMs = 0;
  /** Latest pointer position, viewport heights: what the next grid samples will hold. */
  private held = { x: 0, y: 0 };
  /** Index of the next grid sample not yet produced. */
  private nextIndex = 0;
  /** Produced but not yet polled; never longer than MAX_CATCH_UP_SAMPLES. */
  private readonly pending: AnchorSample[] = [];

  constructor(private readonly sampleHz = MOUSE_SAMPLE_HZ) {
    if (!Number.isFinite(sampleHz) || sampleHz <= 0) throw new RangeError('sampleHz must be a positive finite number');
  }

  /** True while the button is held: the hand is present. */
  get pressed(): boolean {
    return this.isDown;
  }

  /**
   * Button pressed at `t`: the grid starts here and its first sample, at exactly `t`, is not
   * continuous. A press while already pressed (a lost pointerup) restarts cleanly. A press that
   * cannot be mapped (non-finite values, an element with no height) is ignored instead of
   * poisoning the stream with NaN.
   */
  down(clientX: number, clientY: number, t: number, rect: PointerRect): void {
    if (!isTime(t) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) return;
    this.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    this.isDown = true;
    this.startMs = t;
    this.lastEventMs = t;
    this.nextIndex = 0;
    this.pending.length = 0;
    this.held = this.toViewport(clientX, clientY);
  }

  /**
   * Pointer moved while pressed. Grid samples strictly before `t` keep the previous position;
   * from `t` on the new one is held. Ignored when not pressed or when the values are not finite;
   * a timestamp older than the last event is treated as simultaneous, never as time travel.
   */
  move(clientX: number, clientY: number, t: number): void {
    if (!this.isDown || !isTime(t) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const at = Math.max(t, this.lastEventMs);
    this.produceUntil(at, false);
    this.held = this.toViewport(clientX, clientY);
    this.lastEventMs = at;
  }

  /**
   * Button released at `t`. Samples due up to `t` (the hand was present for them) are still
   * handed over by the next `poll`; after that the driver is silent, which the runtime reads as
   * «hand absent». Without this, whatever the app had not polled yet when the button went up,
   * typically the final position of a flick, would be lost.
   */
  up(t: number): void {
    if (!this.isDown) return;
    this.produceUntil(isTime(t) ? Math.max(t, this.lastEventMs) : this.lastEventMs, true);
    this.isDown = false;
  }

  /**
   * Samples due up to `t`, oldest first. At most MAX_CATCH_UP_SAMPLES are returned; if older due
   * samples had to be skipped, the first returned one is marked `continuous: false` so nobody
   * differences across the gap. Returns the caller its own array and objects.
   */
  poll(t: number): AnchorSample[] {
    if (!isTime(t)) return [];
    if (this.isDown) this.produceUntil(t, true);
    let due = 0;
    while (due < this.pending.length && this.pending[due].timestampMs <= t) due += 1;
    return this.pending.splice(0, due);
  }

  /** Grid time of sample `index`, ms. */
  private gridMs(index: number): number {
    return this.startMs + (index * MS_PER_SECOND) / this.sampleHz;
  }

  /** Newest grid index due at `limitMs` (inclusive or strictly before it), or -1 when none. */
  private lastDueIndex(limitMs: number, inclusive: boolean): number {
    const isDue = (index: number) => (inclusive ? this.gridMs(index) <= limitMs : this.gridMs(index) < limitMs);
    let index = Math.floor(((limitMs - this.startMs) * this.sampleHz) / MS_PER_SECOND);
    for (let i = 0; i < GRID_SETTLE_STEPS && isDue(index + 1); i += 1) index += 1;
    for (let i = 0; i < GRID_SETTLE_STEPS && index >= 0 && !isDue(index); i += 1) index -= 1;
    return index;
  }

  /**
   * Produces every grid sample due at `limitMs` with the position held right now. Called before a
   * new position is applied, so a sample never sees an event that happened after its grid time.
   * If more than the catch-up limit are due, the older ones are skipped, never produced.
   */
  private produceUntil(limitMs: number, inclusive: boolean): void {
    const last = this.lastDueIndex(limitMs, inclusive);
    if (last < this.nextIndex) return;
    let first = this.nextIndex;
    let skipped = false;
    if (last - first + 1 > MAX_CATCH_UP_SAMPLES) {
      first = last - MAX_CATCH_UP_SAMPLES + 1;
      skipped = true;
    }
    for (let index = first; index <= last; index += 1) this.enqueue(this.sampleAt(index, skipped && index === first));
    this.nextIndex = last + 1;
  }

  private sampleAt(index: number, followsSkipped: boolean): AnchorSample {
    const timestampMs = this.gridMs(index);
    return {
      timestampMs,
      arrivalMs: timestampMs,
      source: 'mouse',
      x: this.held.x,
      y: this.held.y,
      palmSize: 0,
      continuous: index > 0 && !followsSkipped,
    };
  }

  private enqueue(sample: AnchorSample): void {
    this.pending.push(sample);
    if (this.pending.length <= MAX_CATCH_UP_SAMPLES) return;
    this.pending.shift();
    // The new oldest sample no longer follows the one that was dropped.
    this.pending[0].continuous = false;
  }

  private toViewport(clientX: number, clientY: number): { x: number; y: number } {
    return { x: (clientX - this.rect.left) / this.rect.height, y: (clientY - this.rect.top) / this.rect.height };
  }
}

/**
 * Plays a pointer script through the driver the way an app would: each event is applied at its
 * time and the driver is polled right after it, and between events every `pollMs` (a render-like
 * cadence by default) so the bounded catch-up never skips samples across a long gap. Returns
 * every sample in order. Positions are client pixels, like real pointer events, so the same
 * script can drive Playwright. Steps must be in non-decreasing time order. Used by tests and by
 * the mouse-parity checks.
 */
export function runPointerScript(
  driver: MouseDriver,
  steps: readonly PointerScriptStep[],
  rect: PointerRect,
  pollMs = SCRIPT_POLL_MS,
): AnchorSample[] {
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('pollMs must be a positive finite number');
  const samples: AnchorSample[] = [];
  let previousMs = steps.length > 0 ? steps[0].t : 0;
  for (const step of steps) {
    if (step.t < previousMs) throw new Error('Pointer script steps must be in time order');
    if (step.down && step.up) throw new Error('A pointer script step is one event: down or up, not both');
    for (let t = previousMs + pollMs; t < step.t; t += pollMs) samples.push(...driver.poll(t));
    if (step.down) driver.down(step.x, step.y, step.t, rect);
    else if (step.up) driver.up(step.t);
    else driver.move(step.x, step.y, step.t);
    samples.push(...driver.poll(step.t));
    previousMs = step.t;
  }
  return samples;
}
