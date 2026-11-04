import { describe, expect, it } from 'vitest';
import { createConfig, inertia, setConfigValue, type YoyoConfig } from '../config';
import type { PinState, YoyoEvent, YoyoEventKind, YoyoPhase } from '../contracts';
import { Random } from '../replay/random';
import { RETURN_SWING_DAMPING, YoyoModel } from './YoyoModel';

/**
 * Reduced yoyo model criteria, all SYNTHETIC: a scripted pivot (still or swaying), no tracking, no
 * camera. Set YOYO_REPORT=1 to print every measured number.
 */

const STEP_S = 1 / 240;
const STEP_MS = 1000 / 240;
const GRAVITY = 9.81;
/** How far a step may move the yoyo beyond what its own velocity explains, m: 1 mm, plus rounding. */
const POP_LIMIT = 0.001 + 1e-9;

const report = (label: string, value: number | string) => {
  if (process.env.YOYO_REPORT === '1') console.info(`[model] ${label}: ${typeof value === 'number' ? value.toPrecision(5) : value}`);
};

function configWith(values: Record<string, number> = {}, tweak?: (config: YoyoConfig) => void): YoyoConfig {
  let config = createConfig();
  for (const [key, value] of Object.entries(values)) config = setConfigValue(config, key, value);
  tweak?.(config);
  return config;
}

/** The yoyo with no losses: only the rolling-disc mechanics remain. */
const lossless = (extra: Record<string, number> = {}) =>
  configWith({ 'yoyo.airDamping': 0, 'yoyo.rollTau': 1e12, 'yoyo.sleepTau': 1e12, ...extra });

const idealAcceleration = (config: YoyoConfig) => GRAVITY / (1 + inertia(config.yoyo) / (config.yoyo.mass * config.yoyo.axleRadius ** 2));
const idealAlpha = (config: YoyoConfig) => {
  const { mass, axleRadius: r } = config.yoyo;
  return (GRAVITY * mass * r) / (inertia(config.yoyo) + mass * r * r);
};

/** Small harness: one model, one pivot, a simulation clock and the events that came out. */
class Rig {
  readonly model: YoyoModel;
  readonly events: YoyoEvent[] = [];
  readonly pin: PinState;
  handPresent = true;
  stepIndex = 0;
  /** Largest |ΔX| − max(|V before|, |V after|)·dt seen so far: how far a step moved beyond its own velocity. */
  worstJump = 0;

  constructor(readonly config: YoyoConfig = createConfig(), pin: PinState = { x: 0, y: 0.85, vx: 0, vy: 0 }) {
    this.model = new YoyoModel(config);
    this.pin = pin;
  }

  get state() {
    return this.model.state;
  }

  get timeMs(): number {
    return this.stepIndex * STEP_MS;
  }

  tether(): void {
    this.model.tether(this.pin, this.timeMs, this.events);
  }

  launch(strength = 2, causeMs = this.timeMs): boolean {
    return this.model.launch(strength, this.timeMs, causeMs, this.events);
  }

  tug(strength = 1, causeMs = this.timeMs): boolean {
    return this.model.tug(strength, this.timeMs, causeMs, this.events);
  }

  /** One fixed step with the pivot as it currently is. */
  step(): void {
    const s = this.state;
    const [x, y, vx, vy] = [s.x, s.y, s.vx, s.vy];
    this.stepIndex++;
    this.model.step(STEP_S, { pin: this.pin, handPresent: this.handPresent }, this.timeMs, this.events);
    const moved = Math.hypot(s.x - x, s.y - y);
    const allowed = Math.max(Math.hypot(vx, vy), Math.hypot(s.vx, s.vy)) * STEP_S;
    this.worstJump = Math.max(this.worstJump, moved - allowed);
  }

  /** Steps for `seconds`, calling `each` after every step. Stops early when `until` returns true. */
  run(seconds: number, each?: (rig: Rig) => void, until?: (rig: Rig) => boolean): void {
    const steps = Math.round(seconds / STEP_S);
    for (let i = 0; i < steps; i++) {
      this.step();
      each?.(this);
      if (until?.(this)) return;
    }
  }

  runUntilPhase(phase: YoyoPhase, maxSeconds: number): void {
    this.run(maxSeconds, undefined, (rig) => rig.state.phase === phase);
  }

  kinds(): YoyoEventKind[] {
    return this.events.map((event) => event.kind);
  }

  last(kind: YoyoEventKind): YoyoEvent {
    const found = [...this.events].reverse().find((event) => event.kind === kind);
    if (!found) throw new Error(`No ${kind} event; got ${this.kinds().join(', ')}`);
    return found;
  }
}

function tetheredRig(config: YoyoConfig = createConfig()): Rig {
  const rig = new Rig(config);
  rig.tether();
  return rig;
}

function launchedRig(config: YoyoConfig = createConfig(), strength = 2): Rig {
  const rig = tetheredRig(config);
  expect(rig.launch(strength)).toBe(true);
  return rig;
}

/** Seconds a yoyo thrown with spin ω₀ takes to pay out the string from loopLength to maxLength: L(t) = L₀ + ω₀·r·t + ½·a·t². */
function analyticDescentSeconds(config: YoyoConfig, spin0: number): number {
  const v0 = spin0 * config.yoyo.axleRadius;
  const a = idealAcceleration(config);
  const travel = config.yoyo.maxLength - config.yoyo.loopLength;
  return (-v0 + Math.sqrt(v0 * v0 + 2 * a * travel)) / a;
}

describe('YoyoModel tether (Y-01: no physics before tied on)', () => {
  it('tether() never steps: stepsTaken stays 0 and the yoyo hangs loopLength under the pivot at rest', () => {
    const rig = new Rig();
    expect(rig.model.stepsTaken).toBe(0);
    expect(rig.state.phase).toBe('untethered');
    rig.tether();
    expect(rig.model.stepsTaken).toBe(0);
    expect(rig.state.phase).toBe('tethered');
    expect(rig.state.x).toBe(rig.pin.x);
    expect(rig.state.y).toBeCloseTo(rig.pin.y - rig.config.yoyo.loopLength, 12);
    expect(rig.state.vx).toBe(0);
    expect(rig.state.vy).toBe(0);
    expect(rig.state.length).toBe(rig.config.yoyo.loopLength);
    expect(rig.kinds()).toEqual(['tether']);
    rig.step();
    expect(rig.model.stepsTaken).toBe(1);
  });

  it('steps while untethered do nothing at all', () => {
    const rig = new Rig();
    const before = { ...rig.state };
    rig.run(1);
    expect(rig.model.stepsTaken).toBe(0);
    expect(rig.state).toEqual(before);
    expect(rig.events).toEqual([]);
  });

  it('launch and tug are refused before the yoyo is tied on', () => {
    const rig = new Rig();
    expect(rig.launch()).toBe(false);
    expect(rig.tug()).toBe(false);
    expect(rig.events).toEqual([]);
  });

  it('tether() when already tied on is a no-op: no second event, no reset', () => {
    const rig = tetheredRig();
    rig.run(0.5);
    const before = { ...rig.state };
    rig.model.tether({ x: 5, y: 5, vx: 0, vy: 0 }, rig.timeMs, rig.events);
    expect(rig.kinds()).toEqual(['tether']);
    expect(rig.state).toEqual(before);
  });

  it('rest on a moving pivot: the yoyo is at rest relative to it, so it does not lurch', () => {
    const pin: PinState = { x: 0.1, y: 0.9, vx: 0.6, vy: -0.2 };
    const rig = new Rig(createConfig(), pin);
    rig.tether();
    expect(rig.state.vx).toBe(0.6);
    expect(rig.state.vy).toBe(-0.2);
  });

  it('untether() clears the state; stepsTaken is cumulative and the yoyo can be tied on again', () => {
    const rig = launchedRig();
    rig.run(0.3);
    const steps = rig.model.stepsTaken;
    expect(steps).toBeGreaterThan(0);
    rig.model.untether();
    expect(rig.state).toMatchObject({ phase: 'untethered', x: 0, y: 0, vx: 0, vy: 0, length: 0, spin: 0, spinAngle: 0, tension: 0, phaseMs: 0 });
    rig.run(0.1);
    expect(rig.model.stepsTaken).toBe(steps);
    expect(rig.launch()).toBe(false);
    rig.tether();
    expect(rig.state.phase).toBe('tethered');
  });

  it('ignores a non-finite pivot instead of poisoning the state', () => {
    const rig = tetheredRig();
    rig.run(0.2);
    const before = { ...rig.state };
    const steps = rig.model.stepsTaken;
    rig.model.step(STEP_S, { pin: { x: Number.NaN, y: 0.85, vx: 0, vy: 0 }, handPresent: true }, 1, rig.events);
    rig.model.step(STEP_S, { pin: { x: 0, y: 0.85, vx: Number.POSITIVE_INFINITY, vy: 0 }, handPresent: true }, 1, rig.events);
    rig.model.step(0, { pin: rig.pin, handPresent: true }, 1, rig.events);
    rig.model.step(Number.NaN, { pin: rig.pin, handPresent: true }, 1, rig.events);
    expect(rig.state).toEqual(before);
    expect(rig.model.stepsTaken).toBe(steps);
    rig.run(0.2);
    expect(Number.isFinite(rig.state.x + rig.state.y)).toBe(true);
  });

  it('tethered: a still pivot leaves the yoyo hanging, the finger holding up its weight', () => {
    const rig = tetheredRig();
    rig.run(2);
    expect(rig.state.phase).toBe('tethered');
    expect(rig.state.x).toBeCloseTo(0, 9);
    expect(rig.state.y).toBeCloseTo(0.85 - 0.025, 9);
    expect(rig.state.spin).toBe(0);
    expect(rig.state.slack).toBe(false);
    expect(rig.state.tension).toBeCloseTo(rig.config.yoyo.mass * GRAVITY, 6);
    expect(rig.state.spinAngle).toBe(0);
  });
});

