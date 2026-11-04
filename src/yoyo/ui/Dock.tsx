import type { YoyoEngine } from '../app/YoyoEngine';
import { YOYO_COLORS } from '../render/YoyoRenderer';

/** Colour of the yoyo: one radio of seven. Ephemeral, like everything else the person chooses here. */
function Swatches({ engine, color }: { engine: YoyoEngine; color: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color del yoyó">
      {YOYO_COLORS.map(c => (
        <button
          key={c.value}
          role="radio"
          aria-checked={color === c.value}
          aria-label={c.name}
          title={c.name}
          className="swatch"
          style={{ background: c.value }}
          onClick={() => engine.setColor(c.value)}
        />
      ))}
    </div>
  );
}

/** The footer's always-visible part: colours and the way to the rest. */
export function Dock({ engine, color, open, onToggle }: { engine: YoyoEngine; color: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="dock">
      <Swatches engine={engine} color={color} />
      <button aria-expanded={open} aria-controls="settings-panel" onClick={onToggle}>Ajustes</button>
    </div>
  );
}
