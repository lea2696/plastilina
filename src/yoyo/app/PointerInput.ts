import type { AnchorSample, Vec2 } from '../contracts';
import { MouseDriver, type PointerRect } from '../input/MouseDriver';

/** Where pointer samples go: a runtime in mouse mode. */
export interface PointerSink {
  pushPointer(sample: AnchorSample | null, timeMs: number): void;
}

/** The part of the canvas this layer touches (a fake in tests). */
export interface PointerSurface extends EventTarget {
  getBoundingClientRect(): PointerRect;
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
}

export interface PointerInputOptions {
  /** The engine's clock, `performance.now`: every time handed to the driver and the sink comes from it or from event timestamps on the same base. */
  now: () => number;
  /**
   * Runs inside the press handler, i.e. inside the user gesture (the place to unlock audio), before any sample of
   * the press reaches the sink (the place to home the world mapping). `position` is where the button went down,
   * in canvas heights from the canvas's top-left: the space the samples are in.
   */
  onPress?: (position: Vec2) => void;
}

const PRIMARY_BUTTON = 0;

/**
 * The mouse (or finger, or pen) as the yoyo's hand (PRD §4.5): hold = hand present, drag = anchor. This
 * is the browser half of the mouse path; MouseDriver resamples to the camera's 30 Hz grid and the
 * runtime classifies the samples exactly as it does camera ones.
 *
 * - One pointer at a time; extra fingers and non-primary buttons are ignored. The pointer is captured, so
 *   a drag keeps working outside the canvas and a release anywhere ends it.
 * - Every coalesced event of a move is fed to the driver with its own timestamp: a fast flick is a few
 *   hardware samples per frame, and the last stretch before the release is what decides the launch.
 * - Event times come from `event.timeStamp` (the same base as `performance.now`) when it is plausible,
 *   and from the clock otherwise.
 * - A release (or a cancel) hands the driver's remaining samples over and then tells the sink the hand
 *   is gone; `release()` does the same for the app (pause, hidden tab, new source).
 *
 * Nothing is allocated per frame beyond what the driver returns, and the driver bounds its backlog.
 */
export class PointerInput {
  private readonly driver = new MouseDriver();
  private sink: PointerSink | null = null;
  private activeId: number | null = null;
  /** Latest pointer position of the press in progress, canvas heights; null while the button is up. */
  private last: Vec2 | null = null;
  /** A capture we released ourselves: its `lostpointercapture` is the echo of our own call, not the browser taking the pointer away. */
  private expectedLost: number | null = null;
  /** The canvas rectangle at the press. A drag is pointer-captured, so the canvas does not meaningfully move under it. */
  private rect: PointerRect = { left: 0, top: 0, width: 0, height: 1 };

  constructor(private readonly surface: PointerSurface, private readonly options: PointerInputOptions) {
    surface.addEventListener('pointerdown', this.onDown);
    surface.addEventListener('pointermove', this.onMove);
    surface.addEventListener('pointerup', this.onUp);
    surface.addEventListener('pointercancel', this.onCancel);
    surface.addEventListener('lostpointercapture', this.onLostCapture);
    surface.addEventListener('contextmenu', this.onContextMenu);
  }

  /** True while the button is held. */
  get pressed(): boolean {
    return this.activeId !== null;
  }

  /** Where the pointer is while the button is held, canvas heights from the canvas's top-left; null otherwise. */
  get position(): Vec2 | null {
    return this.last;
  }

  /** Where samples go; null ignores the pointer. Changing it ends any press, so no hand carries over to another runtime. */
  setSink(sink: PointerSink | null): void {
    if (sink === this.sink) return;
    this.release(this.options.now());
    this.sink = sink;
  }

  /** Once per frame: hands the sink the samples due by `nowMs` while the button is held. */
  poll(nowMs: number): void {
    const sink = this.sink;
    if (sink === null || this.activeId === null) return;
    for (const sample of this.driver.poll(nowMs)) sink.pushPointer(sample, nowMs);
  }

