import { performance } from 'node:perf_hooks';
import { ClaySolver } from '../src/simulation/ClaySolver';
import type { HandCollider } from '../src/shared/contracts';
const solver=new ClaySolver(),startVolume=solver.surfaceVolume();let min=Infinity,max=0;
const t0=performance.now();for(let i=0;i<72_000;i++){
 const phase=i%2400;const colliders:HandCollider[]=phase<1800?[{id:'scripted-finger',kind:'tip',center:[0.04+0.04*Math.sin(i*0.012),0.3+0.06*Math.sin(i*0.027),0.03],radius:0.06,velocity:[0,0,0]}]:[];
 solver.step(1/120,colliders);
 if(i%120===0){const v=solver.surfaceVolume();if(!Number.isFinite(v))throw new Error(`Nonfinite volume at step ${i}`);min=Math.min(min,v);max=Math.max(max,v);}
}
const result={kind:'synthetic-10-minutes-at-120-Hz',steps:72000,elapsedWallSeconds:(performance.now()-t0)/1000,startVolume,minVolume:min,maxVolume:max,finalVolume:solver.surfaceVolume(),minY:solver.minY()};
console.log(JSON.stringify(result,null,2));if(result.minY<0||result.finalVolume<=0)process.exitCode=1;
