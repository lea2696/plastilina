import type { Vec2, WorldMapping, WorldRect } from '../contracts';

/** What shapes the mapping; see `pointerMapping`. */
export interface PointerMappingOptions {
  press?: Vec2;
  gain?: number;
  homeFromTop?: number;
}

/**
 * Pivot travel per unit of cursor travel. 0.45: a 270 px launch drag on an 800 px canvas moves the pivot ~0.2 m,
 * so the sleeper (0.65 m long) ends ~0.2 m above the floor, with room to spare for a drag of 400 px, when the
 * home is where the next constant puts it.
 */
export const POINTER_GAIN = 0.45;

/** Where the yoyo ties on, as a share of the visible height from the top: high, so a full sleeper fits underneath. */
export const POINTER_HOME_FROM_TOP = 0.15;

/**
 * `false`: the mouse is homed at the press, high on the screen, with a gain below one (the feel the page ships
 * with). `true`: the direct mapping, pivot under the cursor everywhere; the yoyo then leaves the screen as soon as
 * the person presses below the top fifth (see `pointerMapping`).
 */
export const POINTER_DIRECT = false;

/** The options the engine hands to `pointerMapping` for a press at `press` (canvas heights). */
export function pointerFeel(press: Vec2 | undefined, direct: boolean = POINTER_DIRECT): PointerMappingOptions {
  return direct ? {} : { press, gain: POINTER_GAIN, homeFromTop: POINTER_HOME_FROM_TOP };
}

/**
 * Mouse path: how viewport heights map to world metres (the mouse's «image» is the canvas, measured in canvas
 * heights from its top-left corner; see MouseDriver). Built from what the renderer actually shows.
 *
 * With the defaults it is the direct mapping: the canvas centre is the centre of the visible rectangle and one
 * canvas height spans exactly the rectangle's height, so the pivot is under the cursor everywhere (a point at
 * fraction (u, v) of the canvas is the world point at the same fraction of the rectangle).
 *
 * The engine does not use the defaults, because the direct mapping cannot keep the yoyo on screen. A sleeper
 * hangs 0.65 m under the pivot (half of the 1.3 m the screen shows) and the launch drag itself carries the
 * pivot down with the cursor (270 px is 0.44 m): from anywhere but the top fifth of the screen the yoyo sleeps
 * below the visible floor, and a first-time visitor sees the string leave the screen with nothing on it. So the
 * engine asks for the three knobs below (see POINTER_GAIN, POINTER_HOME_FROM_TOP):
 *
 * - `press`: where the button went down, canvas heights. It becomes the mapping's home image, so wherever the
 *   person presses, the yoyo ties on at the same place and the pivot starts from there. A new press homes again.
 * - `homeFromTop`: where that home sits in the visible rectangle, as a share of its height from the top
 *   (0.5 = the middle). It is horizontally centred.
 * - `gain`: metres the pivot moves per metre of visible rectangle the cursor crosses. Below 1 the pivot moves
 *   less than the cursor, like a wrist snap next to an arm swing.
 *
 * The engine also homes again at every catch (YoyoEngine.rehomePointer): a drag down is longer than the tug up, so
 * without it each round would leave the pivot lower and the sleepers would creep off the bottom of the screen.
 *
 * Null when the canvas has no size or the rectangle is degenerate (before the first layout), so the caller keeps
 * the mapping it had instead of installing a NaN one.
 */
export function pointerMapping(
  view: WorldRect,
  canvasWidth: number,
  canvasHeight: number,
  options: PointerMappingOptions = {},
): WorldMapping | null {
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) return null;
  const height = view.top - view.bottom;
  if (!Number.isFinite(height + view.left + view.right) || !(height > 0)) return null;
  const gain = options.gain ?? 1;
  const homeFromTop = options.homeFromTop ?? 0.5;
  if (!Number.isFinite(gain) || gain <= 0 || !Number.isFinite(homeFromTop)) return null;
  const press = options.press ?? [canvasWidth / canvasHeight / 2, 0.5];
  if (!Number.isFinite(press[0] + press[1])) return null;
  return {
    scale: gain * height,
    homeImage: [press[0], press[1]],
    homeWorld: [(view.left + view.right) / 2, view.top - homeFromTop * height],
  };
}

const sameMapping = (a: WorldMapping, b: WorldMapping): boolean =>
  a.scale === b.scale
  && a.homeImage[0] === b.homeImage[0] && a.homeImage[1] === b.homeImage[1]
  && a.homeWorld[0] === b.homeWorld[0] && a.homeWorld[1] === b.homeWorld[1];

/**
 * Hands out the pointer mapping only when it changed (window resized, a new press). The engine asks every frame;
 * a new object only appears when the world moved under the cursor, which is also exactly when the runtime's
 * pivot has to re-acquire.
 */
export class PointerMappingTracker {
  private last: WorldMapping | null = null;

  /** The new mapping, or null when it is the same as the last one handed out (or cannot be built yet). */
  update(view: WorldRect, canvasWidth: number, canvasHeight: number, options: PointerMappingOptions = {}): WorldMapping | null {
    const next = pointerMapping(view, canvasWidth, canvasHeight, options);
    if (next === null || (this.last !== null && sameMapping(this.last, next))) return null;
    this.last = next;
    return next;
  }

  /** The next `update` hands the mapping out again, e.g. to a runtime that was just created. */
  reset(): void {
    this.last = null;
  }
}
