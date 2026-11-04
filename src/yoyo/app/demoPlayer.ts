import type { HandFrame } from '../../shared/contracts';

/** One frame of a clip as the camera path would deliver it: the frame and the moment it arrives. */
export interface ClipFrame {
  frame: HandFrame;
  arrivalMs: number;
}

/** What the player needs of a clip; a SyntheticClip satisfies it. Frames are in arrival order. */
export interface DemoClip {
  frames: readonly ClipFrame[];
  durationMs: number;
}

export interface DemoOptions {
  /** Silence between the end of one pass and the start of the next, ms. */
  gapMs?: number;
  /**
   * Most frames one `poll` hands out. When more are due (the page stalled for a few frames) the oldest
   * are skipped: the runtime keeps only the newest eight inputs anyway (MAX_QUEUED_INPUTS), and a
   * backlog replayed at once would make the demo react late to where its hand is now.
   */
  maxPerPoll?: number;
  /**
   * A frame this overdue means the page was not running (a throttled tab, a long freeze), not that one
   * frame was late: the demo starts over instead of playing the middle of a gesture.
   */
  resyncMs?: number;
}

export const DEMO_GAP_MS = 400;
/** Same as the runtime's input queue, so a poll never hands out what would be dropped on arrival. */
export const DEMO_MAX_PER_POLL = 8;
export const DEMO_RESYNC_MS = 1500;

/** Frames due in one poll. The array is reused: read it before the next `poll`. */
export interface DemoPoll {
  frames: readonly ClipFrame[];
  /**
   * A new pass began in this poll (never for the first one). The yoyo from the previous pass is still
   * tied on, so the engine re-calibrates the runtime first: every pass then starts from the same
   * state as the first, and the tie-on is part of what the demo shows every time.
   */
  restarted: boolean;
}

/**
 * Schedules a recorded or synthetic clip in real time, in a loop, on the engine's own clock.
 *
 * The clip's times are its own (capture time from 0, arrival 50 ms later); the runtime lives on
 * `performance.now()`. Each pass is shifted by an offset so that clip time 0 plays at the pass's start,
 * and every pass starts after the previous one's last frame: capture times therefore keep strictly
 * increasing for the whole life of the player (the classifiers difference consecutive samples and the
 * extractor drops anything that does not move forward in time), and so do arrival times.
 *
 * It owns no clock and no timer: the engine calls `poll(now)` once per frame, so the demo stops when the
 * page does, and the same call with the same times always returns the same frames (testable without a
 * browser). Everything is bounded: a poll returns at most `maxPerPoll` frames, whatever happened in
 * between.
 */
export class DemoPlayer {
  private readonly frames: readonly ClipFrame[];
  private readonly periodMs: number;
  private readonly firstArrivalMs: number;
  private readonly firstTimestampMs: number;
  private readonly maxPerPoll: number;
  private readonly resyncMs: number;
  private readonly picked: ClipFrame[] = [];
  private readonly result: { frames: ClipFrame[]; restarted: boolean };

  private started = false;
  /** Engine time at which clip time 0 plays in the current pass. */
  private offsetMs = 0;
  private cursor = 0;
  private passCount = 0;
  private heldAtMs: number | null = null;
  private lastTimestampMs = -Infinity;

  constructor(clip: DemoClip, options: DemoOptions = {}) {
    if (clip.frames.length === 0) throw new RangeError('A demo clip needs at least one frame');
    const gapMs = options.gapMs ?? DEMO_GAP_MS;
    this.maxPerPoll = options.maxPerPoll ?? DEMO_MAX_PER_POLL;
    this.resyncMs = options.resyncMs ?? DEMO_RESYNC_MS;
    if (!Number.isFinite(gapMs) || gapMs < 0) throw new RangeError('gapMs must be a non-negative number');
    if (!Number.isInteger(this.maxPerPoll) || this.maxPerPoll < 1) throw new RangeError('maxPerPoll must be a positive integer');
    if (!Number.isFinite(this.resyncMs) || this.resyncMs <= 0) throw new RangeError('resyncMs must be positive');
    this.frames = clip.frames;
    let latest = clip.durationMs;
    for (const f of clip.frames) latest = Math.max(latest, f.arrivalMs, f.frame.timestampMs);
    this.periodMs = latest + gapMs;
    this.firstArrivalMs = clip.frames[0].arrivalMs;
    this.firstTimestampMs = clip.frames[0].frame.timestampMs;
    this.result = { frames: this.picked, restarted: false };
  }

  /** Passes begun so far (1 while the first plays). */
  get passes(): number {
    return this.passCount;
  }

  /** Begins the first pass at `nowMs`. Calling it again starts over. */
  start(nowMs: number): void {
    this.started = true;
    this.heldAtMs = null;
    this.begin(nowMs);
  }

  /**
   * Freezes the schedule (the page is paused or hidden). Time spent frozen is not played afterwards:
   * `release` moves the timeline forward by it, so nothing is skipped and nothing arrives in a burst.
   */
  hold(nowMs: number): void {
    if (this.started && this.heldAtMs === null && Number.isFinite(nowMs)) this.heldAtMs = nowMs;
  }

  release(nowMs: number): void {
    if (this.heldAtMs === null) return;
    if (Number.isFinite(nowMs)) this.offsetMs += Math.max(0, nowMs - this.heldAtMs);
    this.heldAtMs = null;
  }

  /** The frames due by `nowMs`, oldest first, already placed on the engine's clock (timestamps and arrivals). */
  poll(nowMs: number): DemoPoll {
    const picked = this.picked;
    picked.length = 0;
    const result = this.result;
    result.restarted = false;
    if (!this.started || this.heldAtMs !== null || !Number.isFinite(nowMs)) return result;

    let startAt: number | null = null;
    if (this.cursor >= this.frames.length) {
      const passEnd = this.offsetMs + this.periodMs;
      if (nowMs < passEnd) return result;
      startAt = passEnd;
    } else if (nowMs - (this.frames[this.cursor].arrivalMs + this.offsetMs) > this.resyncMs) {
      startAt = nowMs;
    }
    if (startAt !== null) {
      // The next pass is already overdue too (the page slept through the gap): play it from now.
      if (nowMs - (startAt + this.firstArrivalMs) > this.resyncMs) startAt = nowMs;
      this.begin(startAt);
      result.restarted = true;
    }

    let end = this.cursor;
    while (end < this.frames.length && this.frames[end].arrivalMs + this.offsetMs <= nowMs) end++;
    for (let i = Math.max(this.cursor, end - this.maxPerPoll); i < end; i++) picked.push(this.place(this.frames[i]));
    this.cursor = end;
    return result;
  }

  private begin(atMs: number): void {
    // Never start a pass whose first capture time is not after the last one handed out.
    this.offsetMs = Math.max(atMs, this.lastTimestampMs + 1 - this.firstTimestampMs);
    this.cursor = 0;
    this.passCount++;
  }

  private place(source: ClipFrame): ClipFrame {
    const timestampMs = source.frame.timestampMs + this.offsetMs;
    if (timestampMs > this.lastTimestampMs) this.lastTimestampMs = timestampMs;
    return { frame: { ...source.frame, timestampMs }, arrivalMs: source.arrivalMs + this.offsetMs };
  }
}
