import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import {
  app, diagnostics, openAdvanced, openDiagnostics, phasesAfterRounds, phasesOf, playRound, PRESS_AT, SHOT_DIR, shot, sleep, traceOf, valuesOf,
  visit, VIEWPORT, waitForPhase, watchProblems, webglRenderer, yoyoOnScreen, type Diag,
} from './yoyo-ui';

/**
 * Y-10 in the browser. Evidence label: GPU headless — Chrome (channel `chrome`) in headless mode on this machine's GPU, with
 * the WebGL renderer the browser reports written next to the numbers. It is NOT a webcam run, NOT a human's «me sigue», and
 * it says nothing about an integrated GPU or about a Mac that is not this one. The numbers are the ones the page's own
 * diagnostics panel shows (rolling windows of the last ~6 s: 360 frames, 128 intent latencies), read at the end of 20 s of play.
 */

/** The budgets of PRD §7 / Y-10. */
const BUDGET = { frameP95Ms: 16.8, physicsP95Ms: 1.5, renderP95Ms: 8, latencyP95Ms: 100 } as const;

const FILE = `${SHOT_DIR}/browser-performance.json`;
const results: Record<string, unknown> = {};

// The file keeps the sections of earlier runs (a run of one test updates only its own), each stamped with when it was measured.
test.afterAll(() => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const previous = fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>) : {};
  const measuredAt = new Date().toISOString();
  const fresh = Object.fromEntries(Object.entries(results).map(([name, section]) => [name, { measuredAt, ...(section as object) }]));
  fs.writeFileSync(FILE, `${JSON.stringify({
    ...previous,
    kind: 'GPU headless: Chrome (canal chrome) en modo headless sobre la GPU de esta máquina; sin webcam, sin prueba humana',
    machine: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length },
    budgets: BUDGET,
    ...fresh,
  }, null, 2)}\n`);
});

const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

/** The four numbers of Y-10 and the context around them, from one reading of the panel. */
const summarise = (d: Diag) => ({
  fps: d.fps, frameP95Ms: d.frameP95Ms, startLagP95Ms: d.startLagP95Ms, physicsP95Ms: d.physicsP95Ms, renderP95Ms: d.renderP95Ms,
  latencyP50Ms: d.latencyP50Ms, latencyP95Ms: d.latencyP95Ms, latencySamples: d.latencySamples, pixelRatio: d.pixelRatio,
  droppedMs: d.droppedMs, queueDrops: d.queueDrops, launches: d.launches, tugs: d.tugs, catches: d.catches, drawCalls: d.drawCalls, gpu: d.gpu,
});

