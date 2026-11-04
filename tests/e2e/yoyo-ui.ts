/**
 * Helpers shared by the browser specs of the yoyó (`tests/e2e/yoyo-*.spec.ts`).
 *
 * Evidence labels (PRD_YOYO.md §8.1) the specs keep apart, and say so in their titles:
 *  - mouse / demo specs: synthetic input through the real page (a person-less pointer, a synthetic camera replay);
 *  - camera specs: Chrome's FAKE camera (`--use-fake-device-for-media-stream`): real permission flow, real
 *    MediaPipe worker, no hands. With `?qa=camera-replay` the hands in the frames are replaced by a synthetic session;
 *  - performance: headless Chrome, GPU as reported by the browser (recorded next to the numbers).
 * Nothing here is webcam or human evidence.
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { openSettings } from './ui';

export const ORIGIN = 'http://127.0.0.1:4173';
export const YOYO_URL = '/yoyo';
export const QA_URL = '/yoyo?qa=camera-replay';
export const SHOT_DIR = 'artifacts/qa/yoyo';

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** After the tie-on (`untethered` → `tethered`), one round of the game: throw, sleep, tug, catch, tied on again. */
export const ROUND = ['rolling', 'sleeping', 'returning', 'caught', 'tethered'] as const;
/** The phases of a session that ties on and plays `rounds` rounds, in order. */
export const phasesAfterRounds = (rounds: number): string[] => ['untethered', 'tethered', ...Array.from({ length: rounds }).flatMap(() => ROUND)];
/** Two rounds from a fresh session: what the pointer route, the demo and the camera replay must all walk (Y-11 parity). */
export const TWO_ROUNDS: readonly string[] = phasesAfterRounds(2);

/** Writes evidence next to the screenshots: `artifacts/qa/yoyo/e2e-<name>.json`. */
export function saveJson(name: string, data: unknown): void {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(`${SHOT_DIR}/e2e-${name}.json`, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Screenshots, problems
// ---------------------------------------------------------------------------------------------

/** `artifacts/qa/yoyo/e2e-<name>.png`; returns the PNG too, for `yoyoOnScreen`. */
export async function shot(page: Page, name: string): Promise<Buffer> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: `${SHOT_DIR}/e2e-${name}.png` });
}

/** A decoded 8-bit RGB/RGBA PNG. */
export interface Raster { width: number; height: number; channels: 3 | 4; data: Uint8Array }

/**
 * Decodes the PNGs Chrome writes (8-bit RGB or RGBA, no interlacing, any of the five scanline filters). Enough for
 * counting pixels in a screenshot without a dependency.
 */
