import type { HandDetection, HandFrame } from '../../shared/contracts';
import type { AnchorObservation, AnchorSample, FrameEdge, Vec2 } from '../contracts';
import type { YoyoConfig } from '../config';
import { fitLine } from './robust';

/** Camera frames are 640×480, so image width is 4/3 image heights (ih). */
const ASPECT = 4 / 3;
/** Middle-finger MCP: it barely moves when the finger curls, unlike the tip or the PIP/DIP joints. */
const ANCHOR_LANDMARK = 9;
const WRIST = 0;
/** Knuckles whose mean distance to the wrist defines the apparent palm size (same set as Masa's HandMapper). */
const PALM_KNUCKLES = [5, 9, 13, 17] as const;
const LANDMARK_COUNT = 21;
/** A hand smaller than this is a degenerate detection, not a hand (HandMapper rejects it too). */
const MIN_PALM_SIZE = 0.01;

/** One hand reduced to what selection and continuity need; its landmarks are mirrored only if it wins. */
interface Candidate {
  hand: HandDetection;
  x: number;
  y: number;
  palmSize: number;
}

interface Selection {
  candidate: Candidate;
  /** Distance from the last accepted anchor (Infinity without a track). */
  distance: number;
  /** A second hand is as close to the last anchor as this one: identity cannot be trusted. */
  ambiguous: boolean;
}

/** Last sample that was handed to the consumer: the pre-jump truth that new samples are judged against. */
interface Track {
  x: number;
  y: number;
  palmSize: number;
  timestampMs: number;
}

/** Where and when the last sample was: kept through the absence that follows it, so each of its frames can name the exit edge. */
interface LastSeen {
  /** Anchor height. */
  y: number;
  edge: FrameEdge | undefined;
  timestampMs: number;
  /** The first frame without the hand decides the exit edge once; every later frame of the absence repeats it. */
  decided: boolean;
  exitEdge: FrameEdge | undefined;
}

/** Samples remembered for the exit inference: three intervals are enough to see a fast hand, and few enough to follow an explosive start. */
const TRAIL_CAPACITY = 4;

/**
 * Height of the lowest landmark of the last few samples with their times: how fast, and from how
 * far down, a hand was heading when it vanished. The lowest landmark is the first part of a hand to
 * cross the bottom edge. Fixed slots, the oldest overwritten: it never grows.
 */
class LowestTrail {
  private readonly times = new Float64Array(TRAIL_CAPACITY);
  private readonly heights = new Float64Array(TRAIL_CAPACITY);
  private count = 0;

  clear() {
    this.count = 0;
  }

  /** A sample that does not continue the one before starts the trail over: a rate across a break means nothing. */
  push(timestampMs: number, y: number, continuous: boolean) {
    if (!continuous) this.count = 0;
    if (this.count === TRAIL_CAPACITY) {
      this.times.copyWithin(0, 1);
      this.heights.copyWithin(0, 1);
      this.count--;
    }
    this.times[this.count] = timestampMs;
    this.heights[this.count] = y;
    this.count++;
  }

  /** Height of the newest sample's lowest landmark; meaningful only after a push. */
  get latest(): number {
    return this.heights[this.count - 1];
  }

  /**
   * How fast the lowest landmark was going down, ih/s: the faster of the least-squares rate over the
   * trail (steady, but late to notice a throw that starts from rest) and the last interval's rate
   * (up to date, but with ±0.28 ih/s of jitter). 0 with fewer than two samples; negative when it was going up.
   */
  get rate(): number {
    const n = this.count;
    if (n < 2) return 0;
    const lastInterval = ((this.heights[n - 1] - this.heights[n - 2]) / (this.times[n - 1] - this.times[n - 2])) * 1000;
    const fit = fitLine(i => ({ t: this.times[i], x: 0, y: this.heights[i] }), 0, n);
    return fit ? Math.max(lastInterval, fit.vy) : lastInterval;
  }
}

/** A jumped sample waiting for the next frame to say whether it was a glitch or a real relocation. */
interface Suspect {
  x: number;
  y: number;
  palmSize: number;
  timestampMs: number;
  /** It broke a hard limit: if confirmed, the relocation is discontinuous. Otherwise it was just fast. */
  hard: boolean;
}

/** Mirrors x exactly once: MediaPipe x grows to the camera's right, the user sees a mirror. */
const mirrorX = (x: number) => (1 - x) * ASPECT;

