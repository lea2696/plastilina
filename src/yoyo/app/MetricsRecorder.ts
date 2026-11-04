import type { YoyoEvent, YoyoMetrics } from '../contracts';

/** Reaction latencies kept; at one intent every few seconds this covers whole sessions. */
const DEFAULT_LATENCY_CAPACITY = 256;

/**
 * A tracking loss that lasts less than this is a flicker, not a loss of the hand. Camera frames go missing
 * in the PRD's noise model (3 % singly, 1 % in pairs), and three in a row, about once a minute, leave the
 * newest sample just past perception.staleMs when the next one arrives: the runtime rightly stops the
 * physics for that instant and says hand-lost, then hand-found a frame later, but nobody lost their hand.
 * Only a loss that lasts this long counts for «pérdidas de mano/min» (PRD §9).
 */
export const MIN_HAND_LOSS_MS = 300;

/**
 * Local session counters (PRD_YOYO.md §9): time to first launch, launches, tugs and how many of
 * them got the yoyo home, ignored intents, hand losses (those that last at least MIN_HAND_LOSS_MS)
 * and intent→reaction latencies. They live in memory only and leave the page solely through an
 * explicit user action elsewhere; nothing here touches the network, storage or the clock, so the
 * same event stream gives the same metrics.
 *
 * A session begins at `start`/`reset`. Anything reported before that is ignored: counting events
 * with no origin would make `firstLaunchMs` and `sessionMs` meaningless.
 */
export class MetricsRecorder {
  private started = false;
  private startMs = 0;
  private firstLaunchMs: number | null = null;
  private launches = 0;
  private tugs = 0;
  private catches = 0;
  private autoReturns = 0;
  private exhausted = 0;
  private ignoredIntents = 0;
  /** Hand losses that lasted long enough and are over. */
  private handLosses = 0;
  /** When the hand that is lost right now was lost; null while it is present. */
  private handLostSinceMs: number | null = null;
  /** Tugs that a catch vouched for before the next launch. */
  private successfulTugs = 0;
  /** Tugs since the last launch or catch that no catch has vouched for yet. */
  private pendingTugs = 0;
  /** Ring of the newest latencies: bounded memory however long the session runs. */
  private readonly latencies: Float64Array;
  private latencyNext = 0;
  private latencyCount = 0;

  constructor(latencyCapacity = DEFAULT_LATENCY_CAPACITY, private readonly minHandLossMs = MIN_HAND_LOSS_MS) {
    if (!Number.isInteger(latencyCapacity) || latencyCapacity < 1) throw new RangeError('latencyCapacity must be a positive integer');
    if (!Number.isFinite(minHandLossMs) || minHandLossMs < 0) throw new RangeError('minHandLossMs must be a finite, non-negative number');
    this.latencies = new Float64Array(latencyCapacity);
  }

  /** Begins a clean session at `t`, on the same monotonic clock as the events' `timeMs`. */
  start(t: number): void {
    this.reset(t);
  }

  /**
   * Throws away everything counted so far and restarts the session at `t` («Reiniciar métricas»).
   * A non-finite `t` leaves the recorder inactive instead of poisoning every later time with NaN.
   */
  reset(t: number): void {
    this.started = Number.isFinite(t);
    this.startMs = this.started ? t : 0;
    this.firstLaunchMs = null;
    this.launches = 0;
    this.tugs = 0;
    this.catches = 0;
    this.autoReturns = 0;
    this.exhausted = 0;
    this.ignoredIntents = 0;
    this.handLosses = 0;
    // A hand that is lost as the session restarts is not part of the new one: its loss began before it.
    this.handLostSinceMs = null;
    this.successfulTugs = 0;
    this.pendingTugs = 0;
    this.latencyNext = 0;
    this.latencyCount = 0;
  }

