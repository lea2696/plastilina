import type { HandFrame } from '../../shared/contracts';
import { CameraTracking } from '../../tracking/CameraTracking';
import { YoyoAudio } from '../audio/YoyoAudio';
import { DEFAULT_VOLUME } from '../audio/YoyoAudioGraph';
import { CONFIG_FIELDS, createConfig, setConfigValue, type Preset, type YoyoConfig } from '../config';
import type { FrameEdge, InputSource, Vec2, YoyoPhase, YoyoSnapshot } from '../contracts';
import { WebGLUnavailableError, YOYO_COLORS, YoyoRenderer } from '../render/YoyoRenderer';
import { downloadReplay, ReplayRecorder } from '../replay/ReplayRecorder';
import { buildDemoSession, DEMO_SEED } from '../replay/sessions';
import { snapToField } from '../ui/format';
import {
  cameraErrorMessage, GRAPHICS_FAILED_MESSAGE, GRAPHICS_LOST_MESSAGE, trackingErrorMessage, UNEXPECTED_MESSAGE, WEBGL_UNAVAILABLE_MESSAGE,
} from './cameraErrors';
import { DemoPlayer, type DemoClip } from './demoPlayer';
import { buildDiagnostics, buildMetricsExport, formatDiagnostics, type Diagnostics } from './diagnostics';
import { downloadJson, timestampedFilename } from './download';
import {
  canPause, EDGE_HOLD_MS, EMPTY_RECORDER, handState, HAND_LOST_HOLD_MS, initialState, trackingQuality,
  type EngineMode, type EngineState, type RecorderState,
} from './engineState';
import { FRAMING_TIMEOUT_MS, framingZone, guideForZone, measureHand, type HandMeasure } from './framing';
import { idleSnapshot } from './idleScene';
import { PointerInput } from './PointerInput';
import { POINTER_DIRECT, pointerFeel, PointerMappingTracker } from './pointerMapping';
import { createQaReplay, qaFramesFor, qaModeFromSearch, type QaMode, type QaReplay } from './qaHook';
import { ReleaseDelay } from './releaseDelay';
import { FpsMeter, RollingWindow } from './stats';
import { Store } from './store';
import { webgl2Available } from './webgl';
import { YoyoRuntime } from './YoyoRuntime';
import type { TetherZone } from './TetherDetector';

/** Frame intervals kept for the p95: about six seconds at 60 Hz. */
const FRAME_WINDOW = 360;
/** Rings of the measurements that only come with intents or camera frames. */
const EVENT_WINDOW = 128;
/** Longest frame step counted toward the framing timeout, so a frozen page does not burn the ten seconds. */
const MAX_FRAMING_STEP_MS = 100;
/** The recorder's counters reach the UI this often while it records. */
const RECORDER_SYNC_MS = 333;
/** Phases remembered in `data-trail`: enough for several full rounds of the game. */
const TRAIL_LENGTH = 16;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Attributes the engine keeps on the root element, for tests and styling. */
const ATTRIBUTES = ['mode', 'source', 'phase', 'hand', 'edge'] as const;
type AttributeName = typeof ATTRIBUTES[number];

/**
 * Everything the page does that is not drawing React: it owns the renderer, the audio, the runtime of the
 * current source (camera, mouse or demo), the camera, the pointer layer, the demo player and the recorder,
 * and runs the one requestAnimationFrame loop.
 *
 * Rules the whole file follows:
 * - One clock. Every frame starts with `now = performance.now()` (not the rAF timestamp, which is the frame's
 *   start on another base) and that value feeds the pointer poll, `runtime.advance`, `renderer.render` and
 *   `audio.update`. Camera frames are stamped with `performance.now()` when they arrive, which is when the
 *   app could first use them (the capture time inside the frame stays what the camera reported).
 * - No React state per frame. The UI reads `getState()` through `useSyncExternalStore` and hears about
 *   discrete changes only: mode, phase, hand present/lost (held 300 ms), edge, message, recorder, settings.
 *   Per-frame data (snapshots, spin) never leaves this class except as pixels and sound.
 * - Tests read attributes on the root element (`data-mode`, `data-source`, `data-phase`, `data-hand`,
 *   `data-edge`, `data-qa`, `data-trail`), written synchronously on change. No window globals.
 * - One opt-in test hook, `?qa=camera-replay` (qaHook.ts): the camera path plays a synthetic session of hands.
 *   Without that query value nothing about it runs.
 * - Nothing leaves the page and nothing is stored: no network, no localStorage, sessionStorage or
 *   IndexedDB. Files are produced only by explicit clicks (`downloadRecording`, `exportMetrics`).
 */
