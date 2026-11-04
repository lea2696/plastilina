import { test, expect, type Page } from '@playwright/test';
import {
  app, edgeSamples, grantCamera, installEdgeProbe, isSubsequence, num, openAdvanced, openDiagnostics, phasesOf, pollDiagnostics,
  QA_URL, saveJson, shot, sleep, startCameraAndWaitForFraming, timeOf, traceOf, trailOf, TWO_ROUNDS, valuesOf, visit, waitForAttribute,
  waitForPhase, watchProblems, yoyoOnScreen,
} from './yoyo-ui';

/**
 * The camera pipeline of the yoyó. Evidence labels:
 *  - [cámara falsa]: Chrome's fake device (`--use-fake-device-for-media-stream`): the real permission flow, the real
 *    MediaPipe worker running on real frames, no hands in them.
 *  - [cámara falsa + manos sintéticas]: the same, with `?qa=camera-replay`: the camera path plays a synthetic session of hands
 *    (the page says so, in `data-qa` and on screen). Everything downstream of a frame is the production code.
 * Neither is a webcam: tracking quality, MediaPipe behaviour at throwing speed and the real camera's latency are not shown.
 */

const PILL = {
  asking: 'Esperando permiso de cámara',
  loading: 'Cargando modelo de manos',
  framing: 'Levantá la mano dentro del contorno',
  untethered: 'Mostrá la mano y quedate quieto un momento',
  tethered: 'Atado · lanzá hacia abajo',
  handLost: 'Mano perdida',
  edge: 'Muy abajo · subí la mano o incliná la cámara',
} as const;

/** Counts the workers the page creates and keeps every camera stream, to see that stopping releases all of them. */
async function spyResources(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as Window & { qaWorkers?: { created: number; active: number }; qaStreams?: MediaStream[] };
    const workers = { created: 0, active: 0 };
    const streams: MediaStream[] = [];
    w.qaWorkers = workers;
    w.qaStreams = streams;
    const Original = window.Worker;
    window.Worker = class extends Original {
      private counted = true;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.created++;
        workers.active++;
      }
      override terminate() {
        if (this.counted) {
          this.counted = false;
          workers.active--;
        }
        super.terminate();
      }
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints);
        streams.push(stream);
        return stream;
      },
    });
  });
}

async function resources(page: Page): Promise<{ workers: { created: number; active: number }; tracks: string[] }> {
  return page.evaluate(() => {
    const w = window as Window & { qaWorkers?: { created: number; active: number }; qaStreams?: MediaStream[] };
    return { workers: w.qaWorkers ?? { created: -1, active: -1 }, tracks: (w.qaStreams ?? []).flatMap(stream => stream.getTracks().map(track => track.readyState)) };
  });
}

