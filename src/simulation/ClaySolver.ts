import type { HandBasis, HandCollider, SurfaceState, Vec3 } from '../shared/contracts';

interface GripPatch { vertices: Array<{ index: number; offset: Vec3; weight: number }>; center: Vec3; basis?: HandBasis }

/** A solid collider that survived the broadphase, with the vertices and faces it may touch this step. */
interface SolidContact { collider: HandCollider; vertices: number[]; triangles: number[] }

const GRAVITY = 9.81;
const TABLE_Y = 0.003;
/** Per-step horizontal slide below which material resting on the table sticks to it. */
const TABLE_STICK = 0.0015;
const ITERATIONS = 10;
const MAX_SPEED = 2;
const BROADPHASE_MARGIN = 0.03;
/** A hand within this skin of the surface counts as touching (light friction, no push). */
const FRICTION_SKIN = 0.004;
/**
 * Coulomb friction (Barreiro, Torres & Otaduy 2021, sliding anchors): per step, the slip
 * between clay and hand that friction can cancel is μ × the normal push the hand applied,
 * so pressing harder drags more. A light touch inside the skin gets SKIN_GRIP of push.
 */
const FRICTION = 0.8;
const SKIN_GRIP = 0.0015;
/**
 * Velocity-based plasticity with hysteresis (same paper): an edge whose ends separate or
 * approach faster than FLOW_BREAK stops remembering its shape and flows; once slower than
 * FLOW_SET it re-bonds at its current length. Clay keeps whatever shape it is left in.
 */
const FLOW_BREAK = 0.15;
const FLOW_SET = 0.08;
/** Fraction of the velocity difference across each edge removed per pass: heavy, dense clay. */
const VISCOSITY = 0.12;
/** Rate (1/s, scaled by contact activity) at which a worked tet's rest volume follows its current volume. */
const TET_FLOW = 30;
const SELF_CONTACT_CELL = 0.065;
/** Fraction of plastic activity handed to each neighbouring ring. */
const SPREAD = 0.7;

