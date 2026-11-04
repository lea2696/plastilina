import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MasaEngine, type AppMode } from './app/MasaEngine';
import { CLAY_COLORS } from './rendering/Studio';
import './style.css';

function App() {
  const canvas = useRef<HTMLCanvasElement>(null), engine = useRef<MasaEngine | null>(null);
  const [mode, setMode] = useState<AppMode>('idle');
  const [detail, setDetail] = useState('');
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [dark, setDark] = useState(true);
  const [color, setColor] = useState(CLAY_COLORS[0].value);
  const [settings, setSettings] = useState(false);
  const [diagnostic, setDiagnostic] = useState(false);
  const [stats, setStats] = useState('');

  useEffect(() => {
    if (!canvas.current) return;
    let supported = false;
    try { const probe = document.createElement('canvas'); supported = !!(probe.getContext('webgl2') || probe.getContext('webgl')); } catch { supported = false; }
    if (!supported) { setMode('unsupported'); setDetail('Este navegador no ofrece WebGL. Probá Chrome actualizado en una computadora con gráficos disponibles.'); return; }
    let e: MasaEngine;
    try { e = new MasaEngine(canvas.current); } catch { setMode('unsupported'); setDetail('No se pudo iniciar la escena gráfica. Probá otro navegador o dispositivo.'); return; }
    engine.current = e;
    e.onChange = (m, d) => { setMode(m); setDetail(d); };
    const timer = setInterval(() => setStats(JSON.stringify(e.diagnostics())), 700);
    return () => { clearInterval(timer); e.dispose(); engine.current = null; };
  }, []);

  const graphicsError = mode === 'unsupported' || detail.includes('dispositivo gráfico');
  const starting = mode === 'idle' || mode === 'error';
  const hasCamera = !!engine.current?.camera;
  return <div className={`app ${dark ? 'dark' : 'light'} ${settings ? 'settings-open' : ''}`}>
    <canvas ref={canvas} aria-label="Masa para amasar con las manos" />
    <span className="brand">masa<span className="dot">.</span></span>
    {/* key restarts the fade so each new status is readable, then gets out of the way. */}
    {detail && <p key={detail} className={`status ${starting || mode === 'calibrating' ? 'sticky' : ''}`} role="status">{detail}</p>}

    {graphicsError ? <div className="start"><button className="primary" onClick={() => location.reload()}>Reintentar</button></div>
      : starting ? <div className="start">
        <div className="actions">
          <button className="primary" onClick={() => void engine.current?.startCamera()}>Comenzar con cámara</button>
          <button onClick={() => engine.current?.startMouse()}>Probar con mouse</button>
          <button className="link" onClick={() => engine.current?.startReplay()}>Observar demo sintética</button>
        </div>
        <p className="note">Demo experimental · la cámara se procesa en tu navegador, nada se graba ni se envía</p>
      </div> : null}
    {mode === 'permission-pending' && <div className="start"><button onClick={() => engine.current?.stopCamera()}>Cancelar espera</button></div>}
    {mode === 'intro' && <div className="start"><button className="link" onClick={() => engine.current?.skipIntro()}>Omitir introducción</button></div>}

    {!graphicsError && <footer>
      <div className="dock">
        <div className="swatches" role="radiogroup" aria-label="Color de la masa">
          {CLAY_COLORS.map(c => <button key={c.value} role="radio" aria-checked={color === c.value} aria-label={c.name} title={c.name} className="swatch" style={{ background: c.value }}
            onClick={() => { setColor(c.value); engine.current?.setClayColor(c.value); }} />)}
        </div>
        <button onClick={() => engine.current?.reset()}>Reiniciar masa</button>
        <button aria-expanded={settings} onClick={() => setSettings(!settings)}>Ajustes</button>
      </div>
      {settings && <div className="panel">
        <button onClick={() => engine.current?.pause()} disabled={!['active', 'tracking-degraded', 'paused'].includes(mode)}>{mode === 'paused' ? 'Reanudar' : 'Pausar'}</button>
        <button onClick={() => { setMuted(!muted); engine.current?.mute(!muted); }}>{muted ? 'Activar sonido' : 'Silenciar'}</button>
        <label className="volume">Volumen <input type="range" min="0" max="100" value={volume} onChange={e => { const v = Number(e.target.value); setVolume(v); engine.current?.volume(v / 100); }} aria-label="Volumen" /></label>
        <button onClick={() => engine.current?.recalibrate()} disabled={!hasCamera}>Recalibrar</button>
        <button onClick={() => engine.current?.stopCamera()} disabled={!hasCamera}>Apagar cámara</button>
        <button onClick={() => { const next = !dark; setDark(next); engine.current?.darkMode(next); }} aria-pressed={dark}>{dark ? 'Modo claro' : 'Modo oscuro'}</button>
        <button onClick={() => setDiagnostic(!diagnostic)}>Diagnóstico</button>
      </div>}
      {diagnostic && <output>{stats}</output>}
    </footer>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
