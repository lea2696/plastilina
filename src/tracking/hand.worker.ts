import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandFrame } from '../shared/contracts';
let landmarker:HandLandmarker|undefined;
self.onmessage=async(event:MessageEvent<{kind:'init'}|{kind:'frame';bitmap:ImageBitmap;timestampMs:number}|{kind:'close'}>)=>{
  const data=event.data;
  try {
    if(data.kind==='init'){
      const fileset=await FilesetResolver.forVisionTasks('/vendor/mediapipe');
      landmarker=await HandLandmarker.createFromOptions(fileset,{baseOptions:{modelAssetPath:'/vendor/mediapipe/hand_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numHands:2});
      self.postMessage({kind:'ready'});
    } else if(data.kind==='frame'){
      try {
        if(!landmarker)throw new Error('Landmarker not ready');
        const t0=performance.now();const result=landmarker.detectForVideo(data.bitmap,data.timestampMs);
        const frame:HandFrame={timestampMs:data.timestampMs,source:'camera',hands:result.landmarks.map((landmarks,i)=>({landmarks:landmarks.map(p=>({x:p.x,y:p.y,z:p.z})),handedness:(result.handedness[i]?.[0]?.categoryName as 'Left'|'Right'|undefined)??'Unknown',handednessScore:result.handedness[i]?.[0]?.score}))};
        self.postMessage({kind:'result',frame,inferenceMs:performance.now()-t0});
      } finally {data.bitmap.close();}
    } else {landmarker?.close();landmarker=undefined;self.close();}
  } catch(error){self.postMessage({kind:'error',message:error instanceof Error?error.message:String(error)});if(data.kind==='frame')data.bitmap.close();}
};
