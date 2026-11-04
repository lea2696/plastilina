import {test,expect} from '@playwright/test';
import { openSettings } from './ui';

test('intro schedules gentle audio cues and volume/mute controls work without camera',async ({page})=>{
 await page.addInitScript(()=>{
  const w=window as typeof window & {qaOscillators:number};w.qaOscillators=0;
  const original=AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator=function(){w.qaOscillators++;return original.call(this);};
 });
 await page.goto('/');
 await openSettings(page);await page.getByRole('slider',{name:'Volumen'}).fill('35');
 await page.getByRole('button',{name:'Observar demo sintética'}).click();
 await expect(page.locator('p.status')).toContainText('sintética');
 await expect.poll(()=>page.evaluate(()=>(window as typeof window & {qaOscillators:number}).qaOscillators),{timeout:5000}).toBeGreaterThanOrEqual(2);
 await expect(page.getByRole('slider',{name:'Volumen'})).toHaveValue('35');
 await openSettings(page);await page.getByRole('button',{name:'Silenciar'}).click();
 await expect(page.getByRole('button',{name:'Activar sonido'})).toBeVisible();
});
