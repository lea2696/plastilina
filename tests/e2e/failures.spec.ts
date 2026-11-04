import {test,expect} from '@playwright/test';

test('WebGL unavailable shows explicit unsupported state',async ({page})=>{
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;Object.defineProperty(HTMLCanvasElement.prototype,'getContext',{configurable:true,value:function(this:HTMLCanvasElement,type:string,...args:unknown[]){if(type.startsWith('webgl')||type==='experimental-webgl')return null;return Reflect.apply(original,this,[type,...args]);}});});
 await page.goto('/');await expect(page.locator('p.status')).toContainText('no ofrece WebGL');await expect(page.getByRole('button',{name:'Reintentar'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Comenzar con cámara'})).toHaveCount(0);
});

test('invalid model response is a recoverable error rather than a blank canvas',async ({page,context})=>{
 test.setTimeout(30000);await context.grantPermissions(['camera']);
 await page.route('**/hand_landmarker.task',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>wrong</title>'}));
 await page.goto('/');await page.getByRole('button',{name:'Comenzar con cámara'}).click();
 await expect(page.locator('p.status')).toContainText('Seguimiento:',{timeout:20000});
 await expect(page.getByRole('button',{name:'Comenzar con cámara'})).toBeVisible();
});

test('context loss stops interaction and requests explicit reload',async ({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Observar demo sintética'}).click();
 await page.locator('canvas').dispatchEvent('webglcontextlost',{bubbles:false,cancelable:true});
 await expect(page.locator('p.status')).toContainText('dispositivo gráfico');
 await expect(page.getByRole('button',{name:'Reintentar'})).toBeVisible();
});
