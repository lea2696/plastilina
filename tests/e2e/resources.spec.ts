import { test, expect } from '@playwright/test';
import { openSettings } from './ui';

test('20 camera start-stop cycles release worker and stream tracks',async ({page,context})=>{
 test.setTimeout(120000);await context.grantPermissions(['camera']);
 await page.addInitScript(()=>{
  const w=window as typeof window & {qaWorkers:{created:number;active:number};qaStreams:MediaStream[]};w.qaWorkers={created:0,active:0};w.qaStreams=[];
  const Original=window.Worker;
  window.Worker=class extends Original{private counted=true;constructor(url:string|URL,options?:WorkerOptions){super(url,options);w.qaWorkers.created++;w.qaWorkers.active++;}override terminate(){if(this.counted){this.counted=false;w.qaWorkers.active--;}super.terminate();}};
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async(c:MediaStreamConstraints)=>{const stream=await original(c);w.qaStreams.push(stream);return stream;}});
 });
 await page.goto('/');
 for(let i=0;i<20;i++){
  await page.getByRole('button',{name:'Comenzar con cámara'}).click();
  await expect(page.locator('p.status')).toContainText('Mostrá una mano',{timeout:15000});
  await openSettings(page);await page.getByRole('button',{name:'Apagar cámara'}).click();
  await expect(page.locator('p.status')).toContainText('Cámara apagada');
 }
 const state=await page.evaluate(()=>{const w=window as typeof window & {qaWorkers:{created:number;active:number};qaStreams:MediaStream[]};return {workers:w.qaWorkers,tracks:w.qaStreams.flatMap(s=>s.getTracks().map(t=>t.readyState))};});
 expect(state.workers).toEqual({created:20,active:0});expect(state.tracks).toHaveLength(20);expect(state.tracks.every(v=>v==='ended')).toBe(true);
});
