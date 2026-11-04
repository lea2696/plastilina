import { inertia, type YoyoConfig } from '../config';
import type { PinState, YoyoEvent, YoyoEventKind, YoyoModelState, YoyoPhase } from '../contracts';

/** What the model needs besides time at every fixed step. */
export interface StepInput {
  /** The stabilised pivot (world, m) at the end of this step. */
  pin: PinState;
  /** Fresh hand data is arriving. A spent yoyo only returns by itself if there is a hand to catch it. */
  handPresent: boolean;
}

/** Gravity, m/s². World y points up, so it pulls toward −y. */
const GRAVITY = 9.81;
/** The string counts as taut within this much of its length, m. */
const TAUT_EPSILON = 1e-4;
/** Below this distance the string has no usable direction; it is taken to hang straight down, m. */
const MIN_DISTANCE = 1e-9;
/** While tied on or being caught, the yoyo stays at least this far under the pivot, m. */
const TETHER_CLEARANCE = 0.01;
/** Spin decay while the hand catches the yoyo, s: the disc is stopped in a fraction of a second. */
const CAUGHT_SPIN_TAU = 0.1;
/** Share of the relative velocity that survives a catch; the hand absorbs the rest. */
const CATCH_KEEP = 0.2;
/** A returning yoyo with less spin than this has run dry and falls back down, rad/s. */
const RETURN_FAILED_SPIN = 1;
/** Largest step the model accepts without complaint, s. Above this the impulses are no longer small. */
const MAX_STEP_S = 1 / 60;
/**
 * Rate, 1/s, at which a returning yoyo loses the sideways part of its velocity relative to the pivot.
 * Winding a yoyo in on a swinging string conserves its angular momentum about the finger, so a swing
 * of 1 m/s at 0.65 m of string becomes 5 m/s at 0.13 m: the yoyo orbits the finger and crosses its
 * height just outside the catch radius (PRD §8.2: never above the pivot). A real yoyo does not whirl
 * on the way in: string friction on the axle and air drag on the spinning disc kill the swing while it
 * winds. This drag stands for them.
 *
 * Measured over realistic property episodes (seeds 1-15000, about 190 000 throws): 7 /s is the smallest
 * rate that leaves zero steps above the pivot in every phase and catches the yoyo on the catch line,
 * never above it, with no step moving it more than 0.4 mm beyond its velocity. 6.5 /s leaves one step
 * of 1.6 mm settling after a catch, 6 /s two steps 2 mm above the pivot, and 5 /s 31 steps up to 1.5 cm
 * in the first 3000 episodes. Candidate for config.yoyo.
 */
export const RETURN_SWING_DAMPING = 7;
/**
 * Most the tether clamp undoes, per step, of an offset above the clearance line that the pivot's or the
 * yoyo's own motion does not explain, m. A yoyo caught slightly above the line is brought under it at
 * this pace (together with the tether spring) instead of being moved there in one step.
 */
const SETTLE_STEP = 0.001;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isFinitePin = (pin: PinState) => Number.isFinite(pin.x + pin.y + pin.vx + pin.vy);

