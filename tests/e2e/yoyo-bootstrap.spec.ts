import { test, expect } from '@playwright/test';
import { app, shot, VIEWPORT, watchProblems, YOYO_URL } from './yoyo-ui';

/** «rgb(8, 11, 16)» / «rgba(…)» → [r, g, b]. */
const channels = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);

test('[sintético: página] /yoyo loads the start screen: dark, three ways in, privacy line, no console errors, no HTTP failures', async ({ page }) => {
  const watch = watchProblems(page);
  await page.setViewportSize(VIEWPORT);
  const response = await page.goto(YOYO_URL);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Yoyó');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');

  // The start screen: the three ways in and the one line about privacy.
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Probar con mouse' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver demo' })).toBeVisible();
  await expect(page.getByText('La cámara se procesa en tu navegador; nada se graba ni se envía.')).toBeVisible();

  // Dark by default (PRD §1.3): the declared scheme and what is actually painted.
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'dark');
  const paint = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    app: getComputedStyle(document.querySelector('.app')!).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    ink: getComputedStyle(document.body).color,
  }));
  expect(paint.scheme).toBe('dark');
  expect(channels(paint.app).every(c => c <= 40), `app background ${paint.app}`).toBe(true);
  expect(channels(paint.body).every(c => c <= 40), `body background ${paint.body}`).toBe(true);
  expect(channels(paint.ink).every(c => c >= 150), `text colour ${paint.ink}`).toBe(true);

  // Nothing runs yet: the root says idle, there is no QA hook, no status pill, a canvas with a label.
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');
  await expect(app(page)).toHaveAttribute('data-source', 'none');
  await expect(app(page)).toHaveAttribute('data-phase', 'none');
  await expect(app(page)).toHaveAttribute('data-hand', 'none');
  await expect(app(page)).toHaveAttribute('data-edge', 'none');
  expect(await app(page).getAttribute('data-qa')).toBeNull();
  await expect(page.locator('.pill')).toBeHidden();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveAttribute('aria-label', /Yoyó/);

  // The always-visible dock: seven colours (the first is the current one) and the way into the settings.
  const colours = page.getByRole('radiogroup', { name: 'Color del yoyó' }).getByRole('radio');
  await expect(colours).toHaveCount(7);
  await expect(colours.first()).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Ajustes' })).toHaveAttribute('aria-expanded', 'false');

  // Let the idle scene run for a moment: the loop must not throw.
  await page.waitForTimeout(1500);
  await shot(page, 'bootstrap-start');
  expect(watch.problems).toEqual([]);
  expect(watch.ignored).toEqual([]);
});

test('[sintético: página] Masa at / is intact: its own start screen, no yoyó code loaded (Y-15 smoke)', async ({ page }) => {
  const watch = watchProblems(page);
  const requested: string[] = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  await page.setViewportSize(VIEWPORT);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Masa');

  // Masa's start screen and its own controls, none of the yoyó's.
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Probar con mouse' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Observar demo sintética' })).toBeVisible();
  await expect(page.locator('.app')).toHaveClass(/dark/);
  expect(await app(page).getAttribute('data-mode')).toBeNull();
  await expect(page.getByRole('button', { name: 'Ver demo' })).toHaveCount(0);

  await page.waitForTimeout(1200);
  await shot(page, 'bootstrap-masa-start');
  expect(requested.filter(path => /\/assets\/yoyo-|yoyo\.html/.test(path))).toEqual([]);
  expect(watch.problems).toEqual([]);
});
