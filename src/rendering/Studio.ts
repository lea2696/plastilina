import * as THREE from 'three';
import type { MappedHand, Vec3 } from '../shared/contracts';
import type { Ray } from '../interaction/PointerTool';
import { ClaySolver } from '../simulation/ClaySolver';
import { SurfaceSmoother } from './SurfaceSmoother';
import { QualityGovernor } from './QualityGovernor';

const HAND_EDGES: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
/** Landmarks that cast a contact shadow on the table: wrist and fingertips. */
const SHADOW_POINTS = [0, 4, 8, 12, 16, 20];
const CONTACT = new THREE.Color('#5dffb0');
const GRASP = new THREE.Color('#ffcc85');

export const CLAY_COLORS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'Terracota', value: '#be735a' },
  { name: 'Arena', value: '#d9b98c' },
  { name: 'Salvia', value: '#7f9f78' },
  { name: 'Azul', value: '#5b7fb8' },
  { name: 'Lavanda', value: '#9a86c2' },
  { name: 'Rosa', value: '#d98a9e' },
  { name: 'Hueso', value: '#e6dfd2' },
];

interface Palette { background: string; table: string; top: string; ground: string; dot: string; accent: string; line: string; shadow: string }
const DARK: Palette = { background: '#1a2228', table: '#303d43', top: '#455258', ground: '#65717a', dot: '#e0d1c4', accent: '#69dfd5', line: '#9ccdc7', shadow: '#05090b' };
const LIGHT: Palette = { background: '#e9ded1', table: '#c7ad95', top: '#ded0bc', ground: '#9a7862', dot: '#645c54', accent: '#278e8b', line: '#6b817e', shadow: '#4a3326' };

interface HandView { dots: THREE.Mesh[]; line: THREE.LineSegments; shadows: THREE.Mesh[] }

export class Studio {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(37, 1, 0.05, 10);
  readonly canvas: HTMLCanvasElement;
  private readonly clay: THREE.Mesh;
  private readonly clayShadow: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly smoother: SurfaceSmoother;
  private readonly hands: HandView[] = [];
  private readonly pointer: THREE.Mesh;
  private readonly materials: Record<'table' | 'top', THREE.MeshStandardMaterial>;
  private readonly clayMaterial: THREE.MeshStandardMaterial;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly quality = new QualityGovernor();
  private readonly basePixelRatio: number;
  private palette = DARK;

  constructor(canvas: HTMLCanvasElement, solver: ClaySolver) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(devicePixelRatio, 1.7);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.camera.position.set(0, 0.76, 1.12);
    this.camera.lookAt(0, 0.14, 0);

    this.hemisphere = new THREE.HemisphereLight('#fff6e8', '#9a7862', 2.1);
    this.key = new THREE.DirectionalLight('#fff7eb', 2.4);
    this.key.position.set(-0.7, 1.7, 1.2);
    this.fill = new THREE.DirectionalLight('#d0e1e2', 0.7);
    this.fill.position.set(0.8, 0.9, -0.6);
    this.scene.add(this.hemisphere, this.key, this.fill);

