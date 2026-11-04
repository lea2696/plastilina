/**
 * Visual QA and cost of the yoyó renderer. SYNTHETIC input and GPU headless: hand-written snapshots
 * (tests/visual/yoyo-render.html), no runtime, no camera, no person. It says how the renderer looks and
 * behaves on the GPU headless Chrome exposes (the renderer string is printed; on a laptop like this one it is
 * a real, fast GPU, not the integrated one of a low-end target) and what render() costs.
 *
 * Writes artifacts/qa/yoyo/render-<state>.png and artifacts/qa/yoyo/render-benchmark.json.
 * Exits 1 on a console error or warning, a page error, a missing WebGL2 context, a failed behaviour check
 * (cues, context loss, lifecycle, resource growth) or a blown render-cost budget.
 *
 * Flags for iterating: `--only=sleeping,cues` runs just those shots/checks, `--no-bench` skips the costs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'artifacts/qa/yoyo');

/** PRD §7: render ≤ 8 ms at 60 Hz. The CPU part has to fit well inside it; with the GPU it must fit all of it. */
const CPU_BUDGET_P95_MS = 4;
const RENDER_BUDGET_P95_MS = 8;
/** Draw calls must stay far below 40 (PRD budget: low draw-call count). */
const DRAW_CALL_BUDGET = 40;
/** 20 000 frames must not retain more than this much JS heap: a leak would show as megabytes. */
const SOAK_HEAP_BUDGET_BYTES = 2 * 1024 * 1024;
/** The frame after a context loss and restore must be the frame before it, to within rounding of the GPU. */
const CONTEXT_MEAN_DIFF_BUDGET = 0.5;
/**
 * A marker drawn at a world point must land within this many CSS pixels of where visibleWorld() puts that
 * point. The marker floats 3 mm in front of the play plane, which alone shifts it by up to ~0.5 px at the
 * edge of the frame; the rest is the width of a pixel.
 */
const MAPPING_ERROR_BUDGET_PX = 1.5;

interface Shot {
  file: string;
  state: string;
  width: number;
  height: number;
  /** Device pixel ratio the page runs at (the renderer caps it at 2). */
  dpr: number;
  query?: string;
  /** Screenshot this element instead of the page (the fixture's composed sheets). */
  element?: string;
  /** Crop to a region around a world point, in world metres (half sizes), for a close look at a detail. */
  zoom?: { x: number; y: number; halfWidth: number; halfHeight: number };
}

const LANDSCAPE = { width: 1280, height: 800, dpr: 1 };
/** The visible world is fixed, so a bigger canvas is the only way to zoom: 3× the pixels, then crop. */
const CLOSEUP = { width: 3840, height: 2400, dpr: 1 };
const YOYO_CLOSEUP = { x: 0.0325, y: 0.2, halfWidth: 0.1, halfHeight: 0.0625 };

const SHOTS: Shot[] = [
  { file: 'tethered', state: 'tethered', ...LANDSCAPE },
  { file: 'tethered-flash', state: 'tethered-flash', ...LANDSCAPE },
  { file: 'rolling', state: 'rolling', ...LANDSCAPE },
  { file: 'sleeping', state: 'sleeping', ...LANDSCAPE },
  { file: 'slack', state: 'slack', ...LANDSCAPE },
  { file: 'returning', state: 'returning', ...LANDSCAPE },
  { file: 'mouse', state: 'mouse', ...LANDSCAPE },
  { file: 'mouse-tethered', state: 'mouse-tethered', ...LANDSCAPE },
  { file: 'guide', state: 'guide', ...LANDSCAPE },
  { file: 'exhausted', state: 'exhausted', ...LANDSCAPE },
  { file: 'paused', state: 'paused', ...LANDSCAPE },
  { file: 'hand-lost', state: 'hand-lost', ...LANDSCAPE },
  { file: 'edge', state: 'edge', ...LANDSCAPE },
  { file: 'near-floor', state: 'near-floor', ...LANDSCAPE },
  { file: 'portrait', state: 'sleeping', width: 390, height: 844, dpr: 2 },
  // Close-ups show the material and the face smear, not the on-screen size.
  { file: 'closeup-sleeping', state: 'sleeping', ...CLOSEUP, zoom: YOYO_CLOSEUP },
  { file: 'closeup-mid-spin', state: 'mid-spin', ...CLOSEUP, zoom: YOYO_CLOSEUP },
  { file: 'closeup-slow-spin', state: 'slow-spin', ...CLOSEUP, zoom: YOYO_CLOSEUP },
  { file: 'closeup-tethered', state: 'tethered', ...CLOSEUP, zoom: { x: 0, y: 0.82, halfWidth: 0.16, halfHeight: 0.1 } },
  // Every selectable colour, slow spin on top and fast spin below.
  { file: 'colors', state: 'sleeping', ...CLOSEUP, query: 'sheet=colors', element: '#sheet' },
  // One scripted throw as a strip of frames, around the moments the cues act (1× pixel ratio, real size).
  { file: 'sequence', state: 'sleeping', width: 1920, height: 1200, dpr: 1, query: 'sheet=sequence', element: '#sheet' },
  // Created, disposed and created again on one canvas (React StrictMode), then drawn: must equal render-sleeping.
  { file: 'lifecycle', state: 'lifecycle', ...LANDSCAPE },
];

