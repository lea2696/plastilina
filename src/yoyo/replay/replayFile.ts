import type { HandDetection, HandFrame } from '../../shared/contracts';
import type { IntentKind, ReplayFile } from '../contracts';

const SCHEMA = 'yoyo-replay/1';
const KINDS: readonly IntentKind[] = ['launch', 'tug'];
const HANDEDNESS: readonly HandDetection['handedness'][] = ['Left', 'Right', 'Unknown'];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** JSON text of a replay file. Compact: landmark files reach a few MB per minute. */
export function serializeReplay(file: ReplayFile): string {
  return JSON.stringify(file);
}

/**
 * Parses and validates a replay file. Throws with a reason instead of returning a partly valid
 * replay: a fixture that silently drops frames would corrupt precision/recall measurements.
 */
export function parseReplay(text: string): ReplayFile {
  const data = JSON.parse(text) as Partial<ReplayFile> | null;
  if (!isObject(data)) throw new Error('Replay is not an object');
  if (data.schema !== SCHEMA) throw new Error(`Unknown replay schema: ${String(data.schema)}`);
  if (!Array.isArray(data.frames)) throw new Error('Replay without frames');
  let lastT = -Infinity;
  for (const [i, frame] of data.frames.entries()) {
    if (!isObject(frame)) throw new Error(`Frame ${i}: not an object`);
    if (!isFiniteNumber(frame.t) || !isFiniteNumber(frame.a) || frame.a < frame.t) throw new Error(`Frame ${i}: bad timestamps`);
    if (frame.t <= lastT) throw new Error(`Frame ${i}: timestamps must increase`);
    lastT = frame.t;
    if (!Array.isArray(frame.hands)) throw new Error(`Frame ${i}: hands missing`);
    for (const hand of frame.hands) {
      if (!isObject(hand)) throw new Error(`Frame ${i}: bad hand`);
      if (!HANDEDNESS.includes(hand.h)) throw new Error(`Frame ${i}: bad handedness`);
      if (!Array.isArray(hand.lm) || hand.lm.length !== 21) throw new Error(`Frame ${i}: a hand needs 21 landmarks`);
      if (!hand.lm.every(p => Array.isArray(p) && p.length === 3 && p.every(isFiniteNumber))) throw new Error(`Frame ${i}: non-finite landmark`);
    }
  }
  checkIntents(data.detected, 'detected', 't');
  checkIntents(data.labels, 'labels', 'onsetMs');
  return data as ReplayFile;
}

/**
 * Detections and labels: a list of entries with a known kind and a finite time. A label whose
 * onset is missing or NaN would otherwise load fine and then silently skew precision and recall.
 * Absent (or null) means "none", as the format always allowed.
 */
function checkIntents(list: unknown, name: 'detected' | 'labels', timeKey: 't' | 'onsetMs'): void {
  if (list === undefined || list === null) return;
  if (!Array.isArray(list)) throw new Error(`${name} must be a list`);
  for (const [i, entry] of list.entries()) {
    if (!isObject(entry)) throw new Error(`${name}[${i}]: not an object`);
    if (!KINDS.includes(entry.kind as IntentKind)) throw new Error(`Unknown intent kind: ${String(entry.kind)}`);
    if (!isFiniteNumber(entry[timeKey])) throw new Error(`${name}[${i}]: bad ${timeKey}`);
  }
}

/** Frames ready to feed a runtime, in arrival order, as the camera path would deliver them. */
export function replayFrames(file: ReplayFile): Array<{ frame: HandFrame; arrivalMs: number }> {
  return file.frames
    .map(f => ({
      arrivalMs: f.a,
      frame: {
        timestampMs: f.t,
        source: 'replay' as const,
        hands: f.hands.map(h => ({ handedness: h.h, landmarks: h.lm.map(([x, y, z]) => ({ x, y, z })) })),
      },
    }))
    .sort((p, q) => p.arrivalMs - q.arrivalMs);
}
