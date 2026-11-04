import type { EngineState } from '../app/engineState';
import { edgeTip, pillText, showsTracking, TRACKING_LABELS } from './status';

/**
 * The one live region of the page: short text for whatever the yoyo is doing. It stays in the DOM (empty and
 * hidden when there is nothing to say) so screen readers announce its changes instead of its insertion.
 */
export function StatusPill({ state }: { state: EngineState }) {
  const text = pillText(state);
  return <p className="pill" role="status" hidden={text === ''}>{text}</p>;
}

/** Small dot: green while the hand's data is fresh, amber just after it was lost, grey without a hand. */
export function TrackingDot({ state }: { state: EngineState }) {
  if (!showsTracking(state)) return null;
  const label = TRACKING_LABELS[state.tracking];
  return <span className="tracking" data-quality={state.tracking} role="img" aria-label={label} title={label} />;
}

/**
 * What to do about the hand touching a border of the camera frame. The vignette itself is CSS on the root's
 * `data-edge`; this is its sentence. Not a `role="status"`: the pill is the only one, and two would make
 * «the status» ambiguous for assistive tech and for tests.
 */
export function EdgeTip({ state }: { state: EngineState }) {
  const tip = edgeTip(state.edge);
  return <p className="tip" aria-live="polite" hidden={tip === ''}>{tip}</p>;
}