/** Mean wrist→knuckle distance in ih with relative z, so tilting the hand barely changes it (as in HandMapper). */
function palmSizeOf(hand: HandDetection): number {
  const w = hand.landmarks[WRIST];
  let sum = 0;
  for (const i of PALM_KNUCKLES) {
    const p = hand.landmarks[i];
    sum += Math.hypot((p.x - w.x) * ASPECT, p.y - w.y, (p.z - w.z) * ASPECT);
  }
  return sum / PALM_KNUCKLES.length;
}

/** Which border a mirrored landmark set touches. Bottom wins: it is where throws leave the frame. */
function edgeOf(points: readonly Vec2[], margin: number): FrameEdge | undefined {
  let bottom = false, top = false, left = false, right = false;
  for (const [x, y] of points) {
    if (y > 1 - margin) bottom = true;
    if (y < margin) top = true;
    if (x < margin) left = true;
    if (x > ASPECT - margin) right = true;
  }
  if (bottom) return 'bottom';
  if (top) return 'top';
  if (left) return 'left';
  if (right) return 'right';
  return undefined;
}

/**
 * Turns MediaPipe HandFrames into the single stream the intent classifiers trust: one anchor
 * sample per frame for the throwing hand, or an explicit absence.
 *
 * It owns everything that decides whether two consecutive samples may be differenced: hand
 * identity, gaps, impossible speeds, palm-size spikes. A sample that breaks any of these says so
 * with `continuous: false` and consumers must start a fresh history, never difference across it.
 *
 * One-frame glitches (a wrong detection for a single frame) must not reach the classifiers at
 * all, since a 0.2 ih jump looks exactly like a flick. A jumped sample is therefore held back as a
 * «suspect» and judged by the next frame: if the next frame continues the old track the suspect
 * is dropped without a trace; if the next frame agrees with the suspect (near it, similar speed
 * and palm size) the relocation was real and the new position is emitted, discontinuous when it
 * broke a hard limit and continuous when it was merely fast. Only jumps pay that frame of delay;
 * everything else is immediate. A frame held back returns null from `observe`.
 *
 * What it cannot catch: a glitch on the very first frame (there is no track to compare with),
 * and a 0.15–0.27 ih jump right after a dropped frame, whose speed over the longer gap is
 * indistinguishable from a fast stroke. About 2 % of glitch frames in the synthetic corpus.
 *
 * A short absence does not end the track. MediaPipe loses a hand for one to four frames when a
 * fast stroke blurs it (10 of Luis's 19 throws), and it comes back 0.3 ih lower. How far the hand
 * may have travelled is judged by speed over the real time since the last sample (perception.maxSpeed),
 * not by a fixed distance, so a hand that reappears within perception.strokeGapMs at a plausible
 * place continues its track and the consumer keeps its history. Only a longer absence (or an
 * impossible speed) is a discontinuity.
 *
 * Every threshold (crossing margin, suspect fractions, bottom-exit height, the hard limits) lives
 * in YoyoConfig.perception and is read on every frame, so `setConfig` applies live.
 *
 * An absence names the edge the hand left through (see `absence`). The decision is taken once, on the
 * first frame without the hand, and repeated on every later frame: the consumer shows its frame-edge
 * vignette from the latest absence it hears, so an edge that was named and then dropped would blink out.
 *
 * Deterministic: time comes only from frame timestamps and the arrival argument.
 */
export class AnchorExtractor {
  private config: YoyoConfig;
  private lastTimestampMs = -Infinity;
  private track: Track | null = null;
  private suspect: Suspect | null = null;
  /** The last emitted sample, kept through absences so each frame of one can name the exit edge. */
  private exit: LastSeen | null = null;
  /** Lowest landmark of the last few emitted samples: where a vanished hand was heading. */
  private readonly trail = new LowestTrail();

  constructor(config: YoyoConfig) {
    this.config = config;
  }

  /** Live tuning: thresholds are read on every frame, history is kept. */
  setConfig(config: YoyoConfig) {
    this.config = config;
  }

  /** Forget the track, the pending suspect and the clock (pause, recalibration, new replay). */
  reset() {
    this.lastTimestampMs = -Infinity;
    this.track = null;
    this.suspect = null;
    this.exit = null;
    this.trail.clear();
  }

