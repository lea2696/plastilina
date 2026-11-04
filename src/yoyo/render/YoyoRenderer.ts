import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FramingGuide, WorldRect, YoyoRendererLike, YoyoSnapshot } from '../contracts';
import { AdaptiveQuality } from './adaptiveQuality';
import { CAMERA_FOV_DEG, computeFraming, type Framing } from './framing';
import {
  RING_TUBE_RATIO, TEMPLATE_MAX_U, TEMPLATE_MAX_V, TEMPLATE_MIN_U,
  buildHandPose, createHandPose, isDrawableHand, templateHand, type HandPose,
} from './handGeometry';
import {
  DEFAULT_YOYO_COLOR, RING_COLOR, SCENE, STRING_NEUTRAL, STRING_WARM, YOYO_COLORS,
} from './palette';
import {
  BACKDROP_FRAGMENT, BACKDROP_VERTEX, FLAT_FRAGMENT, GUIDE_FRAGMENT, HAND_FRAGMENT, SPIN_RING_FRAGMENT,
  WORLD_QUAD_VERTEX,
} from './shaders';
import { SlackSmoother, sampleString } from './stringCurve';
import { STRING_POINTS, StringTube } from './stringTube';
import { TensionTint } from './tensionTint';
import { POP_FROM, RETETHER_POP_FROM, WeightCues, popScale, smoothstep01 } from './timelines';
import { resetContextState } from './glState';
import { createYoyoGeometry } from './yoyoProfile';
import { createYoyoMaterial, type YoyoMaterial } from './yoyoMaterial';

export { YOYO_COLORS };

/** Physical body radius of the model (config.yoyo.bodyRadius default), m. */
export const YOYO_PHYSICAL_RADIUS = 0.029;
/**
 * The yoyo is DRAWN this many times bigger than its physical size. Why: the world is magnified ~1.7× with
 * respect to a person (1 m of world per image height puts a 17 cm palm where a real one measures ~10 cm,
 * docs/yoyo/DECISIONS.md), and the hand silhouette is drawn at that magnification. A yoyo at its physical
 * 29 mm radius would be a 40 px disc next to a 17 cm palm and look like a button; at the hand's own
 * magnification it keeps the real proportions (a yoyo is about two thirds of a palm's width) and reads as
 * a yoyo at a glance (≈ 7.5 % of the frame height). Purely visual: position, string and contact all come
 * from the snapshot untouched.
 */
export const YOYO_VISUAL_SCALE = 1.8;
export const YOYO_VISUAL_RADIUS = YOYO_PHYSICAL_RADIUS * YOYO_VISUAL_SCALE;

/**
 * The face is smeared over the angle the yoyo turns in one frame: ω × the frame time. The window never
 * drops below one 60 Hz frame, and it follows the real frame time when frames are slower, so a machine at
 * 30 fps cannot strobe the face (a window shorter than the angle turned per frame is what aliases).
 */
const MIN_SHUTTER_S = 1 / 60;
/** Smoothing of the measured frame time used for the shutter, ms, and its plausible range, ms. */
const FRAME_TIME_TAU_MS = 300;
const FRAME_TIME_MIN_MS = 1000 / 120;
const FRAME_TIME_MAX_MS = 1000 / 15;
/** The smear never needs to exceed one turn: a full turn already averages the whole face. */
const MAX_SMEAR = 2 * Math.PI;
/** Smear (rad) over which the brushed streak fades in: from ω = 30 rad/s to ω = 180 rad/s. */
const STREAK_FROM = 0.5;
const STREAK_TO = 3;
/** Spin (rad/s) over which the ring fades in. */
const RING_SPIN_FROM = 10;
const RING_SPIN_FULL = 240;
const RING_MAX_ALPHA = 0.9;
/** Spin ring geometry, in yoyo radii and metres. */
const RING_RADIUS_FACTOR = 1.22;
const RING_HALF_WIDTH_M = 0.002;
const RING_QUAD_HALF = 1.7 * YOYO_VISUAL_RADIUS;

/** How far toward the warm colour the string goes at full tension (0..1): a shift, not a different string. */
const STRING_TINT_MAX = 0.8;

/** Floor height strings may rest on: their own radius, so a slack string lies on the floor. */
const FLOOR_CLEARANCE_M = 0.003;
/** Curve points of the string between pivot and yoyo; the path adds the tie point on the finger first. */
const CURVE_POINTS = STRING_POINTS - 1;

/**
 * The hand lies exactly in the play plane (z = 0), so perspective cannot misregister it against the string
 * (a plane 3 cm behind would shift by 1.4 % of its distance from the screen centre, about 7 mm at the edge
 * of the hand's range). A depth bias pushes it behind the string and the yoyo, which sit at z ≥ 0 or have
 * a front face in front of it. The tie ring sits a hair in front of the string.
 */
const HAND_DEPTH_FACTOR = 1;
const HAND_DEPTH_UNITS = 4;
const RING_Z = 0.003;
const SPIN_RING_Z = 0.004;
/** Radius of the mouse grip marker, m. */
const GRIP_RADIUS = 0.018;
/**
 * The mouse marker sits on top of the yoyo that hangs from it. While the yoyo is close under the pivot (tied
 * on, just caught) the marker fades to GRIP_MIN_OPACITY so it does not read as an eyelet screwed into the
 * face; it is fully opaque once the yoyo is GRIP_CLEAR_M away.
 */
