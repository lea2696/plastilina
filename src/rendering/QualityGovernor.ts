/** Changes only render resolution; physics state and hand inference never reset mid-interaction. */
export class QualityGovernor {
  factor=1;
  private lowSeconds=0;
  private highSeconds=0;
  sample(fps:number){
    if(!Number.isFinite(fps)||fps<=0)return this.factor;
    this.lowSeconds=fps<28?this.lowSeconds+1:0;
    this.highSeconds=fps>55?this.highSeconds+1:0;
    if(this.lowSeconds>=4){this.factor=Math.max(0.6,Math.round((this.factor-0.2)*10)/10);this.lowSeconds=0;this.highSeconds=0;}
    else if(this.highSeconds>=15){this.factor=Math.min(1,Math.round((this.factor+0.1)*10)/10);this.lowSeconds=0;this.highSeconds=0;}
    return this.factor;
  }
}
