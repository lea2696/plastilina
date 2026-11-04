/** Steps owed to one render frame, and the stretch of time the cap threw away (PRD_YOYO.md §5.1). */
export interface StepBudget {
  steps: number;
  droppedMs: number;
}

const MS_PER_SECOND = 1000;

/**
 * Floating-point slack, in steps. A 60 Hz frame is exactly four 240 Hz steps, so every frame
 * sits on a step boundary and rounding noise of 1e-15 would otherwise alternate 3 and 5 steps;
 * the 5 would hit the cap and throw a real step away. Far below any real timing difference
 * (1e-9 steps ≈ 4 ns) and far above double rounding at hour-long magnitudes (~1e-10).
 */
const STEP_EPSILON = 1e-9;

/**
 * Fixed-step clock of the yoyo simulation: physics always advances in identical 1/hz slices, so
 * a replay gives the same trajectory on any machine however irregular its render frames are.
 *
 * It follows the wall clock instead of integrating frame deltas into an accumulator. `timeMs`
 * is `base + steps × stepMs`, recomputed from an integer count, so ten minutes of 240 Hz steps
 * (144 000 of them) add no floating-point drift. When a frame arrives more than
 * `maxStepsPerFrame` steps late, the surplus whole steps are dropped and the clock jumps over
 * them: the simulation slows down for that stretch instead of spiralling (more steps per frame
 * to catch up, each frame costing more and arriving later, forever), and simulation time stays
 * on the timebase of the input samples so event latencies remain comparable.
 *
 * Usage per render frame: `const { steps } = due(now)`, then `advanceOne()` once before each of
 * the `steps` physics steps. No step is ever owed across frames except the sub-step remainder.
 */
export class FixedStep {
  /** One step in ms and in seconds (the `dt` the physics integrates with). */
  readonly stepMs: number;
  readonly dt: number;

  private started = false;
  /** Simulation time of step 0 since the last jump. */
  private baseMs = 0;
  /** Steps taken since `baseMs`; an integer, so the clock never accumulates rounding error. */
  private stepsSinceBase = 0;

  constructor(readonly hz: number, readonly maxStepsPerFrame: number) {
    if (!Number.isFinite(hz) || hz <= 0) throw new RangeError('hz must be a positive finite number');
    if (!Number.isInteger(maxStepsPerFrame) || maxStepsPerFrame < 1) throw new RangeError('maxStepsPerFrame must be a positive integer');
    this.stepMs = MS_PER_SECOND / hz;
    this.dt = 1 / hz;
  }

  /** Simulation time after the last step taken (0 before `start`). */
  get timeMs(): number {
    return this.baseMs + this.stepsSinceBase * this.stepMs;
  }

  /**
   * Starts the clock at `t` without stepping: nothing may simulate before the yoyo is tied on
   * (Y-01), so the engine starts the clock at that moment, never earlier.
   */
  start(t: number): void {
    if (!Number.isFinite(t)) throw new RangeError('start time must be finite');
    this.started = true;
    this.baseMs = t;
    this.stepsSinceBase = 0;
  }

  /**
   * Whole steps owed at `nowMs`, at most `maxStepsPerFrame`. Whole steps beyond the cap are
   * dropped (reported in `droppedMs`) and the clock jumps over them right here, so after taking
   * the returned steps `nowMs - timeMs` is always below one step. A sub-step remainder is kept
   * for the next frame, not dropped. Call once per render frame: the jump is applied on the
   * first call, so asking again reports 0 dropped.
   *
   * Never fails on odd input: before `start`, a non-finite `nowMs` or a time that went
   * backwards owe 0 steps and leave the clock untouched.
   */
  due(nowMs: number): StepBudget {
    if (!this.started || !Number.isFinite(nowMs)) return { steps: 0, droppedMs: 0 };
    const elapsed = nowMs - this.timeMs;
    if (elapsed <= 0) return { steps: 0, droppedMs: 0 };
    const owed = Math.floor(elapsed / this.stepMs + STEP_EPSILON);
    if (owed <= this.maxStepsPerFrame) return { steps: owed, droppedMs: 0 };
    const droppedSteps = owed - this.maxStepsPerFrame;
    this.baseMs = this.timeMs + droppedSteps * this.stepMs;
    this.stepsSinceBase = 0;
    return { steps: this.maxStepsPerFrame, droppedMs: droppedSteps * this.stepMs };
  }

  /**
   * Accounts one physics step actually taken and returns that step's end time in ms. Calling it
   * without `due` having owed the step would run physics ahead of real time, so it throws before
   * `start` (the engine must not step an untied yoyo) and otherwise trusts the caller's loop.
   */
  advanceOne(): number {
    if (!this.started) throw new Error('FixedStep.advanceOne called before start');
    this.stepsSinceBase += 1;
    return this.timeMs;
  }
}
