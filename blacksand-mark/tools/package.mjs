// Packs the blacksand-mark folder into dist/blacksand-mark.zip (dist/ is not committed).
//   node tools/package.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = path.dirname(PKG), DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });
const zip = path.join(DIST, 'blacksand-mark.zip');
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, path.basename(PKG), '-x', '*/tools/.build/*', '*/node_modules/*', '*.pyc'], { cwd: ROOT, stdio: 'inherit' });
console.log(path.relative(ROOT, zip), fs.statSync(zip).size, 'bytes');
