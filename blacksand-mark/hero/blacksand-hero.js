// blacksand-hero.js
// Canvas renderer for the backlit blacksand mark: sand stream from the apex,
// volume-conserving chambers, 180 deg flip with motion blur, a breathing backlight.
//
//   import { mountBlacksand } from './blacksand-hero.js';
//   const hero = mountBlacksand(document.querySelector('canvas'));
//   // hero.destroy() on unmount
//
// The canvas fills its CSS box. The page behind it should be #000.

import { createGeometry, createChambers, createSim, TIMING, STATIC_PHASE, OPEN_PHASE, STREAM, rotAt, smoothstep, SOURCE, STATIC_LINE } from './blacksand-engine.js';

export const PALETTE = {
  bg: '#000',
  etchTop: [38, 38, 38], etchBot: [74, 74, 74],      // ring + walls
  sandTop: [54, 54, 54], sandBot: [94, 94, 94],      // sand body
  surface: 'rgba(160,160,160,0.28)',                 // lit edge of a sand surface
  stream: [92, 150], glint: 190, grainAlpha: 0.5,    // grain grey range
};
// backlight: the rim (soft edge light on the triangle) and the pool of light under the base.
// Both brighten with the flip; the crest is +50% on the rim and the spill keeps its ratio.
export const GLOW = { rim: 0.35, rimBreath: 0.15, poolBreath: 0.10 };
// pointer light (opt-in): the source follows a fine pointer within this offset (units of the
// side), confined to the lower arc (within +/-100 deg of straight down), on a critically
// damped spring, and its lean (direction from the centroid) turns at most maxLeanRate deg/s;
// it lets go after the pointer leaves or idles
export const POINTER = { reach: 0.10, arc: 100, settle: 1.2, idle: 2.5, maxLeanRate: 60 };
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
  // the still frame (reduced motion) is the approved static look: no breath, no pointer
  const reducedMotionEarly = opts.reducedMotion ?? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reducedMotionEarly) dbg.breath = false;

  let W = 0, Hh = 0, dpr = 1, s = 1, ox = 0, oy = 0;     // device-space transform for mark units
  let glowA = null, glowD = null, tex = null;           // backlight at rest; crest image (2D fallback)
  let gl = null, glc = null, glU = null;        // WebGL glow compositor (float + dither per frame)
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
  // Backlight (design panel consensus). A source hidden behind the triangle:
  //   rim   = the Gaussian-blurred outline (sigma 14 units), alpha 0.35 x (1 + 0.15 b),
  //           and, while the pointer light is active, x (1 + 0.25 a max(0, w - 1))
  //   pool  = the elliptical pool under the base, x (1 + 0.10 b)
  //   halo  = b w [0.06 exp(-d / 0.05 S) + 0.05 exp(-d / 0.40 S)] outside the silhouette
  // b: the breath (0 at the trough = the approved static look exactly); d: distance from the
  // triangle; S: its side; w = clamp(1 + 12 (n . o), 0.6, 2.2) weights the halo toward the
  // source offset o (in units of S, y down), n the outward direction from the nearest point
  // of the triangle (edge normal, blending round the corners).
  // Composed per frame in floating point (WebGL2) and quantised once with a fixed per-pixel
  // dither, so no large area shows an 8-bit step. Without WebGL2: rest and crest images
  // (crest at the rest offset) cross-faded by b; that fallback has no swing or pointer and
  // can show one-level steps over flat regions while the breath moves.
  const S_SIDE = Math.hypot(T[1][0] - T[2][0], T[1][1] - T[2][1]);
  const GLSL_VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
  const GLSL_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D rim; uniform vec2 res; uniform vec3 mark;
