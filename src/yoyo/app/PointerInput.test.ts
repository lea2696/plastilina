import { describe, expect, it } from 'vitest';
import { createConfig } from '../config';
import type { AnchorSample, Vec2, WorldRect, YoyoPhase } from '../contracts';
import type { PointerRect } from '../input/MouseDriver';
import { computeFraming } from '../render/framing';
import { POINTER_HOME_FROM_TOP, pointerFeel, pointerMapping } from './pointerMapping';
import { PointerInput, type PointerSink, type PointerSurface } from './PointerInput';
import { YoyoRuntime } from './YoyoRuntime';

/** A canvas stand-in: a real EventTarget with the few members the pointer layer uses. */
class FakeSurface extends EventTarget implements PointerSurface {
  rect: PointerRect = { left: 0, top: 0, width: 1280, height: 800 };
  captured = new Set<number>();
  /** Like the browser, releasing a capture fires `lostpointercapture`. */
  echoLostCapture = true;
  getBoundingClientRect(): PointerRect { return this.rect; }
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void {
    if (!this.captured.delete(id)) return;
    if (this.echoLostCapture) this.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: id }));
  }
}

interface EventInit {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  button?: number;
  timeStamp?: number;
  coalesced?: Array<{ clientX: number; clientY: number; timeStamp: number }>;
}

/** A pointer event with the fields the layer reads (Node has Event but no PointerEvent). */
function pointerEvent(type: string, init: EventInit = {}): Event {
  const event = new Event(type, { cancelable: true });
  const props: Record<string, unknown> = {
    clientX: init.clientX ?? 0, clientY: init.clientY ?? 0, pointerId: init.pointerId ?? 1, button: init.button ?? 0,
  };
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  if (init.timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: init.timeStamp });
  if (init.coalesced) Object.defineProperty(event, 'getCoalescedEvents', { value: () => init.coalesced });
  return event;
}

class RecordingSink implements PointerSink {
  calls: Array<{ sample: AnchorSample | null; timeMs: number }> = [];
  pushPointer(sample: AnchorSample | null, timeMs: number): void { this.calls.push({ sample, timeMs }); }
  get samples(): AnchorSample[] { return this.calls.flatMap(c => (c.sample ? [c.sample] : [])); }
}

function setup(options: { onPress?: (position: Vec2) => void } = {}) {
  const surface = new FakeSurface();
  const clock = { now: 0 };
  const input = new PointerInput(surface, { now: () => clock.now, ...options });
  const sink = new RecordingSink();
  input.setSink(sink);
  const fire = (type: string, init: EventInit = {}) => {
    const event = pointerEvent(type, { timeStamp: clock.now, ...init });
    surface.dispatchEvent(event);
    return event;
  };
  return { surface, clock, input, sink, fire };
}

