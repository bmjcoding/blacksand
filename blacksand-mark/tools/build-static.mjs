// Builds the static backlit logo SVGs from the same engine state the still frame uses
// (STATIC_PHASE, stream in front), plus geom.json for the QA suite and the mark fragment
// for the lockups.
//   node tools/build-static.mjs [outdir]
import fs from 'node:fs';
import { createGeometry, createChambers, createSim, STATIC_PHASE, STREAM, TIMING, PULSE_CREST } from '../blacksand-engine.js';

const out = process.argv[2] || new URL('..', import.meta.url).pathname;
const G = createGeometry(process.env.NECK ? { neck: +process.env.NECK } : {}), C = createChambers(G);
const st = createSim(G, C, 7).stateAt(STATIC_PHASE);
const { ix, iy, R, H, L, T } = G;
const f = (v) => (Math.round(v * 100) / 100).toString();
const P = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';

// palette: identical to blacksand-hero.js PALETTE
const etchTop = '#262626', etchBot = '#4a4a4a', sandTop = '#363636', sandBot = '#5e5e5e';
const STREAM_RGB = [92, 150], GLINT = 190, GRAIN_A = 0.5;

const arc = (a, b) => `A${f(R)} ${f(R)} 0 0 1 ${f(b[0])} ${f(b[1])}`;
const chamberTop = `M${f(G.NL[0])} ${f(G.NL[1])}L${f(G.tl[0])} ${f(G.tl[1])}${arc(G.tl, G.tr)}L${f(G.NR[0])} ${f(G.NR[1])}Z`;
const chamberBot = `M${f(G.NR[0])} ${f(G.NR[1])}L${f(G.br[0])} ${f(G.br[1])}${arc(G.br, G.bl)}L${f(G.NL[0])} ${f(G.NL[1])}Z`;

function surface(fn) { const pts = []; for (let x = ix - R - 24; x <= ix + R + 24 + 1e-6; x += 1.5) pts.push([x, fn(x)]); return pts; }
const topSurf = surface((x) => C.crater(st.crater, x));
const botSurf = surface((x) => C.mound(st.peak, x));
const below = (pts) => P([...pts, [ix + R + 24, iy + R + 60], [ix - R - 24, iy + R + 60]]);
const line = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L');
const edgeTop = Math.min(1, (1 - st.fTop) / 0.12, st.fTop / 0.04);
const edgeBot = Math.min(1, st.fBot / 0.06, (1 - st.fBot) / 0.04);
if (st.fTop <= 0 || st.fTop >= 1 || st.fBot <= 0 || st.fBot >= 1 || st.rot !== 0) throw new Error('STATIC_PHASE must be an upright mid-pour frame');

