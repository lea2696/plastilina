import { test, expect } from '@playwright/test';
import {
  app, installTrace, isSubsequence, mark, openAdvanced, phasesOf, saveJson, shot, sleep, timeOf, traceOf, TWO_ROUNDS, valuesOf, VIEWPORT,
  waitForPhase, watchProblems, yoyoOnScreen, YOYO_URL,
} from './yoyo-ui';
import fs from 'node:fs';

/**
 * «Ver demo»: a synthetic camera session (PRD noise: jitter, 50 ms tracking delay, dropped frames) replayed in real time
 * through the whole pipeline. Evidence label: sintético (demo). It is a showcase, not a measurement of the classifiers.
 */

const DEMO_PILL = 'Demo';

test('[sintético: demo] «Ver demo» walks tethered → rolling → sleeping → returning → caught twice in about 16 s, with the sleeper on screen, and «Volver al inicio» brings the start screen back', async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchProblems(page);
  await installTrace(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(YOYO_URL);

  await page.getByRole('button', { name: 'Ver demo' }).click();
  const clickedAt = await mark(page, 'click-demo');
  await expect(app(page)).toHaveAttribute('data-mode', 'demo');
  await expect(app(page)).toHaveAttribute('data-source', 'replay');
  await expect(page.getByRole('status')).toHaveText(DEMO_PILL);
  // The start screen gave way to the demo: its buttons are gone.
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toHaveCount(0);

  // Each sleeper is photographed (the page once drew it under the floor): on screen, above the floor line.
  const sleepers: Array<ReturnType<typeof yoyoOnScreen>> = [];
  let from = 0;
  for (const round of [1, 2]) {
    const tethered = await waitForPhase(page, 'tethered', { from, timeout: 20_000 });
    // The stand-in camera shows its tracking dot, green while the hand's data is fresh.
    if (round === 1) await expect(page.locator('.tracking')).toHaveAttribute('data-quality', 'fresh');
    if (round === 1) await shot(page, 'demo-1-tethered');
    const rolling = await waitForPhase(page, 'rolling', { from: tethered.index, timeout: 8_000 });
    if (round === 1) await shot(page, 'demo-2-rolling');
    const sleeping = await waitForPhase(page, 'sleeping', { from: rolling.index, timeout: 8_000 });
    await sleep(500);
    sleepers.push(yoyoOnScreen(await shot(page, `demo-3-sleeping-round${round}`)));
    const returning = await waitForPhase(page, 'returning', { from: sleeping.index, timeout: 12_000 });
    if (round === 1) await shot(page, 'demo-4-returning');
    const caught = await waitForPhase(page, 'caught', { from: returning.index, timeout: 6_000 });
    if (round === 1) await shot(page, 'demo-5-caught');
    from = caught.index;
  }
  const secondCaughtAt = (await waitForPhase(page, 'tethered', { from, timeout: 3_000 })).t;

  // Two full rounds, in the order every route walks (Y-11), within about 16 s of the click.
  const trace = await traceOf(page);
  expect(phasesOf(trace).slice(0, TWO_ROUNDS.length)).toEqual([...TWO_ROUNDS]);
  expect(secondCaughtAt - clickedAt).toBeLessThanOrEqual(16_000);
  expect(isSubsequence(['Demo'], valuesOf(trace, 'pill'))).toBe(true);
  for (const [i, pixels] of sleepers.entries()) {
    expect(pixels.count, `yoyo pixels at sleep ${i + 1}`).toBeGreaterThan(1_500);
    expect(pixels.box!.maxY, `yoyo bottom at sleep ${i + 1}`).toBeLessThan(pixels.height * 0.93);
    expect(pixels.box!.minY).toBeGreaterThan(0);
  }
  expect(timeOf(trace, 'data-phase', 'tethered')! - clickedAt).toBeLessThan(3_000);

  // «Volver al inicio»: the demo ends and the start screen is back, ready to pick another way in.
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('button', { name: 'Volver al inicio' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');
  await expect(app(page)).toHaveAttribute('data-source', 'none');
  await expect(app(page)).toHaveAttribute('data-phase', 'none');
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Probar con mouse' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver demo' })).toBeVisible();
  await shot(page, 'demo-6-back-to-start');

  saveJson('demo', {
    kind: 'sintético: demo (clip de cámara sintético con el ruido del PRD §8.2) reproducido en tiempo real',
    secondRoundEndedAfterMs: Math.round(secondCaughtAt - clickedAt),
    phases: phasesOf(trace).slice(0, TWO_ROUNDS.length),
    yoyoPixelsAtSleep: sleepers,
  });
  expect(watch.problems).toEqual([]);
});

test('[sintético: demo] pausing holds the demo, resuming plays on without skipping a phase, and «Exportar métricas» is only a click away', async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchProblems(page);
  await installTrace(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(YOYO_URL);
  await page.getByRole('button', { name: 'Ver demo' }).click();

  // Pause while the yoyo sleeps, for two seconds: nothing moves, and the demo's clock does not run on behind the curtain.
  const sleeping = await waitForPhase(page, 'sleeping', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'paused');
  await expect(page.getByRole('status')).toHaveText('Pausa');
  const heldFrom = (await traceOf(page)).length;
  await sleep(2_500);
  expect(valuesOf(await traceOf(page), 'data-phase', heldFrom)).toEqual([]);
  await shot(page, 'demo-paused');
  await page.getByRole('button', { name: 'Reanudar' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'demo');

  // Everything that was left of the two rounds still happens, in order.
  const returning = await waitForPhase(page, 'returning', { from: sleeping.index, timeout: 12_000 });
  const caught = await waitForPhase(page, 'caught', { from: returning.index, timeout: 6_000 });
  await waitForPhase(page, 'tethered', { from: caught.index, timeout: 3_000 });
  expect(phasesOf(await traceOf(page)).slice(0, 7)).toEqual(TWO_ROUNDS.slice(0, 7));

  // The metrics are a local file, produced by the click and by nothing else.
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await openAdvanced(page);
  await sleep(800);
  expect(downloads).toEqual([]);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar métricas' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^yoyo-metricas-\d{8}-\d{6}\.json$/);
  const file = JSON.parse(fs.readFileSync((await download.path())!, 'utf8')) as { schema: string; source: string; metrics: { launches: number; reactionLatencyMs: number[] } };
  expect(file.schema).toBe('yoyo-metrics/1');
  expect(file.source).toBe('replay');
  expect(file.metrics.launches).toBeGreaterThanOrEqual(1);
  expect(file.metrics.reactionLatencyMs.length).toBeGreaterThanOrEqual(2);
  await shot(page, 'demo-advanced');
  expect(watch.problems).toEqual([]);
});
