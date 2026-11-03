// Renders the preview video and the still from the standalone demo (file://).
//   node tools/preview.mjs video [outdir]   (default: media/blacksand-hero.mp4)   1920x1080 @ 60 fps, two full cycles (703 frames),
//                                           opening at phase 0.6, mark 480 px; libx264 -tune grain CRF 14, full range.
//   node tools/preview.mjs still [outdir]   1600x1000 @ 2x, mark 440 px: the static logo frame (the
//                                           still / reduced-motion look: static line, glow at rest).
//   node tools/preview.mjs poster [outdir]  1600x1000 @ 2x, mark 440 px: the first played frame.
//   node tools/preview.mjs mark  [outdir]   logo/blacksand-mark@2x.png: the default mark, transparent, 1024 px wide.
// Frames are written to a scratch directory (FRAMES env var, default /tmp/blacksand-frames).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { capture } from './capture.mjs';
import { TIMING, OPEN_PHASE, STATIC_PHASE } from '../hero/blacksand-engine.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PKG = path.resolve(HERE, '..');
const what = process.argv[2] || 'video';
const out = process.argv[3] || null;      // default: media/ (video, still, poster) or logo/ (mark)
const FRAMES = process.env.FRAMES || path.join(os.tmpdir(), 'blacksand-frames');
const dest = (d) => { const o = out || path.join(PKG, d); fs.mkdirSync(o, { recursive: true }); return o; };

if (what === 'video') {
  const fps = 60, n = Math.round(2 * TIMING.cycle * fps);        // 703: two cycles is the exact period
  if (Math.abs(n - 2 * TIMING.cycle * fps) > 1e-6) throw new Error('two cycles must be a whole number of frames');
  const times = Array.from({ length: n }, (_, i) => OPEN_PHASE + i / fps);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  await capture({ out: FRAMES, times, w: 1920, h: 1080, dpr: 1, mark: 480 });
  const mp4 = path.join(dest('media'), 'blacksand-hero.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-i', path.join(FRAMES, 'f%05d.png'),
    // full-range 8-bit: limited range squeezes 256 levels into 220 luma steps, which flattens the
    // dither and bands the glow's long halo; tagged BT.709 so decoders do not guess
    '-vf', 'scale=out_range=full:sws_flags=accurate_rnd+full_chroma_int,format=yuvj420p',
    '-c:v', 'libx264', '-preset', 'slow', '-tune', 'grain', '-crf', '14',
    '-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  console.log(mp4, fs.statSync(mp4).size, 'bytes,', n, 'frames');
} else if (what === 'still') {
  const dir = path.join(FRAMES, 'still');
  // the static logo frame (the still / reduced-motion look): static line, the glow at rest
  await capture({ out: dir, times: [STATIC_PHASE], w: 1600, h: 1000, dpr: 2, mark: 440, layer: 'front', debug: 'breath' });
  fs.copyFileSync(path.join(dir, 'f00000.png'), path.join(dest('media'), 'blacksand-hero-still@2x.png'));
  console.log('media/blacksand-hero-still@2x.png');
} else if (what === 'poster') {
  // the hero's poster: exactly the first frame the animation plays (no pop on play)
  const dir = path.join(FRAMES, 'poster');
  await capture({ out: dir, times: [OPEN_PHASE], w: 1600, h: 1000, dpr: 2, mark: 440 });
  fs.copyFileSync(path.join(dir, 'f00000.png'), path.join(dest('media'), 'blacksand-hero-poster@2x.png'));
  console.log('media/blacksand-hero-poster@2x.png');
} else if (what === 'mark') {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const html = path.join(FRAMES, 'mark.html');
  fs.mkdirSync(FRAMES, { recursive: true });
  // the default mark (no glow), transparent background, 1024 px wide at 2x
  fs.writeFileSync(html, `<body style="margin:0;background:transparent"><img src="file://${PKG}/logo/blacksand-mark.svg" style="width:512px;display:block"></body>`);
  const p = await b.newPage({ viewport: { width: 512, height: Math.round(512 * 772 / 944) }, deviceScaleFactor: 2 });
  await p.goto('file://' + html);
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(dest('logo'), 'blacksand-mark@2x.png'), omitBackground: true });
  await b.close();
  console.log('logo/blacksand-mark@2x.png');
}
