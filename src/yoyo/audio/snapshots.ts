import type { YoyoSnapshot } from '../contracts';

/**
 * A complete YoyoSnapshot with quiet defaults (hand present, nothing happening), for tests and for
 * the offline QA that scripts snapshots by hand. Override only what a case is about.
 */
export function buildSnapshot(overrides: Partial<YoyoSnapshot> = {}): YoyoSnapshot {
  return {
    timeMs: 0,
    phase: 'untethered',
    responsiveness: 'responsive',
    pivot: [0, 0.85],
    pivotVelocity: [0, 0],
    yoyo: [0, 0.2],
    yoyoVelocity: [0, 0],
    length: 0.65,
    maxLength: 0.65,
    spin: 0,
    spinAngle: 0,
    tension: 0,
    slack: false,
    hand: { present: true, lostMs: 0, edge: null, landmarks: null, palmWorld: 0 },
    paused: false,
    events: [],
    steps: 0,
    droppedMs: 0,
    ...overrides,
  };
}