describe('YoyoModel rolling mechanics (impulse method)', () => {
  it('free unwinding from a fixed pivot reproduces α = g·m·r/(I + m·r²) and a = g/(1 + I/(m·r²)) within 2 %', () => {
    // Lossless and with room to roll: the only physics left is the string/axle coupling.
    const config = lossless({ 'yoyo.launchSpinMin': 0.001, 'yoyo.launchSpinMax': 0.001, 'yoyo.maxLength': 50 });
    const rig = launchedRig(config);
    const spin0 = rig.state.spin;
    const speed0 = Math.hypot(rig.state.vx, rig.state.vy);
    rig.run(1);
    const alpha = (rig.state.spin - spin0) / 1;
    const acceleration = (Math.hypot(rig.state.vx, rig.state.vy) - speed0) / 1;
    report('α measured (rad/s²)', alpha);
    report('α reference g·m·r/(I + m·r²) (rad/s²)', idealAlpha(config));
    report('a measured (m/s²)', acceleration);
    report('a reference g/(1 + I/(m·r²)) (m/s²)', idealAcceleration(config));
    expect(Math.abs(alpha / idealAlpha(config) - 1)).toBeLessThan(0.02);
    expect(Math.abs(acceleration / idealAcceleration(config) - 1)).toBeLessThan(0.02);
    // The discrete scheme is in fact exact, not merely within 2 %.
    expect(Math.abs(alpha / idealAlpha(config) - 1)).toBeLessThan(1e-6);
    expect(idealAlpha(config)).toBeGreaterThan(68);
    expect(idealAlpha(config)).toBeLessThan(69);
  });

  it('keeps the rolling constraint v_r = ω·r at every step and a constant string tension m·g/(1 + m·r²/I)', () => {
    const config = lossless({ 'yoyo.maxLength': 50 });
    const rig = launchedRig(config, 2);
    const { mass, axleRadius: r } = config.yoyo;
    const expectedTension = (mass * GRAVITY) / (1 + (mass * r * r) / inertia(config.yoyo));
    let worstConstraint = 0;
    let worstTension = 0;
    rig.run(1, (rg) => {
      const s = rg.state;
      worstConstraint = Math.max(worstConstraint, Math.abs(Math.hypot(s.vx, s.vy) - s.spin * r) / (s.spin * r));
      worstTension = Math.max(worstTension, Math.abs(s.tension / expectedTension - 1));
    });
    report('worst |v_r − ω·r| / (ω·r)', worstConstraint);
    report('worst relative tension error', worstTension);
    expect(worstConstraint).toBeLessThan(1e-9);
    expect(worstTension).toBeLessThan(1e-6);
  });

  it('with the default losses the effective α at launch is ≈ 62 rad/s² at ω₀ = 380 and ≈ 56 at 750 (PRD reference ≈ 65, lossless 68.5)', () => {
    // Two losses eat into α at launch spins, both proportional to the speed: the bearing (rollTau = 90 s, about
    // 4 rad/s² at 380 and 8 at 750) and the air drag (0.25/s, which the string coupling passes on to the spin:
    // about 2 and 4). So the strong launch gains the least spin per second of descent.
    const alphaAt = (strength: number, seconds: number) => {
      const rig = launchedRig(createConfig(), strength);
      const spin0 = rig.state.spin;
      rig.run(seconds);
      return { spin0, alpha: (rig.state.spin - spin0) / seconds };
    };
    const weak = alphaAt(1.2, 0.05);
    const strong = alphaAt(3, 0.05);
    report('effective α at launch, ω₀ = 380 rad/s (rad/s²)', weak.alpha);
    report('effective α at launch, ω₀ = 750 rad/s (rad/s²)', strong.alpha);
    // Averaged over the whole descent (0.53 s and 0.28 s) the loss grows a little as the spin does.
    report('effective α over the weak descent (rad/s²)', alphaAt(1.2, 0.5).alpha);
    report('effective α over the strong descent (rad/s²)', alphaAt(3, 0.27).alpha);
    expect(weak.spin0).toBeCloseTo(380, 9);
    expect(strong.spin0).toBeCloseTo(750, 9);
    expect(weak.alpha).toBeGreaterThan(61.5);
    expect(weak.alpha).toBeLessThan(63);
    expect(strong.alpha).toBeGreaterThan(55.5);
    expect(strong.alpha).toBeLessThan(57.5);
    expect(strong.alpha).toBeLessThan(weak.alpha);
  });

  it('launch strength picks the spin linearly inside the band and clamps outside it', () => {
    const { launchSpinMin, launchSpinMax, launchSpeedLow, launchSpeedHigh } = createConfig().yoyo;
    const spinFor = (strength: number) => launchedRig(createConfig(), strength).state.spin;
    expect(spinFor(launchSpeedLow)).toBeCloseTo(launchSpinMin, 9);
    expect(spinFor(launchSpeedHigh)).toBeCloseTo(launchSpinMax, 9);
    expect(spinFor(0.1)).toBeCloseTo(launchSpinMin, 9);
    expect(spinFor(10)).toBeCloseTo(launchSpinMax, 9);
    const mid = (launchSpeedLow + launchSpeedHigh) / 2;
    expect(spinFor(mid)).toBeCloseTo((launchSpinMin + launchSpinMax) / 2, 9);
    // Monotonic: a harder throw never spins slower.
    let previous = 0;
    for (let strength = 0.5; strength <= 4; strength += 0.1) {
      const spin = spinFor(strength);
      expect(spin).toBeGreaterThanOrEqual(previous);
      previous = spin;
    }
  });

  it('throws the yoyo along the string at ω₀·r, on top of the pivot velocity', () => {
    const pin: PinState = { x: 0, y: 0.85, vx: 0.5, vy: -1 };
    const rig = new Rig(createConfig(), pin);
    rig.tether();
    rig.launch(3);
    const { spin, vx, vy } = rig.state;
    const speedAlongString = spin * rig.config.yoyo.axleRadius;
    // Tethered at rest: the string points straight down.
    expect(vx).toBeCloseTo(0.5, 9);
    expect(vy).toBeCloseTo(-1 - speedAlongString, 9);
    expect(rig.state.phase).toBe('rolling');
    expect(rig.state.length).toBeCloseTo(rig.config.yoyo.loopLength, 12);
  });

  it('descent time loopLength → maxLength matches L(t) = L₀ + ω₀·r·t + ½·a·t² within 5 % at both band edges', () => {
    for (const [name, strength, approx] of [['strong', 3, 0.27], ['weak', 1.2, 0.52]] as const) {
      const config = createConfig();
      const rig = launchedRig(config, strength);
      const spin0 = rig.state.spin;
      const launchedAt = rig.timeMs;
      rig.run(2, undefined, (rg) => rg.kinds().includes('snap'));
      const measured = (rig.last('snap').timeMs - launchedAt) / 1000;
      const analytic = analyticDescentSeconds(config, spin0);
      report(`descent ${name}: measured (s)`, measured);
      report(`descent ${name}: analytic (s)`, analytic);
      expect(Math.abs(measured / analytic - 1)).toBeLessThan(0.05);
      expect(measured).toBeGreaterThan(approx - 0.03);
      expect(measured).toBeLessThan(approx + 0.03);
    }
  });

  it('launch measures the string from the actual distance when the yoyo hangs lower than the loop', () => {
    const config = createConfig();
    const rig = tetheredRig(config);
    // Pull the tethered yoyo 3 cm below the pivot, then throw.
    rig.state.y = rig.pin.y - 0.03;
    rig.launch(2);
    expect(rig.state.length).toBeCloseTo(0.03, 12);
  });
});

