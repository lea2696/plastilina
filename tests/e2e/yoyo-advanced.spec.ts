import { test, expect, type Page } from '@playwright/test';
import { CONFIG_FIELDS, createConfig, getConfigValue, type ConfigField } from '../../src/yoyo/config';
import { formatField } from '../../src/yoyo/ui/format';
import { app, launchUntilRolling, openAdvanced, PRESS_AT, shot, visit, waitForPhase, watchProblems } from './yoyo-ui';

/**
 * «Ajustes → Avanzado» (PRD §4.4: every threshold lives in one config and has a panel). Evidence label: sintético.
 * The expected values come from the config module itself, so a tunable added there is tested here without touching this file.
 */

const slider = (page: Page, field: ConfigField) => page.getByRole('slider', { name: field.label, exact: true });
const numberBox = (page: Page, field: ConfigField) => page.getByRole('spinbutton', { name: `${field.label}, valor`, exact: true });

test('[sintético: ajustes] every tunable of «Avanzado» has a slider and a number that agree, stop at their limits, and «Restablecer» brings them all back', async ({ page }) => {
  test.setTimeout(90_000);
  const watch = watchProblems(page);
  await visit(page);
  await openAdvanced(page);
  const defaults = createConfig('standing');

  // The panel has one row per tunable of the config, each starting at the config's own default.
  await expect(page.getByRole('slider'), 'one slider per tunable, plus the volume slider of the settings column').toHaveCount(CONFIG_FIELDS.length + 1);
  for (const field of CONFIG_FIELDS) {
    const value = getConfigValue(defaults, field.key);
    await expect(numberBox(page, field), `${field.key} number box`).toHaveValue(formatField(value, field));
    expect(Number(await slider(page, field).inputValue()), `${field.key} slider`).toBeCloseTo(value, 6);
    expect(await slider(page, field).getAttribute('min')).toBe(String(field.min));
    expect(await slider(page, field).getAttribute('max')).toBe(String(field.max));
  }

  // Each slider goes to both ends with the keyboard (real input events) and its number follows: the limits are reachable, all of
  // them (the tug's 0.01…0.15 in 0.005s and 0.02…0.3 in 0.01s used to stop one step short: snapToField took the grid point
  // that IS the maximum for a floating-point overshoot). Typing the exact limit works too.
  for (const field of CONFIG_FIELDS) {
    await slider(page, field).focus();
    await page.keyboard.press('Home');
    await expect(numberBox(page, field), `${field.key} at its minimum`).toHaveValue(formatField(field.min, field));
    await page.keyboard.press('End');
    await expect(numberBox(page, field), `${field.key} at its maximum`).toHaveValue(formatField(field.max, field));
    await numberBox(page, field).fill(String(field.min));
    await numberBox(page, field).press('Enter');
    await expect(numberBox(page, field), `${field.key} typed at its minimum`).toHaveValue(formatField(field.min, field));
    await numberBox(page, field).fill(String(field.max));
    await numberBox(page, field).press('Enter');
    await expect(numberBox(page, field), `${field.key} typed at its maximum`).toHaveValue(formatField(field.max, field));
  }
  await shot(page, 'advanced-all-at-maximum');

  // The number box is the exact way in: it takes what is typed on Enter or when it is left, clamps to the limits, and keeps
  // the old value for what is not a number.
  const tau = CONFIG_FIELDS.find(field => field.key === 'yoyo.sleepTau')!;
  const box = numberBox(page, tau);
  await box.fill('6.5');
  await box.press('Enter');
  await expect(box).toHaveValue('6.5');
  expect(Number(await slider(page, tau).inputValue())).toBeCloseTo(6.5, 6);
  await box.fill('99');
  await box.blur();
  await expect(box).toHaveValue(formatField(tau.max, tau));
  await box.fill('0.2');
  await box.blur();
  await expect(box).toHaveValue(formatField(tau.min, tau));
  await box.fill('');
  await box.blur();
  await expect(box).toHaveValue(formatField(tau.min, tau));
  // A step of 1 keeps whole numbers: 2.6 frames is 3 frames.
  const frames = CONFIG_FIELDS.find(field => field.key === 'launch.sustainFrames')!;
  await numberBox(page, frames).fill('2.6');
  await numberBox(page, frames).press('Enter');
  await expect(numberBox(page, frames)).toHaveValue('3');

  // «Restablecer»: every tunable and both switches are the defaults again.
  await page.getByRole('switch', { name: 'Auto-retorno' }).uncheck();
  await page.getByRole('switch', { name: 'Modo no responsivo (experimental)' }).check();
  await page.getByRole('button', { name: 'Restablecer' }).click();
  for (const field of CONFIG_FIELDS) {
    await expect(numberBox(page, field), `${field.key} after «Restablecer»`).toHaveValue(formatField(getConfigValue(defaults, field.key), field));
  }
  await expect(page.getByRole('switch', { name: 'Auto-retorno' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Modo no responsivo (experimental)' })).not.toBeChecked();
  expect(watch.problems).toEqual([]);
});

test('[sintético: ajustes] «Sentado» changes the thresholds the way the notes say (world scale ÷ 0.7, launch thresholds × 0.7, the tug rise untouched), and a launch is still read', async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchProblems(page);
  await visit(page);
  await openAdvanced(page);
  const standing = createConfig('standing');
  const seated = createConfig('seated');
  const byKey = (key: string) => CONFIG_FIELDS.find(field => field.key === key)!;

  await page.getByRole('group', { name: 'Postura' }).getByRole('button', { name: 'Sentado' }).click();
  for (const key of ['world.scale', 'launch.minDownSpeed', 'tug.minUpDelta', 'yoyo.launchSpinMin']) {
    await expect(numberBox(page, byKey(key)), key).toHaveValue(formatField(getConfigValue(seated, key), byKey(key)));
  }
  // The figures themselves, so a change of the factor shows up here.
  await expect(numberBox(page, byKey('world.scale'))).toHaveValue('1.43');
  await expect(numberBox(page, byKey('launch.minDownSpeed'))).toHaveValue('0.84');
  await expect(numberBox(page, byKey('tug.minUpDelta'))).toHaveValue(formatField(standing.tug.minUpDelta, byKey('tug.minUpDelta')));

  // Choosing a posture starts from that posture's own config again, keeping the two switches.
  await page.getByRole('switch', { name: 'Auto-retorno' }).uncheck();
  await slider(page, byKey('yoyo.sleepTau')).focus();
  await page.keyboard.press('Home');
  await page.getByRole('group', { name: 'Postura' }).getByRole('button', { name: 'De pie' }).click();
  await expect(numberBox(page, byKey('yoyo.sleepTau'))).toHaveValue(formatField(standing.yoyo.sleepTau, byKey('yoyo.sleepTau')));
  await expect(numberBox(page, byKey('world.scale'))).toHaveValue('1.00');
  await expect(page.getByRole('switch', { name: 'Auto-retorno' })).not.toBeChecked();

  // The seated thresholds still read a launch by pointer.
  await page.getByRole('switch', { name: 'Auto-retorno' }).check();
  await page.getByRole('group', { name: 'Postura' }).getByRole('button', { name: 'Sentado' }).click();
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });
  await launchUntilRolling(page, PRESS_AT);
  await expect(app(page)).toHaveAttribute('data-phase', /rolling|sleeping/);
  await page.mouse.up();
  expect(watch.problems).toEqual([]);
});