const GRIP_MIN_OPACITY = 0.4;
const GRIP_NEAR_M = 0.03;
const GRIP_CLEAR_M = 0.08;
/**
 * The tie ring's axis leans this far toward the camera, so it shows as an ellipse with the finger through
 * its hole instead of an opaque flat band (a ring seen exactly edge-on looks like a lid).
 */
const RING_TILT_RAD = (35 * Math.PI) / 180;

/** Time constants of the render-only eases, ms. */
const FLASH_TAU_MS = 110;
const HAND_PRESENCE_TAU_MS = 100;
const DIM_TAU_MS = 90;
const GUIDE_TAU_MS = 160;
const RING_ALPHA_TAU_MS = 90;
/** Opacity of the dimming overlay when paused, and the hand's opacity when its data is stale. */
const PAUSE_DIM = 0.5;
const STALE_HAND_ALPHA = 0.3;
/** Longest frame delta the eases accept: a stalled tab must not make every ease finish in one step. */
const MAX_DT_MS = 100;
/** Period of the guide's slow pulse, ms. */
const GUIDE_PULSE_MS = 2600;
/** Blob shadow: radius in yoyo radii, peak opacity, and the height scales of its fade and its spread, m. */
const SHADOW_RADIUS_FACTOR = 1.9;
const SHADOW_OPACITY = 0.85;
const SHADOW_FADE_M = 0.25;
const SHADOW_SPREAD_PER_M = 1.1;

/** Strength of the generated room lighting on the PBR materials, and the exposure of the tone mapping. */
const ENVIRONMENT_INTENSITY = 0.85;
const TONE_EXPOSURE = 1.0;

/** Why the renderer could not be created. The page shows its own (Spanish) message for this. */
export class WebGLUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('WebGL2 is not available: the yoyó needs a WebGL2 context to draw.', { cause });
    this.name = 'WebGLUnavailableError';
  }
}

export interface YoyoRendererOptions {
  /** Multisample the canvas. Default true; the thin string and the rim need it. */
  antialias?: boolean;
  /**
   * Let the pixel ratio drop when frames are slow and recover when they are fast. Default true. It assumes
   * render() is called once per animation frame; turn it off if the page throttles rendering on purpose,
   * or the deliberate low frame rate would read as a slow GPU.
   */
  adaptiveQuality?: boolean;
}

/** Counters of the last frame, for diagnostics and the budget checks. */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** CPU milliseconds the last render() call took (JS + GL command submission, not GPU time). */
  lastRenderMs: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
/** Exponential approach to `target` with time constant `tauMs`, independent of the frame rate. */
const approach = (value: number, target: number, dtMs: number, tauMs: number) =>
  value + (target - value) * (1 - Math.exp(-dtMs / tauMs));

/** Writes display-referred sRGB numbers into a Color uniform without three converting them. */
function setSrgb(target: THREE.Color, rgb: readonly number[]): THREE.Color {
  return target.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
}

