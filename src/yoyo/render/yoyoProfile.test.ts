import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FRONT_HALF, PROFILE_HALF_WIDTH, buildYoyoProfile, createYoyoGeometry, roundedPolyline } from './yoyoProfile';

describe('roundedPolyline', () => {
  it('keeps the endpoints and rounds a right angle with an arc of the requested radius', () => {
    const pts = roundedPolyline(
      [{ r: 0, a: 0, fillet: 0 }, { r: 1, a: 0, fillet: 0.25 }, { r: 1, a: 1, fillet: 0 }],
      8,
    );
    expect(pts[0].toArray()).toEqual([0, 0]);
    expect(pts[pts.length - 1].toArray()).toEqual([1, 1]);
    // The arc is centred at (0.75, 0.25) with radius 0.25: every interior point lies on it.
    for (const p of pts.slice(1, -1)) expect(Math.hypot(p.x - 0.75, p.y - 0.25)).toBeCloseTo(0.25, 9);
    // And it starts and ends on the two segments.
    expect(pts[1].x).toBeCloseTo(0.75, 9);
    expect(pts[1].y).toBeCloseTo(0, 9);
    expect(pts[pts.length - 2].x).toBeCloseTo(1, 9);
    expect(pts[pts.length - 2].y).toBeCloseTo(0.25, 9);
  });

  it('emits a hard corner twice so the lathe keeps the crease', () => {
    const pts = roundedPolyline([{ r: 0, a: 0, fillet: 0 }, { r: 1, a: 0, fillet: 0 }, { r: 1, a: 1, fillet: 0 }], 8);
    expect(pts).toHaveLength(4);
    expect(pts[1].equals(pts[2])).toBe(true);
  });

  it('shrinks a fillet that does not fit instead of overlapping its neighbours', () => {
    const pts = roundedPolyline(
      [{ r: 0, a: 0, fillet: 0 }, { r: 0.2, a: 0, fillet: 5 }, { r: 0.2, a: 0.2, fillet: 0 }],
      8,
    );
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-12);
      expect(p.x).toBeLessThanOrEqual(0.2 + 1e-12);
      expect(p.y).toBeGreaterThanOrEqual(-1e-12);
      expect(p.y).toBeLessThanOrEqual(0.2 + 1e-12);
    }
  });

  it('survives straight corners, coincident corners and short lists', () => {
    expect(roundedPolyline([], 4)).toEqual([]);
    expect(roundedPolyline([{ r: 1, a: 2, fillet: 0 }], 4)).toHaveLength(1);
    const straight = roundedPolyline([{ r: 0, a: 0, fillet: 0 }, { r: 1, a: 0, fillet: 0.3 }, { r: 2, a: 0, fillet: 0 }], 4);
    expect(straight).toHaveLength(3);
    const same = roundedPolyline([{ r: 0, a: 0, fillet: 0 }, { r: 0, a: 0, fillet: 0.3 }, { r: 1, a: 1, fillet: 0 }], 4);
    expect(same.every((p) => Number.isFinite(p.x + p.y))).toBe(true);
  });
});

describe('buildYoyoProfile', () => {
  const profile = buildYoyoProfile();

  it('runs from the back hub to the front hub on the axis', () => {
    expect(profile[0].toArray()).toEqual([0, -PROFILE_HALF_WIDTH]);
    expect(profile[profile.length - 1].toArray()).toEqual([0, PROFILE_HALF_WIDTH]);
  });

  it('is finite, never crosses the axis, and its outermost radius is exactly the body radius (1)', () => {
    for (const p of profile) {
      expect(Number.isFinite(p.x + p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
    }
    expect(Math.max(...profile.map((p) => p.x))).toBeCloseTo(1, 12);
  });

  it('is mirror-symmetric about the mid-plane', () => {
    const key = (x: number, y: number) => `${x.toFixed(9)},${y.toFixed(9)}`;
    const set = new Set(profile.map((p) => key(p.x, p.y)));
    for (const p of profile) expect(set.has(key(p.x, -p.y))).toBe(true);
  });

  it('has a string gap: the two halves never touch except through the axle', () => {
    // On each side of the mid-plane the inner face stays at least the axle half-gap away from it.
    const front = profile.filter((p) => p.y > 0);
    expect(Math.min(...front.map((p) => p.y))).toBeGreaterThanOrEqual(0.12 - 1e-12);
    // And the gap widens toward the rim (a butterfly, not a straight-sided body).
    const inner = FRONT_HALF[1];
    expect(inner.a).toBeGreaterThan(FRONT_HALF[0].a * 2);
  });

  it('only contains zero-length segments at the intended creases', () => {
    let duplicates = 0;
    for (let i = 1; i < profile.length; i++) if (profile[i].distanceTo(profile[i - 1]) < 1e-12) duplicates++;
    // Four hard corners: the two axle shoulders (one per half), and nothing else interior.
    expect(duplicates).toBe(2);
  });
});

describe('createYoyoGeometry', () => {
  const geometry = createYoyoGeometry();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');

  it('has its axis along z and fits the unit radius', () => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.x).toBeCloseTo(1, 6);
    expect(box.min.x).toBeCloseTo(-1, 2);
    expect(box.max.y).toBeCloseTo(1, 2);
    expect(box.max.z).toBeCloseTo(PROFILE_HALF_WIDTH, 6);
    expect(box.min.z).toBeCloseTo(-PROFILE_HALF_WIDTH, 6);
  });

  it('has finite positions and unit, finite normals', () => {
    for (let i = 0; i < position.count; i++) {
      expect(Number.isFinite(position.getX(i) + position.getY(i) + position.getZ(i))).toBe(true);
      const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(len).toBeGreaterThan(0.999);
      expect(len).toBeLessThan(1.001);
    }
  });

  it('faces outward: front-face normals point at the viewer, rim normals point away from the axis', () => {
    let faceChecked = 0;
    let rimChecked = 0;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i));
      const z = position.getZ(i);
      if (z > 0.5 && r > 0.3 && r < 0.75) {
        expect(normal.getZ(i)).toBeGreaterThan(0.6);
        faceChecked++;
      }
      if (z < -0.5 && r > 0.3 && r < 0.75) {
        expect(normal.getZ(i)).toBeLessThan(-0.6);
      }
      if (r > 0.999 && Math.abs(z) < 0.6) {
        const radial = (position.getX(i) * normal.getX(i) + position.getY(i) * normal.getY(i)) / r;
        expect(radial).toBeGreaterThan(0.95);
        rimChecked++;
      }
    }
    expect(faceChecked).toBeGreaterThan(50);
    expect(rimChecked).toBeGreaterThan(50);
  });

  it('is a closed outward-wound surface: its signed volume is positive and plausible', () => {
    const index = geometry.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let volume = 0;
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(position, index.getX(i));
      b.fromBufferAttribute(position, index.getX(i + 1));
      c.fromBufferAttribute(position, index.getX(i + 2));
      volume += a.dot(b.clone().cross(c)) / 6;
    }
    // In R³: inside the full cylinder π·1²·1.52 ≈ 4.8, minus the V-shaped gap and the dishes.
    expect(volume).toBeGreaterThan(1.5);
    expect(volume).toBeLessThan(4.8);
  });

  it('stays light: one draw call worth of vertices', () => {
    expect(position.count).toBeLessThan(6000);
  });
});
