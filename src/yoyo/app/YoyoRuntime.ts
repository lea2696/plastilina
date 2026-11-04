import type { HandFrame } from '../../shared/contracts';
import type { YoyoConfig } from '../config';
import type {
  AnchorSample, ArmedIntents, FrameEdge, HandView, InputSource, IntentEvent, Vec2, WorldMapping,
  YoyoEvent, YoyoEventKind, YoyoRuntimeLike, YoyoSnapshot,
} from '../contracts';
import { AnchorExtractor } from '../perception/AnchorExtractor';
import { IntentClassifier } from '../perception/IntentClassifier';
import { PinStabilizer, type PinSample } from '../perception/PinStabilizer';
import { landmarksToWorld, mappingFromHome, toWorld } from '../perception/worldMapping';
import { YoyoModel, type StepInput } from '../sim/YoyoModel';
import { FixedStep } from './FixedStep';
import { MetricsRecorder } from './MetricsRecorder';
import { DEFAULT_HOME_IMAGE, TetherDetector, zoneCentre, type StableHand, type TetherZone } from './TetherDetector';

export { DEFAULT_HOME_IMAGE, DEFAULT_TETHER_ZONE, type TetherZone } from './TetherDetector';

/**
 * Inputs waiting for their arrival time. Past this the oldest are dropped (and counted): a stalled
 * main thread must come back to where the hand is now, not replay a backlog (DECISIONS.md, «colas acotadas»).
 */
export const MAX_QUEUED_INPUTS = 8;

/** Counters for the diagnostics panel. Never sent anywhere. */
export interface RuntimeDiagnostics {
  /** Inputs dropped because the queue was full, since construction. */
  queueDrops: number;
  /** Most inputs that ever waited at once: never above MAX_QUEUED_INPUTS. */
  queuePeak: number;
  /** Wall time the step cap threw away, summed over the whole session, ms. */
  droppedMs: number;
  /** Fixed steps run (the pivot steps even before the yoyo is tied on; the model does not). */
  stepsTotal: number;
  /** Age of the newest sample at the last advance, ms; Infinity before the first one. */
  lastSampleAgeMs: number;
}

/**
 * What `YoyoRuntime.diagnostics` actually carries: the panel's counters (the stable contract, which the
 * panel's own code is typed against) plus a measurement that stability checks need.
 */
export interface RuntimeDiagnosticsDetail extends RuntimeDiagnostics {
  /**
   * The fastest the yoyo moved, m/s, at any of the physics steps the last `advance` ran, counting its speed
   * as the advance began; 0 when the advance ran no step (or the yoyo is not tied on).
   *
   * Why it exists: in a render frame the yoyo moves at most this × (steps × step) (plus a millimetre of
   * rounding in the constraint). A bound built from the speeds at the two ends of the frame alone is wrong
   * whenever the speed peaks inside it: a string that goes taut and snaps the yoyo back, followed by free
   * flight, moves it further than either end velocity says.
   */
  lastAdvancePeakSpeed: number;
}

/** One waiting input. The queue owns a fixed set of these and refills them; nothing is allocated per input. */
interface QueuedInput {
  kind: 'frame' | 'pointer';
  /** When the app received it: the input is handled by the first fixed step that ends at or after this time. */
  arrivalMs: number;
  frame: HandFrame | null;
  /** Pointer inputs: the sample, or null for the button going up. */
  sample: AnchorSample | null;
  /** Pointer inputs: capture time of a button-up (a sample carries its own). */
  timeMs: number;
}

/**
 * The mapping already in use when the new one is the same; otherwise the new one. A tuning edit that
 * does not touch the world (a launch threshold) must not make the pivot re-acquire the hand, and the
 * pivot reads «the mapping changed» as an object comparison.
 */
function sameOrNew(current: WorldMapping, next: WorldMapping): WorldMapping {
  const same = current.scale === next.scale
    && current.homeImage[0] === next.homeImage[0] && current.homeImage[1] === next.homeImage[1]
    && current.homeWorld[0] === next.homeWorld[0] && current.homeWorld[1] === next.homeWorld[1];
  return same ? current : next;
}

