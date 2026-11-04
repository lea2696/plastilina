import type { HandFrame } from '../shared/contracts';
/**
 * 'animation-frame' (default, Masa): grab the current video frame on every animation frame while no inference is pending.
 * 'video-frame' (opt-in, yoyó): grab each new camera frame exactly once through requestVideoFrameCallback, stamped with its
 * capture time when the browser reports it. A 30 fps camera polled at 60 Hz otherwise feeds the same frame twice, which reads
 * as a stopped hand followed by a doubled jump and breaks velocity-based gestures. Falls back to animation frames when unsupported.
 */
export interface CameraTrackingOptions { frameSync?: 'animation-frame'|'video-frame' }
export class CameraTracking {
 private stream?:MediaStream;private video=document.createElement('video');private worker?:Worker;private pending=false;private raf=0;private running=false;private stopped=false;
 private videoCallback=0;private lastStampMs=-Infinity;
 onFrame?:(frame:HandFrame,inferenceMs:number)=>void;onStatus?:(status:string)=>void;onError?:(message:string)=>void;
 constructor(private readonly options:CameraTrackingOptions={}){}
 async start(){
  this.stopped=false;
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Cámara no disponible: se requiere HTTPS y un navegador compatible.');
  this.onStatus?.('Solicitando permiso de cámara');
  const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'},audio:false});
  if(this.stopped){stream.getTracks().forEach(t=>t.stop());return;}
  this.stream=stream;
  this.video.srcObject=this.stream;this.video.muted=true;this.video.playsInline=true;await this.video.play();
  if(this.stopped)return;
  this.onStatus?.('Cargando modelo de manos');
  // This pinned MediaPipe runtime calls importScripts for WASM, requiring a classic worker.
  this.worker=new Worker(new URL('./hand.worker.ts',import.meta.url));
  this.worker.onmessage=(event:MessageEvent)=>{const d=event.data;
    if(d.kind==='ready'&&!this.stopped){this.running=true;this.onStatus?.('Cámara lista');if(this.syncToVideo)this.videoCallback=this.video.requestVideoFrameCallback(this.videoFrame);else this.tick();}
    if(d.kind==='result'){this.pending=false;this.onFrame?.(d.frame,d.inferenceMs);}
    if(d.kind==='error'){this.pending=false;this.onError?.(d.message);}
  };
  this.worker.onerror=(e)=>{this.pending=false;this.onError?.(e.message||'Falló el seguimiento de manos');};
  this.worker.postMessage({kind:'init'});
 }
 private get syncToVideo(){return this.options.frameSync==='video-frame'&&'requestVideoFrameCallback' in this.video;}
 private tick=()=>{
  if(!this.running)return;
  if(!this.pending&&this.video.readyState>=2&&document.visibilityState==='visible'){
    this.pending=true;createImageBitmap(this.video,{resizeWidth:640,resizeHeight:480}).then(bitmap=>{
      if(!this.running){bitmap.close();this.pending=false;return;}
      this.worker?.postMessage({kind:'frame',bitmap,timestampMs:performance.now()},[bitmap]);
    }).catch(e=>{this.pending=false;this.onError?.(String(e));});
  }
  this.raf=requestAnimationFrame(this.tick);
 };
 /** One inference in flight at most: a frame that arrives while the worker is busy is skipped, never queued. */
 private videoFrame=(now:number,metadata:VideoFrameCallbackMetadata)=>{
  if(!this.running)return;
  if(!this.pending&&document.visibilityState==='visible'){
    // MediaPipe's VIDEO mode needs strictly increasing timestamps; capture time keeps camera latency measurable.
    const timestampMs=Math.max(metadata.captureTime??now,this.lastStampMs+0.001);this.lastStampMs=timestampMs;
    this.pending=true;createImageBitmap(this.video,{resizeWidth:640,resizeHeight:480}).then(bitmap=>{
      if(!this.running){bitmap.close();this.pending=false;return;}
      this.worker?.postMessage({kind:'frame',bitmap,timestampMs},[bitmap]);
    }).catch(e=>{this.pending=false;this.onError?.(String(e));});
  }
  this.videoCallback=this.video.requestVideoFrameCallback(this.videoFrame);
 };
 stop(){this.stopped=true;this.running=false;cancelAnimationFrame(this.raf);if(this.videoCallback)this.video.cancelVideoFrameCallback(this.videoCallback);this.videoCallback=0;this.worker?.postMessage({kind:'close'});this.worker?.terminate();this.worker=undefined;this.stream?.getTracks().forEach(t=>t.stop());this.stream=undefined;this.video.srcObject=null;this.pending=false;this.onStatus?.('Cámara apagada');}
}