describe('YoyoModel end of the string (Y-03 snap)', () => {
  it('never lets the string pass maxLength + 1 mm, sleeps, and bounces back along the string at e·v', () => {
    for (const strength of [1.2, 2, 3, 3.5]) {
      const config = createConfig();
      const rig = launchedRig(config, strength);
      let longest = 0;
      let radialAfter = Number.NaN;
      rig.run(2, (rg) => {
        longest = Math.max(longest, rg.state.length, Math.hypot(rg.state.x - rg.pin.x, rg.state.y - rg.pin.y));
        if (Number.isNaN(radialAfter) && rg.kinds().includes('snap')) {
          const dx = rg.state.x - rg.pin.x;
          const dy = rg.state.y - rg.pin.y;
          const d = Math.hypot(dx, dy);
          radialAfter = (rg.state.vx * dx + rg.state.vy * dy) / d;
        }
      });
      const impact = rig.last('snap').strength as number;
      report(`snap strength ${strength}: impact speed (m/s)`, impact);
      report(`snap strength ${strength}: max overshoot (mm)`, (longest - config.yoyo.maxLength) * 1000);
      expect(longest).toBeLessThanOrEqual(config.yoyo.maxLength + 0.001);
      expect(radialAfter).toBeCloseTo(-config.yoyo.snapRestitution * impact, 9);
      expect(rig.kinds().filter((kind) => kind === 'snap')).toHaveLength(1);
      expect(rig.state.phase).toBe('sleeping');
    }
  });

  it('after the bounce the yoyo hangs at the end of the string, taut and still', () => {
    const rig = launchedRig(createConfig(), 3);
    rig.run(1.5);
    expect(rig.state.phase).toBe('sleeping');
    expect(rig.state.length).toBe(rig.config.yoyo.maxLength);
    expect(rig.state.x).toBeCloseTo(0, 6);
    expect(rig.state.y).toBeCloseTo(0.85 - rig.config.yoyo.maxLength, 6);
    expect(Math.hypot(rig.state.vx, rig.state.vy)).toBeLessThan(1e-6);
    // Hanging: the string holds the weight (air damping shaves 0.1 % off each step's gravity impulse).
    expect(rig.state.tension).toBeCloseTo(rig.config.yoyo.mass * GRAVITY, 2);
  });

  it('a snap on a moving pivot bounces relative to the pivot, not to the room', () => {
    const rig = new Rig(createConfig(), { x: 0, y: 0.85, vx: 0, vy: 0 });
    rig.tether();
    rig.launch(3);
    // The hand drifts sideways at 0.3 m/s while the string pays out.
    while (!rig.kinds().includes('snap') && rig.stepIndex < 240 * 2) {
      rig.pin.vx = 0.3;
      rig.pin.x += 0.3 * STEP_S;
      rig.step();
    }
    expect(rig.kinds()).toContain('snap');
    const dx = rig.state.x - rig.pin.x;
    const dy = rig.state.y - rig.pin.y;
    const d = Math.hypot(dx, dy);
    const radial = ((rig.state.vx - rig.pin.vx) * dx + (rig.state.vy - rig.pin.vy) * dy) / d;
    expect(radial).toBeCloseTo(-rig.config.yoyo.snapRestitution * (rig.last('snap').strength as number), 9);
  });
});

describe('YoyoModel sleeping (Y-03 decay)', () => {
  it('spin follows ω_s·e^(−t/τ) within 1 % over 5 s and never rises', () => {
    const config = createConfig();
    const rig = launchedRig(config, 3);
    rig.runUntilPhase('sleeping', 2);
    const spinStart = rig.state.spin;
    const tau = config.yoyo.sleepTau;
    let t = 0;
    let previous = spinStart;
    let worst = 0;
    rig.run(5, (rg) => {
      t += STEP_S;
      expect(rg.state.phase).toBe('sleeping');
      expect(rg.state.spin).toBeLessThanOrEqual(previous);
      previous = rg.state.spin;
      worst = Math.max(worst, Math.abs(rg.state.spin / (spinStart * Math.exp(-t / tau)) - 1));
    });
    report('worst sleeping-decay error vs ω_s·e^(−t/τ)', worst);
    expect(worst).toBeLessThan(0.01);
    expect(rig.state.spin).toBeCloseTo(spinStart * Math.exp(-5 / tau), 6);
  });

  it('the decay does not depend on what the hand does: swaying the pivot leaves the spin alone', () => {
    const still = launchedRig(createConfig(), 2);
    const swaying = launchedRig(createConfig(), 2);
    still.runUntilPhase('sleeping', 2);
    swaying.runUntilPhase('sleeping', 2);
    for (let i = 0; i < 240 * 3; i++) {
      swaying.pin.x = 0.08 * Math.sin((2 * Math.PI * 0.8 * i) / 240);
      swaying.pin.vx = 0.08 * 2 * Math.PI * 0.8 * Math.cos((2 * Math.PI * 0.8 * i) / 240);
      still.step();
      swaying.step();
    }
    expect(swaying.state.spin).toBeCloseTo(still.state.spin, 9);
  });

  it('exposes the string tension while hanging and zero while slack', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(1.5);
    expect(rig.state.slack).toBe(false);
    expect(rig.state.tension).toBeGreaterThan(0);
    // Hand dives toward the yoyo: the string goes slack and carries nothing.
    rig.pin.y -= 0.1;
    rig.pin.vy = -2;
    rig.step();
    rig.pin.vy = 0;
    expect(rig.state.slack).toBe(true);
    expect(rig.state.tension).toBe(0);
  });
});