interface CueFrame { t: number; event: boolean; liveY: number; drawnY: number; drawnX: number; camX: number; camY: number }
interface Summary { n: number; p50: number; p95: number; p99: number; max: number; mean: number }
interface Bench {
  mode: string;
  cpuMs: Summary;
  frameIntervalMs: Summary | null;
  stats: { drawCalls: number; triangles: number; geometries: number; textures: number };
  pixelRatio: number;
}
interface Soak {
  frames: number;
  wallMs: number;
  meanCpuMs: number;
  before: { counts: Record<string, number | null>; heap: number | null };
  after: { counts: Record<string, number | null>; heap: number | null };
  heapGrowthBytes: number | null;
}
interface ContextResult {
  error?: string;
  lostFired: number;
  threwWhileLost: boolean;
  meanAbsDiff: number;
  maxDiff: number;
  drawCalls: number;
}

interface MappingPoint { u: number; v: number; expected: [number, number]; found: [number, number] | null; pixels: number; errorPx: number | null }
interface MappingResult { rect: { left: number; right: number; bottom: number; top: number }; viewport: [number, number]; ratio: number; results: MappingPoint[] }
interface QualityStep { label: string; ratio: number; bufferWidth: number; bufferHeight: number; cssWidth: number; cssHeight: number }
interface ResizeResult { css: [number, number]; buffer: [number, number]; ratio: number; rect: { left: number; right: number; bottom: number; top: number } }

interface ProgramsResult { afterConstruction: number; afterEveryState: number; seen: Array<[string, number]>; constructMs: number; idleFramesMs: number[]; firstFramesMs: number[] }

interface Qa {
  ready: boolean;
  programs?: ProgramsResult;
  mapping?: MappingResult;
  quality?: QualityStep[];
  error?: string;
  rendererName?: string;
  crossOriginIsolated?: boolean;
  stats?: { drawCalls: number; triangles: number };
  bench?: Bench;
  soak?: Soak;
  context?: ContextResult;
  cues?: Record<'snap' | 'snapReduced' | 'catch' | 'catchReduced', CueFrame[]>;
  toScreen?: (x: number, y: number) => [number, number];
}

declare global {
  interface Window { qa?: Qa; afterResize?: () => Promise<ResizeResult> }
}

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
const skipBench = process.argv.includes('--no-bench');
const wants = (name: string) => only === null || only.has(name);

const problems: string[] = [];
let rendererName = 'unknown';

const fmt = (n: number) => n.toFixed(3);
const mm = (m: number) => `${(m * 1000).toFixed(2)} mm`;

function watch(page: Page, label: string): void {
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' || type === 'warning') problems.push(`[${label}] console.${type}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`[${label}] page error: ${error.message}`));
}

interface OpenOptions { state?: string; width: number; height: number; dpr: number; query?: string; bench?: string }

const megapixels = (width: number, height: number, ratio: number) => (width * ratio * height * ratio) / 1e6;

async function openFixture(browser: Browser, base: string, options: OpenOptions, label: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: options.dpr });
  const page = await context.newPage();
  watch(page, label);
  const query = [options.state ? `state=${options.state}` : '', options.bench ? `bench=${options.bench}` : '', options.query ?? ''].filter(Boolean).join('&');
  await page.goto(`${base}/tests/visual/yoyo-render.html?${query}`);
  await page.waitForFunction(() => window.qa?.ready === true, undefined, { timeout: 120_000 });
  const error = await page.evaluate(() => window.qa?.error);
  if (error) throw new Error(`fixture failed: ${error}`);
  const name = await page.evaluate(() => window.qa?.rendererName);
  if (name) rendererName = name;
  return page;
}