/**
 * Reduced 2D yoyo (PRD §5.1): a point mass on a string of variable length whose other end is the
 * stabilised pivot, with a spinning axle that winds or unwinds the string.
 *
 * Why impulses instead of forces: the string is (nearly) inextensible and its length is coupled
 * to the spin (dL/dt = ±ω·r). Solving that coupling as one velocity impulse per step along the
 * string reproduces the exact rolling-disc result a = g / (1 + I/(m·r²)) (α ≈ 68.5 rad/s² for the
 * default yoyo) at any step size, with no stiff spring to tune and no energy gained by the
 * constraint: tension can only pull (J > 0), never push.
 *
 * Phases:
 * - tethered / caught: the yoyo follows a point under the pivot with a damped spring, so it is
 *   never above the pivot and ties on within centimetres of the finger.
 * - rolling: unwinding; gravity feeds the spin through the string.
 * - sleeping / exhausted: the loop slips, the string keeps its length, spin only decays.
 * - returning: winding; the spin is spent lifting the yoyo back.
 *
 * Never above the pivot is a guarantee only while tied on (tethered / caught, by the clamp). In the
 * free phases it is kept by physics and two rules of the return: winding while slack plus the
 * hand-height catch, and the swing damping (RETURN_SWING_DAMPING), which stops a yoyo wound in on a
 * swinging string from orbiting the finger. Realistic hands never get it above the pivot (zero steps in
 * 15 000 property episodes). What is not guarded is a hand that pumps the pendulum at its resonance or
 * dives past a yoyo that was launched without a stroke behind it (up to 1.3 cm for 46 ms, with
 * gesture-less launches); the property tests report both under chaos hands. The margin is thin: the
 * widest sleeping swing in those 15 000 episodes reached 89.5° of a possible 90°, and paying string out
 * continuously in `rolling` (which keeps more of a swing's energy) put 7 of them over the top.
 *
 * Displacement against velocity. Every step of a return moves the yoyo exactly as far as its velocity says
 * (the pull of the string is folded into it, see `moveAndProject`): 0.000 mm beyond max(|V before|, |V after|)·dt
 * in 1.3 M property steps and 34 500 steps of the runtime scenarios. Compared over a 60 Hz frame with only the
 * two end velocities, as the Y-05 scenario does, a return still shows up to ~1.1 mm (1.5 steps of gravity: the
 * string snaps taut at the start of the frame and the yoyo flies free for the other three steps; the exact
 * motion of that would show g·Δt²/2 = 1.36 mm): the sampling of the comparison, not a jump. A hand dive at launch
 * shows a few mm in `rolling`: the string pays out only while taut, so a yoyo that recedes more slowly than
 * the axle lets string go is held back by the projection every other step; paying out continuously fixes
 * the displacement but makes the descent about 7 % faster and lets swings over the top, so it is left as it is.
 *
 * Deterministic: no clocks, no randomness. The step allocates nothing (events allocate only when
 * one actually happens, a few per throw).
 */
export class YoyoModel {
  /** Current state. One object, mutated in place and handed out by reference. */
  readonly state: YoyoModelState = {
    phase: 'untethered', x: 0, y: 0, vx: 0, vy: 0, length: 0,
    spin: 0, spinAngle: 0, tension: 0, slack: false, phaseMs: 0,
  };

  /** Fixed steps that actually ran physics. It stays 0 until the yoyo is tied on and stepped. */
  stepsTaken = 0;

  private config: YoyoConfig;
  /** Pivot at the end of the last step (or at tether): launch and tug need it between steps. */
  private px = 0;
  private py = 0;
  private pvx = 0;
  private pvy = 0;
  /**
   * Pivot at the START of the current step, i.e. the one the yoyo's position was last projected
   * against. The string's geometry (taut or not, direction) must be read against this pivot: the
   * yoyo and the pivot have to be compared at the same instant.
   */
  private startPx = 0;
  private startPy = 0;

  // Derived from the config in setConfig.
  private mass = 0;
  private axle = 0;
  private inertia = 0;
  /** 1 / (1/m + r²/I): converts a velocity mismatch along the string into an impulse. */
  private coupling = 0;

  // Per-step decay factors, rebuilt when dt or the config changes.
  private cachedDt = Number.NaN;
  private airDecay = 1;
  private rollDecay = 1;
  private sleepDecay = 1;
  private caughtDecay = 1;
  /** Share of the sideways relative velocity a returning yoyo loses per step. */
  private swingLoss = 0;
  /** A catch happened this step: the hand takes the yoyo's speed at the start of the next one. */
  private absorbPending = false;

  constructor(config: YoyoConfig) {
    this.config = config;
    this.setConfig(config);
  }