export class YoyoEngine {
  /** The QA hook this page was opened with (`?qa=camera-replay`, see qaHook.ts), or null: the normal case. */
  private readonly qa: QaMode | null = typeof location === 'undefined' ? null : qaModeFromSearch(location.search);
  private readonly store = new Store<EngineState>(initialState(YOYO_COLORS[0].value, DEFAULT_VOLUME, this.qa));
  readonly getState = this.store.getState;
  readonly subscribe = this.store.subscribe;

  private readonly renderer: YoyoRenderer | null = null;
  private readonly audio = new YoyoAudio();
  private readonly pointer: PointerInput;
  private readonly pointerMapping = new PointerMappingTracker();
  /** The mapping is recomputed when the canvas is resized, at a press and at a catch, not every frame. */
  private pointerMappingDirty = true;
  private canvasResizes: ResizeObserver | null = null;
  /** Where the button last went down (canvas heights): the world is homed there. Null until the first press. */
  private pressImage: Vec2 | undefined;
  private readonly recorder = new ReplayRecorder();
  private readonly motionQuery: MediaQueryList | null;

  private config: YoyoConfig = this.store.getState().config;
  private runtime: YoyoRuntime | null = null;
  private source: InputSource | null = null;
  private camera: CameraTracking | undefined;
  private demo: DemoPlayer | null = null;
  private demoClip: DemoClip | null = null;
  /** QA hook only: the session the camera frames carry instead of hands, and when the camera became ready (its clock). */
  private qaReplay: QaReplay | null = null;
  private qaReadyAtMs = 0;
  private zone: TetherZone = framingZone('standing');

  private userPaused = false;
  private hidden = typeof document !== 'undefined' && document.hidden;
  /** Mode to go back to when the person resumes. */
  private resumeMode: EngineMode = 'playing';
  private graphicsLost = false;
  private crashed = false;
  private disposed = false;
  private raf = 0;

  // Per-frame bookkeeping.
  /** Previous frame's `performance.now()` (the framing timer) and rAF timestamp (the frame-interval statistics). */
  private lastFrameMs: number | null = null;
  private lastRafMs: number | null = null;
  private skipInterval = true;
  private framingMs = 0;
  private lastPhase: YoyoPhase | null = null;
  private trail: YoyoPhase[] = [];
  private handSeen = false;
  private readonly handHold = new ReleaseDelay<true>(HAND_LOST_HOLD_MS);
  private readonly edgeHold = new ReleaseDelay<FrameEdge>(EDGE_HOLD_MS);
  private lastRecorderSyncMs = -Infinity;
  private lastMeasure: HandMeasure | null = null;
  private gpu: string | null = null;
  private readonly attributes: Record<AttributeName, string> = { mode: '', source: '', phase: '', hand: '', edge: '' };

  // Diagnostics: fixed rings, always collecting, summarised on demand.
  private readonly fps = new FpsMeter(1000);
  private readonly frameMs = new RollingWindow(FRAME_WINDOW);
  private readonly startLagMs = new RollingWindow(FRAME_WINDOW);
  private readonly physicsMs = new RollingWindow(FRAME_WINDOW);
  private readonly renderMs = new RollingWindow(FRAME_WINDOW);
  private readonly latencyMs = new RollingWindow(EVENT_WINDOW);
  private readonly captureToArrivalMs = new RollingWindow(EVENT_WINDOW);
  private readonly inferenceMs = new RollingWindow(EVENT_WINDOW);

  constructor(private readonly canvas: HTMLCanvasElement, private readonly root: HTMLElement) {
    this.pointer = new PointerInput(canvas, {
      now: () => performance.now(),
      // Inside the press handler, i.e. inside the gesture: audio may start (a later press retries if the first was refused).
      onPress: (position) => {
        this.audio.unlock();
        // Every press homes the world at its own position, before the first sample of the press is handled.
        this.pressImage = position;
        this.refreshPointerMapping(this.runtime);
      },
    });
    this.motionQuery = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY) : null;

