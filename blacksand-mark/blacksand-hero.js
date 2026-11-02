// blacksand-hero.js
// Canvas renderer for the backlit blacksand mark: sand stream from the apex,
// volume-conserving chambers, 180 deg flip with motion blur, glow pulse on every flip.
//
//   import { mountBlacksand } from './blacksand-hero.js';
//   const hero = mountBlacksand(document.querySelector('canvas'));
//   // hero.destroy() on unmount
//
// The canvas fills its CSS box. The page behind it should be #000.

import { createGeometry, createChambers, createSim, TIMING, STATIC_PHASE, OPEN_PHASE, STREAM, rotAt, smoothstep } from './blacksand-engine.js';

export const PALETTE = {
  bg: '#000',
  etchTop: [38, 38, 38], etchBot: [74, 74, 74],      // ring + walls
  sandTop: [54, 54, 54], sandBot: [94, 94, 94],      // sand body
  surface: 'rgba(160,160,160,0.28)',                 // lit edge of a sand surface
  stream: [92, 150], glint: 190, grainAlpha: 0.5,    // grain grey range
};
// backlight: the rim (soft edge light on the triangle) and the pool of light under the base.
// Both brighten with the flip; the crest is +50% on the rim and the spill keeps its ratio.
export const GLOW = { rim: 0.35, rimPeak: 0.50, spillPeak: 0.34 };
// motion blur: eight samples over a half-frame shutter centred on the frame time, blended
// with the sharp render by w = smoothstep((travel_px - onset) / width), travel measured at
// the ring's outer edge. At rest the frame is exactly the sharp render.
export const BLUR = { samples: 8, shutter: 1 / 120, onset: 0.3, width: 2.2 };

const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export function mountBlacksand(canvas, opts = {}) {
  const G = createGeometry();
  const C = createChambers(G);
  let sim = createSim(G, C, opts.seed ?? 7);
  // the sim only runs forward; asking for an earlier time rebuilds it deterministically
  const stateAt = (t) => { if (t < sim.t - 1e-9) sim = createSim(G, C, opts.seed ?? 7); return sim.stateAt(t); };
  const ctx = canvas.getContext('2d', { alpha: false });
  const { ix, iy, R, H, L, T, Rin } = G;
  const dbg = Object.assign({ glow: true, particles: true, blur: true }, opts.debug || {});

  let W = 0, Hh = 0, dpr = 1, s = 1, ox = 0, oy = 0;     // device-space transform for mark units
  let glowA = null, glowD = null, tex = null;           // backlight at rest; crest image (2D fallback)
  let gl = null, glc = null, glU = null, glP = -1;        // WebGL glow compositor (float + dither per frame)
  let mark = null;                                       // stream layer: a strip under the apex
  let box = null;                                        // blur layers: the ring's box

  // ------------------------------------------------------------- layout ---
  function layout() {
    dpr = opts.dpr ?? Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    W = Math.max(1, Math.round(cw * dpr)); Hh = Math.max(1, Math.round(ch * dpr));
    canvas.width = W; canvas.height = Hh;
    const markCss = opts.markSize ?? Math.min(420, cw * 0.34, ch * 0.5);
    s = (markCss / 1024) * dpr;
    // centre the triangle; snap the ring centre to a device pixel so the 180 deg
    // flip lands on exactly the same pixel grid it started from
    const cxDev = W / 2, cyDev = Hh * (opts.verticalCenter ?? 0.5);
    ox = cxDev - ix * s;
    oy = cyDev - ((138 + 878) / 2) * s;
    ox = Math.round(ox + ix * s) - ix * s;
    oy = Math.round(oy + iy * s) - iy * s;
    buildGlow(); buildTexture();
    needFull = true;
    // everything the mark paints lies inside the triangle's box
    {
      const x0 = Math.floor(ox + 56 * s) - 4, y0 = Math.floor(oy + 138 * s) - 4;
      const x1 = Math.ceil(ox + 968 * s) + 4, y1 = Math.ceil(oy + 878 * s) + 4;
      mbox = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(W, x1) - Math.max(0, x0), h: Math.min(Hh, y1) - Math.max(0, y0) };
    }
    // stream layer: from the apex down through the ring, as wide as the ring (grains that land
    // on a wall mid-flip slide along it toward the side wedge's corner)
    {
      const x0 = Math.floor(ox + (ix - R - H / 2) * s) - 2, y0 = Math.floor(oy + 138 * s) - 2;
      const x1 = Math.ceil(ox + (ix + R + H / 2) * s) + 2, y1 = Math.ceil(oy + (iy + R + H / 2) * s) + 2;
      mark = { x0, y0, w: x1 - x0, h: y1 - y0, c: mkCanvas(x1 - x0, y1 - y0) };
    }
    // blur layers: the ring's box (rotation never leaves it)
    {
      const half = Math.ceil((R + H / 2 + 6) * s);
      const x0 = Math.round(ox + ix * s) - half, y0 = Math.round(oy + iy * s) - half, n = 2 * half;
      const mk = () => mkCanvas(n, n);
      box = { x0, y0, n,
        sand: { S: mk(), P0: mk(), P1: mk(), Q0: mk(), Q1: mk(), F: mk(), X: mk() },
        walls: { S: mk(), P0: mk(), P1: mk(), Q0: mk(), Q1: mk(), F: mk(), X: mk() },
        mask: { S: mk(), F: mk(), X: mk() } };
    }
  }
  // transforms: mark units -> device px, for the main canvas or a layer with an origin
  const base = (c = ctx, x0 = 0, y0 = 0) => c.setTransform(s, 0, 0, s, ox - x0, oy - y0);
  const rotate = (rot, c = ctx, x0 = 0, y0 = 0) => { base(c, x0, y0); c.translate(ix, iy); c.rotate(rot); c.translate(-ix, -iy); };

  // ------------------------------------------------------------ glow ---
  // Backlight composed in floating point: the rim (a Gaussian-blurred stroke of the triangle,
  // rendered once at full gain) plus the analytic pool of light, scaled by the pulse and
  // quantised with a fixed per-pixel dither, so no large area ever shows an 8-bit step.
  // With WebGL2 this happens per frame in a fragment shader, exactly. Without it, two 8-bit
  // images (rest and crest) are cross-faded with source-over; that fallback cannot avoid
  // one-level steps over flat regions while the pulse moves, but it never adds a level
  // everywhere at once ('lighter' would: Chrome rounds that blend up).
  const GLSL_VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
  const GLSL_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D rim; uniform vec2 res; uniform vec3 mark; uniform float kRim, kSpill;
