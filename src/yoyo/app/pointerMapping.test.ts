import { describe, expect, it } from 'vitest';
import type { WorldRect } from '../contracts';
import { toImage, toWorld } from '../perception/worldMapping';
import { computeFraming } from '../render/framing';
import { POINTER_DIRECT, POINTER_GAIN, POINTER_HOME_FROM_TOP, PointerMappingTracker, pointerFeel, pointerMapping } from './pointerMapping';

/** A canvas placed away from the page origin, as in a real layout. */
interface Canvas { left: number; top: number; width: number; height: number }

/** The world point the renderer draws at a client position: the same fraction of the visible rectangle. */
function worldUnder(canvas: Canvas, view: WorldRect, clientX: number, clientY: number): [number, number] {
  const u = (clientX - canvas.left) / canvas.width;
  const v = (clientY - canvas.top) / canvas.height;
  return [view.left + u * (view.right - view.left), view.top - v * (view.top - view.bottom)];
}

/** What MouseDriver hands the runtime for a pointer position: canvas heights from the canvas's top-left. */
const driverImage = (canvas: Canvas, clientX: number, clientY: number): [number, number] =>
  [(clientX - canvas.left) / canvas.height, (clientY - canvas.top) / canvas.height];

/** The rectangle the renderer shows for a canvas of this size: its own framing, so the fixtures follow it when it moves. */
const viewOf = (canvas: Canvas): WorldRect => computeFraming(canvas.width / canvas.height).rect;
const heightOf = (view: WorldRect): number => view.top - view.bottom;

const LANDSCAPE: Canvas = { left: 0, top: 0, width: 1280, height: 800 };
const LANDSCAPE_VIEW = viewOf(LANDSCAPE);
const PORTRAIT: Canvas = { left: 0, top: 0, width: 390, height: 844 };
const PORTRAIT_VIEW = viewOf(PORTRAIT);
const OFFSET: Canvas = { left: 120, top: 64, width: 900, height: 500 };
const OFFSET_VIEW = viewOf(OFFSET);

describe('pointerMapping', () => {
  it('uses the visible height as the scale and the canvas centre as the home', () => {
    const m = pointerMapping(LANDSCAPE_VIEW, 1280, 800)!;
    expect(m.scale).toBeCloseTo(heightOf(LANDSCAPE_VIEW), 12);
    expect(m.homeImage[0]).toBeCloseTo(0.8, 12);
    expect(m.homeImage[1]).toBe(0.5);
    expect(m.homeWorld[0]).toBeCloseTo(0, 12);
    expect(m.homeWorld[1]).toBeCloseTo((LANDSCAPE_VIEW.top + LANDSCAPE_VIEW.bottom) / 2, 12);
  });

  it.each([
    ['landscape', LANDSCAPE, LANDSCAPE_VIEW],
    ['portrait', PORTRAIT, PORTRAIT_VIEW],
    ['canvas away from the origin', OFFSET, OFFSET_VIEW],
  ])('puts the pivot under the cursor everywhere: %s', (_name, canvas, view) => {
    const m = pointerMapping(view, canvas.width, canvas.height)!;
    for (const [fx, fy] of [[0, 0], [1, 1], [0.5, 0.5], [0.13, 0.82], [0.9, 0.07], [0.5, 0.25]]) {
      const clientX = canvas.left + fx * canvas.width;
      const clientY = canvas.top + fy * canvas.height;
      const [ix, iy] = driverImage(canvas, clientX, clientY);
      const pivot = toWorld(m, ix, iy);
      const expected = worldUnder(canvas, view, clientX, clientY);
      expect(pivot[0]).toBeCloseTo(expected[0], 9);
      expect(pivot[1]).toBeCloseTo(expected[1], 9);
    }
  });

  it('maps the canvas corners onto the visible rectangle corners', () => {
    const m = pointerMapping(LANDSCAPE_VIEW, 1280, 800)!;
    const topLeft = toWorld(m, 0, 0);
    const bottomRight = toWorld(m, 1280 / 800, 1);
    expect(topLeft[0]).toBeCloseTo(LANDSCAPE_VIEW.left, 12);
    expect(topLeft[1]).toBeCloseTo(LANDSCAPE_VIEW.top, 12);
    expect(bottomRight[0]).toBeCloseTo(LANDSCAPE_VIEW.right, 12);
    expect(bottomRight[1]).toBeCloseTo(LANDSCAPE_VIEW.bottom, 12);
  });

  it('keeps cursor speed and pivot speed in the visible proportion (1 canvas height = the visible height)', () => {
    const m = pointerMapping(LANDSCAPE_VIEW, 1280, 800)!;
    // 250 px down in a 800 px tall canvas is 0.3125 canvas heights, that much of the view's height.
    const a = toWorld(m, 0.8, 0.3);
    const b = toWorld(m, 0.8, 0.3 + 250 / 800);
    expect(a[1] - b[1]).toBeCloseTo((250 / 800) * heightOf(LANDSCAPE_VIEW), 12);
    expect(a[0]).toBeCloseTo(b[0], 12);
  });

  it('is inverted exactly by toImage', () => {
    const m = pointerMapping(PORTRAIT_VIEW, 390, 844)!;
    const w = toWorld(m, 0.31, 0.77);
    const img = toImage(m, w[0], w[1]);
    expect(img[0]).toBeCloseTo(0.31, 12);
    expect(img[1]).toBeCloseTo(0.77, 12);
  });

  it('is null until the canvas has a size or the view is real', () => {
    expect(pointerMapping(LANDSCAPE_VIEW, 0, 800)).toBeNull();
    expect(pointerMapping(LANDSCAPE_VIEW, 1280, 0)).toBeNull();
    expect(pointerMapping({ left: 0, right: 0, bottom: 1, top: 1 }, 1280, 800)).toBeNull();
    expect(pointerMapping({ left: Number.NaN, right: 1, bottom: 0, top: 1 }, 1280, 800)).toBeNull();
    expect(pointerMapping({ left: -1, right: 1, bottom: 2, top: 1 }, 1280, 800)).toBeNull();
  });
});