describe('YoyoModel return (Y-05)', () => {
  it('auto-return with the hand present: rolling → sleeping → returning → caught → tethered, ending < 3 cm from the pivot', () => {
    const rig = launchedRig(createConfig(), 2);
    const phases: YoyoPhase[] = [];
    let spinAtSnap = Number.NaN;
    rig.run(40, (rg) => {
      if (phases[phases.length - 1] !== rg.state.phase) phases.push(rg.state.phase);
      if (Number.isNaN(spinAtSnap) && rg.kinds().includes('snap')) spinAtSnap = rg.state.spin;
    }, (rg) => rg.kinds().includes('retether'));
    expect(phases).toEqual(['rolling', 'sleeping', 'returning', 'caught', 'tethered']);
    expect(rig.kinds()).toEqual(['tether', 'launch', 'snap', 'auto-return', 'catch', 'retether']);
    const distance = Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y);
    report('final distance to pivot after the catch (cm)', distance * 100);
    expect(distance).toBeLessThan(0.03);
    expect(rig.state.spin).toBe(0);
    rig.run(1);
    expect(rig.state.length).toBeCloseTo(rig.config.yoyo.loopLength, 6);
    // It sleeps exactly as long as the spin takes to decay from ω_s to exhaustedSpin: τ·ln(ω_s / ω_exhausted).
    const { sleepTau, exhaustedSpin } = rig.config.yoyo;
    const sleptSeconds = (rig.last('auto-return').timeMs - rig.last('snap').timeMs) / 1000;
    report('sleeping time before the auto-return (s)', sleptSeconds);
    expect(sleptSeconds).toBeCloseTo(sleepTau * Math.log(spinAtSnap / exhaustedSpin), 1);
  });

  it('no step moves the yoyo farther than its own speed allows (+ 1 mm) across every state change', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(25, undefined, (rg) => rg.kinds().includes('retether'));
    expect(rig.kinds()).toContain('retether');
    report('worst step displacement beyond |V|·dt (mm)', rig.worstJump * 1000);
    expect(rig.worstJump).toBeLessThanOrEqual(POP_LIMIT);
  });

  it('never rises above the pivot during a launch, sleep and return with a still hand', () => {
    const rig = launchedRig(createConfig(), 3);
    let highest = -Infinity;
    rig.run(25, (rg) => {
      highest = Math.max(highest, rg.state.y - rg.pin.y);
    }, (rg) => rg.kinds().includes('retether'));
    expect(highest).toBeLessThanOrEqual(0);
  });

  it('catches when L < catchLength and within catchDistance, reporting the impact speed', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(25, undefined, (rg) => rg.kinds().includes('catch'));
    const catchEvent = rig.last('catch');
    expect(catchEvent.strength).toBeGreaterThan(0.3);
    expect(catchEvent.strength).toBeLessThan(1.5);
    report('catch impact speed (m/s)', catchEvent.strength as number);
    expect(rig.state.phase).toBe('caught');
    expect(rig.state.length).toBeLessThan(rig.config.yoyo.catchLength + 1e-9);
  });

  it('the hand absorbs the hit at the next step: the relative speed drops to 20 % of the speed the catch step moved the yoyo at', () => {
    // Tether spring and damping off, so that only the hand's grip acts on the speed.
    const rig = launchedRig(configWith({}, (c) => { c.yoyo.tetherOmega = 0; }), 2);
    rig.run(25, undefined, (rg) => rg.kinds().includes('catch'));
    const impact = rig.last('catch').strength as number;
    const relativeSpeed = () => Math.hypot(rig.state.vx - rig.pin.vx, rig.state.vy - rig.pin.vy);
    // Nothing moved at the catch: the velocity still says how fast the yoyo just travelled.
    expect(relativeSpeed()).toBeCloseTo(impact, 9);
    rig.step();
    expect(relativeSpeed()).toBeCloseTo(0.2 * impact, 9);
  });

  it('caught: spin dies with τ ≈ 0.1 s and the yoyo is tied on again after caughtMs', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(25, undefined, (rg) => rg.kinds().includes('catch'));
    const catchMs = rig.timeMs;
    const spinAtCatch = rig.state.spin;
    rig.run(0.1);
    expect(rig.state.spin).toBeCloseTo(spinAtCatch * Math.exp(-1), 1);
    rig.run(1, undefined, (rg) => rg.kinds().includes('retether'));
    const retetherMs = rig.last('retether').timeMs;
    expect(retetherMs - catchMs).toBeGreaterThanOrEqual(rig.config.yoyo.caughtMs - STEP_MS);
    expect(retetherMs - catchMs).toBeLessThanOrEqual(rig.config.yoyo.caughtMs + 2 * STEP_MS);
    expect(rig.state.phase).toBe('tethered');
    expect(rig.state.spin).toBe(0);
  });

  it('a yoyo that reaches the catch above the finger (hand dipped past it) comes down to the clearance line with no jump', () => {
    // Built directly: a returning yoyo 3 cm ABOVE the pivot with 4 cm of string left.
    const rig = launchedRig(createConfig(), 2);
    const s = rig.state;
    s.phase = 'returning';
    s.x = rig.pin.x;
    s.y = rig.pin.y + 0.03;
    s.vx = 0;
    s.vy = 0.5;
    s.length = 0.04;
    s.spin = 300;
    rig.step();
    expect(rig.state.phase).toBe('caught');
    // The catch itself does not move the yoyo anywhere its speed does not say: no clamp, no pop.
    expect(rig.worstJump).toBeLessThanOrEqual(POP_LIMIT);
    expect(rig.state.y).toBeGreaterThan(rig.pin.y);
    expect(rig.state.length).toBeCloseTo(Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y), 12);
    rig.run(1);
    report('worst step displacement beyond |V|·dt while a yoyo caught above the finger comes down (mm)', rig.worstJump * 1000);
    expect(rig.worstJump).toBeLessThanOrEqual(POP_LIMIT);
    expect(rig.state.y).toBeLessThanOrEqual(rig.pin.y - 0.01 + 1e-12);
    expect(rig.state.phase).toBe('tethered');
  });
});

