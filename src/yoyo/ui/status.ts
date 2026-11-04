import { hasRuntime, type EngineState, type RecorderState, type TrackingQuality } from '../app/engineState';
import type { FrameEdge } from '../contracts';

/**
 * Every sentence the page says about the game, in one place (Spanish rioplatense, voseo, short).
 * The pill is a single `role="status"` element whose text follows `pillText`; nothing else announces.
 */
export const TEXT = {
  framing: 'Levantá la mano dentro del contorno',
  untethered: 'Mostrá la mano y quedate quieto un momento',
  tethered: 'Atado · lanzá hacia abajo',
  rolling: 'Rodando',
  sleeping: 'Durmiendo · tirá para que vuelva',
  sleepingNoReturn: 'Durmiendo · sin retorno',
  returning: 'Enrollando',
  caught: '¡Atrapado!',
  exhausted: 'Giro agotado · tirá para enrollar',
  exhaustedNoReturn: 'Giro agotado · sin retorno',
  handLost: 'Mano perdida',
  paused: 'Pausa',
  demo: 'Demo',
  mouse: 'Mantené apretado · arrastrá rápido hacia abajo para lanzar · hacia arriba para tirar',
} as const;

/** Tip under the vignette: what to do about the hand touching a border of the camera frame. */
export const EDGE_TIPS: Readonly<Record<FrameEdge, string>> = {
  bottom: 'Muy abajo · subí la mano o incliná la cámara',
  top: 'Muy arriba · bajá la mano',
  left: 'Muy a la izquierda · acercala al centro',
  right: 'Muy a la derecha · acercala al centro',
};

export const TRACKING_LABELS: Readonly<Record<TrackingQuality, string>> = {
  fresh: 'Seguimiento activo',
  stale: 'Seguimiento intermitente',
  none: 'Sin seguimiento',
};

type PillState = Pick<EngineState, 'mode' | 'source' | 'phase' | 'hand' | 'detail' | 'config'>;

/**
 * The text of the status pill, or '' when there is nothing to say (the start screen speaks for itself).
 *
 * Priority: failures and transitions (they carry their own message), pause, demo, framing, and then the
 * phase of the yoyo, where a hand lost while the yoyo is tied on trumps the phase (it is the thing the
 * person has to fix). In mouse mode the hint stays until the button is held AND the yoyo is tied on:
 * before that, and whenever the button is released, the person is told how to hold it.
 */
export function pillText(state: PillState): string {
  switch (state.mode) {
    case 'idle': return '';
    case 'unsupported':
    case 'error':
    case 'permission-pending':
    case 'loading': return state.detail;
    case 'paused': return TEXT.paused;
    case 'demo': return TEXT.demo;
    case 'framing': return TEXT.framing;
    default: break;
  }
  const phase = state.phase ?? 'untethered';
  if (state.source === 'mouse' && (state.hand !== 'present' || phase === 'untethered')) return TEXT.mouse;
  if (phase === 'untethered') return TEXT.untethered;
  if (state.hand === 'lost') return TEXT.handLost;
  const responsive = state.config.responsiveness === 'responsive';
  switch (phase) {
    case 'tethered': return TEXT.tethered;
    case 'rolling': return TEXT.rolling;
    case 'sleeping': return responsive ? TEXT.sleeping : TEXT.sleepingNoReturn;
    case 'returning': return TEXT.returning;
    case 'caught': return TEXT.caught;
    case 'exhausted': return responsive ? TEXT.exhausted : TEXT.exhaustedNoReturn;
  }
}

/** The pill stays put while the state lasts (errors, loading, hints); only game phases change under it. */
export function edgeTip(edge: FrameEdge | null): string {
  return edge === null ? '' : EDGE_TIPS[edge];
}

/** The tracking dot says something only when a camera (or the stand-in demo camera) feeds the yoyo. */
export function showsTracking(state: Pick<EngineState, 'mode' | 'source'>): boolean {
  if (state.source === 'camera') return state.mode === 'framing' || state.mode === 'playing' || state.mode === 'paused';
  return state.source === 'replay' && hasRuntime(state.mode);
}

/** Start screen: nothing running, or a failure the person can get out of by picking a source again. */
export function showsStart(state: Pick<EngineState, 'mode' | 'fatal'>): boolean {
  return state.mode === 'idle' || (state.mode === 'error' && !state.fatal);
}

/** The recorder is only for the camera, and only while a camera session is up. */
export function canRecord(state: Pick<EngineState, 'mode' | 'source'>): boolean {
  return state.source === 'camera' && (state.mode === 'framing' || state.mode === 'playing' || state.mode === 'paused');
}

/** «4,1 s» (Spanish decimal comma). */
export function formatDuration(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  return `${seconds.toFixed(1).replace('.', ',')} s`;
}

/** «123 cuadros · 4,1 s», singular for one. */
export function recorderSummary(recorder: RecorderState): string {
  const frames = `${recorder.frames} ${recorder.frames === 1 ? 'cuadro' : 'cuadros'}`;
  return `${frames} · ${formatDuration(recorder.durationMs)}`;
}