    if (!webgl2Available()) {
      this.commit({ mode: 'unsupported', detail: WEBGL_UNAVAILABLE_MESSAGE, fatal: true });
      return;
    }
    try {
      this.renderer = new YoyoRenderer(canvas);
    } catch (error) {
      this.renderer = null;
      const message = error instanceof WebGLUnavailableError ? WEBGL_UNAVAILABLE_MESSAGE : GRAPHICS_FAILED_MESSAGE;
      this.commit({ mode: 'unsupported', detail: message, fatal: true });
      return;
    }

    this.renderer.onContextLost = this.onContextLost;
    if (typeof ResizeObserver !== 'undefined') {
      this.canvasResizes = new ResizeObserver(() => { this.pointerMappingDirty = true; });
      this.canvasResizes.observe(canvas);
    }
    this.renderer.setColor(this.store.getState().color);
    this.renderer.setReducedMotion(this.motionQuery?.matches ?? false);
    this.motionQuery?.addEventListener('change', this.onMotionChange);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    // Only a page opened with the QA hook says so; a normal page has no such attribute.
    if (this.qa !== null) root.dataset.qa = this.qa;
    this.syncAttributes();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------------------------

  /**
   * «Comenzar con cámara». The audio is unlocked first and synchronously, before anything is awaited: a
   * browser lets a context start only while the click that asked for it is fresh.
   */
  async startCamera(): Promise<void> {
    this.audio.unlock();
    if (this.renderer === null || this.disposed || this.graphicsLost) return;
    this.teardown();
    const camera = new CameraTracking({ frameSync: 'video-frame' });
    this.camera = camera;
    this.commit({ mode: 'permission-pending', source: 'camera', detail: 'Esperando permiso de cámara', fatal: false });
    // QA hook: built before the camera starts, so its few milliseconds never fall between «ready» and the first frame.
    if (this.qa !== null) this.qaReplay = createQaReplay();

    camera.onStatus = (status) => {
      if (this.camera !== camera) return;
      if (status.includes('modelo')) this.commit({ mode: 'loading', detail: status });
      if (status === 'Cámara lista') this.enterFraming();
    };
    camera.onFrame = (frame, inferenceMs) => {
      if (this.camera === camera) this.onCameraFrame(frame, inferenceMs);
    };
    camera.onError = (message) => {
      if (this.camera === camera) this.failCamera(trackingErrorMessage(message));
    };
    try {
      await camera.start();
    } catch (error) {
      if (this.camera === camera) this.failCamera(cameraErrorMessage(error));
      else camera.stop();
    }
  }

  /** «Probar con mouse»: the pointer is the hand (PRD §4.5). */
  startMouse(): void {
    this.audio.unlock();
    if (this.renderer === null || this.disposed || this.graphicsLost) return;
    this.teardown();
    const runtime = this.attach('mouse');
    this.pressImage = undefined;
    this.pointerMapping.reset();
    this.pointerMappingDirty = true;
    this.refreshPointerMapping(runtime);
    this.commit({ mode: 'mouse', detail: '', fatal: false });
    this.syncPointerSink();
  }

  /** «Ver demo»: a synthetic camera session replayed in real time, looping. */
  startDemo(): void {
    this.audio.unlock();
    if (this.renderer === null || this.disposed || this.graphicsLost) return;
    this.teardown();
    this.attach('replay');
    // The clip is deterministic and costs a few milliseconds to build: once per page is plenty.
    this.demoClip ??= buildDemoSession(DEMO_SEED);
    this.demo = new DemoPlayer(this.demoClip);
    this.demo.start(performance.now());
    this.commit({ mode: 'demo', detail: '', fatal: false });
  }

  /** «Cancelar» while the permission or the model is pending: back to the start screen. */
  cancelStart(): void {
    if (this.store.getState().mode === 'permission-pending' || this.store.getState().mode === 'loading') this.stopCamera();
  }

  /** «Apagar cámara»: stops the camera and the model and goes back to the start screen. */
  stopCamera(): void {
    if (this.source !== 'camera' && this.camera === undefined) return;
    this.teardown();
    this.commit({ mode: 'idle', detail: '', fatal: false });
  }

  /**
   * «Volver al inicio»: ends whatever runs (the mouse and the demo have no other way out) and shows the start
   * screen again, ready to pick another way in.
   */
  backToStart(): void {
    if (this.runtime === null && this.camera === undefined) return;
    this.teardown();
    this.commit({ mode: 'idle', detail: '', fatal: false });
  }

  /** «Reintentar» after a failure only a reload can fix. */
  retry(): void {
    location.reload();
  }

