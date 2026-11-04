import { test, expect } from '@playwright/test';
import { openSettings } from './ui';
import fs from 'node:fs';
test('combined fake-camera worker plus active physics and render reports capability', async ({page,context})=>{
 test.setTimeout(60000);await context.grantPermissions(['camera']);
 await page.goto('/?qa=combined-two-hands');await page.getByRole('button',{name:'Comenzar con cámara'}).click();
 await openSettings(page);await page.getByRole('button',{name:'Diagnóstico'}).click();
 await expect.poll(async()=>{const raw=await page.locator('output').textContent();return raw?JSON.parse(raw).inferenceMs:0;},{timeout:30000}).toBeGreaterThan(0);
 await page.waitForTimeout(9000);
 const raw=await page.locator('output').textContent();const stats=JSON.parse(raw??'{}');
 expect(stats.source).toBe('camera');expect(stats.inferenceMs).toBeGreaterThan(0);expect(stats.frameP95Ms).toBeGreaterThan(0);expect(stats.totalContacts).toBeGreaterThan(0);
 fs.mkdirSync('artifacts/qa',{recursive:true});fs.writeFileSync('artifacts/qa/browser-performance.json',JSON.stringify({kind:'fake-camera-two-synthetic-hands-combined',browser:'Chrome headless',stats},null,2));
 await openSettings(page);await page.getByRole('button',{name:'Apagar cámara'}).click();
});
