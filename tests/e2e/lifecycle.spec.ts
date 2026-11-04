import {test,expect} from '@playwright/test';
import { openSettings } from './ui';
const readStats=async(page:import('@playwright/test').Page)=>JSON.parse((await page.locator('output').textContent())??'{}') as {simSteps:number;source:string;volume:number};

test('hidden tab pauses simulation and return does not accumulate missed steps',async ({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Observar demo sintética'}).click();
 const skip=page.getByRole('button',{name:'Omitir introducción'});if(await skip.isVisible())await skip.click();
 await openSettings(page);await page.getByRole('button',{name:'Diagnóstico'}).click();await page.waitForTimeout(1000);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(900);const hidden=await readStats(page);await page.waitForTimeout(400);const stillHidden=await readStats(page);
 expect(stillHidden.simSteps).toBe(hidden.simSteps);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(400);const visible=await readStats(page);
 expect(visible.simSteps).toBeGreaterThan(stillHidden.simSteps);expect(visible.simSteps-stillHidden.simSteps).toBeLessThan(70);
});

test('automatic intro ends in active synthetic interaction without input during intro',async ({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Observar demo sintética'}).click();
 await expect(page.getByRole('button',{name:'Omitir introducción'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Omitir introducción'})).toHaveCount(0,{timeout:6000});
 await openSettings(page);await page.getByRole('button',{name:'Diagnóstico'}).click();await expect.poll(async()=> (await readStats(page)).simSteps).toBeGreaterThan(180);
 expect((await readStats(page)).source).toBe('replay');
});