  /**
   * Applies new tunables. Derived constants are recomputed; a string longer than the new maximum
   * is shortened (the next step then pulls the yoyo in, bounded by the usual projection).
   */
  setConfig(config: YoyoConfig): void {
    this.config = config;
    const y = config.yoyo;
    this.mass = y.mass;
    this.axle = y.axleRadius;
    this.inertia = inertia(y);
    this.coupling = 1 / (1 / this.mass + (this.axle * this.axle) / this.inertia);
    this.cachedDt = Number.NaN;
    if (this.state.length > y.maxLength) this.state.length = y.maxLength;
  }

  /**
   * Ties the yoyo on: it hangs `loopLength` under the pivot, at rest relative to it. Only valid
   * from `untethered`, and it never steps: no physics runs before this moment (Y-01).
   */
  tether(pin: PinState, timeMs: number, out: YoyoEvent[]): void {
    const s = this.state;
    if (s.phase !== 'untethered' || !isFinitePin(pin)) return;
    this.setPivot(pin);
    this.startPx = pin.x;
    this.startPy = pin.y;
    s.x = pin.x;
    s.y = pin.y - this.config.yoyo.loopLength;
    s.vx = pin.vx;
    s.vy = pin.vy;
    s.length = this.config.yoyo.loopLength;
    s.spin = 0;
    s.spinAngle = 0;
    s.tension = 0;
    s.slack = false;
    this.enter('tethered');
    this.emit(out, 'tether', timeMs);
  }

  /** Back to `untethered` (hand lost for good, recalibration). Counters are kept; the state is cleared. */
  untether(): void {
    const s = this.state;
    this.absorbPending = false;
    s.x = 0;
    s.y = 0;
    s.vx = 0;
    s.vy = 0;
    s.length = 0;
    s.spin = 0;
    s.spinAngle = 0;
    s.tension = 0;
    s.slack = false;
    this.enter('untethered');
  }

  /**
   * Throws the yoyo (only from `tethered`). The stroke speed only picks a spin inside the band:
   * the throw is canonical, so a clumsy flick and a perfect one both look and feel like a throw.
   * The yoyo leaves along the string at the speed the axle pays it out, so the string is taut and
   * unwinding from the first step and nothing jerks.
   */
  launch(strength: number, timeMs: number, causeMs: number, out: YoyoEvent[]): boolean {
    const s = this.state;
    if (s.phase !== 'tethered' || !Number.isFinite(strength)) return false;
    const y = this.config.yoyo;
    const span = y.launchSpeedHigh - y.launchSpeedLow;
    const share = span > 0 ? clamp((strength - y.launchSpeedLow) / span, 0, 1) : 1;
    const spin = y.launchSpinMin + (y.launchSpinMax - y.launchSpinMin) * share;
    const dx = s.x - this.px;
    const dy = s.y - this.py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ux = dist > MIN_DISTANCE ? dx / dist : 0;
    const uy = dist > MIN_DISTANCE ? dy / dist : -1;
    s.length = Math.max(dist, y.loopLength);
    s.vx = this.pvx + spin * y.axleRadius * ux;
    s.vy = this.pvy + spin * y.axleRadius * uy;
    s.spin = spin;
    s.tension = 0;
    s.slack = false;
    this.enter('rolling');
    this.emit(out, 'launch', timeMs, strength, causeMs);
    return true;
  }

  /**
   * Tug on a sleeping or spent yoyo: it starts winding back with boosted spin. An unresponsive
   * yoyo ignores it (it needs a bind, phase 3).
   */
  tug(strength: number, timeMs: number, causeMs: number, out: YoyoEvent[]): boolean {
    const s = this.state;
    if (this.config.responsiveness !== 'responsive') return false;
    if ((s.phase !== 'sleeping' && s.phase !== 'exhausted') || !Number.isFinite(strength)) return false;
    const y = this.config.yoyo;
    const boosted = Math.max(s.spin, y.returnSpinMin) + y.tugSpinBoost * Math.max(0, strength);
    s.spin = clamp(boosted, y.returnSpinMin, y.maxAscent / y.axleRadius);
    this.enter('returning');
    this.emit(out, 'tug', timeMs, strength, causeMs);
    return true;
  }