test('[cámara falsa] permission → loading → framing, MediaPipe runs, no hands keeps it untethered; «Omitir», «Recalibrar», «Apagar cámara»', async ({ page, context }) => {
  test.setTimeout(90_000);
  const watch = watchProblems(page);
  await grantCamera(context);
  await spyResources(page);
  await visit(page);

  await page.getByRole('button', { name: 'Comenzar con cámara' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'framing', { timeout: 45_000 });
  await expect(app(page)).toHaveAttribute('data-source', 'camera');
  await expect(page.getByRole('status')).toHaveText(PILL.framing);
  let trace = await traceOf(page);
  expect(isSubsequence(['permission-pending', 'loading', 'framing'], valuesOf(trace, 'data-mode'))).toBe(true);
  expect(isSubsequence([PILL.asking, PILL.loading, PILL.framing], valuesOf(trace, 'pill'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Omitir' })).toBeVisible();
  await shot(page, 'camera-1-framing');

  // MediaPipe ran on the fake device's frames (a real worker, real inference), and the frames arrive in time.
  await openDiagnostics(page);
  const d = await pollDiagnostics(page, x => typeof x.inferenceMs === 'number' && x.inferenceMs > 0 && typeof x.captureToArrivalP50Ms === 'number');
  expect(d.source).toBe('camera');
  expect(num(d, 'inferenceMs')).toBeGreaterThan(0);
  expect(num(d, 'inferenceP50Ms')).toBeGreaterThan(0);
  expect(num(d, 'captureToArrivalP50Ms')).toBeGreaterThan(0);

  // The fake device shows no hands: nothing ties on, and the dot says there is no tracking.
  await sleep(3_500);
  await expect(app(page)).toHaveAttribute('data-mode', 'framing');
  await expect(app(page)).toHaveAttribute('data-phase', 'untethered');
  await expect(app(page)).toHaveAttribute('data-hand', 'none');
  await expect(page.locator('.tracking')).toHaveAttribute('data-quality', 'none');
  trace = await traceOf(page);
  expect(phasesOf(trace)).toEqual(['untethered']);
  expect(valuesOf(trace, 'data-hand')).toEqual([]);
  expect(d.launches).toBe(0);

  // The preset is one choice of two, on screen under the outline; the outline follows it.
  const posture = page.getByRole('group', { name: 'Postura' }).last();
  await posture.getByRole('button', { name: 'Sentado' }).click();
  await expect(posture.getByRole('button', { name: 'Sentado' })).toHaveAttribute('aria-pressed', 'true');
  await sleep(300);
  await shot(page, 'camera-2-framing-seated');
  await posture.getByRole('button', { name: 'De pie' }).click();
  await expect(posture.getByRole('button', { name: 'De pie' })).toHaveAttribute('aria-pressed', 'true');

  // «Omitir» (PRD §3.2: the calibration is skippable): it leaves framing and waits for a hand anywhere.
  await page.getByRole('button', { name: 'Omitir' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'playing');
  await expect(page.getByRole('status')).toHaveText(PILL.untethered);
  const skippedFrom = (await traceOf(page)).length;
  await sleep(2_000);
  await expect(app(page)).toHaveAttribute('data-phase', 'untethered');
  expect(valuesOf(await traceOf(page), 'data-phase', skippedFrom)).toEqual([]);
  await shot(page, 'camera-3-skipped');

  // «Recalibrar» brings the outline back.
  await page.getByRole('button', { name: 'Recalibrar' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'framing');
  await expect(page.getByRole('status')).toHaveText(PILL.framing);

  // «Apagar cámara»: back to the start screen with the camera and the worker released.
  expect((await resources(page)).workers).toEqual({ created: 1, active: 1 });
  await page.getByRole('button', { name: 'Apagar cámara' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');
  await expect(app(page)).toHaveAttribute('data-source', 'none');
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();
  await expect(page.locator('.tracking')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apagar cámara' })).toBeDisabled();
  const released = await resources(page);
  expect(released.workers).toEqual({ created: 1, active: 0 });
  expect(released.tracks).toEqual(['ended']);
  await shot(page, 'camera-4-stopped');
  expect(watch.problems).toEqual([]);
  // Only the MediaPipe INFO lines were filtered out of the console, and they are reported, not hidden.
  test.info().annotations.push({ type: 'mediapipe-info-lines-filtered', description: String(watch.ignored.length) });
});

test('[cámara falsa] five start/stop cycles release every track and every worker (stopping from «Apagar cámara» and from «Volver al inicio»)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const watch = watchProblems(page);
  await grantCamera(context);
  await spyResources(page);
  await visit(page);

  for (let cycle = 1; cycle <= 5; cycle++) {
    await startCameraAndWaitForFraming(page);
    await openDiagnostics(page);
    await pollDiagnostics(page, d => typeof d.inferenceMs === 'number' && d.inferenceMs > 0);
    expect((await resources(page)).workers.active, `workers while the camera of cycle ${cycle} runs`).toBe(1);
    await page.getByRole('button', { name: cycle % 2 === 1 ? 'Apagar cámara' : 'Volver al inicio' }).click();
    await expect(app(page)).toHaveAttribute('data-mode', 'idle');
    await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();
  }
  const state = await resources(page);
  expect(state.workers).toEqual({ created: 5, active: 0 });
  expect(state.tracks).toHaveLength(5);
  expect(state.tracks.every(readyState => readyState === 'ended')).toBe(true);
  expect(watch.problems).toEqual([]);
});

test('[cámara falsa + manos sintéticas] ?qa=camera-replay: tie-on (Y-01), two rounds (Y-02..Y-05), a hand out through the bottom with the vignette (Y-06, Y-07), real latency counters', async ({ page, context }) => {
  test.setTimeout(120_000);
  const watch = watchProblems(page);
  await grantCamera(context);
  await installEdgeProbe(page);
  await visit(page, QA_URL);

  // The page says it is synthetic: on the root and on screen.
  await expect(app(page)).toHaveAttribute('data-qa', 'camera-replay');
  await expect(page.locator('.qa-badge')).toHaveText('QA · manos sintéticas');
  await startCameraAndWaitForFraming(page);
  await shot(page, 'camera-replay-1-framing');

  // Y-01: the yoyo ties on after the hand has been steady for 400 ms and no later than a second, never before.
  const tethered = await waitForPhase(page, 'tethered', { timeout: 10_000 });
  await expect(page.getByRole('status')).toHaveText(PILL.tethered);
  await expect(page.locator('.tracking')).toHaveAttribute('data-quality', 'fresh');
  await shot(page, 'camera-replay-2-tethered');

  // Round one, the hand in view the whole time.
  const rolling = await waitForPhase(page, 'rolling', { from: tethered.index, timeout: 10_000 });
  await shot(page, 'camera-replay-3-rolling');
  const sleeping = await waitForPhase(page, 'sleeping', { from: rolling.index, timeout: 8_000 });
  await sleep(500);
  const sleeper1 = yoyoOnScreen(await shot(page, 'camera-replay-4-sleeping'));
  const returning = await waitForPhase(page, 'returning', { from: sleeping.index, timeout: 12_000 });
  await shot(page, 'camera-replay-5-returning');
  const caught = await waitForPhase(page, 'caught', { from: returning.index, timeout: 6_000 });
  const retethered = await waitForPhase(page, 'tethered', { from: caught.index, timeout: 3_000 });

  // Round two: while the yoyo sleeps the hand leaves through the bottom for about 0.6 s and comes back.
  const rolling2 = await waitForPhase(page, 'rolling', { from: retethered.index, timeout: 10_000 });
  const sleeping2 = await waitForPhase(page, 'sleeping', { from: rolling2.index, timeout: 8_000 });
  const edge = await waitForAttribute(page, 'data-edge', 'bottom', { from: sleeping2.index, timeout: 15_000 });
  await sleep(380);   // the vignette fades in over 0.25 s
  const edgeNow = await app(page).getAttribute('data-edge');
  const edgePixels = yoyoOnScreen(await shot(page, 'camera-replay-6-edge-bottom'));
  const handFound = await waitForAttribute(page, 'data-hand', 'present', { from: edge.index, timeout: 5_000 });
  await waitForAttribute(page, 'data-edge', 'none', { from: edge.index, timeout: 5_000 });
  await sleep(300);
  const recovered = yoyoOnScreen(await shot(page, 'camera-replay-7-recovered'));
  const returning2 = await waitForPhase(page, 'returning', { from: sleeping2.index, timeout: 12_000 });
  const caught2 = await waitForPhase(page, 'caught', { from: returning2.index, timeout: 6_000 });
  const finalTether = await waitForPhase(page, 'tethered', { from: caught2.index, timeout: 3_000 });
  await shot(page, 'camera-replay-8-caught-twice');
  const trace = await traceOf(page);
  const edges = await edgeSamples(page);

  // Y-11 parity: the same two rounds the pointer route and the demo walk, and the app's own trail says so too.
  expect(phasesOf(trace)).toEqual([...TWO_ROUNDS]);
  expect(await trailOf(page)).toEqual([...TWO_ROUNDS]);
  expect(isSubsequence(['permission-pending', 'loading', 'framing', 'playing'], valuesOf(trace, 'data-mode'))).toBe(true);

  // Y-01 in the browser. The session's hand appears 400 ms after the camera is ready and then holds still, so the tie-on
  // cannot come before 800 ms (400 ms of lead + the 400 ms the PRD asks the hand to be steady): a yoyo that ties on sooner
  // would be reacting to a hand that has not been steady. And it must come within the second the PRD allows after that
  // (a little slack for the camera frames that carry it: the fake device runs at 20 fps and MediaPipe takes ~25 ms a frame).
  // The time since the first frame the page shows the hand in is NOT the measure here: under the hook the frames arrive in
  // bursts stamped with the session's clock (the first inference is slow), so that wall-clock gap can be shorter than the
  // 400 ms of steadiness in the data's own time; it goes in the evidence file for what it is.
  const framingAt = timeOf(trace, 'data-mode', 'framing')!;
  const handAt = timeOf(trace, 'data-hand', 'present')!;
  const sinceFraming = tethered.t - framingAt;
  expect(sinceFraming).toBeGreaterThanOrEqual(780);
  expect(sinceFraming).toBeLessThanOrEqual(1_800);

  // Y-06 / Y-07: a single loss of the hand, a single edge, the bottom; the yoyo's state is kept all through; the person is told.
  expect(valuesOf(trace, 'data-hand')).toEqual(['present', 'lost', 'present']);
  expect(valuesOf(trace, 'data-edge')).toEqual(['bottom']);
  expect(edgeNow).toBe('bottom');
  expect(phasesOf(trace.slice(edge.index, handFound.index + 1))).toEqual([]);
  expect(isSubsequence(['stale', 'fresh'], valuesOf(trace, 'data-quality'))).toBe(true);
  expect(isSubsequence([PILL.tethered, PILL.handLost], valuesOf(trace, 'pill'))).toBe(true);
  expect(valuesOf(trace, 'tip')).toEqual([PILL.edge]);
  const shown = edges.filter(sample => sample.edge === 'bottom' && sample.tipVisible && sample.tip === PILL.edge && sample.opacity >= 0.99);
  expect(shown.length, 'frames with the vignette fully on and the tip visible').toBeGreaterThan(5);
  expect(edges.every(sample => sample.edge === 'bottom')).toBe(true);
  expect(edges.at(-1)!.t - edges[0].t).toBeLessThan(3_000);
  await expect(page.locator('.tip')).toBeHidden();

  // The yoyo was on screen at the sleep and again after the hand came back (no NaN pose, no teleport off screen). During the
  // exit itself it is not asserted: the hand, and the pivot with it, travelled down to the border, so the sleeper hangs
  // below the visible floor for that second (see the screenshot); the pixel count goes in the evidence file.
  for (const [name, pixels] of Object.entries({ sleeper1, recovered })) {
    expect(pixels.count, `yoyo pixels: ${name}`).toBeGreaterThan(1_000);
    expect(pixels.box!.maxY, `yoyo bottom: ${name}`).toBeLessThan(pixels.height * 0.93);
  }

  // After the session the camera goes on with no hands: the yoyo hangs where it was (it neither falls nor fires).
  await waitForAttribute(page, 'data-hand', 'lost', { from: finalTether.index, timeout: 15_000 });
  await expect(page.getByRole('status')).toHaveText(PILL.handLost);
  await expect(app(page)).toHaveAttribute('data-phase', 'tethered');
  await sleep(600);
  expect(yoyoOnScreen(await shot(page, 'camera-replay-9-hand-lost')).count).toBeGreaterThan(300);

  // The counters that come from the real camera: capture → arrival, inference, and the intent → render latency of each throw and tug.
  await openDiagnostics(page);
  const d = await pollDiagnostics(page, x => x.launches === 2 && x.tugs === 2 && x.catches === 2 && typeof x.captureToArrivalP50Ms === 'number');
  expect(num(d, 'captureToArrivalP50Ms')).toBeGreaterThan(0);
  expect(num(d, 'inferenceMs')).toBeGreaterThan(0);
  expect(num(d, 'latencySamples')).toBeGreaterThanOrEqual(4);
  expect(num(d, 'latencyP50Ms')).toBeGreaterThan(0);
  expect(d.autoReturns).toBe(0);
  expect(d.handLosses).toBeGreaterThanOrEqual(1);
  expect(d.queueDrops).toBe(0);
  await openAdvanced(page);
  await shot(page, 'camera-replay-10-diagnostics');

  saveJson('camera-replay', {
    kind: 'cámara falsa de Chrome + sesión de manos sintéticas (?qa=camera-replay): NO es webcam',
    msFromFramingToTether: Math.round(sinceFraming),
    msFromFirstHandSeenToTether: Math.round(tethered.t - handAt),
    phases: phasesOf(trace),
    exit: {
      edgeAfterSleepMs: Math.round(edge.t - sleeping2.t),
      edgeToHandFoundMs: Math.round(handFound.t - edge.t),
      vignetteFramesFullyOn: shown.length,
      edgeSpanMs: Math.round(edges.at(-1)!.t - edges[0].t),
    },
    yoyoPixels: { sleeper1, edgePixels, recovered },
    diagnostics: d,
  });
  expect(watch.problems).toEqual([]);
  test.info().annotations.push({ type: 'mediapipe-info-lines-filtered', description: String(watch.ignored.length) });
});
