import { describe, expect, it } from 'vitest';
import { ReleaseDelay } from './releaseDelay';

describe('ReleaseDelay', () => {
  it('starts empty', () => {
    const d = new ReleaseDelay<boolean>(300);
    expect(d.current).toBeNull();
    expect(d.update(null, 0)).toBeNull();
  });

  it('shows a value at once', () => {
    const d = new ReleaseDelay<boolean>(300);
    expect(d.update(true, 1000)).toBe(true);
    expect(d.current).toBe(true);
  });

  it('keeps it through a gap shorter than the hold and drops it at the hold', () => {
    const d = new ReleaseDelay<string>(300);
    d.update('bottom', 1000);
    expect(d.update(null, 1100)).toBe('bottom');
    expect(d.update(null, 1299)).toBe('bottom');
    expect(d.update(null, 1300)).toBeNull();
    expect(d.update(null, 5000)).toBeNull();
  });

  it('a flicker shorter than the hold never reaches the UI', () => {
    const d = new ReleaseDelay<boolean>(300);
    d.update(true, 0);
    const seen: Array<boolean | null> = [];
    for (let t = 16; t < 2000; t += 16) {
      // Absent for 3 frames out of every 20.
      const absent = Math.floor(t / 16) % 20 < 3;
      seen.push(d.update(absent ? null : true, t));
    }
    expect(seen.every(v => v === true)).toBe(true);
  });

  it('restarts the hold every time the value is seen again', () => {
    const d = new ReleaseDelay<boolean>(300);
    d.update(true, 0);
    d.update(null, 200);
    d.update(true, 250);
    expect(d.update(null, 500)).toBe(true);
    expect(d.update(null, 550)).toBeNull();
  });

  it('switches between two values immediately', () => {
    const d = new ReleaseDelay<string>(300);
    d.update('left', 0);
    expect(d.update('bottom', 10)).toBe('bottom');
  });

  it('has no hold when asked for none', () => {
    const d = new ReleaseDelay<boolean>(0);
    d.update(true, 5);
    expect(d.update(null, 5)).toBeNull();
  });

  it('forgets on reset', () => {
    const d = new ReleaseDelay<boolean>(300);
    d.update(true, 0);
    d.reset();
    expect(d.current).toBeNull();
    expect(d.update(null, 10)).toBeNull();
  });

  it('rejects a negative or non-finite hold', () => {
    expect(() => new ReleaseDelay(-1)).toThrow(RangeError);
    expect(() => new ReleaseDelay(Number.NaN)).toThrow(RangeError);
  });
});