export function decodePng(png: Buffer): Raster {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let offset = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error(`Unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, data };
}

export interface YoyoPixels {
  /** Pixels that look like the yoyo's (default, red) body. */
  count: number;
  /** Their bounding box in screenshot pixels; null when there are none. */
  box: { minX: number; minY: number; maxX: number; maxY: number } | null;
  width: number;
  height: number;
}

/** The yoyo's default body colour («Rojo»). */
export const DEFAULT_YOYO_COLOR = '#e5383b';

/**
 * Finds the yoyo in a screenshot by its body colour: pixels bright enough whose chromaticity (the colour with the
 * brightness divided out) is close to the body colour's, so the shaded and the lit parts of the body count and the amber
 * ring, the cream string, the cool hand, the orange edge vignette and the dark backdrop do not. The bottom strip with the
 * colour swatches is left out. This is evidence that the yoyo is ON SCREEN at that moment (the page once showed the
 * sleeper under the floor), not a rendering test.
 */
export function yoyoOnScreen(png: Buffer, color: string = DEFAULT_YOYO_COLOR): YoyoPixels {
  const { width, height, channels, data } = decodePng(png);
  const target = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const top = Math.max(...target);
  const wanted = target.map(c => c / top);
  const limit = Math.floor(height * 0.93);
  let count = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < limit; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const peak = Math.max(data[i], data[i + 1], data[i + 2]);
      if (peak < 90) continue;
      const distance = Math.abs(data[i] / peak - wanted[0]) + Math.abs(data[i + 1] / peak - wanted[1]) + Math.abs(data[i + 2] / peak - wanted[2]);
      if (distance > 0.35) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, box: count > 0 ? { minX, minY, maxX, maxY } : null, width, height };
}

/**
 * What MediaPipe's WASM prints through console.error and is NOT a failure: glog-style `INFO:` lines, i.e.
 * «INFO: Created TensorFlow Lite XNNPACK delegate for CPU.». Matched explicitly, counted and reported, never
 * silently dropped; anything else on the console error channel is a problem.
 */
export const MEDIAPIPE_NOISE: readonly RegExp[] = [
  /^INFO: Created TensorFlow Lite XNNPACK delegate for CPU\.?$/,
  /^INFO: /,
];
export const isMediaPipeNoise = (text: string): boolean => MEDIAPIPE_NOISE.some(pattern => pattern.test(text.trim()));

export interface Problems {
  /** console.error (minus MediaPipe's INFO lines), uncaught page errors and HTTP >= 400 responses. */
  problems: string[];
  /** The MediaPipe INFO/XNNPACK lines that were filtered out, kept so the report can say how many there were. */
  ignored: string[];
}

/** Starts collecting what must stay empty on a healthy page. Call before `goto`. */
export function watchProblems(page: Page): Problems {
  const out: Problems = { problems: [], ignored: [] };
  page.on('pageerror', error => out.problems.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (isMediaPipeNoise(text)) out.ignored.push(text);
    else out.problems.push(`console.error: ${text}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) out.problems.push(`HTTP ${response.status()} ${response.url()}`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The engine's root attributes: a trace of every change, from inside the page
// ---------------------------------------------------------------------------------------------

export interface TraceEntry {
  /** performance.now() of the page when the change was observed (the same clock the engine uses). */
  t: number;
  /**
   * `data-mode`, `data-source`, `data-phase`, `data-hand`, `data-edge`, `data-quality` (the tracking dot), `pill` (the
   * status pill's text, '' when hidden), `tip` (the edge tip's text, '' when hidden), `event` (a pointer, focus or visibility
   * event on the window, by type) or `mark` (a test-side marker).
   */
  name: string;
  value: string;
}

declare global {
  interface Window {
    __yoyoTrace?: TraceEntry[];
  }
}

/**
 * Records every change of the engine's `data-*` attributes, of the pill and of the edge tip with the page's own clock
 * (MutationObservers on the document: they exist before the app does). `data-trail` is the app's contract and is
 * asserted too, but `caught` lasts ~0.22 s and the trail only keeps 16 entries, so timing and the full sequence come
 * from here. Call before `goto`.
 */
export async function installTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trace: Array<{ t: number; name: string; value: string }> = [];
    window.__yoyoTrace = trace;
    const watched = ['data-mode', 'data-source', 'data-phase', 'data-hand', 'data-edge', 'data-quality'];
    new MutationObserver(records => {
      const t = performance.now();
      records.forEach((record, i) => {
        const name = record.attributeName;
        if (record.type !== 'attributes' || name === null) return;
        // The value this mutation wrote is the old value of the next mutation of the same attribute, if there is one in
        // the batch (several changes in one task would otherwise all read as the last value).
        let value: string | null = (record.target as Element).getAttribute(name);
        for (let j = i + 1; j < records.length; j++) {
          if (records[j].target === record.target && records[j].attributeName === name) { value = records[j].oldValue; break; }
        }
        trace.push({ t, name, value: value ?? '' });
      });
    }).observe(document, { attributes: true, subtree: true, attributeOldValue: true, attributeFilter: watched });

    // What could end a press behind the page's back: the pointer going up or being cancelled or captured away, the window losing
    // focus (the engine lets go of a held button on blur) and the tab being hidden. They explain a gesture that is not read.
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'focus', 'visibilitychange']) {
      window.addEventListener(type, () => { trace.push({ t: performance.now(), name: 'event', value: type }); }, true);
    }

    const texts: Array<[string, string]> = [['pill', '.pill'], ['tip', '.tip']];
    const last: Record<string, string> = { pill: '', tip: '' };
    new MutationObserver(() => {
      for (const [name, selector] of texts) {
        const element = document.querySelector<HTMLElement>(selector);
        const value = element === null || element.hidden ? '' : (element.textContent ?? '');
        if (value !== last[name]) {
          last[name] = value;
          trace.push({ t: performance.now(), name, value });
        }
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

/** The usual start of a spec: trace installed, the pointer viewport, the page loaded. */
export async function visit(page: Page, url: string = YOYO_URL): Promise<void> {
  await installTrace(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(url);
}

export async function traceOf(page: Page): Promise<TraceEntry[]> {
  return page.evaluate(() => window.__yoyoTrace ?? []);
}

/** Puts a named marker in the trace, on the page's clock. */
export async function mark(page: Page, label: string): Promise<number> {
  return page.evaluate((text) => {
    const t = performance.now();
    window.__yoyoTrace?.push({ t, name: 'mark', value: text });
    return t;
  }, label);
}

/** The values of one attribute over time, collapsing repeats; `none` and empty values are skipped. */
export function valuesOf(trace: readonly TraceEntry[], name: string, from = 0): string[] {
  const out: string[] = [];
  for (let i = from; i < trace.length; i++) {
    const e = trace[i];
    if (e.name !== name || e.value === 'none' || e.value === '') continue;
    if (out[out.length - 1] !== e.value) out.push(e.value);
  }
  return out;
}

export const phasesOf = (trace: readonly TraceEntry[], from = 0): string[] => valuesOf(trace, 'data-phase', from);

/** When (page clock) the attribute first took `value` at or after trace index `from`; null if it did not. */
export function timeOf(trace: readonly TraceEntry[], name: string, value: string, from = 0): number | null {
  for (let i = from; i < trace.length; i++) if (trace[i].name === name && trace[i].value === value) return trace[i].t;
  return null;
}

/**
 * Waits (in the page, polling every 40 ms) until `data-phase` takes `phase` at or after trace index `from`; resolves
 * with the trace entry's time and index. Use `(await traceOf(page)).length` before the action to get `from`.
 */
export async function waitForPhase(page: Page, phase: string, options: { from?: number; timeout?: number } = {}): Promise<{ index: number; t: number }> {
  const handle = await page.waitForFunction(
    ({ phase: wanted, from }) => {
      const trace = window.__yoyoTrace ?? [];
      for (let i = from; i < trace.length; i++) if (trace[i].name === 'data-phase' && trace[i].value === wanted) return { index: i, t: trace[i].t };
      return null;
    },
    { phase, from: options.from ?? 0 },
    { timeout: options.timeout ?? 15_000, polling: 40 },
  );
  return (await handle.jsonValue()) as { index: number; t: number };
}

/** Same for any attribute value (`data-edge` → `bottom`, `data-mode` → `framing`). */
export async function waitForAttribute(page: Page, name: string, value: string, options: { from?: number; timeout?: number } = {}): Promise<{ index: number; t: number }> {
  const handle = await page.waitForFunction(
    ({ name: attribute, value: wanted, from }) => {
      const trace = window.__yoyoTrace ?? [];
      for (let i = from; i < trace.length; i++) if (trace[i].name === attribute && trace[i].value === wanted) return { index: i, t: trace[i].t };
      return null;
    },
    { name, value, from: options.from ?? 0 },
    { timeout: options.timeout ?? 15_000, polling: 40 },
  );
  return (await handle.jsonValue()) as { index: number; t: number };
}

export const app = (page: Page): Locator => page.locator('.app');

/** `data-trail` as an array (the engine's own record of the last 16 phase changes). */
export async function trailOf(page: Page): Promise<string[]> {
  const raw = (await app(page).getAttribute('data-trail')) ?? '';
  return raw.split(' ').filter(Boolean);
}

/** True when `expected` appears in `actual` in that order (other entries may sit in between). */
export function isSubsequence(expected: readonly string[], actual: readonly string[]): boolean {
  let at = 0;
  for (const item of actual) if (at < expected.length && item === expected[at]) at++;
  return at === expected.length;
}

export interface EdgeSample {
  t: number;
  edge: string;
  /** Computed opacity of the vignette (the CSS fades it in over 0.25 s). */
  opacity: number;
  tip: string;
  tipVisible: boolean;
}

declare global {
  interface Window {
    __yoyoEdge?: EdgeSample[];
  }
}

/**
 * Samples, on every animation frame while the root says the hand touches a border (`data-edge` ≠ none), what the person
 * sees of it: the vignette's computed opacity and the tip's text and visibility. The edge lasts about a second, shorter
 * than the polling of a locator assertion is reliable for. Call before `goto`; not for the performance specs.
 */
export async function installEdgeProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const samples: Array<{ t: number; edge: string; opacity: number; tip: string; tipVisible: boolean }> = [];
    window.__yoyoEdge = samples;
    const loop = () => {
      const root = document.querySelector<HTMLElement>('.app');
      const edge = root?.dataset.edge ?? 'none';
      if (root !== null && edge !== 'none') {
        const vignette = root.querySelector('.vignette');
        const tip = root.querySelector<HTMLElement>('.tip');
        samples.push({
          t: performance.now(),
          edge,
          opacity: vignette === null ? -1 : Number(getComputedStyle(vignette).opacity),
          tip: tip?.textContent ?? '',
          tipVisible: tip !== null && !tip.hidden && getComputedStyle(tip).display !== 'none',
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

export async function edgeSamples(page: Page): Promise<EdgeSample[]> {
  return page.evaluate(() => window.__yoyoEdge ?? []);
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

export type Diag = Record<string, number | string | null>;

/** «Ajustes» → «Diagnóstico»: the panel is open (the settings column is on the left, the drawer on the right). */
export async function openDiagnostics(page: Page): Promise<void> {
  await openSettings(page);
  const toggle = page.getByRole('button', { name: 'Diagnóstico' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.locator('#diagnostics')).toBeVisible();
}

export async function openAdvanced(page: Page): Promise<void> {
  await openSettings(page);
  const toggle = page.getByRole('button', { name: 'Avanzado' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByRole('complementary', { name: 'Ajustes avanzados' })).toBeVisible();
}

/** The `<output id="diagnostics">` JSON (flat, one key per line), parsed. The panel refreshes ~3 times a second. */
export async function diagnostics(page: Page): Promise<Diag> {
  const raw = await page.locator('#diagnostics').textContent();
  return JSON.parse(raw ?? '{}') as Diag;
}

/** Waits for a fresh panel text (it only changes when a number does) by polling until `predicate` holds. */
export async function pollDiagnostics(page: Page, predicate: (d: Diag) => boolean, timeout = 15_000): Promise<Diag> {
  let last: Diag = {};
  await expect.poll(async () => { last = await diagnostics(page); return predicate(last); }, { timeout, intervals: [150, 250, 400] }).toBe(true);
  return last;
}

export const num = (d: Diag, key: string): number => {
  const value = d[key];
  if (typeof value !== 'number') throw new Error(`diagnostics.${key} is ${JSON.stringify(value)}, not a number`);
  return value;
};

/** The GPU the browser reports through a throwaway canvas (WEBGL_debug_renderer_info), for the QA report. */
export async function webglRenderer(page: Page): Promise<{ vendor: string; renderer: string; version: string; webgl2: boolean }> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) return { vendor: 'none', renderer: 'none', version: 'none', webgl2: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const info = {
      vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      version: String(gl.getParameter(gl.VERSION)),
      webgl2: true,
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  });
}

// ---------------------------------------------------------------------------------------------
// The pointer route: press, hold, throw, tug
// ---------------------------------------------------------------------------------------------

export interface Point { x: number; y: number }

/** Viewport the pointer specs use: wide enough for the left column and the right drawer to leave the middle free. */
export const VIEWPORT = { width: 1440, height: 900 } as const;
/** Where the button goes down: the middle of the stage, clear of the left column (x < 260) and the right drawer (x > 1040). */
export const PRESS_AT: Point = { x: 700, y: 150 };

/**
 * `steps` equal mouse moves from `from` to `to`, spread over `ms` on an absolute schedule (the wait before each is what is
 * left of its slot, so one slow call does not stretch the whole gesture). Playwright's `mouse.move` itself takes about one
 * browser frame (16.6 ms) per call here, so `steps` beyond `ms / 17` only make the gesture last longer. Returns the real
 * duration, ms.
 */
export async function sweep(page: Page, from: Point, to: Point, ms: number, steps: number): Promise<number> {
  const start = performance.now();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    const wait = start + (ms * i) / steps - performance.now();
    if (wait > 0) await sleep(wait);
  }
  return performance.now() - start;
}

/**
 * Launch: 300 px down in 6 events (~100 ms) with the button held, 50 px per event.
 *
 * Why those numbers: the page samples the pointer on a 30 Hz grid with sample-and-hold and wants ≥ 1.2 canvas heights per
 * second on two consecutive samples, i.e. ≥ 36 px per 33 ms interval at 900 px of height. Playwright cannot send mouse
 * events faster than the browser's frame (measured here: one `mouse.move` per 16.6 ms, p95 19 ms, max 22 ms), so a grid
 * interval holds one to three events and a gesture made of 35 px steps is a staircase whose short steps sit just under
 * the threshold: about one launch in twenty was not read, whatever the frame phase (the same events replayed offline
 * through the driver and the classifier missed it too). With 50 px per event every grid interval that holds an event
 * (all of them: the largest gap is under 33 ms) moves ≥ 50 px. A real mouse reports far more often than this harness.
 */
export const LAUNCH = { dy: 300, ms: 100, steps: 6 } as const;
/** Tug: 100 px up in 5 events (~70 ms): the page needs ≥ 70 px within ≤ 60 ms from a hand still for more than 300 ms. */
export const TUG = { dy: -100, ms: 70, steps: 5 } as const;

export async function launchDrag(page: Page, from: Point): Promise<Point> {
  await sweep(page, from, { x: from.x, y: from.y + LAUNCH.dy }, LAUNCH.ms, LAUNCH.steps);
  return { x: from.x, y: from.y + LAUNCH.dy };
}

export async function tugDrag(page: Page, from: Point): Promise<Point> {
  await sweep(page, from, { x: from.x, y: from.y + TUG.dy }, TUG.ms, TUG.steps);
  return { x: from.x, y: from.y + TUG.dy };
}

/** A slow, deliberate move (well under the launch speed and the tug's): brings the hand back up between rounds. */
export async function glide(page: Page, from: Point, to: Point, ms = 700): Promise<void> {
  await sweep(page, from, to, ms, Math.max(8, Math.round(ms / 35)));
}

/** waitForPhase that answers null instead of throwing when the phase does not come. */
export async function phaseWithin(page: Page, phase: string, from: number, timeout: number): Promise<{ index: number; t: number } | null> {
  try {
    return await waitForPhase(page, phase, { from, timeout });
  } catch {
    return null;
  }
}

export interface LaunchResult {
  /** Where the cursor is after the launch gesture that was read. */
  position: Point;
  rolling: { index: number; t: number };
  /** Page clock: the read gesture ended. */
  endedAt: number;
  /** Gestures made before the page read one (1 = read at once). */
  attempts: number;
  /** Times the button had to be pressed again because the page no longer had the hand (0 in a normal run). */
  repressed: number;
}

/**
 * Throws until the page reads it (`rolling`), from a hand that has been still for `settleMs`. A gesture that is not
 * read is not repeated from where it ended (that would walk the cursor off the screen): the hand glides back to `from`,
 * rests, and throws again, as a person would. If the page has lost the hand under the press (`data-hand` is not
 * `present`: the engine lets go of a held button when the window blurs or the tab hides, and the pill then asks for the
 * button again), the harness lets go and presses again, as a person would, and counts it. The attempts and the
 * re-presses are returned so a spec can assert on them.
 */
export async function launchUntilRolling(page: Page, from: Point, settleMs = 450, maxAttempts = 3): Promise<LaunchResult> {
  let repressed = 0;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    await sleep(settleMs);
    const before = (await traceOf(page)).length;
    const position = await launchDrag(page, from);
    const endedAt = await mark(page, 'launch-gesture-end');
    const rolling = await phaseWithin(page, 'rolling', before, 1_500);
    if (rolling !== null) return { position, rolling, endedAt, attempts, repressed };
    if ((await app(page).getAttribute('data-hand')) !== 'present') {
      await page.mouse.up();
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      repressed++;
      await expect(app(page)).toHaveAttribute('data-hand', 'present', { timeout: 3_000 });
    } else {
      await glide(page, position, from, 400);
    }
  }
  throw new Error(`The launch was not read in ${maxAttempts} attempts (${repressed} re-presses). ${await describeState(page)}`);
}

/** One line on where the page is, for the error of a gesture that was not read: attributes, focus, visibility and the last events. */
export async function describeState(page: Page): Promise<string> {
  const here = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.app');
    return { mode: root?.dataset.mode, source: root?.dataset.source, phase: root?.dataset.phase, hand: root?.dataset.hand, focus: document.hasFocus(), visibility: document.visibilityState };
  });
  const tail = (await traceOf(page)).filter(e => e.name !== 'pill' && e.name !== 'tip').slice(-14).map(e => `${e.t.toFixed(0)} ${e.name}=${e.value}`);
  return `State: ${JSON.stringify(here)}. Last trace entries: ${tail.join(' | ')}`;
}

export interface RoundResult {
  /** Where the cursor is when the round ends. */
  at: Point;
  /** Page clock: the launch gesture ended / the last tug gesture ended / each phase first seen in the round. */
  launchEndedAt: number;
  tugEndedAt: number;
  phaseAt: Record<string, number>;
  /** Gestures made before the page read them (1 = read at once). */
  launchAttempts: number;
  tugAttempts: number;
  /** Times the button was pressed again because the page had lost the hand (0 in a normal run). */
  launchRepresses: number;
}

export interface RoundOptions {
  settleMs?: number;
  calmMs?: number;
  /** Also wait for `exhausted` before the tug (only with auto-return off). */
  waitFor?: 'sleeping' | 'exhausted';
  /** Called, and awaited, right after each phase of the round is first seen: the place for a screenshot. */
  onPhase?: (phase: 'rolling' | 'sleeping' | 'exhausted' | 'returning' | 'caught') => Promise<void>;
}

/**
 * One round of the game by pointer, starting from a tied-on yoyo (`tethered`) with the button held at `from` and the
 * hand still: throw, wait for the sleeper, a calm hand, tug, wait for the catch and the yoyo tied on again, then glide
 * back up to `from` (the drag down is longer than the tug up, and the cursor would walk off the screen).
 *
 * A gesture the page does not read is repeated after a still pause, as a person would; the attempts are returned so a
 * spec can assert that the first try is the usual outcome.
 */
export async function playRound(page: Page, from: Point, options: RoundOptions = {}): Promise<RoundResult> {
  const settleMs = options.settleMs ?? 450;
  const calmMs = options.calmMs ?? 700;
  const phaseAt: Record<string, number> = {};
  let position = from;
  let launchEndedAt = 0;
  let tugEndedAt = 0;

  const launch = await launchUntilRolling(page, from, settleMs);
  const rolling = launch.rolling;
  position = launch.position;
  launchEndedAt = launch.endedAt;
  phaseAt.rolling = rolling.t;
  await options.onPhase?.('rolling');
  phaseAt.sleeping = (await waitForPhase(page, 'sleeping', { from: rolling.index, timeout: 6_000 })).t;
  await options.onPhase?.('sleeping');
  if (options.waitFor === 'exhausted') {
    phaseAt.exhausted = (await waitForPhase(page, 'exhausted', { from: rolling.index, timeout: 15_000 })).t;
    await options.onPhase?.('exhausted');
  }

  let tugAttempts = 0;
  let returning: { index: number; t: number } | null = null;
  while (returning === null && tugAttempts < 3) {
    tugAttempts++;
    await sleep(calmMs);
    const before = (await traceOf(page)).length;
    position = await tugDrag(page, position);
    tugEndedAt = await mark(page, 'tug-gesture-end');
    returning = await phaseWithin(page, 'returning', before, 1_500);
  }
  if (returning === null) throw new Error(`The tug was not read in ${tugAttempts} attempts. ${await describeState(page)}`);
  phaseAt.returning = returning.t;
  await options.onPhase?.('returning');
  const caught = await waitForPhase(page, 'caught', { from: returning.index, timeout: 6_000 });
  phaseAt.caught = caught.t;
  await options.onPhase?.('caught');
  phaseAt.tethered = (await waitForPhase(page, 'tethered', { from: caught.index, timeout: 3_000 })).t;

  await glide(page, position, from, 600);
  return { at: from, launchEndedAt, tugEndedAt, phaseAt, launchAttempts: launch.attempts, tugAttempts, launchRepresses: launch.repressed };
}

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

export async function grantCamera(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['camera']);
}

/** Clicks «Comenzar con cámara» and waits for the framing screen (permission → loading → framing). */
export async function startCameraAndWaitForFraming(page: Page, timeout = 45_000): Promise<void> {
  await page.getByRole('button', { name: 'Comenzar con cámara' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'framing', { timeout });
}

// ---------------------------------------------------------------------------------------------
// Network and storage, for the privacy spec
// ---------------------------------------------------------------------------------------------

export interface NetLog {
  requests: Array<{ method: string; url: string; resourceType: string; hasBody: boolean }>;
  websockets: string[];
}

/** Records every request the context makes (workers included) and every websocket. Call before `goto`. */
export function recordNetwork(context: BrowserContext): NetLog {
  const log: NetLog = { requests: [], websockets: [] };
  context.on('request', request => log.requests.push({
    method: request.method(), url: request.url(), resourceType: request.resourceType(), hasBody: request.postData() !== null,
  }));
  context.on('page', page => page.on('websocket', socket => log.websockets.push(socket.url())));
  return log;
}

/** Counts navigator.sendBeacon calls (it would show up as a POST too; this says so by name). Call before `goto`. */
export async function spyBeacons(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as Window & { __beacons?: number };
    w.__beacons = 0;
    const original = navigator.sendBeacon?.bind(navigator);
    navigator.sendBeacon = (...args: Parameters<Navigator['sendBeacon']>) => { w.__beacons = (w.__beacons ?? 0) + 1; return original ? original(...args) : false; };
  });
}

export async function beaconCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __beacons?: number }).__beacons ?? 0);
}

export interface StorageState {
  localStorage: number;
  sessionStorage: number;
  indexedDB: string[];
  cookie: string;
  cacheStorage: string[];
  serviceWorkers: number;
}

export async function storageState(page: Page): Promise<StorageState> {
  return page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).map(db => String(db.name)),
    cookie: document.cookie,
    cacheStorage: await caches.keys(),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
}
