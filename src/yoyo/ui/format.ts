import type { ConfigField } from '../config';

/** Decimals a step needs to be written exactly: 0.05 → 2, 0.5 → 1, 10 → 0, 0.005 → 3. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  let decimals = 0;
  let scaled = step;
  // Six decimals is far finer than any step of the panel; the cap only keeps a pathological step from looping.
  while (decimals < 6 && Math.abs(Math.round(scaled) - scaled) > 1e-9) {
    scaled *= 10;
    decimals++;
  }
  return decimals;
}

/** A value as the panel shows it: as many decimals as the field's step has. */
export function formatField(value: number, field: Pick<ConfigField, 'step'>): string {
  return Number.isFinite(value) ? value.toFixed(decimalsOf(field.step)) : '';
}

/**
 * The value a field accepts for whatever was typed or dragged: clamped to [min, max] and snapped to the
 * step grid (so «frames» stay whole numbers). null when it is not a number at all, so the caller keeps
 * the value it had instead of writing NaN into the config.
 */
export function snapToField(value: number, field: Pick<ConfigField, 'min' | 'max' | 'step'>): number | null {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.min(field.max, Math.max(field.min, value));
  const decimals = decimalsOf(field.step);
  // Rounded to the step's decimals before it is compared with max: a grid point that IS max can come out a hair above it in
  // floating point (0.01 + 28 × 0.005 is 0.15000000000000002), and would be taken for an overshoot and dropped a step (0.145).
  const snapped = Number((field.min + Math.round((clamped - field.min) / field.step) * field.step).toFixed(decimals));
  // The grid can overshoot max by less than a step when (max − min) is not a multiple of it.
  return snapped > field.max ? Number((snapped - field.step).toFixed(decimals)) : snapped;
}