function sameZone(a: TetherZone | null, b: TetherZone | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

const emptyInput = (): QueuedInput => ({ kind: 'frame', arrivalMs: 0, frame: null, sample: null, timeMs: 0 });

/** Drops what an input points at, so a slot waiting for reuse keeps no frame alive. */
function release(slot: QueuedInput): void {
  slot.frame = null;
  slot.sample = null;
}

/**
 * Fixed-capacity FIFO of inputs. Memory is the same however long the session runs and however
 * badly the consumer stalls; when it is full the oldest input goes (it describes where the hand
 * was, and a newer one says where it is).
 */
class InputQueue {
  drops = 0;
  peak = 0;
  private readonly slots: QueuedInput[] = Array.from({ length: MAX_QUEUED_INPUTS }, emptyInput);
  private head = 0;
  private count = 0;

  get length(): number {
    return this.count;
  }

  /** Arrival time of the oldest waiting input, Infinity when there is none. */
  get nextArrivalMs(): number {
    return this.count > 0 ? this.slots[this.head].arrivalMs : Infinity;
  }

  push(kind: QueuedInput['kind'], arrivalMs: number, frame: HandFrame | null, sample: AnchorSample | null, timeMs: number): void {
    if (this.count === MAX_QUEUED_INPUTS) {
      release(this.slots[this.head]);
      this.head = (this.head + 1) % MAX_QUEUED_INPUTS;
      this.count--;
      this.drops++;
    }
    const slot = this.slots[(this.head + this.count) % MAX_QUEUED_INPUTS];
    slot.kind = kind;
    slot.arrivalMs = arrivalMs;
    slot.frame = frame;
    slot.sample = sample;
    slot.timeMs = timeMs;
    this.count++;
    if (this.count > this.peak) this.peak = this.count;
  }

  /** Moves the oldest input into `out` (a caller-owned slot) and removes it. */
  shiftInto(out: QueuedInput): void {
    const slot = this.slots[this.head];
    out.kind = slot.kind;
    out.arrivalMs = slot.arrivalMs;
    out.frame = slot.frame;
    out.sample = slot.sample;
    out.timeMs = slot.timeMs;
    release(slot);
    this.head = (this.head + 1) % MAX_QUEUED_INPUTS;
    this.count--;
  }

  clear(): void {
    for (let i = 0; i < this.count; i++) release(this.slots[(this.head + i) % MAX_QUEUED_INPUTS]);
    this.head = 0;
    this.count = 0;
  }
}

/**
 * The headless core of the yoyó: everything between «a frame (or a pointer sample) arrived» and
 * «here is what to draw and play». The camera, a replay file and the mouse all drive it through the
 * same two calls, so what a test proves about one path holds for the others, and no clock is read
 * anywhere in here: all time arrives as arguments (determinism: the same inputs give the same
 * snapshots, bit for bit).
 *
 * One `advance(nowMs)` per render frame:
 * 1. The fixed-step clock (config.sim.hz, at most config.sim.maxStepsPerFrame per frame, the rest
 *    dropped and counted) says how many steps are due.
 * 2. Before each step ending at t, every queued input that arrived by t is handled, so a frame is
 *    seen by the first step that could see it: the 60 Hz render cadence does not quantize camera
 *    frames to 16.7 ms. Handling a frame means: extract the anchor, update hand presence, feed the
 *    pivot, run the tie-on or the intent classifier, and fire an accepted intent straight into the
 *    model (no extra frame of delay: the latency budget is 100 ms).
 * 3. The pivot steps; the model steps too once the yoyo is tied on, never before (Y-01).
 * 4. Inputs that arrived after the last step but by `nowMs` are handled too.
 *
 * Why queue at all instead of handling inputs on arrival: a camera frame arrives from the worker at
 * an arbitrary moment between two render frames, and processing it inside the same loop as the
 * steps keeps the order of «sample, then physics» the replays were recorded with.
 */
export class YoyoRuntime implements YoyoRuntimeLike {
  /** Session counters (local only). Started at the first advance. */
  readonly metrics = new MetricsRecorder();
  /**
   * Fired for every classified intent with whether the yoyo accepted it: the recorder's `detected`
   * list and the diagnostics read it. It runs inside `advance`, so keep it cheap.
   */
  onIntent?: (event: IntentEvent, accepted: boolean) => void;
  readonly diagnostics: RuntimeDiagnosticsDetail = { queueDrops: 0, queuePeak: 0, droppedMs: 0, stepsTotal: 0, lastSampleAgeMs: Infinity, lastAdvancePeakSpeed: 0 };
  /** The reduced model, for read-only inspection (tests, diagnostics). Drive it only through the runtime. */
  readonly model: YoyoModel;

  private config: YoyoConfig;
  private readonly extractor: AnchorExtractor;
  private readonly classifier: IntentClassifier;
  private readonly detector: TetherDetector;
  private readonly pin: PinStabilizer;
  private readonly queue = new InputQueue();
  private fixed: FixedStep;
  private started = false;
  private paused = false;

  // Mapping from image space to the world. Camera and replay samples use `tied` once the yoyo is
  // tied on and `provisional` until then; the mouse always uses the pointer mapping.
  private zone: TetherZone | null = null;
  private provisional: WorldMapping;
  private tied: WorldMapping | null = null;
  private pointerMapping: WorldMapping;
  private pointerMappingSet = false;
  /** The mapping the pivot was last fed with: a change means the world moved under it, so the pivot must re-acquire. */
  private pinMapping: WorldMapping | null = null;
  private pinRestartPending = false;

  // Hand presence.
  private present = false;
  private lastSampleMs = -Infinity;
  private lastPalmSize = 0;
  private lastEdge: FrameEdge | null = null;
  /** Newest landmarks (mirrored image space) and their world conversion, cached per (landmarks, mapping). */
  private imageLandmarks: readonly Vec2[] | null = null;
  private worldLandmarks: readonly Vec2[] | null = null;
  private worldLandmarksFor: readonly Vec2[] | null = null;
  private worldLandmarksMapping: WorldMapping | null = null;

  /** Events of the advance in progress; the snapshot keeps the array, so each advance gets its own. */
  private events: YoyoEvent[] = [];
  /** Squared yoyo speed, the largest seen so far in the advance in progress (the square root is taken once, at the end). */
  private peakSpeedSquared = 0;
  // Scratch objects, so that handling a sample or taking a step allocates nothing.
  private readonly armed: ArmedIntents = { launch: false, tug: false };
  /** The input being handled: the queue copies each one here, so handling it allocates nothing. */
  private readonly current: QueuedInput = emptyInput();
  private readonly world: [number, number] = [0, 0];
  private readonly pinSample: PinSample = { x: 0, y: 0, timestampMs: 0, arrivalMs: 0, continuous: false };
  private readonly stepInput: StepInput;

  /**
   * `source` fixes what drives this session: 'camera' and 'replay' feed frames (`pushFrame`), 'mouse'
   * feeds pointer samples (`pushPointer`). Inputs of the other kind are ignored, never mixed: the two
   * live in different image spaces and a runtime that accepted both would differentiate across them.
   */
  constructor(config: YoyoConfig, readonly source: InputSource) {
    this.config = config;
    this.extractor = new AnchorExtractor(config);
    this.classifier = new IntentClassifier(config);
    this.detector = new TetherDetector(config);
    this.pin = new PinStabilizer(config);
    this.model = new YoyoModel(config);
    this.fixed = new FixedStep(config.sim.hz, config.sim.maxStepsPerFrame);
    this.provisional = mappingFromHome(config, DEFAULT_HOME_IMAGE);
    this.pointerMapping = mappingFromHome(config, DEFAULT_HOME_IMAGE);
    this.stepInput = { pin: this.pin.state, handPresent: false };
  }

  /**
   * Live tuning from «Ajustes → Avanzado»: every part reads the new thresholds from the next sample
   * or step on, with its history intact. A config that cannot work (a world scale that is not
   * positive, a step rate that is not) throws before anything changes. Call it when a setting
   * changes, not every frame: the pivot's 1€ filter is rebuilt and re-seeded each time.
   */
  setConfig(config: YoyoConfig): void {
    // Everything that can throw is built first, so a rejected config leaves the runtime as it was.
    const fixed = this.rebuiltClock(config);
    const provisional = sameOrNew(this.provisional, mappingFromHome(config, this.zone ? zoneCentre(this.zone) : DEFAULT_HOME_IMAGE));
    const tied = this.tied ? sameOrNew(this.tied, mappingFromHome(config, this.tied.homeImage)) : null;
    const pointerMapping = this.pointerMappingSet ? this.pointerMapping : sameOrNew(this.pointerMapping, mappingFromHome(config, DEFAULT_HOME_IMAGE));

    this.config = config;
    this.fixed = fixed;
    this.provisional = provisional;
    this.tied = tied;
    this.pointerMapping = pointerMapping;
    this.extractor.setConfig(config);
    this.classifier.setConfig(config);
    this.detector.setConfig(config);
    this.pin.setConfig(config);
    this.model.setConfig(config);
  }

  /**
   * Guided framing. While a zone is set the yoyo only ties on with the anchor inside it, and the
   * mapping is fixed (the zone's centre is the home) so the hand never jumps on screen when the
   * yoyo ties on. Null: tie on anywhere and re-home the world at that anchor. A yoyo that is already
   * tied on keeps its mapping until `recalibrate`.
   */
  setTetherZone(zone: TetherZone | null): void {
    const copy = zone === null ? null : { ...zone };
    // The app may well say the same thing every frame: an unchanged zone must not make the pivot re-acquire, nor restart the window.
    if (sameZone(this.zone, copy)) return;
    this.provisional = sameOrNew(this.provisional, mappingFromHome(this.config, copy ? zoneCentre(copy) : DEFAULT_HOME_IMAGE));
    this.zone = copy;
    this.detector.setZone(copy);
  }

  /** Mouse path: how viewport heights map to the world, set by the app from the renderer's camera. */
  setPointerMapping(mapping: WorldMapping): void {
    const copy: WorldMapping = { scale: mapping.scale, homeImage: [mapping.homeImage[0], mapping.homeImage[1]], homeWorld: [mapping.homeWorld[0], mapping.homeWorld[1]] };
    // An equal mapping keeps the object in use: the pivot re-acquires when the world moves under it, not when the app repeats itself.
    this.pointerMapping = sameOrNew(this.pointerMapping, copy);
    this.pointerMappingSet = true;
  }

  /**
   * A camera or replay frame, delivered at `arrivalMs` on the same clock as `advance`. The frame is
   * read when its turn comes, so it must not be modified afterwards. Ignored while paused, for a
   * non-finite arrival time (it would block the queue forever) and by a mouse session.
   */
  pushFrame(frame: HandFrame, arrivalMs: number): void {
    if (this.paused || this.source === 'mouse' || !Number.isFinite(arrivalMs)) return;
    this.queue.push('frame', arrivalMs, frame, null, arrivalMs);
    this.noteQueue();
  }

  /**
   * Mouse path: an already-resampled anchor sample, or null when the button is up (the hand is
   * absent). `timeMs` is when the app received it. Ignored while paused, for a non-finite time and
   * by a camera or replay session.
   */
  pushPointer(sample: AnchorSample | null, timeMs: number): void {
    if (this.paused || this.source !== 'mouse' || !Number.isFinite(timeMs)) return;
    this.queue.push('pointer', timeMs, null, sample, timeMs);
    this.noteQueue();
  }

  /**
   * Runs the simulation up to `nowMs` (see the class comment) and reports. While paused nothing
   * moves and nothing is handled; the snapshot says so.
   */
  advance(nowMs: number): YoyoSnapshot {
    const events: YoyoEvent[] = [];
    this.events = events;
    let steps = 0;
    let droppedMs = 0;
    this.diagnostics.lastAdvancePeakSpeed = 0;
    if (!this.paused && Number.isFinite(nowMs)) {
      if (!this.started) this.begin(nowMs);
      const budget = this.fixed.due(nowMs);
      steps = budget.steps;
      droppedMs = budget.droppedMs;
      this.peakSpeedSquared = this.yoyoSpeedSquared();
      for (let i = 0; i < steps; i++) {
        const t = this.fixed.advanceOne();
        this.drain(t, t);
        this.step(t);
      }
      this.drain(nowMs, this.fixed.timeMs);
      this.diagnostics.droppedMs += droppedMs;
      this.diagnostics.lastSampleAgeMs = this.sampleAge(this.fixed.timeMs);
      if (steps > 0) this.diagnostics.lastAdvancePeakSpeed = Math.sqrt(this.peakSpeedSquared);
    }
    this.recordEvents(events, nowMs);
    return this.snapshot(nowMs, steps, droppedMs, events);
  }

  /**
   * Pause: nothing steps and queued inputs are discarded (they describe a hand that will have moved
   * by the time we resume). Resume: the next sample is treated as a first sight of the hand (no
   * differencing across the pause, the pivot re-acquires without a leap), and the step clock restarts
   * at `nowMs`, so the time spent paused is neither simulated nor counted as dropped.
   */
  pause(paused: boolean, nowMs: number): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.queue.clear();
      return;
    }
    this.classifier.reset();
    this.extractor.reset();
    this.detector.reset();
    this.pinRestartPending = true;
    // The hand has to prove itself again; this is not a loss, so no event.
    this.present = false;
    if (this.started && Number.isFinite(nowMs)) this.fixed.start(nowMs);
  }

  /** Back to untethered: the next tie-on re-homes the world at wherever the hand is by then. */
  recalibrate(): void {
    this.model.untether();
    this.extractor.reset();
    this.classifier.reset();
    this.detector.reset();
    this.tied = null;
    this.pin.reset();
    this.pinRestartPending = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Fixed steps
  // ---------------------------------------------------------------------------------------------

  /** First advance: the clocks start here, never earlier, so nothing simulates before the app is running. */
  private begin(nowMs: number): void {
    this.started = true;
    this.fixed.start(nowMs);
    this.metrics.start(nowMs);
  }

  private rebuiltClock(config: YoyoConfig): FixedStep {
    if (config.sim.hz === this.fixed.hz && config.sim.maxStepsPerFrame === this.fixed.maxStepsPerFrame) return this.fixed;
    const clock = new FixedStep(config.sim.hz, config.sim.maxStepsPerFrame);
    if (this.started) clock.start(this.fixed.timeMs);
    return clock;
  }

  /** One fixed step ending at `t`. */
  private step(t: number): void {
    this.diagnostics.stepsTotal++;
    this.expirePresence(t);
    this.pin.step(this.fixed.dt, t);
    // No physics before the yoyo is tied on (Y-01): the pivot above may track the hand, the model must not run.
    if (this.model.state.phase === 'untethered') return;
    this.stepInput.handPresent = this.present;
    this.model.step(this.fixed.dt, this.stepInput, t, this.events);
    const speedSquared = this.yoyoSpeedSquared();
    if (speedSquared > this.peakSpeedSquared) this.peakSpeedSquared = speedSquared;
  }

  private yoyoSpeedSquared(): number {
    const { vx, vy } = this.model.state;
    return vx * vx + vy * vy;
  }

  // ---------------------------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------------------------

  private noteQueue(): void {
    this.diagnostics.queueDrops = this.queue.drops;
    this.diagnostics.queuePeak = this.queue.peak;
  }

  /** Handles every queued input that arrived by `arrivalLimitMs`, as of simulation time `simMs`. */
  private drain(arrivalLimitMs: number, simMs: number): void {
    const queue = this.queue;
    while (queue.length > 0 && queue.nextArrivalMs <= arrivalLimitMs) {
      queue.shiftInto(this.current);
      this.handle(this.current, simMs);
      release(this.current);
    }
  }

  private handle(input: QueuedInput, simMs: number): void {
    if (input.kind === 'frame') {
      const observation = this.extractor.observe(input.frame as HandFrame, input.arrivalMs);
      if (observation === null) return;
      if (observation.kind === 'sample') this.onSample(observation.sample, simMs);
      else this.onAbsent(observation.timestampMs, observation.arrivalMs, observation.exitEdge, simMs);
    } else if (input.sample) {
      this.onSample(input.sample, simMs);
    } else {
      this.onAbsent(input.timeMs, input.timeMs, undefined, simMs);
    }
  }

  /**
   * One sample of the tracked hand. Presence first (everything below depends on whether the hand is
   * really there), then the pivot, then the tie-on or the intent. A sample that is already older than
   * perception.staleMs on arrival (a camera that stalled and caught up) is remembered for the view and
   * for the classifier's history, but it is not data to act on: it does not make the hand present, does
   * not move the pivot, does not tie the yoyo on and does not arm anything (PRD §4.1).
   */
  private onSample(sample: AnchorSample, simMs: number): void {
    this.lastSampleMs = sample.timestampMs;
    this.lastPalmSize = sample.palmSize;
    this.lastEdge = sample.edge ?? null;
    this.imageLandmarks = sample.landmarks ?? null;
    this.setPresent(simMs - sample.timestampMs <= this.config.perception.staleMs, simMs);

    if (this.present) {
      const stable = this.model.state.phase === 'untethered' ? this.detector.push(sample) : null;
      if (stable) this.tieOn(sample, stable, simMs);
      else this.feedPin(sample);
    }
    // Always fed, armed or not: the classifier's history must already be there when the yoyo ties on.
    this.armIntents();
    const event = this.classifier.push(sample, this.armed);
    if (event) this.fire(event, simMs);
  }

  /**
   * The hand vanished (a frame without it, or the button released). A throw that carries it out
   * through the bottom may complete a launch here, so the intents are armed as they were while the
   * hand was still present, and only then is it marked absent.
   */
  private onAbsent(timestampMs: number, arrivalMs: number, exitEdge: FrameEdge | undefined, simMs: number): void {
    this.armIntents();
    const event = this.classifier.absent(timestampMs, arrivalMs, exitEdge, this.armed);
    if (event) this.fire(event, simMs);
    this.detector.reset();
    this.lastEdge = exitEdge ?? null;
    this.setPresent(false, simMs);
  }

  /** Which intents the yoyo accepts right now: the same rules the model applies when it is handed one. */
  private armIntents(): void {
    const phase = this.model.state.phase;
    this.armed.launch = this.present && phase === 'tethered';
    this.armed.tug = this.present && (phase === 'sleeping' || phase === 'exhausted') && this.config.responsiveness === 'responsive';
  }

  /** A classified intent goes straight to the model, timed now and caused by the sample that decided it. */
  private fire(event: IntentEvent, simMs: number): void {
    const accepted = event.kind === 'launch'
      ? this.model.launch(event.strength, simMs, event.timestampMs, this.events)
      : this.model.tug(event.strength, simMs, event.timestampMs, this.events);
    if (!accepted) this.metrics.onIgnoredIntent();
    this.onIntent?.(event, accepted);
  }

  // ---------------------------------------------------------------------------------------------
  // Hand presence
  // ---------------------------------------------------------------------------------------------

  /** Present while samples are fresh (capture time within perception.staleMs); absence and silence both end it. */
  private setPresent(value: boolean, simMs: number): void {
    if (value === this.present) return;
    this.present = value;
    this.emit(value ? 'hand-found' : 'hand-lost', simMs);
  }

  /** The camera can also fail by going quiet, not by saying «no hand»: old data ends presence the same way. */
  private expirePresence(simMs: number): void {
    if (this.present && simMs - this.lastSampleMs > this.config.perception.staleMs) this.setPresent(false, simMs);
  }

  private sampleAge(simMs: number): number {
    return Number.isFinite(this.lastSampleMs) ? Math.max(0, simMs - this.lastSampleMs) : Infinity;
  }

  private emit(kind: YoyoEventKind, timeMs: number): void {
    this.events.push({ kind, timeMs });
  }

  // ---------------------------------------------------------------------------------------------
  // Mapping, pivot, tie-on
  // ---------------------------------------------------------------------------------------------

  /** Mapping for the samples of this session right now. */
  private currentMapping(): WorldMapping {
    if (this.source === 'mouse') return this.pointerMapping;
    return this.tied ?? this.provisional;
  }

  /**
   * Maps the sample to the world and hands it to the pivot, keeping its continuity flag. If the
   * mapping is not the one the previous sample used (config tuned, zone moved, tie-on re-homed the
   * world) or the runtime just resumed, the sample is a re-acquire: the pivot glides there at a
   * capped speed instead of filtering across a jump.
   */
  private feedPin(sample: AnchorSample): void {
    const mapping = this.currentMapping();
    toWorld(mapping, sample.x, sample.y, this.world);
    const reacquire = this.pinRestartPending || mapping !== this.pinMapping;
    this.pinRestartPending = false;
    this.pinMapping = mapping;
    const target = this.pinSample;
    target.x = this.world[0];
    target.y = this.world[1];
    target.timestampMs = sample.timestampMs;
    target.arrivalMs = sample.arrivalMs;
    target.continuous = sample.continuous && !reacquire;
    this.pin.push(target);
  }

  /**
   * The hand has been steady long enough. A zone fixes the mapping (so nothing jumps on screen), no
   * zone re-homes the world at the steady position, and the mouse keeps the app's pointer mapping.
   * The pivot starts at the mapped rest position and the yoyo ties on at it: no step of physics has
   * run before this instant.
   */
  private tieOn(sample: AnchorSample, stable: StableHand, simMs: number): void {
    if (this.source !== 'mouse') this.tied = this.zone ? this.provisional : mappingFromHome(this.config, [stable.x, stable.y]);
    toWorld(this.currentMapping(), stable.x, stable.y, this.world);
    this.pin.reset({ x: this.world[0], y: this.world[1], vx: 0, vy: 0 });
    this.pinMapping = null;
    // The sample that completed the window is the pivot's first: it is live from this very step.
    this.feedPin(sample);
    this.model.tether(this.pin.state, simMs, this.events);
    this.detector.reset();
  }

  // ---------------------------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------------------------

  /** Feeds the metrics with the advance's events, and times each intent's reaction from capture to this frame. */
  private recordEvents(events: readonly YoyoEvent[], nowMs: number): void {
    for (const event of events) {
      this.metrics.onEvent(event);
      if ((event.kind === 'launch' || event.kind === 'tug') && event.causeMs !== undefined) this.metrics.onReaction(nowMs - event.causeMs);
    }
  }

  private snapshot(nowMs: number, steps: number, droppedMs: number, events: readonly YoyoEvent[]): YoyoSnapshot {
    const m = this.model.state;
    const p = this.pin.state;
    const timeMs = this.started ? this.fixed.timeMs : nowMs;
    return {
      timeMs,
      phase: m.phase,
      responsiveness: this.config.responsiveness,
      pivot: [p.x, p.y],
      pivotVelocity: [p.vx, p.vy],
      yoyo: [m.x, m.y],
      yoyoVelocity: [m.vx, m.vy],
      length: m.length,
      maxLength: this.config.yoyo.maxLength,
      spin: m.spin,
      spinAngle: m.spinAngle,
      tension: m.tension,
      slack: m.slack,
      hand: this.handView(timeMs),
      paused: this.paused,
      events,
      steps,
      droppedMs,
    };
  }

  private handView(simMs: number): HandView {
    const mapping = this.currentMapping();
    return {
      present: this.present,
      lostMs: this.present ? 0 : Number.isFinite(this.lastSampleMs) ? Math.max(0, simMs - this.lastSampleMs) : 0,
      edge: this.lastEdge,
      landmarks: this.landmarksInWorld(mapping),
      palmWorld: this.lastPalmSize * mapping.scale,
    };
  }

  /**
   * The newest landmarks in world metres. Camera frames arrive at 30 Hz and snapshots are taken at
   * the render rate, so the conversion is kept until a new hand (or a new mapping) makes it stale.
   * A snapshot never changes after it is returned: the cached array is only ever replaced, not edited.
   */
  private landmarksInWorld(mapping: WorldMapping): readonly Vec2[] | null {
    const image = this.imageLandmarks;
    if (image === null) return null;
    if (image !== this.worldLandmarksFor || mapping !== this.worldLandmarksMapping) {
      this.worldLandmarks = landmarksToWorld(mapping, image);
      this.worldLandmarksFor = image;
      this.worldLandmarksMapping = mapping;
    }
    return this.worldLandmarks;
  }
}
