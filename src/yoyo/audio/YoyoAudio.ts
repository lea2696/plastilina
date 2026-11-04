import type { YoyoAudioLike, YoyoSnapshot } from '../contracts';
import { AudioDirector, type DirectorStats } from './AudioDirector';
import { clamp, finiteOr } from './math';
import { DEFAULT_VOLUME, YoyoAudioGraph } from './YoyoAudioGraph';

/**
 * Where the audio is, for diagnostics and the UI.
 * - locked: no gesture yet, nothing created, silent.
 * - ready: context created and unlocked (it may still be starting to run).
 * - suspended: the page asked for silence (hidden tab).
 * - failed: Web Audio misbehaved; the yoyo plays on without sound.
 * - closed: `close()` was called; terminal.
 */
export type YoyoAudioStatus = 'locked' | 'ready' | 'suspended' | 'failed' | 'closed';

export interface YoyoAudioOptions {
  /** Creates the AudioContext. The default builds a real one; tests inject a fake. */
  createContext?: () => AudioContext;
  /** Told once, with the reason, when audio gives up. The default logs a warning. */
  onFailure?: (error: unknown) => void;
}

/**
 * Audio gives up for good after this many failing updates within FAILURE_WINDOW_MS. One bad frame
 * is survived; a context that keeps failing would only flood the console and burn time in the render
 * loop at 60 Hz. A time window, not a streak: frames with nothing to schedule never fail, so a
 * broken context alternates failing and passing frames and a streak counter would never fill.
 */
const FAILURE_LIMIT = 3;
const FAILURE_WINDOW_MS = 2000;

function defaultCreateContext(): AudioContext {
  if (typeof AudioContext === 'undefined') throw new Error('Web Audio is not available');
  return new AudioContext({ latencyHint: 'interactive' });
}

const ignore = (): void => undefined;

/**
 * Procedural audio for the yoyo (PRD_YOYO.md §6): director → graph, plus the AudioContext lifecycle.
 *
 * Silent until `unlock()` runs from a user gesture: no AudioContext exists before that, so the
 * browser's autoplay policy is never poked. Mute is immediate, the volume control is eased.
 * `suspend()` / `resume()` follow tab visibility; `close()` is terminal and releases everything.
 *
 * Audio must never take the game down: every entry point catches, and repeated failures degrade to
 * silence instead of throwing into the render loop.
 */
export class YoyoAudio implements YoyoAudioLike {
  private readonly createContext: () => AudioContext;
  private readonly onFailure: (error: unknown) => void;
  private readonly director = new AudioDirector();
  private context: AudioContext | null = null;
  private graph: YoyoAudioGraph | null = null;
  private muted = false;
  private volume = DEFAULT_VOLUME;
  private suspended = false;
  private failed = false;
  private closed = false;
  /** Times (on the caller's clock) of the most recent failing updates, newest last. */
  private readonly failureTimes: number[] = [];
  private reported = false;

  constructor(options: YoyoAudioOptions = {}) {
    this.createContext = options.createContext ?? defaultCreateContext;
    this.onFailure = options.onFailure ?? ((error) => console.warn('[yoyo-audio] sound disabled:', error));
  }

  get status(): YoyoAudioStatus {
    if (this.closed) return 'closed';
    if (this.failed) return 'failed';
    if (this.context === null) return 'locked';
    return this.suspended ? 'suspended' : 'ready';
  }

  /** Why sounds were or were not played so far; handy in tests and the diagnostics panel. */
  get stats(): Readonly<DirectorStats> {
    return this.director.stats;
  }

