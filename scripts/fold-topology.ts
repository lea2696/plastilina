import {ClaySolver} from '../src/simulation/ClaySolver';
const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
const countCrossings=()=>{
 const p=solver.positions,t=solver.indices;let crossings=0;
 const point=(i:number):[number,number,number]=>[p[3*i],p[3*i+1],p[3*i+2]];
 const sub=(a:number[],b:number[])=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
 const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const dot=(a:number[],b:number[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 const hit=(a:number[],b:number[],c:number[],d:number[],e:number[])=>{
  const dir=sub(b,a),u=sub(d,c),v=sub(e,c),q=cross(dir,v),det=dot(u,q);if(Math.abs(det)<1e-9)return false;
  const inv=1/det,w=sub(a,c),s=dot(w,q)*inv;if(s<1e-4||s>1-1e-4)return false;
  const r=cross(w,u),f=dot(dir,r)*inv;if(f<1e-4||s+f>1-1e-4)return false;
  const alpha=dot(v,r)*inv;return alpha>1e-4&&alpha<1-1e-4;
 };
 for(let i=0;i<t.length;i+=3)for(let j=i+3;j<t.length;j+=3){
  const ai=[t[i],t[i+1],t[i+2]],bi=[t[j],t[j+1],t[j+2]];
  if(ai.some(x=>bi.includes(x)))continue;
  const a=ai.map(point),b=bi.map(point);
  const amin=[0,1,2].map(k=>Math.min(...a.map(x=>x[k]))),amax=[0,1,2].map(k=>Math.max(...a.map(x=>x[k]))),bmin=[0,1,2].map(k=>Math.min(...b.map(x=>x[k]))),bmax=[0,1,2].map(k=>Math.max(...b.map(x=>x[k])));
  if([0,1,2].some(k=>amax[k]<bmin[k]||bmax[k]<amin[k]))continue;
  if([[0,1],[1,2],[2,0]].some(([x,y])=>hit(a[x],a[y],b[0],b[1],b[2]))||[[0,1],[1,2],[2,0]].some(([x,y])=>hit(b[x],b[y],a[0],a[1],a[2])))crossings++;
 }
 return crossings;
};
for(let i=0;i<2400;i++){const q=(i%120)/120;solver.step(1/120,[{id:'move',kind:'tip',center:[0.12-0.26*q,0.29-0.1*q,0],radius:0.085,velocity:[0,0,0],grasp:true},{id:'hold',kind:'tip',center:[-0.13,0.17,0],radius:0.08,velocity:[0,0,0],grasp:true}]);}
const active={crossings:countCrossings(),volume:solver.surfaceVolume(),inverted:solver.invertedTetCount()};
for(let i=0;i<360;i++)solver.step(1/120);
const rested={crossings:countCrossings(),volume:solver.surfaceVolume(),inverted:solver.invertedTetCount()};
console.log(JSON.stringify({fixture:'fold-20',active,rested},null,2));
if(rested.crossings>0)process.exitCode=1;
