interface Stencil { ids:number[]; weights:number[] }
/** One Loop-subdivision level for display. Stencils follow material vertices; physics remains on the coarse volume. */
export class SurfaceSmoother {
 readonly indices:Uint32Array;readonly positions:Float32Array;private stencils:Stencil[];
 constructor(baseVertexCount:number,baseIndices:Uint32Array){
  const neighbors=Array.from({length:baseVertexCount},()=>new Set<number>());
  const edges=new Map<string,{a:number;b:number;opposites:number[];index:number}>();
  const edge=(a:number,b:number,opposite:number)=>{const x=Math.min(a,b),y=Math.max(a,b),key=`${x}:${y}`;let e=edges.get(key);if(!e){e={a:x,b:y,opposites:[],index:baseVertexCount+edges.size};edges.set(key,e);}e.opposites.push(opposite);neighbors[a].add(b);neighbors[b].add(a);return e.index;};
  const out:number[]=[];
  for(let i=0;i<baseIndices.length;i+=3){const a=baseIndices[i],b=baseIndices[i+1],c=baseIndices[i+2],ab=edge(a,b,c),bc=edge(b,c,a),ca=edge(c,a,b);out.push(a,ab,ca,ab,b,bc,ca,bc,c,ab,bc,ca);}
  this.stencils=[];
  for(let i=0;i<baseVertexCount;i++){const adjacent=[...neighbors[i]],n=adjacent.length;
    if(n===0){this.stencils.push({ids:[i],weights:[1]});continue;}
    const beta=n===3?3/16:3/(8*n);this.stencils.push({ids:[i,...adjacent],weights:[1-n*beta,...adjacent.map(()=>beta)]});}
  for(const e of edges.values()){const [o1,o2]=e.opposites;this.stencils[e.index]=o2===undefined?{ids:[e.a,e.b],weights:[0.5,0.5]}:{ids:[e.a,e.b,o1,o2],weights:[3/8,3/8,1/8,1/8]};}
  this.indices=new Uint32Array(out);this.positions=new Float32Array(this.stencils.length*3);
 }
 update(base:Float32Array){const output=this.positions;for(let v=0;v<this.stencils.length;v++){const stencil=this.stencils[v],j=v*3;for(let axis=0;axis<3;axis++){let sum=0;for(let k=0;k<stencil.ids.length;k++)sum+=base[stencil.ids[k]*3+axis]*stencil.weights[k];output[j+axis]=sum;}}return output;}
}
