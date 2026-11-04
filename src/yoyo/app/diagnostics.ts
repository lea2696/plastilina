import type { Preset } from '../config';
import type { InputSource, Responsiveness, YoyoMetrics } from '../contracts';
import type { HandMeasure } from './framing';
import { roundOrNull, type RollingWindow } from './stats';
import type { RuntimeDiagnostics } from './YoyoRuntime';

/** Everything the engine measures, handed over as it is: the builders below only summarise. */
export interface DiagnosticsInput {
  source: InputSource | null;
  mode: string;
  phase: string | null;
  fps: number;
  /** Time between rendered frames on the rAF timestamps (the cadence the person sees), ms. */
  frameMs: RollingWindow;
  /** How late the frame callback started after its frame's begin time (main-thread dispatch jitter), ms. */
  startLagMs: RollingWindow;
  /** Wall time of `runtime.advance`, ms. */
  physicsMs: RollingWindow;
  /** Wall time of `renderer.render`, ms (CPU: command submission, not the GPU). */
  renderMs: RollingWindow;
  /** Capture of the input that caused a launch or tug → right after the frame that shows it was drawn, ms. */
  latencyMs: RollingWindow;
  /** Camera only: when the frame was captured → when the app received it, ms. */
  captureToArrivalMs: RollingWindow;
  /** Camera only: one inference in the worker, ms. */
  inferenceMs: RollingWindow;
  runtime: RuntimeDiagnostics | null;
  metrics: YoyoMetrics | null;
  pixelRatio: number | null;
  gpu: string | null;
  drawCalls: number | null;
  /** Last measured hand, kept in memory only. */
  hand: HandMeasure | null;
}

/** Flat on purpose: `"launches":3` is greppable in the panel and in a test. null means «not measured». */
export interface Diagnostics {
  source: InputSource | null;
  mode: string;
  phase: string | null;
  fps: number | null;
  frameP95Ms: number | null;
  startLagP95Ms: number | null;
  physicsP95Ms: number | null;
  renderP95Ms: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencySamples: number;
  captureToArrivalP50Ms: number | null;
  inferenceMs: number | null;
  inferenceP50Ms: number | null;
  sampleAgeMs: number | null;
  pixelRatio: number | null;
  droppedMs: number | null;
  queueDrops: number | null;
  launches: number | null;
  tugs: number | null;
  catches: number | null;
  autoReturns: number | null;
  handLosses: number | null;
  palmSizeIh: number | null;
  anchorYIh: number | null;
  gpu: string | null;
  drawCalls: number | null;
}

/** Summarises the windows: percentiles rounded to what a person can read, NaN and Infinity as null. */
export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const { runtime, metrics, hand } = input;
  return {
    source: input.source,
    mode: input.mode,
    phase: input.phase,
    fps: roundOrNull(input.fps, 0),
    frameP95Ms: roundOrNull(input.frameMs.percentile(0.95), 1),
    startLagP95Ms: roundOrNull(input.startLagMs.percentile(0.95), 2),
    physicsP95Ms: roundOrNull(input.physicsMs.percentile(0.95), 3),
    renderP95Ms: roundOrNull(input.renderMs.percentile(0.95), 2),
    latencyP50Ms: roundOrNull(input.latencyMs.percentile(0.5), 1),
    latencyP95Ms: roundOrNull(input.latencyMs.percentile(0.95), 1),
    latencySamples: input.latencyMs.count,
    captureToArrivalP50Ms: roundOrNull(input.captureToArrivalMs.percentile(0.5), 1),
    inferenceMs: roundOrNull(input.inferenceMs.latest, 1),
    inferenceP50Ms: roundOrNull(input.inferenceMs.percentile(0.5), 1),
    sampleAgeMs: runtime ? roundOrNull(runtime.lastSampleAgeMs, 0) : null,
    pixelRatio: input.pixelRatio === null ? null : roundOrNull(input.pixelRatio, 2),
    droppedMs: runtime ? roundOrNull(runtime.droppedMs, 1) : null,
    queueDrops: runtime ? runtime.queueDrops : null,
    launches: metrics ? metrics.launches : null,
    tugs: metrics ? metrics.tugs : null,
    catches: metrics ? metrics.catches : null,
    autoReturns: metrics ? metrics.autoReturns : null,
    handLosses: metrics ? metrics.handLosses : null,
    palmSizeIh: hand ? roundOrNull(hand.palmSize, 3) : null,
    anchorYIh: hand ? roundOrNull(hand.anchorY, 3) : null,
    gpu: input.gpu,
    drawCalls: input.drawCalls,
  };
}

/**
 * The text of the diagnostics `<output>`: valid JSON, one key per line, no space after the colon (so a
 * test can match `"launches":3` the way Masa's tests match its panel). Built key by key rather than by
 * patching the output of JSON.stringify, which could split a string value that contains `,"`.
 */
export function formatDiagnostics(diagnostics: Diagnostics): string {
  const lines = Object.entries(diagnostics).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
  return `{${lines.join(',\n')}}`;
}

/** File written by «Exportar métricas»: counters and measurements only, nothing about the person. */
export interface MetricsExport {
  schema: 'yoyo-metrics/1';
  source: InputSource | null;
  preset: Preset;
  responsiveness: Responsiveness;
  /** The runtime's counters; tugSuccessRate is null before the first tug (it is NaN in memory, which JSON cannot hold). */
  metrics: Omit<YoyoMetrics, 'tugSuccessRate' | 'reactionLatencyMs'> & { tugSuccessRate: number | null; reactionLatencyMs: number[] };
  diagnostics: Diagnostics;
}

export function buildMetricsExport(
  metrics: YoyoMetrics,
  diagnostics: Diagnostics,
  context: { source: InputSource | null; preset: Preset; responsiveness: Responsiveness },
): MetricsExport {
  return {
    schema: 'yoyo-metrics/1',
    source: context.source,
    preset: context.preset,
    responsiveness: context.responsiveness,
    metrics: {
      ...metrics,
      sessionMs: roundOrNull(metrics.sessionMs, 0) ?? 0,
      firstLaunchMs: metrics.firstLaunchMs === null ? null : roundOrNull(metrics.firstLaunchMs, 0),
      tugSuccessRate: roundOrNull(metrics.tugSuccessRate, 3),
      reactionLatencyMs: metrics.reactionLatencyMs.map(v => roundOrNull(v, 1) ?? 0),
    },
    diagnostics,
  };
}
