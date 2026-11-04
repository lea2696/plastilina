import type { HandFrame, Landmark } from '../shared/contracts';
/** Deterministic synthetic landmarks. This exercises the HandFrame path, not MediaPipe inference. */
export function replayHand(timestampMs:number):HandFrame{
 const t=timestampMs/1000,move=Math.sin(t*1.4)*0.035,press=Math.max(0,Math.sin(t*1.4))*0.045;
 const xy:[number,number][]=[
  [0.40,0.06],
  // Thumb held apart from the index so the demo presses rather than pinches.
  [0.43,0.12],[0.47,0.15],[0.50,0.19],[0.53,0.22],
  [0.43,0.16],[0.45,0.20],[0.46,0.24],[0.46,0.28+press],
  [0.40,0.15],[0.40,0.19],[0.40,0.23],[0.40,0.27],
  [0.37,0.16],[0.36,0.20],[0.36,0.24],[0.36,0.27],
  [0.34,0.18],[0.32,0.21],[0.31,0.24],[0.31,0.26]
 ];
 const points:Landmark[]=xy.map(([x,y])=>({x:x+move,y,z:-0.13}));
 return {timestampMs,source:'replay',hands:[{landmarks:points,handedness:'Right'}]};
}
export function replayTwoHands(timestampMs:number):HandFrame{
 const one=replayHand(timestampMs).hands[0];
 return {timestampMs,source:'replay',hands:[one,{landmarks:one.landmarks.map(p=>({...p,x:1-p.x})),handedness:'Left'}]};
}
