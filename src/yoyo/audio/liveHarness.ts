import type { YoyoEvent, YoyoSnapshot } from '../contracts';
import { buildSnapshot } from './snapshots';
import { YoyoAudio } from './YoyoAudio';

/**
 * Real-time smoke of YoyoAudio on a real AudioContext, for the QA (scripts/yoyo-audio-qa.ts).
 * The offline renders prove what the voices sound like; this proves the lifecycle on the real thing:
 * nothing exists before unlock, the context starts after a user gesture, sound flows, mute is
 * immediate, suspend/resume/close behave, and nothing throws at 60 Hz.
 *
 * Output is measured with an AnalyserNode that sits between the master chain and the real
 * destination (the audio is handed a proxy whose `destination` is the tap). The page must already
 * have user activation: the script clicks first, as a user would.
 *
 * Browser-only; nothing in the app imports this file.
 */

export interface LiveSmokeResult {
  contextsBeforeUnlock: number;
  statusBeforeUnlock: string;
  peakBeforeUnlock: number;
  stateAfterUnlock: string;
  statusAfterUnlock: string;
  peakWhilePlaying: number;
  playedWhilePlaying: Record<string, number>;
  /** Time from setMuted(true) until the tap read silence, ms (the tap's window is ~43 ms, so this includes it). */
  muteSettleMs: number;
  peakAfterMute: number;
  peakAfterUnmute: number;
  stateAfterSuspend: string;
  statusAfterSuspend: string;
  playedWhileSuspended: number;
  stateAfterResume: string;
  stateAfterClose: string;
  statusAfterClose: string;
  /** Exceptions thrown out of any YoyoAudio call. Must be empty. */
  thrown: string[];
  updates: number;
}

const FRAME_MS = 1000 / 60;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLiveSmoke(): Promise<LiveSmokeResult> {
  const thrown: string[] = [];
  const guard = <T>(label: string, call: () => T): T | undefined => {
    try {
      return call();
    } catch (error) {
      thrown.push(`${label}: ${String(error)}`);
      return undefined;
    }
  };

  const contexts: AudioContext[] = [];
  let tap: AnalyserNode | null = null;
  const audio = new YoyoAudio({
    createContext: () => {
      const real = new AudioContext({ latencyHint: 'interactive' });
      const analyser = real.createAnalyser();
      analyser.fftSize = 2048;
      analyser.connect(real.destination);
      tap = analyser;
      contexts.push(real);
      return new Proxy(real, {
        get(target, property) {
          if (property === 'destination') return analyser;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });

  const peak = (): number => {
    if (tap === null) return 0;
    const samples = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(samples);
    let max = 0;
    for (const x of samples) max = Math.max(max, Math.abs(x));
    return max;
  };

  let updates = 0;
  /** A sleeping yoyo at 700 rad/s; the first frame carries the launch if asked. */
  const drive = async (ms: number, firstEvents: Array<Omit<YoyoEvent, 'timeMs'>> = []) => {
    const start = performance.now();
    let first = true;
    while (performance.now() - start < ms) {
      const now = performance.now();
      const snapshot: YoyoSnapshot = buildSnapshot({ timeMs: now, phase: 'sleeping', spin: 700, events: first ? firstEvents.map((e) => ({ ...e, timeMs: now })) : [] });
      first = false;
      guard('update', () => audio.update(snapshot, now));
      updates += 1;
      await sleep(FRAME_MS);
    }
  };

  // Before the gesture: nothing exists, nothing sounds.
  await drive(200, [{ kind: 'launch', strength: 2.4 }]);
  const contextsBeforeUnlock = contexts.length;
  const statusBeforeUnlock = audio.status;
  const peakBeforeUnlock = peak();

  // The gesture: unlock, and wait for the context to run.
  guard('unlock', () => audio.unlock());
  for (let i = 0; i < 100 && contexts[0]?.state !== 'running'; i += 1) await sleep(10);
  const stateAfterUnlock = contexts[0]?.state ?? 'none';
  const statusAfterUnlock = audio.status;

  // Playing: a launch and a hum.
  await drive(1000, [{ kind: 'launch', strength: 2.4 }]);
  const peakWhilePlaying = peak();
  const playedWhilePlaying = { ...audio.stats.played };

  // Mute is immediate: read the tap as often as it can be read until it is silent.
  guard('mute', () => audio.setMuted(true));
  const muteAt = performance.now();
  let muteSettleMs = Number.POSITIVE_INFINITY;
  while (performance.now() - muteAt < 600) {
    await drive(FRAME_MS);
    if (peak() === 0) {
      muteSettleMs = performance.now() - muteAt;
      break;
    }
  }
  await drive(150);
  const peakAfterMute = peak();
  guard('unmute', () => audio.setMuted(false));
  await drive(400);
  const peakAfterUnmute = peak();

  // Hidden tab: suspend plays nothing and the next launch does not queue up.
  guard('suspend', () => audio.suspend());
  await sleep(200);
  const stateAfterSuspend = contexts[0]?.state ?? 'none';
  const statusAfterSuspend = audio.status;
  const before = Object.values(audio.stats.played).reduce((a, b) => a + b, 0);
  await drive(500, [{ kind: 'catch', strength: 2 }]);
  const playedWhileSuspended = Object.values(audio.stats.played).reduce((a, b) => a + b, 0) - before;
  guard('resume', () => audio.resume());
  for (let i = 0; i < 100 && contexts[0]?.state !== 'running'; i += 1) await sleep(10);
  const stateAfterResume = contexts[0]?.state ?? 'none';

  // Teardown.
  guard('close', () => audio.close());
  await sleep(100);
  const stateAfterClose = contexts[0]?.state ?? 'none';
  await drive(100);

  return {
    contextsBeforeUnlock, statusBeforeUnlock, peakBeforeUnlock, stateAfterUnlock, statusAfterUnlock, peakWhilePlaying,
    playedWhilePlaying, muteSettleMs, peakAfterMute, peakAfterUnmute, stateAfterSuspend, statusAfterSuspend,
    playedWhileSuspended, stateAfterResume, stateAfterClose, statusAfterClose: audio.status, thrown, updates,
  };
}