// grains, binned like the canvas renderer
const BINS = 6, SB = 3, { rMin, rMax } = STREAM;
function binned(list0) {
  const buckets = Array.from({ length: (BINS + 1) * SB }, () => []);
  for (const gr of list0) {
    const tb = gr.shade > 1 ? BINS : Math.min(BINS - 1, Math.floor(gr.shade * BINS));
    const sb = Math.min(SB - 1, Math.floor(((gr.r - rMin) / (rMax - rMin)) * SB));
    buckets[tb * SB + sb].push(gr);
  }
  let out = '';
  for (let tb = 0; tb <= BINS; tb++) {
    const c = tb === BINS ? GLINT : Math.round(STREAM_RGB[0] + (STREAM_RGB[1] - STREAM_RGB[0]) * ((tb + 0.5) / BINS));
    for (let sb = 0; sb < SB; sb++) {
      const list = buckets[tb * SB + sb];
      if (!list.length) continue;
      const w = 2 * (rMin + (rMax - rMin) * ((sb + 0.5) / SB));
      const d = list.map((g) => `M${f(g.x0)} ${f(g.y0)}L${f(g.x)} ${f(g.y)}`).join('');
      out += `<path d="${d}" stroke="rgb(${c},${c},${c})" stroke-opacity="${GRAIN_A}" stroke-width="${f(w)}"/>`;
    }
  }
  return out;
}
const grains = binned(st.grains);
const neckGrains = binned(st.neckGrains);
// the neck column: exactly the opening's width at the neck. Mid-pour its head has landed,
// so it is a solid sand-toned column (the fade-in applies only to a free-falling head).
let column = '';
if (st.column) {
  const N = 32, r = [], l = [];
  for (let i = 0; i <= N; i++) { const y = st.column.y0 + (st.column.y1 - st.column.y0) * i / N; r.push([ix + st.halfW(y), y]); l.push([ix - st.halfW(y), y]); }
  column = P([...r, ...l.reverse()]);
  if (st.column.fadeLen > 0.01) throw new Error('STATIC_PHASE column head must have landed');
}
// core: the apex stream never stops, apex to neck
let core = '';
if (st.core) {
  const yA = G.apex[1], half = (y) => 1.3 * Math.min(1, Math.sqrt(Math.max(0, y - yA) / 46));
  const N = 40, l = [], r = [];
  for (let i = 0; i <= N; i++) { const y = st.core.y0 + (st.core.y1 - st.core.y0) * i / N; r.push([ix + half(y), y]); l.push([ix - half(y), y]); }
  core = `<path d="${P([...r, ...l.reverse()])}" fill="rgb(118,118,118)" fill-opacity="0.24"/>`;
}
// splash + rollers, as the renderer draws them upright
let parts = '';
for (const p of st.splash) {
  const c = Math.round(STREAM_RGB[0] + (STREAM_RGB[1] - STREAM_RGB[0]) * Math.min(1, p.shade));
  parts += `<path d="M${f(p.x - p.vx / 240)} ${f(p.y - p.vy / 240)}L${f(p.x)} ${f(p.y)}" stroke="rgb(${c},${c},${c})" stroke-opacity="0.7" stroke-width="${f(2 * p.r)}"/>`;
}
for (const p of st.rollers) {
  const c = Math.round(96 + 50 * p.shade);
  parts += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r)}" fill="rgb(${c},${c},${c})" fill-opacity="${f(Math.max(0, Math.min(1, p.fade * 1.4)))}"/>`;
}
const walls = `M${f(G.tl[0])} ${f(G.tl[1])}L${f(G.NL[0])} ${f(G.NL[1])}L${f(G.bl[0])} ${f(G.bl[1])}M${f(G.tr[0])} ${f(G.tr[1])}L${f(G.NR[0])} ${f(G.NR[1])}L${f(G.br[0])} ${f(G.br[1])}`;
const tri = P(T);

// a compact spill that fades to zero inside the file's own bounds
const VBOX = { x: -150, y: 60, w: 1324, h: 1200 };
const SPILL = { cx: 512, cy: 900, rx: 640, ry: 340 };
// lockups: a tighter pool of light so the file is not mostly empty space under the mark
const VBOX_L = { x: -110, y: 96, w: 1244, h: 940 };
const SPILL_L = { cx: 512, cy: 888, rx: 560, ry: 140 };
// lite stream for small sizes: a quarter of the grains, same look (they merge below ~64px anyway)
const liteGrains = (all) => all.replace(/<path d="([^"]*)"/g, (m, d) => '<path d="' + d.split('M').filter(Boolean).filter((_, i) => i % 4 === 0).map((x) => 'M' + x).join('') + '"');