  /**
   * One fixed step ending at `timeMs`. A non-positive dt, a non-finite pivot or an untethered
   * yoyo leave everything untouched: bad input must not poison the state for the rest of the
   * session. A dt above MAX_STEP_S is integrated as MAX_STEP_S (the runtime never asks for it).
   */
  step(dt: number, input: StepInput, timeMs: number, out: YoyoEvent[]): void {
    const s = this.state;
    if (s.phase === 'untethered' || !(dt > 0) || !isFinitePin(input.pin)) return;
    const h = Math.min(dt, MAX_STEP_S);
    this.stepsTaken++;
    this.prepare(h);
    this.startPx = this.px;
    this.startPy = this.py;
    this.setPivot(input.pin);
    s.phaseMs += h * 1000;
    if (s.phase === 'tethered' || s.phase === 'caught') this.stepAttached(h, timeMs, out);
    else this.stepFree(h, input.handPresent, timeMs, out);
    s.spinAngle += s.spin * h;
  }

  private setPivot(pin: PinState): void {
    this.px = pin.x;
    this.py = pin.y;
    this.pvx = pin.vx;
    this.pvy = pin.vy;
  }

  private enter(phase: YoyoPhase): void {
    this.state.phase = phase;
    this.state.phaseMs = 0;
  }

  private emit(out: YoyoEvent[], kind: YoyoEventKind, timeMs: number, strength?: number, causeMs?: number): void {
    const event: YoyoEvent = { kind, timeMs };
    if (strength !== undefined) event.strength = strength;
    if (causeMs !== undefined) event.causeMs = causeMs;
    out.push(event);
  }

  /** Exponential decay factors per step; the runtime's dt is constant, so this almost never recomputes. */
  private prepare(dt: number): void {
    if (dt === this.cachedDt) return;
    const y = this.config.yoyo;
    this.cachedDt = dt;
    this.airDecay = Math.exp(-y.airDamping * dt);
    this.rollDecay = Math.exp(-dt / y.rollTau);
    this.sleepDecay = Math.exp(-dt / y.sleepTau);
    this.caughtDecay = Math.exp(-dt / CAUGHT_SPIN_TAU);
    this.swingLoss = 1 - Math.exp(-RETURN_SWING_DAMPING * dt);
  }

  /**
   * Tied on or being caught: a damped spring toward the point `loopLength` under the pivot, measured
   * in the pivot's frame (so a hand moving at constant speed drags the yoyo with no lag). The clamp
   * is the guarantee that a yoyo on the finger is never above it, whatever the hand does.
   *
   * The spring is aimed at the pivot as it was at the start of the step, the same instant as the
   * yoyo's position. Aiming at the pivot's end-of-step position instead would make a hand moving at
   * v leave the yoyo v·dt ahead of it in steady motion (1 cm at 2.5 m/s).
   */
  private stepAttached(dt: number, timeMs: number, out: YoyoEvent[]): void {
    const s = this.state;
    const y = this.config.yoyo;
    if (this.absorbPending) {
      this.absorbPending = false;
      s.vx = this.pvx + CATCH_KEEP * (s.vx - this.pvx);
      s.vy = this.pvy + CATCH_KEEP * (s.vy - this.pvy);
    }
    const stiffness = y.tetherOmega * y.tetherOmega;
    const damping = 2 * y.tetherDamping * y.tetherOmega;
    const ax = stiffness * (this.startPx - s.x) - damping * (s.vx - this.pvx);
    const ay = stiffness * (this.startPy - y.loopLength - s.y) - damping * (s.vy - this.pvy);
    const startY = s.y;
    s.vx += ax * dt;
    s.vy += ay * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    this.keepUnderFinger(startY);
    const dx = s.x - this.px;
    const dy = s.y - this.py;
    s.length = Math.sqrt(dx * dx + dy * dy);
    // Only used to tint the string: the force the finger feels holding the yoyo up.
    s.tension = this.mass * Math.sqrt(ax * ax + (ay + GRAVITY) * (ay + GRAVITY));
    s.slack = false;
    if (s.phase === 'caught') {
      s.spin *= this.caughtDecay;
      if (s.phaseMs >= y.caughtMs) {
        s.spin = 0;
        this.enter('tethered');
        this.emit(out, 'retether', timeMs);
      }
    }
  }

