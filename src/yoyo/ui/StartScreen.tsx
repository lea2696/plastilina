import type { Preset } from '../config';
import type { YoyoEngine } from '../app/YoyoEngine';

/** Start: three ways in and one line about privacy. */
export function StartScreen({ engine }: { engine: YoyoEngine }) {
  return (
    <div className="start">
      <div className="actions">
        <button className="primary" onClick={() => void engine.startCamera()}>Comenzar con cámara</button>
        <button onClick={() => engine.startMouse()}>Probar con mouse</button>
        <button className="link" onClick={() => engine.startDemo()}>Ver demo</button>
      </div>
      <p className="note">La cámara se procesa en tu navegador; nada se graba ni se envía.</p>
    </div>
  );
}

/** While the browser asks for the camera or the model loads. */
export function WaitBar({ engine }: { engine: YoyoEngine }) {
  return (
    <div className="start">
      <button onClick={() => engine.cancelStart()}>Cancelar</button>
    </div>
  );
}

/** Calibration: the preset and the way out. The prompt itself is the status pill. */
export function FramingBar({ engine, preset }: { engine: YoyoEngine; preset: Preset }) {
  return (
    <div className="start">
      <div className="actions">
        <PresetToggle engine={engine} preset={preset} />
        <button onClick={() => engine.skipFraming()}>Omitir</button>
      </div>
    </div>
  );
}

/** A failure only a reload fixes (no WebGL, graphics device lost); the pill says which. */
export function FatalScreen({ engine }: { engine: YoyoEngine }) {
  return (
    <div className="start">
      <button className="primary" onClick={() => engine.retry()}>Reintentar</button>
    </div>
  );
}

/** «De pie» / «Sentado»: two buttons of one choice, each saying whether it is the current one. */
export function PresetToggle({ engine, preset }: { engine: YoyoEngine; preset: Preset }) {
  return (
    <div className="segmented" role="group" aria-label="Postura">
      <button aria-pressed={preset === 'standing'} onClick={() => engine.setPreset('standing')}>De pie</button>
      <button aria-pressed={preset === 'seated'} onClick={() => engine.setPreset('seated')}>Sentado</button>
    </div>
  );
}
