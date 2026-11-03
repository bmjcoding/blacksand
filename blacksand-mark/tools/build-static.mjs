// Builds the static logo SVGs (three variants; the sand levels of STATIC_PHASE with the static
// line), plus geom.json for the QA suite and the mark fragments for the lockups.
//   node tools/build-static.mjs [outdir]       (default: logo/; intermediates go to tools/.build/)
import fs from 'node:fs';
import { createGeometry, createChambers, createSim, STATIC_PHASE, STREAM, TIMING, BREATH, SOURCE, STATIC_LINE } from '../hero/blacksand-engine.js';

const out = process.argv[2] || new URL('../logo', import.meta.url).pathname;
const BUILD = new URL('.build/', import.meta.url);
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const G = createGeometry(process.env.NECK ? { neck: +process.env.NECK } : {}), C = createChambers(G);
const st = createSim(G, C, 7).stateAt(STATIC_PHASE);
const { ix, iy, R, H, L, T } = G;
const f = (v) => (Math.round(v * 100) / 100).toString();
const P = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';

// palette: identical to blacksand-hero.js PALETTE
const etchTop = '#262626', etchBot = '#4a4a4a', sandTop = '#363636', sandBot = '#5e5e5e';

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

const walls = `M${f(G.tl[0])} ${f(G.tl[1])}L${f(G.NL[0])} ${f(G.NL[1])}L${f(G.bl[0])} ${f(G.bl[1])}M${f(G.tr[0])} ${f(G.tr[1])}L${f(G.NR[0])} ${f(G.NR[1])}L${f(G.br[0])} ${f(G.br[1])}`;
const tri = P(T);

