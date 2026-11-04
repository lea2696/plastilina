import { describe, expect, it, vi } from 'vitest';
import type { YoyoMetrics } from '../contracts';
import { buildDiagnostics, buildMetricsExport, formatDiagnostics, type DiagnosticsInput } from './diagnostics';
import { downloadJson, timestampedFilename } from './download';
import { RollingWindow } from './stats';
import type { RuntimeDiagnostics } from './YoyoRuntime';

function windowOf(values: number[], capacity = 64): RollingWindow {
  const w = new RollingWindow(capacity);
  for (const v of values) w.push(v);
  return w;
}

const metrics = (over: Partial<YoyoMetrics> = {}): YoyoMetrics => ({
  sessionMs: 61234.4, firstLaunchMs: 5123.7, launches: 3, tugs: 2, catches: 2, autoReturns: 1, exhausted: 0,
  tugSuccessRate: 1, ignoredIntents: 4, handLosses: 2, reactionLatencyMs: [31.26, 44.04], ...over,
});

const runtime = (over: Partial<RuntimeDiagnostics> = {}): RuntimeDiagnostics => ({
  queueDrops: 0, queuePeak: 3, droppedMs: 0, stepsTotal: 1000, lastSampleAgeMs: 21.4, ...over,
});

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    source: 'camera', mode: 'playing', phase: 'sleeping', fps: 59.7,
    frameMs: windowOf(Array.from({ length: 60 }, (_, i) => 16 + (i % 5) * 0.3)),
    startLagMs: windowOf([0.4, 0.6, 1.234, 0.5]),
    physicsMs: windowOf([0.01, 0.02, 0.012]),
    renderMs: windowOf([1.5, 2.2, 1.9]),
    latencyMs: windowOf([30, 40, 50]),
    captureToArrivalMs: windowOf([48, 52, 55]),
    inferenceMs: windowOf([12, 14, 13]),
    runtime: runtime(), metrics: metrics(), pixelRatio: 2, gpu: 'ANGLE (Apple, M4)', drawCalls: 9,
    hand: { palmSize: 0.17234, anchorY: 0.41099 },
    ...over,
  };
}