describe('YoyoModel winding and catching', () => {
  /** A returning yoyo placed directly: `below` m under the pivot and `lateral` m to its side, with `length` of string out. */
  function returningRig(opts: { below: number; lateral?: number; length: number; spin?: number }): Rig {
    const rig = launchedRig(createConfig(), 2);
    const s = rig.state;
    s.phase = 'returning';
    s.x = rig.pin.x + (opts.lateral ?? 0);
    s.y = rig.pin.y - opts.below;
    s.vx = 0;
    s.vy = 0;
    s.length = opts.length;
    s.spin = opts.spin ?? 400;
    rig.events.length = 0;
    return rig;
  }

  it('a returning yoyo keeps winding a slack string, at ω·r per second, with or without tension', () => {
    const rig = returningRig({ below: 0.2, length: 0.5, spin: 400 });
    const { axleRadius } = rig.config.yoyo;
    const before = rig.state.length;
    rig.step();
    // The string is slack (the yoyo is 20 cm under the finger with 50 cm out) and still shortens by ω·r·dt.
    expect(rig.state.slack).toBe(true);
    expect(rig.state.length).toBeCloseTo(before - 400 * axleRadius * STEP_S, 12);
    // It never gets longer while returning, slack or taut, all the way to the catch.
    let previous = rig.state.length;
    let sawSlack = false;
    let sawTaut = false;
    rig.run(5, (rg) => {
      if (rg.state.phase !== 'returning') return;
      expect(rg.state.length).toBeLessThanOrEqual(previous);
      previous = rg.state.length;
      if (rg.state.slack) sawSlack = true;
      else sawTaut = true;
    }, (rg) => rg.kinds().includes('catch'));
    expect(sawSlack).toBe(true);
    expect(sawTaut).toBe(true);
    expect(rig.kinds()).toContain('catch');
  });

  it('when winding takes the string shorter than the distance the projection pulls the yoyo in and the string is taut again', () => {
    // 30 cm below the finger with 30.4 cm out and 3 m/s of winding: a step later L is 1.25 cm shorter than before.
    const rig = returningRig({ below: 0.3, length: 0.304, spin: 1000 });
    rig.step();
    const distance = Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y);
    expect(rig.state.length).toBeLessThan(0.304 - 0.012);
    expect(distance).toBeLessThanOrEqual(rig.state.length + 1e-12);
    // The next step sees a taut string.
    rig.step();
    expect(rig.state.slack).toBe(false);
  });

  it('the pull that reels a yoyo in is in its velocity too: a step moves it no farther than its speed says', () => {
    // Same setup as above: the yoyo is 4 mm inside the string and winding takes 1.25 cm of it in one step.
    const rig = returningRig({ below: 0.3, length: 0.304, spin: 1000 });
    const before = rig.state.y;
    rig.step();
    report('rise of a yoyo reeled in by 1.25 cm of winding (mm) / its vertical speed after (m/s)', `${((rig.state.y - before) * 1000).toFixed(2)} / ${rig.state.vy.toFixed(2)}`);
    expect(rig.state.y - before).toBeGreaterThan(0.008);
    expect(rig.state.vy).toBeGreaterThan(1.9);
    expect(rig.worstJump).toBeLessThanOrEqual(POP_LIMIT);
  });

  it('winding on a swaying hand: no step of the return moves the yoyo beyond its velocity before or after it, taut or slack', () => {
    // A sleeper tugged on a hand that sways in both axes, with the pivot's velocity the true derivative of its path.
    const rig = launchedRig(createConfig(), 3);
    rig.runUntilPhase('sleeping', 5);
    rig.run(0.3);
    const sway = (t: number) => {
      rig.pin.x = 0.05 * Math.sin(2 * Math.PI * 1.3 * t);
      rig.pin.y = 0.85 + 0.04 * Math.sin(2 * Math.PI * 0.9 * t + 1);
      rig.pin.vx = 0.05 * 2 * Math.PI * 1.3 * Math.cos(2 * Math.PI * 1.3 * t);
      rig.pin.vy = 0.04 * 2 * Math.PI * 0.9 * Math.cos(2 * Math.PI * 0.9 * t + 1);
    };
    expect(rig.tug(1.2)).toBe(true);
    let windingSteps = 0;
    let tautSteps = 0;
    let slackSteps = 0;
    let worst = 0;
    for (let i = 0; i < 240 * 6 && rig.state.phase === 'returning'; i++) {
      const s = rig.state;
      const [x, y, speedBefore] = [s.x, s.y, Math.hypot(s.vx, s.vy)];
      sway(rig.timeMs / 1000 + STEP_S);
      rig.step();
      if (s.phase !== 'returning') break;
      windingSteps++;
      if (s.slack) slackSteps++;
      else tautSteps++;
      worst = Math.max(worst, Math.hypot(s.x - x, s.y - y) - Math.max(speedBefore, Math.hypot(s.vx, s.vy)) * STEP_S);
    }
    report('winding on a swaying hand: steps (taut / slack) and worst displacement beyond the velocity (mm)', `${windingSteps} (${tautSteps} / ${slackSteps}) / ${(worst * 1000).toFixed(5)}`);
    // Both kinds of step really happened, so the check says something about the projection.
    expect(windingSteps).toBeGreaterThan(40);
    expect(tautSteps).toBeGreaterThan(10);
    expect(slackSteps).toBeGreaterThan(5);
    expect(worst).toBeLessThanOrEqual(1e-9);
  });

  describe('swing damping (RETURN_SWING_DAMPING)', () => {
    /** A yoyo 30 cm under the pivot with 60 cm of string out (slack), moving sideways at `vx`, the pivot at `pivotVx`; run for `steps`. */
    function swung(phase: YoyoPhase, vx: number, pivotVx: number, steps: number): Rig {
      const rig = launchedRig(lossless(), 2);
      rig.pin.vx = pivotVx;
      const s = rig.state;
      s.phase = phase;
      s.x = rig.pin.x;
      s.y = rig.pin.y - 0.3;
      s.vx = vx;
      s.vy = 0;
      s.length = 0.6;
      s.spin = 400;
      for (let i = 0; i < steps; i++) {
        rig.pin.x += pivotVx * STEP_S;
        rig.step();
      }
      return rig;
    }

    it('a returning yoyo loses the sideways part of its velocity relative to the pivot at that rate', () => {
      const steps = 3;
      const rig = swung('returning', 1, 0, steps);
      const expected = Math.exp(-RETURN_SWING_DAMPING * steps * STEP_S);
      report('sideways speed left after 3 steps of swing damping, 1 m/s start', rig.state.vx);
      // The string tilts by about 2° while it moves sideways, which is why this is not exact.
      expect(rig.state.vx).toBeGreaterThan(expected - 0.01);
      expect(rig.state.vx).toBeLessThan(expected + 0.01);
    });

    it('it is only the swing across the string: not the winding itself, not the pivot\'s own motion, not other phases', () => {
      // Moving with the pivot at 1 m/s there is no relative velocity to take.
      expect(swung('returning', 1, 1, 12).state.vx).toBeCloseTo(1, 9);
      // The same swing in any other phase is left alone (no losses in this config).
      for (const phase of ['rolling', 'sleeping'] as const) expect(swung(phase, 1, 0, 12).state.vx).toBeCloseTo(1, 9);
      // Winding is radial: a yoyo straight under the pivot with no sideways speed is pulled up at ω·r as ever.
      const rig = swung('returning', 0, 0, 1);
      expect(rig.state.length).toBeCloseTo(0.6 - 400 * rig.config.yoyo.axleRadius * STEP_S, 12);
      expect(rig.state.vx).toBe(0);
    });

    it('a swing that winding would make orbit the finger dies out instead: the yoyo comes in under the finger\'s height', () => {
      // A sleeper jerked sideways at 1.5 m/s at the bottom of its swing and tugged at once: winding it in on
      // that swing conserves angular momentum, and without the damping it whirls up to 9 cm above the finger.
      const rig = launchedRig(createConfig(), 2);
      rig.runUntilPhase('sleeping', 5);
      const s = rig.state;
      s.x = rig.pin.x;
      s.y = rig.pin.y - s.length;
      s.vx = 1.5;
      s.vy = 0;
      expect(rig.tug(1.2)).toBe(true);
      let highest = -Infinity;
      rig.run(10, (rg) => { highest = Math.max(highest, rg.state.y - rg.pin.y); }, (rg) => rg.kinds().includes('catch'));
      expect(rig.kinds()).toContain('catch');
      report('highest the yoyo got above the pivot on a return from a 1.5 m/s swing (mm)', highest * 1000);
      expect(highest).toBeLessThanOrEqual(0);
    });
  });

  it('a rolling yoyo does not pay string out while it is slack (only winding is unconditional)', () => {
    const rig = launchedRig(createConfig(), 2);
    const s = rig.state;
    s.x = rig.pin.x;
    s.y = rig.pin.y - 0.2;
    s.vx = 0;
    s.vy = 0;
    s.length = 0.5;
    s.spin = 400;
    rig.step();
    expect(rig.state.slack).toBe(true);
    expect(rig.state.length).toBe(0.5);
  });

  it('PRD catch: almost all the string wound (L < catchLength) and within catchDistance of the pivot', () => {
    const rig = returningRig({ below: 0.06, lateral: 0.04, length: 0.04 });
    rig.step();
    expect(rig.state.phase).toBe('caught');
    expect(rig.kinds()).toEqual(['catch']);
  });

  it('extended catch: up at the height of its rest point next to the finger counts as caught even with string still out', () => {
    // 2 cm under the finger (the rest point is 2.5 cm under), 4 cm to the side, 30 cm of string out.
    const rig = returningRig({ below: 0.02, lateral: 0.04, length: 0.3 });
    rig.step();
    expect(rig.state.phase).toBe('caught');
    expect(rig.kinds()).toEqual(['catch']);
    expect(rig.state.y).toBeLessThanOrEqual(rig.pin.y - 0.01 + 1e-12);
    // A yoyo that came up above the finger beside it is caught too, and brought down to the clearance line
    // without a jump.
    const over = returningRig({ below: -0.03, lateral: 0.05, length: 0.3 });
    over.step();
    expect(over.state.phase).toBe('caught');
    over.run(1);
    expect(over.worstJump).toBeLessThanOrEqual(POP_LIMIT);
    expect(over.state.y).toBeLessThanOrEqual(over.pin.y - 0.01 + 1e-12);
  });

  it('extended catch needs both: below the rest point, or farther than catchDistance, a long string is not caught', () => {
    const belowRest = returningRig({ below: 0.06, lateral: 0.04, length: 0.3 });
    belowRest.step();
    expect(belowRest.state.phase).toBe('returning');
    const farAtHeight = returningRig({ below: 0.01, lateral: 0.15, length: 0.3 });
    farAtHeight.step();
    expect(farAtHeight.state.phase).toBe('returning');
  });

  it('a yoyo that is not returning is never caught by either rule', () => {
    for (const phase of ['sleeping', 'rolling', 'exhausted'] as const) {
      const rig = returningRig({ below: 0.02, lateral: 0.03, length: 0.3 });
      rig.state.phase = phase;
      rig.step();
      expect(rig.kinds()).not.toContain('catch');
    }
  });
});

