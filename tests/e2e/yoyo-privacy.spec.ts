import { test, expect, type Download } from '@playwright/test';
import fs from 'node:fs';
import { parseReplay } from '../../src/yoyo/replay/replayFile';
import {
  app, beaconCount, grantCamera, openAdvanced, openDiagnostics, ORIGIN, playRound, PRESS_AT, QA_URL, recordNetwork, saveJson, shot, sleep,
  spyBeacons, startCameraAndWaitForFraming, storageState, visit, waitForPhase, watchProblems, YOYO_URL,
} from './yoyo-ui';

/**
 * Y-12 — privacy. Camera and landmarks stay in the browser: no request carries them, nothing is persisted, and the only
 * way anything leaves memory is a download the person asks for. Evidence labels: the network and storage checks run
 * across a camera session on the FAKE camera with the synthetic hands of `?qa=camera-replay`, a pointer session and the
 * demo; the recorder's file is the fake camera's frames carrying synthetic hands. None of it is a real webcam.
 */

/** What the page may ask its own origin for: the document, its bundles, the MediaPipe runtime and the model, the icon. */
const STATIC_PATH = /^\/(yoyo|favicon\.svg|assets\/[\w.-]+|vendor\/mediapipe\/[\w./-]+)$/;

/** Every string in a parsed JSON value, keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) { out.push(key); strings(item, out); }
  return out;
}

const readJson = async (download: Download): Promise<{ text: string; json: Record<string, unknown> }> => {
  const text = fs.readFileSync((await download.path())!, 'utf8');
  return { text, json: JSON.parse(text) as Record<string, unknown> };
};

test('[cámara falsa + manos sintéticas, puntero, demo] Y-12: across the three sources the page only GETs its own static files, opens no websocket, sends no beacon, and stores nothing', async ({ page, context }) => {
  test.setTimeout(150_000);
  const watch = watchProblems(page);
  const net = recordNetwork(context);
  await grantCamera(context);
  await spyBeacons(page);
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await visit(page, QA_URL);

  // The page's own policy says it too: everything from 'self', connections included.
  const csp = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");

  // 1. Camera (fake device, synthetic hands) until the yoyo has been thrown and sleeps; the settings are touched on the way.
  await startCameraAndWaitForFraming(page);
  await openDiagnostics(page);
  await waitForPhase(page, 'sleeping', { timeout: 15_000 });
  await page.getByRole('radiogroup', { name: 'Color del yoyó' }).getByRole('radio', { name: 'Verde' }).click();
  await page.getByRole('slider', { name: 'Volumen' }).fill('40');
  await page.getByRole('button', { name: 'Apagar cámara' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');

  // 2. Pointer: one round.
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });
  await playRound(page, PRESS_AT);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Volver al inicio' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');

  // 3. Demo until the first throw.
  await page.getByRole('button', { name: 'Ver demo' }).click();
  await waitForPhase(page, 'rolling', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Volver al inicio' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');

  // Nothing but same-origin GETs of static files, none with a body; none of the channels a leak would use.
  const outside = net.requests.filter(r => !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const paths = [...new Set(outside.map(r => new URL(r.url).pathname))].sort();
  expect(outside.length).toBeGreaterThan(5);
  expect(outside.filter(r => new URL(r.url).origin !== ORIGIN).map(r => r.url)).toEqual([]);
  expect(outside.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.url}`)).toEqual([]);
  expect(outside.filter(r => r.hasBody).map(r => r.url)).toEqual([]);
  expect(paths.filter(p => !STATIC_PATH.test(p))).toEqual([]);
  expect(outside.filter(r => ['websocket', 'ping', 'eventsource', 'beacon'].includes(r.resourceType)).map(r => r.url)).toEqual([]);
  expect(net.websockets).toEqual([]);
  expect(await beaconCount(page)).toBe(0);
  // The check is not vacuous: the camera session did load the model and its runtime through those same GETs.
  expect(paths.some(p => p.startsWith('/vendor/mediapipe/') && p.endsWith('.task'))).toBe(true);
  expect(paths.some(p => p.startsWith('/vendor/mediapipe/') && p.endsWith('.wasm'))).toBe(true);
  expect(paths.some(p => p.startsWith('/assets/hand.worker-'))).toBe(true);

  // Nothing persisted: no web storage, no database, no cookie (document.cookie or the HttpOnly kind), no cache, no service worker.
  expect(await storageState(page)).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: [], cookie: '', cacheStorage: [], serviceWorkers: 0 });
  expect(await context.cookies()).toEqual([]);
  // And nothing was downloaded by itself.
  expect(downloads).toEqual([]);

  saveJson('privacy-network', {
    kind: 'cámara falsa + manos sintéticas, puntero y demo en una sola sesión de página',
    requests: outside.length,
    methods: [...new Set(outside.map(r => r.method))],
    resourceTypes: [...new Set(outside.map(r => r.resourceType))].sort(),
    distinctPaths: paths,
    websockets: net.websockets.length,
    beacons: 0,
    storage: await storageState(page),
    cookies: 0,
    downloads: 0,
  });
  expect(watch.problems).toEqual([]);
});

test('[cámara falsa + manos sintéticas] Y-12: landmarks leave the page only by an explicit click, as one JSON of the documented schema; the metrics too', async ({ page, context }) => {
  test.setTimeout(120_000);
  const watch = watchProblems(page);
  const net = recordNetwork(context);
  await grantCamera(context);
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await visit(page, QA_URL);
  await startCameraAndWaitForFraming(page);
  await openAdvanced(page);

  // Before anything is recorded there is nothing to download.
  const record = page.getByRole('button', { name: 'Grabar landmarks' });
  const download = page.getByRole('button', { name: 'Descargar JSON' });
  await expect(record).toBeEnabled();
  await expect(download).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Descartar' })).toBeDisabled();
  await expect(page.getByText('Sin grabación')).toBeVisible();

  // About 4.5 s with the yoyo tying on and being thrown (the first throw is at ~3 s of the session).
  await record.click();
  await expect(page.getByRole('button', { name: 'Detener' })).toBeVisible();
  await page.getByLabel('Nota (opcional)').fill('nota de prueba e2e');
  await sleep(4_500);
  await page.getByRole('button', { name: 'Detener' }).click();
  await expect(page.getByText(/^\d+ cuadros · \d+,\d s$/)).toBeVisible();
  await expect(download).toBeEnabled();
  await shot(page, 'privacy-recorded');

  // Stopping is not downloading: nothing has left the page, however long we wait.
  await sleep(1_500);
  expect(downloads).toEqual([]);

  // One click, one file.
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^yoyo-replay-\d{8}-\d{6}\.json$/);
  const { text, json } = await readJson(file);
  await sleep(800);
  expect(downloads).toHaveLength(1);

  // The schema, and nothing but the schema.
  expect(json.schema).toBe('yoyo-replay/1');
  expect(Object.keys(json).every(key => ['schema', 'note', 'config', 'frames', 'detected', 'labels'].includes(key))).toBe(true);
  expect(json.note).toBe('nota de prueba e2e');
  const frames = json.frames as Array<{ t: number; a: number; hands: Array<{ h: string; lm: unknown[] }> }>;
  expect(frames.length).toBeGreaterThan(60);
  expect(frames.some(frame => frame.hands.length > 0)).toBe(true);
  let lastT = -Infinity;
  for (const frame of frames) {
    expect(Object.keys(frame).sort()).toEqual(['a', 'hands', 't']);
    expect(frame.t).toBeGreaterThan(lastT);
    expect(frame.a).toBeGreaterThanOrEqual(frame.t);
    lastT = frame.t;
    for (const hand of frame.hands) {
      expect(Object.keys(hand).sort()).toEqual(['h', 'lm']);
      expect(['Left', 'Right', 'Unknown']).toContain(hand.h);
      expect(hand.lm).toHaveLength(21);
      for (const point of hand.lm as unknown[]) {
        expect(Array.isArray(point) && point.length === 3 && point.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true);
      }
    }
  }
  // Landmarks only, never pixels: no data URLs, no base64-looking payloads, no image words, anywhere in the file.
  const all = strings(json);
  expect(all.filter(s => s.startsWith('data:'))).toEqual([]);
  expect(all.filter(s => /^[A-Za-z0-9+/=]{40,}$/.test(s))).toEqual([]);
  expect(text).not.toMatch(/data:|base64|image\//i);
  // What the live classifier fired during the recording is in it, and the file is something the repo's own parser loads back as a fixture.
  const detected = json.detected as Array<{ kind: string; t: number }>;
  expect(detected.some(entry => entry.kind === 'launch')).toBe(true);
  expect(detected.every(entry => entry.t >= 0 && entry.t <= lastT)).toBe(true);
  expect(() => parseReplay(text)).not.toThrow();
  expect((json.config as { preset: string }).preset).toBe('standing');

  // The metrics export is the same kind of thing: nothing until the click, then one local file.
  const [metrics] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar métricas' }).click()]);
  expect(metrics.suggestedFilename()).toMatch(/^yoyo-metricas-\d{8}-\d{6}\.json$/);
  const exported = await readJson(metrics);
  expect(exported.json.schema).toBe('yoyo-metrics/1');
  expect(Object.keys(exported.json).sort()).toEqual(['diagnostics', 'metrics', 'preset', 'responsiveness', 'schema', 'source']);
  expect(exported.json.source).toBe('camera');
  expect(strings(exported.json).filter(s => s.startsWith('data:') || /^[A-Za-z0-9+/=]{40,}$/.test(s))).toEqual([]);
  expect((exported.json.metrics as { launches: number }).launches).toBeGreaterThanOrEqual(1);
  await sleep(800);
  expect(downloads).toHaveLength(2);

  // «Descartar» forgets the recording: it exists only in memory, and now it does not exist.
  await page.getByRole('button', { name: 'Descartar' }).click();
  await expect(download).toBeDisabled();
  await expect(page.getByText('Sin grabación')).toBeVisible();
  await sleep(500);
  expect(downloads).toHaveLength(2);

  // Through all of it, still no request but GETs of static files.
  const outside = net.requests.filter(r => !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  expect(outside.filter(r => new URL(r.url).origin !== ORIGIN || r.method !== 'GET' || r.hasBody).map(r => `${r.method} ${r.url}`)).toEqual([]);
  expect(await storageState(page)).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: [], cookie: '', cacheStorage: [], serviceWorkers: 0 });

  saveJson('privacy-recorder', {
    kind: 'cámara falsa + manos sintéticas: NO es webcam',
    replayFile: {
      name: 'yoyo-replay-<fecha>.json (nombre con la hora local; el contenido no lleva fecha)',
      bytes: Buffer.byteLength(text),
      frames: frames.length,
      framesWithHands: frames.filter(frame => frame.hands.length > 0).length,
      durationMs: Math.round(lastT),
      topLevelKeys: Object.keys(json),
      detected,
      parsedByTheRepoParser: true,
    },
    metricsFile: { name: 'yoyo-metricas-<fecha>.json', topLevelKeys: Object.keys(exported.json) },
    downloadsBeforeTheClick: 0,
    downloadsInTotal: 2,
  });
  expect(watch.problems).toEqual([]);
});

test('[sintético: página] Y-12: the start screen says the camera is processed in the browser and nothing is recorded or sent, and a fresh load starts with nothing stored', async ({ page }) => {
  const watch = watchProblems(page);
  await visit(page, YOYO_URL);
  await expect(page.getByText('La cámara se procesa en tu navegador; nada se graba ni se envía.')).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByText('Sólo puntos de la mano, nunca imágenes. Queda en tu navegador hasta que lo descargues.')).toBeVisible();
  await expect(page.getByText('Contadores de esta sesión como archivo local; nada se envía.')).toBeVisible();
  expect(await storageState(page)).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: [], cookie: '', cacheStorage: [], serviceWorkers: 0 });
  expect(watch.problems).toEqual([]);
});
