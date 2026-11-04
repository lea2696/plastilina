import { describe, expect, it } from 'vitest';
import { STRING_POINTS, STRING_RADIUS, STRING_SIDES, StringTube } from './stringTube';

function straightPath(tube: StringTube, ax: number, ay: number, bx: number, by: number): void {
  for (let i = 0; i < STRING_POINTS; i++) {
    const t = i / (STRING_POINTS - 1);
    tube.path[2 * i] = ax + (bx - ax) * t;
    tube.path[2 * i + 1] = ay + (by - ay) * t;
  }
}

describe('StringTube', () => {
  it('has a fixed vertex and index count and a visual radius that is at least 1.5 px at 1080p', () => {
    const tube = new StringTube();
    const position = tube.geometry.getAttribute('position');
    expect(position.count).toBe(STRING_POINTS * STRING_SIDES);
    expect(tube.geometry.getIndex()!.count).toBe((STRING_POINTS - 1) * STRING_SIDES * 6);
    // 1080 px for the 1.2 m the base framing shows: pixels per metre, then radius in pixels.
    const pxPerMetre = 1080 / 1.2;
    expect(STRING_RADIUS * pxPerMetre).toBeGreaterThanOrEqual(1.5);
    expect(STRING_RADIUS).toBeGreaterThanOrEqual(0.002);
    expect(STRING_RADIUS).toBeLessThanOrEqual(0.003);
  });

  it('wraps every path point in a circle of the tube radius perpendicular to the string', () => {
    const tube = new StringTube(0.0025);
    straightPath(tube, 0, 0.85, 0.2, 0.2);
    expect(tube.update()).toBe(true);
    const position = tube.geometry.getAttribute('position');
    const dirX = 0.2 / Math.hypot(0.2, 0.65);
    const dirY = -0.65 / Math.hypot(0.2, 0.65);
    for (let i = 0; i < STRING_POINTS; i++) {
      for (let s = 0; s < STRING_SIDES; s++) {
        const v = i * STRING_SIDES + s;
        const rx = position.getX(v) - tube.path[2 * i];
        const ry = position.getY(v) - tube.path[2 * i + 1];
        const rz = position.getZ(v);
        expect(Math.hypot(rx, ry, rz)).toBeCloseTo(0.0025, 6);
        // Perpendicular to the string direction.
        expect(rx * dirX + ry * dirY).toBeCloseTo(0, 6);
      }
    }
  });

  it('has unit normals that point outward from the centre line', () => {
    const tube = new StringTube();
    straightPath(tube, -0.1, 0.9, 0.1, 0.3);
    tube.update();
    const position = tube.geometry.getAttribute('position');
    const normal = tube.geometry.getAttribute('normal');
    for (let i = 0; i < STRING_POINTS; i++) {
      for (let s = 0; s < STRING_SIDES; s++) {
        const v = i * STRING_SIDES + s;
        expect(Math.hypot(normal.getX(v), normal.getY(v), normal.getZ(v))).toBeCloseTo(1, 5);
        const outX = position.getX(v) - tube.path[2 * i];
        const outY = position.getY(v) - tube.path[2 * i + 1];
        const outZ = position.getZ(v);
        expect(normal.getX(v) * outX + normal.getY(v) * outY + normal.getZ(v) * outZ).toBeGreaterThan(0);
      }
    }
  });

  it('winds its triangles outward (faces point away from the centre line)', () => {
    const tube = new StringTube();
    // A curved path, so the check covers more than a straight tube.
    for (let i = 0; i < STRING_POINTS; i++) {
      const t = i / (STRING_POINTS - 1);
      tube.path[2 * i] = 0.2 * Math.sin(t * 3);
      tube.path[2 * i + 1] = 0.8 - 0.5 * t;
    }
    tube.update();
    const position = tube.geometry.getAttribute('position');
    const index = tube.geometry.getIndex()!;
    let outward = 0;
    let total = 0;
    for (let k = 0; k < index.count; k += 3) {
      const [a, b, c] = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
      const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
      const ux = position.getX(b) - ax, uy = position.getY(b) - ay, uz = position.getZ(b) - az;
      const vx = position.getX(c) - ax, vy = position.getY(c) - ay, vz = position.getZ(c) - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      // Centre line point of this ring.
      const ring = Math.floor(a / STRING_SIDES);
      const ox = ax - tube.path[2 * ring];
      const oy = ay - tube.path[2 * ring + 1];
      total++;
      if (nx * ox + ny * oy + nz * az > 0) outward++;
    }
    expect(outward).toBe(total);
  });

  it('is finite for a degenerate path (all points equal) and keeps a direction', () => {
    const tube = new StringTube();
    for (let i = 0; i < STRING_POINTS; i++) {
      tube.path[2 * i] = 0.3;
      tube.path[2 * i + 1] = 0.5;
    }
    expect(tube.update()).toBe(true);
    const position = tube.geometry.getAttribute('position');
    const normal = tube.geometry.getAttribute('normal');
    for (let v = 0; v < position.count; v++) {
      expect(Number.isFinite(position.getX(v) + position.getY(v) + position.getZ(v))).toBe(true);
      expect(Number.isFinite(normal.getX(v) + normal.getY(v) + normal.getZ(v))).toBe(true);
    }
  });

  it('refuses a non-finite path and keeps the previous tube', () => {
    const tube = new StringTube();
    straightPath(tube, 0, 0.85, 0, 0.2);
    tube.update();
    const before = Array.from(tube.geometry.getAttribute('position').array);
    tube.path[10] = Number.NaN;
    expect(tube.update()).toBe(false);
    expect(Array.from(tube.geometry.getAttribute('position').array)).toEqual(before);
    tube.path[10] = Number.POSITIVE_INFINITY;
    expect(tube.update()).toBe(false);
  });

  it('rewrites its buffers in place (no per-frame allocation of attributes)', () => {
    const tube = new StringTube();
    const position = tube.geometry.getAttribute('position');
    const arrayBefore = position.array;
    straightPath(tube, 0, 0.85, 0.1, 0.3);
    tube.update();
    straightPath(tube, 0.2, 0.9, 0.0, 0.2);
    tube.update();
    expect(tube.geometry.getAttribute('position')).toBe(position);
    expect(tube.geometry.getAttribute('position').array).toBe(arrayBefore);
  });

  it('dispose releases the geometry without throwing', () => {
    const tube = new StringTube();
    expect(() => tube.dispose()).not.toThrow();
  });
});
