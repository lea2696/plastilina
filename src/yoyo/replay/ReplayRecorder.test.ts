import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandDetection, HandFrame } from '../../shared/contracts';
import type { ReplayFile } from '../contracts';
import { DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_FRAMES, ReplayRecorder, downloadReplay } from './ReplayRecorder';
import { Random } from './random';
import { parseReplay, replayFrames, serializeReplay } from './replayFile';

/** 21 landmarks with digits well beyond the 1e-5 the recorder keeps, so rounding is observable. */
const hand = (handedness: HandDetection['handedness'] = 'Right', shift = 0): HandDetection => ({
  handedness,
  landmarks: Array.from({ length: 21 }, (_, i) => ({
    x: 0.3 + i * 0.0123456789 + shift,
    y: 0.4 + i * 0.0098765432,
    z: -0.0011223344 * (i + 1),
  })),
});

const frameAt = (timestampMs: number, hands: readonly HandDetection[] = [hand()]): HandFrame => ({ timestampMs, source: 'camera', hands });

/** A started recorder with `count` frames at `periodMs`, arriving 50 ms after capture. */
function recordFrames(recorder: ReplayRecorder, count: number, periodMs = 1000 / 30, originMs = 40_000): void {
  for (let i = 0; i < count; i += 1) {
    const capture = originMs + i * periodMs;
    recorder.add(frameAt(capture), capture + 50);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReplayRecorder', () => {
  describe('lifecycle', () => {
    it('records nothing until started', () => {
      const recorder = new ReplayRecorder();
      recorder.add(frameAt(1000), 1050);
      recorder.markDetected('launch', 1000);
      expect(recorder.recording).toBe(false);
      expect(recorder.frameCount).toBe(0);
      expect(recorder.toFile().frames).toEqual([]);
      expect(recorder.toFile().detected).toEqual([]);
    });

    it('records while started and keeps what it has after stop', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      expect(recorder.recording).toBe(true);
      recordFrames(recorder, 5);
      recorder.stop();
      expect(recorder.recording).toBe(false);
      expect(recorder.full).toBe(false);
      expect(recorder.frameCount).toBe(5);

      // A stopped recorder ignores further frames but still builds its file.
      recorder.add(frameAt(99_999), 100_000);
      expect(recorder.frameCount).toBe(5);
      expect(recorder.toFile().frames).toHaveLength(5);
    });

    it('start discards the previous recording and begins a new origin', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 10, 33, 1000);
      recorder.markDetected('launch', 1100);
      recorder.start();
      expect(recorder.frameCount).toBe(0);
      expect(recorder.durationMs).toBe(0);
      expect(recorder.toFile().detected).toEqual([]);
      recorder.add(frameAt(500_000), 500_040);
      expect(recorder.toFile().frames[0]).toMatchObject({ t: 0, a: 40 });
    });

    it('clear stops the recording and forgets everything, including the full flag', () => {
      const recorder = new ReplayRecorder(1000, 3);
      recorder.start();
      recordFrames(recorder, 10);
      expect(recorder.full).toBe(true);
      recorder.clear();
      expect(recorder.recording).toBe(false);
      expect(recorder.full).toBe(false);
      expect(recorder.frameCount).toBe(0);
      expect(recorder.durationMs).toBe(0);
    });

    it('rejects nonsensical caps', () => {
      for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new ReplayRecorder(duration, 10)).toThrow(RangeError);
      for (const frames of [0, -3, 1.5, Number.NaN]) expect(() => new ReplayRecorder(1000, frames)).toThrow(RangeError);
    });
  });

  describe('caps', () => {
    it('stops by itself at the frame cap and keeps exactly that many frames', () => {
      const recorder = new ReplayRecorder(1_000_000, 5);
      recorder.start();
      recordFrames(recorder, 12);
      expect(recorder.frameCount).toBe(5);
      expect(recorder.recording).toBe(false);
      expect(recorder.full).toBe(true);
      expect(recorder.toFile().frames).toHaveLength(5);
    });

    it('stops by itself at the duration cap without storing the frame that crosses it', () => {
      const recorder = new ReplayRecorder(100, 1000);
      recorder.start();
      for (const t of [0, 33, 66, 99]) recorder.add(frameAt(5000 + t), 5000 + t + 40);
      expect(recorder.recording).toBe(true);
      expect(recorder.full).toBe(false);

      recorder.add(frameAt(5132), 5172);
      expect(recorder.recording).toBe(false);
      expect(recorder.full).toBe(true);
      expect(recorder.frameCount).toBe(4);
      expect(recorder.durationMs).toBe(99);
    });

    it('accepts a frame exactly at the duration cap, then stops on the next', () => {
      const recorder = new ReplayRecorder(100, 1000);
      recorder.start();
      recorder.add(frameAt(1000), 1040);
      recorder.add(frameAt(1100), 1140);
      expect(recorder.frameCount).toBe(2);
      expect(recorder.recording).toBe(true);
      recorder.add(frameAt(1100.5), 1141);
      expect(recorder.frameCount).toBe(2);
      expect(recorder.full).toBe(true);
    });

    it('has defaults of two minutes and 4000 frames, and stops at 120 s at 30 fps', () => {
      expect(DEFAULT_MAX_DURATION_MS).toBe(120_000);
      expect(DEFAULT_MAX_FRAMES).toBe(4000);
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 4000);
      expect(recorder.full).toBe(true);
      expect(recorder.frameCount).toBe(3601);
      expect(recorder.durationMs).toBe(120_000);
    });

    it('stops at 4000 frames when tracking runs faster than 30 fps', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 5000, 10);
      expect(recorder.frameCount).toBe(4000);
      expect(recorder.durationMs).toBeCloseTo(39_990, 3);
      expect(recorder.full).toBe(true);
    });

    it('can start a new recording after a cap stopped the last one', () => {
      const recorder = new ReplayRecorder(1000, 2);
      recorder.start();
      recordFrames(recorder, 5);
      expect(recorder.full).toBe(true);
      recorder.start();
      expect(recorder.full).toBe(false);
      expect(recorder.recording).toBe(true);
      recordFrames(recorder, 1);
      expect(recorder.frameCount).toBe(1);
    });

    it('bounds the list of detections', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recorder.add(frameAt(0), 40);
      for (let i = 0; i < 5000; i += 1) recorder.markDetected('tug', i);
      expect(recorder.toFile().detected).toHaveLength(1000);
    });
  });

  describe('what is stored', () => {
    it('stores times relative to the first frame, for capture and arrival alike', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      const origin = 98_765.4321;
      recorder.add(frameAt(origin), origin + 48.5);
      recorder.add(frameAt(origin + 33.3333), origin + 33.3333 + 51);
      recorder.add(frameAt(origin + 66.6667), origin + 66.6667 + 120.25);
      const { frames } = recorder.toFile();
      expect(frames.map(f => f.t)).toEqual([0, 33.333, 66.667]);
      expect(frames.map(f => f.a)).toEqual([48.5, 84.333, 186.917]);
      expect(recorder.durationMs).toBe(66.667);
    });

    it('rounds landmarks to 1e-5 and keeps handedness', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      const source = hand('Left');
      recorder.add(frameAt(0, [source, hand('Right', 0.1), hand('Unknown')]), 40);
      const { hands } = recorder.toFile().frames[0];
      expect(hands.map(h => h.h)).toEqual(['Left', 'Right', 'Unknown']);
      hands[0].lm.forEach((point, i) => {
        const original = source.landmarks[i];
        expect(point).toEqual([Math.round(original.x * 1e5) / 1e5, Math.round(original.y * 1e5) / 1e5, Math.round(original.z * 1e5) / 1e5]);
        // Never further than half a unit in the fifth decimal from what the tracker said.
        expect(Math.abs(point[0] - original.x)).toBeLessThanOrEqual(5e-6 + 1e-12);
        expect(Math.abs(point[1] - original.y)).toBeLessThanOrEqual(5e-6 + 1e-12);
        expect(Math.abs(point[2] - original.z)).toBeLessThanOrEqual(5e-6 + 1e-12);
      });
      // 5 decimals at most: no floating-point tails in the file.
      expect(JSON.stringify(hands[0].lm)).not.toMatch(/\d\.\d{6,}/);
    });

    it('writes 0 rather than -0 for tiny negative values', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      const tiny = { handedness: 'Right' as const, landmarks: Array.from({ length: 21 }, () => ({ x: -0.000001, y: 0.5, z: -0.000002 })) };
      recorder.add(frameAt(0, [tiny]), 40);
      const [point] = recorder.toFile().frames[0].hands[0].lm;
      expect(Object.is(point[0], 0)).toBe(true);
      expect(Object.is(point[2], 0)).toBe(true);
    });

    it('stores exactly the schema fields and nothing the frame object happens to carry', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      const dirty = {
        timestampMs: 1000,
        source: 'camera' as const,
        image: 'data:image/png;base64,SECRETPIXELS',
        deviceLabel: 'FaceTime HD Camera',
        capturedAt: '2026-10-01T12:00:00Z',
        hands: [
          {
            handedness: 'Right' as const,
            handednessScore: 0.987,
            userName: 'luis',
            landmarks: Array.from({ length: 21 }, (_, i) => ({ x: 0.1 * (i % 5), y: 0.2, z: 0.01, visibility: 0.9, presence: 0.8 })),
          },
        ],
      } as unknown as HandFrame;
      recorder.add(dirty, 1040);
      const file = recorder.toFile();
      const text = serializeReplay(file);

      for (const secret of ['SECRETPIXELS', 'FaceTime', '2026-10-01', 'luis', 'handednessScore', 'visibility', 'presence', 'image', 'deviceLabel']) {
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(file).sort()).toEqual(['detected', 'frames', 'schema']);
      const [stored] = file.frames;
      expect(Object.keys(stored).sort()).toEqual(['a', 'hands', 't']);
      expect(Object.keys(stored.hands[0]).sort()).toEqual(['h', 'lm']);
      expect(stored.hands[0].lm.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))).toBe(true);
    });

    it('serializes exactly the schema keys, with the optional ones only when given', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 3);
      recorder.markDetected('launch', 40_033);
      const bare = JSON.parse(serializeReplay(recorder.toFile())) as Record<string, unknown>;
      expect(Object.keys(bare).sort()).toEqual(['detected', 'frames', 'schema']);

      const full = JSON.parse(serializeReplay(recorder.toFile({ launch: { minDownSpeed: 1.2 } }, 'sentado'))) as Record<string, unknown>;
      expect(Object.keys(full).sort()).toEqual(['config', 'detected', 'frames', 'note', 'schema']);
      // `labels` is for ground truth added later by hand, never written by the recorder.
      expect(full).not.toHaveProperty('labels');

      const frames = full.frames as Array<Record<string, unknown>>;
      expect(frames.every(f => Object.keys(f).sort().join() === 'a,hands,t')).toBe(true);
      const detected = full.detected as Array<Record<string, unknown>>;
      expect(detected.every(d => Object.keys(d).sort().join() === 'kind,t')).toBe(true);
      expect(full.schema).toBe('yoyo-replay/1');
    });

    it('carries no wall-clock date or other ambient data: the same recording gives the same file', () => {
      const build = () => {
        const recorder = new ReplayRecorder();
        recorder.start();
        recordFrames(recorder, 4);
        recorder.markDetected('tug', 40_066);
        return serializeReplay(recorder.toFile({ a: 1 }, 'nota'));
      };
      expect(build()).toBe(build());
    });

    it('maps an unknown handedness label to Unknown so the file always loads', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      const odd = { handedness: 'Both', landmarks: hand().landmarks } as unknown as HandDetection;
      recorder.add(frameAt(0, [odd]), 40);
      expect(recorder.toFile().frames[0].hands[0].h).toBe('Unknown');
    });

    it('stores frames with no hand as empty frames', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recorder.add(frameAt(0, []), 40);
      expect(recorder.toFile().frames[0]).toEqual({ t: 0, a: 40, hands: [] });
    });

    it('clamps arrival to capture time, since a result cannot arrive before its frame', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recorder.add(frameAt(1000), 1040);
      recorder.add(frameAt(1033), 1000);
      expect(recorder.toFile().frames[1]).toMatchObject({ t: 33, a: 33 });
    });
  });

  describe('frames it will not store', () => {
    it('skips what the parser would reject, leaving a gap instead of a half-true frame', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recorder.add(frameAt(1000), 1040);

      const nan: HandDetection = { handedness: 'Right', landmarks: hand().landmarks.map((p, i) => (i === 4 ? { ...p, x: Number.NaN } : p)) };
      recorder.add(frameAt(1033, [nan]), 1073);
      recorder.add(frameAt(1033, [{ handedness: 'Right', landmarks: hand().landmarks.slice(0, 20) }]), 1073);
      recorder.add(frameAt(1033, [{ handedness: 'Right', landmarks: [...hand().landmarks, { x: 0, y: 0, z: 0 }] }]), 1073);
      recorder.add(frameAt(Number.NaN), 1073);
      recorder.add(frameAt(1033), Number.POSITIVE_INFINITY);
      expect(recorder.frameCount).toBe(1);

      // Capture times must strictly increase: a repeated or older timestamp is skipped.
      recorder.add(frameAt(1066), 1100);
      recorder.add(frameAt(1066), 1101);
      recorder.add(frameAt(1050), 1102);
      expect(recorder.frameCount).toBe(2);
      recorder.add(frameAt(1099), 1140);
      expect(recorder.frameCount).toBe(3);

      const file = recorder.toFile();
      expect(file.frames.map(f => f.t)).toEqual([0, 66, 99]);
      expect(() => parseReplay(serializeReplay(file))).not.toThrow();
    });

    it('always produces a file the parser accepts, whatever mix of frames it was fed', () => {
      const recorder = new ReplayRecorder(60_000, 2000);
      recorder.start();
      let t = 7_000_000;
      for (let i = 0; i < 1500; i += 1) {
        t += i % 17 === 0 ? 0 : (i % 5 === 0 ? -3 : 33.37);
        const hands = i % 11 === 0 ? [] : i % 7 === 0 ? [hand('Left'), hand('Right', 0.2)] : [hand()];
        recorder.add(frameAt(t, hands), t + (i % 4 === 0 ? -10 : 45));
      }
      expect(() => parseReplay(serializeReplay(recorder.toFile()))).not.toThrow();
    });
  });

  describe('detections', () => {
    it('stores what the live classifier fired, relative to the first frame', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recorder.add(frameAt(10_000), 10_040);
      recorder.markDetected('launch', 10_500.1234);
      recorder.markDetected('tug', 12_000);
      expect(recorder.toFile().detected).toEqual([{ kind: 'launch', t: 500.123 }, { kind: 'tug', t: 2000 }]);
    });

    it('ignores detections while not recording, before the first frame, or from before it', () => {
      const recorder = new ReplayRecorder();
      recorder.markDetected('launch', 100);
      recorder.start();
      recorder.markDetected('launch', 100);
      recorder.add(frameAt(10_000), 10_040);
      recorder.markDetected('tug', 9000);
      recorder.markDetected('tug', Number.NaN);
      recorder.stop();
      recorder.markDetected('launch', 10_100);
      expect(recorder.toFile().detected).toEqual([]);
    });
  });

  describe('toFile', () => {
    it('omits note and config when not given, trims the note and caps its length', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 1);
      expect(recorder.toFile()).not.toHaveProperty('note');
      expect(recorder.toFile()).not.toHaveProperty('config');
      expect(recorder.toFile(undefined, '   ')).not.toHaveProperty('note');
      expect(recorder.toFile(undefined, '  luz de ventana  ').note).toBe('luz de ventana');
      expect(recorder.toFile(undefined, 'x'.repeat(5000)).note).toHaveLength(1000);
      expect(recorder.toFile(0).config).toBe(0);
      expect(recorder.toFile(null).config).toBeNull();
    });

    it('returns an independent snapshot: neither side can change the other', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 2);
      const config = { launch: { minDownSpeed: 1.2 } };
      const first = recorder.toFile(config);

      recordFrames(recorder, 3, 1000 / 30, 50_000);
      config.launch.minDownSpeed = 99;
      expect(first.frames).toHaveLength(2);
      expect(first.config).toEqual({ launch: { minDownSpeed: 1.2 } });

      first.frames[0].hands[0].lm[0][0] = 42;
      first.frames.length = 0;
      const second = recorder.toFile();
      expect(second.frames).toHaveLength(5);
      expect(second.frames[0].hands[0].lm[0][0]).not.toBe(42);
    });

    it('works while still recording', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      recordFrames(recorder, 4);
      expect(recorder.recording).toBe(true);
      expect(recorder.toFile().frames).toHaveLength(4);
      recordFrames(recorder, 2, 33, 60_000);
      expect(recorder.toFile().frames).toHaveLength(6);
    });
  });

  describe('round trip', () => {
    it('toFile → serializeReplay → parseReplay → replayFrames preserves frames and arrival order', () => {
      const recorder = new ReplayRecorder();
      recorder.start();
      const origin = 250_000.789;
      // Results do not always come back in capture order: frame 1 is slow, frame 2 overtakes it.
      const captures = [0, 33.33, 66.67, 100, 133.33];
      const latencies = [50, 140, 45, 52, 47];
      const sources = captures.map((c, i) => frameAt(origin + c, i === 3 ? [] : [hand(i % 2 ? 'Left' : 'Right', i * 0.05)]));
      sources.forEach((frame, i) => recorder.add(frame, origin + captures[i] + latencies[i]));
      recorder.markDetected('launch', origin + 100);

      const text = serializeReplay(recorder.toFile({ sim: { hz: 240 } }, 'prueba'));
      const file: ReplayFile = parseReplay(text);
      expect(file.note).toBe('prueba');
      expect(file.config).toEqual({ sim: { hz: 240 } });
      expect(file.detected).toEqual([{ kind: 'launch', t: 100 }]);

      const delivered = replayFrames(file);
      expect(delivered).toHaveLength(5);
      const expectedOrder = captures
        .map((c, i) => ({ i, arrival: c + latencies[i] }))
        .sort((p, q) => p.arrival - q.arrival)
        .map(entry => entry.i);
      // The slow frame 1 (arrives at 173 ms) is overtaken by frames 2 and 3, so this is a real reordering.
      expect(expectedOrder).toEqual([0, 2, 3, 1, 4]);
      expect(delivered.map(d => d.frame.timestampMs)).toEqual(expectedOrder.map(i => Math.round(captures[i] * 1e3) / 1e3));
      expect(delivered.map(d => d.arrivalMs)).toEqual(expectedOrder.map(i => Math.round((captures[i] + latencies[i]) * 1e3) / 1e3));

      for (const { frame } of delivered) {
        expect(frame.source).toBe('replay');
        const index = captures.findIndex(c => Math.abs(c - frame.timestampMs) < 0.01);
        const original = sources[index];
        expect(frame.hands).toHaveLength(original.hands.length);
        frame.hands.forEach((delivery, h) => {
          expect(delivery.handedness).toBe(original.hands[h].handedness);
          delivery.landmarks.forEach((p, k) => {
            const o = original.hands[h].landmarks[k];
            expect(Math.abs(p.x - o.x)).toBeLessThanOrEqual(5e-6 + 1e-12);
            expect(Math.abs(p.y - o.y)).toBeLessThanOrEqual(5e-6 + 1e-12);
            expect(Math.abs(p.z - o.z)).toBeLessThanOrEqual(5e-6 + 1e-12);
          });
        });
      }
    });

    it('survives a full two-minute recording and stays small enough to be a download', () => {
      const random = new Random(11);
      const recorder = new ReplayRecorder();
      recorder.start();
      // Full-precision values, like a tracker produces: the worst case for file size.
      for (let i = 0; i < 4000; i += 1) {
        const capture = 40_000 + (i * 1000) / 30;
        const landmarks = Array.from({ length: 21 }, () => ({ x: random.next(), y: random.next(), z: random.range(-0.2, 0.2) }));
        recorder.add(frameAt(capture, [{ handedness: 'Right', landmarks }]), capture + 50);
      }
      expect(recorder.full).toBe(true);
      const text = serializeReplay(recorder.toFile());
      expect(parseReplay(text).frames).toHaveLength(3601);
      // Measured: ~2.2 MB for the cap with one hand (~4.2 MB with two).
      expect(text.length).toBeLessThan(3_000_000);
    });
  });

  describe('privacy by construction', () => {
    it('does not use network, storage or ambient clock and randomness APIs', () => {
      const source = readFileSync(new URL('./ReplayRecorder.ts', import.meta.url), 'utf8');
      expect(source).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(source).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random/);
    });
  });
});

