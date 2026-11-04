import * as THREE from 'three';

/**
 * Yoyo body, built from scratch (PRD §6): a surface of revolution of a modern butterfly profile, two
 * halves joined by an axle with a V-shaped string gap between them, rounded rims and a hub cap. The
 * profile is authored in units of the body radius R (R = 1) as a short list of corners, each with a
 * fillet radius, and rounded procedurally so the silhouette and the light on it come from one source.
 *
 * Axis along z after `createYoyoGeometry` (the face looks at the camera), +z toward the viewer.
 */

/** One corner of the profile: radius r from the axis, axial position a from the mid-plane, fillet radius. */
export interface ProfileCorner { r: number; a: number; fillet: number }

/** Half the body width at the hub cap, in R units (a real butterfly yoyo is ~0.78 R wide per half). */
export const PROFILE_HALF_WIDTH = 0.76;
/** Radius of the axle between the halves, and half the gap at the axle, R units. Room for the string. */
export const AXLE_RADIUS = 0.12;
export const AXLE_HALF_GAP = 0.12;

/**
 * Front half (a > 0), from the axle outward along the string-gap side, around the rim, and inward over the
 * outer face to the hub: V-shaped gap (0.12 → 0.38 at the rim), a rim 0.32 R thick, a rim land, a recessed
 * dish and a domed hub cap. Hard corners (fillet 0) are emitted twice so the lathe keeps them crisp.
 */
export const FRONT_HALF: readonly ProfileCorner[] = [
  { r: AXLE_RADIUS, a: AXLE_HALF_GAP, fillet: 0 },
  { r: 1.0, a: 0.38, fillet: 0.1 },
  { r: 1.0, a: 0.7, fillet: 0.14 },
  { r: 0.83, a: 0.7, fillet: 0.03 },
  { r: 0.8, a: 0.63, fillet: 0.04 },
  { r: 0.5, a: 0.56, fillet: 0.5 },
  { r: 0.26, a: 0.585, fillet: 0.05 },
  { r: 0.2, a: 0.64, fillet: 0.02 },
  { r: 0.17, a: 0.75, fillet: 0.03 },
  { r: 0, a: PROFILE_HALF_WIDTH, fillet: 0 },
];

/** Largest turn per arc segment, rad (18°): a 90° fillet gets 5 segments, a gentle one just 1 or 2. */
const MAX_ANGLE_STEP = Math.PI / 10;

/**
 * Rounds a polyline of corners with circular fillets. Each interior corner with fillet radius ρ becomes an
 * arc (at most `arcSteps` segments) tangent to both adjacent segments; the tangent length is limited to half of each adjacent segment so
 * neighbouring fillets never overlap, which shrinks ρ where the geometry is tight instead of failing.
 * A corner with ρ = 0 is emitted twice (a crease the lathe keeps sharp). Endpoints are kept as they are.
 */
export function roundedPolyline(corners: readonly ProfileCorner[], arcSteps: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const n = corners.length;
  if (n === 0) return out;
  out.push(new THREE.Vector2(corners[0].r, corners[0].a));
  if (n === 1) return out;
  for (let i = 1; i < n - 1; i++) {
    const prev = corners[i - 1];
    const cur = corners[i];
    const next = corners[i + 1];
    const ux = prev.r - cur.r;
    const uy = prev.a - cur.a;
    const wx = next.r - cur.r;
    const wy = next.a - cur.a;
    const ul = Math.hypot(ux, uy);
    const wl = Math.hypot(wx, wy);
    if (ul < 1e-12 || wl < 1e-12) {
      out.push(new THREE.Vector2(cur.r, cur.a));
      continue;
    }
    const u = new THREE.Vector2(ux / ul, uy / ul);
    const w = new THREE.Vector2(wx / wl, wy / wl);
    // Angle between the two segments at the corner, in (0, π); π means the corner is straight.
    const cosTheta = Math.min(1, Math.max(-1, u.dot(w)));
    const theta = Math.acos(cosTheta);
    const straight = Math.PI - theta < 1e-6;
    if (cur.fillet <= 0 || straight || theta < 1e-6) {
      out.push(new THREE.Vector2(cur.r, cur.a));
      if (cur.fillet <= 0 && !straight) out.push(new THREE.Vector2(cur.r, cur.a));
      continue;
    }
    const half = theta / 2;
    // Tangent length for a fillet of radius ρ is ρ / tan(θ/2); clamp it, and derive the radius it implies.
    const tangent = Math.min(cur.fillet / Math.tan(half), ul / 2, wl / 2);
    const radius = tangent * Math.tan(half);
    const bisector = u.clone().add(w).normalize();
    const centre = new THREE.Vector2(cur.r, cur.a).addScaledVector(bisector, radius / Math.sin(half));
    const start = new THREE.Vector2(cur.r, cur.a).addScaledVector(u, tangent);
    const end = new THREE.Vector2(cur.r, cur.a).addScaledVector(w, tangent);
    const a0 = Math.atan2(start.y - centre.y, start.x - centre.x);
    let a1 = Math.atan2(end.y - centre.y, end.x - centre.x);
    // Take the short way round (the fillet turns by π − θ).
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    a1 = a0 + delta;
    // Segments in proportion to the turn: sharp fillets get detail, near-straight ones do not pay for it.
    const steps = Math.min(arcSteps, Math.max(1, Math.ceil(Math.abs(delta) / MAX_ANGLE_STEP)));
    for (let s = 0; s <= steps; s++) {
      const ang = a0 + (a1 - a0) * (s / steps);
      out.push(new THREE.Vector2(centre.x + Math.cos(ang) * radius, centre.y + Math.sin(ang) * radius));
    }
  }
  out.push(new THREE.Vector2(corners[n - 1].r, corners[n - 1].a));
  return out;
}

/**
 * Full profile, back centre → back half → axle → front half → front centre. The back half mirrors the
 * front one (a → −a) in reverse order, which keeps the outward side of the curve on the same hand all the
 * way round as LatheGeometry expects (normal = (dy, −dx)).
 */
export function buildYoyoProfile(arcSteps = 5): THREE.Vector2[] {
  const back = FRONT_HALF.map((c): ProfileCorner => ({ r: c.r, a: -c.a, fillet: c.fillet })).reverse();
  return roundedPolyline([...back, ...FRONT_HALF], arcSteps);
}

/**
 * The yoyo body geometry for a unit radius (scale the mesh by the radius you want): axis along +z, the
 * half-width of the hub caps at ±PROFILE_HALF_WIDTH. One draw call, a few thousand vertices.
 */
export function createYoyoGeometry(radialSegments = 64, arcSteps = 5): THREE.BufferGeometry {
  const geometry = new THREE.LatheGeometry(buildYoyoProfile(arcSteps), radialSegments);
  // LatheGeometry revolves about Y with the profile's second coordinate along Y; turn Y into +z.
  geometry.rotateX(Math.PI / 2);
  geometry.computeBoundingSphere();
  return geometry;
}