  /**
   * Reads one frame. Returns null when the frame yields nothing new: its timestamp does not
   * advance (out of order or duplicated), or its sample is being held as a suspect glitch.
   * Otherwise a sample of the tracked hand or an absence.
   */
  observe(frame: HandFrame, arrivalMs: number): AnchorObservation | null {
    // Written as a negated comparison so a NaN timestamp is ignored as well.
    if (!(frame.timestampMs > this.lastTimestampMs)) return null;
    this.lastTimestampMs = frame.timestampMs;

    const candidates = this.validHands(frame);
    if (candidates.length === 0) return this.absence(frame, arrivalMs);
    return this.admit(frame, arrivalMs, this.select(candidates, frame.timestampMs));
  }

  private validHands(frame: HandFrame): Candidate[] {
    const out: Candidate[] = [];
    for (const hand of frame.hands) {
      if (hand.landmarks.length !== LANDMARK_COUNT) continue;
      if (!hand.landmarks.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) continue;
      const palmSize = palmSizeOf(hand);
      if (!(palmSize > MIN_PALM_SIZE)) continue;
      const anchor = hand.landmarks[ANCHOR_LANDMARK];
      out.push({ hand, x: mirrorX(anchor.x), y: anchor.y, palmSize });
    }
    return out;
  }

  /**
   * The last emitted sample as far as it can still be continued at `timestampMs`. It survives an
   * absence, but not one longer than perception.strokeGapMs, which is too stale to follow. The clock
   * of that limit is the last frame that SAW the hand, so a frame held back as a suspect counts: it
   * is a hand detection, and at the camera's slow moments (67 ms frames) holding one frame would
   * otherwise stretch the time since the last emitted sample past the limit and cut the track.
   */
  private trackAt(timestampMs: number): Track | null {
    const track = this.track;
    if (!track) return null;
    const seenMs = this.suspect ? this.suspect.timestampMs : track.timestampMs;
    return timestampMs - seenMs <= this.config.perception.strokeGapMs ? track : null;
  }

  /** No track: the biggest palm is the hand nearest the camera, the one meant to throw. Else follow the anchor. */
  private select(candidates: Candidate[], timestampMs: number): Selection {
    const track = this.trackAt(timestampMs);
    if (!track) {
      let best = candidates[0];
      for (const c of candidates) if (c.palmSize > best.palmSize) best = c;
      return { candidate: best, distance: Infinity, ambiguous: false };
    }
    const ranked = candidates
      .map(candidate => ({ candidate, distance: Math.hypot(candidate.x - track.x, candidate.y - track.y) }))
      .sort((a, b) => a.distance - b.distance);
    const [nearest, second] = ranked;
    const { identityGate, crossingMargin } = this.config.perception;
    const ambiguous = second !== undefined && second.distance <= identityGate && second.distance - nearest.distance < crossingMargin;
    return { candidate: nearest.candidate, distance: nearest.distance, ambiguous };
  }

  /** Decides what the selected hand's sample becomes: emitted, emitted discontinuous, or held. */
  private admit(frame: HandFrame, arrivalMs: number, pick: Selection): AnchorObservation | null {
    const { candidate: c, ambiguous } = pick;
    // The first sample after a reset has nothing to continue, nor has one that follows a gap (an
    // absence included) longer than perception.strokeGapMs: that track is too stale to judge a jump against.
    const track = this.trackAt(frame.timestampMs);
    if (!track) return this.emit(frame, arrivalMs, c, false);

    const gapMs = frame.timestampMs - track.timestampMs;
    const p = this.config.perception;
    // Distance is judged as speed over the real time since the track's last sample, so one dropped
    // frame or a short absence stretches what the hand may have covered; the old fixed 0.25 ih gate
    // threw away Luis's fastest strokes (0.3 ih in a 65 ms gap is 4.6 ih/s, a downstroke).
    const speed = pick.distance / (gapMs / 1000);
    const palmChange = Math.abs(c.palmSize / track.palmSize - 1);
    const hard = speed > p.maxSpeed || palmChange > p.maxPalmJump;
    const soft = speed > p.maxSpeed * p.speedSuspectFraction || palmChange > p.maxPalmJump * p.palmSuspectFraction;
    if (!hard && !soft) return this.emit(frame, arrivalMs, c, !ambiguous);

    if (this.confirms(c, frame.timestampMs)) {
      // Two frames in a row agree on the new place: a relocation (or just a very fast move), not a glitch.
      return this.emit(frame, arrivalMs, c, !(this.suspect!.hard || hard));
    }
    // First jumped frame (or one that agrees with nothing): hold it, show nothing.
    this.suspect = { x: c.x, y: c.y, palmSize: c.palmSize, timestampMs: frame.timestampMs, hard };
    return null;
  }

