/**
 * Measurements over rendered audio for the offline QA (scripts/yoyo-audio-qa.ts). Plain numeric
 * code with no DOM dependency, so it runs in the page that renders and in Node's unit tests, where
 * it is checked against signals whose answer is known.
 */

export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/** Root mean square of samples[from, to). 0 for an empty range. */
export function rmsOf(samples: Float32Array, from = 0, to: number = samples.length): number {
  const end = Math.min(to, samples.length);
  const start = Math.max(0, from);
  if (end <= start) return 0;
  let energy = 0;
  for (let i = start; i < end; i += 1) energy += samples[i] * samples[i];
  return Math.sqrt(energy / (end - start));
}

/** RMS of consecutive bins of `binSamples` samples: the coarse loudness envelope of a render. */
export function rmsEnvelope(samples: Float32Array, binSamples: number): number[] {
  const bins: number[] = [];
  for (let start = 0; start < samples.length; start += binSamples) bins.push(rmsOf(samples, start, start + binSamples));
  return bins;
}

export const toDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY);

/** In-place radix-2 FFT. The length must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) throw new RangeError('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stepRe = Math.cos((-2 * Math.PI) / size);
    const stepIm = Math.sin((-2 * Math.PI) / size);
    for (let start = 0; start < n; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
}

/**
 * Magnitude spectrum, bins 0..size/2, of the LAST `size` samples (the end of a render is the steady
 * part; the start still has the fade-in). Shorter input is zero-padded. A Hann window keeps a steady
 * tone's line sharp; pass `windowed = false` for a short transient (a click), whose energy sits at
 * the very start, exactly where a Hann window is zero.
 */
export function magnitudeSpectrum(samples: Float32Array, size: number, windowed = true): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const take = Math.min(size, samples.length);
  const offset = samples.length - take;
  for (let i = 0; i < take; i += 1) {
    const window = windowed ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (take - 1 || 1)) : 1;
    re[i] = samples[offset + i] * window;
  }
  fftInPlace(re, im);
  const half = size >> 1;
  const magnitudes = new Float64Array(half + 1);
  for (let k = 0; k <= half; k += 1) magnitudes[k] = Math.hypot(re[k], im[k]);
  return magnitudes;
}

/**
 * Frequency of the strongest spectral line in [minHz, maxHz], Hz, refined below the bin width by
 * parabolic interpolation on the log magnitudes (a Hann-windowed line is close to a parabola there).
 */
export function dominantFrequency(samples: Float32Array, sampleRate: number, minHz: number, maxHz: number, size = 32768): number {
  const spectrum = magnitudeSpectrum(samples, size);
  const hzPerBin = sampleRate / size;
  const first = Math.max(1, Math.ceil(minHz / hzPerBin));
  const last = Math.min(spectrum.length - 2, Math.floor(maxHz / hzPerBin));
  let best = first;
  for (let k = first; k <= last; k += 1) if (spectrum[k] > spectrum[best]) best = k;
  const a = Math.log(spectrum[best - 1] + 1e-300);
  const b = Math.log(spectrum[best] + 1e-300);
  const c = Math.log(spectrum[best + 1] + 1e-300);
  const denominator = a - 2 * b + c;
  const shift = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator;
  return (best + shift) * hzPerBin;
}

/** Power-weighted mean frequency in [minHz, maxHz], Hz: how bright the sound is. */
export function spectralCentroid(
  samples: Float32Array, sampleRate: number, minHz: number, maxHz: number, size = 32768, windowed = true,
): number {
  const spectrum = magnitudeSpectrum(samples, size, windowed);
  const hzPerBin = sampleRate / size;
  const first = Math.max(1, Math.ceil(minHz / hzPerBin));
  const last = Math.min(spectrum.length - 1, Math.floor(maxHz / hzPerBin));
  let weighted = 0;
  let total = 0;
  for (let k = first; k <= last; k += 1) {
    const power = spectrum[k] * spectrum[k];
    weighted += power * k * hzPerBin;
    total += power;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * A-weighting (IEC 61672) as a linear amplitude factor, 1 at 1 kHz: the ear's sensitivity at low
 * level, which is why a 2 kHz hiss is heard as much louder than a 200 Hz hum of equal rms.
 */
export function aWeight(hz: number): number {
  if (hz <= 0) return 0;
  const f2 = hz * hz;
  const num = 12194 ** 2 * f2 * f2;
  const den = (f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2);
  return (num / den) * 10 ** (2 / 20);
}

/**
 * A-weighted rms of `samples`, taken over `activeSamples` samples (the sound's own length, so a
 * click is not diluted by the silence after it), via Parseval on the whole-signal spectrum. This is
 * the number that balances voices against each other: peaks mislead for noise, rms ignores the ear.
 */
export function aWeightedRms(samples: Float32Array, sampleRate: number, activeSamples: number = samples.length): number {
  let size = 2;
  while (size < samples.length) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(samples);
  fftInPlace(re, im);
  const hzPerBin = sampleRate / size;
  const half = size >> 1;
  let energy = 0;
  for (let k = 1; k < half; k += 1) {
    const w = aWeight(k * hzPerBin);
    energy += 2 * (re[k] * re[k] + im[k] * im[k]) * w * w;
  }
  const nyquist = aWeight(half * hzPerBin);
  energy += (re[half] * re[half] + im[half] * im[half]) * nyquist * nyquist;
  return Math.sqrt(energy / size / Math.max(1, activeSamples));
}

/** Signed 16-bit little-endian PCM of mono float samples, clipped to [-1, 1]: the body of a WAV file. */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(x < 0 ? x * 32768 : x * 32767);
  }
  return out;
}

/** A complete mono 16-bit WAV file, for a human to listen to what the offline render produced. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = toPcm16(samples);
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}
