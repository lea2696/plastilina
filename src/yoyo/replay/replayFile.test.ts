import { describe, expect, it } from 'vitest';
import type { ReplayFile } from '../contracts';
import { parseReplay, replayFrames, serializeReplay } from './replayFile';

type Landmark3 = [number, number, number];

const landmarks = (shift = 0): Landmark3[] =>
  // z is never 0: JSON writes -0 as 0 and toEqual tells them apart, which is noise for these tests.
  Array.from({ length: 21 }, (_, i): Landmark3 => [0.1 + i * 0.01 + shift, 0.2 + i * 0.02, -0.001 - 0.003 * i]);

const frame = (t: number, a = t + 50, hands = 1): ReplayFile['frames'][number] => ({
  t,
  a,
  hands: Array.from({ length: hands }, (_, i) => ({ h: i === 0 ? ('Right' as const) : ('Left' as const), lm: landmarks(i * 0.3) })),
});

const validFile = (): ReplayFile => ({
  schema: 'yoyo-replay/1',
  note: 'sentado, luz de ventana',
  config: { launch: { minDownSpeed: 1.2 } },
  frames: [frame(0), frame(33), frame(66)],
  detected: [{ kind: 'launch', t: 40 }],
  labels: [{ kind: 'tug', onsetMs: 20 }],
});

/** Text of a valid file after `edit` changed a deep copy of it; edits assign bad values on purpose. */
function textWith(edit: (file: ReplayFile) => void): string {
  const copy = JSON.parse(serializeReplay(validFile())) as ReplayFile;
  edit(copy);
  return JSON.stringify(copy);
}

describe('serializeReplay', () => {
  it('writes compact JSON that parseReplay reads back unchanged', () => {
    const file = validFile();
    const text = serializeReplay(file);
    expect(text).not.toMatch(/\n/);
    expect(text).toBe(JSON.stringify(file));
    expect(parseReplay(text)).toEqual(file);
  });
});

