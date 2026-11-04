import type { WorldRect, YoyoSnapshot } from '../contracts';

/**
 * The start screen's yoyo (PRD §3.1: «yoyó centrado sobre fondo oscuro»): a sleeper hanging from above
 * the top of the screen, spinning, swaying a few millimetres. It is a hand-made snapshot, not a runtime:
 * nothing is tied to anything, no hand exists, and no physics runs (Y-01 says none before the yoyo ties
 * on; this one never does). It only exists to give the first screen the object the whole page is about,
 * drawn by the very renderer that will draw the game.
 */

/** Rest height of the yoyo as a share of the visible height measured from the bottom: slightly above the middle. */
const REST_HEIGHT = 0.56;
/** The string's top end sits this far above the top edge, so no pivot, ring or grip marker is ever visible. */
const PIVOT_ABOVE_TOP_M = 0.15;
const SWAY_AMPLITUDE_M = 0.012;
const SWAY_PERIOD_MS = 4200;
/** A slow-enough spin to read as «sleeping» and fast enough to show the spin ring and the brushed streak, rad/s. */
const IDLE_SPIN = 260;
/** With prefers-reduced-motion the yoyo hangs still and only turns slowly (no ring, no streak, no sway), rad/s. */
const REDUCED_SPIN = 40;
/** A hanging yoyo weighs m·g = 0.06 kg · 9.81 m/s², N. */
const HANG_TENSION = 0.59;

/** Used when the renderer has no layout yet (a 0 × 0 canvas): a landscape view like the renderer's (floor at 0, about 1.3 m of height). */
const FALLBACK_VIEW: WorldRect = { left: -1.04, right: 1.04, bottom: -0.06, top: 1.24 };

const finiteView = (v: WorldRect): boolean =>
  Number.isFinite(v.left + v.right + v.bottom + v.top) && v.top > v.bottom && v.right > v.left;

/** The snapshot to draw on the start screen at `nowMs`, for the world rectangle currently visible. */
export function idleSnapshot(nowMs: number, view: WorldRect, reducedMotion = false): YoyoSnapshot {
  const v = finiteView(view) ? view : FALLBACK_VIEW;
  const t = Number.isFinite(nowMs) ? nowMs : 0;
  const centreX = (v.left + v.right) / 2;
  const pivotY = v.top + PIVOT_ABOVE_TOP_M;
  const restY = v.bottom + REST_HEIGHT * (v.top - v.bottom);
  const length = pivotY - restY;
  const phase = (2 * Math.PI * t) / SWAY_PERIOD_MS;
  const amplitude = reducedMotion ? 0 : SWAY_AMPLITUDE_M;
  const spin = reducedMotion ? REDUCED_SPIN : IDLE_SPIN;
  const swayX = amplitude * Math.sin(phase);
  // The string stays taut: the yoyo moves along the circle of radius `length` around the pivot.
  const x = centreX + swayX;
  const y = pivotY - Math.sqrt(Math.max(0, length * length - swayX * swayX));
  const turn = 2 * Math.PI;
  return {
    timeMs: t,
    phase: 'sleeping',
    responsiveness: 'responsive',
    pivot: [centreX, pivotY],
    pivotVelocity: [0, 0],
    yoyo: [x, y],
    yoyoVelocity: [(amplitude * 2 * Math.PI / SWAY_PERIOD_MS) * 1000 * Math.cos(phase), 0],
    length,
    maxLength: length,
    spin,
    spinAngle: (((spin * t) / 1000) % turn + turn) % turn,
    tension: HANG_TENSION,
    slack: false,
    hand: { present: false, lostMs: 0, edge: null, landmarks: null, palmWorld: 0 },
    paused: false,
    events: [],
    steps: 0,
    droppedMs: 0,
  };
}
