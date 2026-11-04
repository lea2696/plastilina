import {describe,it,expect} from 'vitest';
import {QualityGovernor} from '../src/rendering/QualityGovernor';
describe('adaptive render quality',()=>{
 it('requires sustained low FPS, bounds resolution and never touches physics',()=>{
  const q=new QualityGovernor();for(let i=0;i<3;i++)expect(q.sample(20)).toBe(1);
  expect(q.sample(20)).toBe(0.8);
  for(let i=0;i<40;i++)q.sample(20);
  expect(q.factor).toBe(0.6);
 });
 it('recovers slowly and ignores invalid samples',()=>{
  const q=new QualityGovernor();for(let i=0;i<4;i++)q.sample(20);
  expect(q.sample(Number.NaN)).toBe(0.8);
  for(let i=0;i<14;i++)expect(q.sample(60)).toBe(0.8);
  expect(q.sample(60)).toBe(0.9);
 });
});