  /**
   * Creates the context on the first call and resumes it on every call. Call it synchronously
   * inside the click handler of «Comenzar con cámara» / «Probar con mouse», before awaiting
   * anything: Chrome lets a context start only while the gesture is fresh (or after the page has
   * had one). Calling it again from later gestures is harmless.
   */
  unlock(): void {
    if (this.closed || this.failed) return;
    try {
      if (this.context === null) this.build();
      this.suspended = false;
      this.director.setUnlocked(true);
      this.resumeContext();
    } catch (error) {
      // Creation failed (no Web Audio, too many contexts): stay locked and silent; a later gesture may retry.
      this.discard();
      this.report(error);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.director.setMuted(muted);
    this.applyOutput();
  }

  setVolume(volume: number): void {
    this.volume = clamp(finiteOr(volume, this.volume), 0, 1);
    this.applyOutput();
  }

  /**
   * Once per rendered frame with the frame's snapshot (events are delivered once, in the snapshot
   * they were emitted in, so do not skip snapshots that carry events). `nowMs` only has to be
   * monotonic: it spaces the rate limits.
   *
   * Nothing is scheduled while the context is not running (autoplay-blocked, suspended, closed):
   * sounds queued then would all burst out on resume.
   */
  update(snapshot: YoyoSnapshot, nowMs: number): void {
    const context = this.context;
    const graph = this.graph;
    if (context === null || graph === null || this.suspended) return;
    try {
      if (context.state === 'closed') {
        this.discard();
        return;
      }
      if (context.state !== 'running') return;
      graph.apply(this.director.update(snapshot, nowMs), context.currentTime);
    } catch (error) {
      if (this.shouldGiveUp(nowMs)) {
        this.failed = true;
        this.discard();
        this.report(error);
      }
    }
  }

  suspend(): void {
    this.suspended = true;
    const context = this.context;
    if (context === null) return;
    try {
      void Promise.resolve(context.suspend()).catch(ignore);
    } catch {
      // Nothing to do: the page just wanted silence and update() already skips while suspended.
    }
  }

  resume(): void {
    this.suspended = false;
    if (this.context !== null) this.resumeContext();
  }

  /** Terminal: releases the voices and the context. Later calls do nothing. */
  close(): void {
    this.closed = true;
    this.discard();
  }

  /** Records a failing update and says whether there have been too many lately. */
  private shouldGiveUp(nowMs: number): boolean {
    this.failureTimes.push(Number.isFinite(nowMs) ? nowMs : 0);
    if (this.failureTimes.length > FAILURE_LIMIT) this.failureTimes.shift();
    return this.failureTimes.length === FAILURE_LIMIT && this.failureTimes[FAILURE_LIMIT - 1] - this.failureTimes[0] <= FAILURE_WINDOW_MS;
  }

  private build(): void {
    const context = this.createContext();
    try {
      const graph = new YoyoAudioGraph(context, context.destination);
      this.context = context;
      this.graph = graph;
      graph.setOutput(this.volume, this.muted, context.currentTime);
    } catch (error) {
      void Promise.resolve(context.close()).catch(ignore);
      throw error;
    }
  }

  private resumeContext(): void {
    const context = this.context;
    if (context === null || context.state === 'running' || context.state === 'closed') return;
    try {
      // A refusal (autoplay policy) leaves it suspended, which is still silent; the next gesture retries.
      void Promise.resolve(context.resume()).catch(ignore);
    } catch {
      // Same: stays suspended.
    }
  }

  private applyOutput(): void {
    const context = this.context;
    if (context === null || this.graph === null) return;
    try {
      this.graph.setOutput(this.volume, this.muted, context.currentTime);
    } catch (error) {
      this.failed = true;
      this.discard();
      this.report(error);
    }
  }

  /** Drops the graph and the context; every step guarded, because teardown must not throw either. */
  private discard(): void {
    const graph = this.graph;
    const context = this.context;
    this.graph = null;
    this.context = null;
    this.director.reset();
    try {
      graph?.dispose();
    } catch {
      // Closing the context below releases the nodes anyway.
    }
    try {
      if (context !== null && context.state !== 'closed') void Promise.resolve(context.close()).catch(ignore);
    } catch {
      // Already closing.
    }
  }

  private report(error: unknown): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.onFailure(error);
    } catch {
      // A throwing reporter must not become the failure it reports.
    }
  }
}