  /** Ends a press from the app's side: the hand is gone. Does nothing when nothing is pressed. */
  release(nowMs: number): void {
    if (this.activeId === null) return;
    this.finish(nowMs, nowMs);
  }

  dispose(): void {
    const surface = this.surface;
    surface.removeEventListener('pointerdown', this.onDown);
    surface.removeEventListener('pointermove', this.onMove);
    surface.removeEventListener('pointerup', this.onUp);
    surface.removeEventListener('pointercancel', this.onCancel);
    surface.removeEventListener('lostpointercapture', this.onLostCapture);
    surface.removeEventListener('contextmenu', this.onContextMenu);
    this.release(this.options.now());
    this.sink = null;
  }

  /** A usable capture time for an event: its own timestamp when it is a past instant of this clock, else now. */
  private eventTime(event: PointerEvent, nowMs: number): number {
    const t = event.timeStamp;
    return Number.isFinite(t) && t > 0 && t <= nowMs ? t : nowMs;
  }

  private readonly onDown = (event: Event): void => {
    const e = event as PointerEvent;
    if (this.sink === null || this.activeId !== null || e.button !== PRIMARY_BUTTON) return;
    e.preventDefault();
    const now = this.options.now();
    this.activeId = e.pointerId;
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; its up event will not come either, and the next down starts clean.
    }
    const rect = this.surface.getBoundingClientRect();
    this.rect = rect;
    this.driver.down(e.clientX, e.clientY, this.eventTime(e, now), rect);
    this.last = this.toImage(e.clientX, e.clientY);
    this.options.onPress?.(this.last);
  };

  private readonly onMove = (event: Event): void => {
    const e = event as PointerEvent;
    if (this.activeId === null || e.pointerId !== this.activeId) return;
    const now = this.options.now();
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const c of events) this.driver.move(c.clientX, c.clientY, this.eventTime(c, now));
    const newest = events[events.length - 1];
    this.last = this.toImage(newest.clientX, newest.clientY);
  };

  private readonly onUp = (event: Event): void => {
    const e = event as PointerEvent;
    if (this.activeId === null || e.pointerId !== this.activeId) return;
    const now = this.options.now();
    const t = this.eventTime(e, now);
    // The release carries the final position, which may be newer than the last move event.
    this.driver.move(e.clientX, e.clientY, t);
    this.finish(t, now);
  };

  private readonly onCancel = (event: Event): void => {
    const e = event as PointerEvent;
    if (this.activeId === null || e.pointerId !== this.activeId) return;
    const now = this.options.now();
    this.finish(this.eventTime(e, now), now);
  };

  /**
   * The browser took the pointer away mid-drag (the canvas was removed, another capture won): the press is
   * over, and the up event may never reach us. The echo of our own release is ignored.
   */
  private readonly onLostCapture = (event: Event): void => {
    const e = event as PointerEvent;
    if (this.expectedLost === e.pointerId) {
      this.expectedLost = null;
      return;
    }
    this.onCancel(event);
  };

  /** Right-click would open a menu in the middle of a drag; nothing here uses it. */
  private readonly onContextMenu = (event: Event): void => {
    if (this.sink !== null) event.preventDefault();
  };

  /** Client pixels → canvas heights, with the rectangle captured at the press (the driver does the same). */
  private toImage(clientX: number, clientY: number): Vec2 {
    return [(clientX - this.rect.left) / this.rect.height, (clientY - this.rect.top) / this.rect.height];
  }

  private finish(upMs: number, nowMs: number): void {
    const id = this.activeId;
    if (id === null) return;
    this.activeId = null;
    this.last = null;
    const sink = this.sink;
    this.driver.up(upMs);
    // The samples the driver still owes (the last stretch of a flick) go first; then the hand is gone.
    if (sink !== null) {
      for (const sample of this.driver.poll(nowMs)) sink.pushPointer(sample, nowMs);
      sink.pushPointer(null, nowMs);
    }
    try {
      if (this.surface.hasPointerCapture(id)) {
        this.expectedLost = id;
        this.surface.releasePointerCapture(id);
      }
    } catch {
      // Capture already released by the browser.
    }
  }
}