// Static logo (design panel consensus, review 3). Three variants, one interior:
//   dark  (default, no glow): solid #000 triangle with a crisp inner edge #3a3a3a, for dark surfaces
//   glow  (key art on black): a uniform backlit rim on all three edges (white 0.40, blur 14); no pool.
//         Its sand stream glows from the same light: a soft haze and a tight halo around a core
//         that reads as light, drawn as a fixed light (lighten blend), so it is one brightness
//         over the air, the ring and the sand, and never darkens what is behind it
//   light (white surfaces, e.g. an email signature): solid #000 triangle, lighter flat interior, no lighting
// Interior: the approved etch; the approved sand gradient in world space, flat (no grain texture);
// the static line from the apex down into the bottom mound (the mound covers its end).
const LINE = STATIC_LINE;
const lineEnd = st.peak + 6;                      // 6 units under the mound's peak: the pile swallows it
const VARIANTS = {
  dark:  { etch: [etchTop, etchBot], sand: [sandTop, sandBot], line: LINE.tone, edge: '#3a3a3a', rim: false, litEdges: true, pad: 16 },
  glow:  { etch: [etchTop, etchBot], sand: [sandTop, sandBot], line: LINE.tone, edge: null, rim: 0.40, litEdges: true, pad: 64, stream: true },
  light: { etch: ['#5c5c5c', '#5c5c5c'], sand: ['#8a8a8a', '#8a8a8a'], line: LINE.toneLight, edge: null, rim: false, litEdges: false, pad: 16 },
};
// The glowing stream (glow variant). Widths and blurs are for the 8-unit master line and scale
// with the line, so the small cut glows alike. The core is white at 18% over the glow, which puts
// it at the same brightness as the approved line on black (122 of 255).
const GLOW = { haze: { opacity: 0.30, width: 18, blur: 16 }, halo: { opacity: 0.38, width: 8, blur: 4 }, core: 0.18 };
// Drawn opaque over its own black backing, then lightened onto the logo: each pixel shows the
// stream or what's behind it, whichever is brighter. (Nested inside the clips, the blend would
// only meet the group's own transparent backdrop, so it sits outermost.)
function streamGlow(q, lineW) {
  const k = lineW / LINE.master;
  const reach = 4 * GLOW.haze.blur * k + GLOW.haze.width * k;
  const path = (attrs) => `<path d="M${f(ix)} ${f(T[0][1])}V${f(lineEnd)}" fill="none" stroke="#fff" ${attrs}/>`;
  return `<g style="mix-blend-mode:lighten"><g clip-path="url(#${q('tri')})"><g clip-path="url(#${q('am')})">` +
    `<rect x="${f(ix - reach)}" y="${f(T[0][1])}" width="${f(2 * reach)}" height="${f(lineEnd - T[0][1])}" fill="#000"/>` +
    path(`stroke-opacity="${GLOW.haze.opacity}" stroke-width="${f(GLOW.haze.width * k)}" filter="url(#${q('haze')})"`) +
    path(`stroke-opacity="${GLOW.halo.opacity}" stroke-width="${f(GLOW.halo.width * k)}" filter="url(#${q('halo')})"`) +
    path(`stroke-opacity="${GLOW.core}" stroke-width="${lineW}" stroke-linecap="butt"`) +
    `</g></g></g>`;
}
const vbFor = (pad) => ({ x: 56 - pad, y: 138 - pad, w: 912 + 2 * pad, h: 740 + 2 * pad });
const above = (pts) => P([[ix - R - 24, 0], ...pts, [ix + R + 24, 0]]);
function mark(id, variant, { lineW = LINE.master, edgeW = LINE.bandMaster, bg = null } = {}) {
  const V = VARIANTS[variant], VB = vbFor(V.pad);
  const q = (s) => `${id}-${s}`;
  return `<defs>
${V.rim ? `<filter id="${q('rim')}" filterUnits="userSpaceOnUse" x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}"><feGaussianBlur stdDeviation="14"/></filter>` : ''}${V.stream ? `<filter id="${q('haze')}" filterUnits="userSpaceOnUse" x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}"><feGaussianBlur stdDeviation="${f(GLOW.haze.blur * lineW / LINE.master)}"/></filter><filter id="${q('halo')}" filterUnits="userSpaceOnUse" x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}"><feGaussianBlur stdDeviation="${f(GLOW.halo.blur * lineW / LINE.master)}"/></filter>` : ''}
<linearGradient id="${q('etch')}" gradientUnits="userSpaceOnUse" x1="0" y1="${f(iy - R - H / 2)}" x2="0" y2="${f(iy + R + H / 2)}"><stop offset="0" stop-color="${V.etch[0]}"/><stop offset="1" stop-color="${V.etch[1]}"/></linearGradient>
<linearGradient id="${q('sand')}" gradientUnits="userSpaceOnUse" x1="0" y1="${f(iy - R)}" x2="0" y2="${f(iy + R)}"><stop offset="0" stop-color="${V.sand[0]}"/><stop offset="1" stop-color="${V.sand[1]}"/></linearGradient>
<clipPath id="${q('ct')}"><path d="${chamberTop}"/></clipPath>
<clipPath id="${q('cb')}"><path d="${chamberBot}"/></clipPath>
<clipPath id="${q('st')}"><path d="${below(topSurf)}"/></clipPath>
<clipPath id="${q('sb')}"><path d="${below(botSurf)}"/></clipPath>
<clipPath id="${q('am')}"><path d="${above(botSurf)}"/></clipPath>
<clipPath id="${q('tri')}"><path d="${tri}"/></clipPath>
</defs>
${bg ? `<rect x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}" fill="${bg}"/>` : ''}
${V.rim ? `<path d="${tri}" fill="none" stroke="#fff" stroke-opacity="${V.rim}" stroke-width="10" stroke-linejoin="round" filter="url(#${q('rim')})"/>` : ''}
<path d="${tri}" fill="#000"/>
<g clip-path="url(#${q('ct')})"><path d="${below(topSurf)}" clip-path="url(#${q('st')})" fill="url(#${q('sand')})"/>${V.litEdges ? `<path d="${line(topSurf)}" fill="none" stroke="rgb(160,160,160)" stroke-opacity="${f(0.28 * edgeTop)}" stroke-width="1.6" stroke-linejoin="round"/>` : ''}</g>
<g clip-path="url(#${q('cb')})"><path d="${below(botSurf)}" clip-path="url(#${q('sb')})" fill="url(#${q('sand')})"/>${V.litEdges ? `<path d="${line(botSurf)}" fill="none" stroke="rgb(160,160,160)" stroke-opacity="${f(0.28 * edgeBot)}" stroke-width="1.6" stroke-linejoin="round"/>` : ''}</g>
<circle cx="${f(ix)}" cy="${f(iy)}" r="${f(R)}" fill="none" stroke="url(#${q('etch')})" stroke-width="${H}"/>
<path d="${walls}" fill="none" stroke="url(#${q('etch')})" stroke-width="${L}" stroke-linejoin="miter" stroke-miterlimit="10"/>
${V.stream ? streamGlow(q, lineW) : `<g clip-path="url(#${q('tri')})"><path d="M${f(ix)} ${f(T[0][1])}V${f(lineEnd)}" clip-path="url(#${q('am')})" fill="none" stroke="${V.line}" stroke-width="${lineW}" stroke-linecap="butt"/></g>`}
${V.edge ? `<path d="${tri}" clip-path="url(#${q('tri')})" fill="none" stroke="${V.edge}" stroke-width="${2 * edgeW}" stroke-linejoin="miter" stroke-miterlimit="10"/>` : ''}`;
}

const wrap = (body, vb) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}" role="img" aria-label="blacksand">
<title>blacksand</title>
${body}
</svg>
`;
const emit = (name, variant, o = {}) => fs.writeFileSync(`${out}/${name}`, wrap(mark('bs', variant, o), vbFor(VARIANTS[variant].pad)));
// base name: marks 128 px tall and up (8-unit line); -small: 24-127 px (16-unit line, 12-unit edge).
// Below 24 px use the hand-drawn icons (logo/blacksand-icon.svg, -dark.svg), not built here.
emit('blacksand-mark.svg', 'dark');
emit('blacksand-mark-small.svg', 'dark', { lineW: LINE.small, edgeW: LINE.bandSmall });
emit('blacksand-mark-glow.svg', 'glow');
emit('blacksand-mark-glow-small.svg', 'glow', { lineW: LINE.small, edgeW: LINE.bandSmall });
emit('blacksand-mark-light.svg', 'light');
emit('blacksand-mark-light-small.svg', 'light', { lineW: LINE.small, edgeW: LINE.bandSmall });
// fragments for the lockups (default dark and light, both line cuts)
fs.writeFileSync(new URL('mark-fragment.json', BUILD), JSON.stringify({
  vb: vbFor(16), tri: T, iy, R,
  dark: mark('bsl', 'dark', { lineW: LINE.small, edgeW: LINE.bandSmall }), darkLarge: mark('bsl', 'dark'),
  light: mark('bsl', 'light', { lineW: LINE.small, edgeW: LINE.bandSmall }), lightLarge: mark('bsl', 'light'),
  glow: mark('bsl', 'glow', { lineW: LINE.small, edgeW: LINE.bandSmall }), glowLarge: mark('bsl', 'glow'), glowPad: VARIANTS.glow.pad,
}));
// geometry + timing for the QA suite
fs.writeFileSync(new URL('geom.json', BUILD), JSON.stringify({
  ix, iy, R, Rin: G.Rin, H, L, nk: G.nk, a: G.a, hx: G.hx, slope: G.slope, tl: G.tl, tr: G.tr, bl: G.bl, br: G.br, T,
  timing: TIMING, breathCrest: BREATH.crest, source: SOURCE, side: Math.hypot(T[1][0] - T[2][0], T[1][1] - T[2][1]), KB: C.K_BOT, KT: C.K_TOP, taper: STREAM.taper, staticPhase: STATIC_PHASE,
}));
console.log('static phase', STATIC_PHASE, 'line end', f(lineEnd), 'mound peak', f(st.peak), '; default mark', fs.statSync(`${out}/blacksand-mark.svg`).size, 'bytes');
