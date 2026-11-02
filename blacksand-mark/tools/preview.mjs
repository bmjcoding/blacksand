// Renders the preview video and the still from the standalone demo (file://).
//   node tools/preview.mjs video [outdir]   1920x1080 @ 60 fps, two full cycles (703 frames),
//                                           opening at phase 0.6, mark 480 px; libx264 CRF 14.
//   node tools/preview.mjs still [outdir]   1600x1000 @ 2x, mark 440 px, phase 2.5, stream in front.
//   node tools/preview.mjs mark  [outdir]   blacksand_mark@2x.png from blacksand_mark_on_black.svg.
// Frames are written to a scratch directory (FRAMES env var, default /tmp/blacksand-frames).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { capture } from './capture.mjs';
import { TIMING, OPEN_PHASE, STATIC_PHASE } from '../blacksand-engine.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PKG = path.resolve(HERE, '..');
const what = process.argv[2] || 'video';
const out = process.argv[3] || PKG;
const FRAMES = process.env.FRAMES || path.join(os.tmpdir(), 'blacksand-frames');
fs.mkdirSync(out, { recursive: true });

if (what === 'video') {
  const fps = 60, n = Math.round(2 * TIMING.cycle * fps);        // 703: two cycles is the exact period
  if (Math.abs(n - 2 * TIMING.cycle * fps) > 1e-6) throw new Error('two cycles must be a whole number of frames');
  const times = Array.from({ length: n }, (_, i) => OPEN_PHASE + i / fps);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  await capture({ out: FRAMES, times, w: 1920, h: 1080, dpr: 1, mark: 480 });
  const mp4 = path.join(out, 'blacksand_hero_preview.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-i', path.join(FRAMES, 'f%05d.png'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  console.log(mp4, fs.statSync(mp4).size, 'bytes,', n, 'frames');
} else if (what === 'still') {
  const dir = path.join(FRAMES, 'still');
  await capture({ out: dir, times: [STATIC_PHASE], w: 1600, h: 1000, dpr: 2, mark: 440, layer: 'front' });
  fs.copyFileSync(path.join(dir, 'f00000.png'), path.join(out, 'blacksand_hero_still@2x.png'));
  console.log('blacksand_hero_still@2x.png');
} else if (what === 'mark') {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const html = path.join(FRAMES, 'mark.html');
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(html, `<body style="margin:0;background:#000"><img src="file://${PKG}/blacksand_mark_on_black.svg" style="width:1324px;height:1200px;display:block"></body>`);
  const p = await b.newPage({ viewport: { width: 1324, height: 1200 }, deviceScaleFactor: 2 });
  await p.goto('file://' + html);
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(out, 'blacksand_mark@2x.png') });
  await b.close();
  console.log('blacksand_mark@2x.png');
}
