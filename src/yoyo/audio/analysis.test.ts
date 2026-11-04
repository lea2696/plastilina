import { describe, expect, it } from 'vitest';
import {
  aWeight, aWeightedRms, dominantFrequency, encodeWav, fftInPlace, magnitudeSpectrum, peakOf, rmsEnvelope, rmsOf, spectralCentroid, toDb, toPcm16,
} from './analysis';
import { Xorshift32 } from './math';

const RATE = 44100;

function tone(hz: number, amplitude: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function noise(seconds: number, seed = 1): Float32Array {
  const random = new Xorshift32(seed);
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = random.next() * 2 - 1;
  return out;
}

describe('levels', () => {
  it('measures peak and rms of a sine', () => {
    const x = tone(220, 0.5, 1);
    expect(peakOf(x)).toBeCloseTo(0.5, 3);
    expect(rmsOf(x)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(rmsOf(x, 100, 100)).toBe(0);
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(peakOf(new Float32Array(0))).toBe(0);
  });

  it('bins an rms envelope', () => {
    const x = new Float32Array(1000);
    x.fill(0.2, 500);
    const bins = rmsEnvelope(x, 250);
    expect(bins).toHaveLength(4);
    expect(bins[0]).toBe(0);
    expect(bins[3]).toBeCloseTo(0.2, 6);
  });

  it('converts to dB', () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(toDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('fft', () => {
  it('rejects lengths that are not a power of two', () => {
    expect(() => fftInPlace(new Float64Array(12), new Float64Array(12))).toThrow(RangeError);
  });

  it('puts a single-bin cosine in that bin only', () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * 64 * i) / n);
    fftInPlace(re, im);
    expect(Math.hypot(re[64], im[64])).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[100], im[100])).toBeLessThan(1e-9);
  });
});

describe('dominantFrequency', () => {
  it.each([55, 121, 165.4, 209, 220, 319, 1000])('finds a %s Hz sine within 0.2 Hz', (hz) => {
    expect(dominantFrequency(tone(hz, 0.4, 1.2), RATE, 30, 2000)).toBeCloseTo(hz, 0);
    expect(Math.abs(dominantFrequency(tone(hz, 0.4, 1.2), RATE, 30, 2000) - hz)).toBeLessThan(0.2);
  });

  it('picks the strongest of several lines and respects the search band', () => {
    const a = tone(150, 0.5, 1.2);
    const b = tone(300, 0.2, 1.2);
    const mix = a.map((v, i) => v + b[i]);
    expect(dominantFrequency(mix, RATE, 30, 2000)).toBeCloseTo(150, 0);
    expect(dominantFrequency(mix, RATE, 250, 2000)).toBeCloseTo(300, 0);
  });

  it('still finds a tone under noise', () => {
    const t = tone(180, 0.3, 1.2);
    const n = noise(1.2);
    const mix = t.map((v, i) => v + 0.2 * n[i]);
    expect(Math.abs(dominantFrequency(mix, RATE, 30, 2000) - 180)).toBeLessThan(0.5);
  });

  it('is monotonic: a higher tone never reads lower', () => {
    let previous = 0;
    for (let hz = 100; hz <= 400; hz += 25) {
      const measured = dominantFrequency(tone(hz, 0.4, 1.2), RATE, 30, 2000);
      expect(measured).toBeGreaterThan(previous);
      previous = measured;
    }
  });
});

describe('spectralCentroid', () => {
  it('reads a sine at its own frequency', () => {
    expect(Math.abs(spectralCentroid(tone(500, 0.4, 1.2), RATE, 20, 8000) - 500)).toBeLessThan(5);
  });

  it('is higher for a brighter sound and mid-band for white noise', () => {
    const dull = tone(200, 0.4, 1.2);
    const bright = tone(2000, 0.4, 1.2);
    expect(spectralCentroid(bright, RATE, 20, 8000)).toBeGreaterThan(spectralCentroid(dull, RATE, 20, 8000));
    const white = spectralCentroid(noise(1.2), RATE, 0, 20000);
    expect(white).toBeGreaterThan(8000);
    expect(white).toBeLessThan(12000);
    expect(spectralCentroid(new Float32Array(32768), RATE, 20, 8000)).toBe(0);
  });
});

describe('magnitudeSpectrum', () => {
  it('uses the end of the signal and zero-pads short input', () => {
    const long = new Float32Array(100000);
    long.set(tone(300, 0.5, 0.5), 0);
    // Silence at the end: nothing to see, however loud the start was.
    expect(Math.max(...magnitudeSpectrum(long, 4096))).toBeLessThan(1e-6);
    expect(magnitudeSpectrum(tone(300, 0.5, 0.01), 4096)).toHaveLength(2049);
  });
});

describe('A-weighting', () => {
  it('matches the standard curve at the reference points', () => {
    expect(toDb(aWeight(1000))).toBeCloseTo(0, 1);
    expect(toDb(aWeight(100))).toBeCloseTo(-19.1, 1);
    expect(toDb(aWeight(200))).toBeCloseTo(-10.85, 1);
    expect(toDb(aWeight(2000))).toBeCloseTo(1.2, 1);
    expect(toDb(aWeight(4000))).toBeCloseTo(1.0, 1);
    expect(toDb(aWeight(10000))).toBeCloseTo(-2.5, 1);
    expect(aWeight(0)).toBe(0);
  });

  it('leaves a 1 kHz tone at its rms and quiets a low tone of equal rms', () => {
    const mid = tone(1000, 0.5, 1);
    const low = tone(100, 0.5, 1);
    expect(aWeightedRms(mid, RATE)).toBeCloseTo(rmsOf(mid), 2);
    expect(toDb(aWeightedRms(low, RATE)) - toDb(rmsOf(low))).toBeCloseTo(-19.1, 0);
  });

  it('is not diluted by silence after the sound when the active length is given', () => {
    const click = new Float32Array(RATE);
    click.set(tone(1000, 0.5, 0.05), 0);
    const diluted = aWeightedRms(click, RATE);
    const active = aWeightedRms(click, RATE, Math.round(0.05 * RATE));
    expect(active).toBeGreaterThan(diluted * 4);
    expect(active).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});

describe('wav output', () => {
  it('clips and quantises to 16-bit', () => {
    const pcm = toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it('writes a canonical 44-byte header and the samples', () => {
    const samples = tone(440, 0.5, 0.01);
    const wav = encodeWav(samples, RATE);
    const view = new DataView(wav.buffer);
    const ascii = (o: number) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(ascii(12)).toBe('fmt ');
    expect(ascii(36)).toBe('data');
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44 + 2 * 25, true)).toBe(toPcm16(samples)[25]);
  });
});