uniform float kRim, kSpill, breath, act; uniform vec2 src;  // breath: the halo factor h
uniform vec2 T0, T1, T2; uniform float side;
out vec4 o;
float spill(float d) {
  if (d >= 1.0) return 0.0;
  if (d < 0.28) return mix(0.22, 0.09, d / 0.28);
  if (d < 0.6) return mix(0.09, 0.025, (d - 0.28) / 0.32);
  return mix(0.025, 0.0, (d - 0.6) / 0.4);
}
vec2 closestOnSeg(vec2 p, vec2 a, vec2 b) { vec2 ab = b - a; float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0); return a + ab * t; }
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
void main() {
  float r = texture(rim, gl_FragCoord.xy / res).r;
  float u = (gl_FragCoord.x - mark.x) / mark.z;
  float v = (res.y - gl_FragCoord.y - mark.y) / mark.z;
  vec2 P = vec2(u, v);
  float dx = u - 512.0, dy = (v - 905.0) * (1250.0 / 820.0);
  float sp = spill(sqrt(dx * dx + dy * dy) / 1250.0);
  // nearest point of the triangle, and the direction out of it
  vec2 c0 = closestOnSeg(P, T0, T1), c1 = closestOnSeg(P, T1, T2), c2 = closestOnSeg(P, T2, T0);
  float d0 = distance(P, c0), d1 = distance(P, c1), d2 = distance(P, c2);
  vec2 c = c0; float dd = d0;
  if (d1 < dd) { c = c1; dd = d1; } if (d2 < dd) { c = c2; dd = d2; }
  float s0 = cross2(T1 - T0, P - T0), s1 = cross2(T2 - T1, P - T1), s2 = cross2(T0 - T2, P - T2);
  bool inside = (s0 >= 0.0 && s1 >= 0.0 && s2 >= 0.0) || (s0 <= 0.0 && s1 <= 0.0 && s2 <= 0.0);
  vec2 n = dd > 1e-4 ? (P - c) / dd : vec2(0.0, 1.0);
  if (inside) n = -n;
  float w = clamp(1.0 + 12.0 * dot(n, src), 0.6, 2.2);
  float halo = inside ? 0.0 : breath * w * (0.06 * exp(-dd / (0.05 * side)) + 0.05 * exp(-dd / (0.40 * side)));
  float rimK = kRim * (1.0 + 0.25 * act * max(0.0, w - 1.0));
  uint x = uint(gl_FragCoord.x), y = uint(res.y - gl_FragCoord.y);
  uint h = x * 374761393u + y * 668265263u; h = (h ^ (h >> 13)) * 1274126177u; h ^= h >> 16;
  float d = float(h) / 4294967296.0;
  float q = floor((r * rimK + sp * kSpill + halo) * 255.0 + d);
  o = vec4(vec3(min(q, 255.0) / 255.0), 1.0);
}`;
  // the same light in JS, for the 2D fallback's precomputed images
  function haloJS(u, v, b, srcX, srcY) {
    if (b <= 0) return 0;
    const P = [u, v];
    let best = Infinity, cx = 0, cy = 0;
    for (let k = 0; k < 3; k++) {
      const A = T[k], B = T[(k + 1) % 3], abx = B[0] - A[0], aby = B[1] - A[1];
      const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * abx + (P[1] - A[1]) * aby) / (abx * abx + aby * aby)));
      const qx = A[0] + abx * t, qy = A[1] + aby * t, dd = Math.hypot(P[0] - qx, P[1] - qy);
      if (dd < best) { best = dd; cx = qx; cy = qy; }
    }
    const cr = (a, b2, p) => (b2[0] - a[0]) * (p[1] - a[1]) - (b2[1] - a[1]) * (p[0] - a[0]);
    const s0 = cr(T[0], T[1], P), s1 = cr(T[1], T[2], P), s2 = cr(T[2], T[0], P);
    if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) return 0;
    const nx = best > 1e-4 ? (P[0] - cx) / best : 0, ny = best > 1e-4 ? (P[1] - cy) / best : 1;
    const w = Math.max(0.6, Math.min(2.2, 1 + 12 * (nx * srcX + ny * srcY)));
    return b * w * (0.06 * Math.exp(-best / (0.05 * S_SIDE)) + 0.05 * Math.exp(-best / (0.40 * S_SIDE)));
  }
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
      const U = (n) => gl.getUniformLocation(prog, n);
      glU = { res: U('res'), mark: U('mark'), kRim: U('kRim'), kSpill: U('kSpill'), breath: U('breath'), act: U('act'), src: U('src') };
      gl.uniform1i(U('rim'), 0);
      gl.uniform2f(U('T0'), T[0][0], T[0][1]); gl.uniform2f(U('T1'), T[1][0], T[1][1]); gl.uniform2f(U('T2'), T[2][0], T[2][1]);
      gl.uniform1f(U('side'), S_SIDE);
      glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; glKey = ''; buildGlow(); needFull = true; }, false);
      return true;
    } catch (e) { gl = null; return false; }
  }
  // draw the glow for breath b, source offset (sx, sy) and pointer activity a (only when changed)
  let glKey = '';
  function glowGL(b, sx, sy, a) {
    const key = `${b},${sx},${sy},${a}`;
    if (glKey === key) return;
    gl.uniform1f(glU.kRim, GLOW.rim * (1 + GLOW.rimBreath * b));
    gl.uniform1f(glU.kSpill, 1 + GLOW.poolBreath * b);
    // halo factor: the breath, with a floor of 0.5 a while the pointer light is active
    // (equal to b when a = 0, so the pointer-off trough is the static look exactly)
    gl.uniform1f(glU.breath, b + 0.5 * a * (1 - b)); gl.uniform1f(glU.act, a); gl.uniform2f(glU.src, sx, sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    glKey = key;
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
      glKey = ''; glowGL(0, 0, SOURCE.down, 0);
      // the rest image (breath 0: the approved static look), pixel-identical to the shader
      glowA = mkCanvas(W, Hh); glowA.getContext('2d').drawImage(glc, 0, 0);
      glowD = null;
      return;
    }
    const rim = g.getImageData(0, 0, W, Hh).data;
    const A = new ImageData(W, Hh), B = new ImageData(W, Hh);
    const a = A.data, b = B.data;
    const kR = GLOW.rim / 255, kRp = kR * (1 + GLOW.rimBreath), kSp = 1 + GLOW.poolBreath;
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
        const vb = Math.min(255, Math.floor(r * kRp * 255 + sp * kSp * 255 + haloJS(u, v, 1, 0, SOURCE.down) * 255 + d));
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
    if (streamLayer !== 'front') c.drawImage(tex, ix - R - 1 / s, iy - R - 1 / s, tex.width / s, tex.height / s);   // the still frame's sand is flat
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
    if (dbg.particles && st.flipFade > 0 && streamLayer !== 'front' && (st.splash.length || st.rollers.length)) {
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

  let lastRest = false, needFull = true, mbox = null;    // partial repaint bookkeeping

  // --------------------------------------------------- pointer light ---
  // Opt-in (opts.pointerLight). A fine pointer over the canvas pulls the hidden source toward
  // it: offset up to POINTER.reach (units of the side) from the triangle's centroid, confined
  // to the lower arc so it stays a backlight. Source and activity a (0..1) ride critically
  // damped springs (POINTER.settle to settle), so nothing ever steps; the light lets go when
  // the pointer leaves or idles for POINTER.idle seconds. Touch, pen-less coarse pointers and
  // reduced motion never engage it, and renderAt (captures, the MP4) leaves it untouched.
  const pointer = { a: 0, va: 0, x: 0, y: SOURCE.down, vx: 0, vy: 0, tx: 0, ty: SOURCE.down, ta: 0, lastMove: -1e9 };
  const pointerOn = !!opts.pointerLight && typeof window !== 'undefined';
  const centroid = [(T[0][0] + T[1][0] + T[2][0]) / 3, (T[0][1] + T[1][1] + T[2][1]) / 3];
  function pointerTarget(e) {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) * dpr - ox) / s, py = ((e.clientY - rect.top) * dpr - oy) / s;
    let dx = (px - centroid[0]) / S_SIDE, dy = (py - centroid[1]) / S_SIDE;
    let r = Math.hypot(dx, dy) * POINTER.reach;              // one side away = full reach
    r = Math.min(POINTER.reach, r);
    let ang = Math.atan2(dx, dy);                             // 0 = straight down
    const lim = POINTER.arc * Math.PI / 180;
    // past the arc the reach fades to nothing at straight up, so a pointer crossing over the
    // apex never makes the light swing from one end of the arc to the other
    const over = Math.abs(ang) - lim;
    if (over > 0) r *= 1 - smoothstep(over / (Math.PI - lim));
    ang = Math.max(-lim, Math.min(lim, ang));
    pointer.tx = r * Math.sin(ang); pointer.ty = r * Math.cos(ang);
  }
  const fine = (e) => e.pointerType === 'mouse' && (typeof matchMedia === 'undefined' || matchMedia('(pointer: fine)').matches);
  const onPointer = (e) => { if (!fine(e)) return; pointerTarget(e); pointer.ta = 1; pointer.lastMove = performance.now(); };
  const onLeave = () => { pointer.ta = 0; };
  // critically damped spring step (omega from the 2% settle time)
  const OMEGA = 5.83 / POINTER.settle;
  function spring(v, vel, target, dt) {
    const acc = OMEGA * OMEGA * (target - v) - 2 * OMEGA * vel;
    vel += acc * dt; return [v + vel * dt, vel];
  }
  function stepPointer(dt) {
    if (!pointerOn) return;
    if (performance.now() - pointer.lastMove > POINTER.idle * 1000) pointer.ta = 0;
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    for (let k = 0; k < n; k++) {
      const h = dt / n;
      [pointer.a, pointer.va] = spring(pointer.a, pointer.va, pointer.ta, h);
      const px0 = pointer.x, py0 = pointer.y;
      [pointer.x, pointer.vx] = spring(pointer.x, pointer.vx, pointer.tx, h);
      [pointer.y, pointer.vy] = spring(pointer.y, pointer.vy, pointer.ty, h);
      // cap how fast the light's direction turns (radius is free)
      const r0 = Math.hypot(px0, py0), r1 = Math.hypot(pointer.x, pointer.y);
      if (r0 > 1e-4 && r1 > 1e-4) {
        const a0 = Math.atan2(px0, py0), a1 = Math.atan2(pointer.x, pointer.y);
        let da = a1 - a0; da -= 2 * Math.PI * Math.round(da / (2 * Math.PI));
        const cap = POINTER.maxLeanRate * Math.PI / 180 * h;
        if (Math.abs(da) > cap) {
          const a = a0 + Math.sign(da) * cap;
          pointer.x = r1 * Math.sin(a); pointer.y = r1 * Math.cos(a);
          pointer.vx = (pointer.x - px0) / h; pointer.vy = (pointer.y - py0) / h;
        }
      }
    }
    if (pointer.ta === 0 && pointer.a < 1e-3 && Math.abs(pointer.va) < 1e-3) { pointer.a = 0; pointer.va = 0; }
    pointer.a = Math.max(0, Math.min(1, pointer.a));
  }

  // optional section timings (opts.profile): hero.prof = { section: [ms, ...] }
  const prof = opts.profile ? {} : null;
  let pt = 0;
  const tick = (name) => { if (!prof) return; const now = performance.now(); (prof[name] ||= []).push(now - pt); pt = now; };

  function render(st) {
    if (prof) pt = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // light behind the glass: it breathes continuously; the hidden source leans with the glass
    // and, if enabled, toward the pointer. At the breath's trough (with no pointer) it is the
    // rest image, the approved static look; while that holds, only the mark's box is repainted.
    if (dbg.glow) {
      const b = dbg.breath === false ? 0 : st.breath;
      const so = dbg.breath === false ? [0, SOURCE.down] : st.source;
      const pa = pointer.a, sx = (1 - pa) * so[0] + pa * pointer.x, sy = (1 - pa) * so[1] + pa * pointer.y;
      const atRest = b === 0 && pa === 0;
      if (gl) {
        if (!atRest) { glowGL(b, sx, sy, pa); ctx.drawImage(glc, 0, 0); }
        else if (!lastRest || needFull) ctx.drawImage(glowA, 0, 0);
        else ctx.drawImage(glowA, mbox.x, mbox.y, mbox.w, mbox.h, mbox.x, mbox.y, mbox.w, mbox.h);
      } else {
        // 2D fallback: breath only (the crest image is at the rest offset)
        const P = b < glowD.snap ? 0 : b;
        if (P > 0 || !lastRest || needFull) ctx.drawImage(glowA, 0, 0);
        else ctx.drawImage(glowA, mbox.x, mbox.y, mbox.w, mbox.h, mbox.x, mbox.y, mbox.w, mbox.h);
        if (P > 0) { ctx.globalAlpha = P; ctx.drawImage(glowD.c, glowD.x0, glowD.y0); ctx.globalAlpha = 1; }
      }
      lastRest = atRest; needFull = false;
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
    // the still frame (stream in front) is the static logo: the line replaces the pour
    if (dbg.particles && st.column && streamLayer !== 'front') drawColumn(st);
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
      if (streamLayer === 'front') { /* the static line is drawn last, over the walls */ }
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
    // the static logo's line (the still frame only): over the walls, under the bottom mound
    if (streamLayer === 'front' && dbg.particles) {
      const triPx = (T[1][1] - T[0][1]) * s;                    // the triangle's height in device px
      const lw = triPx * 1024 / 740 >= 128 ? STATIC_LINE.master : STATIC_LINE.small;
      ctx.save();
      base(); ctx.beginPath(); ctx.moveTo(...T[0]); ctx.lineTo(...T[1]); ctx.lineTo(...T[2]); ctx.closePath(); ctx.clip();
      // it runs from the apex down into the bottom mound: clipped above the mound's surface
      // (6 units past the peak, so the pile covers its end)
      surfacePath((x) => C.mound(st.peak, x), false); ctx.lineTo(ix + R + 24, 0); ctx.lineTo(ix - R - 24, 0); ctx.closePath(); ctx.clip();
      ctx.beginPath(); ctx.moveTo(ix, T[0][1]); ctx.lineTo(ix, st.peak + 6);
      ctx.strokeStyle = STATIC_LINE.tone; ctx.lineWidth = lw; ctx.lineCap = 'butt'; ctx.stroke();
      ctx.restore(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
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
    if (last !== null) { const dt = Math.min(0.1, (now - last) / 1000); clock += dt; stepPointer(dt); }   // hitches slow down, never jump
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
  if (pointerOn && !reduced) {
    canvas.addEventListener('pointerenter', onPointer); canvas.addEventListener('pointermove', onPointer);
    canvas.addEventListener('pointerleave', onLeave);
  }
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
    destroy() { stop(); ro.disconnect(); io && io.disconnect(); document.removeEventListener('visibilitychange', onVis); canvas.removeEventListener('pointerenter', onPointer); canvas.removeEventListener('pointermove', onPointer); canvas.removeEventListener('pointerleave', onLeave); if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); ext && ext.loseContext(); } },
    timing: TIMING,
    get glow() { return gl ? 'webgl' : 'canvas2d'; },
    get pointerState() { return { a: pointer.a, x: pointer.x, y: pointer.y }; },
  };
}
