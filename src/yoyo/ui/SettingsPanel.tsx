import { canPause, type EngineState } from '../app/engineState';
import type { YoyoEngine } from '../app/YoyoEngine';
import { PresetToggle } from './StartScreen';

export interface SettingsPanelProps {
  engine: YoyoEngine;
  state: EngineState;
  advancedOpen: boolean;
  diagnosticsOpen: boolean;
  onToggleAdvanced: () => void;
  onToggleDiagnostics: () => void;
}

/**
 * «Ajustes»: the controls that are not the game. Buttons that need a camera stay in place but disabled
 * without one, so the panel does not rearrange itself between sources.
 */
export function SettingsPanel({ engine, state, advancedOpen, diagnosticsOpen, onToggleAdvanced, onToggleDiagnostics }: SettingsPanelProps) {
  const camera = state.source === 'camera';
  const cameraRunning = camera && (state.mode === 'playing' || state.mode === 'framing' || state.mode === 'paused');
  return (
    <div className="panel" id="settings-panel">
      <button onClick={() => engine.togglePause()} disabled={!canPause(state.mode)}>{state.mode === 'paused' ? 'Reanudar' : 'Pausar'}</button>
      <button onClick={() => engine.setMuted(!state.muted)}>{state.muted ? 'Activar sonido' : 'Silenciar'}</button>
      <label className="volume">
        Volumen
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(state.volume * 100)}
          aria-label="Volumen"
          onChange={e => engine.setVolume(Number(e.target.value) / 100)}
        />
      </label>
      {/* While framing, the same choice is already on screen under the outline. */}
      {state.mode !== 'framing' && <PresetToggle engine={engine} preset={state.config.preset} />}
      <button onClick={() => engine.recalibrate()} disabled={!cameraRunning}>Recalibrar</button>
      <button onClick={() => engine.stopCamera()} disabled={!camera}>Apagar cámara</button>
      <button onClick={() => engine.backToStart()} disabled={state.source === null}>Volver al inicio</button>
      <button aria-expanded={diagnosticsOpen} aria-controls="diagnostics" onClick={onToggleDiagnostics}>Diagnóstico</button>
      <button aria-expanded={advancedOpen} aria-controls="advanced-panel" onClick={onToggleAdvanced}>Avanzado</button>
    </div>
  );
}