describe('parseReplay', () => {
  describe('accepts', () => {
    it('a valid file, keeping every field', () => {
      const file = validFile();
      expect(parseReplay(serializeReplay(file))).toEqual(file);
    });

    it('a minimal file: schema and frames only', () => {
      const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0)] };
      expect(parseReplay(serializeReplay(file))).toEqual(file);
    });

    it('frames with no hand (the hand left the picture) and frames with two hands', () => {
      const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0, 30, 0), frame(33, 70, 2), frame(66, 100, 1)] };
      expect(parseReplay(serializeReplay(file)).frames.map(f => f.hands.length)).toEqual([0, 2, 1]);
    });

    it('every handedness label the tracker can produce', () => {
      const file: ReplayFile = {
        schema: 'yoyo-replay/1',
        frames: [{ t: 0, a: 10, hands: [{ h: 'Left', lm: landmarks() }, { h: 'Right', lm: landmarks() }, { h: 'Unknown', lm: landmarks() }] }],
      };
      expect(() => parseReplay(serializeReplay(file))).not.toThrow();
    });

    it('arrival equal to capture, and arrival order that differs from capture order', () => {
      const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0, 0), frame(33, 200), frame(66, 90)] };
      expect(() => parseReplay(serializeReplay(file))).not.toThrow();
    });
  });

  describe('rejects', () => {
    it('text that is not JSON', () => {
      expect(() => parseReplay('not json')).toThrow();
      expect(() => parseReplay('')).toThrow();
    });

    it('a wrong or missing schema', () => {
      expect(() => parseReplay(textWith(f => Object.assign(f, { schema: 'yoyo-replay/2' })))).toThrow(/schema/i);
      expect(() => parseReplay(textWith(f => Object.assign(f, { schema: undefined })))).toThrow(/schema/i);
      expect(() => parseReplay(JSON.stringify({ frames: [] }))).toThrow(/schema/i);
    });

    it('a file whose frames are not a list', () => {
      expect(() => parseReplay(textWith(f => Object.assign(f, { frames: 'nope' })))).toThrow(/frames/i);
      expect(() => parseReplay(textWith(f => Object.assign(f, { frames: undefined })))).toThrow(/frames/i);
      expect(() => parseReplay(textWith(f => Object.assign(f, { frames: { 0: frame(0) } })))).toThrow(/frames/i);
    });

    it('timestamps that do not strictly increase', () => {
      expect(() => parseReplay(textWith(f => { f.frames[1].t = f.frames[0].t; }))).toThrow(/increase/i);
      expect(() => parseReplay(textWith(f => { f.frames[2].t = 10; }))).toThrow(/increase/i);
    });

    it('a frame that arrives before it was captured', () => {
      expect(() => parseReplay(textWith(f => { f.frames[1].a = f.frames[1].t - 1; }))).toThrow(/timestamps/i);
    });

    it('a hand without exactly 21 landmarks', () => {
      expect(() => parseReplay(textWith(f => { f.frames[1].hands[0].lm.pop(); }))).toThrow(/21 landmarks/);
      expect(() => parseReplay(textWith(f => { f.frames[1].hands[0].lm.push([0, 0, 0]); }))).toThrow(/21 landmarks/);
      expect(() => parseReplay(textWith(f => { f.frames[1].hands[0].lm = []; }))).toThrow(/21 landmarks/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1].hands[0], { lm: undefined })))).toThrow(/21 landmarks/);
    });

    it('a landmark that is not an [x, y, z] triple', () => {
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[0].hands[0].lm, { 4: [0.1, 0.2] })))).toThrow(/landmark/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[0].hands[0].lm, { 4: [0.1, 0.2, 0.3, 0.4] })))).toThrow(/landmark/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[0].hands[0].lm, { 4: { x: 1, y: 2, z: 3 } })))).toThrow(/landmark/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[0].hands[0].lm, { 4: null })))).toThrow(/landmark/);
    });

    it('non-finite landmark values, however they sneak into the text', () => {
      // JSON.stringify turns NaN and ±Infinity into null...
      expect(() => parseReplay(textWith(f => { f.frames[1].hands[0].lm[7][1] = Number.NaN; }))).toThrow(/non-finite/);
      expect(() => parseReplay(textWith(f => { f.frames[1].hands[0].lm[7][0] = Number.POSITIVE_INFINITY; }))).toThrow(/non-finite/);
      // ...while a literal like 1e999 parses to Infinity by itself, and a string is not a number.
      const base = serializeReplay(validFile());
      expect(() => parseReplay(base.replace('"lm":[[0.1,', '"lm":[[1e999,'))).toThrow(/non-finite/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[0].hands[0].lm[3], { 2: '0.5' })))).toThrow(/non-finite/);
    });

    it('non-finite or missing timestamps', () => {
      expect(() => parseReplay(textWith(f => { f.frames[1].t = Number.NaN; }))).toThrow(/timestamps/);
      expect(() => parseReplay(textWith(f => { f.frames[1].a = Number.POSITIVE_INFINITY; }))).toThrow(/timestamps/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1], { t: '33' })))).toThrow(/timestamps/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1], { a: undefined })))).toThrow(/timestamps/);
      expect(() => parseReplay(base1e999('"t":33', '"t":1e999'))).toThrow(/timestamps/);
    });

    it('a frame without its hands list, or with an unknown handedness', () => {
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1], { hands: undefined })))).toThrow(/hands/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1], { hands: 'both' })))).toThrow(/hands/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1].hands[0], { h: 'Both' })))).toThrow(/handedness/);
      expect(() => parseReplay(textWith(f => Object.assign(f.frames[1].hands[0], { h: undefined })))).toThrow(/handedness/);
    });

    it('unknown intent kinds in detections and in labels', () => {
      expect(() => parseReplay(textWith(f => Object.assign(f.detected![0], { kind: 'wave' })))).toThrow(/Unknown intent kind: wave/);
      expect(() => parseReplay(textWith(f => Object.assign(f.labels![0], { kind: 'catch' })))).toThrow(/Unknown intent kind: catch/);
      expect(() => parseReplay(textWith(f => Object.assign(f.labels![0], { kind: undefined })))).toThrow(/Unknown intent kind/);
    });

    it('detections and labels without a finite time, which would silently corrupt precision and recall', () => {
      expect(() => parseReplay(textWith(f => Object.assign(f.detected![0], { t: 'soon' })))).toThrow(/detected/);
      expect(() => parseReplay(textWith(f => Object.assign(f.detected![0], { t: undefined })))).toThrow(/detected/);
      expect(() => parseReplay(textWith(f => Object.assign(f.labels![0], { onsetMs: Number.NaN })))).toThrow(/labels/);
      expect(() => parseReplay(textWith(f => Object.assign(f.labels![0], { onsetMs: undefined })))).toThrow(/labels/);
    });

    it('malformed shapes with a reason instead of a TypeError from deep inside', () => {
      for (const text of ['null', '42', '"replay"', 'true']) expect(reasonOf(text)).toMatch(/not an object/);
      expect(reasonOf('[]')).toMatch(/schema/);
      expect(reasonOf(textWith(f => Object.assign(f, { frames: [null] })))).toMatch(/Frame 0/);
      expect(reasonOf(textWith(f => Object.assign(f, { frames: [42] })))).toMatch(/Frame 0/);
      expect(reasonOf(textWith(f => Object.assign(f.frames[1], { hands: [null] })))).toMatch(/Frame 1/);
      expect(reasonOf(textWith(f => Object.assign(f.frames[1], { hands: [7] })))).toMatch(/Frame 1/);
      expect(reasonOf(textWith(f => Object.assign(f, { detected: 'launch' })))).toMatch(/detected/);
      expect(reasonOf(textWith(f => Object.assign(f, { detected: { kind: 'launch' } })))).toMatch(/detected/);
      expect(reasonOf(textWith(f => Object.assign(f, { detected: [null] })))).toMatch(/detected/);
      expect(reasonOf(textWith(f => Object.assign(f, { labels: [5] })))).toMatch(/labels/);
    });

    it('reports which frame is bad', () => {
      expect(() => parseReplay(textWith(f => { f.frames[2].hands[0].lm.pop(); }))).toThrow(/Frame 2/);
      expect(() => parseReplay(textWith(f => { f.frames[1].a = -1; }))).toThrow(/Frame 1/);
    });
  });
});