/** «Exportar métricas»: the runtime's own record of intent → advance latency, for the sources the panel does not time (the demo). */
async function exportedLatencies(page: Page): Promise<number[]> {
  await openAdvanced(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar métricas' }).click()]);
  const file = JSON.parse(fs.readFileSync((await download.path())!, 'utf8')) as { metrics: { reactionLatencyMs: number[] } };
  return file.metrics.reactionLatencyMs;
}

async function environment(page: Page, browserVersion: string) {
  return { browser: 'Chrome', version: browserVersion, headless: true, viewport: VIEWPORT, webgl: await webglRenderer(page) };
}

test('[GPU headless] Y-10 pointer route: 20 s of scripted rounds stay inside the frame, physics, render and latency budgets', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const watch = watchProblems(page);
  await visit(page);
  const env = await environment(page, browser.version());
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await openDiagnostics(page);   // open the whole time: the panel's own cost is part of what is measured

  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });
  const started = Date.now();
  const series: Array<{ atS: number } & ReturnType<typeof summarise>> = [];
  let rounds = 0;
  let represses = 0;
  while (Date.now() - started < 20_000) {
    represses += (await playRound(page, PRESS_AT)).launchRepresses;
    rounds++;
    series.push({ atS: Math.round((Date.now() - started) / 100) / 10, ...summarise(await diagnostics(page)) });
  }
  const elapsedS = (Date.now() - started) / 1000;

  // The reading: let the panel refresh once more, then take the final numbers.
  await sleep(450);
  const final = await diagnostics(page);
  await page.mouse.up();
  const latencies = await exportedLatencies(page);
  await shot(page, 'performance-pointer');

  results.pointer = {
    elapsedS: Math.round(elapsedS * 10) / 10,
    rounds,
    harnessRepresses: represses,
    final: summarise(final),
    seriesOfTheRun: series,
    worstFrameP95InTheRun: Math.max(...series.map(s => Number(s.frameP95Ms))),
    metricsFileReactionLatencyMs: { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
    ...env,
  };

  expect(elapsedS).toBeGreaterThanOrEqual(20);
  expect(Number(final.launches)).toBeGreaterThanOrEqual(5);
  expect(Number(final.frameP95Ms), 'frame interval p95 (rAF timestamps), ms').toBeLessThanOrEqual(BUDGET.frameP95Ms);
  expect(Number(final.physicsP95Ms), 'physics p95, ms').toBeLessThanOrEqual(BUDGET.physicsP95Ms);
  expect(Number(final.renderP95Ms), 'render p95, ms').toBeLessThanOrEqual(BUDGET.renderP95Ms);
  expect(Number(final.latencySamples)).toBeGreaterThanOrEqual(10);
  expect(Number(final.latencyP95Ms), 'intent → render p95, ms').toBeLessThanOrEqual(BUDGET.latencyP95Ms);
  expect(Math.max(...latencies), 'worst intent → advance in the metrics file, ms').toBeLessThanOrEqual(BUDGET.latencyP95Ms);
  expect(final.queueDrops).toBe(0);
  expect(watch.problems).toEqual([]);
});

