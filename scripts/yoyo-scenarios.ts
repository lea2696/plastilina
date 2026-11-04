import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDER_HZ, SCENARIOS, runScenario, type Check, type ScenarioResult } from '../src/yoyo/app/scenarios';

/**
 * Phase 0 end-to-end scenarios (PRD_YOYO.md §9: Y-01 .. Y-09, Y-11, and the full-pipeline half of
 * Y-S4). Runs every scenario of src/yoyo/app/scenarios.ts, prints a readable summary and writes
 * artifacts/qa/yoyo/scenarios.json with every number measured.
 *
 * ALL of it is SYNTHETIC evidence: generated sessions with the PRD §8.2 camera noise, or a
 * noise-free mouse script, through the headless runtime at a 60 Hz render cadence. No webcam, no
 * GPU, no human. It says the pipeline behaves on that noise model, not that it works in Luis's
 * hands.
 *
 * Exit code 1 when a check fails that is not a declared known gap, or when a declared known gap
 * starts to pass (the mark must go, or the report lies).
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const line = (text = '') => console.log(text);

/** Verdict of one check, taking the declared known gaps into account. */
type Verdict = 'pass' | 'fail' | 'known-gap' | 'gap-closed';

function verdictOf(c: Check): Verdict {
  if (c.knownGap === undefined) return c.pass ? 'pass' : 'fail';
  return c.pass ? 'gap-closed' : 'known-gap';
}

const LABEL: Record<Verdict, string> = { pass: 'PASS     ', fail: 'FAIL     ', 'known-gap': 'KNOWN GAP', 'gap-closed': 'GAP CLOSED' };

function printScenario(result: ScenarioResult, ms: number) {
  line();
  line(`${result.id}  ${result.title}  [${result.evidence}, ${ms} ms]`);
  for (const c of result.checks) {
    const verdict = verdictOf(c);
    line(`  ${LABEL[verdict]} ${c.name}`);
    line(`            ${c.detail}`);
    if (c.knownGap) line(`            known gap: ${c.knownGap}`);
  }
}

const started = Date.now();
line(`Yoyó phase 0: end-to-end scenarios on SYNTHETIC sessions (PRD §8.2 noise, ${RENDER_HZ} Hz render cadence; no webcam, no GPU, no human)`);

const results: Array<{ result: ScenarioResult; ms: number }> = [];
for (const entry of SCENARIOS) {
  const t0 = Date.now();
  const result = runScenario(entry);
  const ms = Date.now() - t0;
  results.push({ result, ms });
  printScenario(result, ms);
}

const all = results.flatMap(r => r.result.checks.map(c => ({ id: r.result.id, check: c, verdict: verdictOf(c) })));
const count = (v: Verdict) => all.filter(a => a.verdict === v).length;
const failing = all.filter(a => a.verdict === 'fail' || a.verdict === 'gap-closed');

line();
line(`checks: ${all.length}  pass ${count('pass')}  known gap ${count('known-gap')}  fail ${count('fail')}  gap closed ${count('gap-closed')}`);
line(`per criterion: ${results.map(r => `${r.result.id} ${r.result.checks.every(c => verdictOf(c) === 'pass' || verdictOf(c) === 'known-gap') ? 'ok' : 'FAIL'}`).join(', ')}`);

const outDir = join(root, 'artifacts', 'qa', 'yoyo');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'scenarios.json'), JSON.stringify({
  evidence: 'synthetic',
  note: 'Generated sessions with the PRD §8.2 noise model (camera path) or a noise-free mouse script, through the headless runtime at a 60 Hz render cadence. Not webcam, not GPU, not human.',
  generatedBy: 'pnpm test:yoyo:scenarios',
  renderHz: RENDER_HZ,
  summary: { checks: all.length, pass: count('pass'), knownGap: count('known-gap'), fail: count('fail'), gapClosed: count('gap-closed'), elapsedMs: Date.now() - started },
  scenarios: results.map(({ result, ms }) => ({
    id: result.id,
    title: result.title,
    evidence: result.evidence,
    elapsedMs: ms,
    pass: result.checks.every(c => verdictOf(c) === 'pass' || verdictOf(c) === 'known-gap'),
    checks: result.checks.map(c => ({ name: c.name, verdict: verdictOf(c), pass: c.pass, detail: c.detail, ...(c.knownGap ? { knownGap: c.knownGap } : {}) })),
    numbers: result.numbers,
  })),
}, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value), 2));
line();
line(`wrote ${join('artifacts', 'qa', 'yoyo', 'scenarios.json')}`);

if (failing.length > 0) {
  line();
  for (const f of failing) line(`${f.verdict === 'gap-closed' ? 'GAP CLOSED (remove the knownGap mark)' : 'FAILED'}: ${f.id}: ${f.check.name}`);
  process.exitCode = 1;
} else {
  line('all scenario checks hold (known gaps aside)');
}
