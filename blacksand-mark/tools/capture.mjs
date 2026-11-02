// Deterministic frame capture: opens index.html from disk (file://), drives
// hero.renderAt(t) and dumps PNGs plus meta.json.
//
//   node tools/capture.mjs <outdir> <t0> <t1> <fps> <w> <h> <dpr> <mark> [debug] [layer]
//   node tools/capture.mjs <outdir> --times '[0.1,0.2]' <w> <h> <dpr> <mark> [debug] [layer]
//
// debug: comma list of layers to switch off (glow, particles, blur). layer: behind-sand | front | behind.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// playwright may be a global install (NODE_PATH), which ESM imports do not see
const { chromium } = createRequire(import.meta.url)('playwright');

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const INDEX = path.resolve(HERE, '..', 'index.html');

export async function capture({ out, times, w, h, dpr, mark, debug = '', layer = '', url, timing = false }) {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  // CAPTURE_QUERY adds page parameters, e.g. CAPTURE_QUERY=webgl=0 for the 2D glow fallback
  const q = `autoplay=0&dpr=${dpr}&mark=${mark}&debug=${debug}&layer=${layer}${timing ? '&profile' : ''}${process.env.CAPTURE_QUERY ? '&' + process.env.CAPTURE_QUERY : ''}`;
  await page.goto(url ? `${url}?${q}` : `file://${INDEX}?${q}`);
  await page.waitForFunction('window.heroReady === true');
  const meta = [];
  const B = 8;
  for (let i = 0; i < times.length; i += B) {
    const chunk = times.slice(i, i + B);
    const res = await page.evaluate(([ts, timing]) => ts.map((t) => {
      const t0 = performance.now();
      hero.renderAt(t);
      const ms = performance.now() - t0;
      const s = hero.state(t);
      return [document.getElementById('blacksand').toDataURL('image/png'),
        { t: s.t, ph: s.ph, rot: s.rot, omega: s.omega, fTop: s.fTop, fBot: s.fBot, peak: s.peak, crater: s.crater, pulse: s.pulse,
          g: s.grains.length, n: s.neckGrains.length, sp: s.splash.length, ro: s.rollers.length, col: s.column, ms: timing ? ms : undefined }];
    }), [chunk, timing]);
    res.forEach(([png, m], j) => {
      fs.writeFileSync(path.join(out, `f${String(i + j).padStart(5, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
      meta.push(m);
    });
  }
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta));
  if (timing) {
    const prof = await page.evaluate(() => hero.prof);
    if (prof) {
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
      console.log('section medians ms:', Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, +med(v).toFixed(2)])));
    }
  }
  await browser.close();
  if (errs.length) { console.error('ERRORS', errs); process.exit(1); }
  return meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const a = process.argv.slice(2);
  const out = a.shift();
  let times;
  if (a[0] === '--times') { a.shift(); times = JSON.parse(a.shift()); }
  else { const t0 = +a.shift(), t1 = +a.shift(), fps = +a.shift(); times = Array.from({ length: Math.round((t1 - t0) * fps) }, (_, i) => t0 + i / fps); }
  const [w, h, dpr, mark, debug = '', layer = ''] = a;
  const meta = await capture({ out, times, w: +w, h: +h, dpr: +dpr, mark: +mark, debug, layer, timing: true });
  const ms = meta.map((m) => m.ms).sort((x, y) => x - y);
  console.log('frames', meta.length, 'render ms median', ms[ms.length >> 1]?.toFixed(2), 'p95', ms[Math.floor(ms.length * 0.95)]?.toFixed(2));
}
