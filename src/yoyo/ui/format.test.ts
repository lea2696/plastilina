import { describe, expect, it } from 'vitest';
import { CONFIG_FIELDS, createConfig, getConfigValue } from '../config';
import { decimalsOf, formatField, snapToField } from './format';

describe('decimalsOf', () => {
  it.each([[1, 0], [10, 0], [0.5, 1], [0.1, 1], [0.05, 2], [0.01, 2], [0.005, 3], [0.25, 2]])('step %s needs %s decimals', (step, expected) => {
    expect(decimalsOf(step)).toBe(expected);
  });

  it('is 0 for a step that is not a positive number', () => {
    expect(decimalsOf(0)).toBe(0);
    expect(decimalsOf(-1)).toBe(0);
    expect(decimalsOf(Number.NaN)).toBe(0);
  });
});

describe('formatField', () => {
  it('writes as many decimals as the step has', () => {
    expect(formatField(1.2, { step: 0.05 })).toBe('1.20');
    expect(formatField(0.04, { step: 0.005 })).toBe('0.040');
    expect(formatField(250, { step: 10 })).toBe('250');
    expect(formatField(0.4, { step: 0.1 })).toBe('0.4');
  });

  it('writes nothing for a value that is not a number', () => {
    expect(formatField(Number.NaN, { step: 1 })).toBe('');
  });

  it('can show every default of the config without losing precision', () => {
    const config = createConfig('standing');
    for (const field of CONFIG_FIELDS) {
      const value = getConfigValue(config, field.key);
      expect(Number(formatField(value, field))).toBeCloseTo(value, 9);
    }
  });
});

describe('snapToField', () => {
  const field = { min: 0.4, max: 3, step: 0.05 };

  it('keeps a value that is already on the grid', () => {
    expect(snapToField(1.2, field)).toBe(1.2);
    expect(snapToField(0.4, field)).toBe(0.4);
    expect(snapToField(3, field)).toBe(3);
  });

  it('clamps to the range', () => {
    expect(snapToField(-5, field)).toBe(0.4);
    expect(snapToField(99, field)).toBe(3);
  });

  it('snaps to the nearest step, without floating-point tails', () => {
    expect(snapToField(1.234, field)).toBe(1.25);
    expect(snapToField(0.71, field)).toBe(0.7);
    expect(String(snapToField(0.1 + 0.2 + 0.4, field))).toBe('0.7');
  });

  it('keeps whole-number fields whole', () => {
    const frames = { min: 1, max: 4, step: 1 };
    expect(snapToField(2.4, frames)).toBe(2);
    expect(snapToField(2.6, frames)).toBe(3);
    expect(snapToField(0, frames)).toBe(1);
  });

  it('never lands above max when the range is not a multiple of the step', () => {
    expect(snapToField(1, { min: 0, max: 0.95, step: 0.1 })).toBe(0.9);
  });

  it('answers null for what is not a number, so the config never gets NaN', () => {
    expect(snapToField(Number.NaN, field)).toBeNull();
    expect(snapToField(Infinity, field)).toBeNull();
  });

  it('reaches the exact minimum and the exact maximum of every tunable (a grid point that is max must not read as an overshoot)', () => {
    for (const field of CONFIG_FIELDS) {
      expect(snapToField(field.min, field), `${field.key} min`).toBe(field.min);
      expect(snapToField(field.max, field), `${field.key} max`).toBe(field.max);
    }
    // The two that used to fall one step short: 0.01 + 28 × 0.005 and 0.02 + 28 × 0.01 are a hair above their maximum in floating point.
    expect(snapToField(0.15, { min: 0.01, max: 0.15, step: 0.005 })).toBe(0.15);
    expect(snapToField(0.3, { min: 0.02, max: 0.3, step: 0.01 })).toBe(0.3);
  });

  it('accepts every default of the config unchanged (the panel never edits a value by showing it)', () => {
    const config = createConfig('standing');
    for (const field of CONFIG_FIELDS) {
      const value = getConfigValue(config, field.key);
      expect(snapToField(value, field), field.key).toBeCloseTo(value, 9);
    }
  });
});
