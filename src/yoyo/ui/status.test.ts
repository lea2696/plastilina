import { describe, expect, it } from 'vitest';
import { createConfig } from '../config';
import type { EngineState } from '../app/engineState';
import { initialState, trackingQuality, handState, canPause, hasRuntime, HAND_LOST_HOLD_MS } from '../app/engineState';
import type { FrameEdge, YoyoPhase } from '../contracts';
import {
  EDGE_TIPS, TEXT, TRACKING_LABELS, canRecord, edgeTip, formatDuration, pillText, recorderSummary, showsStart, showsTracking,
} from './status';

const state = (over: Partial<EngineState> = {}): EngineState => ({ ...initialState('#e5383b', 0.8), ...over });

describe('pillText: the phases of the camera game', () => {
  const table: Array<[YoyoPhase, string]> = [
    ['tethered', 'Atado · lanzá hacia abajo'],
    ['rolling', 'Rodando'],
    ['sleeping', 'Durmiendo · tirá para que vuelva'],
    ['returning', 'Enrollando'],
    ['caught', '¡Atrapado!'],
    ['exhausted', 'Giro agotado · tirá para enrollar'],
    ['untethered', 'Mostrá la mano y quedate quieto un momento'],
  ];

  it.each(table)('says the words of the PRD for %s', (phase, text) => {
    expect(pillText(state({ mode: 'playing', source: 'camera', phase, hand: 'present' }))).toBe(text);
  });

  it('says «Mano perdida» when the hand is gone while the yoyo is tied on, whatever the phase', () => {
    for (const phase of ['tethered', 'rolling', 'sleeping', 'returning', 'caught', 'exhausted'] as const) {
      expect(pillText(state({ mode: 'playing', source: 'camera', phase, hand: 'lost' }))).toBe('Mano perdida');
    }
  });

  it('keeps asking for the hand while untethered, even if it was lost (that is the thing to do)', () => {
    expect(pillText(state({ mode: 'playing', source: 'camera', phase: 'untethered', hand: 'lost' }))).toBe(TEXT.untethered);
    expect(pillText(state({ mode: 'playing', source: 'camera', phase: 'untethered', hand: 'none' }))).toBe(TEXT.untethered);
    expect(pillText(state({ mode: 'playing', source: 'camera', phase: null, hand: 'none' }))).toBe(TEXT.untethered);
  });

  it('drops the promise of a return when the yoyo is not responsive (no bind yet)', () => {
    const config = createConfig('standing');
    config.responsiveness = 'unresponsive';
    expect(pillText(state({ mode: 'playing', source: 'camera', phase: 'sleeping', hand: 'present', config }))).toBe('Durmiendo · sin retorno');
    expect(pillText(state({ mode: 'playing', source: 'camera', phase: 'exhausted', hand: 'present', config }))).toBe('Giro agotado · sin retorno');
    // The other phases do not depend on it.
    expect(pillText(state({ mode: 'playing', source: 'camera', phase: 'rolling', hand: 'present', config }))).toBe('Rodando');
  });

  it('keeps every sentence short', () => {
    for (const [, text] of table) expect(text.length).toBeLessThanOrEqual(46);
    expect(TEXT.handLost.length).toBeLessThan(20);
  });
});

describe('pillText: modes', () => {
  it('is empty on the start screen', () => {
    expect(pillText(state({ mode: 'idle' }))).toBe('');
  });

  it('shows the framing prompt while framing, whatever the phase says', () => {
    expect(pillText(state({ mode: 'framing', source: 'camera', phase: 'untethered' }))).toBe('Levantá la mano dentro del contorno');
  });

  it('says «Pausa» when paused, for every source', () => {
    for (const source of ['camera', 'mouse', 'replay'] as const) {
      expect(pillText(state({ mode: 'paused', source, phase: 'sleeping', hand: 'present' }))).toBe('Pausa');
    }
  });

  it('says «Demo» during the demo and nothing else', () => {
    for (const phase of ['untethered', 'rolling', 'sleeping', 'caught'] as const) {
      expect(pillText(state({ mode: 'demo', source: 'replay', phase, hand: 'present' }))).toBe('Demo');
    }
  });

  it('shows the message of transitions and failures', () => {
    for (const mode of ['permission-pending', 'loading', 'error', 'unsupported'] as const) {
      expect(pillText(state({ mode, detail: 'un mensaje' }))).toBe('un mensaje');
    }
  });
});

describe('pillText: the mouse', () => {
  const mouse = (over: Partial<EngineState>) => state({ mode: 'mouse', source: 'mouse', ...over });
  const hint = 'Mantené apretado · arrastrá rápido hacia abajo para lanzar · hacia arriba para tirar';

  it('shows the hint until the button is held and the yoyo is tied on', () => {
    expect(TEXT.mouse).toBe(hint);
    expect(pillText(mouse({ phase: 'untethered', hand: 'none' }))).toBe(hint);
    expect(pillText(mouse({ phase: 'untethered', hand: 'present' }))).toBe(hint);
  });

  it('shows the phases once the yoyo is tied on and the button is held', () => {
    expect(pillText(mouse({ phase: 'tethered', hand: 'present' }))).toBe('Atado · lanzá hacia abajo');
    expect(pillText(mouse({ phase: 'rolling', hand: 'present' }))).toBe('Rodando');
    expect(pillText(mouse({ phase: 'sleeping', hand: 'present' }))).toBe('Durmiendo · tirá para que vuelva');
  });

  it('goes back to the hint when the button is released (the hand is the button; it is not «lost»)', () => {
    expect(pillText(mouse({ phase: 'sleeping', hand: 'lost' }))).toBe(hint);
  });
});

