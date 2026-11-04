import { afterAll, describe, expect, it, vi } from 'vitest';
import { KNOWN_GAPS, runScenario, SCENARIOS, type ScenarioResult } from './scenarios';

// The ten-minute stability run and the 60 s jitter runs take a few seconds on a quiet machine and several on a busy one.
vi.setConfig({ testTimeout: 120_000 });

/**
 * End-to-end scenarios of the headless runtime, one `describe` per PRD criterion (Y-01 .. Y-09, Y-11
 * and the full-pipeline half of Y-S4), every `it` one condition of that criterion.
 *
 * ALL of it is SYNTHETIC evidence: sessions generated with the PRD §8.2 camera noise, or a noise-free
 * mouse script, through the runtime at a 60 Hz render cadence. Not a webcam, not a GPU, not a human.
 * The scenarios themselves live in scenarios.ts, which `pnpm test:yoyo:scenarios` runs as well, so
 * this file and the CLI report can never disagree; set YOYO_REPORT=1 to print every number as one
 * JSON line.
 *
 * A condition that is NOT met is declared in KNOWN_GAPS with its measured cause and encoded here as
 * `it.fails('KNOWN GAP …')`: it is reported, never hidden and never weakened, and the day it starts to
 * pass this file goes red until the mark is removed.
 */

// Running the scenarios while the file is collected is what lets each check become a test with its own name.
const results: ScenarioResult[] = SCENARIOS.map(runScenario);

for (const result of results) {
  describe(`${result.id} (synthetic): ${result.title}`, () => {
    for (const c of result.checks) {
      if (c.knownGap !== undefined) {
        // Passes while the condition fails; goes red the day the condition holds.
        it.fails(`KNOWN GAP ${c.id}: ${c.name}`, () => {
          expect(c.pass, `${c.detail}\nKnown gap: ${c.knownGap}\nIt holds now: remove ${c.id} from KNOWN_GAPS.`).toBe(true);
        });
      } else {
        it(c.name, () => {
          expect(c.pass, c.detail).toBe(true);
        });
      }
    }
  });
}

describe('the scenario library', () => {
  it('a scenario that throws is reported as a failing check, not as a crash of the others', () => {
    const result = runScenario({ id: 'Y-XX', run: () => { throw new Error('boom'); } });
    expect(result.id).toBe('Y-XX');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: 'Y-XX:runs', pass: false });
    expect(result.checks[0].detail).toContain('boom');
  });

  it('every criterion produced checks, and none of the scenarios threw', () => {
    expect(results.map(r => r.id)).toEqual(['Y-01', 'Y-02', 'Y-03', 'Y-04', 'Y-05', 'Y-06', 'Y-07', 'Y-08', 'Y-09', 'Y-11', 'Y-S4']);
    for (const r of results) {
      expect(r.evidence).toBe('synthetic');
      expect(r.checks.length, r.id).toBeGreaterThan(0);
      expect(r.checks.some(c => c.id.endsWith(':runs')), `${r.id} threw: ${r.checks[0].detail}`).toBe(false);
    }
  });

  it('check ids are unique, and every known gap names a check that exists', () => {
    const ids = results.flatMap(r => r.checks.map(c => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of KNOWN_GAPS.keys()) expect(ids, `KNOWN_GAPS names ${id}, which no scenario produces`).toContain(id);
  });

  it('every known gap carries a cause and who owns it: a module, the design, or the camera noise of the PRD', () => {
    for (const [id, why] of KNOWN_GAPS) {
      expect(why.length, id).toBeGreaterThan(40);
      expect(why, id).toMatch(/Perception|Model|by design|Camera noise/);
    }
  });
});

afterAll(() => {
  if (process.env.YOYO_REPORT !== '1') return;
  const line = JSON.stringify({
    report: 'yoyo-scenarios',
    evidence: 'synthetic',
    scenarios: results.map(r => ({
      id: r.id,
      title: r.title,
      checks: r.checks.map(c => ({ id: c.id, pass: c.pass, knownGap: c.knownGap !== undefined, detail: c.detail })),
      numbers: r.numbers,
    })),
  }, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value));
  console.log(line);
});
