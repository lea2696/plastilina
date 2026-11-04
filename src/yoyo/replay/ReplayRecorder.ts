import type { HandDetection, HandFrame } from '../../shared/contracts';
import type { IntentKind, ReplayFile } from '../contracts';
import { serializeReplay } from './replayFile';

type ReplayFrame = ReplayFile['frames'][number];

/** Same literal as the contract, typed against it so a schema bump cannot go unnoticed here. */
const SCHEMA: ReplayFile['schema'] = 'yoyo-replay/1';

/** MediaPipe returns 21 landmarks per hand; the replay format and its parser require exactly that. */
const LANDMARKS_PER_HAND = 21;

/** Two minutes at 30 fps is ~3 600 frames (a few MB of JSON): enough to capture many launches and tugs. */
export const DEFAULT_MAX_DURATION_MS = 120_000;
/** Also caps higher tracking rates, so file size and memory stay bounded either way. */
export const DEFAULT_MAX_FRAMES = 4_000;

/**
 * The live classifier fires at most once per refractory period (400 ms), so two minutes hold
 * ~300 detections; this only guards a misbehaving caller from growing the list without bound.
 */
const MAX_DETECTED = 1_000;

/** The note is typed by the user; capped so a paste cannot bloat the file. */
const MAX_NOTE_CHARS = 1_000;

/**
 * Landmarks keep 1e-5 of the normalized image (0.006 px at 640 px): far below tracking noise, and
 * it keeps files small (measured: ~2.2 MB for a full two-minute recording of one hand).
 */
const LANDMARK_SCALE = 1e5;
/** Times keep microseconds, which also removes floating-point tails from subtracted timestamps. */
const TIME_SCALE = 1e3;

/** Delay before the object URL is revoked, so the browser has started the download. */
const REVOKE_DELAY_MS = 1_000;

function roundTo(value: number, scale: number): number {
  const rounded = Math.round(value * scale) / scale;
  // Math.round(-0.1) is -0: canonicalise it so equal values serialize and compare equal.
  return rounded === 0 ? 0 : rounded;
}

function isRecordable(frame: HandFrame, arrivalMs: number): boolean {
  if (!Number.isFinite(frame.timestampMs) || !Number.isFinite(arrivalMs)) return false;
  return frame.hands.every(
    hand => hand.landmarks.length === LANDMARKS_PER_HAND && hand.landmarks.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)),
  );
}

/** Copies only the schema's fields, so nothing else a frame object carries can leak into the file. */
function toReplayHand(hand: HandDetection): ReplayFrame['hands'][number] {
  const label = hand.handedness;
  return {
    h: label === 'Left' || label === 'Right' ? label : 'Unknown',
    lm: hand.landmarks.map((p): [number, number, number] => [roundTo(p.x, LANDMARK_SCALE), roundTo(p.y, LANDMARK_SCALE), roundTo(p.z, LANDMARK_SCALE)]),
  };
}

/**
 * Opt-in recorder of real landmark sessions (PRD_YOYO.md §8.3). It keeps hand landmarks, never
 * images, only in memory, and only after the user starts it; the file leaves the page solely
 * through `downloadReplay` from an explicit click. Nothing is uploaded or stored.
 *
 * What the file holds, and nothing more: times relative to the first recorded frame, handedness,
 * landmarks rounded to 1e-5, what the live classifier fired, the effective config and an optional
 * note. No wall-clock date, no device information, no pixels. Everything is bounded: it stops
 * itself at `maxDurationMs` or `maxFrames`, and it never records a frame the replay parser would
 * reject, so a saved file always loads back as a fixture.
 */
export class ReplayRecorder {
  private readonly frames: ReplayFrame[] = [];
  private readonly detected: Array<{ kind: IntentKind; t: number }> = [];
  /** Capture time of the first recorded frame; every stored time is relative to it. */
  private originMs = 0;
  private isRecording = false;
  private isFull = false;

  constructor(
    private readonly maxDurationMs = DEFAULT_MAX_DURATION_MS,
    private readonly maxFrames = DEFAULT_MAX_FRAMES,
  ) {
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new RangeError('maxDurationMs must be a positive finite number');
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new RangeError('maxFrames must be a positive integer');
  }