describe('YoyoModel exhausted spin (Y-08) and tug', () => {
  const quickSleep = (values: Record<string, number> = {}, tweak?: (config: YoyoConfig) => void) =>
    configWith({ 'yoyo.sleepTau': 1, ...values }, tweak);

  it('autoReturn off: the spin runs out, the yoyo hangs «exhausted», and a tug winds it back and catches it', () => {
    const rig = launchedRig(quickSleep({}, (c) => { c.yoyo.autoReturn = false; }), 2);
    rig.run(20, undefined, (rg) => rg.state.phase === 'exhausted');
    expect(rig.state.phase).toBe('exhausted');
    expect(rig.kinds()).toContain('exhausted');
    expect(rig.kinds()).not.toContain('auto-return');
    // Hangs there, spin still decaying, until somebody tugs.
    rig.run(3);
    expect(rig.state.phase).toBe('exhausted');
    expect(rig.state.length).toBe(rig.config.yoyo.maxLength);
    expect(rig.tug(1)).toBe(true);
    expect(rig.state.phase).toBe('returning');
    rig.run(10, undefined, (rg) => rg.kinds().includes('retether'));
    expect(rig.kinds().slice(-4)).toEqual(['exhausted', 'tug', 'catch', 'retether']);
    expect(rig.state.phase).toBe('tethered');
    expect(Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y)).toBeLessThan(0.03);
  });

  it('hand absent when the spin runs out: exhausted even though autoReturn is on, and it stays so when the hand comes back', () => {
    const rig = launchedRig(quickSleep(), 2);
    rig.handPresent = false;
    rig.run(20, undefined, (rg) => rg.state.phase !== 'rolling' && rg.state.phase !== 'sleeping');
    expect(rig.state.phase).toBe('exhausted');
    expect(rig.kinds()).not.toContain('auto-return');
    rig.handPresent = true;
    rig.run(5);
    expect(rig.state.phase).toBe('exhausted');
    expect(rig.tug(0.8)).toBe(true);
    rig.run(10, undefined, (rg) => rg.kinds().includes('retether'));
    expect(rig.state.phase).toBe('tethered');
  });

  it('a tug winds a sleeping yoyo back before its spin has run out', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(1.5);
    expect(rig.state.phase).toBe('sleeping');
    expect(rig.tug(1, 1234)).toBe(true);
    expect(rig.state.phase).toBe('returning');
    rig.run(5, undefined, (rg) => rg.kinds().includes('catch'));
    expect(rig.kinds()).toEqual(['tether', 'launch', 'snap', 'tug', 'catch']);
  });

  it('tug spin = clamp(max(ω, returnSpinMin) + boost·strength, returnSpinMin, maxAscent/r)', () => {
    const config = createConfig();
    const { returnSpinMin, tugSpinBoost, maxAscent, axleRadius } = config.yoyo;
    const spinAfterTug = (strength: number, sleepFor: number) => {
      const rig = launchedRig(config, 2);
      rig.run(sleepFor);
      const before = rig.state.spin;
      rig.tug(strength);
      return { before, after: rig.state.spin };
    };
    const soft = spinAfterTug(0.5, 1.5);
    expect(soft.after).toBeCloseTo(Math.max(soft.before, returnSpinMin) + tugSpinBoost * 0.5, 9);
    const wild = spinAfterTug(50, 1.5);
    expect(wild.after).toBeCloseTo(maxAscent / axleRadius, 9);
    const late = spinAfterTug(0.5, 14);
    expect(late.before).toBeLessThan(returnSpinMin);
    expect(late.after).toBeCloseTo(returnSpinMin + tugSpinBoost * 0.5, 9);
  });

  it('carries strength and the capture time of the cause on launch and tug events', () => {
    const rig = tetheredRig();
    rig.launch(2.2, 111);
    rig.run(1.5);
    rig.tug(0.7, 222);
    expect(rig.events.find((event) => event.kind === 'launch')).toMatchObject({ strength: 2.2, causeMs: 111 });
    expect(rig.last('tug')).toMatchObject({ strength: 0.7, causeMs: 222 });
    expect(rig.last('snap').causeMs).toBeUndefined();
  });

  it('a returning yoyo that runs dry before reaching the hand falls and unwinds again (no magic return)', () => {
    // A tug on a spent yoyo gives only returnSpinMin: too little to climb the whole string.
    const config = quickSleep({ 'yoyo.returnSpinMin': 100, 'yoyo.tugSpinBoost': 0 }, (c) => { c.yoyo.autoReturn = false; });
    const rig = launchedRig(config, 2);
    rig.run(20, undefined, (rg) => rg.state.phase === 'exhausted');
    rig.tug(1);
    rig.run(10, undefined, (rg) => rg.kinds().includes('return-failed'));
    expect(rig.kinds()).toContain('return-failed');
    expect(rig.kinds()).not.toContain('catch');
    expect(rig.state.phase).toBe('rolling');
    // Climbed part of the way (v²/2a = 0.22 m) and then came back down to the end of the string.
    expect(rig.state.length).toBeGreaterThan(config.yoyo.maxLength - 0.35);
    expect(rig.state.length).toBeLessThan(config.yoyo.maxLength - 0.1);
    rig.run(10, undefined, (rg) => rg.state.phase === 'sleeping');
    expect(rig.state.phase).toBe('sleeping');
    expect(rig.state.length).toBe(config.yoyo.maxLength);
    expect(rig.worstJump).toBeLessThanOrEqual(POP_LIMIT);
  });
});

describe('YoyoModel unresponsive (§5.2)', () => {
  it('ignores a tug and, with nothing to bring it back, ends exhausted', () => {
    const config = configWith({ 'yoyo.sleepTau': 1 }, (c) => { c.responsiveness = 'unresponsive'; });
    const rig = launchedRig(config, 2);
    rig.run(1.2);
    expect(rig.state.phase).toBe('sleeping');
    const before = { ...rig.state };
    expect(rig.tug(2)).toBe(false);
    expect(rig.state).toEqual(before);
    expect(rig.kinds()).not.toContain('tug');
    rig.run(20, undefined, (rg) => rg.state.phase === 'exhausted');
    expect(rig.state.phase).toBe('exhausted');
    expect(rig.kinds()).toContain('exhausted');
    expect(rig.kinds()).not.toContain('auto-return');
    expect(rig.tug(2)).toBe(false);
    rig.run(10);
    expect(rig.state.phase).toBe('exhausted');
    expect(rig.state.length).toBe(config.yoyo.maxLength);
  });

  it('responsiveness is read live: switching it with setConfig changes what a tug does', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(1.5);
    const unresponsive = createConfig();
    unresponsive.responsiveness = 'unresponsive';
    rig.model.setConfig(unresponsive);
    expect(rig.tug()).toBe(false);
    rig.model.setConfig(createConfig());
    expect(rig.tug()).toBe(true);
  });
});

describe('YoyoModel refuses what the state machine does not allow', () => {
  it('launch only from tethered; tug only from sleeping or exhausted', () => {
    const rig = tetheredRig();
    expect(rig.tug()).toBe(false);
    expect(rig.launch()).toBe(true);
    expect(rig.state.phase).toBe('rolling');
    expect(rig.launch()).toBe(false);
    expect(rig.tug()).toBe(false);
    rig.run(1.5);
    expect(rig.state.phase).toBe('sleeping');
    expect(rig.launch()).toBe(false);
    expect(rig.tug()).toBe(true);
    expect(rig.state.phase).toBe('returning');
    expect(rig.launch()).toBe(false);
    expect(rig.tug()).toBe(false);
    rig.run(5, undefined, (rg) => rg.state.phase === 'caught');
    expect(rig.state.phase).toBe('caught');
    expect(rig.launch()).toBe(false);
    expect(rig.tug()).toBe(false);
  });

  it('rejects non-finite strengths', () => {
    const rig = tetheredRig();
    expect(rig.launch(Number.NaN)).toBe(false);
    expect(rig.launch(Number.POSITIVE_INFINITY)).toBe(false);
    expect(rig.state.phase).toBe('tethered');
    rig.launch(2);
    rig.run(1.5);
    expect(rig.tug(Number.NaN)).toBe(false);
    expect(rig.state.phase).toBe('sleeping');
  });

  it('a refused request emits nothing and leaves the state untouched', () => {
    const rig = tetheredRig();
    rig.launch(2);
    rig.run(0.1);
    const before = { ...rig.state };
    const events = rig.events.length;
    rig.launch(3);
    rig.tug(1);
    expect(rig.events).toHaveLength(events);
    expect(rig.state).toEqual(before);
  });
});

describe('YoyoModel tethered follower', () => {
  it('a hand moving at constant speed drags the yoyo along with no lag (damping is relative to the pivot)', () => {
    const rig = tetheredRig();
    for (let i = 0; i < 240 * 2; i++) {
      rig.pin.vx = 1;
      rig.pin.x += STEP_S;
      rig.step();
    }
    expect(rig.state.x - rig.pin.x).toBeCloseTo(0, 6);
    expect(rig.state.y - (rig.pin.y - rig.config.yoyo.loopLength)).toBeCloseTo(0, 6);
  });

  it('is never above the pivot, even when the hand drops at 25 m/s² and the yoyo lags behind it', () => {
    const rig = tetheredRig();
    let highest = -Infinity;
    let lowestClearance = Infinity;
    for (let i = 0; i < 240 * 2; i++) {
      const t = i * STEP_S;
      const downward = t < 0.2;
      rig.pin.vy = downward ? -25 * t : 0;
      rig.pin.y += rig.pin.vy * STEP_S;
      rig.step();
      highest = Math.max(highest, rig.state.y - rig.pin.y);
      lowestClearance = Math.min(lowestClearance, rig.pin.y - rig.state.y);
    }
    expect(highest).toBeLessThanOrEqual(-0.01 + 1e-12);
    report('tethered clearance under the pivot, worst case (cm)', lowestClearance * 100);
  });

  it('settles under a stopped hand within a couple of centimetres of the rest point', () => {
    const rig = tetheredRig();
    for (let i = 0; i < 240; i++) {
      rig.pin.vx = Math.sin(i / 20);
      rig.pin.x += rig.pin.vx * STEP_S;
      rig.step();
    }
    rig.pin.vx = 0;
    rig.run(2);
    expect(Math.abs(rig.state.x - rig.pin.x)).toBeLessThan(1e-3);
    expect(rig.state.y).toBeCloseTo(rig.pin.y - rig.config.yoyo.loopLength, 3);
  });
});

