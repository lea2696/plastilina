import type { HandDetection, HandFrame } from '../../shared/contracts';
import { buildQaCameraSession, QA_SEED } from '../replay/sessions';

/**
 * TEST HOOK, not a feature. `/yoyo?qa=camera-replay` makes the camera path play a synthetic session of hands, so a
 * browser test can walk the whole camera pipeline (framing zone, tie-on, throw, sleep, tug, catch, a hand that
 * leaves through the bottom for a moment, the vignette, the tracking dot, the recorder) without a person and
 * without a webcam. Masa has the same idea in `?qa=`.
 *
 * What stays real: the fake device (or any camera), its permission flow, the MediaPipe model running in its worker,
 * the frame clock from requestVideoFrameCallback, every counter of the diagnostics that comes from them (capture
 * to arrival, inference time), and everything downstream of a frame: the runtime, the framing zone, the recorder,
 * the vignette and the dot. What is replaced: the hands in the frames. The fake device sees no hands, so under the
 * hook the camera frames only say WHEN (they are the clock) and the session says WHAT.
 *
 * Why the session's own frames and not a lookup at each camera frame's time: a lookup resamples the session at
 * the camera's rate, and the fake device runs at 20 fps while the classifiers are tuned for the 30 fps the session
 * was drawn at. Measured offline (40 runs each, random phase and latency), sampling the session at the camera's
 * frame times walks all its phases in 30/40 runs at 20 fps and 35/40 at 30 fps; handing over the session's own
 * frames, every one captured by that moment, walks them in 40/40 at 15, 20, 25 and 30 fps. So each camera frame
 * delivers the session frames that are due by its capture time, oldest first, each with its own capture time
 * (shifted onto the camera's clock) and its own hands. After the session ends the camera goes on delivering frames,
 * with `hands: []`.
 *
 * Nothing here runs unless the page is opened with exactly that query value; any other value is ignored.
 * Every page that has it says so on screen (the «QA» label) and in `data-qa` on the root element: it is
 * synthetic evidence, and the labels keep it from being taken for webcam validation.
 */

/** The value of `?qa=` that turns the hook on. */
export const QA_CAMERA_REPLAY = 'camera-replay';

export type QaMode = typeof QA_CAMERA_REPLAY;

/** The hook a page was opened with, from its `location.search`; null unless it is exactly the documented value. */
export function qaModeFromSearch(search: string): QaMode | null {
  return new URLSearchParams(search).get('qa') === QA_CAMERA_REPLAY ? QA_CAMERA_REPLAY : null;
}

/**
 * One frame of the session as the hook holds it: capture time in ms from the start of the session (the moment
 * the camera became ready) and the hands of that frame, `[]` while the session has none in view.
 */
export interface QaFrame {
  timestampMs: number;
  hands: readonly HandDetection[];
}

/**
 * Frames handed out by one call when the page was busy for a long while (a stalled tab). The runtime keeps only
 * its newest eight inputs anyway (MAX_QUEUED_INPUTS): older ones would be dropped on arrival, so they are skipped
 * here instead, for good.
 */
export const QA_MAX_PER_TAKE = 8;

/**
 * The session, and how far through it the hook is. Pure: it reads no clock and nothing from the page; the engine
 * says how much time has gone by since the camera became ready.
 */
export class QaReplay {
  private readonly frames: readonly QaFrame[];
  private next = 0;

  /** `frames` in any order (a session's are in arrival order); they are sorted by capture time. */
  constructor(
    frames: ReadonlyArray<{ frame: Pick<HandFrame, 'timestampMs' | 'hands'> }>,
    private readonly maxPerTake = QA_MAX_PER_TAKE,
  ) {
    if (!Number.isInteger(maxPerTake) || maxPerTake < 1) throw new RangeError('maxPerTake must be a positive integer');
    this.frames = frames
      .map(({ frame }): QaFrame => ({ timestampMs: frame.timestampMs, hands: frame.hands }))
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  /** Capture time of the session's last frame, ms from its start; 0 for an empty session. */
  get durationMs(): number {
    return this.frames.length === 0 ? 0 : this.frames[this.frames.length - 1].timestampMs;
  }

  /** Every frame has been handed out (or skipped). */
  get finished(): boolean {
    return this.next >= this.frames.length;
  }

  /**
   * The frames captured by `elapsedMs` (ms since the camera became ready) that have not been handed out yet,
   * oldest first. Each frame is handed out once. When more than `maxPerTake` are due the oldest are skipped; a
   * time that is not a number, or before the session's first frame, hands out nothing.
   */
  takeDue(elapsedMs: number): QaFrame[] {
    if (!Number.isFinite(elapsedMs)) return [];
    const from = this.next;
    let end = from;
    while (end < this.frames.length && this.frames[end].timestampMs <= elapsedMs) end++;
    this.next = end;
    return this.frames.slice(Math.max(from, end - this.maxPerTake), end);
  }

  /** Starts over, as if the camera had just become ready. */
  reset(): void {
    this.next = 0;
  }
}

/**
 * The time alignment of the hook: what the camera path receives for one real camera frame. `readyAtMs` is when the
 * camera became ready, on the same clock as `frame.timestampMs` (performance.now), so `frame.timestampMs - readyAtMs`
 * is the session's clock.
 *
 * - While the session runs: the session frames due by this camera frame's capture time, each stamped with its own
 *   capture time on the camera's clock (`readyAtMs + its time`) and its own hands. A camera frame between two
 *   session frames delivers nothing: it only told the time.
 * - After the session: the camera frame itself, with `hands: []` (strictly after every session frame, so times
 *   keep increasing).
 */
export function qaFramesFor(replay: QaReplay, frame: HandFrame, readyAtMs: number): HandFrame[] {
  const elapsed = frame.timestampMs - readyAtMs;
  const due = replay.takeDue(elapsed);
  if (due.length > 0) return due.map(s => ({ timestampMs: readyAtMs + s.timestampMs, source: frame.source, hands: s.hands }));
  if (replay.finished && elapsed > replay.durationMs) return [{ ...frame, hands: [] }];
  return [];
}

/**
 * The session a page under the hook plays. Built when the camera starts (about 15 ms), not when it becomes
 * ready, so the work does not land between «ready» and the first frame and shift the session's clock.
 */
export function createQaReplay(): QaReplay {
  return new QaReplay(buildQaCameraSession(QA_SEED).frames);
}
