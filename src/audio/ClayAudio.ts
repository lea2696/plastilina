import type { ContactAudioEvent } from '../shared/contracts';
/** Shared graph for live and offline QA; a bounded sine body sound, not a recorded sample. */
export function scheduleContactVoice(context:BaseAudioContext,destination:AudioNode,e:ContactAudioEvent,now=context.currentTime){
 const duration=e.kind==='intro'?0.28:0.12;
 const osc=context.createOscillator(),gain=context.createGain();osc.type='sine';
 osc.frequency.setValueAtTime(e.kind==='land'?130:100+Math.min(100,e.intensity*70),now);
 osc.frequency.exponentialRampToValueAtTime(72,now+duration);
 gain.gain.setValueAtTime(0.0001,now);gain.gain.exponentialRampToValueAtTime(Math.max(0.002,Math.min(0.22,e.intensity*0.15)),now+0.014);gain.gain.exponentialRampToValueAtTime(0.0001,now+duration);
 osc.connect(gain).connect(destination);osc.start(now);osc.stop(now+duration+0.01);
 return {osc,gain};
}
export class ClayAudio {
 private context?:AudioContext;private master?:GainNode;private muted=false;private volume=1;private lastMs=0;private voices=0;
 unlock(){try{this.context??=new AudioContext();this.master??=this.context.createGain();this.master.gain.value=this.muted?0:0.12*this.volume;this.master.connect(this.context.destination);void this.context.resume();}catch{ /* audio failure does not block physics */ }}
 setMuted(muted:boolean){this.muted=muted;if(this.master)this.master.gain.value=muted?0:0.12*this.volume;}
 setVolume(volume:number){this.volume=Math.max(0,Math.min(1,volume));if(this.master)this.master.gain.value=this.muted?0:0.12*this.volume;}
 event(e:ContactAudioEvent){if(this.muted||!this.context||!this.master||this.voices>=3||e.timestampMs-this.lastMs<90)return;this.lastMs=e.timestampMs;
  const {osc,gain}=scheduleContactVoice(this.context,this.master,e);this.voices++;osc.onended=()=>{osc.disconnect();gain.disconnect();this.voices--;};
 }
 pause(){void this.context?.suspend();}resume(){void this.context?.resume();}
 close(){void this.context?.close();this.context=undefined;this.master=undefined;}
}