/** What the engine asks for: homed at the press, high on the screen, with a gain below one. */
const tuned = (view: WorldRect, canvas: Canvas, press: [number, number]) =>
  pointerMapping(view, canvas.width, canvas.height, { press, gain: POINTER_GAIN, homeFromTop: POINTER_HOME_FROM_TOP })!;

/** Canvas heights from the canvas's top-left, the space MouseDriver reports in. */
const imageAt = (canvas: Canvas, px: number, py: number): [number, number] => [px / canvas.height, py / canvas.height];

describe('pointerMapping as the engine uses it (homed at the press, with a gain)', () => {
  it('ties the yoyo on at the same world place wherever the button goes down', () => {
    for (const [canvas, view] of [[LANDSCAPE, LANDSCAPE_VIEW], [PORTRAIT, PORTRAIT_VIEW]] as const) {
      const homes = [[40, 40], [canvas.width / 2, canvas.height / 2], [canvas.width - 20, canvas.height - 20]].map(([px, py]) => {
        const press = imageAt(canvas, px, py);
        return toWorld(tuned(view, canvas, press), press[0], press[1]);
      });
      for (const home of homes) {
        expect(home[0]).toBeCloseTo((view.left + view.right) / 2, 12);
        expect(home[1]).toBeCloseTo(view.top - POINTER_HOME_FROM_TOP * (view.top - view.bottom), 12);
      }
    }
  });

  it('keeps the home in the upper part of the screen, clear of the top edge', () => {
    expect(POINTER_HOME_FROM_TOP).toBeGreaterThan(0.1);
    expect(POINTER_HOME_FROM_TOP).toBeLessThan(0.3);
  });

  it('moves the pivot by the gain times the visible distance the cursor crosses', () => {
    const press = imageAt(LANDSCAPE, 300, 500);
    const m = tuned(LANDSCAPE_VIEW, LANDSCAPE, press);
    const home = toWorld(m, press[0], press[1]);
    const moved = toWorld(m, press[0] + 200 / 800, press[1] - 150 / 800);
    // 200 px right and 150 px up are that share of the visible width and height, times the gain.
    expect(moved[0] - home[0]).toBeCloseTo(POINTER_GAIN * (200 / 1280) * (LANDSCAPE_VIEW.right - LANDSCAPE_VIEW.left), 12);
    expect(moved[1] - home[1]).toBeCloseTo(POINTER_GAIN * (150 / 800) * heightOf(LANDSCAPE_VIEW), 12);
  });

  it('keeps a sleeping yoyo on screen after a launch drag, wherever the person pressed (the point of homing)', () => {
    const LENGTH = 0.65;
    const RADIUS = 0.052; // drawn radius of the yoyo, m
    for (const [canvas, view] of [[LANDSCAPE, LANDSCAPE_VIEW], [PORTRAIT, PORTRAIT_VIEW]] as const) {
      for (const pressY of [0.05, 0.3, 0.6, 0.95]) {
        const press = imageAt(canvas, canvas.width / 2, pressY * canvas.height);
        const m = tuned(view, canvas, press);
        const home = toWorld(m, press[0], press[1]);
        // A launch drag of 270 px on the 800 px canvas: 0.3375 canvas heights, scaled to this canvas.
        const drag = 0.3375;
        const after = toWorld(m, press[0], press[1] + drag);
        const sleeperY = after[1] - LENGTH;
        expect(home[1]).toBeGreaterThan(sleeperY);
        expect(sleeperY - RADIUS, `press at ${pressY} of ${canvas.height} px`).toBeGreaterThan(view.bottom);
      }
    }
  });

  it('is exactly why the direct mapping is not used: from the middle of the screen the same drag loses the yoyo', () => {
    const press = imageAt(LANDSCAPE, 640, 400);
    const m = pointerMapping(LANDSCAPE_VIEW, 1280, 800)!; // defaults: pivot under the cursor
    const after = toWorld(m, press[0], press[1] + 0.3375);
    expect(after[1] - 0.65 - 0.052).toBeLessThan(LANDSCAPE_VIEW.bottom);
  });

  it('ships with the homed feel; the direct mapping is one switch away', () => {
    expect(POINTER_DIRECT).toBe(false);
    expect(pointerFeel([0.3, 0.2])).toEqual({ press: [0.3, 0.2], gain: POINTER_GAIN, homeFromTop: POINTER_HOME_FROM_TOP });
    expect(pointerFeel(undefined)).toEqual({ press: undefined, gain: POINTER_GAIN, homeFromTop: POINTER_HOME_FROM_TOP });
    // Direct: no options at all, so pointerMapping falls back to the pivot-under-the-cursor defaults.
    expect(pointerFeel([0.3, 0.2], true)).toEqual({});
    const direct = pointerMapping(LANDSCAPE_VIEW, 1280, 800, pointerFeel([0.3, 0.2], true))!;
    expect(direct).toEqual(pointerMapping(LANDSCAPE_VIEW, 1280, 800)!);
  });

  it('rejects options that cannot make a mapping', () => {
    expect(pointerMapping(LANDSCAPE_VIEW, 1280, 800, { gain: 0 })).toBeNull();
    expect(pointerMapping(LANDSCAPE_VIEW, 1280, 800, { gain: -1 })).toBeNull();
    expect(pointerMapping(LANDSCAPE_VIEW, 1280, 800, { gain: Number.NaN })).toBeNull();
    expect(pointerMapping(LANDSCAPE_VIEW, 1280, 800, { homeFromTop: Number.NaN })).toBeNull();
    expect(pointerMapping(LANDSCAPE_VIEW, 1280, 800, { press: [Number.NaN, 0.5] })).toBeNull();
  });
});

