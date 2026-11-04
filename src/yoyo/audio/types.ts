/**
 * Vocabulary shared by the director (decides what to play) and the voices (decide how it sounds).
 * Plain data on purpose: the director runs and is tested in Node with no Web Audio at all.
 */

/** The five one-shot voices of the yoyo. */
export type OneShotKind = 'whoosh' | 'snap' | 'zip' | 'catch' | 'tether';

export const ONE_SHOT_KINDS: readonly OneShotKind[] = ['whoosh', 'snap', 'zip', 'catch', 'tether'];

/** What a one-shot voice builder needs to know. */
export interface OneShotParams {
  /** Peak linear amplitude before the master chain, 0..1. */
  gain: number;
  /** Normalised strength of the cause, 0..1. Brightness, pitch and sweep range derive from it. */
  intensity: number;
  /** Nominal length, seconds. The voice shapes its envelope to it and releases its nodes after it. */
  durationS: number;
}

export interface OneShotCommand extends OneShotParams {
  kind: OneShotKind;
}

/** Target of the continuous hum. While `active` is false only the fade-out matters. */
export interface HumCommand {
  active: boolean;
  /** Fundamental, Hz. */
  frequencyHz: number;
  /** Overall linear amplitude before the master chain. */
  gain: number;
  /** 0..1: how bright the bearing texture is. Follows spin. */
  brightness: number;
}

/** What the director asks for on one rendered frame. */
export interface DirectorFrame {
  /** One-shots to start now, in event order. */
  oneShots: readonly OneShotCommand[];
  /** Hum target to apply now, or null when the previous one still stands (update-rate limit). */
  hum: HumCommand | null;
}