function mark(id, withBg, SP = SPILL, VB = VBOX, lite = false) {
  const q = (s) => `${id}-${s}`;
  return `<defs>
<radialGradient id="${q('spill')}" gradientUnits="userSpaceOnUse" cx="${SP.cx}" cy="${SP.cy}" r="${SP.rx}" gradientTransform="translate(${SP.cx} ${SP.cy}) scale(1 ${f(SP.ry / SP.rx)}) translate(${-SP.cx} ${-SP.cy})">
<stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.28" stop-color="#fff" stop-opacity="0.09"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.025"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
</radialGradient>
<filter id="${q('rim')}" filterUnits="userSpaceOnUse" x="-120" y="40" width="1264" height="1000"><feGaussianBlur stdDeviation="14"/></filter>
<linearGradient id="${q('etch')}" gradientUnits="userSpaceOnUse" x1="0" y1="${f(iy - R - H / 2)}" x2="0" y2="${f(iy + R + H / 2)}"><stop offset="0" stop-color="${etchTop}"/><stop offset="1" stop-color="${etchBot}"/></linearGradient>
<linearGradient id="${q('sand')}" gradientUnits="userSpaceOnUse" x1="0" y1="${f(iy - R)}" x2="0" y2="${f(iy + R)}"><stop offset="0" stop-color="${sandTop}"/><stop offset="1" stop-color="${sandBot}"/></linearGradient>
<filter id="${q('grain')}" filterUnits="userSpaceOnUse" x="${f(ix - R)}" y="${f(iy - R)}" width="${f(2 * R)}" height="${f(2 * R)}">
<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="11" result="n"/>
<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.3 0 0 0 0.95" result="dark"/>
<feColorMatrix in="n" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1.6 0 0 0 -0.98" result="light"/>
<feMerge><feMergeNode in="dark"/><feMergeNode in="light"/></feMerge>
</filter>
<clipPath id="${q('ct')}"><path d="${chamberTop}"/></clipPath>
<clipPath id="${q('cb')}"><path d="${chamberBot}"/></clipPath>
<clipPath id="${q('st')}"><path d="${below(topSurf)}"/></clipPath>
<clipPath id="${q('sb')}"><path d="${below(botSurf)}"/></clipPath>
<clipPath id="${q('tri')}"><path d="${tri}"/></clipPath>
${column ? `<clipPath id="${q('col')}"><path d="${column}"/></clipPath>` : ''}
</defs>
${withBg ? `<rect x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}" fill="#000"/>` : ''}
<ellipse cx="${SP.cx}" cy="${SP.cy}" rx="${SP.rx}" ry="${SP.ry}" fill="url(#${q('spill')})"/>
<path d="${tri}" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="10" stroke-linejoin="round" filter="url(#${q('rim')})"/>
<path d="${tri}" fill="#000"/>
${column ? `<path d="${column}" fill="url(#${q('sand')})"/><g clip-path="url(#${q('col')})" fill="none" stroke-linecap="round">${lite ? liteGrains(neckGrains).replace(/stroke-opacity=\"0.5\"/g, 'stroke-opacity="0.85"') : neckGrains}</g>` : ''}
<g clip-path="url(#${q('ct')})"><g clip-path="url(#${q('st')})">
<rect x="${f(ix - R)}" y="${f(iy - R)}" width="${f(2 * R)}" height="${f(2 * R)}" fill="url(#${q('sand')})"/>
<rect x="${f(ix - R)}" y="${f(iy - R)}" width="${f(2 * R)}" height="${f(2 * R)}" filter="url(#${q('grain')})"/>
</g><path d="${line(topSurf)}" fill="none" stroke="rgb(160,160,160)" stroke-opacity="${f(0.28 * edgeTop)}" stroke-width="1.6" stroke-linejoin="round"/></g>
<g clip-path="url(#${q('cb')})"><g clip-path="url(#${q('sb')})">
<rect x="${f(ix - R)}" y="${f(iy - R)}" width="${f(2 * R)}" height="${f(2 * R)}" fill="url(#${q('sand')})"/>
<rect x="${f(ix - R)}" y="${f(iy - R)}" width="${f(2 * R)}" height="${f(2 * R)}" filter="url(#${q('grain')})"/>
</g><path d="${line(botSurf)}" fill="none" stroke="rgb(160,160,160)" stroke-opacity="${f(0.28 * edgeBot)}" stroke-width="1.6" stroke-linejoin="round"/>
<g stroke-linecap="round">${parts}</g></g>
<circle cx="${f(ix)}" cy="${f(iy)}" r="${f(R)}" fill="none" stroke="url(#${q('etch')})" stroke-width="${H}"/>
<g clip-path="url(#${q('tri')})">${core}<g fill="none" stroke-linecap="round">${lite ? liteGrains(grains).replace(/stroke-opacity=\"0.5\"/g, 'stroke-opacity="0.85"') : grains}</g></g>
<path d="${walls}" fill="none" stroke="url(#${q('etch')})" stroke-width="${L}" stroke-linejoin="miter" stroke-miterlimit="10"/>`;
}

const wrap = (body, vb = VBOX) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="img" aria-label="blacksand">
<title>blacksand</title>
${body}
</svg>
`;
fs.writeFileSync(`${out}/blacksand_mark.svg`, wrap(mark('bs', false)));
fs.writeFileSync(`${out}/blacksand_mark_on_black.svg`, wrap(mark('bs', true)));
// fragment for lockups: mark body plus its bounds
fs.writeFileSync(new URL('mark_fragment.json', import.meta.url), JSON.stringify({ body: mark('bsl', false, SPILL_L, VBOX_L, true), vb: VBOX_L, tri: T, iy, R }));
// geometry + timing for the QA suite
fs.writeFileSync(new URL('geom.json', import.meta.url), JSON.stringify({
  ix, iy, R, Rin: G.Rin, H, L, nk: G.nk, a: G.a, hx: G.hx, slope: G.slope, tl: G.tl, tr: G.tr, bl: G.bl, br: G.br, T,
  timing: TIMING, pulseCrest: PULSE_CREST, KB: C.K_BOT, KT: C.K_TOP, taper: STREAM.taper, staticPhase: STATIC_PHASE,
}));
console.log('static phase', STATIC_PHASE, 'grains', st.grains.length, 'neck', st.neckGrains.length, 'bytes', fs.statSync(`${out}/blacksand_mark.svg`).size);