  /**
   * The clamp that keeps a tied-on yoyo under the finger: at least TETHER_CLEARANCE below the pivot,
   * with no upward motion relative to it there.
   *
   * It may move the yoyo down only as far as the pivot's drop and the yoyo's own rise this step explain,
   * plus SETTLE_STEP. Starting from under the line that is always enough, so a hand diving at the yoyo
   * still can never get above it. Starting from above the line (a catch beside the finger that left it
   * there) it brings the yoyo down at a steady pace and never in one jump.
   */
  private keepUnderFinger(startY: number): void {
    const s = this.state;
    const lowest = this.py - TETHER_CLEARANCE;
    if (s.y <= lowest) return;
    const pivotDrop = Math.max(0, this.startPy - this.py);
    const ownRise = Math.max(0, s.y - startY);
    s.y -= Math.min(s.y - lowest, pivotDrop + ownRise + SETTLE_STEP);
    if (s.vy > this.pvy) s.vy = this.pvy;
  }

  /** Rolling, sleeping, returning or exhausted: a mass on a string of variable length. */
  private stepFree(dt: number, handPresent: boolean, timeMs: number, out: YoyoEvent[]): void {
    this.applyGravityAndLosses(dt);
    const taut = this.solveString(dt);
    if (this.state.phase === 'returning') this.dampSwing();
    this.advanceLength(dt, taut);
    this.moveAndProject(dt);
    this.transition(handPresent, timeMs, out);
  }

  private applyGravityAndLosses(dt: number): void {
    const s = this.state;
    s.vy -= GRAVITY * dt;
    s.vx *= this.airDecay;
    s.vy *= this.airDecay;
    // Returning spends its spin through the string impulse (gravity does the work); no extra loss.
    if (s.phase === 'rolling') s.spin *= this.rollDecay;
    else if (s.phase === 'sleeping' || s.phase === 'exhausted') s.spin *= this.sleepDecay;
  }

