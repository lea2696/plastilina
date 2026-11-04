import { performance } from 'node:perf_hooks';
import { ClaySolver } from '../src/simulation/ClaySolver';
const solver=new ClaySolver();const t0=performance.now();
for(let i=0;i<240;i++){solver.step(1/120);solver.surfaceVolume();}
const elapsed=performance.now()-t0;
console.log(JSON.stringify({kind:'cpu-synthetic-solver-plus-surface-volume',device:process.platform,steps:240,msPerStep:elapsed/240,volume:solver.surfaceVolume(),render:'not-included',tracking:'not-included'},null,2));
