import { describe, expect, it } from 'vitest';
import { createConfig } from '../config';
import type { Vec2, WorldMapping } from '../contracts';
import { Random } from '../replay/random';
import { landmarksToWorld, mappingFromHome, toImage, toWorld } from './worldMapping';

const config = createConfig();
const home: Vec2 = [0.66, 0.4];

describe('worldMapping', () => {
  it('sends the calibrated home image point to the world home', () => {
    const m = mappingFromHome(config, home);
    const [x, y] = toWorld(m, home[0], home[1]);
    expect(x).toBeCloseTo(config.world.homeX, 12);
    expect(y).toBeCloseTo(config.world.homeY, 12);
  });

  it('flips only the vertical axis: image down is world down, image right is world right', () => {
    const m = mappingFromHome(config, home);
    const [x0, y0] = toWorld(m, home[0], home[1]);
    const [x1, y1] = toWorld(m, home[0] + 0.1, home[1] + 0.1);
    expect(x1 - x0).toBeCloseTo(0.1 * config.world.scale, 12);
    expect(y1 - y0).toBeCloseTo(-0.1 * config.world.scale, 12);
  });

  it('keeps 1 ih equal to 1 m at the default scale, so ih/s and m/s coincide', () => {
    expect(config.world.scale).toBe(1);
    const m = mappingFromHome(config, home);
    const a = toWorld(m, 0.2, 0.3);
    const b = toWorld(m, 0.2, 0.3 + 1);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(1, 12);
  });

  it('takes its scale and home from the config, including the seated preset gain', () => {
    const seated = createConfig('seated');
    const m = mappingFromHome(seated, home);
    expect(m.scale).toBeCloseTo(1 / 0.7, 12);
    expect(m.homeWorld).toEqual([seated.world.homeX, seated.world.homeY]);
    const [x, y] = toWorld(m, home[0] - 0.07, home[1] - 0.07);
    expect(x - seated.world.homeX).toBeCloseTo(-0.07 / 0.7, 12);
    expect(y - seated.world.homeY).toBeCloseTo(0.07 / 0.7, 12);
  });

  it('does not alias the home passed in', () => {
    const mutable: [number, number] = [0.5, 0.5];
    const m = mappingFromHome(config, mutable);
    mutable[0] = 99;
    expect(m.homeImage[0]).toBe(0.5);
  });

  it('round-trips random points through random mappings (image → world → image)', () => {
    const random = new Random(7);
    for (let i = 0; i < 2000; i++) {
      const c = createConfig();
      c.world.scale = random.range(0.6, 2);
      c.world.homeX = random.range(-0.5, 0.5);
      c.world.homeY = random.range(0.5, 1.2);
      const m = mappingFromHome(c, [random.range(0, 4 / 3), random.range(0, 1)]);
      const x = random.range(-0.2, 1.6);
      const y = random.range(-0.2, 1.2);
      const [wx, wy] = toWorld(m, x, y);
      const [ix, iy] = toImage(m, wx, wy);
      expect(ix).toBeCloseTo(x, 10);
      expect(iy).toBeCloseTo(y, 10);
      // And the other way around: world → image → world.
      const [bx, by] = toWorld(m, ...toImage(m, wx + 0.3, wy - 0.2));
      expect(bx).toBeCloseTo(wx + 0.3, 10);
      expect(by).toBeCloseTo(wy - 0.2, 10);
    }
  });

  it('reuses the tuple it is given instead of allocating', () => {
    const m = mappingFromHome(config, home);
    const out: [number, number] = [0, 0];
    expect(toWorld(m, 0.1, 0.2, out)).toBe(out);
    expect(toImage(m, 0.1, 0.2, out)).toBe(out);
  });

  it('maps all 21 landmarks with the same affine map, in order', () => {
    const m = mappingFromHome(config, home);
    const landmarks: Vec2[] = Array.from({ length: 21 }, (_, i) => [0.5 + 0.01 * i, 0.3 + 0.02 * i]);
    const world = landmarksToWorld(m, landmarks);
    expect(world).toHaveLength(21);
    landmarks.forEach((p, i) => expect(world[i]).toEqual(toWorld(m, p[0], p[1])));
  });

  it('refills a previous result in place and resizes it to the new input', () => {
    const m = mappingFromHome(config, home);
    const first = landmarksToWorld(m, [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]);
    const firstPoint = first[0];
    const second = landmarksToWorld(m, [[0.5, 0.5], [0.6, 0.6]], first);
    expect(second).toBe(first);
    expect(second).toHaveLength(2);
    expect(second[0]).toBe(firstPoint);
    expect(second[1]).toEqual(toWorld(m, 0.6, 0.6));
  });

  it('rejects a mapping that would collapse or mirror the world', () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = createConfig();
      c.world.scale = scale;
      expect(() => mappingFromHome(c, home)).toThrow(RangeError);
    }
  });

  it('is a pure function of its mapping: a hand-built mapping behaves the same as one from config', () => {
    const manual: WorldMapping = { scale: 2, homeImage: [1, 0.5], homeWorld: [0.1, 0.9] };
    expect(toWorld(manual, 1.25, 0.25)).toEqual([0.6, 1.4]);
    const [ix, iy] = toImage(manual, 0.6, 1.4);
    expect(ix).toBeCloseTo(1.25, 12);
    expect(iy).toBeCloseTo(0.25, 12);
  });
});