    this.materials = {
      table: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
      top: new THREE.MeshStandardMaterial({ roughness: 0.95 }),
    };
    const table = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.07, 96), this.materials.table);
    table.position.y = -0.048;
    const top = new THREE.Mesh(new THREE.CircleGeometry(1.5, 96), this.materials.top);
    top.rotation.x = -Math.PI / 2;
    top.position.y = -0.009;
    this.scene.add(table, top);

    this.clayShadow = new THREE.Mesh(new THREE.CircleGeometry(0.25, 48), new THREE.MeshBasicMaterial({ color: '#6c4e3c', transparent: true, opacity: 0.15, depthWrite: false }));
    this.clayShadow.rotation.x = -Math.PI / 2;
    this.clayShadow.position.y = -0.006;
    this.scene.add(this.clayShadow);

    this.smoother = new SurfaceSmoother(solver.positions.length / 3, solver.indices);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.smoother.update(solver.positions).slice(), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(this.smoother.indices, 1));
    this.geometry.computeVertexNormals();
    this.clayMaterial = new THREE.MeshStandardMaterial({ color: CLAY_COLORS[0].value, roughness: 0.94, metalness: 0, side: THREE.DoubleSide });
    this.clay = new THREE.Mesh(this.geometry, this.clayMaterial);
    this.scene.add(this.clay);

    for (let h = 0; h < 2; h++) {
      const dots: THREE.Mesh[] = [];
      for (let i = 0; i < 21; i++) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.012 : 0.0095, 10, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.82 }));
        dot.visible = false;
        this.scene.add(dot);
        dots.push(dot);
      }
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_EDGES.length * 6), 3));
      const line = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.72 }));
      line.visible = false;
      this.scene.add(line);
      // Soft discs on the table under wrist and fingertips: the main depth cue for a monocular hand.
      const shadows = SHADOW_POINTS.map(() => {
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.022, 20), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false }));
        disc.rotation.x = -Math.PI / 2;
        disc.visible = false;
        this.scene.add(disc);
        return disc;
      });
      this.hands.push({ dots, line, shadows });
    }

    this.pointer = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false }));
    this.pointer.visible = false;
    this.scene.add(this.pointer);
    this.setDarkMode(true);
  }

  setDarkMode(dark: boolean) {
    const palette = this.palette = dark ? DARK : LIGHT;
    this.scene.background = new THREE.Color(palette.background);
    this.scene.fog = new THREE.Fog(palette.background, 1.8, 3.8);
    for (const key of ['table', 'top'] as const) this.materials[key].color.set(palette[key]);
    this.hemisphere.color.set(dark ? '#d5e0df' : '#fff6e8');
    this.hemisphere.groundColor.set(palette.ground);
    this.hemisphere.intensity = dark ? 1.35 : 2.1;
    this.key.intensity = dark ? 2.5 : 2.4;
    this.fill.intensity = dark ? 0.9 : 0.7;
    this.renderer.toneMappingExposure = dark ? 1.15 : 1.25;
  }

  setClayColor(color: string) { this.clayMaterial.color.set(color); }

  /** Camera ray through a point in normalized device coordinates. */
  ray(ndc: [number, number]): Ray {
    this.raycaster.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), this.camera);
    const { origin, direction } = this.raycaster.ray;
    return { origin: [origin.x, origin.y, origin.z], direction: [direction.x, direction.y, direction.z] };
  }

  /** Distance along the camera ray to the visible clay surface, or null when the cursor misses it. */
  pickClay(ndc: [number, number]): number | null {
    if (!this.clay.visible) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), this.camera);
    return this.raycaster.intersectObject(this.clay, false)[0]?.distance ?? null;
  }

  /** Show the mouse tool where it acts on the clay; null hides it. */
  setPointer(center: Vec3 | null, radius = 0, grasping = false) {
    this.pointer.visible = !!center;
    if (!center) return;
    this.pointer.position.set(...center);
    this.pointer.scale.setScalar(radius);
    (this.pointer.material as THREE.MeshBasicMaterial).color.copy(grasping ? GRASP : CONTACT);
  }

  update(solver: ClaySolver, hands: readonly MappedHand[]) {
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    (position.array as Float32Array).set(this.smoother.update(solver.positions));
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
    const p = solver.positions;
    for (const vertex of solver.surfaceVertices) {
      const i = vertex * 3;
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
      minY = Math.min(minY, p[i + 1]);
    }
    this.clayShadow.position.set((minX + maxX) / 2, -0.006, (minZ + maxZ) / 2);
    this.clayShadow.scale.set(Math.max(0.25, Math.min(2.5, (maxX - minX) / 0.44)), Math.max(0.25, Math.min(2.5, (maxZ - minZ) / 0.44)), 1);
    (this.clayShadow.material as THREE.MeshBasicMaterial).opacity = 0.19 * Math.exp(-Math.max(0, minY) * 5);


    for (let h = 0; h < 2; h++) this.updateHand(this.hands[h], hands[h]);
  }

  private updateHand(view: HandView, hand: MappedHand | undefined) {
    const palette = this.palette;
    view.line.visible = !!hand;
    for (const dot of view.dots) dot.visible = !!hand;
    for (const disc of view.shadows) disc.visible = !!hand;
    if (!hand) return;
    const highlight = hand.state === 'grasp' ? GRASP : CONTACT;
    const touching = hand.state === 'grasp' || hand.state === 'contact';
    // Approaching hands warm towards the contact colour so depth can be judged before touching;
    // the whole hand switches colour the moment it touches, touching points grow.
    const proximity = hand.proximity ?? 0;
    view.dots.forEach((dot, i) => {
      dot.position.set(...hand.points[i]);
      const contact = hand.contactPoints?.includes(i) ?? false;
      const material = dot.material as THREE.MeshBasicMaterial;
      if (touching) material.color.copy(highlight);
      else material.color.set(i === 4 || i === 8 ? palette.accent : palette.dot).lerp(CONTACT, proximity * 0.45);
      material.opacity = touching ? 1 : 0.82;
      dot.scale.setScalar(contact ? 1.9 : touching ? 1.25 : 1 + proximity * 0.25);
    });
    const lineMaterial = view.line.material as THREE.LineBasicMaterial;
    if (hand.state === 'grasp' || hand.state === 'contact') lineMaterial.color.copy(highlight);
    else lineMaterial.color.set(palette.line).lerp(CONTACT, proximity * 0.6);
    const array = (view.line.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    let k = 0;
    for (const [i, j] of HAND_EDGES) { array.set(hand.points[i], k); k += 3; array.set(hand.points[j], k); k += 3; }
    view.line.geometry.getAttribute('position').needsUpdate = true;
    SHADOW_POINTS.forEach((landmark, s) => {
      const [x, y, z] = hand.points[landmark], disc = view.shadows[s];
      disc.position.set(x, -0.004, z);
      disc.scale.setScalar(1 + y * 4);
      const material = disc.material as THREE.MeshBasicMaterial;
      material.color.set(palette.shadow);
      material.opacity = 0.42 * Math.exp(-y * 4);
    });
  }

  sampleFps(fps: number) {
    const ratio = this.basePixelRatio * this.quality.sample(fps);
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 0.01) this.renderer.setPixelRatio(ratio);
  }

  pixelRatio() { return this.renderer.getPixelRatio(); }

  render() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, ratio = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.round(w * ratio) || this.canvas.height !== Math.round(h * ratio)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }

  rendererInfo() {
    const gl = this.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  }

  dispose() {
    this.renderer.dispose();
    this.geometry.dispose();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        const material = object.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach(m => m.dispose()); else material.dispose();
      }
    });
  }
}
