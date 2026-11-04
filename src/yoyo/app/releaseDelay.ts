/**
 * A value that shows up at once and goes away only after it has stayed away for `holdMs`.
 *
 * Why: the UI reacts to «hand present / lost» and «touching the frame edge», but the tracker flickers
 * (a dropped frame, a fingertip grazing the border). Showing «Mano perdida» or the edge vignette on a
 * single bad frame would strobe; hiding them late costs nothing. Appearing is never delayed, so the
 * feedback for «I did it» stays immediate.
 *
 * `T` is whatever is being held (a boolean, an edge name); null means «nothing». Changing from one
 * value to another is also immediate: only going to null waits.
 */
export class ReleaseDelay<T> {
  private shown: T | null = null;
  private lastSeenMs = -Infinity;

  constructor(private readonly holdMs: number) {
    if (!Number.isFinite(holdMs) || holdMs < 0) throw new RangeError('holdMs must be a non-negative number');
  }

  /** What the UI should show at `nowMs` given what the engine sees right now. */
  update(value: T | null, nowMs: number): T | null {
    if (value !== null) {
      this.shown = value;
      this.lastSeenMs = nowMs;
    } else if (this.shown !== null && nowMs - this.lastSeenMs >= this.holdMs) {
      this.shown = null;
    }
    return this.shown;
  }

  get current(): T | null {
    return this.shown;
  }

  /** Forgets everything, e.g. when the source changes: a hand from the previous session is not «lost» in the next. */
  reset(): void {
    this.shown = null;
    this.lastSeenMs = -Infinity;
  }
}
