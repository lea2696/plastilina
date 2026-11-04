import { useState } from 'react';
import { CONFIG_FIELDS, getConfigValue, type ConfigField } from '../config';
import { hasRuntime, type EngineState } from '../app/engineState';
import type { YoyoEngine } from '../app/YoyoEngine';
import { formatField } from './format';
import { canRecord, recorderSummary } from './status';

/** A switch: a checkbox with the `switch` role, so assistive tech says «activado/desactivado». */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * The number next to a slider. It keeps what is being typed until the field is left (or Enter), because
 * committing every keystroke would rewrite «0.» into «0.00» under the cursor; the slider commits as it moves.
 */
function NumberBox({ field, value, label, onCommit }: { field: ConfigField; value: number; label: string; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const typed = Number(draft.trim().replace(',', '.'));
    if (draft.trim() !== '' && Number.isFinite(typed)) onCommit(typed);
    setDraft(null);
  };
  return (
    <input
      className="number"
      type="number"
      inputMode="decimal"
      min={field.min}
      max={field.max}
      step={field.step}
      value={draft ?? formatField(value, field)}
      aria-label={`${label}, valor`}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }}
    />
  );
}

/** One tunable: label, slider, exact number and unit. */
function FieldRow({ engine, field, value }: { engine: YoyoEngine; field: ConfigField; value: number }) {
  const id = `field-${field.key}`;
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      <div className="field-controls">
        <input
          id={id}
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          onChange={e => engine.setField(field.key, Number(e.target.value))}
        />
        <NumberBox field={field} value={value} label={field.label} onCommit={v => engine.setField(field.key, v)} />
        <span className="unit">{field.unit}</span>
      </div>
    </div>
  );
}

/** «Grabación» (PRD §8.3): landmarks of a real session, opt-in, downloaded only by an explicit click. */
function RecorderSection({ engine, state, note, onNote }: { engine: YoyoEngine; state: EngineState; note: string; onNote: (note: string) => void }) {
  const available = canRecord(state);
  const { recorder, hasRecording } = state;
  const summary = recorder.recording || hasRecording ? recorderSummary(recorder) : available ? 'Sin grabación' : 'Disponible con la cámara';
  return (
    <section className="group" aria-labelledby="recording-title">
      <h3 id="recording-title">Grabación</h3>
      <div className="row">
        {recorder.recording
          ? <button onClick={() => engine.stopRecording()}>Detener</button>
          : <button onClick={() => engine.startRecording()} disabled={!available}>Grabar landmarks</button>}
        <span className="muted" data-recording={recorder.recording}>{summary}</span>
      </div>
      {recorder.full && <p className="hint">Llegó al límite y se detuvo sola.</p>}
      <label className="note-field">
        Nota (opcional)
        <input type="text" maxLength={1000} value={note} onChange={e => onNote(e.target.value)} autoComplete="off" />
      </label>
      <div className="row">
        <button onClick={() => engine.downloadRecording(note)} disabled={!hasRecording}>Descargar JSON</button>
        <button className="link" onClick={() => engine.discardRecording()} disabled={!hasRecording}>Descartar</button>
      </div>
      <p className="hint">Sólo puntos de la mano, nunca imágenes. Queda en tu navegador hasta que lo descargues.</p>
    </section>
  );
}

export interface AdvancedPanelProps {
  engine: YoyoEngine;
  state: EngineState;
  note: string;
  onNote: (note: string) => void;
}

/**
 * «Ajustes → Avanzado»: the two switches, the recorder, the metrics export and one row per tunable of the
 * config. The actions come before the long list so they are reachable without scrolling.
 */
export function AdvancedPanel({ engine, state, note, onNote }: AdvancedPanelProps) {
  const { config } = state;
  return (
    <aside className="advanced" id="advanced-panel" aria-label="Ajustes avanzados">
      <h2>Avanzado</h2>
      <Switch label="Auto-retorno" checked={config.yoyo.autoReturn} onChange={on => engine.setAutoReturn(on)} />
      <Switch label="Modo no responsivo (experimental)" checked={config.responsiveness === 'unresponsive'} onChange={on => engine.setResponsive(!on)} />
      <p className="hint">En modo no responsivo el tirón no lo hace volver; el bind llega en una fase futura.</p>

      <RecorderSection engine={engine} state={state} note={note} onNote={onNote} />

      <section className="group" aria-labelledby="metrics-title">
        <h3 id="metrics-title">Métricas</h3>
        <div className="row">
          <button onClick={() => engine.exportMetrics()} disabled={!hasRuntime(state.mode)}>Exportar métricas</button>
        </div>
        <p className="hint">Contadores de esta sesión como archivo local; nada se envía.</p>
      </section>

      <section className="group" aria-labelledby="thresholds-title">
        <div className="group-head">
          <h3 id="thresholds-title">Umbrales</h3>
          <button onClick={() => engine.resetConfig()}>Restablecer</button>
        </div>
        {CONFIG_FIELDS.map(field => <FieldRow key={field.key} engine={engine} field={field} value={getConfigValue(config, field.key)} />)}
      </section>
    </aside>
  );
}
