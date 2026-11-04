import {describe,it,expect} from 'vitest';
import {HandMapper} from '../src/interaction/HandMapper';
import {HandInteraction} from '../src/interaction/HandInteraction';
import {PointerTool} from '../src/interaction/PointerTool';
import {replayHand} from '../src/diagnostics/replay';
import {ClaySolver} from '../src/simulation/ClaySolver';
import type {MappedHand,Vec3} from '../src/shared/contracts';
describe('synthetic HandFrame path',()=>{
 it('maps a replay, mirrors once and expires stale hands',()=>{const m=new HandMapper(),f=replayHand(100);m.calibrate(f);const h=m.consume(f);expect(h).toHaveLength(1);expect(h[0].points).toHaveLength(21);expect(m.fresh(281)).toHaveLength(0);});
 it('rejects out-of-order frames and avoids array-index-only identity',()=>{const m=new HandMapper();const f=replayHand(100);const a=m.consume(f);expect(m.consume(f)).toHaveLength(0);const next=replayHand(120);next.hands=[...next.hands];const b=m.consume(next);expect(b[0].id).toBe(a[0].id);});
 it('does not grasp at distance from surface',()=>{const m=new HandMapper();const hands=m.consume(replayHand(100));const surface=new Float32Array([5,5,5]);const v=new HandInteraction().build(100,hands,surface);expect(v.colliders.some(c=>c.grasp)).toBe(false);});
 it('keeps two identities when result array order swaps, then drops stale forces',()=>{
  const m=new HandMapper();const left=replayHand(100).hands[0],right=replayHand(100).hands[0];
  const shift=(h:typeof left,dx:number,label:'Left'|'Right')=>({landmarks:h.landmarks.map(p=>({...p,x:p.x+dx})),handedness:label});
  const a=m.consume({timestampMs:100,source:'replay',hands:[shift(left,-0.15,'Left'),shift(right,0.15,'Right')]});
  const b=m.consume({timestampMs:116,source:'replay',hands:[shift(right,0.15,'Right'),shift(left,-0.15,'Left')]});
  expect(b.map(h=>h.id)).toEqual([a[1].id,a[0].id]);
  expect(m.fresh(297)).toHaveLength(0);
 });
 it('releases a missing hand immediately and never transfers a grasp on ambiguous crossing',()=>{
  const m=new HandMapper(),base=replayHand(100).hands[0];
  const at=(x:number)=>({...base,landmarks:base.landmarks.map(p=>({...p,x:p.x+x})),handedness:'Unknown' as const});
  const first=m.consume({timestampMs:100,source:'replay',hands:[at(-0.12),at(0.12)]});
  expect(first).toHaveLength(2);
  const one=m.consume({timestampMs:116,source:'replay',hands:[at(-0.12)]});
  expect(one.map(h=>h.id)).toEqual([first[0].id]);
  expect(m.fresh(117).map(h=>h.id)).toEqual([first[0].id]);
  const second=m.consume({timestampMs:132,source:'replay',hands:[at(0.12)]});
  expect(second[0].id).not.toBe(first[1].id);
  const crossing=new HandMapper();const before=crossing.consume({timestampMs:100,source:'replay',hands:[at(-0.12),at(0.12)]});
  const ambiguous=crossing.consume({timestampMs:116,source:'replay',hands:[at(0),at(0.01)]});
  expect(ambiguous.some(h=>before.some(old=>old.id===h.id))).toBe(false);
 });
 it('reduces deterministic static landmark jitter without excessive step lag',()=>{
  const m=new HandMapper();let seed=19;const noise=()=>{seed=(seed*1664525+1013904223)>>>0;return (seed/4294967296-0.5)*0.018;};
  const raw:number[]=[],smoothed:number[]=[];const base=replayHand(100).hands[0];const baseline=(0.5-base.landmarks[0].x)*1.0;
  for(let i=0;i<120;i++){
   const n=noise();const frame={timestampMs:100+i*16,source:'replay' as const,hands:[{...base,landmarks:base.landmarks.map(p=>({...p,x:p.x+n}))}]};
   const h=m.consume(frame)[0];if(i>15){raw.push(n*1.0);smoothed.push(h.points[0][0]-baseline);}
  }
  const rms=(v:number[])=>Math.sqrt(v.reduce((s,x)=>s+x*x,0)/v.length);
  const reduction=1-rms(smoothed)/rms(raw);expect(reduction).toBeGreaterThan(0.2);
  const next={timestampMs:2020,source:'replay' as const,hands:[{...base,landmarks:base.landmarks.map(p=>({...p,x:p.x+0.08}))}]};
  const h=m.consume(next)[0];const response=(baseline-h.points[0][0])/(0.08*1.0);
  console.log(JSON.stringify({fixture:'seeded-static-jitter',rmsReduction:reduction,oneFrameStepResponse:response}));
  expect(h.points[0][0]).toBeLessThan(baseline-0.08*0.4);
 });
 // Collapsed pose: every landmark at one point, so thumb and finger tips touch (a closed pinch).
 const pose=(y:number,opened=false,id='stable-hand',z=0.16):MappedHand=>{const points:Vec3[]=Array.from({length:21},()=>[0,y,z] as Vec3);if(opened)points[4]=[0.16,y,z];return {id,timestampMs:100,points,handedness:'Right',state:'free'};};
 it('releases a synthetic grasp on stale signal and cannot reacquire remotely',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  const interaction=new HandInteraction();
  expect(interaction.build(100,[pose(0.2)],solver.positions,solver.indices).colliders.some(c=>c.grasp)).toBe(true);
  expect(interaction.build(281,[pose(0.2)],solver.positions,solver.indices).colliders).toHaveLength(0);
  expect(interaction.isGrasping('stable-hand')).toBe(false);
  const far=interaction.build(400,[{...pose(0.75),timestampMs:400}],solver.positions,solver.indices);
  expect(far.colliders.some(c=>c.grasp)).toBe(false);
 });
 it('keeps a surface-acquired pinch while lifting, then releases on opening or hand loss',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  const interaction=new HandInteraction();
  expect(interaction.build(100,[pose(0.2)],solver.positions).colliders.some(c=>c.grasp)).toBe(true);
  expect(interaction.isGrasping('stable-hand')).toBe(true);
  expect(interaction.build(116,[pose(0.55)],solver.positions).colliders.some(c=>c.grasp)).toBe(true);
  // A single open frame is treated as tracking flicker; staying open past 150 ms releases.
  expect(interaction.build(132,[pose(0.55,true)],solver.positions).colliders.some(c=>c.grasp)).toBe(true);
  expect(interaction.build(300,[{...pose(0.55,true),timestampMs:300}],solver.positions).colliders.some(c=>c.grasp)).toBe(false);
  expect(interaction.isGrasping('stable-hand')).toBe(false);
  interaction.build(316,[{...pose(0.2),timestampMs:316}],solver.positions);
  interaction.build(332,[],solver.positions);
  expect(interaction.isGrasping('stable-hand')).toBe(false);
 });
 it('does not let the pinching thumb and finger push away the clay they hold',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  const frame=new HandInteraction().build(100,[pose(0.2)],solver.positions);
  const ids=frame.colliders.map(c=>c.id);
  expect(ids).toContain('stable-hand-grasp');
  expect(ids).not.toContain('stable-hand-tip-4');
  expect(ids.some(id=>/segment-\d+-4$/.test(id))).toBe(false);
  expect(ids).toContain('stable-hand-tip-20');
 });
 it('grabs with a closed fist on the clay and drops every solid of that hand',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  // Fingertips curled back next to the knuckles, thumb tucked away from the index.
  const points:Vec3[]=Array.from({length:21},(_,i)=>[0,0.2+(i>=5?0.06:0.02),0.17] as Vec3);
  points[0]=[0,0.12,0.17];points[4]=[0.08,0.2,0.17];points[5]=[0.03,0.2,0.17];points[17]=[-0.04,0.2,0.17];
  for(const tip of [8,12,16,20])points[tip]=[0,0.19,0.17];
  const frame=new HandInteraction().build(100,[{id:'fist',timestampMs:100,points,handedness:'Right',state:'free'}],solver.positions);
  const grasp=frame.colliders.find(c=>c.grasp);
  expect(grasp?.radius).toBeGreaterThan(0.06);
  expect(frame.colliders.filter(c=>!c.grasp)).toHaveLength(0);
 });
 it('maps a larger apparent hand deeper into the studio at constant virtual size',()=>{
  const m=new HandMapper(),base=replayHand(100);m.calibrate(base);
  const near=(scale:number,t:number)=>({timestampMs:t,source:'replay' as const,hands:[{...base.hands[0],landmarks:base.hands[0].landmarks.map(p=>({x:0.4+(p.x-0.4)*scale,y:0.06+(p.y-0.06)*scale,z:p.z}))}]});
  const resting=new HandMapper();resting.calibrate(base);const a=resting.consume(near(1,100))[0];
  const closer=new HandMapper();closer.calibrate(base);const b=closer.consume(near(1.3,100))[0];
  expect(b.points[0][2]).toBeLessThan(a.points[0][2]-0.2);
  const span=(h:MappedHand)=>Math.hypot(h.points[0][0]-h.points[9][0],h.points[0][1]-h.points[9][1]);
  expect(Math.abs(span(a)-span(b))).toBeLessThan(0.005);
  expect(a.points[0][2]).toBeGreaterThan(0.25);
 });
 it('depth assist sets a hand hovering just in front of the clay onto its surface, without pressing it',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  let front=-Infinity;for(const v of solver.surfaceVertices){const i=v*3;if(Math.abs(solver.positions[i])<0.04&&Math.abs(solver.positions[i+1]-0.18)<0.04)front=Math.max(front,solver.positions[i+2]);}
  // Open flat hand spread along x, thumb held well away from the fingers (no grab intent).
  const open=(z:number):MappedHand=>{const points=Array.from({length:21},(_,i)=>[(i-10)*0.012,0.18,z] as Vec3);points[4]=[-0.1,0.36,z];points[3]=[-0.1,0.3,z];return {id:'open',timestampMs:100,points,handedness:'Right',state:'free'};};
  const near=new HandInteraction();let frame=near.build(100,[open(front+0.09)],solver.positions,solver.indices);
  for(let i=0;i<8;i++)frame=near.build(100,[open(front+0.09)],solver.positions,solver.indices);
  // Moved in until its nearest solid part (here the wide palm) rests on the surface.
  expect(frame.hands[0].points[12][2]).toBeLessThan(front+0.09-0.02);
  solver.step(1/120,frame.colliders);
  expect(solver.contactCount).toBe(0);
  expect([...solver.contactColliderIds].some(id=>id.startsWith('open-'))).toBe(true);
  const far=new HandInteraction();let away=far.build(100,[open(front+0.3)],solver.positions,solver.indices);
  for(let i=0;i<8;i++)away=far.build(100,[open(front+0.3)],solver.positions,solver.indices);
  expect(away.hands[0].points[12][2]).toBeCloseTo(front+0.3,6);
 });
 it('a pinch closed 12 cm in front of the clay, with noisy finger depth, is set on it and grabs',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  let front=-Infinity;for(const v of solver.surfaceVertices){const i=v*3;if(Math.abs(solver.positions[i])<0.04&&Math.abs(solver.positions[i+1]-0.2)<0.04)front=Math.max(front,solver.positions[i+2]);}
  const z=front+0.12;
  const points=Array.from({length:21},(_,i)=>[(i-10)*0.012,0.12,z] as Vec3);
  points[4]=[0,0.2,z+0.03];points[8]=[0.01,0.2,z-0.03];// touching in the image, 6 cm apart in estimated depth
  const interaction=new HandInteraction();let grabbed=false;
  for(let i=0;i<10&&!grabbed;i++)grabbed=interaction.build(100,[{id:'pinch',timestampMs:100,points,handedness:'Right',state:'free'}],solver.positions,solver.indices).colliders.some(c=>c.grasp);
  expect(grabbed).toBe(true);
  for(let i=0;i<10;i++)solver.step(1/120,interaction.build(100,[{id:'pinch',timestampMs:100,points,handedness:'Right',state:'free'}],solver.positions,solver.indices).colliders);
  expect(solver.hasGrasp('pinch-grasp')).toBe(true);
 });
 it('releases a pinch when it opens clearly beyond how closed it was at grab time',()=>{
  const solver=new ClaySolver();for(let i=0;i<180;i++)solver.step(1/120);
  const hand=(gap:number,t:number):MappedHand=>{const points=Array.from({length:21},(_,i)=>[(i-10)*0.012,0.12,0.16] as Vec3);points[4]=[0,0.2,0.16];points[8]=[gap,0.2,0.16];return {id:'loose',timestampMs:t,points,handedness:'Right',state:'free'};};
  const interaction=new HandInteraction();
  expect(interaction.build(100,[hand(0.01,100)],solver.positions,solver.indices).colliders.some(c=>c.grasp)).toBe(true);
  // 2 cm wider than at grab: still held. 5 cm wider (past gapAtGrab + 3 cm) for over 150 ms: released.
  expect(interaction.build(120,[hand(0.03,120)],solver.positions,solver.indices).colliders.some(c=>c.grasp)).toBe(true);
  interaction.build(140,[hand(0.06,140)],solver.positions,solver.indices);
  expect(interaction.build(320,[hand(0.06,320)],solver.positions,solver.indices).colliders.some(c=>c.grasp)).toBe(false);
 });
 it('mouse tool starts at the clicked surface, presses progressively and grabs as a grip',()=>{
  const tool=new PointerTool(),cast=()=>({origin:[0,0.5,1] as Vec3,direction:[0,0,-1] as Vec3});
  tool.begin('press',[0,0],0.8,0);
  const first=tool.collider(0,cast)!,later=tool.collider(600,cast)!;
  expect(first.grasp).toBeFalsy();expect(later.center[2]).toBeLessThan(first.center[2]-0.05);
  tool.end();expect(tool.collider(700,cast)).toBeUndefined();
  tool.begin('grab',[0,0],0.8,0);const grab=tool.collider(0,cast)!;
  expect(grab.grasp).toBe(true);expect(grab.center[2]).toBeCloseTo(0.2,5);
 });
});
