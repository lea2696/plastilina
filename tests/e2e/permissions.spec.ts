import { test, expect } from '@playwright/test';

test('camera denial shows recovery without blocking synthetic observation',async ({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>Promise.reject(new DOMException('Permission denied','NotAllowedError'))});});
 await page.goto('/');await page.getByRole('button',{name:'Comenzar con cámara'}).click();
 await expect(page.locator('p.status')).toContainText('Permiso rechazado');
 await page.getByRole('button',{name:'Observar demo sintética'}).click();
 await expect(page.locator('p.status')).toContainText('sintética');
});

test('missing camera reports absence and keeps synthetic mode available',async ({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>Promise.reject(new DOMException('No camera','NotFoundError'))});});
 await page.goto('/');await page.getByRole('button',{name:'Comenzar con cámara'}).click();
 await expect(page.locator('p.status')).toContainText('No se encontró una cámara');
 await page.getByRole('button',{name:'Observar demo sintética'}).click();
 await expect(page.locator('p.status')).toContainText('sintética');
});

test('cancelling pending camera permission stops a late-granted stream',async ({page})=>{
 await page.addInitScript(()=>{
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>new Promise<MediaStream>(resolve=>{(window as typeof window & {resolveCamera:(s:MediaStream)=>void}).resolveCamera=resolve;})});
 });
 await page.goto('/');await page.getByRole('button',{name:'Comenzar con cámara'}).click();
 await expect(page.locator('p.status')).toContainText('Esperando permiso');
 await page.getByRole('button',{name:'Cancelar espera'}).click();
 await page.evaluate(()=>{const stream=document.createElement('canvas').captureStream();(window as typeof window & {lateStream:MediaStream;resolveCamera:(s:MediaStream)=>void}).lateStream=stream;(window as typeof window & {resolveCamera:(s:MediaStream)=>void}).resolveCamera(stream);});
 await expect.poll(()=>page.evaluate(()=>(window as typeof window & {lateStream:MediaStream}).lateStream.getTracks().every(t=>t.readyState==='ended'))).toBe(true);
 await expect(page.locator('p.status')).toContainText('Cámara apagada');
});
