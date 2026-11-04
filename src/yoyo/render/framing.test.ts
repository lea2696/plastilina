import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_FOV_DEG, EXTRA_BELOW_SHARE, FRAME_BOTTOM, FRAME_HALF_WIDTH, FRAME_TOP, computeFraming, rectAtPlane,
} from './framing';

const ASPECTS: ReadonlyArray<readonly [string, number]> = [
  ['ultrawide 21:9', 21 / 9],
  ['16:9', 16 / 9],
  ['16:10 (the QA viewport 1280×800)', 1280 / 800],
  ['4:3', 4 / 3],
  ['square', 1],
  ['iPad portrait', 3 / 4],
  ['phone portrait 390×844', 390 / 844],
  ['very tall', 0.3],
];

/** Builds the three.js camera the renderer builds from a framing, to test the math against the library. */
function cameraFor(aspect: number): { camera: THREE.PerspectiveCamera; framing: ReturnType<typeof computeFraming> } {
  const framing = computeFraming(aspect);
  const camera = new THREE.PerspectiveCamera(framing.fovDeg, framing.aspect, 0.5, 20);
  camera.position.set(framing.centerX, framing.centerY, framing.distance);
  camera.lookAt(framing.centerX, framing.centerY, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return { camera, framing };
}

describe('computeFraming', () => {
  it.each(ASPECTS)('always shows the required world region (%s)', (_name, aspect) => {
    const { rect } = computeFraming(aspect);
    expect(rect.bottom).toBeLessThanOrEqual(-0.02);
    expect(rect.top).toBeGreaterThanOrEqual(1.12);
    // The PRD's width rule: x ∈ [−0.45, 0.45] stays visible on narrow screens (on wide ones it is a subset).
    expect(rect.left).toBeLessThanOrEqual(-FRAME_HALF_WIDTH + 1e-12);
    expect(rect.right).toBeGreaterThanOrEqual(FRAME_HALF_WIDTH - 1e-12);
  });

  it.each(ASPECTS)('rectangle has exactly the viewport aspect (%s)', (_name, aspect) => {
    const { rect } = computeFraming(aspect);
    expect((rect.right - rect.left) / (rect.top - rect.bottom)).toBeCloseTo(aspect, 12);
  });

  it.each(ASPECTS)('visible rectangle matches a real PerspectiveCamera: corners project to NDC ±1 (%s)', (_name, aspect) => {
    const { camera, framing } = cameraFor(aspect);
    const { rect } = framing;
    const corners: ReadonlyArray<readonly [number, number, number, number]> = [
      [rect.left, rect.bottom, -1, -1],
      [rect.right, rect.bottom, 1, -1],
      [rect.left, rect.top, -1, 1],
      [rect.right, rect.top, 1, 1],
    ];
    for (const [x, y, ndcX, ndcY] of corners) {
      const p = new THREE.Vector3(x, y, 0).project(camera);
      expect(p.x).toBeCloseTo(ndcX, 9);
      expect(p.y).toBeCloseTo(ndcY, 9);
    }
    // And the centre of the rectangle is the centre of the screen.
    const centre = new THREE.Vector3((rect.left + rect.right) / 2, (rect.bottom + rect.top) / 2, 0).project(camera);
    expect(centre.x).toBeCloseTo(0, 9);
    expect(centre.y).toBeCloseTo(0, 9);
  });

  it('the screen-to-world mapping the mouse uses is the exact inverse of the projection', () => {
    const { camera, framing } = cameraFor(1280 / 800);
    const { rect } = framing;
    for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.93, 0.07], [0.25, 0.8]] as const) {
      // u, v: pointer position as a fraction of the canvas, v measured from the top.
      const worldX = rect.left + u * (rect.right - rect.left);
      const worldY = rect.top - v * (rect.top - rect.bottom);
      const p = new THREE.Vector3(worldX, worldY, 0).project(camera);
      expect((p.x + 1) / 2).toBeCloseTo(u, 9);
      expect((1 - p.y) / 2).toBeCloseTo(v, 9);
    }
  });

  it('landscape is limited by height: the base region fills the viewport vertically', () => {
    const { rect, halfHeight } = computeFraming(16 / 9);
    expect(rect.bottom).toBeCloseTo(FRAME_BOTTOM, 12);
    expect(rect.top).toBeCloseTo(FRAME_TOP, 12);
    expect(halfHeight).toBeCloseTo((FRAME_TOP - FRAME_BOTTOM) / 2, 12);
  });

  it('portrait is limited by width and the surplus height is split with a small share below the floor', () => {
    const aspect = 390 / 844;
    const { rect } = computeFraming(aspect);
    expect(rect.right).toBeCloseTo(FRAME_HALF_WIDTH, 12);
    expect(rect.left).toBeCloseTo(-FRAME_HALF_WIDTH, 12);
    const surplus = rect.top - rect.bottom - (FRAME_TOP - FRAME_BOTTOM);
    expect(surplus).toBeGreaterThan(0);
    expect(FRAME_BOTTOM - rect.bottom).toBeCloseTo(surplus * EXTRA_BELOW_SHARE, 12);
    expect(rect.top - FRAME_TOP).toBeCloseTo(surplus * (1 - EXTRA_BELOW_SHARE), 12);
  });

  it('keeps the floor (y = 0) inside the frame at every aspect', () => {
    for (const [, aspect] of ASPECTS) {
      const { rect } = computeFraming(aspect);
      expect(rect.bottom).toBeLessThan(0);
      expect(rect.top).toBeGreaterThan(0);
    }
  });

  it('is finite for degenerate aspects (zero-size canvas)', () => {
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = computeFraming(aspect);
      expect(Number.isFinite(f.distance)).toBe(true);
      expect(Number.isFinite(f.rect.left + f.rect.right + f.rect.top + f.rect.bottom)).toBe(true);
      expect(f.rect.right).toBeGreaterThan(f.rect.left);
    }
  });

  it('uses a narrow lens', () => {
    expect(CAMERA_FOV_DEG).toBeGreaterThanOrEqual(28);
    expect(CAMERA_FOV_DEG).toBeLessThanOrEqual(32);
  });
});

describe('rectAtPlane', () => {
  it('follows a camera that moved (screen shake) and a plane that is not z = 0', () => {
    const base = rectAtPlane(0, 0.55, 2, 30, 1.5);
    const shaken = rectAtPlane(0.004, 0.55 - 0.003, 2, 30, 1.5);
    expect(shaken.left - base.left).toBeCloseTo(0.004, 12);
    expect(shaken.bottom - base.bottom).toBeCloseTo(-0.003, 12);
    // Same size: shaking translates, it does not zoom.
    expect(shaken.right - shaken.left).toBeCloseTo(base.right - base.left, 12);
    const farther = rectAtPlane(0, 0.55, 2, 30, 1.5, -1);
    expect(farther.top - farther.bottom).toBeGreaterThan(base.top - base.bottom);
  });
});