test('[GPU headless] Y-10 demo: 20 s of the demo (with its simulated 50–60 ms tracking delay) stay inside the budgets', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const watch = watchProblems(page);
  await visit(page);
  const env = await environment(page, browser.version());
  await page.getByRole('button', { name: 'Ver demo' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'demo');
  await openDiagnostics(page);

  const started = Date.now();
  const series: Array<{ atS: number } & ReturnType<typeof summarise>> = [];
  while (Date.now() - started < 20_000) {
    await sleep(2_000);
    series.push({ atS: Math.round((Date.now() - started) / 100) / 10, ...summarise(await diagnostics(page)) });
  }
  const elapsedS = (Date.now() - started) / 1000;
  await sleep(450);
  const final = await diagnostics(page);
  const latencies = await exportedLatencies(page);
  await shot(page, 'performance-demo');

  results.demo = {
    elapsedS: Math.round(elapsedS * 10) / 10,
    final: summarise(final),
    seriesOfTheRun: series,
    worstFrameP95InTheRun: Math.max(...series.map(s => Number(s.frameP95Ms))),
    // The panel does not time the demo (its input is a clip, not a person: YoyoEngine.frame skips the `replay` source), so the
    // intent latency comes from the runtime's own record in the metrics file: capture of the sample that decided it → the frame
    // that advanced the physics. It includes the clip's simulated tracking delay (50 ms + 0–10 ms).
    latencyFromMetricsFileMs: { samples: latencies.length, values: latencies, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
    panelLatencySamples: final.latencySamples,
    ...env,
  };

  expect(elapsedS).toBeGreaterThanOrEqual(20);
  expect(Number(final.launches)).toBeGreaterThanOrEqual(3);   // two in the first pass, one or more in the second
  expect(Number(final.frameP95Ms), 'frame interval p95 (rAF timestamps), ms').toBeLessThanOrEqual(BUDGET.frameP95Ms);
  expect(Number(final.physicsP95Ms), 'physics p95, ms').toBeLessThanOrEqual(BUDGET.physicsP95Ms);
  expect(Number(final.renderP95Ms), 'render p95, ms').toBeLessThanOrEqual(BUDGET.renderP95Ms);
  expect(latencies.length).toBeGreaterThanOrEqual(6);
  expect(Math.max(...latencies), 'worst intent → advance in the demo, ms').toBeLessThanOrEqual(BUDGET.latencyP95Ms);
  expect(Math.min(...latencies), 'the demo\'s simulated tracking delay is in the number').toBeGreaterThanOrEqual(45);
  expect(final.queueDrops).toBe(0);
  expect(watch.problems).toEqual([]);
});

/**
 * Opt-in, like Masa's long run: `YOYO_LONG_ROUNDS=60 pnpm exec playwright test tests/e2e/yoyo-performance.spec.ts -g opt-in`
 * is about three minutes of pointer play. Y-09 is asserted headless (10 simulated minutes at 240 Hz); this is the same
 * question asked of the page: after dozens of rounds, are the counters still in step, the frames still on budget, the yoyo
 * still on screen, and the console still empty?
 */
const LONG_ROUNDS = Number(process.env.YOYO_LONG_ROUNDS ?? 0);

test('[GPU headless] opt-in: many pointer rounds in a row keep every counter in step, the frame budget and the yoyo on screen (Y-09 in the browser)', async ({ page, browser }) => {
  test.skip(!(LONG_ROUNDS >= 10), 'Set YOYO_LONG_ROUNDS=60 for about three minutes of pointer play');
  test.setTimeout(LONG_ROUNDS * 8_000 + 60_000);
  const watch = watchProblems(page);
  await visit(page);
  const env = await environment(page, browser.version());
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await openDiagnostics(page);
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });

  const started = Date.now();
  const series: Array<{ round: number; atS: number } & ReturnType<typeof summarise>> = [];
  let retries = 0;
  let represses = 0;
  for (let round = 1; round <= LONG_ROUNDS; round++) {
    const result = await playRound(page, PRESS_AT);
    represses += result.launchRepresses;
    if (result.launchAttempts > 1 || result.tugAttempts > 1) retries++;
    if (round % 10 === 0) series.push({ round, atS: Math.round((Date.now() - started) / 1000), ...summarise(await diagnostics(page)) });
  }
  const elapsedS = (Date.now() - started) / 1000;
  await sleep(450);
  const final = await diagnostics(page);
  const pixels = yoyoOnScreen(await shot(page, 'performance-long'));
  const trace = await traceOf(page);
  await page.mouse.up();

  results.long = { rounds: LONG_ROUNDS, elapsedS: Math.round(elapsedS), roundsWithARetriedGesture: retries, harnessRepresses: represses, final: summarise(final), seriesEveryTenRounds: series, yoyoPixelsAtTheEnd: pixels, ...env };

  // Every round is one launch, one tug and one catch, and nothing else happened in between.
  expect(phasesOf(trace)).toEqual(phasesAfterRounds(LONG_ROUNDS));
  expect(valuesOf(trace, 'data-hand')).toEqual(['present']);
  expect(final.launches).toBe(LONG_ROUNDS);
  expect(final.tugs).toBe(LONG_ROUNDS);
  expect(final.catches).toBe(LONG_ROUNDS);
  expect(final.autoReturns).toBe(0);
  expect(final.queueDrops).toBe(0);
  expect(Number(final.frameP95Ms), 'frame interval p95, ms').toBeLessThanOrEqual(BUDGET.frameP95Ms);
  expect(Number(final.physicsP95Ms), 'physics p95, ms').toBeLessThanOrEqual(BUDGET.physicsP95Ms);
  expect(Number(final.renderP95Ms), 'render p95, ms').toBeLessThanOrEqual(BUDGET.renderP95Ms);
  expect(Number(final.latencyP95Ms), 'intent → render p95, ms').toBeLessThanOrEqual(BUDGET.latencyP95Ms);
  expect(pixels.count, 'the yoyo is on screen after all of them').toBeGreaterThan(1_000);
  expect(watch.problems).toEqual([]);
});