// Scratch result for closestOnTriangle; avoids allocating in the inner contact loops.
const hit = { x: 0, y: 0, z: 0, u: 0, v: 0, w: 0 };

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). Writes into `hit`. */
function closestOnTriangle(p: Float32Array, a: number, b: number, c: number, px: number, py: number, pz: number) {
  const ax = p[a], ay = p[a + 1], az = p[a + 2];
  const abx = p[b] - ax, aby = p[b + 1] - ay, abz = p[b + 2] - az;
  const acx = p[c] - ax, acy = p[c + 1] - ay, acz = p[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const set = (u: number, v: number, w: number) => {
    hit.u = u; hit.v = v; hit.w = w;
    hit.x = ax + abx * v + acx * w; hit.y = ay + aby * v + acy * w; hit.z = az + abz * v + acz * w;
  };
  if (d1 <= 0 && d2 <= 0) return set(1, 0, 0);
  const bpx = px - p[b], bpy = py - p[b + 1], bpz = pz - p[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return set(1 - v, v, 0); }
  const cpx = px - p[c], cpy = py - p[c + 1], cpz = pz - p[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return set(1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return set(0, 1 - w, w); }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return set(1 - v - w, v, w);
}

/** Parameter of the point on segment a→a+s closest to q. */
function segmentParam(ax: number, ay: number, az: number, sx: number, sy: number, sz: number, qx: number, qy: number, qz: number) {
  const den = sx * sx + sy * sy + sz * sz;
  return den > 1e-10 ? Math.max(0, Math.min(1, ((qx - ax) * sx + (qy - ay) * sy + (qz - az) * sz) / den)) : 0;
}

/**
 * Closest pair between a collider core (point or segment) and triangle abc.
 * Alternating projection converges for convex pairs; three rounds are ample at hand scale.
 * Leaves the surface point in `hit` and returns the core point.
 */
function closestCoreToTriangle(p: Float32Array, a: number, b: number, c: number, collider: HandCollider, core: number[]) {
  const [cx, cy, cz] = collider.center;
  if (!collider.end) { closestOnTriangle(p, a, b, c, cx, cy, cz); core[0] = cx; core[1] = cy; core[2] = cz; return; }
  const sx = collider.end[0] - cx, sy = collider.end[1] - cy, sz = collider.end[2] - cz;
  let t = segmentParam(cx, cy, cz, sx, sy, sz, (p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3);
  for (let round = 0; round < 3; round++) {
    closestOnTriangle(p, a, b, c, cx + sx * t, cy + sy * t, cz + sz * t);
    t = segmentParam(cx, cy, cz, sx, sy, sz, hit.x, hit.y, hit.z);
  }
  core[0] = cx + sx * t; core[1] = cy + sy * t; core[2] = cz + sz * t;
  closestOnTriangle(p, a, b, c, core[0], core[1], core[2]);
}

/**
 * Volumetric XPBD clay: tetrahedral volume + edge constraints with local plastic
 * flow, a closed shell for volume measurement, and kinematic hand colliders that
 * touch both vertices and triangle faces. Does not solve arbitrary fold self-contact (AC-10).
 */
export class ClaySolver {
  readonly n: number;
  readonly radius = 0.18;
  readonly diameter = this.radius * 2;
  readonly positions: Float32Array;
  readonly previous: Float32Array;
  readonly velocity: Float32Array;
  readonly indices: Uint32Array;
  readonly restSurfaceVolume: number;
  readonly surfaceVertices: number[];
  readonly contactColliderIds = new Set<string>();
  readonly tetCount: number;
  /** Sum of tet rest volumes; plastic volume flow redistributes it but never changes it. */
  private readonly totalTetRest: number;
  readonly edgeCount: number;
  version = 0;
  contactCount = 0;
  selfContactCount = 0;

  private readonly tetIndex: Uint32Array;
  private readonly tetRest: Float32Array;
  private readonly tetLambda: Float32Array;
  private readonly edgeIndex: Uint32Array;
  private readonly edgeRest: Float32Array;
  private readonly edgeLambda: Float32Array;
  private readonly contactActivity: Float32Array;
  /** Activity from solid (pressing) contact this step; the source for spreadPressActivity. */
  private readonly pressSeed: Float32Array;
  /** Per-step contact accumulators for friction: normal push, touch weight, hand velocity and normal. */
  private readonly normalPush: Float32Array;
  private readonly touchWeight: Float32Array;
  private readonly touchVelocity: Float32Array;
  private readonly touchNormal: Float32Array;
  private readonly edgeFlowing: Uint8Array;
  private readonly volumeGradient: Float32Array;
  private readonly neighbours: ReadonlyArray<ReadonlySet<number>>;
  /** +1 when the shell winding points outward, -1 otherwise. */
  private readonly orientation: number;
  private readonly anchors = new Map<string, GripPatch>();
  private readonly core = [0, 0, 0];

  constructor(resolution = 6) {
    if (!Number.isInteger(resolution) || resolution < 3 || resolution > 10) throw new Error('Unsupported clay resolution');
    const n = this.n = resolution;
    const count = (n + 1) ** 3;
    this.positions = new Float32Array(count * 3);
    this.previous = new Float32Array(count * 3);
    this.velocity = new Float32Array(count * 3);
    this.contactActivity = new Float32Array(count);
    this.pressSeed = new Float32Array(count);
    this.normalPush = new Float32Array(count);
    this.touchWeight = new Float32Array(count);
    this.touchVelocity = new Float32Array(count * 3);
    this.touchNormal = new Float32Array(count * 3);
    this.volumeGradient = new Float32Array(count * 3);
    const idx = (x: number, y: number, z: number) => x + (n + 1) * (y + (n + 1) * z);

    for (let z = 0; z <= n; z++) for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
      const u = 2 * x / n - 1, v = 2 * y / n - 1, w = 2 * z / n - 1;
      // Rounded cube mapped continuously to a ball. Every boundary vertex lies on a closed shell.
      const px = u * Math.sqrt(Math.max(0, 1 - v * v / 2 - w * w / 2 + v * v * w * w / 3));
      const py = v * Math.sqrt(Math.max(0, 1 - u * u / 2 - w * w / 2 + u * u * w * w / 3));
      const pz = w * Math.sqrt(Math.max(0, 1 - u * u / 2 - v * v / 2 + u * u * v * v / 3));
      const i = idx(x, y, z) * 3;
      this.positions[i] = px * this.radius;
      this.positions[i + 1] = 0.205 + py * this.radius;
      this.positions[i + 2] = pz * this.radius;
    }
    this.previous.set(this.positions);

    const tets: number[] = [], tetRest: number[] = [], edges: number[] = [], edgeKeys = new Set<number>();
    const addTet = (a: number, b: number, c: number, d: number) => {
      let volume = this.signedTet(a, b, c, d);
      if (volume < 0) { [c, d] = [d, c]; volume = -volume; }
      tets.push(a, b, c, d); tetRest.push(volume);
      for (const [i, j] of [[a, b], [a, c], [a, d], [b, c], [b, d], [c, d]]) {
        const lo = Math.min(i, j), hi = Math.max(i, j), key = lo * count + hi;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key); edges.push(lo, hi);
      }
    };
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const a = idx(x, y, z), b = idx(x + 1, y, z), c = idx(x + 1, y + 1, z), d = idx(x, y + 1, z);
      const e = idx(x, y, z + 1), f = idx(x + 1, y, z + 1), g = idx(x + 1, y + 1, z + 1), h = idx(x, y + 1, z + 1);
      // Six tetrahedra around body diagonal a-g.
      addTet(a, b, c, g); addTet(a, c, d, g); addTet(a, d, h, g);
      addTet(a, h, e, g); addTet(a, e, f, g); addTet(a, f, b, g);
    }
    this.tetIndex = new Uint32Array(tets);
    this.tetRest = new Float32Array(tetRest);
    this.tetLambda = new Float32Array(tetRest.length);
    this.tetCount = tetRest.length;
    this.totalTetRest = tetRest.reduce((a, b) => a + b, 0);
    this.edgeIndex = new Uint32Array(edges);
    this.edgeCount = edges.length / 2;
    this.edgeRest = new Float32Array(this.edgeCount);
    this.edgeLambda = new Float32Array(this.edgeCount);
    this.edgeFlowing = new Uint8Array(this.edgeCount);
    for (let k = 0; k < this.edgeCount; k++) this.edgeRest[k] = this.distance(edges[2 * k], edges[2 * k + 1]);

    const triangles: number[] = [];
    const quad = (a: number, b: number, c: number, d: number) => triangles.push(a, b, c, a, c, d);
    for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
      quad(idx(0, y, z), idx(0, y, z + 1), idx(0, y + 1, z + 1), idx(0, y + 1, z));
      quad(idx(n, y, z), idx(n, y + 1, z), idx(n, y + 1, z + 1), idx(n, y, z + 1));
    }
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
      quad(idx(x, 0, z), idx(x + 1, 0, z), idx(x + 1, 0, z + 1), idx(x, 0, z + 1));
      quad(idx(x, n, z), idx(x, n, z + 1), idx(x + 1, n, z + 1), idx(x + 1, n, z));
    }
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
      quad(idx(x, y, 0), idx(x, y + 1, 0), idx(x + 1, y + 1, 0), idx(x + 1, y, 0));
      quad(idx(x, y, n), idx(x + 1, y, n), idx(x + 1, y + 1, n), idx(x, y + 1, n));
    }
    this.indices = new Uint32Array(triangles);
    const signedVolume = this.signedSurfaceVolume();
    this.orientation = Math.sign(signedVolume) || 1;
    this.restSurfaceVolume = signedVolume;
    this.surfaceVertices = [...new Set(triangles)];
    const neighbours = Array.from({ length: count }, () => new Set<number>());
    for (let k = 0; k < triangles.length; k += 3) {
      const a = triangles[k], b = triangles[k + 1], c = triangles[k + 2];
      for (const [i, j] of [[a, b], [a, c], [b, c]]) { neighbours[i].add(j); neighbours[j].add(i); }
    }
    this.neighbours = neighbours;
  }

  surface(): SurfaceState { return { positions: this.positions, indices: this.indices, version: this.version }; }
  hasGrasp(id: string) { return this.anchors.has(id); }
  get graspCount() { return this.anchors.size; }
  surfaceVolume(): number { return Math.abs(this.signedSurfaceVolume()); }
  minY() { let m = Infinity; for (let i = 1; i < this.positions.length; i += 3) m = Math.min(m, this.positions[i]); return m; }
  centerY() { let s = 0; for (let i = 1; i < this.positions.length; i += 3) s += this.positions[i]; return s / (this.positions.length / 3); }
  invertedTetCount() {
    let count = 0;
    for (let t = 0; t < this.tetCount; t++) if (this.tetVolume(t) <= 0) count++;
    return count;
  }

  private distance(a: number, b: number) {
    const p = this.positions, i = a * 3, j = b * 3;
    return Math.hypot(p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]);
  }

  private signedTet(a: number, b: number, c: number, d: number) {
    const p = this.positions, ia = a * 3, ib = b * 3, ic = c * 3, id = d * 3;
    const bx = p[ib] - p[ia], by = p[ib + 1] - p[ia + 1], bz = p[ib + 2] - p[ia + 2];
    const cx = p[ic] - p[ia], cy = p[ic + 1] - p[ia + 1], cz = p[ic + 2] - p[ia + 2];
    const dx = p[id] - p[ia], dy = p[id + 1] - p[ia + 1], dz = p[id + 2] - p[ia + 2];
    return (bx * (cy * dz - cz * dy) + by * (cz * dx - cx * dz) + bz * (cx * dy - cy * dx)) / 6;
  }

  private tetVolume(t: number) {
    const k = t * 4, q = this.tetIndex;
    return this.signedTet(q[k], q[k + 1], q[k + 2], q[k + 3]);
  }

  /** Closed-triangle signed volume; independent of tetra rest targets and particle masses. */
  private signedSurfaceVolume(): number {
    const p = this.positions, t = this.indices;
    let sum = 0;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
      sum += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    return sum;
  }

  /** XPBD-style global volume projection on the visible closed shell, not an object-scale transform. */
  private projectSurfaceVolume() {
    const p = this.positions, t = this.indices, grad = this.volumeGradient;
    grad.fill(0);
    let volume = 0;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], cx = p[c], cy = p[c + 1], cz = p[c + 2];
      const gax = by * cz - bz * cy, gay = bz * cx - bx * cz, gaz = bx * cy - by * cx;
      volume += (ax * gax + ay * gay + az * gaz) / 6;
      grad[a] += gax / 6; grad[a + 1] += gay / 6; grad[a + 2] += gaz / 6;
      grad[b] += (cy * az - cz * ay) / 6; grad[b + 1] += (cz * ax - cx * az) / 6; grad[b + 2] += (cx * ay - cy * ax) / 6;
      grad[c] += (ay * bz - az * by) / 6; grad[c + 1] += (az * bx - ax * bz) / 6; grad[c + 2] += (ax * by - ay * bx) / 6;
    }
    let den = 1e-10;
    for (let i = 0; i < grad.length; i++) den += grad[i] * grad[i];
    const dl = Math.max(-0.5, Math.min(0.5, -(volume - this.restSurfaceVolume) / den));
    for (let i = 0; i < p.length; i++) p[i] += grad[i] * dl;
  }

  private projectEdges(dt: number) {
    const p = this.positions, e = this.edgeIndex, activity = this.contactActivity;
    for (let k = 0; k < this.edgeCount; k++) {
      // A flowing (broken) bond holds nothing; incompressible tets keep the volume.
      if (this.edgeFlowing[k]) continue;
      const a = e[2 * k], b = e[2 * k + 1], i = a * 3, j = b * 3;
      const dx = p[i] - p[j], dy = p[i + 1] - p[j + 1], dz = p[i + 2] - p[j + 2], l = Math.hypot(dx, dy, dz);
      if (l < 1e-8) continue;
      // Yield locally beneath a finger or held patch, without softening the
      // opposite end into a liquid. The volume constraints still redistribute it.
      const alpha = (0.000002 + 0.00008 * Math.max(activity[a], activity[b])) / (dt * dt);
      const dl = (-(l - this.edgeRest[k]) - alpha * this.edgeLambda[k]) / (2 + alpha);
      this.edgeLambda[k] += dl;
      const s = dl / l;
      p[i] += s * dx; p[i + 1] += s * dy; p[i + 2] += s * dz;
      p[j] -= s * dx; p[j + 1] -= s * dy; p[j + 2] -= s * dz;
    }
  }

  /**
   * Shared tetra-gradient projection: XPBD volume preservation, or (barrier=true)
   * a one-sided push that restores a collapsing tet to 20% of its rest volume.
   * Returns whether a correction was applied.
   */
  private projectTet(t: number, dt: number, barrier: boolean): boolean {
    const p = this.positions, q = this.tetIndex, k = t * 4;
    const a = q[k] * 3, b = q[k + 1] * 3, c = q[k + 2] * 3, d = q[k + 3] * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    const adx = p[d] - p[a], ady = p[d + 1] - p[a + 1], adz = p[d + 2] - p[a + 2];
    const gbx = (acy * adz - acz * ady) / 6, gby = (acz * adx - acx * adz) / 6, gbz = (acx * ady - acy * adx) / 6;
    const gcx = (ady * abz - adz * aby) / 6, gcy = (adz * abx - adx * abz) / 6, gcz = (adx * aby - ady * abx) / 6;
    const gdx = (aby * acz - abz * acy) / 6, gdy = (abz * acx - abx * acz) / 6, gdz = (abx * acy - aby * acx) / 6;
    const gax = -gbx - gcx - gdx, gay = -gby - gcy - gdy, gaz = -gbz - gcz - gdz;
    const volume = abx * gbx + aby * gby + abz * gbz;
    const gradSq = gax * gax + gay * gay + gaz * gaz + gbx * gbx + gby * gby + gbz * gbz + gcx * gcx + gcy * gcy + gcz * gcz + gdx * gdx + gdy * gdy + gdz * gdz;
    let dl: number;
    if (barrier) {
      const floor = this.tetRest[t] * 0.2;
      if (volume >= floor || gradSq < 1e-12) return false;
      dl = Math.min(1, (floor - volume) / gradSq);
    } else {
      const alpha = 1e-11 / (dt * dt);
      dl = (-(volume - this.tetRest[t]) - alpha * this.tetLambda[t]) / (gradSq + alpha);
      this.tetLambda[t] += dl;
    }
    p[a] += dl * gax; p[a + 1] += dl * gay; p[a + 2] += dl * gaz;
    p[b] += dl * gbx; p[b + 1] += dl * gby; p[b + 2] += dl * gbz;
    p[c] += dl * gcx; p[c + 1] += dl * gcy; p[c + 2] += dl * gcz;
    p[d] += dl * gdx; p[d + 1] += dl * gdy; p[d + 2] += dl * gdz;
    return true;
  }

  /** Last-resort fix for tets that still flipped: push the fourth vertex back over the base face. */
  private hardBarrier() {
    const p = this.positions, q = this.tetIndex;
    for (let t = 0; t < this.tetCount; t++) {
      const volume = this.tetVolume(t);
      if (volume > 0) continue;
      const a = q[t * 4] * 3, b = q[t * 4 + 1] * 3, c = q[t * 4 + 2] * 3, d = q[t * 4 + 3] * 3;
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx, n2 = nx * nx + ny * ny + nz * nz;
      if (n2 < 1e-12) continue;
      const scale = Math.min(0.02 / Math.sqrt(n2), (this.tetRest[t] * 0.05 - volume) * 6 / n2);
      p[d] += nx * scale; p[d + 1] += ny * scale; p[d + 2] += nz * scale;
    }
  }

  /** Boundary vertex vs non-neighbouring surface triangles; a conservative fold-contact approximation. */
  private projectSelfContact() {
    const p = this.positions, tri = this.indices, thickness = 0.019, cell = SELF_CONTACT_CELL;
    this.selfContactCount = 0;
    // Conservative triangle AABBs in a fixed-size grid. Large stretched faces
    // go into a fallback list rather than creating an unbounded number of cells.
    const bins = new Map<number, number[]>(), largeFaces: number[] = [];
    const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    for (let k = 0; k < tri.length; k += 3) {
      const a = tri[k] * 3, b = tri[k + 1] * 3, c = tri[k + 2] * 3;
      const x0 = Math.floor((Math.min(p[a], p[b], p[c]) - thickness) / cell), x1 = Math.floor((Math.max(p[a], p[b], p[c]) + thickness) / cell);
      const y0 = Math.floor((Math.min(p[a + 1], p[b + 1], p[c + 1]) - thickness) / cell), y1 = Math.floor((Math.max(p[a + 1], p[b + 1], p[c + 1]) + thickness) / cell);
      const z0 = Math.floor((Math.min(p[a + 2], p[b + 2], p[c + 2]) - thickness) / cell), z1 = Math.floor((Math.max(p[a + 2], p[b + 2], p[c + 2]) + thickness) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 125) { largeFaces.push(k); continue; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const entries = bins.get(key(x, y, z));
        if (entries) entries.push(k); else bins.set(key(x, y, z), [k]);
      }
    }
    const visit = (vi: number, k: number) => {
      const a = tri[k], b = tri[k + 1], c = tri[k + 2], near = this.neighbours[vi];
      if (a === vi || b === vi || c === vi || near.has(a) || near.has(b) || near.has(c)) return;
      const i = vi * 3, px = p[i], py = p[i + 1], pz = p[i + 2];
      closestOnTriangle(p, a * 3, b * 3, c * 3, px, py, pz);
      let dx = px - hit.x, dy = py - hit.y, dz = pz - hit.z, d = Math.hypot(dx, dy, dz);
      if (d >= thickness) return;
      if (d < 1e-7) {
        const ia = a * 3, ib = b * 3, ic = c * 3;
        const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2];
        const vx = p[ic] - p[ia], vy = p[ic + 1] - p[ia + 1], vz = p[ic + 2] - p[ia + 2];
        dx = uy * vz - uz * vy; dy = uz * vx - ux * vz; dz = ux * vy - uy * vx;
        const normalLength = Math.hypot(dx, dy, dz);
        if (normalLength < 1e-8) return;
        dx /= normalLength; dy /= normalLength; dz /= normalLength; d = 0;
      }
      const amount = (thickness - d) * 0.55 / (d || 1);
      p[i] += dx * amount; p[i + 1] += dy * amount; p[i + 2] += dz * amount;
      for (const [id, w] of [[a, hit.u], [b, hit.v], [c, hit.w]] as const) {
        const j = id * 3, q = amount * w * 0.25;
        p[j] -= dx * q; p[j + 1] -= dy * q; p[j + 2] -= dz * q;
      }
      this.selfContactCount++;
    };
    for (const vi of this.surfaceVertices) {
      const i = vi * 3;
      const entries = bins.get(key(Math.floor(p[i] / cell), Math.floor(p[i + 1] / cell), Math.floor(p[i + 2] / cell)));
      if (entries) for (const k of entries) visit(vi, k);
      for (const k of largeFaces) visit(vi, k);
    }
  }

  /** Per-step broadphase: drop colliders far from the clay and list the vertices/faces each may reach. */
  private gatherSolidContacts(colliders: readonly HandCollider[]): SolidContact[] {
    const p = this.positions, tri = this.indices;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
      minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
    }
    const out: SolidContact[] = [];
    for (const collider of colliders) {
      if (collider.grasp) continue;
      const end = collider.end ?? collider.center, m = collider.radius + BROADPHASE_MARGIN;
      const lo = [Math.min(collider.center[0], end[0]) - m, Math.min(collider.center[1], end[1]) - m, Math.min(collider.center[2], end[2]) - m];
      const hi = [Math.max(collider.center[0], end[0]) + m, Math.max(collider.center[1], end[1]) + m, Math.max(collider.center[2], end[2]) + m];
      if (hi[0] < minX || lo[0] > maxX || hi[1] < minY || lo[1] > maxY || hi[2] < minZ || lo[2] > maxZ) continue;
      const vertices: number[] = [], triangles: number[] = [];
      for (let v = 0, i = 0; i < p.length; v++, i += 3) {
        if (p[i] >= lo[0] && p[i] <= hi[0] && p[i + 1] >= lo[1] && p[i + 1] <= hi[1] && p[i + 2] >= lo[2] && p[i + 2] <= hi[2]) vertices.push(v);
      }
      for (let k = 0; k < tri.length; k += 3) {
        const a = tri[k] * 3, b = tri[k + 1] * 3, c = tri[k + 2] * 3;
        if (Math.max(p[a], p[b], p[c]) < lo[0] || Math.min(p[a], p[b], p[c]) > hi[0]) continue;
        if (Math.max(p[a + 1], p[b + 1], p[c + 1]) < lo[1] || Math.min(p[a + 1], p[b + 1], p[c + 1]) > hi[1]) continue;
        if (Math.max(p[a + 2], p[b + 2], p[c + 2]) < lo[2] || Math.min(p[a + 2], p[b + 2], p[c + 2]) > hi[2]) continue;
        triangles.push(k);
      }
      if (vertices.length || triangles.length) out.push({ collider, vertices, triangles });
    }
    return out;
  }

  /** Record a hand touching a vertex this step: friction later uses push, hand velocity and normal. */
  private touch(vertex: number, c: HandCollider, weight: number, push: number, nx: number, ny: number, nz: number) {
    const i = vertex * 3;
    this.normalPush[vertex] += push * weight;
    this.touchWeight[vertex] += weight;
    this.touchVelocity[i] += c.velocity[0] * weight; this.touchVelocity[i + 1] += c.velocity[1] * weight; this.touchVelocity[i + 2] += c.velocity[2] * weight;
    this.touchNormal[i] += nx * weight; this.touchNormal[i + 1] += ny * weight; this.touchNormal[i + 2] += nz * weight;
  }

  /**
   * Push material out of a solid collider. Vertices (including interior ones a deep
   * finger reaches) are projected directly; faces are projected through their
   * barycentric weights so a fingertip between coarse vertices still makes a dent.
   * Faces within FRICTION_SKIN register a touch without being pushed.
   */
  private projectSolid(contact: SolidContact) {
    const p = this.positions, tri = this.indices, c = contact.collider, core = this.core;
    const [cx, cy, cz] = c.center;
    const sx = c.end ? c.end[0] - cx : 0, sy = c.end ? c.end[1] - cy : 0, sz = c.end ? c.end[2] - cz : 0;
    let touched = false;
    for (const v of contact.vertices) {
      const i = v * 3, t = c.end ? segmentParam(cx, cy, cz, sx, sy, sz, p[i], p[i + 1], p[i + 2]) : 0;
      let dx = p[i] - (cx + sx * t), dy = p[i + 1] - (cy + sy * t), dz = p[i + 2] - (cz + sz * t), d = Math.hypot(dx, dy, dz);
      if (d >= c.radius) continue;
      if (d < 1e-6) { dx = 0; dy = 1; dz = 0; d = 0; }
      const push = c.radius - d, q = push / (d || 1);
      p[i] += dx * q; p[i + 1] += dy * q; p[i + 2] += dz * q;
      this.touch(v, c, 1, push, dx / (d || 1), dy / (d || 1), dz / (d || 1));
      this.contactActivity[v] = 1; this.pressSeed[v] = 1; this.contactCount++; touched = true;
    }
    for (const k of contact.triangles) {
      const a = tri[k] * 3, b = tri[k + 1] * 3, cc = tri[k + 2] * 3;
      closestCoreToTriangle(p, a, b, cc, c, core);
      let nx = hit.x - core[0], ny = hit.y - core[1], nz = hit.z - core[2];
      const d = Math.hypot(nx, ny, nz);
      if (d >= c.radius + FRICTION_SKIN) continue;
      if (d < 1e-6) {
        // Core lies on the face: push the face inward, against its outward normal.
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[cc] - p[a], vy = p[cc + 1] - p[a + 1], vz = p[cc + 2] - p[a + 2];
        nx = -(uy * vz - uz * vy) * this.orientation; ny = -(uz * vx - ux * vz) * this.orientation; nz = -(ux * vy - uy * vx) * this.orientation;
        const length = Math.hypot(nx, ny, nz);
        if (length < 1e-10) continue;
        nx /= length; ny /= length; nz /= length;
      } else { nx /= d; ny /= d; nz /= d; }
      const wu = hit.u, wv = hit.v, ww = hit.w;
      touched = true;
      if (d >= c.radius) {
        // Resting on the surface: a light touch, no push.
        for (const [vertex, w] of [[tri[k], wu], [tri[k + 1], wv], [tri[k + 2], ww]] as const) if (w > 0.05) this.touch(vertex, c, w, 0, nx, ny, nz);
        continue;
      }
      const push = c.radius - d, norm = push / (wu * wu + wv * wv + ww * ww);
      p[a] += nx * wu * norm; p[a + 1] += ny * wu * norm; p[a + 2] += nz * wu * norm;
      p[b] += nx * wv * norm; p[b + 1] += ny * wv * norm; p[b + 2] += nz * wv * norm;
      p[cc] += nx * ww * norm; p[cc + 1] += ny * ww * norm; p[cc + 2] += nz * ww * norm;
      for (const [vertex, w] of [[tri[k], wu], [tri[k + 1], wv], [tri[k + 2], ww]] as const) {
        this.touch(vertex, c, w, push, nx, ny, nz);
        this.contactActivity[vertex] = Math.max(this.contactActivity[vertex], w);
        this.pressSeed[vertex] = Math.max(this.pressSeed[vertex], w);
      }
      this.contactCount++;
    }
    if (touched) this.contactColliderIds.add(c.id);
  }

  /**
   * Coulomb friction with the hands, once per step after the contact iterations. The slip of
   * each touched vertex relative to the hand, minus its normal part, is cancelled up to
   * μ × (normal push this step + SKIN_GRIP): clay sticks to a hand pressing into it and is
   * smeared along when the hand slides, but a hand barely resting on it glides over.
   */
  private applyFriction(dt: number) {
    const p = this.positions, old = this.previous, w = this.touchWeight, tv = this.touchVelocity, tn = this.touchNormal;
    for (let v = 0; v < w.length; v++) {
      if (!w[v]) continue;
      const i = v * 3, inv = 1 / w[v];
      let nx = tn[i], ny = tn[i + 1], nz = tn[i + 2];
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; }
      // Slip of the clay relative to the hand over this step, without its normal part.
      let sx = p[i] - old[i] - tv[i] * inv * dt, sy = p[i + 1] - old[i + 1] - tv[i + 1] * inv * dt, sz = p[i + 2] - old[i + 2] - tv[i + 2] * inv * dt;
      const along = sx * nx + sy * ny + sz * nz;
      sx -= along * nx; sy -= along * ny; sz -= along * nz;
      const slip = Math.hypot(sx, sy, sz);
      if (slip < 1e-9) continue;
      const cancel = Math.min(1, FRICTION * (this.normalPush[v] * inv + SKIN_GRIP) / slip);
      p[i] -= sx * cancel; p[i + 1] -= sy * cancel; p[i + 2] -= sz * cancel;
      this.contactActivity[v] = 1; this.pressSeed[v] = 1;
    }
  }

  /** Damp velocity differences across edges (viscosity): clay moves as a heavy whole, not a jelly. */
  private applyViscosity() {
    const v = this.velocity, e = this.edgeIndex;
    for (let k = 0; k < this.edgeCount; k++) {
      const i = e[2 * k] * 3, j = e[2 * k + 1] * 3;
      for (let axis = 0; axis < 3; axis++) {
        const dv = (v[j + axis] - v[i + axis]) * VISCOSITY * 0.5;
        v[i + axis] += dv; v[j + axis] -= dv;
      }
    }
  }

  /**
   * Diffuse press activity three rings out along volumetric edges. Seeded only from
   * solid (pressing) contact: spreading from grips too made extreme folds fold through
   * themselves far more often (fold-topology fixture).
   */
  private spreadPressActivity() {
    const e = this.edgeIndex, seed = this.pressSeed, activity = this.contactActivity;
    for (let pass = 0; pass < 3; pass++) for (let k = 0; k < this.edgeCount; k++) {
      const a = e[2 * k], b = e[2 * k + 1];
      if (seed[a] * SPREAD > seed[b]) seed[b] = seed[a] * SPREAD;
      else if (seed[b] * SPREAD > seed[a]) seed[a] = seed[b] * SPREAD;
    }
    for (let i = 0; i < seed.length; i++) if (seed[i] > activity[i]) activity[i] = seed[i];
  }

  /** Grasp is acquired only from material overlapping the grip volume, never at distance. */
  private updateAnchors(colliders: readonly HandCollider[], dt: number) {
    const p = this.positions;
    const activeIds = new Set<string>();
    for (const c of colliders) if (c.grasp) activeIds.add(c.id);
    for (const id of this.anchors.keys()) if (!activeIds.has(id)) this.anchors.delete(id);
    for (const c of colliders) {
      if (!c.grasp || this.anchors.has(c.id)) continue;
      // Surface material only: anchoring interior vertices too left tets inverted under
      // the fold fixture. A grip point sunk inside still takes the shell around it.
      const reach = c.radius + 0.012;
      const near = this.surfaceVertices
        .map(index => ({ index, distance: Math.hypot(p[index * 3] - c.center[0], p[index * 3 + 1] - c.center[1], p[index * 3 + 2] - c.center[2]) }))
        .filter(a => a.distance < reach)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 16);
      if (!near.length) continue;
      this.anchors.set(c.id, {
        center: c.center,
        basis: c.basis,
        vertices: near.map(a => {
          const i = a.index * 3, offset: Vec3 = [p[i] - c.center[0], p[i + 1] - c.center[1], p[i + 2] - c.center[2]];
          const local: Vec3 = c.basis ? [0, 1, 2].map(j => c.basis![j][0] * offset[0] + c.basis![j][1] * offset[1] + c.basis![j][2] * offset[2]) as unknown as Vec3 : offset;
          return { index: a.index, offset: local, weight: Math.max(0.5, 1 - a.distance / reach) };
        }),
      });
    }
    for (const c of colliders) {
      const patch = this.anchors.get(c.id);
      if (!patch) continue;
      // The held patch follows the hand at most 1.4 m/s so a tracking jump cannot fling the clay.
      const mx = c.center[0] - patch.center[0], my = c.center[1] - patch.center[1], mz = c.center[2] - patch.center[2];
      const scale = Math.min(1, 1.4 * dt / (Math.hypot(mx, my, mz) || 1));
      patch.center = [patch.center[0] + mx * scale, patch.center[1] + my * scale, patch.center[2] + mz * scale];
      if (patch.basis && c.basis) patch.basis = c.basis;
      for (const a of patch.vertices) this.contactActivity[a.index] = 1;
      this.contactColliderIds.add(c.id);
      this.contactCount += patch.vertices.length;
    }
  }

  private projectAnchors(colliders: readonly HandCollider[]) {
    const p = this.positions;
    for (const c of colliders) {
      const patch = this.anchors.get(c.id);
      if (!patch) continue;
      // Held material follows the fingers firmly (the rest of the mass then stretches
      // plastically); the 4 mm/iteration cap keeps a tracking jump from tearing the mesh.
      const basis = patch.basis, strength = 0.45 + 0.4 * (c.gripStrength ?? 1);
      for (const a of patch.vertices) {
        const i = a.index * 3, o = a.offset;
        const ox = basis ? basis[0][0] * o[0] + basis[1][0] * o[1] + basis[2][0] * o[2] : o[0];
        const oy = basis ? basis[0][1] * o[0] + basis[1][1] * o[1] + basis[2][1] * o[2] : o[1];
        const oz = basis ? basis[0][2] * o[0] + basis[1][2] * o[1] + basis[2][2] * o[2] : o[2];
        const dx = patch.center[0] + ox - p[i], dy = patch.center[1] + oy - p[i + 1], dz = patch.center[2] + oz - p[i + 2];
        const amount = Math.min(0.85, strength * a.weight, 0.004 / (Math.hypot(dx, dy, dz) || 1));
        p[i] += dx * amount; p[i + 1] += dy * amount; p[i + 2] += dz * amount;
      }
    }
  }

  /**
   * Table contact with position-based static friction: material resting on the table keeps
   * its footprint under a gentle push, so the push dents the clay instead of sliding the ball.
   */
  private clampTable() {
    const p = this.positions, old = this.previous;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] >= TABLE_Y) continue;
      p[i + 1] = TABLE_Y;
      // Static friction only: small creeping slides are cancelled, a firm squash still spreads.
      if (Math.hypot(p[i] - old[i], p[i + 2] - old[i + 2]) < TABLE_STICK) { p[i] = old[i]; p[i + 2] = old[i + 2]; }
    }
  }

  /** A collider only pushes when overlapping. Grasp is acquired at the surface, never at distance. */
  step(dt: number, colliders: readonly HandCollider[] = []) {
    if (!(dt > 0 && dt <= 1 / 30)) throw new Error('dt outside bounded fixed-step range');
    const p = this.positions, v = this.velocity, old = this.previous, activity = this.contactActivity;
    old.set(p);
    this.contactCount = 0;
    this.contactColliderIds.clear();
    this.pressSeed.fill(0);
    this.normalPush.fill(0);
    this.touchWeight.fill(0);
    this.touchVelocity.fill(0);
    this.touchNormal.fill(0);
    const decay = Math.exp(-dt * 7);
    for (let i = 0; i < activity.length; i++) activity[i] *= decay;
    for (let i = 0; i < p.length; i += 3) {
      v[i + 1] = Math.max(-MAX_SPEED, v[i + 1] - GRAVITY * dt);
      p[i] += v[i] * dt; p[i + 1] += v[i + 1] * dt; p[i + 2] += v[i + 2] * dt;
    }

    this.updateAnchors(colliders, dt);
    const solids = this.gatherSolidContacts(colliders);

    this.edgeLambda.fill(0);
    this.tetLambda.fill(0);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      this.projectEdges(dt);
      for (let t = 0; t < this.tetCount; t++) this.projectTet(t, dt, false);
      this.clampTable();
      // The virtual grip is not a solid ball pushing its own anchors away.
      for (const contact of solids) this.projectSolid(contact);
      this.projectAnchors(colliders);
    }
    this.applyFriction(dt);

    this.projectSelfContact();
    for (let i = 0; i < 5; i++) this.projectSurfaceVolume();
    // Volume passes may push material back into a hand or out of a grip; hands
    // win, otherwise held clay creeps out of the fingers every step. Inversion
    // barriers still run last so a crushing grip cannot turn tets inside out.
    for (const contact of solids) this.projectSolid(contact);
    for (let i = 0; i < 3; i++) this.projectAnchors(colliders);
    this.projectSelfContact();
    this.clampTable();
    for (let pass = 0; pass < 100; pass++) {
      let corrected = false;
      for (let t = 0; t < this.tetCount; t++) corrected = this.projectTet(t, dt, true) || corrected;
      if (!corrected) break;
    }
    this.hardBarrier();

    for (let i = 0; i < p.length; i += 3) {
      if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1]) || !Number.isFinite(p[i + 2])) throw new Error('Non-finite solver position');
      // Barriers can move a vertex after the earlier table projection.
      p[i + 1] = Math.max(TABLE_Y, p[i + 1]);
      const ground = p[i + 1] < TABLE_Y + 0.001;
      if (ground && v[i + 1] < -0.25) activity[i / 3] = 1;
      v[i] = (p[i] - old[i]) / dt * (ground ? 0.76 : 0.91);
      v[i + 1] = (p[i + 1] - old[i + 1]) / dt * (ground ? 0.42 : 0.91);
      v[i + 2] = (p[i + 2] - old[i + 2]) / dt * (ground ? 0.76 : 0.91);
      for (let j = 0; j < 3; j++) v[i + j] = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v[i + j]));
    }
    this.applyViscosity();

    // Material displaced by a finger bulges around it; let that ring flow too, or its
    // elastic recovery pushes the clay straight back into the dent after release.
    this.spreadPressActivity();
    // Plastic flow, two mechanisms. Fast relative motion breaks an edge's bond (it flows,
    // following its current length) until it slows down and re-bonds where it is. Slower
    // strain beyond a yield distance still creeps the rest length, faster near contact.
    const e = this.edgeIndex;
    for (let k = 0; k < this.edgeCount; k++) {
      const a = e[2 * k], b = e[2 * k + 1], l = this.distance(a, b), act = Math.max(activity[a], activity[b]);
      const i = a * 3, j = b * 3, inv = 1 / (l || 1);
      const separating = Math.abs(((v[i] - v[j]) * (p[i] - p[j]) + (v[i + 1] - v[j + 1]) * (p[i + 1] - p[j + 1]) + (v[i + 2] - v[j + 2]) * (p[i + 2] - p[j + 2])) * inv);
      if (this.edgeFlowing[k]) {
        this.edgeRest[k] = Math.max(0.005, l);
        if (separating < FLOW_SET) this.edgeFlowing[k] = 0;
        continue;
      }
      if (separating > FLOW_BREAK) { this.edgeFlowing[k] = 1; this.edgeRest[k] = Math.max(0.005, l); continue; }
      const yieldDistance = 0.0035 - 0.0025 * act, error = l - this.edgeRest[k];
      if (Math.abs(error) > yieldDistance) {
        const flow = 1 - Math.exp(-(6 + 45 * act) * dt);
        this.edgeRest[k] = Math.max(0.005, this.edgeRest[k] + flow * (error - Math.sign(error) * yieldDistance));
      }
    }
    this.flowTetVolumes(dt);
    this.version++;
  }

  /**
   * Plastic volume flow: worked tets (near contact) let their rest volume follow the volume they
   * were squeezed into, so displaced clay settles into the rim around a dent instead of popping
   * back. Rest volumes are then rescaled so the total never changes (mass is conserved), and
   * kept within [0.5, 2]× of the mean so no tet collapses or balloons.
   */
  private flowTetVolumes(dt: number) {
    const q = this.tetIndex, activity = this.contactActivity, rest = this.tetRest;
    let total = 0;
    const mean = this.totalTetRest / this.tetCount;
    for (let t = 0; t < this.tetCount; t++) {
      const k = t * 4, act = Math.max(activity[q[k]], activity[q[k + 1]], activity[q[k + 2]], activity[q[k + 3]]);
      if (act > 0.05) {
        const flow = 1 - Math.exp(-TET_FLOW * act * dt);
        rest[t] = Math.min(mean * 2, Math.max(mean * 0.5, rest[t] + (this.tetVolume(t) - rest[t]) * flow));
      }
      total += rest[t];
    }
    const scale = this.totalTetRest / total;
    for (let t = 0; t < this.tetCount; t++) rest[t] *= scale;
  }
}
