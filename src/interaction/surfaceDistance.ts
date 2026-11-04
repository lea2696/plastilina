import type { Vec3 } from '../shared/contracts';

/** Distance to the closed physical shell, including face interiors between coarse vertices. */
export function surfaceDistance(point:Vec3,positions:Float32Array,indices?:Uint32Array):number {
  let minimum=Infinity;
  const segmentDistance=(a:number,b:number)=>{
    const x=positions[a],y=positions[a+1],z=positions[a+2];
    const ux=positions[b]-x,uy=positions[b+1]-y,uz=positions[b+2]-z;
    const den=ux*ux+uy*uy+uz*uz;
    const t=den>1e-12?Math.max(0,Math.min(1,((point[0]-x)*ux+(point[1]-y)*uy+(point[2]-z)*uz)/den)):0;
    return (point[0]-x-t*ux)**2+(point[1]-y-t*uy)**2+(point[2]-z-t*uz)**2;
  };
  if(!indices){
    for(let i=0;i<positions.length;i+=3)minimum=Math.min(minimum,(point[0]-positions[i])**2+(point[1]-positions[i+1])**2+(point[2]-positions[i+2])**2);
  }else for(let k=0;k<indices.length;k+=3){
    const a=indices[k]*3,b=indices[k+1]*3,c=indices[k+2]*3;
    const ux=positions[b]-positions[a],uy=positions[b+1]-positions[a+1],uz=positions[b+2]-positions[a+2];
    const vx=positions[c]-positions[a],vy=positions[c+1]-positions[a+1],vz=positions[c+2]-positions[a+2];
    const wx=point[0]-positions[a],wy=point[1]-positions[a+1],wz=point[2]-positions[a+2];
    const uu=ux*ux+uy*uy+uz*uz,uv=ux*vx+uy*vy+uz*vz,vv=vx*vx+vy*vy+vz*vz;
    const wu=wx*ux+wy*uy+wz*uz,wv=wx*vx+wy*vy+wz*vz,den=uu*vv-uv*uv;
    if(den>1e-14){
      const s=(wu*vv-wv*uv)/den,t=(wv*uu-wu*uv)/den;
      if(s>=0&&t>=0&&s+t<=1){minimum=Math.min(minimum,(wx-s*ux-t*vx)**2+(wy-s*uy-t*vy)**2+(wz-s*uz-t*vz)**2);continue;}
    }
    minimum=Math.min(minimum,segmentDistance(a,b),segmentDistance(b,c),segmentDistance(c,a));
  }
  return Math.sqrt(minimum);
}

/**
 * Distance from point along −z (into the studio, away from the viewer) to the closed shell.
 * Returns −1 when the point is already inside (odd number of crossings), Infinity on a miss.
 */
export function depthToSurface(point:Vec3,positions:Float32Array,indices:Uint32Array):number {
  const [px,py,pz]=point;let nearest=Infinity,crossings=0;
  for(let k=0;k<indices.length;k+=3){
    const a=indices[k]*3,b=indices[k+1]*3,c=indices[k+2]*3;
    // Barycentric test of (px,py) in the triangle projected onto the xy plane.
    const ax=positions[a],ay=positions[a+1],bx=positions[b],by=positions[b+1],cx=positions[c],cy=positions[c+1];
    const den=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy);
    if(Math.abs(den)<1e-12)continue;
    const u=((by-cy)*(px-cx)+(cx-bx)*(py-cy))/den,v=((cy-ay)*(px-cx)+(ax-cx)*(py-cy))/den,w=1-u-v;
    if(u<0||v<0||w<0)continue;
    const t=pz-(u*positions[a+2]+v*positions[b+2]+w*positions[c+2]);
    if(t<0)continue;
    crossings++;nearest=Math.min(nearest,t);
  }
  return crossings%2===1?-1:nearest;
}