  /**
   * The string as one velocity impulse along it. Returns whether the string is taut; a slack string
   * applies no impulse and a rolling yoyo does not pay out on it (a returning one still winds).
   *
   * With u the unit vector pivot → yoyo and v_r the yoyo's speed along it relative to the pivot:
   * - rolling:   the axle pays out ω·r, so the string wants v_r = +ω·r. Too fast pulls the yoyo back and spins it up.
   * - returning: the axle takes in ω·r, so it wants v_r = −ω·r. The yoyo is pulled in and the spin is spent.
   * - sleeping:  the loop slips on the axle; the string is just inextensible, spin untouched.
   * J > 0 is tension; J ≤ 0 means the string would have to push, so it goes slack instead.
   *
   * Taut-or-not and the direction u come from the yoyo and the pivot at the START of the step. Using
   * the pivot's end-of-step position would call the string slack whenever the pivot approaches by
   * more than TAUT_EPSILON in a step, even for a yoyo hanging taut under a slowly descending hand;
   * the yoyo would then fall on, pinned to the end of the string by the position projection alone,
   * collecting gravity's velocity until the hand stopped and the string finally jerked it.
   */
  private solveString(dt: number): boolean {
    const s = this.state;
    const dx = s.x - this.startPx;
    const dy = s.y - this.startPy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < s.length - TAUT_EPSILON) {
      s.tension = 0;
      s.slack = true;
      return false;
    }
    const ux = dist > MIN_DISTANCE ? dx / dist : 0;
    const uy = dist > MIN_DISTANCE ? dy / dist : -1;
    const radial = (s.vx - this.pvx) * ux + (s.vy - this.pvy) * uy;
    const r = this.axle;
    let impulse: number;
    if (s.phase === 'rolling') {
      impulse = this.coupling * (radial - s.spin * r);
      if (impulse > 0) {
        s.vx -= (impulse / this.mass) * ux;
        s.vy -= (impulse / this.mass) * uy;
        s.spin += (impulse * r) / this.inertia;
      }
    } else if (s.phase === 'returning') {
      impulse = this.coupling * (radial + s.spin * r);
      if (impulse > 0) {
        s.vx -= (impulse / this.mass) * ux;
        s.vy -= (impulse / this.mass) * uy;
        s.spin = Math.max(0, s.spin - (impulse * r) / this.inertia);
      }
    } else {
      impulse = this.mass * radial;
      if (impulse > 0) {
        s.vx -= radial * ux;
        s.vy -= radial * uy;
      }
    }
    s.tension = impulse > 0 ? impulse / dt : 0;
    s.slack = impulse <= 0;
    return true;
  }

  /**
   * Takes RETURN_SWING_DAMPING worth of the yoyo's sideways velocity, relative to the pivot and
   * across the string, away: the radial part (the winding itself) and the pivot's own motion are
   * left alone. Measured against the string as it was at the start of the step, like the impulse.
   */
  private dampSwing(): void {
    const s = this.state;
    const dx = s.x - this.startPx;
    const dy = s.y - this.startPy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < MIN_DISTANCE) return;
    const ux = dx / dist;
    const uy = dy / dist;
    const wx = s.vx - this.pvx;
    const wy = s.vy - this.pvy;
    const radial = wx * ux + wy * uy;
    s.vx -= (wx - radial * ux) * this.swingLoss;
    s.vy -= (wy - radial * uy) * this.swingLoss;
  }

  /**
   * The exposed length follows the axle. Unwinding pays string out only while it is taut: a slack
   * yoyo just falls. Winding never waits for tension: a responsive yoyo that has grabbed keeps eating
   * slack whether the string is taut or not, as a real one does (the spin reels in whatever is out).
   * Waiting for tension let a climbing yoyo fly on past a hand that had dipped toward it, because a
   * slack string neither pulled it in nor got shorter; in the property tests that put the yoyo above
   * the pivot for 13 % of returning steps. L can now drop below the distance to the pivot: the
   * projection then pulls the yoyo in and the string is taut again.
   */
  private advanceLength(dt: number, taut: boolean): void {
    const s = this.state;
    if (s.phase === 'rolling') {
      // Capped here, before the position update, so the yoyo can never be placed past the end.
      if (taut) s.length = Math.min(s.length + s.spin * this.axle * dt, this.config.yoyo.maxLength);
    } else if (s.phase === 'returning') {
      s.length = Math.max(0, s.length - s.spin * this.axle * dt);
    }
  }

  /**
   * Moves the yoyo, then enforces |X − P| ≤ L exactly: no step can leave the string over-stretched.
   *
   * While winding, the projection is the string reeling the yoyo in (L shrinks even when slack, so L
   * can fall below the distance) or following a pivot that moves away. The yoyo's velocity takes that
   * pull, so that what it moves in a step is what its velocity says: otherwise a yoyo next to the hand
   * could jump a centimetre in one step with its velocity unchanged, and only get up to speed on the
   * next one. The velocity only takes what the speeds in play (winding, pivot, yoyo) can explain; a
   * bigger pull, a pivot that teleported, stays a plain position correction. In the other free phases the
   * projection stays a position correction: it is mostly the centripetal part of a swing, which the next
   * step's impulse turns into velocity (see the class comment for what folding it into `rolling` does).
   */
  private moveAndProject(dt: number): void {
    const s = this.state;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    const dx = s.x - this.px;
    const dy = s.y - this.py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > s.length) {
      const pull = dist - s.length;
      const k = s.length / dist;
      s.x = this.px + dx * k;
      s.y = this.py + dy * k;
      if (s.phase === 'returning') {
        const explained = s.spin * this.axle + Math.hypot(this.pvx, this.pvy) + Math.hypot(s.vx, s.vy);
        // Inward, along the string: the unit vector from the yoyo to the pivot is −(dx, dy)/dist.
        const drag = Math.min(pull / dt, explained) / dist;
        s.vx -= dx * drag;
        s.vy -= dy * drag;
      }
    }
  }

  private transition(handPresent: boolean, timeMs: number, out: YoyoEvent[]): void {
    const s = this.state;
    const y = this.config.yoyo;
    if (s.phase === 'rolling') {
      if (s.length >= y.maxLength) this.snap(timeMs, out);
    } else if (s.phase === 'sleeping') {
      if (s.spin < y.exhaustedSpin) this.spend(handPresent, timeMs, out);
    } else if (s.phase === 'returning') {
      if (this.reachedTheHand()) {
        this.catchYoyo(timeMs, out);
      } else if (s.spin < RETURN_FAILED_SPIN) {
        // Out of spin before reaching the hand: it falls and unwinds again, as a real one would.
        this.enter('rolling');
        this.emit(out, 'return-failed', timeMs);
      }
    }
  }

  /**
   * A returning yoyo is caught when it is within catchDistance of the pivot and either
   * - nearly all the string is wound (L < catchLength): the PRD's rule; or
   * - it has come up to the height of its rest point under the finger (y ≥ pivot.y − loopLength):
   *   it is in the hand even though some string is still out. Winding no longer waits for tension,
   *   but a yoyo arriving next to the finger on a swaying hand would otherwise circle it, wound or
   *   not, until the last centimetres of string were gone.
   */
  private reachedTheHand(): boolean {
    const s = this.state;
    const y = this.config.yoyo;
    const dx = s.x - this.px;
    const dy = s.y - this.py;
    if (dx * dx + dy * dy >= y.catchDistance * y.catchDistance) return false;
    return s.length < y.catchLength || s.y >= this.py - y.loopLength;
  }

  /** End of the string: a short bounce along it, then the yoyo sleeps. The length is already exactly the maximum. */
  private snap(timeMs: number, out: YoyoEvent[]): void {
    const s = this.state;
    const dx = s.x - this.px;
    const dy = s.y - this.py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ux = dist > MIN_DISTANCE ? dx / dist : 0;
    const uy = dist > MIN_DISTANCE ? dy / dist : -1;
    const radial = Math.max(0, (s.vx - this.pvx) * ux + (s.vy - this.pvy) * uy);
    const kick = (1 + this.config.yoyo.snapRestitution) * radial;
    s.vx -= kick * ux;
    s.vy -= kick * uy;
    this.enter('sleeping');
    this.emit(out, 'snap', timeMs, radial);
  }

  /** A sleeper that ran out of spin returns by itself if it can (responsive, allowed, hand present); otherwise it hangs. */
  private spend(handPresent: boolean, timeMs: number, out: YoyoEvent[]): void {
    const y = this.config.yoyo;
    if (this.config.responsiveness === 'responsive' && y.autoReturn && handPresent) {
      this.state.spin = y.returnSpinMin;
      this.enter('returning');
      this.emit(out, 'auto-return', timeMs);
    } else {
      this.enter('exhausted');
      this.emit(out, 'exhausted', timeMs);
    }
  }

  /**
   * The yoyo reaches the hand. Nothing moves at the catch: if the yoyo is not yet under the clearance
   * line the tether brings it there at a bounded pace (see `keepUnderFinger`), so there is no pop.
   * The hand takes most of the yoyo's speed (CATCH_KEEP of it is left) at the start of the next step,
   * not now: this step already moved the yoyo at its old speed, and a velocity that no longer says
   * how far it just went would be a (small) teleport on paper.
   */
  private catchYoyo(timeMs: number, out: YoyoEvent[]): void {
    const s = this.state;
    const relX = s.vx - this.pvx;
    const relY = s.vy - this.pvy;
    const impact = Math.sqrt(relX * relX + relY * relY);
    this.absorbPending = true;
    // While attached the exposed length is, by definition, the distance to the pivot.
    s.length = Math.hypot(s.x - this.px, s.y - this.py);
    this.enter('caught');
    this.emit(out, 'catch', timeMs, impact);
  }
}