  get recording(): boolean {
    return this.isRecording;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Span from the first to the last recorded frame, ms. */
  get durationMs(): number {
    return this.frames.length === 0 ? 0 : this.frames[this.frames.length - 1].t;
  }

  /** True once a cap stopped the recording by itself; cleared by `start` and `clear`. */
  get full(): boolean {
    return this.isFull;
  }

  /** Begins a new recording. Whatever was recorded before is discarded: one session per file. */
  start(): void {
    this.clear();
    this.isRecording = true;
  }

  /** Ends the recording but keeps what was captured, ready for `toFile`. */
  stop(): void {
    this.isRecording = false;
  }

  /** Stops and forgets everything, as when the user discards a recording. */
  clear(): void {
    this.isRecording = false;
    this.isFull = false;
    this.originMs = 0;
    this.frames.length = 0;
    this.detected.length = 0;
  }

  /**
   * Adds a frame while recording and stops by itself at the caps. A frame the parser would
   * reject is skipped, leaving an honest gap rather than a half-true frame: one that is not
   * finite, has a hand without exactly 21 landmarks, or does not come after the previous frame.
   * Arrival is clamped to capture time, since a result cannot arrive before its frame.
   */
  add(frame: HandFrame, arrivalMs: number): void {
    if (!this.isRecording || !isRecordable(frame, arrivalMs)) return;
    if (this.frames.length === 0) this.originMs = frame.timestampMs;
    const t = roundTo(frame.timestampMs - this.originMs, TIME_SCALE);
    if (t > this.maxDurationMs) {
      this.finish();
      return;
    }
    // The parser requires strictly increasing capture times; durationMs is the last frame's.
    if (this.frames.length > 0 && t <= this.durationMs) return;
    const a = Math.max(t, roundTo(arrivalMs - this.originMs, TIME_SCALE));
    this.frames.push({ t, a, hands: frame.hands.map(toReplayHand) });
    if (this.frames.length >= this.maxFrames) this.finish();
  }

  /**
   * Notes what the live classifier fired. This is not ground truth: it lets a later reader see
   * what the user was shown, next to the labels added by hand. Ignored while not recording, and
   * for times before the first recorded frame.
   */
  markDetected(kind: IntentKind, timestampMs: number): void {
    if (!this.isRecording || this.frames.length === 0 || !Number.isFinite(timestampMs)) return;
    const t = roundTo(timestampMs - this.originMs, TIME_SCALE);
    if (t < 0 || this.detected.length >= MAX_DETECTED) return;
    this.detected.push({ kind, t });
  }

  /**
   * Builds the ReplayFile without touching the DOM. The result is an independent snapshot:
   * recording on, or editing the file, never affects the other. `config` is cloned, so it must be
   * plain data; `note` is trimmed and capped. Keys with nothing to say are omitted.
   */
  toFile(config?: unknown, note?: string): ReplayFile {
    const text = note?.trim().slice(0, MAX_NOTE_CHARS);
    // Metadata first and the long frame list last, so the JSON reads well when opened by hand.
    return {
      schema: SCHEMA,
      ...(text ? { note: text } : {}),
      ...(config !== undefined ? { config: structuredClone(config) } : {}),
      detected: this.detected.map(entry => ({ ...entry })),
      frames: structuredClone(this.frames),
    };
  }

  private finish(): void {
    this.isRecording = false;
    this.isFull = true;
  }
}

/**
 * Hands the replay to the user as a local JSON download: Blob, object URL and a temporary
 * `<a download>`; nothing is sent anywhere. Browser only, and only from an explicit click
 * handler. The URL is revoked a moment later, once the browser has started the download.
 * `doc` and `urls` are injectable so the flow can be tested without a browser.
 */
export function downloadReplay(
  file: ReplayFile,
  filename: string,
  doc: Document = document,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): void {
  const url = urls.createObjectURL(new Blob([serializeReplay(file)], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  setTimeout(() => urls.revokeObjectURL(url), REVOKE_DELAY_MS);
}
