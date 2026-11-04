import { createConfig, type YoyoConfig } from '../config';
import type { FrameEdge, InputSource, YoyoPhase } from '../contracts';
import type { QaMode } from './qaHook';

/**
 * What the UI knows about the engine. The engine runs at the display's rate and only publishes this when
 * something discrete changes, so React never re-renders per frame.
 *
 * - idle: start screen (the camera was never started, or was switched off).
 * - permission-pending: the browser is asking for the camera. loading: the hand model is loading.
 * - framing: camera ready, the outline guides the hand into place (≈ 10 s, skippable).
 * - playing: the camera drives the yoyo. mouse and demo: the other two sources.
 * - paused: the person paused (the source stays in `source`).
 * - unsupported: no WebGL. error: something failed; `fatal` says whether only a reload helps.
 */
export type EngineMode =
  | 'idle' | 'permission-pending' | 'loading' | 'framing' | 'playing' | 'mouse' | 'demo' | 'paused' | 'unsupported' | 'error';

/** The UI's view of the hand: present, was seen and is gone (≥ 300 ms), or never seen in this session. */
export type HandState = 'present' | 'lost' | 'none';

/** Small dot next to the brand: fresh data / stale (hand recently lost) / nothing. */
export type TrackingQuality = 'fresh' | 'stale' | 'none';

export interface RecorderState {
  recording: boolean;
  frames: number;
  durationMs: number;
  /** A cap (2 min or 4000 frames) stopped it by itself. */
  full: boolean;
}

export interface EngineState {
  mode: EngineMode;
  /** What drives the yoyo: null on the start screen. It stays set while paused. */
  source: InputSource | null;
  /** The runtime's phase; null when no runtime exists (start screen, loading). */
  phase: YoyoPhase | null;
  hand: HandState;
  /** The edge the hand touches or left through; null otherwise. Held a moment so it does not strobe. */
  edge: FrameEdge | null;
  tracking: TrackingQuality;
  /** Message of the transitional and failure modes; '' otherwise. */
  detail: string;
  /** The failure cannot be recovered without reloading the page (no WebGL, graphics device lost). */
  fatal: boolean;
  /** Effective config: preset, responsiveness, auto-return and every tunable of «Avanzado». */
  config: YoyoConfig;
  muted: boolean;
  /** 0..1 */
  volume: number;
  /** Body colour of the yoyo, '#rrggbb'. Not persisted anywhere. */
  color: string;
  recorder: RecorderState;
  /** The recorder holds frames that can be downloaded. */
  hasRecording: boolean;
  /** The page was opened with the QA hook (`?qa=camera-replay`, see qaHook.ts): its camera hands are synthetic. Null on every normal page. */
  qa: QaMode | null;
}

export const EMPTY_RECORDER: RecorderState = { recording: false, frames: 0, durationMs: 0, full: false };

export function initialState(color: string, volume: number, qa: QaMode | null = null): EngineState {
  return {
    mode: 'idle', source: null, phase: null, hand: 'none', edge: null, tracking: 'none', detail: '', fatal: false,
    config: createConfig('standing'), muted: false, volume, color, recorder: EMPTY_RECORDER, hasRecording: false, qa,
  };
}

/** A hand that vanished is shown as lost only after this long, so a dropped frame does not flash «Mano perdida». */
export const HAND_LOST_HOLD_MS = 300;
/** The edge vignette stays this long after the hand stops touching the border. */
export const EDGE_HOLD_MS = 300;
/** After this long without a hand the indicator goes from amber (just lost) to grey (not coming back on its own). */
export const TRACKING_STALE_MS = 3000;

/** Present while held; lost when it was seen in this session and is gone; none before it was ever seen. */
export function handState(held: boolean, seen: boolean): HandState {
  if (held) return 'present';
  return seen ? 'lost' : 'none';
}

/** Green while data arrives, amber for a hand lost a moment ago, grey for no hand at all. */
export function trackingQuality(hand: HandState, lostMs: number): TrackingQuality {
  if (hand === 'present') return 'fresh';
  if (hand === 'lost' && lostMs < TRACKING_STALE_MS) return 'stale';
  return 'none';
}

/** Modes in which a runtime exists and the yoyo is on screen (or about to be). */
export function hasRuntime(mode: EngineMode): boolean {
  return mode === 'framing' || mode === 'playing' || mode === 'mouse' || mode === 'demo' || mode === 'paused';
}

/** Modes in which pausing makes sense and the person can ask for it. */
export function canPause(mode: EngineMode): boolean {
  return mode === 'playing' || mode === 'mouse' || mode === 'demo' || mode === 'paused';
}
