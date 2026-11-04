import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '../config';
import { DEFAULT_YOYO_COLOR } from './palette';
import {
  WebGLUnavailableError, YOYO_COLORS, YOYO_PHYSICAL_RADIUS, YOYO_VISUAL_RADIUS, YOYO_VISUAL_SCALE, YoyoRenderer,
} from './YoyoRenderer';

/**
 * Node has no WebGL, so what can be tested here is what does not need a context: the failure path of the
 * constructor and the constants other modules depend on. Everything that draws is covered by the browser
 * fixture (scripts/yoyo-render-shots.ts), which is GPU headless and SYNTHETIC, not a real session.
 */

/** A canvas stand-in whose getContext returns whatever the test wants. */
function fakeCanvas(getContext: () => unknown): HTMLCanvasElement {
  return {
    getContext,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    clientWidth: 640,
    clientHeight: 400,
    width: 640,
    height: 400,
    style: {},
  } as unknown as HTMLCanvasElement;
}

describe('YoyoRenderer constructor without WebGL', () => {
  // three reports a failed context creation with console.error; that is expected here, not noise to keep.
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('throws a WebGLUnavailableError (an Error the page can recognise) when no context can be created', () => {
    const canvas = fakeCanvas(() => null);
    expect(() => new YoyoRenderer(canvas)).toThrow(WebGLUnavailableError);
    expect(() => new YoyoRenderer(canvas)).toThrow(Error);
  });

  it('the error says what is wrong in plain words and keeps the underlying cause', () => {
    let caught: unknown;
    try {
      new YoyoRenderer(fakeCanvas(() => null));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebGLUnavailableError);
    const error = caught as WebGLUnavailableError;
    expect(error.name).toBe('WebGLUnavailableError');
    expect(error.message).toMatch(/WebGL2/);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('also throws it when getContext itself throws (blocked or disabled GPU)', () => {
    const canvas = fakeCanvas(() => { throw new Error('GPU process crashed'); });
    expect(() => new YoyoRenderer(canvas)).toThrow(WebGLUnavailableError);
  });
});

describe('YOYO_COLORS', () => {
  it('offers 5 to 7 named colours, the first being the default', () => {
    expect(YOYO_COLORS.length).toBeGreaterThanOrEqual(5);
    expect(YOYO_COLORS.length).toBeLessThanOrEqual(7);
    expect(YOYO_COLORS[0].value).toBe(DEFAULT_YOYO_COLOR);
  });

  it('every colour has a distinct Spanish name and a valid #rrggbb value', () => {
    const names = new Set<string>();
    const values = new Set<string>();
    for (const { name, value } of YOYO_COLORS) {
      expect(name).toMatch(/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/);
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      names.add(name);
      values.add(value.toLowerCase());
    }
    expect(names.size).toBe(YOYO_COLORS.length);
    expect(values.size).toBe(YOYO_COLORS.length);
  });
});

describe('yoyo visual size', () => {
  it('is the physical radius times a named factor, and the physical radius is the model default', () => {
    expect(YOYO_VISUAL_RADIUS).toBeCloseTo(YOYO_PHYSICAL_RADIUS * YOYO_VISUAL_SCALE, 12);
    // Keeps the renderer's idea of the body in step with the model: if the default changes, this fails.
    expect(YOYO_PHYSICAL_RADIUS).toBe(createConfig().yoyo.bodyRadius);
  });

  it('is bigger than physical for legibility, but not a different object: under 2.2×', () => {
    expect(YOYO_VISUAL_SCALE).toBeGreaterThan(1);
    expect(YOYO_VISUAL_SCALE).toBeLessThan(2.2);
  });
});