describe('edge tips and the dot', () => {
  it('tells what to do at the bottom edge (the one throws leave through)', () => {
    // The voseo imperative of «inclinar» carries an acute accent, like «subí».
    expect(edgeTip('bottom')).toBe('Muy abajo · subí la mano o incliná la cámara');
    expect(edgeTip(null)).toBe('');
  });

  it('has a tip for every edge, in voseo', () => {
    const edges: FrameEdge[] = ['bottom', 'top', 'left', 'right'];
    for (const edge of edges) {
      expect(EDGE_TIPS[edge].length).toBeGreaterThan(5);
      expect(EDGE_TIPS[edge]).not.toMatch(/\b(sube|baja|acerca|inclina)\b/);
    }
  });

  it('names the three states of the tracking dot', () => {
    expect(Object.keys(TRACKING_LABELS).sort()).toEqual(['fresh', 'none', 'stale']);
    expect(TRACKING_LABELS.fresh).toMatch(/activo/);
  });

  it('is green while the hand is present, amber just after it was lost, grey after that or without a hand', () => {
    expect(trackingQuality('present', 0)).toBe('fresh');
    expect(trackingQuality('lost', 500)).toBe('stale');
    expect(trackingQuality('lost', 2999)).toBe('stale');
    expect(trackingQuality('lost', 3000)).toBe('none');
    expect(trackingQuality('none', 0)).toBe('none');
  });

  it('only shows the dot for a camera session or the demo', () => {
    expect(showsTracking({ mode: 'playing', source: 'camera' })).toBe(true);
    expect(showsTracking({ mode: 'framing', source: 'camera' })).toBe(true);
    expect(showsTracking({ mode: 'paused', source: 'camera' })).toBe(true);
    expect(showsTracking({ mode: 'loading', source: 'camera' })).toBe(false);
    expect(showsTracking({ mode: 'demo', source: 'replay' })).toBe(true);
    expect(showsTracking({ mode: 'mouse', source: 'mouse' })).toBe(false);
    expect(showsTracking({ mode: 'idle', source: null })).toBe(false);
  });
});

describe('what each mode offers', () => {
  it('shows the start actions on the start screen and after a failure that can be recovered from', () => {
    expect(showsStart({ mode: 'idle', fatal: false })).toBe(true);
    expect(showsStart({ mode: 'error', fatal: false })).toBe(true);
    expect(showsStart({ mode: 'error', fatal: true })).toBe(false);
    expect(showsStart({ mode: 'unsupported', fatal: true })).toBe(false);
    expect(showsStart({ mode: 'playing', fatal: false })).toBe(false);
  });

  it('allows recording only with the camera up', () => {
    expect(canRecord({ mode: 'framing', source: 'camera' })).toBe(true);
    expect(canRecord({ mode: 'playing', source: 'camera' })).toBe(true);
    expect(canRecord({ mode: 'paused', source: 'camera' })).toBe(true);
    expect(canRecord({ mode: 'loading', source: 'camera' })).toBe(false);
    expect(canRecord({ mode: 'mouse', source: 'mouse' })).toBe(false);
    expect(canRecord({ mode: 'demo', source: 'replay' })).toBe(false);
    expect(canRecord({ mode: 'idle', source: null })).toBe(false);
  });

  it('allows pausing only while something is playing', () => {
    for (const mode of ['playing', 'mouse', 'demo', 'paused'] as const) expect(canPause(mode)).toBe(true);
    for (const mode of ['idle', 'framing', 'loading', 'permission-pending', 'error', 'unsupported'] as const) expect(canPause(mode)).toBe(false);
  });

  it('knows which modes have a runtime', () => {
    for (const mode of ['framing', 'playing', 'mouse', 'demo', 'paused'] as const) expect(hasRuntime(mode)).toBe(true);
    for (const mode of ['idle', 'loading', 'permission-pending', 'error', 'unsupported'] as const) expect(hasRuntime(mode)).toBe(false);
  });
});

describe('hand state', () => {
  it('is present, lost or none', () => {
    expect(handState(true, true)).toBe('present');
    expect(handState(false, true)).toBe('lost');
    expect(handState(false, false)).toBe('none');
    expect(HAND_LOST_HOLD_MS).toBeGreaterThanOrEqual(300);
  });
});

describe('recorder labels', () => {
  it('writes the duration with a decimal comma', () => {
    expect(formatDuration(4123)).toBe('4,1 s');
    expect(formatDuration(0)).toBe('0,0 s');
    expect(formatDuration(Number.NaN)).toBe('0,0 s');
    expect(formatDuration(120_000)).toBe('120,0 s');
  });

  it('counts frames, singular for one', () => {
    expect(recorderSummary({ recording: true, frames: 123, durationMs: 4123, full: false })).toBe('123 cuadros · 4,1 s');
    expect(recorderSummary({ recording: true, frames: 1, durationMs: 0, full: false })).toBe('1 cuadro · 0,0 s');
    expect(recorderSummary({ recording: false, frames: 0, durationMs: 0, full: false })).toBe('0 cuadros · 0,0 s');
  });
});
