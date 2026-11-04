import type { HandCollider, Vec3 } from '../shared/contracts';

export type PointerMode = 'grab' | 'press';
export interface Ray { origin: Vec3; direction: Vec3 }

const GRAB_RADIUS = 0.06;
const PRESS_RADIUS = 0.038;
/** A press sinks this far past the surface over PRESS_RAMP_MS while the button is held. */
const PRESS_DEPTH = 0.085;
const PRESS_RAMP_MS = 450;
const MAX_SPEED = 1.4;

interface PointerState { mode: PointerMode; ndc: [number, number]; surfaceDistance: number; extra: number; startMs: number; center?: Vec3; lastMs: number; velocity: Vec3 }

/**
 * Mouse/touch stand-in for a hand, for checking deformation without a camera.
 * It starts only where the cursor ray hits the clay (no remote attraction) and feeds the
 * same HandCollider path as tracked hands:
 *  - grab: a grip volume at the hit point that follows the cursor on a camera-facing plane;
 *  - press: a fingertip that sinks into the surface while held and smears it when dragged.
 * The wheel moves the tool along the view ray (pull out / push in).
 */
export class PointerTool {
  private state?: PointerState;

  get active() { return !!this.state; }
  get mode() { return this.state?.mode; }

  begin(mode: PointerMode, ndc: [number, number], surfaceDistance: number, nowMs: number) {
    this.state = { mode, ndc, surfaceDistance, extra: 0, startMs: nowMs, lastMs: nowMs, velocity: [0, 0, 0] };
  }

  move(ndc: [number, number]) { if (this.state) this.state.ndc = ndc; }

  wheel(deltaY: number) {
    if (!this.state) return;
    this.state.extra = Math.max(-0.25, Math.min(0.15, this.state.extra + deltaY * 0.0004));
  }

  end() { this.state = undefined; }

  collider(nowMs: number, cast: (ndc: [number, number]) => Ray): HandCollider | undefined {
    const s = this.state;
    if (!s) return;
    const { origin, direction } = cast(s.ndc);
    const press = s.mode === 'press';
    const sink = press ? PRESS_DEPTH * Math.min(1, (nowMs - s.startMs) / PRESS_RAMP_MS) - PRESS_RADIUS : 0;
    const along = s.surfaceDistance + sink + s.extra;
    const center: Vec3 = [origin[0] + direction[0] * along, Math.max(0.01, origin[1] + direction[1] * along), origin[2] + direction[2] * along];
    const dt = (nowMs - s.lastMs) / 1000;
    if (s.center && dt > 0) {
      const v = [0, 1, 2].map(j => (center[j] - s.center![j]) / dt);
      const scale = Math.min(1, MAX_SPEED / (Math.hypot(v[0], v[1], v[2]) || 1));
      // Light smoothing: mouse events are bursty compared with the 120 Hz solver.
      s.velocity = [0, 1, 2].map(j => s.velocity[j] * 0.5 + v[j] * scale * 0.5) as unknown as Vec3;
    }
    s.center = center;
    s.lastMs = nowMs;
    return press
      ? { id: 'pointer-press', kind: 'tip', center, radius: PRESS_RADIUS, velocity: s.velocity }
      : { id: 'pointer-grasp', kind: 'tip', center, radius: GRAB_RADIUS, velocity: s.velocity, grasp: true, gripStrength: 1 };
  }
}