out vec4 o;
float spill(float d) {
  if (d >= 1.0) return 0.0;
  if (d < 0.28) return mix(0.22, 0.09, d / 0.28);
  if (d < 0.6) return mix(0.09, 0.025, (d - 0.28) / 0.32);
  return mix(0.025, 0.0, (d - 0.6) / 0.4);
}
void main() {
  float r = texture(rim, gl_FragCoord.xy / res).r;
  float u = (gl_FragCoord.x - mark.x) / mark.z;
  float v = (res.y - gl_FragCoord.y - mark.y) / mark.z;
  float dx = u - 512.0, dy = (v - 905.0) * (1250.0 / 820.0);
  float sp = spill(sqrt(dx * dx + dy * dy) / 1250.0);
  uint x = uint(gl_FragCoord.x), y = uint(res.y - gl_FragCoord.y);
  uint h = x * 374761393u + y * 668265263u; h = (h ^ (h >> 13)) * 1274126177u; h ^= h >> 16;
  float d = float(h) / 4294967296.0;
  float q = floor((r * kRim + sp * kSpill) * 255.0 + d);
  o = vec4(vec3(min(q, 255.0) / 255.0), 1.0);
}`;
  function initGL() {
    if (opts.webgl === false) return false;
    try {
      glc = mkCanvas(1, 1);
      gl = glc.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
      if (!gl) return false;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, GLSL_VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, GLSL_FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      glU = { res: gl.getUniformLocation(prog, 'res'), mark: gl.getUniformLocation(prog, 'mark'), kRim: gl.getUniformLocation(prog, 'kRim'), kSpill: gl.getUniformLocation(prog, 'kSpill') };
      gl.uniform1i(gl.getUniformLocation(prog, 'rim'), 0);
      glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; glP = -1; buildGlow(); needFull = true; }, false);
      return true;
    } catch (e) { gl = null; return false; }
  }
  // draw the glow at pulse weight P into the WebGL canvas (only when it changed)
  function glowGL(P) {
    if (glP === P) return;
    gl.uniform1f(glU.kRim, GLOW.rim * (1 + GLOW.rimPeak * P));
    gl.uniform1f(glU.kSpill, 1 + GLOW.spillPeak * P);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    glP = P;
  }
  function buildGlow() {
    const rc = mkCanvas(W, Hh);
    const g = rc.getContext('2d', { alpha: false, willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, W, Hh);
    g.globalCompositeOperation = 'lighter';
    const OFF = W + 2000;                        // draw the shape off-canvas, keep only its shadow
    g.save();
    g.setTransform(s, 0, 0, s, ox - OFF, oy);
    g.shadowOffsetX = OFF; g.shadowOffsetY = 0;
    g.shadowBlur = 2 * 14 * s;                   // sigma 14 units
    g.shadowColor = 'rgba(255,255,255,1)';
    g.strokeStyle = '#fff'; g.lineWidth = 10; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(...T[0]); g.lineTo(...T[1]); g.lineTo(...T[2]); g.closePath(); g.stroke();
    g.restore();
    if (gl) {
      glc.width = W; glc.height = Hh; gl.viewport(0, 0, W, Hh);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rc);
      gl.uniform2f(glU.res, W, Hh); gl.uniform3f(glU.mark, ox, oy, s);
      glP = -1; glowGL(0);
      // the rest image, for the frames in which the pulse is zero (pixel-identical to the shader)
      glowA = mkCanvas(W, Hh); glowA.getContext('2d').drawImage(glc, 0, 0);
      glowD = null;
      return;
    }
    const rim = g.getImageData(0, 0, W, Hh).data;
    const A = new ImageData(W, Hh), B = new ImageData(W, Hh);
    const a = A.data, b = B.data;
    const kR = GLOW.rim / 255, kRp = kR * (1 + GLOW.rimPeak), kSp = 1 + GLOW.spillPeak;
    let bx0 = W, by0 = Hh, bx1 = -1, by1 = -1, dMax = 1;         // bounds and size of the crest-rest delta
    const stops = [[0, 0.22], [0.28, 0.09], [0.6, 0.025], [1, 0]];
    const spill = (d) => {
      if (d >= 1) return 0;
      let i = 1; while (stops[i][0] < d) i++;
      const [d0, v0] = stops[i - 1], [d1, v1] = stops[i];
      return v0 + (v1 - v0) * (d - d0) / (d1 - d0);
    };
    const ky = 1250 / 820;
    for (let y = 0, i = 0; y < Hh; y++) {
      const v = (y + 0.5 - oy) / s, dy = (v - 905) * ky;
      for (let x = 0; x < W; x++, i += 4) {
        const u = (x + 0.5 - ox) / s, dx = u - 512;
        const sp = spill(Math.sqrt(dx * dx + dy * dy) / 1250);
        const r = rim[i];
        // fixed per-pixel dither in [0,1): an integer hash of the device pixel
        let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
        const d = (h >>> 0) / 4294967296;
        const va = Math.min(255, Math.floor(r * kR * 255 + sp * 255 + d));
        const vb = Math.min(255, Math.floor(r * kRp * 255 + sp * kSp * 255 + d));
        a[i] = a[i + 1] = a[i + 2] = va; a[i + 3] = 255;
        b[i] = b[i + 1] = b[i + 2] = vb; b[i + 3] = 255;
        if (vb !== va) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (vb - va > dMax) dMax = vb - va; }
      }
    }
    glowA = mkCanvas(W, Hh); glowA.getContext('2d').putImageData(A, 0, 0);
    // below this weight the cross-fade truncates to the rest image on every pixel, so skipping
    // it changes nothing
    glowD = { x0: bx0, y0: by0, w: Math.max(1, bx1 - bx0 + 1), h: Math.max(1, by1 - by0 + 1), snap: 0.99 / dMax };
    glowD.c = mkCanvas(glowD.w, glowD.h);
    glowD.c.getContext('2d').putImageData(B, -bx0, -by0);
  }

  // sand grain texture, in glass space (it turns with the vessel)
  function buildTexture() {
    const size = Math.ceil(2 * R * s) + 2;
    tex = mkCanvas(size, size);
    const t = tex.getContext('2d');
    t.setTransform(s, 0, 0, s, 1, 1);
    let a = 12345;
    const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
    const n = Math.round(Math.PI * R * R * 0.34);
    for (let i = 0; i < n; i++) {
      const x = rnd() * 2 * R, y = rnd() * 2 * R;
      const r = 0.32 + rnd() * 0.55;
      const q = rnd();
      t.fillStyle = q < 0.55 ? `rgba(0,0,0,${0.08 + rnd() * 0.16})` : q < 0.994 ? `rgba(255,255,255,${0.03 + rnd() * 0.06})` : `rgba(255,255,255,${0.10 + rnd() * 0.08})`;
      t.beginPath(); t.arc(x, y, r, 0, Math.PI * 2); t.fill();
    }
  }

  // ------------------------------------------------------------ paths ---
  // Points are added through the current transform, so a chamber built under a
  // rotation keeps its shape when the world transform is restored for filling.
  function chamberPath(which, c = ctx) {
    const a = (p) => Math.atan2(p[1] - iy, p[0] - ix);
    c.beginPath();
    if (which === 'bot') {
      c.moveTo(...G.NR); c.lineTo(...G.br); c.arc(ix, iy, R, a(G.br), a(G.bl), false); c.lineTo(...G.NL);
    } else {
      c.moveTo(...G.NL); c.lineTo(...G.tl); c.arc(ix, iy, R, a(G.tl), a(G.tr), false); c.lineTo(...G.NR);
    }
    c.closePath();
  }
  function surfacePath(fn, close, c = ctx) {
    c.beginPath();
    const x0 = ix - R - 24, x1 = ix + R + 24;
    for (let x = x0; x <= x1 + 1e-6; x += 1.5) { const y = fn(x); x === x0 ? c.moveTo(x, y) : c.lineTo(x, y); }
    if (close) { c.lineTo(x1, iy + R + 60); c.lineTo(x0, iy + R + 60); c.closePath(); }
  }
  function etchGradient(c = ctx) {
    const gr = c.createLinearGradient(0, iy - R - H / 2, 0, iy + R + H / 2);
    gr.addColorStop(0, rgb(PALETTE.etchTop)); gr.addColorStop(1, rgb(PALETTE.etchBot));
    return gr;
  }
  function sandGradient(c = ctx) {
    const gr = c.createLinearGradient(0, iy - R, 0, iy + R);
    gr.addColorStop(0, rgb(PALETTE.sandTop)); gr.addColorStop(1, rgb(PALETTE.sandBot));
    return gr;
  }
  // a sand body, or (for a full chamber) the whole chamber: the two chambers then draw the
  // identical region, so the wrap of the cycle, where their roles swap, is seamless
  const topSurface = (st) => (st.fTop <= 0 ? null : (x) => C.crater(st.crater, x, st.craterK));
  const botSurface = (st) => (st.fBot >= 1 ? null : (x) => C.mound(st.peak, x));

  // --------------------------------------------------------- layer draws ---
  // L = { c, x0, y0 } is a layer; the main canvas is { c: ctx, x0: 0, y0: 0 }
  const MAIN = { get c() { return ctx; }, x0: 0, y0: 0 };

  // A sand surface is level under gravity, so it is drawn in world space; only the chamber
  // (the glass) turns. Upright, the two are the same thing.
  function drawSandBody(L, which, surfaceFn, rot, texRot, edge) {
    const c = L.c;
    c.save();
    rotate(rot, c, L.x0, L.y0); chamberPath(which, c); c.clip();
    if (surfaceFn) { base(c, L.x0, L.y0); surfacePath(surfaceFn, true, c); c.clip(); }
    base(c, L.x0, L.y0); c.fillStyle = sandGradient(c); c.fillRect(ix - R - 40, iy - R - 40, 2 * R + 80, 2 * R + 80);
    rotate(texRot, c, L.x0, L.y0);
    c.drawImage(tex, ix - R - 1 / s, iy - R - 1 / s, tex.width / s, tex.height / s);
    c.restore();
    if (!surfaceFn || edge <= 0) return;
    // lit surface edge
    c.save();
    rotate(rot, c, L.x0, L.y0); chamberPath(which, c); c.clip();
    base(c, L.x0, L.y0); surfacePath(surfaceFn, false, c);
    c.globalAlpha = edge; c.strokeStyle = PALETTE.surface; c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
    c.restore();
  }

  // both sand bodies plus the grains resting on the mound, in glass space at rotation rot
  function drawSand(L, st, rot) {
    const texRot = rot + st.parity * Math.PI;
    const edgeT = Math.min(1, (1 - st.fTop) / 0.12, st.fTop / 0.04);
    const edgeB = Math.min(1, st.fBot / 0.06, (1 - st.fBot) / 0.04);
    if (st.fTop < 1) drawSandBody(L, 'top', topSurface(st), rot, texRot, edgeT);
    if (st.fBot > 0) drawSandBody(L, 'bot', botSurface(st), rot, texRot, edgeB);
    // splash + rolling grains: they live on the mound, ride with the glass, and fade as it turns
    if (dbg.particles && st.flipFade > 0 && (st.splash.length || st.rollers.length)) {
      const c = L.c;
      c.save();
      rotate(rot, c, L.x0, L.y0); chamberPath('bot', c); c.clip();
      c.lineCap = 'round';
      for (const p of st.splash) {
        const k = Math.round(PALETTE.stream[0] + (PALETTE.stream[1] - PALETTE.stream[0]) * Math.min(1, p.shade));
        c.strokeStyle = `rgba(${k},${k},${k},${0.7 * st.flipFade})`; c.lineWidth = 2 * p.r;
        c.beginPath(); c.moveTo(p.x - p.vx / 240, p.y - p.vy / 240); c.lineTo(p.x, p.y); c.stroke();
      }
      for (const p of st.rollers) {
        const k = Math.round(96 + 50 * p.shade);
        c.fillStyle = `rgba(${k},${k},${k},${Math.max(0, Math.min(1, p.fade * 1.4)) * st.flipFade})`;
        c.beginPath(); c.arc(p.x, p.y, p.r, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }
  }

  // the visible sand (inside the ring's inner edge) as an opaque mask: what hides the stream
  function drawMask(L, st, rot) {
    const c = L.c;
    for (const which of ['top', 'bot']) {
      const fn = which === 'top' ? (st.fTop < 1 ? topSurface(st) : undefined) : (st.fBot > 0 ? botSurface(st) : undefined);
      if (fn === undefined) continue;
      c.save();
      base(c, L.x0, L.y0); c.beginPath(); c.arc(ix, iy, Rin, 0, Math.PI * 2); c.clip();
      rotate(rot, c, L.x0, L.y0); chamberPath(which, c); c.clip();
      if (fn) { base(c, L.x0, L.y0); surfacePath(fn, true, c); c.clip(); }
      base(c, L.x0, L.y0); c.fillStyle = '#000'; c.fillRect(ix - R - 40, iy - R - 40, 2 * R + 80, 2 * R + 80);
      c.restore();
    }
  }

  function drawWalls(Ly, rot) {
    const c = Ly.c;
    rotate(rot, c, Ly.x0, Ly.y0);
    c.beginPath();
    c.moveTo(...G.tl); c.lineTo(...G.NL); c.lineTo(...G.bl);
    c.moveTo(...G.tr); c.lineTo(...G.NR); c.lineTo(...G.br);
    base(c, Ly.x0, Ly.y0); c.strokeStyle = etchGradient(c); c.lineWidth = G.L; c.lineJoin = 'miter'; c.miterLimit = 10; c.lineCap = 'butt';
    c.stroke();
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawRing() {
    base(); ctx.strokeStyle = etchGradient(); ctx.lineWidth = H;
    ctx.beginPath(); ctx.arc(ix, iy, R, 0, Math.PI * 2); ctx.stroke();
  }

  // grains batched by tone, size and fade (gr.fade, 0..1, quantised to FADES levels), as streaks
  const FADES = 6;
  function strokeGrains(c, list, fadeKey = 'fade') {
    const BINS = 6, SB = 3, { rMin, rMax } = STREAM;
    const buckets = new Map();
    for (const gr of list) {
      const f = gr[fadeKey] ?? 1;
      if (f <= 0) continue;
      const fb = Math.max(1, Math.min(FADES, Math.ceil(f * FADES)));
      const tb = gr.shade > 1 ? BINS : Math.min(BINS - 1, Math.floor(gr.shade * BINS));
      const sb = Math.min(SB - 1, Math.floor(((gr.r - rMin) / (rMax - rMin)) * SB));
      const key = (fb * (BINS + 1) + tb) * SB + sb;
      let b = buckets.get(key); if (!b) buckets.set(key, (b = []));
      b.push(gr);
    }
    c.lineCap = 'round';
    // fixed order: translucent strokes composite order-dependently, so the order must not
    // depend on which grains happen to be visible
    for (const key of [...buckets.keys()].sort((p, q) => p - q)) {
      const list = buckets.get(key);
      const sb = key % SB, tb = Math.floor(key / SB) % (BINS + 1), fb = Math.floor(key / SB / (BINS + 1));
      const k = tb === BINS ? PALETTE.glint : Math.round(PALETTE.stream[0] + (PALETTE.stream[1] - PALETTE.stream[0]) * ((tb + 0.5) / BINS));
      c.strokeStyle = `rgba(${k},${k},${k},${PALETTE.grainAlpha * fb / FADES})`;
      c.lineWidth = 2 * (rMin + (rMax - rMin) * ((sb + 0.5) / SB));
      c.beginPath();
      for (const gr of list) { c.moveTo(gr.x0, gr.y0); c.lineTo(gr.x, gr.y); }
      c.stroke();
    }
  }

  // Sand leaving the neck: a column exactly as wide as the opening at the neck, in the sand's
  // own tone, with the moving grains on top. Drawn under both sand bodies. Its side edges are
  // crisp; while the head falls free it fades in over its last stretch instead of a flat cap.
  function drawColumn(st) {
    const { y0, y1, fadeLen, tailFade } = st.column, N = 32;
    ctx.save();
    base();
    ctx.beginPath();
    for (let i = 0; i <= N; i++) { const y = y0 + (y1 - y0) * i / N; i ? ctx.lineTo(ix + st.halfW(y), y) : ctx.moveTo(ix + st.halfW(y), y); }
    for (let i = N; i >= 0; i--) { const y = y0 + (y1 - y0) * i / N; ctx.lineTo(ix - st.halfW(y), y); }
    ctx.closePath(); ctx.clip();
    const tone = (y) => { const u = Math.max(0, Math.min(1, (y - (iy - R)) / (2 * R))); return PALETTE.sandTop.map((v, i) => Math.round(v + (PALETTE.sandBot[i] - v) * u)); };
    if (fadeLen > 0.01 || tailFade > 0.01) {
      const gr = ctx.createLinearGradient(0, y0, 0, y1), K = 10, h = y1 - y0;
      const stop = (y, a) => gr.addColorStop(Math.min(1, Math.max(0, (y - y0) / h)), rgb(tone(y), a));
      if (tailFade > 0.01) for (let i = 0; i <= K; i++) stop(y0 + tailFade * i / K, smoothstep(i / K));
      else stop(y0, 1);
      if (fadeLen > 0.01) for (let i = 0; i <= K; i++) stop(y1 - fadeLen + fadeLen * i / K, 1 - smoothstep(i / K));
      else stop(y1, 1);
      ctx.fillStyle = gr;
    } else ctx.fillStyle = sandGradient();
    ctx.fillRect(ix - 20, y0 - 2, 40, y1 - y0 + 4);
    if (dbg.particles) strokeGrains(ctx, st.neckGrains);
    ctx.restore();
  }

  // the apex stream, into the mark-box layer (or straight onto the canvas): faint core + grains
  function drawStream(L, st) {
    const c = L.c;
    c.save();
    base(c, L.x0, L.y0);
    c.beginPath(); c.moveTo(...T[0]); c.lineTo(...T[1]); c.lineTo(...T[2]); c.closePath(); c.clip();
    const front = streamLayer === 'front';
    if (st.core && (front ? st.core.y1 : st.core.yHidden ?? st.core.y1) > st.core.y0) {
      const { y0, density } = st.core;
      // the static logo (stream in front) is one unbroken line: no end fade there
      const y1 = front ? st.core.y1 : st.core.yHidden ?? st.core.y1;
      const endFade = front ? 0 : st.core.endFade;
      const fadeAt = st.core.fadeAt ?? y1;
      const yA = G.apex[1];
      const half = (y) => 1.3 * Math.min(1, Math.sqrt(Math.max(0, y - yA) / 46));
      c.beginPath();
      const N = 40;
      for (let i = 0; i <= N; i++) { const y = y0 + (y1 - y0) * i / N; i ? c.lineTo(ix + half(y), y) : c.moveTo(ix + half(y), y); }
      for (let i = N; i >= 0; i--) { const y = y0 + (y1 - y0) * i / N; c.lineTo(ix - half(y), y); }
      c.closePath();
      // the core's density follows the grains' (the emission when that sand left the apex);
      // above a wall contact its last units fade out
      // stops at fixed heights (every 16 units from the apex), so moving the end never
      // re-interpolates the rest of the line; plus the fade stops at the end
      const gr = c.createLinearGradient(0, y0, 0, y1), hgt = y1 - y0;
      const alpha = (y) => { const e = endFade > 0 ? Math.max(0, Math.min(1, (fadeAt - y) / endFade)) : 1; return 0.24 * (density ? density(y) : 1) * e; };
      const ys = [];
      for (let y = y0; y < y1; y += 16) ys.push(y);
      if (endFade > 0) for (let i = 0; i <= 4; i++) ys.push(fadeAt - endFade * (1 - i / 4));
      ys.push(y1);
      ys.filter((y) => y >= y0 && y <= y1).sort((a, b) => a - b)
        .forEach((y) => gr.addColorStop((y - y0) / hgt, `rgba(118,118,118,${alpha(y).toFixed(4)})`));
      c.fillStyle = gr; c.fill();
    }
    strokeGrains(c, st.grains);
    // grains that landed on a wall, sliding off it (they fade out)
    if (st.spray && st.spray.length) strokeGrains(c, st.spray, 'a');
    c.restore();
  }

  // ------------------------------------------------------- blur helpers ---
  const clear = (cv) => { const c = cv.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, cv.width, cv.height); };
  // dst = a * wa + b * wb, premultiplied, additive (a transparent-cleared destination)
  function mix(dst, a, wa, b, wb) {
    clear(dst);
    const c = dst.getContext('2d');
    c.globalCompositeOperation = 'lighter';
    if (wa > 0) { c.globalAlpha = wa; c.drawImage(a, 0, 0); }
    if (wb > 0) { c.globalAlpha = wb; c.drawImage(b, 0, 0); }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
  const avg = (dst, a, b) => mix(dst, a, 0.5, b, 0.5);

  // ------------------------------------------------------------- frame ---
  const reducedMotion = opts.reducedMotion ?? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // In motion the stream falls behind the sand (into the top pile, out of the neck).
  // A still frame keeps the static logo's foreground line.
  const streamLayer = opts.streamLayer ?? (reducedMotion ? 'front' : 'behind-sand');

  // the sample rotations for a frame: the shutter is centred on the frame time and the
  // rotation is continuous across the wrap of the cycle (where rotAt jumps by pi)
  function sampleRots(st) {
    const { samples, shutter } = BLUR;
    const out = [];
    for (let k = 0; k < samples; k++) {
      const tk = st.t + ((k + 0.5) / samples - 0.5) * shutter;
      const kk = Math.floor(tk / TIMING.cycle), phk = tk - kk * TIMING.cycle;
      out.push(rotAt(phk) + Math.PI * (kk - st.cycleIndex));
    }
    return out;
  }

  let lastP = 0, needFull = true, mbox = null;          // partial repaint bookkeeping

  // optional section timings (opts.profile): hero.prof = { section: [ms, ...] }
  const prof = opts.profile ? {} : null;
  let pt = 0;
  const tick = (name) => { if (!prof) return; const now = performance.now(); (prof[name] ||= []).push(now - pt); pt = now; };

  function render(st) {
    if (prof) pt = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // light behind the glass, brightening with every flip: the rest glow is the background,
    // the crest glow is cross-faded over it at the pulse's weight. Where the weight is so small
    // that the fade truncates to the rest image on every pixel the pulse snaps to zero
    // (pixel-identical); while it is zero only the mark's box is repainted (nothing outside it
    // changes): cheap frames.
    if (dbg.glow) {
      if (gl) {
        // float composition per frame; the pulse's tail changes single scattered pixels only
        const P = st.pulse < 2e-4 ? 0 : st.pulse;
        if (P > 0) { glowGL(P); ctx.drawImage(glc, 0, 0); }
        else if (lastP > 0 || needFull) ctx.drawImage(glowA, 0, 0);
        else ctx.drawImage(glowA, mbox.x, mbox.y, mbox.w, mbox.h, mbox.x, mbox.y, mbox.w, mbox.h);
        lastP = P; needFull = false;
      } else {
        const P = st.pulse < glowD.snap ? 0 : st.pulse;
        if (P > 0 || lastP > 0 || needFull) ctx.drawImage(glowA, 0, 0);
        else ctx.drawImage(glowA, mbox.x, mbox.y, mbox.w, mbox.h, mbox.x, mbox.y, mbox.w, mbox.h);
        if (P > 0) {
          ctx.globalAlpha = P;
          ctx.drawImage(glowD.c, glowD.x0, glowD.y0);
          ctx.globalAlpha = 1;
        }
        lastP = P; needFull = false;
      }
    } else { ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, W, Hh); }
    tick('glow');

    // solid black face
    base(); ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.moveTo(...T[0]); ctx.lineTo(...T[1]); ctx.lineTo(...T[2]); ctx.closePath(); ctx.fill();
    tick('face');

    const showStream = dbg.particles && (st.grains.length || st.core);
    if (showStream && streamLayer === 'behind') drawStream(MAIN, st);

    // motion blur weight for this frame
    const travel = st.omega * (R + H / 2) * s * BLUR.shutter;
    const w = dbg.blur ? smoothstep((travel - BLUR.onset) / BLUR.width) : 0;
    const rots = w > 0 ? sampleRots(st) : null;

    // the column goes under both sand bodies: the pile covers its top, the mound its foot,
    // each with its own clean edge, so there is no seam where sand meets stream
    if (dbg.particles && st.column) drawColumn(st);
    tick('column');

    // sand, attached to the glass while it turns
    if (w <= 0) {
      drawSand(MAIN, st, st.rot);
    } else {
      const X = blurred(box.sand, st, rots, w, (L, rot) => drawSand(L, st, rot), true);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(X, box.x0, box.y0);
    }
    tick('sand');

    // etched ring, over the sand so its inner half is never painted over
    // (fixed in place: a circle is unchanged by the flip)
    drawRing();
    tick('ring');

    // the stream, from the apex: over the ring, behind the visible sand and under the walls.
    // While the glass turns it ends where it first meets a wall (the engine's first-hit
    // contact), so a wall never hides part of it: it lands on the wall instead.
    if (showStream && streamLayer !== 'behind') {
      if (streamLayer === 'front') drawStream(MAIN, st);
      else {
        const mc = mark.c.getContext('2d');
        clear(mark.c);
        drawStream({ c: mc, x0: mark.x0, y0: mark.y0 }, st);
        mc.globalCompositeOperation = 'destination-out';
        mc.setTransform(1, 0, 0, 1, 0, 0);
        if (w <= 0) {
          drawMask({ c: mc, x0: mark.x0, y0: mark.y0 }, st, st.rot);
        } else {
          const M = blurred(box.mask, st, rots, w, (L, rot) => drawMask(L, st, rot), false);
          mc.drawImage(M, box.x0 - mark.x0, box.y0 - mark.y0);
        }
        mc.globalCompositeOperation = 'source-over';
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(mark.c, mark.x0, mark.y0);
      }
    }
    tick('stream');

    // glass walls: they cover every edge where sand meets glass
    if (w <= 0) {
      drawWalls(MAIN, st.rot);
    } else {
      const X = blurred(box.walls, st, rots, w, (L, rot) => drawWalls(L, rot), true);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(X, box.x0, box.y0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    tick('walls');
  }

  // eight-sample blur of one group, mixed with its sharp render by w. Returns group.X.
  // tree: averaged pairwise (P0,P1 -> Q0/Q1 -> F) so flat areas round by at most one level;
  // the mask (a soft alpha) is simply accumulated.
  function blurred(group, st, rots, w, draw, tree) {
    const { S, F, X } = group;
    const L = { c: S.getContext('2d'), x0: box.x0, y0: box.y0 };
    const sample = (k) => { clear(S); draw(L, rots[k]); };
    if (tree) {
      const { P0, P1, Q0, Q1 } = group;
      const pair = (dst, k) => { sample(k); mix(dst, S, 0.5, S, 0); sample(k + 1); const c = dst.getContext('2d'); c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.5; c.drawImage(S, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; };
      pair(P0, 0); pair(P1, 2); avg(Q0, P0, P1);
      pair(P0, 4); pair(P1, 6); avg(Q1, P0, P1);
      avg(F, Q0, Q1);
    } else {
      clear(F);
      const c = F.getContext('2d');
      c.globalCompositeOperation = 'lighter'; c.globalAlpha = 1 / BLUR.samples;
      for (let k = 0; k < BLUR.samples; k++) { sample(k); c.drawImage(S, 0, 0); }
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    }
    if (w >= 1) return F;
    clear(S); draw(L, st.rot);                    // the sharp render at the frame time
    mix(X, S, 1 - w, F, w);
    return X;
  }

  // -------------------------------------------------------------- clock ---
  const reduced = reducedMotion;
  let clock = opts.startTime ?? (reduced ? STATIC_PHASE : OPEN_PHASE);
  let last = null, raf = 0, running = false, visible = true;

  function frame(now) {
    if (!running) return;
    if (last !== null) clock += Math.min(0.1, (now - last) / 1000);   // hitches slow down, never jump
    last = now;
    render(stateAt(clock));
    raf = requestAnimationFrame(frame);
  }
  const autoplay = opts.autoplay !== false;
  function start() { if (running || reduced || !autoplay) return; running = true; last = null; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  initGL();
  layout();
  render(stateAt(clock));
  const ro = new ResizeObserver(() => { layout(); render(stateAt(clock)); });
  ro.observe(canvas);
  const onVis = () => { visible = !document.hidden; visible ? start() : stop(); };
  document.addEventListener('visibilitychange', onVis);
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(([e]) => (e.isIntersecting && visible ? start() : stop()));
    io.observe(canvas);
  }
  start();

  return {
    start, stop,
    // deterministic: render the frame at absolute time t (seconds)
    renderAt(t) { stop(); clock = t; const st = stateAt(t); tick('sim'); render(st); },
    state: (t) => stateAt(t),
    prof,
    destroy() { stop(); ro.disconnect(); io && io.disconnect(); document.removeEventListener('visibilitychange', onVis); if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); ext && ext.loseContext(); } },
    timing: TIMING,
    get glow() { return gl ? 'webgl' : 'canvas2d'; },
  };
}