describe('PointerInput', () => {
  it('turns a press into a hand: captures the pointer, feeds the sink on the 30 Hz grid, and reports the release', () => {
    const { surface, clock, input, sink, fire } = setup();
    clock.now = 1000;
    const down = fire('pointerdown', { clientX: 640, clientY: 400 });
    expect(down.defaultPrevented).toBe(true);
    expect(input.pressed).toBe(true);
    expect(surface.captured.has(1)).toBe(true);

    for (let i = 0; i < 12; i++) {
      clock.now += 1000 / 60;
      input.poll(clock.now);
    }
    // 200 ms at 30 Hz: the press sample and six more, positions in canvas heights from the canvas's top-left.
    expect(sink.samples.length).toBeGreaterThanOrEqual(6);
    expect(sink.samples[0]).toMatchObject({ source: 'mouse', x: 0.8, y: 0.5, continuous: false, palmSize: 0 });
    expect(sink.samples[1].continuous).toBe(true);
    for (let i = 1; i < sink.samples.length; i++) expect(sink.samples[i].timestampMs).toBeGreaterThan(sink.samples[i - 1].timestampMs);

    fire('pointerup', { clientX: 640, clientY: 400 });
    expect(input.pressed).toBe(false);
    expect(surface.captured.size).toBe(0);
    expect(sink.calls[sink.calls.length - 1].sample).toBeNull();
  });

  it('feeds every coalesced event of a move with its own time, so a fast flick keeps its shape', () => {
    const { clock, sink, input, fire } = setup();
    clock.now = 500;
    fire('pointerdown', { clientX: 600, clientY: 100 });
    clock.now = 533;
    fire('pointermove', {
      clientX: 600, clientY: 190,
      coalesced: [
        { clientX: 600, clientY: 130, timeStamp: 511 },
        { clientX: 600, clientY: 160, timeStamp: 522 },
        { clientX: 600, clientY: 190, timeStamp: 533 },
      ],
    });
    input.poll(534);
    // The grid sample at 533.3 sees the third position; the one at 500 and 533.3−33.3 saw the earlier ones.
    const ys = sink.samples.map(s => s.y);
    expect(ys[0]).toBeCloseTo(100 / 800, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(190 / 800, 9);
  });

  it('falls back to the event itself when there is nothing coalesced, and to the clock when its timestamp is not a past instant of it', () => {
    const { clock, sink, input, fire } = setup();
    clock.now = 2000;
    // A timestamp from another base (epoch milliseconds) or from the future is replaced by the clock.
    fire('pointerdown', { clientX: 0, clientY: 0, timeStamp: 1.7e12 });
    clock.now = 2100;
    fire('pointermove', { clientX: 80, clientY: 80, timeStamp: Number.NaN });
    input.poll(2100);
    expect(sink.samples.length).toBeGreaterThan(2);
    expect(sink.samples[0].timestampMs).toBe(2000);
    expect(sink.samples[sink.samples.length - 1].x).toBeCloseTo(0.1, 9);
  });

  it('ignores moves that are not a press, other buttons, other pointers and extra fingers', () => {
    const { clock, input, sink, fire, surface } = setup();
    clock.now = 100;
    fire('pointermove', { clientX: 10, clientY: 10 });
    expect(input.pressed).toBe(false);
    const rightClick = fire('pointerdown', { button: 2 });
    expect(input.pressed).toBe(false);
    expect(rightClick.defaultPrevented).toBe(false);

    fire('pointerdown', { pointerId: 7, clientX: 100, clientY: 100 });
    expect(input.pressed).toBe(true);
    // A second finger neither takes over nor ends the first one.
    fire('pointerdown', { pointerId: 8, clientX: 900, clientY: 700 });
    fire('pointermove', { pointerId: 8, clientX: 950, clientY: 700 });
    fire('pointerup', { pointerId: 8 });
    expect(input.pressed).toBe(true);
    expect(surface.captured.has(8)).toBe(false);
    clock.now = 200;
    input.poll(200);
    expect(sink.samples.every(s => s.x < 0.2)).toBe(true);
    fire('pointerup', { pointerId: 7, clientX: 100, clientY: 100 });
    expect(input.pressed).toBe(false);
  });

  it('treats a cancel and a capture the browser took away as the hand vanishing, but not the echo of its own release', () => {
    for (const type of ['pointercancel', 'lostpointercapture']) {
      const { clock, input, sink, fire } = setup();
      clock.now = 100;
      fire('pointerdown', { clientX: 5, clientY: 5 });
      clock.now = 200;
      input.poll(200);
      fire(type);
      expect(input.pressed).toBe(false);
      expect(sink.calls[sink.calls.length - 1].sample).toBeNull();
    }
    // A normal release echoes lostpointercapture right after the up: it must not end the NEXT press.
    const { clock, input, fire } = setup();
    clock.now = 100;
    fire('pointerdown');
    fire('pointerup');
    clock.now = 110;
    fire('pointerdown');
    expect(input.pressed).toBe(true);
  });

  it('release() ends a press from the app and says the hand is gone; without a press it does nothing', () => {
    const { clock, input, sink, fire } = setup();
    input.release(10);
    expect(sink.calls).toHaveLength(0);
    clock.now = 100;
    fire('pointerdown', { clientX: 1, clientY: 1 });
    clock.now = 400;
    input.release(400);
    expect(input.pressed).toBe(false);
    expect(sink.calls[sink.calls.length - 1]).toMatchObject({ sample: null, timeMs: 400 });
    // Moves after that are not a press any more.
    const before = sink.calls.length;
    fire('pointermove', { clientX: 9, clientY: 9 });
    input.poll(500);
    expect(sink.calls).toHaveLength(before);
  });

  it('does nothing without a sink, and changing the sink ends the press (no hand carries over to another runtime)', () => {
    const { clock, input, sink, fire, surface } = setup();
    input.setSink(null);
    clock.now = 10;
    fire('pointerdown');
    expect(input.pressed).toBe(false);
    expect(surface.captured.size).toBe(0);
    input.setSink(sink);
    fire('pointerdown');
    expect(input.pressed).toBe(true);
    const other = new RecordingSink();
    clock.now = 50;
    input.setSink(other);
    expect(input.pressed).toBe(false);
    expect(sink.calls[sink.calls.length - 1].sample).toBeNull();
    expect(other.calls).toHaveLength(0);
  });

  it('calls onPress inside the press handler (the user gesture), once per press, and not for a press it ignores', () => {
    const log: string[] = [];
    const { clock, fire } = setup({ onPress: () => log.push('press') });
    clock.now = 10;
    fire('pointerdown', { button: 2 });
    fire('pointerdown');
    fire('pointerdown', { pointerId: 9 });
    fire('pointerup');
    fire('pointerdown');
    expect(log).toEqual(['press', 'press']);
  });

  it('knows where the pointer is while the button is held, and nowhere otherwise', () => {
    const { clock, surface, input, fire } = setup();
    surface.rect = { left: 100, top: 50, width: 1280, height: 800 };
    expect(input.position).toBeNull();
    clock.now = 10;
    fire('pointerdown', { clientX: 100 + 400, clientY: 50 + 200 });
    expect(input.position).toEqual([0.5, 0.25]);
    fire('pointermove', { clientX: 100 + 800, clientY: 50 + 400, coalesced: [
      { clientX: 100 + 600, clientY: 50 + 300, timeStamp: 5 },
      { clientX: 100 + 800, clientY: 50 + 400, timeStamp: 10 },
    ] });
    expect(input.position).toEqual([1, 0.5]);
    fire('pointerup', { clientX: 100 + 800, clientY: 50 + 400 });
    expect(input.position).toBeNull();
  });

  it('tells onPress where the button went down in canvas heights, before any sample of the press reaches the sink', () => {
    const seen: Vec2[] = [];
    let samplesAtPress = -1;
    const { clock, surface, sink, input, fire } = setup({ onPress: position => { seen.push(position); samplesAtPress = sink.calls.length; } });
    surface.rect = { left: 100, top: 50, width: 1280, height: 800 };
    clock.now = 10;
    fire('pointerdown', { clientX: 100 + 400, clientY: 50 + 200 });
    expect(seen).toEqual([[0.5, 0.25]]);
    expect(samplesAtPress).toBe(0);
    clock.now = 100;
    input.poll(100);
    expect(sink.samples[0]).toMatchObject({ x: 0.5, y: 0.25 });
  });

  it('suppresses the context menu only while it is in use, and removes its listeners on dispose', () => {
    const { surface, input, fire, clock } = setup();
    expect(fire('contextmenu').defaultPrevented).toBe(true);
    clock.now = 5;
    fire('pointerdown');
    input.dispose();
    expect(input.pressed).toBe(false);
    expect(fire('contextmenu').defaultPrevented).toBe(false);
    const down = fire('pointerdown');
    expect(down.defaultPrevented).toBe(false);
    expect(surface.captured.size).toBe(0);
  });

  it('survives a pointer that cannot be captured', () => {
    const { surface, clock, input, fire } = setup();
    surface.setPointerCapture = () => { throw new DOMException('gone', 'NotFoundError'); };
    clock.now = 5;
    expect(() => fire('pointerdown', { clientX: 3, clientY: 3 })).not.toThrow();
    expect(input.pressed).toBe(true);
    expect(() => fire('pointerup')).not.toThrow();
    expect(input.pressed).toBe(false);
  });
});

/**
 * The mouse path end to end without a browser: the same script the browser smoke runs (hold, fast drag
 * down, wait, tug up) through PointerInput and a real mouse-source runtime.
 */
describe('PointerInput through the runtime (Y-11 by the app\'s own pointer layer)', () => {
  /** What the renderer shows on the 1280×800 canvas of these tests (its own framing, so the tests follow it when it moves). */
  const VIEW: WorldRect = computeFraming(1280 / 800).rect;
  const VIEW_HEIGHT = VIEW.top - VIEW.bottom;
  const VIEW_WIDTH = VIEW.right - VIEW.left;

  /**
   * `feel` 'direct' is the default mapping (pivot under the cursor); 'engine' is what the page uses: homed at each
   * press, high on the screen, with a gain below one.
   */
  function playScript(cursorY: number, feel: 'direct' | 'engine' = 'engine', rehome = true) {
    const surface = new FakeSurface();
    const clock = { now: 0 };
    const runtime = new YoyoRuntime(createConfig(), 'mouse');
    const input = new PointerInput(surface, {
      now: () => clock.now,
      onPress: position => {
        if (feel === 'engine') {
          runtime.setPointerMapping(pointerMapping(VIEW, surface.rect.width, surface.rect.height, pointerFeel(position))!);
        }
      },
    });
    const fire = (type: string, init: EventInit = {}) => {
      const event = pointerEvent(type, { timeStamp: clock.now, ...init });
      surface.dispatchEvent(event);
      return event;
    };
    if (feel === 'direct') runtime.setPointerMapping(pointerMapping(VIEW, surface.rect.width, surface.rect.height)!);
    input.setSink(runtime);
    const phases: YoyoPhase[] = [];
    const events: string[] = [];
    let hand = '';
    const frame = () => {
      clock.now += 1000 / 60;
      input.poll(clock.now);
      const snapshot = runtime.advance(clock.now);
      if (phases[phases.length - 1] !== snapshot.phase) phases.push(snapshot.phase);
      for (const e of snapshot.events) events.push(e.kind);
      // What the engine does at the catch: home the world again where the cursor is.
      if (feel === 'engine' && rehome && input.position && snapshot.events.some(e => e.kind === 'retether')) {
        runtime.setPointerMapping(pointerMapping(VIEW, surface.rect.width, surface.rect.height, pointerFeel(input.position))!);
      }
      hand = snapshot.hand.present ? 'present' : 'absent';
      return snapshot;
    };
    const run = (ms: number) => { for (const end = clock.now + ms; clock.now < end;) frame(); };
    clock.now = 10_000;
    run(100);
    return { surface, clock, input, fire, runtime, phases, events, run, frame, get hand() { return hand; }, cursorY };
  }

  it('walks untethered → tethered → rolling → sleeping → returning → caught → tethered', () => {
    const s = playScript(150);
    // Press near the top and hold still for 600 ms.
    s.fire('pointerdown', { clientX: 640, clientY: 150 });
    s.run(600);
    expect(s.phases).toEqual(['untethered', 'tethered']);

    // Fast drag down: 270 px in 100 ms, still holding.
    let y = 150;
    for (let i = 0; i < 6; i++) {
      y += 45;
      s.fire('pointermove', { clientX: 640, clientY: y });
      s.frame();
    }
    s.run(2500);
    expect(s.phases).toEqual(['untethered', 'tethered', 'rolling', 'sleeping']);

    // Hold still half a second, then a fast drag up: 80 px in 50 ms.
    s.run(500);
    for (let i = 0; i < 3; i++) {
      y -= 27;
      s.fire('pointermove', { clientX: 640, clientY: y });
      s.frame();
    }
    s.run(3000);
    expect(s.phases).toEqual(['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'tethered']);
    expect(s.events).toEqual(expect.arrayContaining(['tether', 'launch', 'snap', 'tug', 'catch', 'retether']));
    s.fire('pointerup', { clientX: 640, clientY: y });
  });

  it('a press that moves does not tie on, and releasing is a hand loss, not a launch', () => {
    const s = playScript(300);
    s.fire('pointerdown', { clientX: 300, clientY: 300 });
    for (let i = 0; i < 30; i++) {
      s.fire('pointermove', { clientX: 300 + i * 12, clientY: 300 });
      s.frame();
    }
    expect(s.phases).toEqual(['untethered']);
    s.fire('pointerup', { clientX: 660, clientY: 300 });
    s.run(500);
    expect(s.phases).toEqual(['untethered']);
    expect(s.events).not.toContain('launch');
  });

  it('with the direct mapping the pivot is under the cursor once tied on', () => {
    const s = playScript(200, 'direct');
    s.fire('pointerdown', { clientX: 320, clientY: 200 });
    s.run(700);
    const snapshot = s.frame();
    expect(snapshot.phase).toBe('tethered');
    // Cursor (320, 200) of a 1280×800 canvas: the same fraction of the visible rectangle.
    expect(snapshot.pivot[0]).toBeCloseTo(VIEW.left + (320 / 1280) * VIEW_WIDTH, 2);
    expect(snapshot.pivot[1]).toBeCloseTo(VIEW.top - (200 / 800) * VIEW_HEIGHT, 2);
  });

  it('with the engine feel the yoyo ties on high and centred wherever the button went down', () => {
    for (const [x, y] of [[100, 60], [640, 400], [1200, 760]]) {
      const s = playScript(y);
      s.fire('pointerdown', { clientX: x, clientY: y });
      s.run(700);
      const snapshot = s.frame();
      expect(snapshot.phase).toBe('tethered');
      expect(snapshot.pivot[0]).toBeCloseTo(0, 2);
      expect(snapshot.pivot[1]).toBeCloseTo(VIEW.top - POINTER_HOME_FROM_TOP * VIEW_HEIGHT, 2);
      s.fire('pointerup', { clientX: x, clientY: y });
    }
  });

  it('with the engine feel the sleeping yoyo is on screen after the launch drag, pressed at the top, the middle or the bottom', () => {
    for (const startY of [60, 400, 760]) {
      const s = playScript(startY);
      s.fire('pointerdown', { clientX: 640, clientY: startY });
      s.run(600);
      let y = startY;
      for (let i = 0; i < 6; i++) {
        y += 45;
        s.fire('pointermove', { clientX: 640, clientY: y });
        s.frame();
      }
      s.run(2500);
      expect(s.phases[s.phases.length - 1], `pressed at ${startY}`).toBe('sleeping');
      const snapshot = s.frame();
      // Above the visible bottom with room for the yoyo's drawn radius.
      expect(snapshot.yoyo[1] - 0.052, `pressed at ${startY}`).toBeGreaterThan(VIEW.bottom);
      expect(snapshot.yoyo[1]).toBeLessThan(VIEW.top);
      s.fire('pointerup', { clientX: 640, clientY: y });
    }
  });

  /** Plays `rounds` throws in a row from one press (drag down 270 px, wait, tug up 81 px, wait for the catch) and returns where each sleeper hung. */
  function playRounds(rounds: number, rehome: boolean): number[] {
    const s = playScript(100, 'engine', rehome);
    s.fire('pointerdown', { clientX: 640, clientY: 100 });
    s.run(700);
    let y = 100;
    const sleepers: number[] = [];
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 6; i++) {
        y += 45;
        s.fire('pointermove', { clientX: 640, clientY: y });
        s.frame();
      }
      for (let i = 0; i < 240 && s.phases[s.phases.length - 1] !== 'sleeping'; i++) s.frame();
      s.run(500);
      sleepers.push(s.frame().yoyo[1]);
      for (let i = 0; i < 3; i++) {
        y -= 27;
        s.fire('pointermove', { clientX: 640, clientY: y });
        s.frame();
      }
      // Back to «atado» before the next throw.
      for (let i = 0; i < 480 && !(s.phases[s.phases.length - 1] === 'tethered' && s.phases.includes('caught')); i++) s.frame();
      s.run(300);
      s.phases.length = 0;
      s.phases.push('tethered');
    }
    s.fire('pointerup', { clientX: 640, clientY: y });
    return sleepers;
  }

  it('three rounds in a row keep every sleeper on screen when the world is homed again at each catch', () => {
    const sleepers = playRounds(3, true);
    expect(sleepers).toHaveLength(3);
    for (const sleeper of sleepers) expect(sleeper - 0.052).toBeGreaterThan(VIEW.bottom);
    // Nothing creeps: the third hangs where the first did.
    expect(Math.abs(sleepers[2] - sleepers[0])).toBeLessThan(0.02);
  });

  it('without homing at the catch the sleepers creep down and leave the screen (why the engine does it)', () => {
    const sleepers = playRounds(3, false);
    expect(sleepers[1]).toBeLessThan(sleepers[0] - 0.05);
    expect(sleepers[2] - 0.052).toBeLessThan(VIEW.bottom);
  });

  it('a new press homes the world again: the yoyo does not stay where the last press left it', () => {
    const s = playScript(400);
    s.fire('pointerdown', { clientX: 640, clientY: 100 });
    s.run(700);
    let y = 100;
    for (let i = 0; i < 4; i++) {
      y += 30;
      s.fire('pointermove', { clientX: 640, clientY: y });
      s.frame();
    }
    s.run(300);
    const lowered = s.frame().pivot[1];
    s.fire('pointerup', { clientX: 640, clientY: y });
    s.run(300);
    s.fire('pointerdown', { clientX: 900, clientY: 700 });
    s.run(1500);
    const rehomed = s.frame().pivot[1];
    expect(rehomed).toBeGreaterThan(lowered);
    expect(rehomed).toBeCloseTo(VIEW.top - POINTER_HOME_FROM_TOP * VIEW_HEIGHT, 1);
  });
});