  // ---------------------------------------------------------------------------------------------
  // Framing (PRD §3.2)
  // ---------------------------------------------------------------------------------------------

  /**
   * The camera is ready: show the outline and let the yoyo tie on only with the anchor inside it. After
   * FRAMING_TIMEOUT_MS, or on «Omitir», it ties on wherever the hand is and the world re-homes there.
   * Nothing technical is shown; palm size and height are measured only for the diagnostics.
   */
  private enterFraming(): void {
    if (this.renderer === null || this.camera === undefined) return;
    const runtime = this.attach('camera');
    this.zone = framingZone(this.config.preset);
    runtime.setTetherZone(this.zone);
    this.renderer.setGuide(guideForZone(this.config, this.zone));
    this.framingMs = 0;
    // The camera's clock for the QA hook starts now; frames only flow from here on.
    this.qaReadyAtMs = performance.now();
    this.qaReplay?.reset();
    this.commit({ mode: 'framing', detail: '', fatal: false });
  }

  /** «Omitir»: tie on anywhere. */
  skipFraming(): void {
    if (this.store.getState().mode !== 'framing') return;
    this.runtime?.setTetherZone(null);
    this.renderer?.setGuide(null);
    this.commit({ mode: 'playing' });
  }

  /** «Recalibrar»: the yoyo unties and the outline comes back. Resumes first if the person had paused. */
  recalibrate(): void {
    const state = this.store.getState();
    const runtime = this.runtime;
    if (this.source !== 'camera' || runtime === null || this.renderer === null) return;
    if (state.mode !== 'playing' && state.mode !== 'framing' && state.mode !== 'paused') return;
    if (state.mode === 'paused') {
      this.userPaused = false;
      this.applyPause(performance.now());
    }
    runtime.recalibrate();
    this.zone = framingZone(this.config.preset);
    runtime.setTetherZone(this.zone);
    this.renderer.setGuide(guideForZone(this.config, this.zone));
    this.framingMs = 0;
    this.resetObservation();
    this.commit({ mode: 'framing' });
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  /** Pausar / Reanudar. Nothing simulates while paused, and the time spent paused is never simulated afterwards. */
  togglePause(): void {
    const state = this.store.getState();
    if (this.runtime === null || !canPause(state.mode)) return;
    const now = performance.now();
    if (state.mode === 'paused') {
      this.userPaused = false;
      this.applyPause(now);
      this.commit({ mode: this.resumeMode });
    } else {
      this.resumeMode = state.mode;
      this.userPaused = true;
      this.applyPause(now);
      this.commit({ mode: 'paused' });
    }
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.commit({ muted });
  }

  /** 0..1 */
  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : DEFAULT_VOLUME));
    this.audio.setVolume(clamped);
    this.commit({ volume: clamped });
  }

  /** The yoyo's body colour. Ephemeral: it is not stored anywhere. */
  setColor(hex: string): void {
    this.renderer?.setColor(hex);
    this.commit({ color: hex });
  }

  /**
   * De pie / Sentado. Starts from the preset's own config again (an edit made on top of the other preset
   * would not mean the same thing), keeping the two switches, and moves the framing zone with it.
   */
  setPreset(preset: Preset): void {
    if (preset === this.config.preset) return;
    const next = createConfig(preset);
    next.responsiveness = this.config.responsiveness;
    next.yoyo.autoReturn = this.config.yoyo.autoReturn;
    this.zone = framingZone(preset);
    this.applyConfig(next);
    if (this.store.getState().mode === 'framing') this.runtime?.setTetherZone(this.zone);
  }

  /** A live edit from «Avanzado». The value is clamped and snapped to the field's range and step. */
  setField(key: string, value: number): void {
    const field = CONFIG_FIELDS.find(f => f.key === key);
    if (field === undefined) return;
    const snapped = snapToField(value, field);
    if (snapped === null) return;
    this.applyConfig(setConfigValue(this.config, key, snapped));
  }

  /** «Restablecer»: every tunable, and the two switches, back to the preset's defaults. */
  resetConfig(): void {
    this.applyConfig(createConfig(this.config.preset));
  }

  setAutoReturn(enabled: boolean): void {
    const next = structuredClone(this.config);
    next.yoyo.autoReturn = enabled;
    this.applyConfig(next);
  }

  /** «Modo no responsivo (experimental)»: the tug no longer brings the yoyo back (the bind comes in a later phase). */
  setResponsive(responsive: boolean): void {
    const next = structuredClone(this.config);
    next.responsiveness = responsive ? 'responsive' : 'unresponsive';
    this.applyConfig(next);
  }

  /** Gives the runtime the new config first: one that cannot work throws and leaves everything as it was. */
  private applyConfig(next: YoyoConfig): void {
    try {
      this.runtime?.setConfig(next);
    } catch {
      return;
    }
    this.config = next;
    this.commit({ config: next });
    // The outline is drawn through the config's world scale.
    if (this.store.getState().mode === 'framing') this.renderer?.setGuide(guideForZone(next, this.zone));
  }

  // ---------------------------------------------------------------------------------------------
  // Recording and export (explicit clicks only)
  // ---------------------------------------------------------------------------------------------

  /** «Grabar landmarks»: only with the camera up. Landmarks only, never images, in memory. */
  startRecording(): void {
    const state = this.store.getState();
    if (this.source !== 'camera' || (state.mode !== 'framing' && state.mode !== 'playing' && state.mode !== 'paused')) return;
    this.recorder.start();
    this.syncRecorder(performance.now(), true);
  }

  stopRecording(): void {
    this.recorder.stop();
    this.syncRecorder(performance.now(), true);
  }

  /** Forgets the recording: it exists only in memory, and this empties it. */
  discardRecording(): void {
    this.recorder.clear();
    this.syncRecorder(performance.now(), true);
  }

  /** «Descargar JSON»: the one place a recording leaves memory, as a local file the person saves. */
  downloadRecording(note: string): void {
    if (this.recorder.frameCount === 0) return;
    downloadReplay(this.recorder.toFile(this.config, note), timestampedFilename('yoyo-replay'));
  }

  /** «Exportar métricas»: counters and measurements of this session as a local JSON file. */
  exportMetrics(): void {
    const runtime = this.runtime;
    if (runtime === null) return;
    const now = performance.now();
    const file = buildMetricsExport(runtime.metrics.snapshot(now), this.diagnostics(now), {
      source: this.source, preset: this.config.preset, responsiveness: this.config.responsiveness,
    });
    downloadJson(file, timestampedFilename('yoyo-metricas'));
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------------------------

  /** The measurements as numbers; the panel and the export are both built from this. */
  diagnostics(now = performance.now()): Diagnostics {
    const state = this.store.getState();
    const renderer = this.renderer;
    this.gpu ??= renderer?.rendererName() ?? null;
    return buildDiagnostics({
      source: this.source,
      mode: state.mode,
      phase: state.phase,
      fps: this.fps.fps,
      frameMs: this.frameMs,
      startLagMs: this.startLagMs,
      physicsMs: this.physicsMs,
      renderMs: this.renderMs,
      latencyMs: this.latencyMs,
      captureToArrivalMs: this.captureToArrivalMs,
      inferenceMs: this.inferenceMs,
      runtime: this.runtime?.diagnostics ?? null,
      metrics: this.runtime?.metrics.snapshot(now) ?? null,
      pixelRatio: renderer?.pixelRatio ?? null,
      gpu: this.gpu,
      drawCalls: renderer?.stats().drawCalls ?? null,
      hand: this.lastMeasure,
    });
  }

  /** The text of the diagnostics `<output>`. */
  diagnosticsText(): string {
    return formatDiagnostics(this.diagnostics());
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.canvasResizes?.disconnect();
    this.teardown();
    this.pointer.dispose();
    this.audio.close();
    this.renderer?.dispose();
  }

  // ---------------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------------

  /** `rafMs` is the timestamp rAF passes: the frame's begin time. `now` (performance.now) is the simulation's clock. */
  private readonly loop = (rafMs: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    try {
      this.frame(now, rafMs);
    } catch (error) {
      this.crash(error);
    }
  };

  private frame(now: number, rafMs: number): void {
    const renderer = this.renderer;
    if (renderer === null) return;

    // Frame cadence is measured on the rAF timestamp, the frame's begin time aligned with the compositor: what the
    // person sees, and what Masa reports. performance.now() at the start of the callback also carries the main
    // thread's dispatch jitter, which is 0.7–1 ms at p95 even on an empty page (measured), so intervals taken from
    // it read ~17.4 ms where the cadence is 16.7. That jitter is reported on its own, as `startLagMs`.
    // A frame after the tab was hidden (or the very first) measures nothing but the gap.
    if (this.lastRafMs !== null && !this.skipInterval) {
      this.frameMs.push(rafMs - this.lastRafMs);
      this.startLagMs.push(now - rafMs);
    }
    this.lastRafMs = rafMs;
    this.fps.tick(rafMs);
    // The framing timer is simulation time, so it stays on the simulation's clock.
    const stepMs = this.lastFrameMs === null ? 0 : now - this.lastFrameMs;
    this.skipInterval = false;
    this.lastFrameMs = now;

    const runtime = this.runtime;
    let snapshot: YoyoSnapshot;
    if (runtime !== null) {
      this.feedInputs(runtime, now);
      this.checkFramingTimeout(stepMs);
      const before = performance.now();
      snapshot = runtime.advance(now);
      this.physicsMs.push(performance.now() - before);
      this.observe(snapshot, now);
      this.audio.update(snapshot, now);
    } else {
      // Start screen (and the wait for the camera): the sleeper hanging from the top. No runtime, no physics.
      snapshot = idleSnapshot(now, renderer.visibleWorld(), this.motionQuery?.matches ?? false);
    }

    const renderStart = performance.now();
    renderer.render(snapshot, now);
    const renderEnd = performance.now();
    this.renderMs.push(renderEnd - renderStart);
    if (runtime !== null && this.source !== 'replay') this.recordLatency(snapshot, renderEnd);

    // After the render, which is where the renderer learns the canvas's new size. No observer: every frame.
    if (this.pointerMappingDirty || this.canvasResizes === null) this.refreshPointerMapping(runtime);
    this.syncRecorder(now, false);
  }

  /** What the source owes the runtime this frame. Camera frames arrive by callback instead. */
  private feedInputs(runtime: YoyoRuntime, now: number): void {
    if (this.source === 'mouse') {
      this.pointer.poll(now);
    } else if (this.source === 'replay' && this.demo !== null) {
      const poll = this.demo.poll(now);
      // Every pass starts from the same state as the first (see DemoPlayer): the tie-on is part of the show.
      if (poll.restarted) {
        runtime.recalibrate();
        this.resetObservation();
      }
      for (const { frame, arrivalMs } of poll.frames) runtime.pushFrame(frame, arrivalMs);
    }
  }

  private checkFramingTimeout(stepMs: number): void {
    if (this.store.getState().mode !== 'framing') return;
    this.framingMs += Math.min(stepMs, MAX_FRAMING_STEP_MS);
    if (this.framingMs >= FRAMING_TIMEOUT_MS) this.skipFraming();
  }

  /**
   * Turns the snapshot into the few discrete facts the UI shows, and publishes only what changed. The hand
   * and the edge are held for a moment so a dropped frame does not flash «Mano perdida» or the vignette.
   */
  private observe(snapshot: YoyoSnapshot, now: number): void {
    const state = this.store.getState();
    // The facts first, as plain values: most frames change none of them, and a frame must not allocate for that.
    // The two holds see every frame (they count time), changed or not.
    if (snapshot.hand.present) this.handSeen = true;
    const held = this.handHold.update(snapshot.hand.present ? true : null, now) === true;
    const hand = handState(held, this.handSeen);
    const edge = this.edgeHold.update(snapshot.hand.edge, now);
    const tracking = trackingQuality(hand, snapshot.hand.lostMs);
    const phaseChanged = snapshot.phase !== this.lastPhase;

    if (this.source === 'mouse' && snapshot.events.some(event => event.kind === 'retether')) this.rehomePointer();
    if (!phaseChanged && hand === state.hand && edge === state.edge && tracking === state.tracking) return;

    const changes: Partial<EngineState> = {};
    if (phaseChanged) {
      this.lastPhase = snapshot.phase;
      changes.phase = snapshot.phase;
      this.trail.push(snapshot.phase);
      if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
      this.root.dataset.trail = this.trail.join(' ');
      // The yoyo tied on: the outline has done its job.
      if (state.mode === 'framing' && snapshot.phase !== 'untethered') {
        this.renderer?.setGuide(null);
        changes.mode = 'playing';
      }
    }
    if (hand !== state.hand) changes.hand = hand;
    if (edge !== state.edge) changes.edge = edge;
    if (tracking !== state.tracking) changes.tracking = tracking;
    this.commit(changes);
  }

  /** Reaction time of launches and tugs: from the capture of the input that caused them to just after the frame that shows them. */
  private recordLatency(snapshot: YoyoSnapshot, renderedMs: number): void {
    for (const event of snapshot.events) {
      if ((event.kind === 'launch' || event.kind === 'tug') && event.causeMs !== undefined) this.latencyMs.push(renderedMs - event.causeMs);
    }
  }

  /**
   * The pointer path maps canvas heights to world metres through what the renderer shows (see pointerMapping.ts for
   * why it is homed at the press, high on the screen, with a gain below one). Refreshed when the layout moves and at
   * every press.
   */
  private refreshPointerMapping(runtime: YoyoRuntime | null): void {
    if (this.source !== 'mouse' || runtime === null || this.renderer === null) return;
    this.pointerMappingDirty = false;
    const mapping = this.pointerMapping.update(this.renderer.visibleWorld(), this.canvas.clientWidth, this.canvas.clientHeight, pointerFeel(this.pressImage));
    if (mapping !== null) runtime.setPointerMapping(mapping);
  }

  /**
   * The yoyo was caught: homes the world again at wherever the cursor is, so the next throw starts as high as the
   * first. Without it every round would leave the pivot a little lower (the drag down is longer than the tug up)
   * and the sleeper would creep off the bottom of the screen after two or three throws.
   */
  private rehomePointer(): void {
    const at = this.pointer.position;
    if (POINTER_DIRECT || at === null) return;
    this.pressImage = at;
    this.refreshPointerMapping(this.runtime);
  }

  // ---------------------------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------------------------

  /**
   * A camera frame has just arrived: stamped on the engine's clock, then handed to the runtime and, if asked for,
   * the recorder. Under the QA hook the frame is only the clock: what goes down the pipeline are the session's frames
   * that are due (see qaHook.ts); the measurements of the real frame (capture to arrival, inference) stay as they are.
   */
  private onCameraFrame(frame: HandFrame, inferenceMs: number): void {
    const arrival = performance.now();
    this.captureToArrivalMs.push(arrival - frame.timestampMs);
    this.inferenceMs.push(inferenceMs);
    const runtime = this.runtime;
    if (runtime === null) return;
    if (this.qaReplay === null) {
      this.deliverCameraFrame(runtime, frame, arrival);
    } else if (!this.userPaused && !this.hidden) {
      for (const replaced of qaFramesFor(this.qaReplay, frame, this.qaReadyAtMs)) this.deliverCameraFrame(runtime, replaced, arrival);
    }
  }

  private deliverCameraFrame(runtime: YoyoRuntime, frame: HandFrame, arrival: number): void {
    const measure = measureHand(frame);
    if (measure !== null) this.lastMeasure = measure;
    // Paused or hidden: the runtime would ignore the frame, and a recording must hold what the classifier saw.
    if (this.userPaused || this.hidden) return;
    runtime.pushFrame(frame, arrival);
    if (this.recorder.recording) this.recorder.add(frame, arrival);
  }

  /** The camera or the model failed: stop everything it owned and say why, ready for another try. */
  private failCamera(message: string): void {
    this.teardown();
    this.commit({ mode: 'error', detail: message, fatal: false });
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime bookkeeping
  // ---------------------------------------------------------------------------------------------

  /** Creates the runtime of a source and makes it the current one. */
  private attach(source: InputSource): YoyoRuntime {
    const runtime = new YoyoRuntime(this.config, source);
    // What the live classifier fires while recording goes into the file as «detected» (not ground truth).
    runtime.onIntent = (event) => {
      if (this.recorder.recording) this.recorder.markDetected(event.kind, event.timestampMs);
    };
    this.runtime = runtime;
    this.source = source;
    this.userPaused = false;
    this.resetObservation();
    this.commit({ source, phase: 'untethered', detail: '', fatal: false });
    return runtime;
  }

  /** Forgets what the UI was told about the hand and the phase: a new session or a new pass starts with nothing. */
  private resetObservation(): void {
    this.lastPhase = null;
    this.trail = [];
    this.root.dataset.trail = '';
    this.handSeen = false;
    this.handHold.reset();
    this.edgeHold.reset();
    this.commit({ phase: this.runtime === null ? null : 'untethered', hand: 'none', edge: null, tracking: 'none' });
  }

  /** Ends the current source and everything it owned. The caller sets the next mode. */
  private teardown(): void {
    const camera = this.camera;
    // Cleared first: the camera announces «apagada» while it stops, and nobody should answer that.
    this.camera = undefined;
    camera?.stop();
    this.recorder.stop();
    this.runtime = null;
    this.demo = null;
    this.qaReplay = null;
    this.source = null;
    this.userPaused = false;
    this.lastMeasure = null;
    this.pointer.setSink(null);
    this.renderer?.setGuide(null);
    // A new source starts with sound running again, unless the tab is hidden (then the visibility handler resumes it).
    if (!this.hidden) this.audio.resume();
    this.pointerMapping.reset();
    this.resetObservation();
    this.syncRecorder(performance.now(), true);
    this.commit({ source: null, phase: null });
  }

  /** Pause state of everything that follows the runtime: the person's pause and a hidden tab both stop it. */
  private applyPause(now: number): void {
    const paused = this.userPaused || this.hidden;
    this.runtime?.pause(paused, now);
    if (paused) {
      this.audio.suspend();
      this.demo?.hold(now);
    } else {
      this.audio.resume();
      this.demo?.release(now);
    }
    this.syncPointerSink();
  }

  /** The pointer drives the mouse runtime while it runs; paused or in another mode it is ignored. */
  private syncPointerSink(): void {
    const live = this.source === 'mouse' && this.runtime !== null && !this.userPaused && !this.hidden;
    this.pointer.setSink(live ? this.runtime : null);
  }

  private syncRecorder(now: number, force: boolean): void {
    const recorder = this.recorder;
    const current = this.store.getState().recorder;
    const next: RecorderState = { recording: recorder.recording, frames: recorder.frameCount, durationMs: recorder.durationMs, full: recorder.full };
    const same = current.recording === next.recording && current.frames === next.frames
      && current.durationMs === next.durationMs && current.full === next.full;
    if (same) return;
    // The counters tick up to 30 times a second; the UI hears about them ~3 times, and at once when the state itself changes.
    if (!force && current.recording === next.recording && now - this.lastRecorderSyncMs < RECORDER_SYNC_MS) return;
    this.lastRecorderSyncMs = now;
    this.commit({ recorder: next.frames === 0 && !next.recording && !next.full ? EMPTY_RECORDER : next, hasRecording: next.frames > 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // State and attributes
  // ---------------------------------------------------------------------------------------------

  /** Publishes changes to the UI and mirrors the ones tests look at onto the root element. */
  private commit(changes: Partial<EngineState>): void {
    if (this.store.patch(changes)) this.syncAttributes();
  }

  private syncAttributes(): void {
    const s = this.store.getState();
    const next: Record<AttributeName, string> = {
      mode: s.mode, source: s.source ?? 'none', phase: s.phase ?? 'none', hand: s.hand, edge: s.edge ?? 'none',
    };
    for (const name of ATTRIBUTES) {
      if (this.attributes[name] === next[name]) continue;
      this.attributes[name] = next[name];
      this.root.dataset[name] = next[name];
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Browser events
  // ---------------------------------------------------------------------------------------------

  /** A hidden tab stops the runtime and the sound; coming back resumes without the hidden time (the step clock restarts). */
  private readonly onVisibility = (): void => {
    this.hidden = document.hidden;
    this.skipInterval = true;
    this.fps.reset();
    this.applyPause(performance.now());
  };

  /** Losing focus mid-drag would leave the button «held» for a hand nobody is moving. */
  private readonly onBlur = (): void => {
    this.pointer.release(performance.now());
  };

  private readonly onMotionChange = (event: MediaQueryListEvent): void => {
    this.renderer?.setReducedMotion(event.matches);
  };

  /** The GPU device went away: nothing can be drawn, so say so. Only a reload is promised; a restore clears it. */
  private readonly onContextLost = (): void => {
    this.graphicsLost = true;
    this.teardown();
    this.commit({ mode: 'error', detail: GRAPHICS_LOST_MESSAGE, fatal: true });
  };

  private readonly onContextRestored = (): void => {
    if (!this.graphicsLost) return;
    this.graphicsLost = false;
    this.commit({ mode: 'idle', detail: '', fatal: false });
  };

  /** The loop threw: log it once, stop, and tell the person. Never loop on an exception. */
  private crash(error: unknown): void {
    if (this.crashed) return;
    this.crashed = true;
    cancelAnimationFrame(this.raf);
    console.error('[yoyo] the frame loop stopped:', error);
    this.teardown();
    this.commit({ mode: 'error', detail: UNEXPECTED_MESSAGE, fatal: true });
  }
}