describe('buildDiagnostics', () => {
  it('summarises every quantity the panel promises', () => {
    const d = buildDiagnostics(input());
    expect(d).toMatchObject({
      source: 'camera', mode: 'playing', phase: 'sleeping', fps: 60,
      latencyP50Ms: 40, latencyP95Ms: 50, latencySamples: 3,
      captureToArrivalP50Ms: 52, inferenceMs: 13, inferenceP50Ms: 13,
      sampleAgeMs: 21, pixelRatio: 2, droppedMs: 0, queueDrops: 0,
      launches: 3, tugs: 2, catches: 2, autoReturns: 1, handLosses: 2,
      palmSizeIh: 0.172, anchorYIh: 0.411, gpu: 'ANGLE (Apple, M4)', drawCalls: 9,
    });
    expect(d.frameP95Ms).toBeGreaterThan(16);
    expect(d.frameP95Ms).toBeLessThan(17.5);
    expect(d.startLagP95Ms).toBe(1.23);
    expect(d.physicsP95Ms).toBe(0.02);
    expect(d.renderP95Ms).toBe(2.2);
  });

  it('says null, not NaN, for what has not been measured', () => {
    const d = buildDiagnostics(input({
      source: null, phase: null, fps: 0,
      frameMs: new RollingWindow(4), startLagMs: new RollingWindow(4), physicsMs: new RollingWindow(4), renderMs: new RollingWindow(4),
      latencyMs: new RollingWindow(4), captureToArrivalMs: new RollingWindow(4), inferenceMs: new RollingWindow(4),
      runtime: null, metrics: null, pixelRatio: null, gpu: null, drawCalls: null, hand: null,
    }));
    for (const key of ['frameP95Ms', 'startLagP95Ms', 'physicsP95Ms', 'renderP95Ms', 'latencyP50Ms', 'latencyP95Ms', 'captureToArrivalP50Ms', 'inferenceMs', 'inferenceP50Ms', 'sampleAgeMs', 'droppedMs', 'queueDrops', 'launches', 'tugs', 'catches', 'autoReturns', 'handLosses', 'palmSizeIh', 'anchorYIh', 'pixelRatio'] as const) {
      expect(d[key]).toBeNull();
    }
    expect(d.latencySamples).toBe(0);
    expect(d.fps).toBe(0);
  });

  it('turns an infinite sample age (no sample yet) into null', () => {
    expect(buildDiagnostics(input({ runtime: runtime({ lastSampleAgeMs: Infinity }) })).sampleAgeMs).toBeNull();
  });

  it('is JSON-safe whatever it is given', () => {
    const d = buildDiagnostics(input({ fps: Number.NaN }));
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe('formatDiagnostics', () => {
  it('is valid JSON, one key per line, with no space after the colon', () => {
    const d = buildDiagnostics(input());
    const text = formatDiagnostics(d);
    expect(JSON.parse(text)).toEqual(d);
    expect(text.split('\n')).toHaveLength(Object.keys(d).length);
    expect(text).toContain('"launches":3');
    expect(text).toContain('"phase":"sleeping"');
    expect(text).toMatch(/"launches":[1-9]/);
  });

  it('survives a string value that contains a comma before its closing quote', () => {
    const d = buildDiagnostics(input({ gpu: 'ANGLE (Apple, "M4",' }));
    expect(JSON.parse(formatDiagnostics(d)).gpu).toBe('ANGLE (Apple, "M4",');
  });
});

describe('buildMetricsExport', () => {
  const context = { source: 'camera' as const, preset: 'seated' as const, responsiveness: 'responsive' as const };

  it('carries the counters and the diagnostics and says what it is', () => {
    const d = buildDiagnostics(input());
    const file = buildMetricsExport(metrics(), d, context);
    expect(file.schema).toBe('yoyo-metrics/1');
    expect(file.source).toBe('camera');
    expect(file.preset).toBe('seated');
    expect(file.responsiveness).toBe('responsive');
    expect(file.metrics).toMatchObject({ launches: 3, tugs: 2, catches: 2, autoReturns: 1, handLosses: 2, ignoredIntents: 4, tugSuccessRate: 1, sessionMs: 61234, firstLaunchMs: 5124 });
    expect(file.metrics.reactionLatencyMs).toEqual([31.3, 44]);
    expect(file.diagnostics).toBe(d);
  });

  it('writes null for what is NaN in memory (no tug yet) so the file round-trips', () => {
    const file = buildMetricsExport(metrics({ tugSuccessRate: Number.NaN, firstLaunchMs: null, tugs: 0 }), buildDiagnostics(input()), context);
    expect(file.metrics.tugSuccessRate).toBeNull();
    expect(file.metrics.firstLaunchMs).toBeNull();
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });

  it('contains nothing but numbers, names of states and the GPU string: no landmarks, no images, no dates', () => {
    const text = JSON.stringify(buildMetricsExport(metrics(), buildDiagnostics(input()), context));
    expect(text).not.toMatch(/landmark|image|frames|20\d\d-\d\d-\d\d/i);
  });
});

describe('timestampedFilename', () => {
  it('writes the local time of the click into the name', () => {
    const date = new Date(2026, 9, 1, 16, 5, 9);
    expect(timestampedFilename('yoyo-replay', 'json', date)).toBe('yoyo-replay-20261001-160509.json');
    expect(timestampedFilename('yoyo-metricas', 'json', new Date(2027, 0, 2, 3, 4, 5))).toBe('yoyo-metricas-20270102-030405.json');
  });
});

describe('downloadJson', () => {
  function fakeBrowser() {
    const calls: string[] = [];
    const anchor = { href: '', download: '', click: vi.fn(() => { calls.push('click'); }) };
    const doc = {
      createElement: vi.fn((tag: string) => { calls.push(`create:${tag}`); return anchor; }),
      body: { appendChild: vi.fn(() => { calls.push('append'); }), removeChild: vi.fn(() => { calls.push('remove'); }) },
    };
    const blobs: Blob[] = [];
    const urls = {
      createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); calls.push('createObjectURL'); return 'blob:yoyo-1'; }),
      revokeObjectURL: vi.fn((url: string) => { calls.push(`revoke:${url}`); }),
    };
    return { calls, anchor, doc: doc as unknown as Document, urls, blobs };
  }

  it('creates a local download of the JSON and revokes the URL a moment later', async () => {
    vi.useFakeTimers();
    try {
      const env = fakeBrowser();
      downloadJson({ a: 1 }, 'x.json', env.doc, env.urls);
      expect(env.calls).toEqual(['createObjectURL', 'create:a', 'append', 'click', 'remove']);
      expect(env.anchor.download).toBe('x.json');
      expect(env.anchor.href).toBe('blob:yoyo-1');
      expect(env.blobs[0].type).toBe('application/json');
      expect(JSON.parse(await env.blobs[0].text())).toEqual({ a: 1 });
      expect(env.urls.revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(env.urls.revokeObjectURL).toHaveBeenCalledWith('blob:yoyo-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing anywhere', () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn();
      const beaconSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      vi.stubGlobal('navigator', { sendBeacon: beaconSpy });
      const env = fakeBrowser();
      downloadJson({ a: 1 }, 'x.json', env.doc, env.urls);
      vi.runAllTimers();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(beaconSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