  /**
   * Feeds one yoyo event. Only the kinds that feed a metric are counted; tether, snap, retether and
   * return-failed are ignored here. hand-lost and hand-found delimit a loss, which counts once it has
   * lasted MIN_HAND_LOSS_MS (see `snapshot` for a loss that is still going on).
   *
   * Tug success follows the PRD wording: a tug counts as successful when a catch follows it
   * before the next launch. A launch therefore discards the tugs still waiting for their catch.
   */
  onEvent(e: YoyoEvent): void {
    if (!this.started) return;
    switch (e.kind) {
      case 'launch':
        this.launches += 1;
        this.pendingTugs = 0;
        if (this.firstLaunchMs === null && Number.isFinite(e.timeMs)) this.firstLaunchMs = Math.max(0, e.timeMs - this.startMs);
        break;
      case 'tug':
        this.tugs += 1;
        this.pendingTugs += 1;
        break;
      case 'catch':
        this.catches += 1;
        this.successfulTugs += this.pendingTugs;
        this.pendingTugs = 0;
        break;
      case 'auto-return':
        this.autoReturns += 1;
        break;
      case 'exhausted':
        this.exhausted += 1;
        break;
      case 'hand-lost':
        // The runtime alternates lost and found; a second lost with no found between is the same loss.
        if (this.handLostSinceMs === null && Number.isFinite(e.timeMs)) this.handLostSinceMs = e.timeMs;
        break;
      case 'hand-found':
        if (this.handLostSinceMs !== null && e.timeMs - this.handLostSinceMs >= this.minHandLossMs) this.handLosses += 1;
        this.handLostSinceMs = null;
        break;
      default:
        break;
    }
  }

  /** An intent was classified while the yoyo did not accept it: a proxy for false triggers. */
  onIgnoredIntent(): void {
    if (this.started) this.ignoredIntents += 1;
  }

  /**
   * Records one capture→render latency in ms. Values that cannot be a latency (negative, NaN)
   * are dropped rather than clamped: a clamped 0 would look like a perfect reaction and hide a
   * clock bug.
   */
  onReaction(latencyMs: number): void {
    if (!this.started || !Number.isFinite(latencyMs) || latencyMs < 0) return;
    this.latencies[this.latencyNext] = latencyMs;
    this.latencyNext = (this.latencyNext + 1) % this.latencies.length;
    this.latencyCount = Math.min(this.latencyCount + 1, this.latencies.length);
  }

  /** A copy of the current metrics: later events never change a snapshot already handed out. */
  snapshot(nowMs: number): YoyoMetrics {
    return {
      sessionMs: this.started && Number.isFinite(nowMs) ? Math.max(0, nowMs - this.startMs) : 0,
      firstLaunchMs: this.firstLaunchMs,
      launches: this.launches,
      tugs: this.tugs,
      catches: this.catches,
      autoReturns: this.autoReturns,
      exhausted: this.exhausted,
      tugSuccessRate: this.tugs === 0 ? Number.NaN : this.successfulTugs / this.tugs,
      ignoredIntents: this.ignoredIntents,
      handLosses: this.handLosses + (this.lossInProgressCounts(nowMs) ? 1 : 0),
      reactionLatencyMs: this.latenciesOldestFirst(),
    };
  }

  /**
   * A hand that is lost at `nowMs` and has been for MIN_HAND_LOSS_MS counts already: a session that ends with
   * the hand out of view for ten seconds had a loss. It is counted once only: when the hand is found again the
   * loss is stored and no longer in progress.
   */
  private lossInProgressCounts(nowMs: number): boolean {
    return this.handLostSinceMs !== null && nowMs - this.handLostSinceMs >= this.minHandLossMs;
  }

  private latenciesOldestFirst(): number[] {
    const capacity = this.latencies.length;
    const oldest = (this.latencyNext - this.latencyCount + capacity) % capacity;
    const out: number[] = [];
    for (let i = 0; i < this.latencyCount; i += 1) out.push(this.latencies[(oldest + i) % capacity]);
    return out;
  }
}