describe('PointerMappingTracker', () => {
  it('hands the mapping out once and stays quiet while nothing changes', () => {
    const t = new PointerMappingTracker();
    const first = t.update(LANDSCAPE_VIEW, 1280, 800);
    expect(first).not.toBeNull();
    for (let i = 0; i < 100; i++) expect(t.update(LANDSCAPE_VIEW, 1280, 800)).toBeNull();
  });

  it('hands out a new one when the canvas or the view changes', () => {
    const t = new PointerMappingTracker();
    t.update(LANDSCAPE_VIEW, 1280, 800);
    const resized = t.update(PORTRAIT_VIEW, 390, 844);
    expect(resized).not.toBeNull();
    expect(resized!.scale).toBeCloseTo(PORTRAIT_VIEW.top - PORTRAIT_VIEW.bottom, 12);
    // Same view, different aspect: only the home in canvas heights moves.
    const wider = t.update(PORTRAIT_VIEW, 600, 844);
    expect(wider).not.toBeNull();
    expect(wider!.homeImage[0]).toBeCloseTo(600 / 844 / 2, 12);
  });

  it('hands out a new mapping at every press that homes somewhere else, and not for the same press again', () => {
    const t = new PointerMappingTracker();
    const options = { gain: POINTER_GAIN, homeFromTop: POINTER_HOME_FROM_TOP };
    expect(t.update(LANDSCAPE_VIEW, 1280, 800, options)).not.toBeNull();
    const first = t.update(LANDSCAPE_VIEW, 1280, 800, { ...options, press: [0.3, 0.6] });
    expect(first).not.toBeNull();
    expect(first!.homeImage).toEqual([0.3, 0.6]);
    expect(t.update(LANDSCAPE_VIEW, 1280, 800, { ...options, press: [0.3, 0.6] })).toBeNull();
    expect(t.update(LANDSCAPE_VIEW, 1280, 800, { ...options, press: [0.9, 0.2] })).not.toBeNull();
  });

  it('keeps quiet on a canvas without size and offers the mapping again after a reset', () => {
    const t = new PointerMappingTracker();
    expect(t.update(LANDSCAPE_VIEW, 0, 0)).toBeNull();
    t.update(LANDSCAPE_VIEW, 1280, 800);
    expect(t.update(LANDSCAPE_VIEW, 0, 0)).toBeNull();
    expect(t.update(LANDSCAPE_VIEW, 1280, 800)).toBeNull();
    t.reset();
    expect(t.update(LANDSCAPE_VIEW, 1280, 800)).not.toBeNull();
  });
});