/**
 * Checks, on what the real renderer drew at 240 Hz, the render-only cues of PRD §6: snap overshoot ≤ 8 mm
 * that springs back within ~100 ms, hit-stop that holds the pose ~40 ms and then rejoins the live pose with
 * no jump, camera shake ≤ 4 mm gone in ~150 ms, and all of it off under prefers-reduced-motion.
 */
function checkCues(cues: NonNullable<Qa['cues']>): { lines: string[]; failures: string[] } {
  const lines: string[] = [];
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(`cues: ${message}`); };
  const camera = (frames: CueFrame[]) => {
    const base = frames[0];
    let max = 0;
    let lastActive = -Infinity;
    for (const f of frames) {
      const d = Math.hypot(f.camX - base.camX, f.camY - base.camY);
      if (d > 1e-9) lastActive = f.t;
      max = Math.max(max, d);
    }
    return { max, lastActive };
  };
  const maxStep = (frames: CueFrame[]) => {
    let max = 0;
    for (let i = 1; i < frames.length; i++) {
      max = Math.max(max, Math.hypot(frames[i].drawnX - frames[i - 1].drawnX, frames[i].drawnY - frames[i - 1].drawnY));
    }
    return max;
  };

  // Snap on a taut string: the yoyo is pushed along it, held while frozen, then springs back.
  const snap = cues.snap;
  const push = snap.map((f) => f.liveY - f.drawnY);
  const maxPush = Math.max(...push);
  const lastPush = snap.reduce((t, f, i) => (push[i] > 1e-7 ? f.t : t), -Infinity);
  const snapCam = camera(snap);
  lines.push(`snap:   overshoot max ${mm(maxPush)} (limit 8), back on the live pose by ${lastPush.toFixed(0)} ms, max step ${mm(maxStep(snap))} per 4.2 ms, camera shake max ${mm(snapCam.max)} (limit 4), over by ${snapCam.lastActive.toFixed(0)} ms`);
  check(maxPush > 0.002 && maxPush <= 0.008 + 1e-6, `snap overshoot ${mm(maxPush)} outside (2, 8] mm`);
  check(Math.min(...push) >= -1e-9, 'snap shortened the string (drawn yoyo above the live pose)');
  check(lastPush <= 105, `snap overshoot lasted until ${lastPush.toFixed(0)} ms (more than ~100)`);
  check(maxStep(snap) <= 0.006, `snap overshoot stepped ${mm(maxStep(snap))} in one 240 Hz frame`);
  check(snapCam.max <= 0.004 + 1e-9 && snapCam.max > 0.0005, `camera shake ${mm(snapCam.max)} outside (0.5, 4] mm`);
  check(snapCam.lastActive <= 152, `camera shake lasted until ${snapCam.lastActive.toFixed(0)} ms (more than ~150)`);

  // Catch on a live pose that keeps moving: the pose is held 40 ms and then rejoins it without a jump.
  const catchFrames = cues.catch;
  // Times are measured from the frame that carried the event: the pose frozen is that frame's pose.
  const reference = catchFrames.find((f) => f.event)!;
  const since = (f: CueFrame) => f.t - reference.t;
  const frozen = catchFrames.filter((f) => since(f) >= 0 && since(f) < 39);
  const heldMax = Math.max(...frozen.map((f) => Math.abs(f.drawnY - reference.liveY)));
  const rejoin = catchFrames.reduce((t, f) => (since(f) >= 0 && Math.abs(f.drawnY - f.liveY) > 1e-6 ? since(f) : t), -Infinity);
  const gap = Math.abs(catchFrames.find((f) => since(f) >= 40)!.liveY - reference.liveY);
  // The drawn pose may move at the live speed plus the ease's peak catch-up speed (1.5 × gap / 60 ms).
  const frameMs = 1000 / 240;
  const stepBound = (1.5 * frameMs) / 1000 + (1.5 * gap * frameMs) / 60 + 0.002;
  const catchStep = maxStep(catchFrames);
  const catchCam = camera(catchFrames);
  lines.push(`catch:  pose held within ${mm(heldMax)} for 40 ms while the live pose moved ${mm(gap)}, rejoined by ${rejoin.toFixed(0)} ms, max step ${mm(catchStep)} (bound ${mm(stepBound)}), camera shake max ${mm(catchCam.max)}`);
  check(heldMax < 1e-6, `catch hit-stop did not hold the pose (moved ${mm(heldMax)})`);
  check(gap > 0.04, `catch scenario did not move the live pose during the freeze (${mm(gap)})`);
  check(rejoin >= 90 && rejoin <= 101, `catch pose rejoined the live pose at ${rejoin.toFixed(0)} ms (expected 40 + 60)`);
  check(catchStep <= stepBound, `catch stepped ${mm(catchStep)} in one frame (bound ${mm(stepBound)}): a visible jump`);
  check(catchCam.max <= 0.004 + 1e-9 && catchCam.max > 0.0005, `catch camera shake ${mm(catchCam.max)} outside (0.5, 4] mm`);

  for (const key of ['snapReduced', 'catchReduced'] as const) {
    const frames = cues[key];
    const deviation = Math.max(...frames.map((f) => Math.abs(f.drawnY - f.liveY)));
    const shake = camera(frames).max;
    lines.push(`${key}: max deviation from the live pose ${mm(deviation)}, camera shake ${mm(shake)} (both must be 0)`);
    check(deviation < 1e-9, `${key} drew ${mm(deviation)} away from the live pose`);
    check(shake < 1e-9, `${key} shook the camera ${mm(shake)}`);
  }
  return { lines, failures };
}

