import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
const root='dist';
const files:string[]=[];
const walk=(p:string)=>{for(const name of readdirSync(p)){const path=join(p,name);if(statSync(path).isDirectory())walk(path);else files.push(path);}};
walk(root);
const patterns=[/VERCEL_OIDC_TOKEN/i,/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,/sk-[A-Za-z0-9]{20,}/,/\/Users\/luisalvarez/,/api[_-]?key\s*[:=]/i];
const flagged=files.filter(p=>patterns.some(q=>q.test(readFileSync(p).toString('latin1'))));
const bytes=(predicate:(path:string)=>boolean)=>files.filter(predicate).reduce((n,p)=>n+statSync(p).size,0);
const simd=bytes(p=>!p.includes('nosimd'));
const noSimd=bytes(p=>!p.includes('vision_wasm_internal.'));
// Both pages (Masa at /, yoyó at /yoyo) must ship with their CSP and with every asset they reference.
const page=(name:string)=>{const path=join(root,name);const html=existsSync(path)?readFileSync(path,'utf8'):'';const refs=[...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map(m=>m[1]);return {present:!!html,csp:html.includes('Content-Security-Policy'),missingRefs:refs.filter(r=>!existsSync(join(root,r)))};};
const pages={'index.html':page('index.html'),'yoyo.html':page('yoyo.html')};
const report={kind:'static-dist-audit',files:files.length,maxVariantRawMiB:Math.max(simd,noSimd)/1048576,flaggedFiles:flagged.map(p=>relative(root,p)),containsModel:files.some(p=>p.endsWith('hand_landmarker.task')),pages};
console.log(JSON.stringify(report,null,2));
const pageProblems=Object.values(pages).some(p=>!p.present||!p.csp||p.missingRefs.length>0);
if(flagged.length||!report.containsModel||report.maxVariantRawMiB>35||pageProblems)process.exitCode=1;
