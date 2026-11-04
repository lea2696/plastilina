import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const server=await createServer({server:{host:'127.0.0.1',port:5192}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5192/');
 const result=await page.evaluate(`(async()=>{
  const {scheduleContactVoice}=await import('/src/audio/ClayAudio.ts');
  async function render(muted,events){
   const ctx=new OfflineAudioContext(1,44100,44100),master=ctx.createGain();master.gain.value=muted?0:0.12;master.connect(ctx.destination);
   for(let i=0;i<events;i++)scheduleContactVoice(ctx,master,{timestampMs:i*150,kind:'press',intensity:1},i*0.15);
   const buffer=await ctx.startRendering(),samples=buffer.getChannelData(0);let peak=0,energy=0;for(const sample of samples){peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;}
   return {peak,rms:Math.sqrt(energy/samples.length)};
  }
  return {idle:await render(false,0),contact:await render(false,3),muted:await render(true,3)};
 })()` ) as {idle:{peak:number};contact:{peak:number};muted:{peak:number}};
 console.log(JSON.stringify({kind:'offline-web-audio-44.1kHz-mono-1s',...result},null,2));
 if(result.idle.peak!==0||result.contact.peak<=0||result.contact.peak>=1||result.muted.peak!==0)process.exitCode=1;
}finally{await browser.close();await server.close();}