const server = await createServer({
  root: ROOT,
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    port: 5193,
    strictPort: false,
    // Cross-origin isolation makes performance.now() resolve to a few microseconds instead of 100 µs, which
    // matters when render() takes a fraction of a millisecond. Only this QA server sends the headers.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
});
await server.listen();
const address = server.httpServer?.address() as AddressInfo | null;
if (!address) throw new Error('vite did not report an address');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
mkdirSync(OUT, { recursive: true });

try {
  console.log(`Chrome ${browser.version()}`);

  // --- screenshots ----------------------------------------------------------------------------------
  for (const shot of SHOTS) {
    if (!wants(shot.file)) continue;
    const page = await openFixture(browser, base, shot, shot.file);
    const path = resolve(OUT, `render-${shot.file}.png`);
    if (shot.element) {
      await page.locator(shot.element).screenshot({ path });
    } else if (shot.zoom) {
      const { x, y, halfWidth, halfHeight } = shot.zoom;
      const [x0, y0] = await page.evaluate(([wx, wy]) => window.qa!.toScreen!(wx, wy), [x - halfWidth, y + halfHeight] as [number, number]);
      const [x1, y1] = await page.evaluate(([wx, wy]) => window.qa!.toScreen!(wx, wy), [x + halfWidth, y - halfHeight] as [number, number]);
      await page.screenshot({ path, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    } else {
      await page.screenshot({ path });
    }
    const stats = await page.evaluate(() => window.qa?.stats);
    console.log(`render-${shot.file}.png  ${shot.width}x${shot.height}@${shot.dpr}  draw calls ${stats?.drawCalls ?? '-'}  triangles ${stats?.triangles ?? '-'}`);
    if (stats && stats.drawCalls >= DRAW_CALL_BUDGET) problems.push(`${shot.file}: ${stats.drawCalls} draw calls (budget < ${DRAW_CALL_BUDGET})`);
    await page.context().close();
  }

  // The same canvas created, disposed and created again must draw exactly what a fresh one draws.
  if (wants('lifecycle') && wants('sleeping')) {
    const fresh = readFileSync(resolve(OUT, 'render-sleeping.png'));
    const again = readFileSync(resolve(OUT, 'render-lifecycle.png'));
    const same = fresh.equals(again);
    console.log(`lifecycle: create/dispose/create on one canvas draws ${same ? 'exactly the same frame as a fresh renderer' : 'a DIFFERENT frame'}`);
    if (!same) problems.push('lifecycle: a renderer created after dispose() on the same canvas does not match a fresh one');
  }

  // --- context loss and restore ---------------------------------------------------------------------
  if (wants('context')) {
    const page = await openFixture(browser, base, { state: 'context', ...LANDSCAPE }, 'context');
    const result = await page.evaluate(() => window.qa?.context);
    await page.screenshot({ path: resolve(OUT, 'render-context-restored.png') });
    await page.context().close();
    if (!result || result.error) {
      problems.push(`context: ${result?.error ?? 'no result'}`);
    } else {
      console.log(`context: onContextLost fired ${result.lostFired}×, render() while lost ${result.threwWhileLost ? 'THREW' : 'was a no-op'}, frame after restore differs from before by ${result.meanAbsDiff.toFixed(3)}/255 on average (max ${result.maxDiff}), ${result.drawCalls} draw calls`);
      if (result.lostFired !== 1) problems.push(`context: onContextLost fired ${result.lostFired} times (expected 1)`);
      if (result.threwWhileLost) problems.push('context: render() threw while the context was lost');
      if (result.meanAbsDiff > CONTEXT_MEAN_DIFF_BUDGET) problems.push(`context: the frame after a restore differs by ${result.meanAbsDiff.toFixed(3)}/255 (> ${CONTEXT_MEAN_DIFF_BUDGET})`);
      if (result.drawCalls === 0) problems.push('context: nothing drawn after the restore');
    }
  }

  // --- render-only cues -----------------------------------------------------------------------------
  if (wants('cues')) {
    const page = await openFixture(browser, base, { state: 'cues', ...LANDSCAPE }, 'cues');
    const cues = await page.evaluate(() => window.qa?.cues);
    await page.context().close();
    if (!cues) throw new Error('fixture returned no cue measurements');
    const result = checkCues(cues);
    console.log('\nRender-only cues (what the renderer drew, sampled at 240 Hz):');
    for (const line of result.lines) console.log(`  ${line}`);
    problems.push(...result.failures);
  }

  // --- the exact visible rectangle: marker position versus prediction, at several aspect ratios -----
  if (wants('mapping')) {
    for (const [width, height] of [[1280, 800], [390, 844], [800, 800], [2000, 600]] as const) {
      const page = await openFixture(browser, base, { state: 'mapping', width, height, dpr: 1 }, `mapping-${width}x${height}`);
      const mapping = await page.evaluate(() => window.qa?.mapping);
      await page.context().close();
      if (!mapping) { problems.push(`mapping ${width}x${height}: no result`); continue; }
      const { rect } = mapping;
      const aspect = width / height;
      const found = mapping.results.filter((r) => r.errorPx !== null);
      const errors = found.map((r) => r.errorPx as number);
      const worst = Math.max(...errors);
      const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
      console.log(`mapping ${String(width).padStart(4)}x${String(height).padEnd(3)}: visible x ${rect.left.toFixed(3)}..${rect.right.toFixed(3)} y ${rect.bottom.toFixed(3)}..${rect.top.toFixed(3)} m; ${found.length}/9 markers found, position error mean ${mean.toFixed(2)} px, worst ${worst.toFixed(2)} px`);
      if (found.length !== 9) problems.push(`mapping ${width}x${height}: found ${found.length} of 9 markers`);
      if (worst > MAPPING_ERROR_BUDGET_PX) problems.push(`mapping ${width}x${height}: marker landed ${worst.toFixed(2)} px from where visibleWorld() predicts (> ${MAPPING_ERROR_BUDGET_PX})`);
      if (Math.abs((rect.right - rect.left) / (rect.top - rect.bottom) - aspect) > 1e-9) problems.push(`mapping ${width}x${height}: visible rectangle does not have the canvas aspect`);
      if (rect.bottom > -0.02 || rect.top < 1.12) problems.push(`mapping ${width}x${height}: y range ${rect.bottom}..${rect.top} does not cover -0.02..1.12`);
      if (rect.left > -0.45 + 1e-9 || rect.right < 0.45 - 1e-9) problems.push(`mapping ${width}x${height}: x range does not cover -0.45..0.45`);
    }

    // A resize after creation must be picked up (ResizeObserver) and re-fit the framing.
    const page = await openFixture(browser, base, { state: 'sleeping', ...LANDSCAPE }, 'resize');
    await page.setViewportSize({ width: 390, height: 844 });
    const resized = await page.evaluate(() => window.afterResize!());
    await page.context().close();
    const wide = resized.rect.right - resized.rect.left;
    console.log(`resize: 1280x800 -> 390x844 gives css ${resized.css.join('x')}, buffer ${resized.buffer.join('x')}, visible width ${wide.toFixed(3)} m, height ${(resized.rect.top - resized.rect.bottom).toFixed(3)} m`);
    if (resized.css[0] !== 390 || resized.css[1] !== 844) problems.push(`resize: css size ${resized.css.join('x')}, expected 390x844`);
    if (resized.buffer[0] !== Math.round(390 * resized.ratio) || resized.buffer[1] !== Math.round(844 * resized.ratio)) problems.push(`resize: drawing buffer ${resized.buffer.join('x')} does not match css × pixel ratio ${resized.ratio}`);
    if (Math.abs(wide - 0.9) > 1e-9) problems.push(`resize: portrait should keep exactly x ∈ [-0.45, 0.45], got width ${wide}`);
  }

  // --- every shader exists after construction ---------------------------------------------------------
  if (wants('programs')) {
    const page = await openFixture(browser, base, { state: 'programs', ...LANDSCAPE }, 'programs');
    const programs = await page.evaluate(() => window.qa?.programs);
    await page.context().close();
    if (!programs) {
      problems.push('programs: no result');
    } else {
      console.log(`programs: ${programs.afterConstruction} compiled right after construction, ${programs.afterEveryState} after every state, guide and pause were shown`);
      console.log(`startup:  constructor ${programs.constructMs.toFixed(1)} ms (WebGL context, generated environment, ${programs.afterConstruction} shaders compiled and warmed up); first idle frames ${programs.idleFramesMs.map((ms) => ms.toFixed(2)).join(', ')} ms, then the tie-on frames ${programs.firstFramesMs.map((ms) => ms.toFixed(2)).join(', ')} ms`);
      if (programs.afterEveryState !== programs.afterConstruction) {
        const first = programs.seen.find(([, count]) => count !== programs.afterConstruction);
        problems.push(`programs: ${programs.afterEveryState - programs.afterConstruction} shader(s) compiled after construction (first while showing "${first?.[0]}"): a stall the first time they become visible`);
      }
    }
  }

  // --- adaptive pixel ratio, end to end -------------------------------------------------------------
  if (wants('quality')) {
    const page = await openFixture(browser, base, { state: 'quality', width: 1280, height: 800, dpr: 2 }, 'quality');
    const steps = await page.evaluate(() => window.qa?.quality);
    await page.context().close();
    if (!steps) {
      problems.push('quality: no result');
    } else {
      console.log('adaptive pixel ratio (synthetic frame times, device ratio 2):');
      for (const st of steps) console.log(`  ${st.label.padEnd(22)} ratio ${st.ratio}  buffer ${st.bufferWidth}x${st.bufferHeight} (css ${st.cssWidth}x${st.cssHeight})`);
      const expected = [2, 1.75, 1.75, 2, 2];
      steps.forEach((st, i) => {
        if (st.ratio !== expected[i]) problems.push(`quality: "${st.label}" ratio ${st.ratio}, expected ${expected[i]}`);
        if (st.bufferWidth !== Math.round(st.cssWidth * st.ratio)) problems.push(`quality: "${st.label}" buffer width ${st.bufferWidth} does not follow the ratio ${st.ratio}`);
      });
    }
  }

  // --- cost -----------------------------------------------------------------------------------------
  const benches: Record<string, Bench> = {};
  const sizes: Record<string, number> = {};
  let soak: Soak | null = null;
  if (!skipBench && wants('bench')) {
    // [label, mode, device pixel ratio, viewport, extra query]. The "gpu-…" runs queue 60 frames and wait for
    // the GPU once, so they give the GPU time per frame once the pipeline is full (what a vsync-paced loop
    // pays); the big viewport and the no-MSAA run show how that scales with pixels, which is what matters
    // for a slower GPU. "worst" adds the pause dimming, the most overdraw this renderer ever has.
    const runs: Array<readonly [string, string, number, readonly [number, number], string?]> = [
      ['sync-1x', 'sync', 1, [1280, 800]], ['raf-1x', 'raf', 1, [1280, 800]],
      ['sync-2x', 'sync', 2, [1280, 800]], ['raf-2x', 'raf', 2, [1280, 800]],
      ['gpu-1x', 'batch', 1, [1280, 800]], ['gpu-2x', 'batch', 2, [1280, 800]],
      ['gpu-2x-worst', 'batch', 2, [1280, 800], 'worst=1'], ['gpu-2x-nomsaa', 'batch', 2, [1280, 800], 'antialias=0'],
      ['gpu-xl', 'batch', 2, [2560, 1600]],
    ];
    for (const [label, mode, dpr, [width, height], query] of runs) {
      const page = await openFixture(browser, base, { width, height, dpr, bench: mode, query }, label);
      const bench = (await page.evaluate(() => window.qa?.bench)) as Bench;
      benches[label] = bench;
      sizes[label] = megapixels(width, height, dpr);
      await page.context().close();
    }
    console.log('\nCost of one frame (SYNTHETIC scenario; ms; sync/raf = CPU of render(), gpu = GPU time per frame with the pipeline full):');
    for (const [label, b] of Object.entries(benches)) {
      const interval = b.frameIntervalMs ? `  frame interval p50 ${fmt(b.frameIntervalMs.p50)} p95 ${fmt(b.frameIntervalMs.p95)} max ${fmt(b.frameIntervalMs.max)}` : '';
      const mp = sizes[label];
      const perMp = label.startsWith('gpu') ? `  ${fmt(b.cpuMs.p50 / mp)} ms/MP at p50` : '';
      console.log(`  ${label.padEnd(13)} p50 ${fmt(b.cpuMs.p50)}  p95 ${fmt(b.cpuMs.p95)}  p99 ${fmt(b.cpuMs.p99)}  max ${fmt(b.cpuMs.max)}  (n=${b.cpuMs.n}, ${mp.toFixed(1)} MP, ${b.stats.drawCalls} draw calls)${interval}${perMp}`);
      if (label.startsWith('gpu')) {
        if (b.cpuMs.p95 > RENDER_BUDGET_P95_MS) problems.push(`${label}: render + GPU p95 ${fmt(b.cpuMs.p95)} ms exceeds ${RENDER_BUDGET_P95_MS} ms`);
      } else if (b.cpuMs.p95 > CPU_BUDGET_P95_MS) {
        problems.push(`${label}: render() CPU p95 ${fmt(b.cpuMs.p95)} ms exceeds ${CPU_BUDGET_P95_MS} ms`);
      }
      if (b.stats.drawCalls >= DRAW_CALL_BUDGET) problems.push(`${label}: ${b.stats.drawCalls} draw calls (budget < ${DRAW_CALL_BUDGET})`);
    }

    const page = await openFixture(browser, base, { width: 1280, height: 800, dpr: 1, bench: 'soak' }, 'soak');
    soak = (await page.evaluate(() => window.qa?.soak)) as Soak;
    await page.context().close();
    const growth = soak.heapGrowthBytes;
    console.log(`  soak      ${soak.frames} frames, mean ${fmt(soak.meanCpuMs)} ms/frame; geometries ${soak.before.counts.geometries}→${soak.after.counts.geometries}, textures ${soak.before.counts.textures}→${soak.after.counts.textures}, programs ${soak.before.counts.programs}→${soak.after.counts.programs}; retained heap growth ${growth === null ? 'n/a' : `${(growth / 1024).toFixed(0)} KiB`}`);
    for (const key of Object.keys(soak.before.counts)) {
      if (soak.before.counts[key] !== soak.after.counts[key]) problems.push(`soak: ${key} count changed ${soak.before.counts[key]} → ${soak.after.counts[key]}`);
    }
    if (growth !== null && growth > SOAK_HEAP_BUDGET_BYTES) problems.push(`soak: retained heap grew ${(growth / 1024 / 1024).toFixed(1)} MiB over ${soak.frames} frames`);

    writeFileSync(
      resolve(OUT, 'render-benchmark.json'),
      `${JSON.stringify({
        kind: 'SYNTHETIC input, GPU headless Chrome: render() cost on this machine; not a real webcam session and not an integrated GPU',
        chrome: browser.version(),
        webglRenderer: rendererName,
        budgets: { cpuP95Ms: CPU_BUDGET_P95_MS, renderWithGpuP95Ms: RENDER_BUDGET_P95_MS, drawCalls: DRAW_CALL_BUDGET },
        benches,
        megapixels: sizes,
        soak,
      }, null, 2)}\n`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\nWebGL renderer (GPU headless): ${rendererName}`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
