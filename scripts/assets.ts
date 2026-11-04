import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const mode = process.argv[2];
if (!['prepare', 'verify'].includes(mode ?? '')) throw new Error('Use prepare or verify');
interface Asset { id:string; path:string; sourceUrl:string; sha256:string; type:string }
const manifest = JSON.parse(fs.readFileSync('assets/manifest.json', 'utf8')) as {assets: Asset[]};
for (const asset of manifest.assets) {
  if (!asset.path.startsWith('public/') || asset.path.includes('..')) throw new Error(`Unsafe asset path: ${asset.path}`);
  if (!fs.existsSync(asset.path) && mode === 'prepare') {
    fs.mkdirSync(path.dirname(asset.path),{recursive:true});
    if(asset.sourceUrl.startsWith('npm:')) {
      const name=path.basename(asset.path);
      fs.copyFileSync(`node_modules/@mediapipe/tasks-vision/wasm/${name}`,asset.path);
    } else if(asset.sourceUrl.startsWith('https://storage.googleapis.com/mediapipe-models/')) {
      const response=await fetch(asset.sourceUrl);if(!response.ok)throw new Error(`Download failed: ${asset.id}: ${response.status}`);
      fs.writeFileSync(asset.path,Buffer.from(await response.arrayBuffer()));
    } else throw new Error(`Unapproved source: ${asset.id}`);
  }
  if (!fs.existsSync(asset.path)) throw new Error(`Missing asset: ${asset.path}; run pnpm assets:prepare`);
  const data = fs.readFileSync(asset.path);
  if (data.subarray(0, 100).toString().toLowerCase().includes('<!doctype html')) throw new Error(`HTML instead of asset: ${asset.path}`);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== asset.sha256) throw new Error(`SHA-256 mismatch: ${asset.path}`);
}
console.log(`${mode}: verified ${manifest.assets.length} manifest assets`);
