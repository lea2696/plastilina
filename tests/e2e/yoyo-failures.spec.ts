import { test, expect } from '@playwright/test';
import {
  app, grantCamera, PRESS_AT, shot, sleep, traceOf, visit, waitForPhase, watchProblems, yoyoOnScreen, YOYO_URL,
} from './yoyo-ui';

/**
 * What the page does when something is missing or breaks. Evidence label: sintético (the failures are injected into the real
 * page: no WebGL, a camera that refuses or is absent, a model that does not load, a GPU context that is lost).
 * The messages are the ones the person reads, so they are asserted word for word.
 */

const START_BUTTONS = ['Comenzar con cámara', 'Probar con mouse', 'Ver demo'] as const;

test('[sintético: fallas] WebGL unavailable: the page says so, offers «Reintentar» and no way in, and the console stays clean', async ({ page }) => {
  const watch = watchProblems(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        if (type.startsWith('webgl') || type === 'experimental-webgl') return null;
        return Reflect.apply(original, this, [type, ...args]);
      },
    });
  });
  await visit(page);
  await expect(app(page)).toHaveAttribute('data-mode', 'unsupported');
  await expect(page.getByRole('status')).toHaveText('Este navegador no ofrece WebGL. Probá Chrome actualizado en una computadora con gráficos disponibles.');
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  for (const name of START_BUTTONS) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ajustes' })).toHaveCount(0);
  await shot(page, 'failures-no-webgl');

  // «Reintentar» reloads the page (here it meets the same missing WebGL, so the same message comes back).
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reintentar' }).click()]);
  await expect(page.getByRole('status')).toContainText('no ofrece WebGL');
  expect(watch.problems).toEqual([]);
});

const CAMERA_REFUSALS = [
  { error: 'NotAllowedError', message: 'Permiso rechazado. Habilitá la cámara en el navegador o probá con el mouse.' },
  { error: 'NotFoundError', message: 'No se encontró una cámara. Podés probar con el mouse o mirar la demo.' },
  { error: 'NotReadableError', message: 'La cámara está ocupada o no responde. Cerrá otras apps e intentá de nuevo.' },
] as const;

for (const { error, message } of CAMERA_REFUSALS) {
  test(`[sintético: fallas] camera ${error}: a Spanish message, the start buttons come back, the pointer still works`, async ({ page }) => {
    const watch = watchProblems(page);
    await page.addInitScript((name: string) => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => Promise.reject(new DOMException('injected', name)) });
    }, error);
    await visit(page);
    await page.getByRole('button', { name: 'Comenzar con cámara' }).click();
    await expect(app(page)).toHaveAttribute('data-mode', 'error');
    await expect(page.getByRole('status')).toHaveText(message);
    for (const name of START_BUTTONS) await expect(page.getByRole('button', { name })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await shot(page, `failures-camera-${error}`);

    // Not a dead end: the pointer route starts from there.
    await page.getByRole('button', { name: 'Probar con mouse' }).click();
    await expect(app(page)).toHaveAttribute('data-mode', 'mouse');
    await expect(page.getByRole('status')).toContainText('Mantené apretado');
    expect(watch.problems).toEqual([]);
  });
}

test('[sintético: fallas] «Cancelar» while the permission is pending: back to the start, and a stream granted late is stopped', async ({ page }) => {
  const watch = watchProblems(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => new Promise<MediaStream>(resolve => { (window as Window & { grantLate?: (stream: MediaStream) => void }).grantLate = resolve; }),
    });
  });
  await visit(page);
  await page.getByRole('button', { name: 'Comenzar con cámara' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'permission-pending');
  await expect(page.getByRole('status')).toHaveText('Esperando permiso de cámara');
  await expect(page.getByRole('button', { name: 'Cancelar' })).toBeVisible();
  for (const name of START_BUTTONS) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await shot(page, 'failures-permission-pending');

  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();

  // The browser grants the camera after the person gave up: nobody is listening, so the stream must be stopped, not kept.
  await page.evaluate(() => {
    const w = window as Window & { lateStream?: MediaStream; grantLate?: (stream: MediaStream) => void };
    w.lateStream = document.createElement('canvas').captureStream();
    w.grantLate?.(w.lateStream);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { lateStream: MediaStream }).lateStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');
  expect(watch.problems).toEqual([]);
});

test('[cámara falsa] a model that does not load is a recoverable error, not a blank screen, and the camera is released', async ({ page, context }) => {
  test.setTimeout(60_000);
  await grantCamera(context);
  await page.addInitScript(() => {
    const w = window as Window & { qaStreams?: MediaStream[] };
    w.qaStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => { const stream = await original(constraints); w.qaStreams!.push(stream); return stream; },
    });
  });
  await page.route('**/hand_landmarker.task', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>wrong</title>' }));
  await visit(page);
  await page.getByRole('button', { name: 'Comenzar con cámara' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'error', { timeout: 30_000 });
  await expect(page.getByRole('status')).toContainText('Seguimiento:');
  for (const name of START_BUTTONS) await expect(page.getByRole('button', { name })).toBeVisible();
  const tracks = await page.evaluate(() => ((window as Window & { qaStreams?: MediaStream[] }).qaStreams ?? []).flatMap(stream => stream.getTracks().map(track => track.readyState)));
  expect(tracks).toEqual(['ended']);
  await shot(page, 'failures-model');
});

test('[sintético: fallas] a GPU context that is lost: «Se perdió el dispositivo gráfico. Recargá la página.», «Reintentar», nothing else; the session in progress ends', async ({ page }) => {
  const watch = watchProblems(page);
  await visit(page);
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });

  // The real thing: the GPU context of the canvas goes away (WEBGL_lose_context).
  await page.evaluate(() => {
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    gl.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(app(page)).toHaveAttribute('data-mode', 'error');
  await expect(page.getByRole('status')).toHaveText('Se perdió el dispositivo gráfico. Recargá la página.');
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  for (const name of START_BUTTONS) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(app(page)).toHaveAttribute('data-source', 'none');
  await page.mouse.up();
  await shot(page, 'failures-context-lost');
  const trace = await traceOf(page);
  expect(trace.some(entry => entry.name === 'pill' && entry.value.includes('dispositivo gráfico'))).toBe(true);
  // The frame loop must not throw on a lost context, and the page must not log an error of its own for it.
  expect(watch.problems).toEqual([]);
});

test('[sintético: fallas] a GPU context that comes back clears the message: the start screen returns and the yoyo draws again', async ({ page }) => {
  await visit(page);
  await page.evaluate(async () => {
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const lose = gl.getExtension('WEBGL_lose_context')!;
    lose.loseContext();
    await new Promise(resolve => setTimeout(resolve, 300));
    lose.restoreContext();
  });
  await expect(app(page)).toHaveAttribute('data-mode', 'idle', { timeout: 10_000 });
  for (const name of START_BUTTONS) await expect(page.getByRole('button', { name })).toBeVisible();

  // And it really draws: a pointer session ties on and the yoyo is on screen.
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });
  await sleep(500);
  const pixels = yoyoOnScreen(await shot(page, 'failures-context-restored'));
  expect(pixels.count).toBeGreaterThan(1_000);
  await page.mouse.up();
});

test('[sintético: fallas] the «webglcontextlost» event alone (as Masa tests it) also asks for a reload', async ({ page }) => {
  await page.goto(YOYO_URL);
  await page.getByRole('button', { name: 'Ver demo' }).click();
  await page.locator('canvas').dispatchEvent('webglcontextlost', { bubbles: false, cancelable: true });
  await expect(page.getByRole('status')).toContainText('dispositivo gráfico');
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
});
