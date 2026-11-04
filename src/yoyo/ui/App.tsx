import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { YoyoEngine } from '../app/YoyoEngine';
import { AdvancedPanel } from './AdvancedPanel';
import { DiagnosticsOutput } from './DiagnosticsOutput';
import { Dock } from './Dock';
import { SettingsPanel } from './SettingsPanel';
import { FatalScreen, FramingBar, StartScreen, WaitBar } from './StartScreen';
import { EdgeTip, StatusPill, TrackingDot } from './StatusPill';
import { showsStart } from './status';

/**
 * The page: a full-screen canvas the engine draws on, and a thin layer of React over it. The engine is created
 * once the canvas exists and is disposed with it; React only renders what the engine publishes (discrete
 * changes), never frames. The root element also carries the engine's `data-*` attributes (mode, source,
 * phase, hand, edge, trail), which the engine writes itself.
 */
export function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<YoyoEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (canvas === null || root === null) return;
    const created = new YoyoEngine(canvas, root);
    setEngine(created);
    return () => {
      created.dispose();
      setEngine(null);
    };
  }, []);

  return (
    <div className="app" ref={rootRef}>
      <canvas ref={canvasRef} aria-label="Yoyó: se lanza y se tira con la mano frente a la cámara, o con el mouse" />
      <div className="vignette" aria-hidden="true" />
      <span className="brand">yoyó</span>
      {engine !== null && <Interface engine={engine} />}
    </div>
  );
}

/** Everything that reads the engine's state. */
function Interface({ engine }: { engine: YoyoEngine }) {
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const [settings, setSettings] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  // Kept here so closing and reopening the panel does not lose a note being written.
  const [note, setNote] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettings(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <StatusPill state={state} />
      <TrackingDot state={state} />
      <EdgeTip state={state} />

      {state.qa !== null && <span className="qa-badge" title="Hook de prueba: ?qa=camera-replay">QA · manos sintéticas</span>}

      {state.fatal
        ? <FatalScreen engine={engine} />
        : showsStart(state)
          ? <StartScreen engine={engine} />
          : state.mode === 'framing'
            ? <FramingBar engine={engine} preset={state.config.preset} />
            : state.mode === 'permission-pending' || state.mode === 'loading'
              ? <WaitBar engine={engine} />
              : null}

      {!state.fatal && (
        <footer>
          <Dock engine={engine} color={state.color} open={settings} onToggle={() => setSettings(open => !open)} />
          {settings && (
            <SettingsPanel
              engine={engine}
              state={state}
              advancedOpen={advanced}
              diagnosticsOpen={diagnostics}
              onToggleAdvanced={() => setAdvanced(open => !open)}
              onToggleDiagnostics={() => setDiagnostics(open => !open)}
            />
          )}
          {settings && (diagnostics || advanced) && (
            <div className="drawers">
              {diagnostics && <DiagnosticsOutput engine={engine} />}
              {advanced && <AdvancedPanel engine={engine} state={state} note={note} onNote={setNote} />}
            </div>
          )}
        </footer>
      )}
    </>
  );
}
