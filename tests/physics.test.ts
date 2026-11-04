import { describe,expect,it } from 'vitest';
import { ClaySolver } from '../src/simulation/ClaySolver';
import { SurfaceSmoother } from '../src/rendering/SurfaceSmoother';
import type { HandCollider } from '../src/shared/contracts';
const dt=1/120;
const sphere=(x:number,y:number,z:number,radius:number,grasp=false,id='finger'):HandCollider=>({id,kind:'tip',center:[x,y,z],radius,velocity:[0,0,0],grasp});
// Resolution-independent probes: the top centre patch and the extreme side vertices of the shell.
const top=(s:ClaySolver)=>{let max=-Infinity;for(const v of s.surfaceVertices){const i=v*3;if(Math.abs(s.positions[i])<0.07&&Math.abs(s.positions[i+2])<0.07)max=Math.max(max,s.positions[i+1]);}return max;};
const sideVertex=(s:ClaySolver,sign:1|-1)=>{let best=-1,score=-Infinity;for(const v of s.surfaceVertices){const i=v*3,value=sign*s.positions[i]-Math.abs(s.positions[i+1]-0.17)-Math.abs(s.positions[i+2]);if(value>score){score=value;best=v;}}return best*3;};
const meshVolume=(p:Float32Array,t:Uint32Array)=>{let sum=0;for(let i=0;i<t.length;i+=3){const a=t[i]*3,b=t[i+1]*3,c=t[i+2]*3;sum+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}return Math.abs(sum);};
describe('3D volumetric spike with scripted colliders',()=>{
 it('falls, lands above table and keeps independently measured shell volume',()=>{
  const s=new ClaySolver(),initial=s.surfaceVolume();expect(initial).toBeGreaterThan(0.015);
  for(let i=0;i<240;i++)s.step(dt);
  expect(s.minY()).toBeGreaterThanOrEqual(0);
  expect(s.centerY()).toBeLessThan(0.205);
  expect(Math.abs(s.surfaceVolume()-initial)/initial).toBeLessThan(0.1);
 });
 it('has zero effect before contact; pressure leaves over 50% localized residual after 3 seconds',()=>{
  const a=new ClaySolver(),b=new ClaySolver();
  for(let i=0;i<20;i++){a.step(dt,[sphere(0,1,0,0.03)]);b.step(dt);}
  expect(a.positions).toEqual(b.positions);
  let peak=0,contacts=0;
  for(let i=0;i<120;i++){const y=i<80?0.48-i*0.0035:0.20;
    a.step(dt,[sphere(0.036,y,0.036,0.085)]);b.step(dt);contacts+=a.contactCount;
    peak=Math.max(peak,top(b)-top(a));
  }
  expect(contacts).toBeGreaterThan(0);expect(peak).toBeGreaterThan(0.02);
  for(let i=0;i<360;i++){a.step(dt);b.step(dt);}
  expect(top(b)-top(a)).toBeGreaterThan(peak*0.5);
 });
 it('acquires grasp only near surface; lifts and releases with volume error under 10%',()=>{
  const s=new ClaySolver();for(let i=0;i<240;i++)s.step(dt);
  const initial=s.surfaceVolume();
  for(let i=0;i<60;i++)s.step(dt,[sphere(1,0.4,0,0.05,true)]);
  expect(s.minY()).toBeLessThan(0.01);
  for(let i=0;i<120;i++)s.step(dt,[sphere(0.035,0.31+i*0.003,0.035,0.085,true)]);
  expect(s.minY()).toBeGreaterThan(0.1);
  expect(Math.abs(s.surfaceVolume()-initial)/initial).toBeLessThan(0.1);
  for(let i=0;i<240;i++)s.step(dt);
  expect(s.minY()).toBeLessThan(0.011);
  expect(Math.abs(s.surfaceVolume()-initial)/initial).toBeLessThan(0.1);
 });
 it('two near-surface anchors stretch rather than rigidly translate the whole mass',()=>{
  const s=new ClaySolver();for(let i=0;i<240;i++)s.step(dt);
  const right=sideVertex(s,1),left=sideVertex(s,-1);
  const startRight=s.positions[right],startLeft=s.positions[left];
  for(let i=0;i<120;i++)s.step(dt,[sphere(0.14+i*0.002,0.18,0,0.08,true,'right'),sphere(-0.14,0.18,0,0.08,true,'left')]);
  expect(s.positions[right]-startRight).toBeGreaterThan(0.15);
  expect(Math.abs(s.positions[left]-startLeft)).toBeLessThan(0.05);
 });
 it('opposing palm colliders compress locally and redistribute without deep penetration',()=>{
  // Width is measured in the band the palms squeeze: plastic clay escapes below them, near the table, as real clay does.
  const band=(s:ClaySolver)=>{const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(let i=0;i<s.positions.length;i+=3){if(Math.abs(s.positions[i+1]-0.16)>0.08)continue;for(let j=0;j<3;j++){lo[j]=Math.min(lo[j],s.positions[i+j]);hi[j]=Math.max(hi[j],s.positions[i+j]);}}return hi.map((v,j)=>v-lo[j]);};
  const s=new ClaySolver();for(let i=0;i<180;i++)s.step(dt);const start=band(s),volume=s.surfaceVolume();let contacts=0,minClearance=Infinity;
  for(let i=0;i<120;i++){
   const x=0.29-i*0.0013,colliders=[sphere(-x,0.16,0,0.12,false,'left'),sphere(x,0.16,0,0.12,false,'right')];
   s.step(dt,colliders);contacts+=s.contactCount;
   for(const c of colliders)for(let j=0;j<s.positions.length;j+=3)minClearance=Math.min(minClearance,Math.hypot(s.positions[j]-c.center[0],s.positions[j+1]-c.center[1],s.positions[j+2]-c.center[2])-c.radius);
  }
  const end=band(s);expect(contacts).toBeGreaterThan(0);expect(end[0]).toBeLessThan(start[0]);expect(end[2]).toBeGreaterThan(start[2]);
  expect(minClearance).toBeGreaterThan(-0.03*s.diameter);expect(Math.abs(s.surfaceVolume()-volume)/volume).toBeLessThan(0.1);
 });
 it('a small fingertip between coarse vertices still dents the face it presses',()=>{
  const s=new ClaySolver();for(let i=0;i<180;i++)s.step(dt);
  // Highest-facing top triangle: press straight down through its centroid, away from every vertex.
  let best=0,height=-Infinity;for(let k=0;k<s.indices.length;k+=3){const y=(s.positions[s.indices[k]*3+1]+s.positions[s.indices[k+1]*3+1]+s.positions[s.indices[k+2]*3+1])/3;if(y>height){height=y;best=k;}}
  const ids=[s.indices[best],s.indices[best+1],s.indices[best+2]],c=[0,1,2].map(j=>ids.reduce((sum,v)=>sum+s.positions[v*3+j],0)/3);
  const before=ids.map(v=>s.positions[v*3+1]);let contacts=0;
  for(let i=0;i<60;i++){s.step(dt,[sphere(c[0],c[1]+0.02-i*0.0004,c[2],0.02)]);contacts+=s.contactCount;}
  expect(contacts).toBeGreaterThan(0);
  expect(Math.max(...ids.map((v,j)=>before[j]-s.positions[v*3+1]))).toBeGreaterThan(0.008);
 });
 it('friction grows with pressure: a pressing palm drags the clay surface, a resting one glides',()=>{
  const drag=(depth:number)=>{const s=new ClaySolver();for(let i=0;i<180;i++)s.step(dt);
   let top=-1,y=-Infinity;for(const v of s.surfaceVertices)if(s.positions[v*3+1]>y){y=s.positions[v*3+1];top=v;}
   const x0=s.positions[top*3];
   // A flat palm on the top of the clay sliding +x at 0.3 m/s for 0.25 s.
   for(let i=0;i<30;i++){const x=-0.04+i*0.0025;s.step(dt,[{id:'palm',kind:'palm',center:[x-0.05,y+0.05-depth,0],end:[x+0.05,y+0.05-depth,0],radius:0.05,velocity:[0.3,0,0]}]);}
   return s.positions[top*3]-x0;};
  expect(drag(0.012)).toBeGreaterThan(drag(0)*1.5);
  expect(drag(0.012)).toBeGreaterThan(0.01);
 });
 it('a fingertip dent stays: most of it remains after release (clay, not jelly)',()=>{
  const s=new ClaySolver();for(let i=0;i<180;i++)s.step(dt);
  let target=-1,best=Infinity;for(const v of s.surfaceVertices){const i=v*3;const d=Math.hypot(s.positions[i],s.positions[i+1]-0.2);if(s.positions[i+2]>0&&d<best){best=d;target=v;}}
  const [x0,y0,z0]=[0,1,2].map(j=>s.positions[target*3+j]);
  for(let i=0;i<72;i++){const d=Math.min(1,i/54)*0.045;s.step(dt,[{id:'f',kind:'tip',center:[x0,y0,z0+0.038-d],radius:0.038,velocity:[0,0,i<54?-0.1:0]}]);}
  const peak=z0-s.positions[target*3+2];
  for(let i=0;i<240;i++)s.step(dt);
  const kept=z0-s.positions[target*3+2];
  console.log(JSON.stringify({fixture:'mouse-like-dent',peak,kept,ratio:kept/peak}));
  expect(peak).toBeGreaterThan(0.03);expect(kept/peak).toBeGreaterThan(0.6);
 });
 it('finger segment capsule responds only where the shaft overlaps the shell',()=>{
  const a=new ClaySolver(),b=new ClaySolver();
  const far:HandCollider={id:'shaft',kind:'segment',center:[-0.06,0.7,0],end:[0.06,0.7,0],radius:0.02,velocity:[0,0,0]};
  for(let i=0;i<30;i++){a.step(dt,[far]);b.step(dt);}expect(a.positions).toEqual(b.positions);
  const near:HandCollider={...far,center:[-0.06,0.35,0],end:[0.06,0.35,0],radius:0.05};let contacts=0;
  for(let i=0;i<80;i++){a.step(dt,[near]);contacts+=a.contactCount;}expect(contacts).toBeGreaterThan(0);
 });
 it('remains finite during a scripted 10-second deformation',()=>{
  const s=new ClaySolver();for(let i=0;i<1200;i++)s.step(dt,[sphere(0,0.32+Math.sin(i*0.03)*0.08,0,0.05)]);
  expect(s.surfaceVolume()).toBeGreaterThan(0);
 });
 it('survives 20 scripted fold cycles without persistent inversion or shell-volume loss',()=>{
  const s=new ClaySolver();for(let i=0;i<180;i++)s.step(dt);const initial=s.surfaceVolume(),smooth=new SurfaceSmoother(s.positions.length/3,s.indices),renderedInitial=meshVolume(smooth.update(s.positions),smooth.indices);let selfContacts=0,maxInverted=0,streak=0,maxStreak=0;
  for(let i=0;i<2400;i++){
   const q=(i%120)/120;
   s.step(dt,[sphere(0.12-0.26*q,0.29-0.1*q,0,0.085,true,'move'),sphere(-0.13,0.17,0,0.08,true,'hold')]);
   selfContacts+=s.selfContactCount;const inverted=s.invertedTetCount();maxInverted=Math.max(maxInverted,inverted);streak=inverted>0?streak+1:0;maxStreak=Math.max(maxStreak,streak);
  }
  for(let i=0;i<360;i++)s.step(dt);
  console.log(JSON.stringify({fixture:'fold-20',selfContacts,maxInverted,maxStreak}));
  expect(selfContacts).toBeGreaterThan(0);expect(maxStreak).toBeLessThan(12);
  expect(s.invertedTetCount()).toBe(0);
  expect(Math.abs(s.surfaceVolume()-initial)/initial).toBeLessThan(0.1);
  expect(Math.abs(meshVolume(smooth.update(s.positions),smooth.indices)-renderedInitial)/renderedInitial).toBeLessThan(0.1);
 },20000);
});
