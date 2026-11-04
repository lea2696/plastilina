import { spawnSync } from 'node:child_process';
const checks = ['assets:prepare','assets:verify','typecheck','lint','test','test:physics','test:topology','test:stability','test:audio','benchmark','build','audit:dist','test:e2e'];
const failures:string[]=[];
for (const name of checks) {
  const r = spawnSync('pnpm', [name], { stdio: 'inherit' });
  console.log(`${name}: ${r.status === 0 ? 'PASS' : 'FAIL'}`);
  if(r.status !== 0)failures.push(name);
}
console.log(`Automated checks: ${failures.length?`FAIL (${failures.join(', ')})`:'PASS'}`);
console.log('P0 validation: INCOMPLETE — real webcam/human contact and remote smoke pending even if automated checks pass; see docs/QA_REPORT.md');
if (failures.length) process.exitCode = 1;