/** The smallest stand-ins for the browser pieces downloadReplay touches, recording the order of calls. */
function fakeBrowser() {
  const calls: string[] = [];
  const anchor = { href: '', download: '', click: vi.fn(() => { calls.push('click'); }) };
  const doc = {
    createElement: vi.fn((tag: string) => { calls.push(`create:${tag}`); return anchor; }),
    body: {
      appendChild: vi.fn(() => { calls.push('append'); }),
      removeChild: vi.fn(() => { calls.push('remove'); }),
    },
  };
  const blobs: Blob[] = [];
  const urls = {
    createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); calls.push('createObjectURL'); return 'blob:yoyo-test-1'; }),
    revokeObjectURL: vi.fn((url: string) => { calls.push(`revoke:${url}`); }),
  };
  return { calls, anchor, doc: doc as unknown as Document, rawDoc: doc, urls, blobs };
}

describe('downloadReplay', () => {
  const file = (): ReplayFile => ({ schema: 'yoyo-replay/1', note: 'prueba', frames: [{ t: 0, a: 40, hands: [] }], detected: [] });

  it('creates one anchor with the blob URL and the file name, clicks it, then revokes the URL', () => {
    vi.useFakeTimers();
    const env = fakeBrowser();
    downloadReplay(file(), 'yoyo-replay.json', env.doc, env.urls);

    expect(env.rawDoc.createElement).toHaveBeenCalledTimes(1);
    expect(env.rawDoc.createElement).toHaveBeenCalledWith('a');
    expect(env.anchor.href).toBe('blob:yoyo-test-1');
    expect(env.anchor.download).toBe('yoyo-replay.json');
    expect(env.anchor.click).toHaveBeenCalledTimes(1);
    expect(env.urls.createObjectURL).toHaveBeenCalledTimes(1);

    // The link is attached while it is clicked and removed right after.
    expect(env.calls).toEqual(['createObjectURL', 'create:a', 'append', 'click', 'remove']);

    // The URL is revoked a moment later, once the browser has started the download, and only once.
    expect(env.urls.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(env.urls.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(env.urls.revokeObjectURL).toHaveBeenCalledWith('blob:yoyo-test-1');
    expect(env.calls[env.calls.length - 1]).toBe('revoke:blob:yoyo-test-1');
  });

  it('downloads the serialized replay as a JSON blob', async () => {
    vi.useFakeTimers();
    const env = fakeBrowser();
    const replay = file();
    downloadReplay(replay, 'a.json', env.doc, env.urls);
    expect(env.blobs).toHaveLength(1);
    expect(env.blobs[0].type).toBe('application/json');
    expect(await env.blobs[0].text()).toBe(serializeReplay(replay));
    vi.runAllTimers();
  });

  it('sends nothing anywhere', () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const beaconSpy = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });
    const env = fakeBrowser();
    downloadReplay(file(), 'a.json', env.doc, env.urls);
    vi.runAllTimers();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('records a replay and downloads exactly what toFile built', async () => {
    vi.useFakeTimers();
    const recorder = new ReplayRecorder();
    recorder.start();
    recordFrames(recorder, 3);
    const env = fakeBrowser();
    const replay = recorder.toFile({ hz: 240 }, 'nota');
    downloadReplay(replay, 'yoyo-replay-sesion.json', env.doc, env.urls);
    const downloaded = parseReplay(await env.blobs[0].text());
    expect(downloaded).toEqual(replay);
    expect(env.anchor.download).toBe('yoyo-replay-sesion.json');
    vi.runAllTimers();
  });
});
