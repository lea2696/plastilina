import { ClaySolver } from '../simulation/ClaySolver';
import { Studio } from '../rendering/Studio';
import { CameraTracking } from '../tracking/CameraTracking';
import { HandMapper } from '../interaction/HandMapper';
import { HandInteraction } from '../interaction/HandInteraction';
import { PointerTool, type PointerMode } from '../interaction/PointerTool';
import { replayHand, replayTwoHands } from '../diagnostics/replay';
import { ClayAudio } from '../audio/ClayAudio';
import type { HandCollider, HandFrame, MappedHand } from '../shared/contracts';

export type AppMode = 'idle' | 'loading' | 'permission-pending' | 'calibrating' | 'intro' | 'active' | 'tracking-degraded' | 'paused' | 'unsupported' | 'error';
export type InputSource = 'camera' | 'replay' | 'mouse';

const STEP = 1 / 120;
const MAX_STEPS_PER_FRAME = 4;
const RESOLUTION = 6;
const SETTLE_STEPS = 180;
const INTRO_MS = 2500;
const SIGNAL_LOST_MS = 200;

function cameraMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Permiso rechazado. Habilitá la cámara en el navegador o probá con el mouse.';
    if (error.name === 'NotFoundError') return 'No se encontró una cámara. Podés probar con el mouse o mirar la demo sintética.';
    if (error.name === 'NotReadableError') return 'La cámara está ocupada o no responde. Cerrá otras apps e intentá de nuevo.';
  }
  return error instanceof Error ? error.message : String(error);
}

function settledSolver() {
  const solver = new ClaySolver(RESOLUTION);
  for (let i = 0; i < SETTLE_STEPS; i++) solver.step(STEP);
  return solver;
}

export class MasaEngine {
  solver = settledSolver();
  readonly studio: Studio;
  readonly audio = new ClayAudio();
  camera?: CameraTracking;
  mode: AppMode = 'idle';
  source: InputSource | null = null;
  fps = 0;
  onChange?: (mode: AppMode, detail: string) => void;

