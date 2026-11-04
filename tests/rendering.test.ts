import {describe,it,expect} from 'vitest';
import * as THREE from 'three';
import {ClaySolver} from '../src/simulation/ClaySolver';
import {SurfaceSmoother} from '../src/rendering/SurfaceSmoother';

describe('render surface buffer',()=>{
 it('keeps every display vertex finite, including unused interior physics vertices',()=>{
  const solver=new ClaySolver(),smoother=new SurfaceSmoother(solver.positions.length/3,solver.indices);
  for(let i=0;i<90;i++)solver.step(1/120);
  const positions=smoother.update(solver.positions);
  expect(Array.from(positions).every(Number.isFinite)).toBe(true);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setIndex(new THREE.BufferAttribute(smoother.indices,1));geometry.computeBoundingSphere();
  expect(Number.isFinite(geometry.boundingSphere!.radius)).toBe(true);
 });
});