describe('YoyoModel string dynamics with a moving pivot', () => {
  it('a hand that suddenly moves sideways makes the sleeper swing like a pendulum: it rises v²/2g, no more (no energy created)', () => {
    // No air: the room-frame drag would add or remove energy depending on the swing, and this checks the string alone.
    const rig = launchedRig(lossless(), 3);
    rig.run(1.5);
    expect(rig.state.phase).toBe('sleeping');
    const restY = rig.state.y;
    for (const speed of [0.5, 1.5, 2.5]) {
      const swing = launchedRig(lossless(), 3);
      swing.run(1.5);
      let rise = 0;
      for (let i = 0; i < 240; i++) {
        swing.pin.vx = speed;
        swing.pin.x += speed * STEP_S;
        swing.step();
        rise = Math.max(rise, swing.state.y - restY);
        expect(Math.hypot(swing.state.x - swing.pin.x, swing.state.y - swing.pin.y)).toBeLessThanOrEqual(swing.state.length + 1e-9);
        expect(swing.state.y).toBeLessThan(swing.pin.y);
      }
      const ideal = (speed * speed) / (2 * GRAVITY);
      report(`sleeper swing rise after a ${speed} m/s hand jerk (cm)`, rise * 100);
      report(`ideal v²/2g at ${speed} m/s (cm)`, ideal * 100);
      expect(rise).toBeLessThanOrEqual(ideal + 0.001);
      expect(rise).toBeGreaterThan(0.97 * ideal);
    }
  });

  it('a hanging yoyo under a hand that slowly descends moves down with it instead of falling on, pinned to the end of the string', () => {
    // The hand approaches the yoyo at 5 cm/s, more than TAUT_EPSILON per step. The string is still taut:
    // the yoyo must follow the hand's velocity, not accelerate under gravity while the projection holds its position.
    const rig = launchedRig(createConfig(), 3);
    rig.run(1.5);
    expect(rig.state.phase).toBe('sleeping');
    let fastest = 0;
    for (let i = 0; i < 240 * 3; i++) {
      rig.pin.vy = -0.05;
      rig.pin.y += -0.05 * STEP_S;
      rig.step();
      fastest = Math.max(fastest, Math.abs(rig.state.vy));
    }
    report('fastest yoyo speed under a hand descending at 5 cm/s (m/s)', fastest);
    expect(fastest).toBeLessThan(0.1);
    expect(rig.state.vy).toBeCloseTo(-0.05, 2);
    expect(rig.state.slack).toBe(false);
  });

  it('a jerked pivot never leaves the string stretched: |X − P| ≤ L after every step', () => {
    const rig = launchedRig(createConfig(), 2);
    const random = new Random(5);
    rig.run(1.5);
    for (let i = 0; i < 240 * 5; i++) {
      if (i % 40 === 0) {
        rig.pin.vx = random.range(-2.5, 2.5);
        rig.pin.vy = random.range(-2.5, 2.5);
      }
      rig.pin.x += rig.pin.vx * STEP_S;
      rig.pin.y += rig.pin.vy * STEP_S;
      rig.step();
      const d = Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y);
      expect(d).toBeLessThanOrEqual(rig.state.length + 1e-9);
      expect(rig.state.length).toBeLessThanOrEqual(rig.config.yoyo.maxLength + 1e-9);
    }
  });

  it('even a pivot teleport (which the stabilizer prevents) leaves a finite, taut-or-slack, inextensible string', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(1.5);
    rig.pin.x += 0.8;
    rig.pin.y -= 0.4;
    rig.step();
    expect(Number.isFinite(rig.state.x + rig.state.y + rig.state.vx + rig.state.vy)).toBe(true);
    expect(Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y)).toBeLessThanOrEqual(rig.state.length + 1e-9);
  });
});

describe('YoyoModel bookkeeping', () => {
  it('spinAngle integrates ω·dt every step, and stays 0 while tethered', () => {
    const rig = tetheredRig();
    rig.run(0.5);
    expect(rig.state.spinAngle).toBe(0);
    rig.launch(2);
    let angle = 0;
    rig.run(0.3, (rg) => {
      angle += rg.state.spin * STEP_S;
    });
    expect(rig.state.spinAngle).toBeCloseTo(angle, 9);
  });

  it('phaseMs counts time in the current phase and restarts at every change', () => {
    const rig = tetheredRig();
    rig.run(0.5);
    expect(rig.state.phaseMs).toBeCloseTo(500, 6);
    rig.launch(2);
    expect(rig.state.phaseMs).toBe(0);
    rig.run(0.1);
    expect(rig.state.phaseMs).toBeCloseTo(100, 6);
  });

  it('returns the very same state object on every step and keeps no per-step history', () => {
    const rig = tetheredRig();
    const state = rig.state;
    rig.run(0.2);
    expect(rig.model.state).toBe(state);
    expect(rig.events).toHaveLength(1);
  });

  it('events array only grows with real events: a full cycle emits a handful, not one per step', () => {
    const rig = launchedRig(createConfig(), 2);
    rig.run(25, undefined, (rg) => rg.kinds().includes('retether'));
    expect(rig.stepIndex).toBeGreaterThan(3000);
    expect(rig.events.length).toBeLessThanOrEqual(8);
  });

  it('setConfig shortens an over-long string and keeps |X − P| ≤ L', () => {
    const rig = launchedRig(createConfig(), 3);
    rig.run(1.5);
    expect(rig.state.length).toBe(0.65);
    const shorter = configWith({ 'yoyo.maxLength': 0.4 });
    rig.model.setConfig(shorter);
    expect(rig.state.length).toBeLessThanOrEqual(0.4);
    rig.step();
    expect(Math.hypot(rig.state.x - rig.pin.x, rig.state.y - rig.pin.y)).toBeLessThanOrEqual(rig.state.length + 1e-9);
    expect(Number.isFinite(rig.state.x + rig.state.y + rig.state.vx + rig.state.vy)).toBe(true);
  });

  it('setConfig applies new physics immediately (a heavier yoyo unwinds with the same a but more tension)', () => {
    const light = lossless({ 'yoyo.maxLength': 50 });
    const heavy = lossless({ 'yoyo.maxLength': 50, 'yoyo.mass': 0.12 });
    const rigLight = launchedRig(light, 2);
    const rigHeavy = launchedRig(light, 2);
    rigHeavy.model.setConfig(heavy);
    rigLight.run(0.5);
    rigHeavy.run(0.5);
    // For a disc I = ½·m·R² the mass cancels out of a = g/(1 + R²/(2r²)); only the tension scales with m.
    expect(Math.hypot(rigHeavy.state.vx, rigHeavy.state.vy)).toBeCloseTo(Math.hypot(rigLight.state.vx, rigLight.state.vy), 5);
    expect(rigHeavy.state.tension / rigLight.state.tension).toBeCloseTo(2, 3);
  });
});

/** Hand sway: a few sinusoids, mostly horizontal, with exact velocities. */
function makeSway(seed: number): (tSeconds: number, out: PinState) => void {
  const random = new Random(seed);
  const horizontal = [0, 1].map(() => ({ a: random.range(0.05, 0.1), f: random.range(0.3, 1.5), p: random.range(0, 2 * Math.PI) }));
  const vertical = { a: random.range(0.01, 0.02), f: random.range(0.3, 1.5), p: random.range(0, 2 * Math.PI) };
  return (t, out) => {
    out.x = 0;
    out.vx = 0;
    for (const c of horizontal) {
      const w = 2 * Math.PI * c.f;
      out.x += c.a * Math.sin(w * t + c.p);
      out.vx += c.a * w * Math.cos(w * t + c.p);
    }
    const wv = 2 * Math.PI * vertical.f;
    out.y = 0.85 + vertical.a * Math.sin(wv * t + vertical.p);
    out.vy = vertical.a * wv * Math.cos(wv * t + vertical.p);
  };
}

interface SwayStats {
  steps: number;
  maxLengthOver: number;
  maxSpin: number;
  minSpin: number;
  maxDistanceOverLength: number;
  nonFinite: number;
  aboveByPhase: Partial<Record<YoyoPhase, { steps: number; max: number }>>;
  events: Partial<Record<YoyoEventKind, number>>;
}

