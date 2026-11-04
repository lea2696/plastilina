import * as THREE from 'three';

/**
 * The string as a real tube (PRD §6: «tubo con grosor real»), not a 1 px line: at 1080p a 2.5 mm radius is
 * about 5 px across. The geometry is built once with a fixed number of path points and sides; every frame
 * only the vertex and normal buffers are rewritten in place, so nothing is allocated per frame.
 *
 * The path lives in the z = 0 plane, so the cross-section frame needs no transport: at each point it is
 * spanned by the in-plane normal and the z axis.
 */

/** Points along the path (tie point on the finger, then pivot → yoyo). Fixed. */
export const STRING_POINTS = 42;
/** Sides of the tube. Eight is round enough at a few pixels of width and keeps the buffer tiny. */
export const STRING_SIDES = 8;
/** Visual tube radius, m. 2.5 mm → ≥ 1.5 px at 1080p for the framing in `framing.ts` (≈ 5 px actual). */
export const STRING_RADIUS = 0.0025;

export class StringTube {
  readonly geometry = new THREE.BufferGeometry();
  /** The path, x and y interleaved (STRING_POINTS pairs). Callers write it, then call update(). */
  readonly path = new Float32Array(2 * STRING_POINTS);

  private readonly positions = new Float32Array(3 * STRING_POINTS * STRING_SIDES);
  private readonly normals = new Float32Array(3 * STRING_POINTS * STRING_SIDES);
  private readonly cos = new Float32Array(STRING_SIDES);
  private readonly sin = new Float32Array(STRING_SIDES);
  private readonly radius: number;

  constructor(radius: number = STRING_RADIUS) {
    this.radius = radius;
    for (let s = 0; s < STRING_SIDES; s++) {
      const angle = (2 * Math.PI * s) / STRING_SIDES;
      this.cos[s] = Math.cos(angle);
      this.sin[s] = Math.sin(angle);
    }
    const indices: number[] = [];
    for (let i = 0; i < STRING_POINTS - 1; i++) {
      for (let s = 0; s < STRING_SIDES; s++) {
        const a = i * STRING_SIDES + s;
        const b = i * STRING_SIDES + ((s + 1) % STRING_SIDES);
        const c = (i + 1) * STRING_SIDES + s;
        const d = (i + 1) * STRING_SIDES + ((s + 1) % STRING_SIDES);
        // Outward winding for a ring that runs from the in-plane normal toward +z (see update()).
        indices.push(a, b, c, b, d, c);
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(indices);
    // The path moves every frame and never leaves the scene; a fixed generous sphere avoids stale culling.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 4);
    this.update();
  }

  /**
   * Rebuilds the tube from `path`. Returns false (and keeps the previous tube) if the path holds a
   * non-finite number, so one bad snapshot can never poison the buffers.
   */
  update(): boolean {
    const p = this.path;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
    const r = this.radius;
    let tx = 0;
    let ty = -1;
    for (let i = 0; i < STRING_POINTS; i++) {
      // Central difference tangent; one-sided at the ends; keep the previous direction if it degenerates.
      const i0 = i === 0 ? 0 : i - 1;
      const i1 = i === STRING_POINTS - 1 ? i : i + 1;
      const dx = p[2 * i1] - p[2 * i0];
      const dy = p[2 * i1 + 1] - p[2 * i0 + 1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-9) {
        tx = dx / len;
        ty = dy / len;
      }
      // In-plane normal n = (−ty, tx); with ẑ it spans the cross-section, and n × ẑ = t.
      const nx = -ty;
      const ny = tx;
      const cx = p[2 * i];
      const cy = p[2 * i + 1];
      for (let s = 0; s < STRING_SIDES; s++) {
        const k = 3 * (i * STRING_SIDES + s);
        const c = this.cos[s];
        const sn = this.sin[s];
        const ox = c * nx;
        const oy = c * ny;
        this.positions[k] = cx + ox * r;
        this.positions[k + 1] = cy + oy * r;
        this.positions[k + 2] = sn * r;
        this.normals[k] = ox;
        this.normals[k + 1] = oy;
        this.normals[k + 2] = sn;
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