function srgbColor(rgb: readonly number[]): THREE.Color {
  return setSrgb(new THREE.Color(), rgb);
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function snapshotIsFinite(s: YoyoSnapshot): boolean {
  return Number.isFinite(s.pivot[0] + s.pivot[1] + s.yoyo[0] + s.yoyo[1] + s.length + s.spin + s.spinAngle);
}

/**
 * Three.js (WebGL2) renderer of the yoyó, built from scratch (PRD §6).
 *
 * World metres, x right, y up, play plane z = 0, floor y = 0, frontal view that is ALREADY mirrored: nothing
 * here flips x. It draws a snapshot and nothing else: it never feeds anything back to the model, and every
 * render-only cue (hit-stop, string overshoot, camera shake, pop-in) changes only what is painted.
 *
 * Budget (PRD §7): about ten draw calls, no shadow maps (a blob shadow), no per-frame allocation of
 * geometries, materials or textures, and an adaptive pixel ratio as the one quality lever.
 *
 * Using it:
 * - `new YoyoRenderer(canvas)` throws WebGLUnavailableError when there is no WebGL2; show your own message.
 * - Give the canvas a CSS size (e.g. 100 % × 100 %, display: block). The drawing buffer follows it times the
 *   adaptive pixel ratio: never set canvas.width or canvas.height yourself. A ResizeObserver tracks size
 *   changes; resize() forces a re-read. After a resize, take the mouse mapping from visibleWorld().
 * - `nowMs` must be a wall clock (performance.now()), not the simulation clock: the render-only eases (pause
 *   dimming, hand fade, flashes, hit-stop) have to keep moving while the simulation is stopped.
 * - Camera path: hand.landmarks are the 21 WORLD-space landmarks, already mirrored. Mouse path: landmarks
 *   null with hand.present true while the button is held; a grip ring is drawn at the pivot instead.
 * - Phase 'untethered' draws only the hand (where it was tracked) and the guide; every other phase draws the
 *   yoyo, the string and the tie ring, with the hand shifted so landmark 9 sits on the pivot.
 * - Events (snap, catch, tether, retether) are read from the snapshot; handing the same snapshot object to
 *   render() twice does not replay them.
 * - dispose() releases GPU resources and leaves the context clean, so a new renderer can take the same canvas.
 */
export class YoyoRenderer implements YoyoRendererLike {
  onContextLost?: () => void;

  private readonly canvas: HTMLCanvasElement;
  private readonly adaptive: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, 0.5, 12);
  private readonly quality = new AdaptiveQuality(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);

  private framing: Framing = computeFraming(16 / 9);
  private cssWidth = 0;
  private cssHeight = 0;
  private deviceRatio = 1;
  private sizeDirty = true;
  private readonly resizeObserver: ResizeObserver | null;
  private contextLost = false;
  private disposed = false;

  // Shared uniforms: one object each, referenced by every material that needs it.
  private readonly uPx = { value: 0.0015 };

  // Scene objects.
  private readonly backdrop: THREE.Mesh;
  private readonly backdropRect = new THREE.Vector4();
  private readonly shadow: THREE.Mesh;
  private readonly shadowTexture: THREE.CanvasTexture;
  private readonly hand: THREE.Mesh;
  private readonly handUniforms: Record<string, THREE.IUniform>;
  private readonly guideMesh: THREE.Mesh;
  private readonly guideUniforms: Record<string, THREE.IUniform>;
  private readonly yoyo: THREE.Mesh;
  private readonly yoyoMaterial: YoyoMaterial;
  private readonly spinRing: THREE.Mesh;
  private readonly spinRingUniforms: Record<string, THREE.IUniform>;
  private readonly string: THREE.Mesh;
  private readonly stringMaterial: THREE.MeshStandardMaterial;
  private readonly tube = new StringTube();
  private readonly tieRing: THREE.Mesh;
  private readonly tieMaterial: THREE.MeshStandardMaterial;
  private readonly gripDisc: THREE.Mesh;
  private readonly dim: THREE.Mesh;
  private readonly dimUniforms: Record<string, THREE.IUniform>;
  private environment: THREE.WebGLRenderTarget | null = null;

  // Per-frame state.
  private readonly handPose: HandPose = createHandPose();
  private readonly guidePose: HandPose = createHandPose();
  private guide: FramingGuide | null = null;
  private readonly cues = new WeightCues();
  private readonly tension = new TensionTint();
  private readonly slack = new SlackSmoother();
  private bowSign = 1;
  private lastNowMs = 0;
  private hasFrame = false;
  private lastSnapshot: YoyoSnapshot | null = null;
  private tetherMs = Number.NEGATIVE_INFINITY;
  private popFrom = POP_FROM;
  private flash = 0;
  private handAlpha = 0;
  private warn = 0;
  private dimAmount = 0;
  private guideAlpha = 0;
  private ringAlpha = 0;
  /** Eased 0..1: how live the hand data is, for the tie ring's glow. */
  private tiePresence = 0;
  private reducedMotion = false;
  private readonly yoyoColor = new THREE.Color(DEFAULT_YOYO_COLOR);
  private lastRenderMs = 0;
  /** Smoothed time between rendered frames, ms: sets the width of the spin smear. */
  private frameTimeMs = 1000 / 60;

  // Scratch objects, reused every frame.
  private readonly offset: [number, number] = [0, 0];
  private readonly shake: [number, number] = [0, 0];
  private readonly neutral = new THREE.Color(STRING_NEUTRAL);
  private readonly warm = new THREE.Color(STRING_WARM);
  private readonly scratchRgb = { r: 0, g: 0, b: 0 };
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  private readonly direction = new THREE.Vector3();

  private readonly onLost = (event: Event) => {
    // Prevent the default so the browser may restore the context; the page decides what to do meanwhile.
    event.preventDefault();
    this.contextLost = true;
    this.onContextLost?.();
  };
  private readonly onRestored = () => {
    this.contextLost = false;
    // The generated environment lived in a GPU render target: it is gone and must be drawn again. The old
    // target is only forgotten, not disposed: its GL objects belonged to the lost context and deleting them
    // in the restored one is an INVALID_OPERATION.
    this.environment = null;
    this.buildEnvironment();
    this.sizeDirty = true;
    // Programs and buffers were lost with the context too: relink them now instead of in the middle of play.
    this.warmUp();
  };

  /**
   * @throws WebGLUnavailableError when no WebGL2 context can be created.
   */
  constructor(canvas: HTMLCanvasElement, options: YoyoRendererOptions = {}) {
    this.canvas = canvas;
    this.adaptive = options.adaptiveQuality ?? true;
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: options.antialias ?? true,
        alpha: false,
        stencil: false,
        powerPreference: 'high-performance',
      });
    } catch (cause) {
      throw new WebGLUnavailableError(cause);
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = TONE_EXPOSURE;
    this.renderer.setClearColor(0x080b10, 1);
    this.renderer.info.autoReset = true;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);

    this.buildEnvironment();
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;

    // --- backdrop (opaque, first, no depth) -------------------------------------------------------
    const backdropMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uRect: { value: this.backdropRect },
        uPx: this.uPx,
        uWallTop: { value: srgbColor(SCENE.wallTop) },
        uWallBottom: { value: srgbColor(SCENE.wallBottom) },
        uGlow: { value: srgbColor(SCENE.glow) },
        uFloorNear: { value: srgbColor(SCENE.floorNear) },
        uFloorFar: { value: srgbColor(SCENE.floorFar) },
        uLine: { value: srgbColor(SCENE.floorLine) },
      },
      vertexShader: BACKDROP_VERTEX,
      fragmentShader: BACKDROP_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backdropMaterial);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -1000;
    this.scene.add(this.backdrop);

    // --- blob shadow on the floor -----------------------------------------------------------------
    this.shadowTexture = YoyoRenderer.makeShadowTexture();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false, toneMapped: false, color: 0x000000 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.0008;
    this.shadow.renderOrder = -50;
    this.shadow.frustumCulled = false;
    this.shadow.visible = false;
    this.scene.add(this.shadow);

    // --- translucent hand -------------------------------------------------------------------------
    this.handUniforms = {
      uSeg: { value: this.handPose.seg },
      uRad: { value: this.handPose.rad },
      uCount: { value: 0 },
      uSmooth: { value: 0.01 },
      uArm: { value: new THREE.Vector4() },
      uArmRad: { value: new THREE.Vector2() },
      uTint: { value: srgbColor(SCENE.handTint) },
      uBright: { value: srgbColor(SCENE.handBright) },
      uWarm: { value: srgbColor(SCENE.handWarm) },
      uAlpha: { value: 0 },
      uFlash: { value: 0 },
      uWarn: { value: 0 },
      uPx: this.uPx,
    };
    this.hand = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.handUniforms,
        vertexShader: WORLD_QUAD_VERTEX,
        fragmentShader: HAND_FRAGMENT,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: HAND_DEPTH_FACTOR,
        polygonOffsetUnits: HAND_DEPTH_UNITS,
      }),
    );
    this.hand.renderOrder = -40;
    this.hand.frustumCulled = false;
    this.hand.visible = false;
    this.scene.add(this.hand);

    // --- framing guide ----------------------------------------------------------------------------
    this.guideUniforms = {
      uSeg: { value: this.guidePose.seg },
      uRad: { value: this.guidePose.rad },
      uCount: { value: 0 },
      uSmooth: { value: 0.01 },
      uCenter: { value: new THREE.Vector2() },
      uHalf: { value: new THREE.Vector2(0.2, 0.3) },
      uCorner: { value: 0.07 },
      uDashes: { value: 12 },
      uColor: { value: srgbColor(SCENE.guide) },
      uAlpha: { value: 0 },
      uPx: this.uPx,
    };
    this.guideMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.guideUniforms,
        vertexShader: WORLD_QUAD_VERTEX,
        fragmentShader: GUIDE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.guideMesh.renderOrder = -30;
    this.guideMesh.frustumCulled = false;
    this.guideMesh.visible = false;
    this.scene.add(this.guideMesh);

    // --- the yoyo ---------------------------------------------------------------------------------
    this.yoyoMaterial = createYoyoMaterial(DEFAULT_YOYO_COLOR);
    this.yoyo = new THREE.Mesh(createYoyoGeometry(), this.yoyoMaterial.material);
    this.yoyo.scale.setScalar(YOYO_VISUAL_RADIUS);
    this.yoyo.frustumCulled = false;
    this.yoyo.visible = false;
    this.scene.add(this.yoyo);

    // --- spin ring --------------------------------------------------------------------------------
    this.spinRingUniforms = {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uAlpha: { value: 0 },
      uBlur: { value: 0 },
      uAngle: { value: 0 },
      uRing: { value: (RING_RADIUS_FACTOR * YOYO_VISUAL_RADIUS) / RING_QUAD_HALF },
      uWidth: { value: RING_HALF_WIDTH_M / RING_QUAD_HALF },
    };
    this.spinRing = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.spinRingUniforms,
        vertexShader: WORLD_QUAD_VERTEX,
        fragmentShader: SPIN_RING_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.spinRing.scale.setScalar(2 * RING_QUAD_HALF);
    this.spinRing.position.z = SPIN_RING_Z;
    this.spinRing.renderOrder = 10;
    this.spinRing.frustumCulled = false;
    this.spinRing.visible = false;
    this.scene.add(this.spinRing);

    // --- string -----------------------------------------------------------------------------------
    this.stringMaterial = new THREE.MeshStandardMaterial({ color: STRING_NEUTRAL, roughness: 0.55, metalness: 0 });
    this.string = new THREE.Mesh(this.tube.geometry, this.stringMaterial);
    this.string.frustumCulled = false;
    this.string.visible = false;
    this.scene.add(this.string);

    // --- tie ring on the finger / grip marker for the mouse ---------------------------------------
    // Transparent from the start (toggling `transparent` later would force a shader recompile): the finger
    // ring keeps opacity 1, the mouse marker fades with the yoyo's distance.
    this.tieMaterial = new THREE.MeshStandardMaterial({
      color: RING_COLOR, emissive: RING_COLOR, emissiveIntensity: 0.55, metalness: 0.5, roughness: 0.35,
      transparent: true,
    });
    this.tieRing = new THREE.Mesh(new THREE.TorusGeometry(1, RING_TUBE_RATIO, 12, 40), this.tieMaterial);
    this.tieRing.frustumCulled = false;
    this.tieRing.visible = false;
    this.scene.add(this.tieRing);
    this.gripDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({ color: RING_COLOR, transparent: true, opacity: 0.16, depthWrite: false, depthTest: false, toneMapped: false }),
    );
    this.gripDisc.frustumCulled = false;
    this.gripDisc.visible = false;
    this.gripDisc.renderOrder = 19;
    this.scene.add(this.gripDisc);

    // --- pause dimming ----------------------------------------------------------------------------
    this.dimUniforms = { uColor: { value: new THREE.Color(0.02, 0.03, 0.045) }, uAlpha: { value: 0 } };
    this.dim = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.dimUniforms,
        vertexShader: BACKDROP_VERTEX,
        fragmentShader: FLAT_FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.dim.frustumCulled = false;
    this.dim.renderOrder = 100;
    this.dim.visible = false;
    this.scene.add(this.dim);

    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => { this.sizeDirty = true; });
    this.resizeObserver?.observe(canvas);
    // The body colour also tints the spin ring: derive it from the default so a renderer that is never told
    // a colour still looks right.
    this.setColor(DEFAULT_YOYO_COLOR);
    this.resize();
    this.warmUp();
  }

  // --- YoyoRendererLike -------------------------------------------------------------------------

  /** Pixel ratio currently used (adaptive quality), for diagnostics. */
  get pixelRatio(): number {
    return this.quality.ratio;
  }

  setColor(hex: string): void {
    if (typeof hex !== 'string' || !HEX.test(hex.trim())) return;
    this.yoyoColor.set(hex.trim());
    this.yoyoMaterial.material.color.copy(this.yoyoColor);
    // The ring around the yoyo is the body colour lifted toward white, in display-referred sRGB.
    this.yoyoColor.getRGB(this.scratchRgb, THREE.SRGBColorSpace);
    const lift = 0.5;
    setSrgb(
      this.spinRingUniforms.uColor.value as THREE.Color,
      [
        this.scratchRgb.r + (1 - this.scratchRgb.r) * lift,
        this.scratchRgb.g + (1 - this.scratchRgb.g) * lift,
        this.scratchRgb.b + (1 - this.scratchRgb.b) * lift,
      ],
    );
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.cues.setReducedMotion(reduced);
  }

  setGuide(guide: FramingGuide | null): void {
    const valid = guide !== null
      && Number.isFinite(guide.center[0] + guide.center[1] + guide.halfSize[0] + guide.halfSize[1])
      && guide.halfSize[0] > 0.01 && guide.halfSize[1] > 0.01;
    this.guide = valid ? { center: [guide.center[0], guide.center[1]], halfSize: [guide.halfSize[0], guide.halfSize[1]] } : null;
    if (this.guide) this.buildGuide(this.guide);
  }

  resize(): void {
    this.syncSize(true);
  }

  visibleWorld(): WorldRect {
    const { rect } = this.framing;
    return { left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top };
  }

  render(snapshot: YoyoSnapshot, nowMs: number): void {
    if (this.disposed || this.contextLost) return;
    const cpuStart = performance.now();
    if (this.sizeDirty || this.resizeObserver === null || window.devicePixelRatio !== this.deviceRatio) this.syncSize(false);
    if (this.cssWidth === 0 || this.cssHeight === 0) return;

    const interval = this.hasFrame ? nowMs - this.lastNowMs : 1000 / 60;
    const dt = Number.isFinite(interval) ? clamp(interval, 0, MAX_DT_MS) : 1000 / 60;
    this.lastNowMs = nowMs;
    this.hasFrame = true;
    if (Number.isFinite(interval) && interval > 0 && interval <= 250) {
      this.frameTimeMs = clamp(approach(this.frameTimeMs, interval, interval, FRAME_TIME_TAU_MS), FRAME_TIME_MIN_MS, FRAME_TIME_MAX_MS);
    }

    if (snapshotIsFinite(snapshot)) this.update(snapshot, nowMs, dt);
    this.renderer.render(this.scene, this.camera);

    if (this.adaptive && this.quality.sample(interval)) this.applySize();
    this.lastRenderMs = performance.now() - cpuStart;
  }

  /** Counters of the last frame. */
  stats(): RenderStats {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      lastRenderMs: this.lastRenderMs,
    };
  }

  /** The GPU the browser reports (e.g. "ANGLE (Apple, …)"), or 'unavailable'. */
  rendererName(): string {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  }

  /**
   * Releases GPU resources and listeners and leaves the WebGL context in its initial state. The context
   * itself is kept, so the same canvas can be handed to a new renderer (React StrictMode mounts twice);
   * drop the canvas element to free the context.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        if (object.geometry !== this.tube.geometry) object.geometry.dispose();
        const material = object.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((m) => m.dispose()); else material.dispose();
      }
    });
    this.tube.dispose();
    this.shadowTexture.dispose();
    this.environment?.dispose();
    this.environment = null;
    this.scene.environment = null;
    const gl = this.renderer.getContext();
    this.renderer.dispose();
    // Leave the context as a new renderer on the same canvas expects to find it (React StrictMode).
    if (!this.contextLost && !gl.isContextLost()) resetContextState(gl as WebGL2RenderingContext);
  }

  // --- internals --------------------------------------------------------------------------------

  /**
   * Gets every shader and buffer ready before the first real frame.
   *
   * Why: three compiles a program the first time an object using it is drawn, and links and uploads lazily
   * on first use. Hidden objects (the yoyo before the tie-on, the guide, the pause dimming) would therefore
   * cost a stalled frame the first time they appear, and for the yoyo that is exactly the moment of the
   * "snap". So: request every program now (browsers with parallel shader compilation do it off the main
   * thread), then draw everything once so each is linked and uploaded, then draw the clean idle backdrop.
   * All of it happens inside one task, so the compositor can only ever present that last clean frame.
   */
  private warmUp(): void {
    this.renderer.compile(this.scene, this.camera);
    const objects = this.scene.children;
    const visibility = objects.map((object) => object.visible);
    for (const object of objects) object.visible = true;
    this.renderer.render(this.scene, this.camera);
    objects.forEach((object, i) => { object.visible = visibility[i]; });
    this.renderer.render(this.scene, this.camera);
  }

  /** Generates the lighting locally: three's RoomEnvironment through PMREM, no HDRI file. */
  private buildEnvironment(): void {
    this.environment?.dispose();
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    room.dispose();
    pmrem.dispose();
  }

  private static makeShadowTexture(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(0.35, 'rgba(0,0,0,0.62)');
      gradient.addColorStop(0.7, 'rgba(0,0,0,0.18)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /** Reads the canvas size and the device ratio and applies them; cheap when nothing changed. */
  private syncSize(force: boolean): void {
    const width = Math.round(this.canvas.clientWidth);
    const height = Math.round(this.canvas.clientHeight);
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    const changed = force || width !== this.cssWidth || height !== this.cssHeight || ratio !== this.deviceRatio;
    this.sizeDirty = false;
    if (!changed) return;
    if (ratio !== this.deviceRatio) this.quality.setDeviceRatio(ratio);
    this.deviceRatio = ratio;
    this.cssWidth = width;
    this.cssHeight = height;
    if (width === 0 || height === 0) return;
    this.framing = computeFraming(width / height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(this.framing.centerX, this.framing.centerY, this.framing.distance);
    this.applySize();
  }

  /** Applies the current pixel ratio to the drawing buffer and refreshes the pixel size uniform. */
  private applySize(): void {
    this.renderer.setPixelRatio(this.quality.ratio);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    const { rect } = this.framing;
    this.uPx.value = (rect.top - rect.bottom) / (this.cssHeight * this.quality.ratio);
  }

  private buildGuide(guide: FramingGuide): void {
    const [cx, cy] = guide.center;
    const [hx, hy] = guide.halfSize;
    const u = this.guideUniforms;
    (u.uCenter.value as THREE.Vector2).set(cx, cy);
    (u.uHalf.value as THREE.Vector2).set(hx, hy);
    const corner = Math.min(0.08, 0.35 * Math.min(hx, hy));
    u.uCorner.value = corner;
    const quarter = (hx - corner) + 1.5707963 * corner + (hy - corner);
    u.uDashes.value = Math.max(4, Math.round(quarter / 0.045));
    // A ghost hand fitted inside the outline, with margin.
    const marginX = 2 * hx * 0.8;
    const marginY = 2 * hy * 0.8;
    const widthUnits = TEMPLATE_MAX_U - TEMPLATE_MIN_U + 0.24;
    const heightUnits = TEMPLATE_MAX_V + 0.2;
    const palm = Math.min(marginX / widthUnits, marginY / heightUnits);
    const k = palm / Math.hypot(0.09, 1.0);
    // Centre the template's box on the guide: its centre is at (u, v) = (0.2, 0.93) palm units.
    const hand = templateHand(cx + (0.09 - 0.2) * k, cy + (1.0 - 0.93) * k, palm);
    buildHandPose(this.guidePose, hand, 0, 0, false, palm);
    u.uCount.value = this.guidePose.count;
    u.uSmooth.value = this.guidePose.smooth;
    this.guideMesh.position.set(cx, cy, 0);
    this.guideMesh.scale.set(2 * hx + 0.14, 2 * hy + 0.14, 1);
  }

  /** One frame of scene state from a snapshot; draws nothing. */
  private update(s: YoyoSnapshot, nowMs: number, dt: number): void {
    // The yoyo exists (is tied on) in every phase but 'untethered'; no physics ran before that.
    const tied = s.phase !== 'untethered';
    const px = s.pivot[0];
    const py = s.pivot[1];

    // Events first: they decide this frame's effects. A snapshot handed over twice (a paused page that
    // re-renders) must not replay its events.
    const liveX = s.yoyo[0] - px;
    const liveY = s.yoyo[1] - py;
    if (s !== this.lastSnapshot) {
      this.lastSnapshot = s;
      for (const event of s.events) {
        switch (event.kind) {
          case 'snap': this.cues.snap(nowMs, event.strength, liveX, liveY); break;
          case 'catch': this.cues.catchYoyo(nowMs, event.strength, liveX, liveY); this.flash = 1; break;
          case 'tether': this.tetherMs = nowMs; this.popFrom = POP_FROM; this.flash = 1; break;
          case 'retether': this.tetherMs = nowMs; this.popFrom = RETETHER_POP_FROM; this.flash = Math.max(this.flash, 0.6); break;
          default: break;
        }
      }
    }
    this.flash *= Math.exp(-dt / FLASH_TAU_MS);
    if (this.flash < 0.002) this.flash = 0;

    // Pose to draw: hit-stop holds the yoyo's offset from the pivot, the snap stretches the string a hair.
    this.cues.pose(nowMs, liveX, liveY, this.offset);
    const yx = px + this.offset[0];
    const yy = py + this.offset[1];

    // Camera: shake displaces it a few millimetres; the backdrop follows so the floor shakes with the scene.
    this.cues.shake(nowMs, this.shake);
    const cam = this.framing;
    this.camera.position.set(cam.centerX + this.shake[0], cam.centerY + this.shake[1], cam.distance);
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    this.backdropRect.set(camX - cam.halfWidth, camX + cam.halfWidth, camY - cam.halfHeight, camY + cam.halfHeight);

    // Hand or grip marker.
    const landmarks = isDrawableHand(s.hand.landmarks) ? s.hand.landmarks : null;
    // Before the yoyo is tied on there is no pivot yet: the hand is drawn where it was tracked. Once tied, the
    // whole silhouette is shifted so landmark 9 sits on the (smoothed) pivot and the string stays on the finger.
    const handDrawn = landmarks !== null
      && buildHandPose(this.handPose, landmarks, px, py, tied, s.hand.palmWorld);
    this.updateHand(s, handDrawn, dt);

    // Yoyo, string, ring, shadow.
    const chord = Math.hypot(yx - px, yy - py);
    this.updateYoyo(s, tied, yx, yy, nowMs, dt);
    this.updateString(s, tied, handDrawn, px, py, yx, yy, chord, dt);
    this.updateTieRing(s, tied, handDrawn, px, py, chord, dt);
    this.updateShadow(tied, yx, yy);

    // Guide and pause dimming.
    this.guideAlpha = approach(this.guideAlpha, this.guide ? 1 : 0, dt, GUIDE_TAU_MS);
    const pulse = this.reducedMotion ? 1 : 0.84 + 0.16 * Math.sin((2 * Math.PI * nowMs) / GUIDE_PULSE_MS);
    this.guideUniforms.uAlpha.value = this.guideAlpha * pulse;
    this.guideMesh.visible = this.guideAlpha > 0.003;
    this.dimAmount = approach(this.dimAmount, s.paused ? 1 : 0, dt, DIM_TAU_MS);
    this.dimUniforms.uAlpha.value = this.dimAmount * PAUSE_DIM;
    this.dim.visible = this.dimAmount > 0.003;
  }

  private updateHand(s: YoyoSnapshot, drawn: boolean, dt: number): void {
    const u = this.handUniforms;
    const target = s.hand.present ? 1 : STALE_HAND_ALPHA;
    this.handAlpha = approach(this.handAlpha, drawn ? target : 0, dt, HAND_PRESENCE_TAU_MS);
    this.warn = approach(this.warn, s.hand.edge !== null && s.hand.present ? 1 : 0, dt, HAND_PRESENCE_TAU_MS);
    // Fading out (the hand vanished, e.g. a mouse session after a camera one) keeps drawing the last pose.
    this.hand.visible = drawn || this.handAlpha > 0.01;
    u.uAlpha.value = this.handAlpha;
    u.uFlash.value = this.flash;
    u.uWarn.value = this.warn;
    if (!drawn) return;
    const pose = this.handPose;
    u.uCount.value = pose.count;
    u.uSmooth.value = pose.smooth;
    (u.uArm.value as THREE.Vector4).set(pose.arm[0], pose.arm[1], pose.arm[2], pose.arm[3]);
    (u.uArmRad.value as THREE.Vector2).set(pose.arm[4], pose.arm[5]);
    this.hand.position.x = (pose.minX + pose.maxX) / 2;
    this.hand.position.y = (pose.minY + pose.maxY) / 2;
    this.hand.scale.set(pose.maxX - pose.minX, pose.maxY - pose.minY, 1);
  }

  private updateYoyo(s: YoyoSnapshot, tied: boolean, yx: number, yy: number, nowMs: number, dt: number): void {
    this.yoyo.visible = tied;
    if (!tied) {
      this.ringAlpha = 0;
      this.spinRing.visible = false;
      return;
    }
    const exhausted = s.phase === 'exhausted';
    const omega = exhausted ? 0 : Math.max(0, s.spin);
    const smear = Math.min(MAX_SMEAR, omega * Math.max(MIN_SHUTTER_S, this.frameTimeMs / 1000));
    const streak = smoothstep01((smear - STREAK_FROM) / (STREAK_TO - STREAK_FROM));
    const turn = 2 * Math.PI;
    const angle = ((s.spinAngle % turn) + turn) % turn;
    const face = this.yoyoMaterial.uniforms;
    face.uSpinAngle.value = angle;
    face.uSmear.value = smear;
    face.uStreak.value = streak;

    const pop = this.reducedMotion ? 1 : popScale(nowMs - this.tetherMs, this.popFrom);
    this.yoyo.position.set(yx, yy, 0);
    this.yoyo.scale.setScalar(YOYO_VISUAL_RADIUS * pop);

    const ringTarget = exhausted ? 0 : smoothstep01((omega - RING_SPIN_FROM) / (RING_SPIN_FULL - RING_SPIN_FROM)) * RING_MAX_ALPHA;
    this.ringAlpha = approach(this.ringAlpha, ringTarget, dt, RING_ALPHA_TAU_MS);
    this.spinRing.visible = this.ringAlpha > 0.004;
    this.spinRing.position.set(yx, yy, SPIN_RING_Z);
    this.spinRing.scale.setScalar(2 * RING_QUAD_HALF * pop);
    this.spinRingUniforms.uAlpha.value = this.ringAlpha;
    this.spinRingUniforms.uBlur.value = smoothstep01((smear - 0.5) / 2);
    this.spinRingUniforms.uAngle.value = angle;
  }

  private updateString(
    s: YoyoSnapshot, tied: boolean, handDrawn: boolean, px: number, py: number, yx: number, yy: number, chord: number, dt: number,
  ): void {
    this.string.visible = tied;
    if (!tied) {
      this.slack.reset();
      this.tension.reset();
      return;
    }
    // Slack only counts when the model says the string is slack; the smoother keeps a string that hovers at
    // the taut/slack boundary from flickering between a line and a bow.
    const slack = this.slack.step(s.slack ? Math.max(0, s.length - chord) : 0, dt);
    const path = this.tube.path;
    // Tie point: the ring on the finger when there is a hand, else the pivot (mouse grip).
    path[0] = handDrawn ? this.handPose.ringX : px;
    path[1] = handDrawn ? this.handPose.ringY : py;
    this.bowSign = sampleString(path, CURVE_POINTS, px, py, yx, yy, chord + slack, this.bowSign, FLOOR_CLEARANCE_M, 1);
    this.tube.update();

    const tint = this.tension.step(s.tension, dt);
    this.stringMaterial.color.lerpColors(this.neutral, this.warm, tint * STRING_TINT_MAX);
    this.stringMaterial.emissive.copy(this.stringMaterial.color).multiplyScalar(0.2);
  }

  private updateTieRing(s: YoyoSnapshot, tied: boolean, handDrawn: boolean, px: number, py: number, chord: number, dt: number): void {
    const pulse = this.reducedMotion ? 0 : this.flash;
    if (handDrawn && tied) {
      const pose = this.handPose;
      this.tieRing.visible = true;
      this.tieMaterial.depthTest = true;
      this.tieMaterial.depthWrite = true;
      this.tieMaterial.opacity = 1;
      this.tieRing.renderOrder = 0;
      this.gripDisc.visible = false;
      this.tieRing.position.set(pose.ringX, pose.ringY, RING_Z);
      this.direction.set(pose.ringDirX * Math.cos(RING_TILT_RAD), pose.ringDirY * Math.cos(RING_TILT_RAD), Math.sin(RING_TILT_RAD));
      this.tieRing.quaternion.setFromUnitVectors(this.zAxis, this.direction);
      this.tieRing.scale.setScalar(pose.ringRadius * (1 + 0.25 * pulse));
    } else if (!handDrawn && (s.hand.present || tied)) {
      // Mouse path: a small ring at the pivot, facing the camera and always on top of the yoyo, so the
      // pointer never disappears behind the body that hangs from it.
      this.tieRing.visible = true;
      this.tieMaterial.depthTest = false;
      this.tieMaterial.depthWrite = false;
      this.tieMaterial.opacity = GRIP_MIN_OPACITY + (1 - GRIP_MIN_OPACITY) * smoothstep01((chord - GRIP_NEAR_M) / (GRIP_CLEAR_M - GRIP_NEAR_M));
      this.tieRing.renderOrder = 20;
      this.gripDisc.visible = true;
      this.tieRing.position.set(px, py, RING_Z);
      this.tieRing.quaternion.identity();
      const radius = GRIP_RADIUS * (1 + 0.3 * pulse);
      this.tieRing.scale.setScalar(radius);
      this.gripDisc.position.set(px, py, RING_Z - 0.001);
      this.gripDisc.scale.setScalar(radius);
    } else {
      this.tieRing.visible = false;
      this.gripDisc.visible = false;
    }
    // Glows less when the hand data is stale (eased, like the hand), brighter on tether and catch.
    this.tiePresence = approach(this.tiePresence, s.hand.present ? 1 : 0, dt, HAND_PRESENCE_TAU_MS);
    this.tieMaterial.emissiveIntensity = 0.2 + 0.35 * this.tiePresence + 0.9 * this.flash;
  }

  private updateShadow(tied: boolean, yx: number, yy: number): void {
    this.shadow.visible = tied;
    if (!tied) return;
    const height = Math.max(0, yy);
    const radius = YOYO_VISUAL_RADIUS * SHADOW_RADIUS_FACTOR * (1 + SHADOW_SPREAD_PER_M * height);
    this.shadow.position.x = yx;
    this.shadow.scale.set(2 * radius, 2 * radius, 1);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = SHADOW_OPACITY * Math.exp(-height / SHADOW_FADE_M);
  }
}