function runSway(seed: number, config: YoyoConfig, mode: 'relaunch' | 'single'): SwayStats {
  const pin: PinState = { x: 0, y: 0.85, vx: 0, vy: 0 };
  const sway = makeSway(seed);
  sway(0, pin);
  const rig = new Rig(config, pin);
  rig.tether();
  const stats: SwayStats = { steps: 0, maxLengthOver: -Infinity, maxSpin: 0, minSpin: Infinity, maxDistanceOverLength: -Infinity, nonFinite: 0, aboveByPhase: {}, events: {} };
  let relaunchAt = 0.5;
  const steps = 60 * 240;
  for (let i = 1; i <= steps; i++) {
    const t = i * STEP_S;
    sway(t, pin);
    if (mode === 'single' && i === 1) rig.launch(2.5);
    if (mode === 'relaunch' && rig.state.phase === 'tethered' && t >= relaunchAt) {
      rig.launch(2.5);
      relaunchAt = t + 0.4;
    }
    rig.step();
    const s = rig.state;
    stats.steps++;
    if (![s.x, s.y, s.vx, s.vy, s.length, s.spin, s.spinAngle, s.tension].every(Number.isFinite)) stats.nonFinite++;
    stats.maxLengthOver = Math.max(stats.maxLengthOver, s.length - config.yoyo.maxLength);
    stats.maxSpin = Math.max(stats.maxSpin, s.spin);
    stats.minSpin = Math.min(stats.minSpin, s.spin);
    stats.maxDistanceOverLength = Math.max(stats.maxDistanceOverLength, Math.hypot(s.x - pin.x, s.y - pin.y) - s.length);
    const above = s.y - pin.y;
    if (above > 0) {
      const entry = (stats.aboveByPhase[s.phase] ??= { steps: 0, max: 0 });
      entry.steps++;
      entry.max = Math.max(entry.max, above);
    }
  }
  for (const event of rig.events) stats.events[event.kind] = (stats.events[event.kind] ?? 0) + 1;
  return stats;
}

describe('Y-S3 model stability under a swaying hand (60 s at 240 Hz)', () => {
  const spinBound = (config: YoyoConfig) => Math.max(config.yoyo.launchSpinMax * 2, config.yoyo.maxAscent / config.yoyo.axleRadius);

  it('(a) default config, relaunching after every catch: bounded, finite, string never over-stretched', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const config = createConfig();
      const stats = runSway(seed, config, 'relaunch');
      report(`Y-S3(a) seed ${seed}: launches`, stats.events.launch ?? 0);
      report(`Y-S3(a) seed ${seed}: catches`, stats.events.catch ?? 0);
      report(`Y-S3(a) seed ${seed}: max L − maxLength (mm)`, stats.maxLengthOver * 1000);
      report(`Y-S3(a) seed ${seed}: max spin (rad/s)`, stats.maxSpin);
      report(`Y-S3(a) seed ${seed}: max dist − L (m)`, stats.maxDistanceOverLength);
      report(`Y-S3(a) seed ${seed}: above-pivot steps by phase`, JSON.stringify(stats.aboveByPhase));
      expect(stats.steps).toBe(60 * 240);
      expect(stats.nonFinite).toBe(0);
      expect(stats.maxLengthOver).toBeLessThanOrEqual(0.001);
      expect(stats.minSpin).toBeGreaterThanOrEqual(0);
      expect(stats.maxSpin).toBeLessThanOrEqual(spinBound(config));
      expect(stats.maxDistanceOverLength).toBeLessThanOrEqual(1e-6);
      // The model really did cycle: several throws and catches in a minute.
      expect(stats.events.launch ?? 0).toBeGreaterThanOrEqual(3);
      expect(stats.events.catch ?? 0).toBeGreaterThanOrEqual(2);
      // Never above the pivot in any phase but returning (see the property test for why returning is reported, not asserted).
      for (const phase of ['tethered', 'rolling', 'sleeping', 'exhausted', 'caught'] as const) {
        expect(stats.aboveByPhase[phase]).toBeUndefined();
      }
    }
  });

  it('(b) a literal 60 s sleeper (sleepTau = 1e9, no auto-return): bounded, finite, never above the pivot', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const config = configWith({ 'yoyo.sleepTau': 1e9 }, (c) => { c.yoyo.autoReturn = false; });
      const stats = runSway(seed, config, 'single');
      report(`Y-S3(b) seed ${seed}: max L − maxLength (mm)`, stats.maxLengthOver * 1000);
      report(`Y-S3(b) seed ${seed}: spin range (rad/s)`, `${stats.minSpin.toFixed(1)}…${stats.maxSpin.toFixed(1)}`);
      expect(stats.nonFinite).toBe(0);
      expect(stats.maxLengthOver).toBeLessThanOrEqual(0.001);
      expect(stats.minSpin).toBeGreaterThanOrEqual(0);
      expect(stats.maxSpin).toBeLessThanOrEqual(spinBound(config));
      expect(stats.maxDistanceOverLength).toBeLessThanOrEqual(1e-6);
      expect(stats.aboveByPhase).toEqual({});
      // It really slept for the minute: one throw, one snap, no way back.
      expect(stats.events).toMatchObject({ tether: 1, launch: 1, snap: 1 });
      expect(stats.events.catch).toBeUndefined();
      expect(stats.events.exhausted).toBeUndefined();
      expect(stats.minSpin).toBeGreaterThan(500);
    }
  });
});

const PHASES: YoyoPhase[] = ['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'exhausted'];

/** Everything observable about the model after a step, as numbers. */
function sample(rig: Rig): number[] {
  const s = rig.state;
  return [s.x, s.y, s.vx, s.vy, s.length, s.spin, s.spinAngle, s.tension, s.slack ? 1 : 0, s.phaseMs, PHASES.indexOf(s.phase)];
}

describe('Y-S4 determinism', () => {
  interface Script {
    pinAt: (tSeconds: number, out: PinState) => void;
    launchAtStep: number[];
    tugAtStep: number[];
  }

  function run(script: Script, config: YoyoConfig): number[] {
    const pin: PinState = { x: 0, y: 0.85, vx: 0, vy: 0 };
    script.pinAt(0, pin);
    const rig = new Rig(config, pin);
    rig.tether();
    const trace: number[] = [];
    for (let i = 1; i <= 25 * 240; i++) {
      script.pinAt(i * STEP_S, pin);
      if (script.launchAtStep.includes(i)) rig.launch(2.2, i * STEP_MS);
      if (script.tugAtStep.includes(i)) rig.tug(1.1, i * STEP_MS);
      rig.step();
      trace.push(...sample(rig));
    }
    for (const event of rig.events) trace.push(event.timeMs, event.strength ?? -1, event.causeMs ?? -1, event.kind.length);
    return trace;
  }

  it('the same scripted pin path, launches and tugs give the same trajectory twice (to 1e-6, in fact bit for bit)', () => {
    const script: Script = { pinAt: makeSway(21), launchAtStep: [120, 4200], tugAtStep: [1700, 5400] };
    const first = run(script, createConfig());
    const second = run(script, createConfig());
    expect(second).toHaveLength(first.length);
    let worst = 0;
    for (let i = 0; i < first.length; i++) worst = Math.max(worst, Math.abs(first[i] - second[i]));
    report('Y-S4 worst difference between two runs', worst);
    expect(worst).toBeLessThanOrEqual(1e-6);
    expect(worst).toBe(0);
    // And it is a real trajectory, not two copies of nothing.
    expect(Math.max(...first.filter((_, i) => i % 11 === 5))).toBeGreaterThan(100);
  });

  it('the state is a pure function of its inputs: a different seed gives a different trajectory', () => {
    const a = run({ pinAt: makeSway(21), launchAtStep: [120], tugAtStep: [] }, createConfig());
    const b = run({ pinAt: makeSway(22), launchAtStep: [120], tugAtStep: [] }, createConfig());
    expect(a).not.toEqual(b);
  });

  it('reading the state between steps does not change it (no hidden state in accessors)', () => {
    const script: Script = { pinAt: makeSway(3), launchAtStep: [60], tugAtStep: [] };
    const plain = run(script, createConfig());
    const pin: PinState = { x: 0, y: 0.85, vx: 0, vy: 0 };
    script.pinAt(0, pin);
    const rig = new Rig(createConfig(), pin);
    rig.tether();
    const trace: number[] = [];
    for (let i = 1; i <= 25 * 240; i++) {
      script.pinAt(i * STEP_S, pin);
      if (script.launchAtStep.includes(i)) rig.launch(2.2, i * STEP_MS);
      rig.step();
      JSON.stringify(rig.state);
      trace.push(...sample(rig));
    }
    for (const event of rig.events) trace.push(event.timeMs, event.strength ?? -1, event.causeMs ?? -1, event.kind.length);
    expect(trace).toEqual(plain);
  });
});
