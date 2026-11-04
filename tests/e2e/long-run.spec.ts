import { test, expect } from '@playwright/test';
import { openSettings } from './ui';
import fs from 'node:fs';

const seconds = Number(process.env.LONG_QA_SECONDS ?? 0);
test('opt-in sustained combined synthetic workload', async ({ page, context }) => {
  test.skip(!Number.isFinite(seconds) || seconds < 30, 'Set LONG_QA_SECONDS=600 for the 10-minute integrated fixture');
  test.setTimeout((seconds + 90) * 1000);
  await context.grantPermissions(['camera']);
  await page.goto('/?qa=combined-two-hands');
  await page.getByRole('button', { name: 'Comenzar con cámara' }).click();
  await openSettings(page);await page.getByRole('button', { name: 'Diagnóstico' }).click();
  await expect.poll(async () => {
    const raw = await page.locator('output').textContent();
    return raw ? JSON.parse(raw).inferenceMs : 0;
  }, { timeout: 30000 }).toBeGreaterThan(0);
  const samples: Array<{ fps:number; frameP95Ms:number; frameP99Ms:number; ageMs:number; inferenceMs:number; simSteps:number; totalContacts:number; invertedTets:number; volume:number }> = [];
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(1000);
    const raw = await page.locator('output').textContent();
    const data = JSON.parse(raw ?? '{}');
    if (!Number.isFinite(data.fps) || !Number.isFinite(data.ageMs)) throw new Error('Missing integrated diagnostics');
    samples.push(data);
  }
  const percentile = (v:number[],p:number) => [...v].sort((a,b)=>a-b)[Math.min(v.length-1,Math.floor((v.length-1)*p))];
  const report = {
    kind:'fake-camera-inference-two-synthetic-hands-physics-render-long-run',
    browser:'Chrome headless',
    elapsedSeconds:(Date.now()-started)/1000,
    sampleCount:samples.length,
    medianFps:percentile(samples.map(x=>x.fps),0.5),
    p95OfRollingFrameP95Ms:percentile(samples.map(x=>x.frameP95Ms),0.95),
    p99OfRollingFrameP99Ms:percentile(samples.map(x=>x.frameP99Ms),0.99),
    p95LandmarkAgeMs:percentile(samples.map(x=>x.ageMs),0.95),
    first:samples[0],last:samples.at(-1),
    maxInvertedTets:Math.max(...samples.map(x=>x.invertedTets)),
    volumeRange:[Math.min(...samples.map(x=>x.volume)),Math.max(...samples.map(x=>x.volume))],
  };
  fs.mkdirSync('artifacts/qa',{recursive:true});
  fs.writeFileSync('artifacts/qa/browser-long-run.json',JSON.stringify(report,null,2));
  expect(report.elapsedSeconds).toBeGreaterThanOrEqual(seconds);
  expect(report.medianFps).toBeGreaterThanOrEqual(30);
  expect(report.p95OfRollingFrameP95Ms).toBeLessThanOrEqual(50);
  expect(report.p99OfRollingFrameP99Ms).toBeLessThanOrEqual(100);
  expect(report.p95LandmarkAgeMs).toBeLessThanOrEqual(150);
  expect(report.last!.totalContacts).toBeGreaterThan(report.first!.totalContacts);
  expect(report.last!.simSteps).toBeGreaterThan(report.first!.simSteps);
  expect(report.maxInvertedTets).toBe(0);
  await openSettings(page);await page.getByRole('button',{name:'Apagar cámara'}).click();
});
