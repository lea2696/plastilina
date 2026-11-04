import { useEffect, useState } from 'react';
import type { YoyoEngine } from '../app/YoyoEngine';

/** The panel samples ~3 times a second, only while it is open; the engine's rings are always collecting. */
const DIAGNOSTICS_INTERVAL_MS = 350;

/**
 * Diagnostics as an `<output>` of JSON, like Masa's. An explicit `role="group"` replaces the element's implicit
 * `status`: a live region that changes three times a second would be read out loud over and over, and it
 * would be a second «status» next to the pill.
 */
export function DiagnosticsOutput({ engine }: { engine: YoyoEngine }) {
  const [text, setText] = useState(() => engine.diagnosticsText());
  useEffect(() => {
    setText(engine.diagnosticsText());
    const timer = window.setInterval(() => setText(engine.diagnosticsText()), DIAGNOSTICS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [engine]);
  return <output id="diagnostics" role="group" aria-label="Diagnóstico" aria-live="off">{text}</output>;
}