  private mapper = new HandMapper();
  private interaction = new HandInteraction();
  private pointer = new PointerTool();
  private readonly qaMode = new URLSearchParams(location.search).get('qa');
  private hands: MappedHand[] = [];
  private raf = 0;
  private last = 0;
  private accumulator = 0;
  private lastFrameMs = -Infinity;
  private introStart = 0;
  private introCues = 0;
  private replayLast = 0;
  private inferenceMs = 0;
  private frames = 0;
  private fpsStart = 0;
  private intervals: number[] = [];
  private calibrationFrames: HandFrame[] = [];
  private totalContacts = 0;
  private graphicsLost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.studio = new Studio(canvas, this.solver);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerUp);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', this.contextMenu);
    document.addEventListener('visibilitychange', this.visibility);
    this.raf = requestAnimationFrame(this.loop);
  }

  private get running() { return (this.mode === 'active' || this.mode === 'tracking-degraded') && !document.hidden; }

  private setMode(mode: AppMode, detail = '') { this.mode = mode; this.onChange?.(mode, detail); }

  private clearInput() {
    this.mapper.reset();
    this.interaction.reset();
    this.pointer.end();
    this.hands = [];
  }

  private startIntro(detail: string) {
    this.introStart = performance.now();
    this.introCues = 0;
    this.setMode('intro', detail);
  }

  private receive = (actualFrame: HandFrame, inferenceMs = 0) => {
    const frame = this.qaMode === 'combined-two-hands' ? replayTwoHands(actualFrame.timestampMs) : actualFrame;
    if (frame.timestampMs <= this.lastFrameMs) return;
    this.inferenceMs = inferenceMs;
    this.lastFrameMs = frame.timestampMs;
    if (this.mode === 'calibrating') this.calibrate(frame);
    this.hands = this.mapper.consume(frame);
  };

  /** Calibrate once a hand has stayed roughly still for 600 ms. */
  private calibrate(frame: HandFrame) {
    if (!frame.hands.length) { this.calibrationFrames = []; return; }
    this.calibrationFrames.push(frame);
    this.calibrationFrames = this.calibrationFrames.filter(f => frame.timestampMs - f.timestampMs < 1000);
    const first = this.calibrationFrames[0], wrist = frame.hands[0].landmarks[0];
    const still = this.calibrationFrames.every(f => Math.hypot(f.hands[0].landmarks[0].x - wrist.x, f.hands[0].landmarks[0].y - wrist.y) < 0.08);
    if (first && frame.timestampMs - first.timestampMs >= 600 && still) {
      this.mapper.calibrate(frame);
      this.calibrationFrames = [];
      this.startIntro('Listo. Acercá la mano a la cámara para tocar la masa.');
    }
  }

  async startCamera() {
    this.stopCamera();
    this.source = 'camera';
    this.audio.unlock();
    this.setMode('permission-pending', 'Esperando permiso de cámara');
    const camera = new CameraTracking();
    this.camera = camera;
    camera.onStatus = status => {
      if (this.camera !== camera) return;
      if (status.includes('modelo')) this.setMode('loading', status);
      if (status === 'Cámara lista') {
        if (this.qaMode) {
          // QA hands are synthetic: pose them over the clay like the replay demo.
          if (this.qaMode === 'combined-two-hands') this.mapper.calibrate(replayTwoHands(0), { wristY: 0.62, depth: 0.02 });
          this.setMode('active', 'Modo QA: cámara y manos sintéticas; no valida manos reales');
        }
        else this.setMode('calibrating', 'Mostrá una mano quieta, a la distancia cómoda de siempre');
      }
    };
    camera.onFrame = this.receive;
    camera.onError = message => {
      if (this.camera !== camera) return;
      camera.stop();
      this.camera = undefined;
      this.source = null;
      this.clearInput();
      this.setMode('error', `Seguimiento: ${message}`);
    };
    try { await camera.start(); } catch (error) {
      if (this.camera === camera) this.setMode('error', cameraMessage(error));
      camera.stop();
    }
  }

  startReplay() {
    this.stopCamera();
    this.source = 'replay';
    this.audio.unlock();
    this.mapper = new HandMapper();
    // Synthetic hand hangs above the clay and presses its top.
    this.mapper.calibrate(replayHand(0), { wristY: 0.62, depth: 0.02 });
    this.interaction.reset();
    this.lastFrameMs = -Infinity;
    this.startIntro('Demostración con puntos sintéticos; no valida webcam');
  }

  startMouse() {
    this.stopCamera();
    this.source = 'mouse';
    this.audio.unlock();
    this.clearInput();
    this.startIntro('Modo mouse: arrastrá con click izquierdo para estirar, con click derecho (o Shift) para presionar y amasar. La rueda acerca o aleja.');
  }

  skipIntro() {
    if (this.mode !== 'intro') return;
    const detail = this.source === 'replay' ? 'Demostración sintética'
      : this.source === 'mouse' ? 'Modo mouse activo: click izquierdo estira, click derecho o Shift presiona, rueda ajusta profundidad'
        : 'Interacción activa: acercá la mano a la cámara para tocar; pellizcá o cerrá el puño sobre la masa para agarrar';
    this.setMode('active', detail);
  }

  pause() {
    if (this.mode === 'paused') {
      this.setMode('active', 'Reanudado');
      this.audio.resume();
      this.last = performance.now();
      this.accumulator = 0;
    } else {
      this.pointer.end();
      this.setMode('paused', 'Simulación pausada');
      this.audio.pause();
    }
  }

  reset() {
    this.solver = settledSolver();
    this.interaction.reset();
    this.pointer.end();
    this.mapper.reset();
    this.hands = [];
    this.accumulator = 0;
  }

  recalibrate() {
    if (this.source !== 'camera' || !this.camera) return;
    this.clearInput();
    this.calibrationFrames = [];
    this.setMode('calibrating', 'Mostrá una mano quieta, a la distancia cómoda de siempre');
  }

  stopCamera() {
    this.camera?.stop();
    this.camera = undefined;
    if (this.source === 'camera') {
      this.source = null;
      this.clearInput();
      this.setMode('idle', 'Cámara apagada');
    }
  }

  mute(muted: boolean) { this.audio.setMuted(muted); }
  volume(value: number) { this.audio.setVolume(value); }
  darkMode(enabled: boolean) { this.studio.setDarkMode(enabled); }
  setClayColor(color: string) { this.studio.setClayColor(color); }

  private ndc(event: PointerEvent | WheelEvent): [number, number] {
    const rect = this.studio.canvas.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1];
  }

  /** The mouse works in every running mode, also alongside the camera. It only starts on the clay. */
  private pointerDown = (event: PointerEvent) => {
    if (!this.running || this.pointer.active) return;
    const mode: PointerMode = event.button === 2 || event.shiftKey ? 'press' : event.button === 0 ? 'grab' : 'press';
    const ndc = this.ndc(event), hit = this.studio.pickClay(ndc);
    if (hit === null) return;
    event.preventDefault();
    this.studio.canvas.setPointerCapture(event.pointerId);
    this.audio.unlock();
    this.pointer.begin(mode, ndc, hit, performance.now());
    this.studio.canvas.style.cursor = mode === 'grab' ? 'grabbing' : 'crosshair';
  };

  private pointerMove = (event: PointerEvent) => {
    if (this.pointer.active) { this.pointer.move(this.ndc(event)); return; }
    // Hover hint: show that the clay can be taken only where the cursor is over it.
    this.studio.canvas.style.cursor = this.running && this.studio.pickClay(this.ndc(event)) !== null ? 'grab' : '';
  };

  private pointerUp = (event: PointerEvent) => {
    if (!this.pointer.active) return;
    if (this.studio.canvas.hasPointerCapture(event.pointerId)) this.studio.canvas.releasePointerCapture(event.pointerId);
    this.pointer.end();
    this.studio.canvas.style.cursor = '';
  };

  private wheel = (event: WheelEvent) => {
    if (!this.pointer.active) return;
    event.preventDefault();
    this.pointer.wheel(event.deltaY);
  };

  private contextMenu = (event: Event) => { if (this.running) event.preventDefault(); };

  private visibility = () => {
    if (document.hidden) {
      this.audio.pause();
      this.pointer.end();
      this.last = performance.now();
      this.accumulator = 0;
    } else if (this.mode !== 'paused') {
      this.audio.resume();
      this.last = performance.now();
    }
  };

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.graphicsLost = true;
    this.stopCamera();
    this.audio.pause();
    this.setMode('error', 'Se perdió el dispositivo gráfico. Recargá la página para reintentar.');
  };

  private updateTrackingState(now: number) {
    if (this.source === 'replay' && this.mode !== 'paused' && now - this.replayLast > 33) {
      this.replayLast = now;
      this.receive(replayHand(now));
    }
    if (this.source === 'replay') this.hands = this.mapper.fresh(now);
    if (this.source === 'camera' && (this.mode === 'active' || this.mode === 'tracking-degraded')) {
      this.hands = this.mapper.fresh(now);
      const lost = now - this.lastFrameMs > SIGNAL_LOST_MS;
      if (lost && this.mode === 'active') this.setMode('tracking-degraded', 'Se perdió el seguimiento; la masa queda libre');
      else if (!lost && this.mode === 'tracking-degraded') this.setMode('active', 'Seguimiento recuperado');
    }
  }

  private updateIntro(now: number) {
    const elapsed = now - this.introStart;
    if (this.introCues === 0) { this.audio.event({ timestampMs: now, kind: 'intro', intensity: 0.35 }); this.introCues++; }
    if (this.introCues === 1 && elapsed > 850) { this.audio.event({ timestampMs: now, kind: 'intro', intensity: 0.55 }); this.introCues++; }
    if (this.introCues === 2 && elapsed > 2200) { this.audio.event({ timestampMs: now, kind: 'land', intensity: 0.45 }); this.introCues++; }
    if (elapsed > INTRO_MS || matchMedia('(prefers-reduced-motion: reduce)').matches) this.skipIntro();
  }

  private simulate(now: number, delta: number) {
    this.accumulator = Math.min(this.accumulator + delta, MAX_STEPS_PER_FRAME * STEP);
    const input = this.interaction.build(now, this.hands, this.solver.positions, this.solver.indices);
    const pointer = this.pointer.collider(now, ndc => this.studio.ray(ndc));
    const colliders: HandCollider[] = pointer ? [...input.colliders, pointer] : [...input.colliders];
    const byId = new Map(colliders.map(c => [c.id, c]));
    for (let steps = 0; this.accumulator >= STEP && steps < MAX_STEPS_PER_FRAME; steps++) {
      this.solver.step(STEP, colliders);
      this.totalContacts += this.solver.contactCount;
      let motion = 0;
      for (const id of this.solver.contactColliderIds) {
        const c = byId.get(id);
        if (c) motion = Math.max(motion, Math.hypot(...c.velocity));
      }
      if (this.solver.contactCount > 0 && motion > 0.025) {
        const kind = this.solver.graspCount ? 'stretch' : motion > 0.1 ? 'knead' : 'press';
        this.audio.event({ timestampMs: now, kind, intensity: Math.min(0.8, motion * 0.7 + this.solver.contactCount / 160) });
      }
      this.accumulator -= STEP;
    }
    // Render actual solver contact, not just the tracked landmarks or a requested
    // grasp which failed to acquire material.
    this.hands = input.hands.map((hand): MappedHand => {
      const contactPoints = new Set<number>();
      let touching = false;
      for (const id of this.solver.contactColliderIds) {
        const c = byId.get(id);
        if (c?.handId !== hand.id) continue;
        touching = true;
        for (const landmark of c.landmarks ?? []) contactPoints.add(landmark);
      }
      const grasp = this.solver.hasGrasp(`${hand.id}-grasp`);
      return { ...hand, contactPoints: [...contactPoints], state: grasp ? 'grasp' : touching ? 'contact' : 'free' };
    });
    const held = pointer?.grasp ? this.solver.hasGrasp(pointer.id) : false;
    this.studio.setPointer(pointer ? pointer.center : null, pointer?.radius, held);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.last) this.last = now;
    const delta = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    if (delta > 0) { this.intervals.push(delta * 1000); if (this.intervals.length > 600) this.intervals.shift(); }

    this.updateTrackingState(now);
    if (this.mode === 'intro') this.updateIntro(now);
    if (this.running) this.simulate(now, delta);
    else { this.accumulator = 0; this.studio.setPointer(null); }

    if (!this.graphicsLost) {
      const showHands = this.mode === 'calibrating' || this.mode === 'active' || this.mode === 'tracking-degraded';
      // The clay is always on the table; the intro is now only a short audio cue before input starts.
      this.studio.update(this.solver, showHands ? this.hands : []);
      this.studio.render();
    }
    this.frames++;
    if (now - this.fpsStart > 1000) {
      this.fps = Math.round(this.frames * 1000 / (now - this.fpsStart));
      this.frames = 0;
      this.fpsStart = now;
      if (this.running) this.studio.sampleFps(this.fps);
    }
  };

  diagnostics() {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const pct = (q: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10 : null;
    return {
      fps: this.fps,
      frameP95Ms: pct(0.95),
      frameP99Ms: pct(0.99),
      simSteps: this.solver.version,
      inferenceMs: this.inferenceMs,
      ageMs: Number.isFinite(this.lastFrameMs) ? Math.round(performance.now() - this.lastFrameMs) : null,
      volume: this.solver.surfaceVolume(),
      contacts: this.solver.contactCount,
      grasps: this.solver.graspCount,
      vertices: this.solver.positions.length / 3,
      totalContacts: this.totalContacts,
      invertedTets: this.solver.invertedTetCount(),
      handDepth: this.hands.map(h => Math.round(h.points[0][2] * 100) / 100),
      proximity: this.hands.map(h => Math.round((h.proximity ?? 0) * 100) / 100),
      source: this.source,
      qaMode: this.qaMode,
      webglRenderer: this.studio.rendererInfo(),
      renderPixelRatio: this.studio.pixelRatio(),
    };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    const canvas = this.studio.canvas;
    document.removeEventListener('visibilitychange', this.visibility);
    canvas.removeEventListener('webglcontextlost', this.contextLost);
    canvas.removeEventListener('pointerdown', this.pointerDown);
    canvas.removeEventListener('pointermove', this.pointerMove);
    canvas.removeEventListener('pointerup', this.pointerUp);
    canvas.removeEventListener('pointercancel', this.pointerUp);
    canvas.removeEventListener('wheel', this.wheel);
    canvas.removeEventListener('contextmenu', this.contextMenu);
    this.stopCamera();
    this.audio.close();
    this.studio.dispose();
  }
}