/** The message parseReplay fails with, asserting it is a deliberate Error and never an accidental TypeError. */
function reasonOf(text: string): string {
  try {
    parseReplay(text);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    return (error as Error).message;
  }
  return 'did not throw';
}

/** A valid file's text with one literal swapped, for values JSON.stringify cannot produce (1e999). */
function base1e999(from: string, to: string): string {
  const text = serializeReplay(validFile());
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe('replayFrames', () => {
  it('turns replay frames into the HandFrames the camera path delivers, marked as replay', () => {
    const file = validFile();
    const [first] = replayFrames(file);
    expect(first.arrivalMs).toBe(50);
    expect(first.frame.timestampMs).toBe(0);
    expect(first.frame.source).toBe('replay');
    expect(first.frame.hands).toHaveLength(1);
    expect(first.frame.hands[0].handedness).toBe('Right');
    expect(first.frame.hands[0].landmarks).toHaveLength(21);
    expect(first.frame.hands[0].landmarks[3]).toEqual({ x: file.frames[0].hands[0].lm[3][0], y: file.frames[0].hands[0].lm[3][1], z: file.frames[0].hands[0].lm[3][2] });
  });

  it('delivers frames sorted by arrival time, not capture time', () => {
    const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0, 80), frame(33, 60), frame(66, 70), frame(99, 200)] };
    const delivered = replayFrames(file);
    expect(delivered.map(d => d.arrivalMs)).toEqual([60, 70, 80, 200]);
    expect(delivered.map(d => d.frame.timestampMs)).toEqual([33, 66, 0, 99]);
  });

  it('keeps capture order among frames that arrive together (stable)', () => {
    const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0, 100), frame(33, 100), frame(66, 100), frame(99, 90)] };
    expect(replayFrames(file).map(d => d.frame.timestampMs)).toEqual([99, 0, 33, 66]);
  });

  it('carries frames with no hands and frames with several hands through unchanged', () => {
    const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0, 30, 0), frame(33, 70, 2)] };
    const delivered = replayFrames(file);
    expect(delivered[0].frame.hands).toEqual([]);
    expect(delivered[1].frame.hands.map(h => h.handedness)).toEqual(['Right', 'Left']);
  });

  it('does not mutate or reorder the file it reads', () => {
    const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0, 80), frame(33, 60)] };
    const before = serializeReplay(file);
    replayFrames(file);
    expect(serializeReplay(file)).toBe(before);
  });

  it('gives each delivery its own landmark objects, so a runtime cannot corrupt the fixture', () => {
    const file: ReplayFile = { schema: 'yoyo-replay/1', frames: [frame(0)] };
    const [delivery] = replayFrames(file);
    (delivery.frame.hands[0].landmarks[0] as { x: number }).x = 99;
    expect(file.frames[0].hands[0].lm[0][0]).not.toBe(99);
    expect(replayFrames(file)[0].frame.hands[0].landmarks[0].x).not.toBe(99);
  });

  it('yields nothing for a file with no frames', () => {
    expect(replayFrames({ schema: 'yoyo-replay/1', frames: [] })).toEqual([]);
  });
});
