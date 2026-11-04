import type { YoyoConfig } from '../config';
import type { Vec2, WorldMapping } from '../contracts';

/**
 * Image space (ih) → world space (m).
 *
 * Image y grows DOWN and world y grows UP, so the vertical axis flips exactly once, here. The
 * calibrated «home» pins one image point to one world point; everything else is a uniform
 * scale around it. Keeping the mapping affine and tiny is deliberate: the classifiers work on
 * image samples, the physics on world samples, and a nonlinear map between them would make
 * «1 ih/s of hand = 1 m/s of pivot» (docs/yoyo/DECISIONS.md) stop being true.
 */

/** Builds the mapping that sends `homeImage` (the anchor when the yoyo ties on) to the world home. */
export function mappingFromHome(config: YoyoConfig, homeImage: Vec2): WorldMapping {
  const { scale, homeX, homeY } = config.world;
  // A zero or negative scale would collapse or mirror the world and make toImage divide by zero.
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError(`world.scale must be positive, got ${scale}`);
  return { scale, homeImage: [homeImage[0], homeImage[1]], homeWorld: [homeX, homeY] };
}

/**
 * World position of an image point. `out` lets per-frame callers reuse one tuple instead of
 * allocating a fresh one for every sample.
 */
export function toWorld(m: WorldMapping, x: number, y: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = m.homeWorld[0] + m.scale * (x - m.homeImage[0]);
  out[1] = m.homeWorld[1] - m.scale * (y - m.homeImage[1]);
  return out;
}

/** Exact inverse of `toWorld`: image position of a world point. */
export function toImage(m: WorldMapping, x: number, y: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = m.homeImage[0] + (x - m.homeWorld[0]) / m.scale;
  out[1] = m.homeImage[1] - (y - m.homeWorld[1]) / m.scale;
  return out;
}

/**
 * Maps a whole hand (21 mirrored landmarks) to world metres for the silhouette. Pass the array
 * returned by the previous call as `out` to reuse it; it is resized to match the input.
 */
export function landmarksToWorld(m: WorldMapping, landmarks: readonly Vec2[], out: [number, number][] = []): [number, number][] {
  out.length = landmarks.length;
  for (let i = 0; i < landmarks.length; i++) {
    out[i] = toWorld(m, landmarks[i][0], landmarks[i][1], out[i]);
  }
  return out;
}