  /**
   * Does this frame confirm the pending suspect? It must continue the suspect as a hand would:
   * near it, at a plausible speed and with a similar palm size. Two different wrong frames in a
   * row (a palm spike up, then one down) disagree on size and so never vouch for each other.
   */
  private confirms(c: Candidate, timestampMs: number): boolean {
    const suspect = this.suspect;
    if (!suspect) return false;
    const p = this.config.perception;
    const distance = Math.hypot(c.x - suspect.x, c.y - suspect.y);
    if (distance > p.identityGate) return false;
    const seconds = (timestampMs - suspect.timestampMs) / 1000;
    if (distance / seconds > p.maxSpeed * p.speedSuspectFraction) return false;
    return Math.abs(c.palmSize / suspect.palmSize - 1) <= p.maxPalmJump * p.palmSuspectFraction;
  }

  private emit(frame: HandFrame, arrivalMs: number, c: Candidate, continuous: boolean): AnchorObservation {
    const landmarks: Vec2[] = c.hand.landmarks.map(p => [mirrorX(p.x), p.y] as const);
    const edge = edgeOf(landmarks, this.config.perception.edgeMargin);
    const sample: AnchorSample = {
      timestampMs: frame.timestampMs,
      arrivalMs,
      source: frame.source,
      x: c.x,
      y: c.y,
      palmSize: c.palmSize,
      continuous,
      ...(edge ? { edge } : {}),
      landmarks,
    };
    this.trail.push(frame.timestampMs, landmarks.reduce((lowest, p) => Math.max(lowest, p[1]), -Infinity), continuous);
    this.track = { x: c.x, y: c.y, palmSize: c.palmSize, timestampMs: frame.timestampMs };
    this.suspect = null;
    this.exit = { y: c.y, edge, timestampMs: frame.timestampMs, decided: false, exitEdge: undefined };
    return { kind: 'sample', sample };
  }

  /**
   * The hand is gone. The first frame without it decides which edge it left through, and every later
   * frame of the absence repeats that decision: whatever edge the last sample touched, else the
   * bottom (see `inferBottomExit`), else none.
   */
  private absence(frame: HandFrame, arrivalMs: number): AnchorObservation {
    const last = this.exit;
    if (last && !last.decided) {
      last.exitEdge = last.edge ?? this.inferBottomExit(last, frame.timestampMs);
      last.decided = true;
    }
    const exitEdge = last?.exitEdge;
    // The track outlives the absence (see trackAt); a frame held as a suspect does not: nothing can confirm it any more.
    this.suspect = null;
    return {
      kind: 'absent',
      timestampMs: frame.timestampMs,
      arrivalMs,
      source: frame.source,
      ...(exitEdge ? { exitEdge } : {}),
    };
  }

  /**
   * Did a hand whose last sample touched no border still leave through the bottom? Yes if
   *
   * - its anchor was low in the frame (below perception.bottomExitY), or
   * - it was heading out: a fast throw goes from fully visible to gone within a frame or two, and
   *   the camera drops frames on top, so its last sample need not be near the edge. Its lowest
   *   landmark is carried on at its recent downward speed over the time since that sample (the
   *   actual gap, which dropped frames stretch to two or three intervals, but at most
   *   perception.maxGapMs of travel), and if that lands inside the bottom margin (the zone in
   *   which a visible hand would have flagged the bottom edge) the hand left that way. A sample older
   *   than perception.staleMs is no evidence of where the hand was heading.
   *
   * A hand that vanished mid-frame (occlusion, a tracking loss) was neither low nor fast enough
   * to get there, and is not given an edge: the vignette would lie about where to bring it back.
   */
  private inferBottomExit(last: LastSeen, timestampMs: number): FrameEdge | undefined {
    const { bottomExitY, edgeMargin, maxGapMs, staleMs } = this.config.perception;
    if (last.y > bottomExitY) return 'bottom';
    const sinceMs = timestampMs - last.timestampMs;
    if (sinceMs > staleMs) return undefined;
    const reachedY = this.trail.latest + (Math.max(0, this.trail.rate) * Math.min(sinceMs, maxGapMs)) / 1000;
    return reachedY > 1 - edgeMargin ? 'bottom' : undefined;
  }
}
