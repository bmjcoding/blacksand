// blacksand-hero.js
// Canvas renderer for the backlit blacksand mark: sand stream from the apex,
// volume-conserving chambers, 180 deg flip, glow pulse on every flip.
//
//   import { mountBlacksand } from './blacksand-hero.js';
//   const hero = mountBlacksand(document.querySelector('canvas'));
//   // hero.destroy() on unmount
//
// The canvas fills its CSS box. The page behind it should be #000.

import { createGeometry, createChambers, createSim, TIMING, STATIC_PHASE, STREAM } from './blacksand-engine.js';

export const PALETTE = {
  bg: '#000',
  etchTop: [38, 38, 38], etchBot: [74, 74, 74],      // ring + walls
  sandTop: [54, 54, 54], sandBot: [94, 94, 94],      // sand body
  surface: 'rgba(160,160,160,0.28)',                 // lit edge of a sand surface
  stream: [92, 150], glint: 190, grainAlpha: 0.5,                     // grain grey range
};

const lerp3 = (a, b, u) => a.map((v, i) => Math.round(v + (b[i] - v) * u));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function mountBlacksand(canvas, opts = {}) {
  const G = createGeometry();
  const C = createChambers(G);
  let sim = createSim(G, C, opts.seed ?? 7);
  // the sim only runs forward; asking for an earlier time rebuilds it deterministically
  const stateAt = (t) => { if (t < sim.t - 1e-9) sim = createSim(G, C, opts.seed ?? 7); return sim.stateAt(t); };
  const ctx = canvas.getContext('2d', { alpha: false });
  const { ix, iy, R, H, L, T } = G;

  let W = 0, Hh = 0, dpr = 1, s = 1, ox = 0, oy = 0;     // device-space transform for mark units
  let glow = null, tex = null, dither = null;
  let scanvas = null, sctx = null;                       // stream layer for 'behind-sand'

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
    ox = Math.round(cxDev - ix * s + 0) + 0;
    oy = cyDev - ((138 + 878) / 2) * s;
    ox = Math.round(ox + ix * s) - ix * s;
    oy = Math.round(oy + iy * s) - iy * s;
    buildGlow(); buildTexture(); buildDither();
    scanvas = document.createElement('canvas'); scanvas.width = W; scanvas.height = Hh;
    sctx = scanvas.getContext('2d');
  }
  const base = (c = ctx) => c.setTransform(s, 0, 0, s, ox, oy);

  // ----------------------------------------------------- pre-rendered glow ---
  // Backlight: a soft rim on all three edges. The pooled light under the base is the spill gradient.
  function buildGlow() {
    glow = document.createElement('canvas');
    glow.width = W; glow.height = Hh;
    const g = glow.getContext('2d');
    g.globalCompositeOperation = 'lighter';
    const OFF = W + 2000;                        // draw shapes off-canvas, keep only their shadows
    const shadow = (alpha, sigmaUnits, draw) => {
      g.save();
      g.setTransform(s, 0, 0, s, ox - OFF, oy);
      g.shadowOffsetX = OFF;
      g.shadowOffsetY = 0;
      g.shadowBlur = 2 * sigmaUnits * s;
      g.shadowColor = `rgba(255,255,255,${alpha})`;
      g.strokeStyle = '#fff'; g.fillStyle = '#fff';
      draw(g);
      g.restore();
    };
    shadow(0.35, 14, (c) => { c.lineWidth = 10; c.lineJoin = 'round'; c.beginPath(); c.moveTo(...T[0]); c.lineTo(...T[1]); c.lineTo(...T[2]); c.closePath(); c.stroke(); });
  }

  // static grain dither inside the spill, so the gradient never bands on 8-bit panels
  function buildDither() {
    dither = document.createElement('canvas');
    dither.width = 128; dither.height = 128;
    const d = dither.getContext('2d');
    const img = d.createImageData(128, 128);
    let a = 0x9e3779b9 >>> 0;
    for (let i = 0; i < img.data.length; i += 4) {
      a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0;
      const v = a % 3;                           // 0..2 of 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    d.putImageData(img, 0, 0);
  }

  // sand grain texture, in glass space (it turns with the vessel)
  function buildTexture() {
    const size = Math.ceil(2 * R * s) + 2;
    tex = document.createElement('canvas');
    tex.width = size; tex.height = size;
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
  const rotate = (rot, c = ctx) => { base(c); c.translate(ix, iy); c.rotate(rot); c.translate(-ix, -iy); };

  // remove a sand body from a layer (exactly the region drawSand fills)
  function cutSand(c, which, surfaceFn, rot) {
    c.save();
    rotate(rot, c); chamberPath(which, c); c.clip();
    rotate(rot, c); surfacePath(surfaceFn, true, c);
    c.fillStyle = '#000'; c.fill();
    c.restore();
  }

  function etchGradient() {
    const gr = ctx.createLinearGradient(0, iy - R - H / 2, 0, iy + R + H / 2);
    gr.addColorStop(0, rgb(PALETTE.etchTop)); gr.addColorStop(1, rgb(PALETTE.etchBot));
    return gr;
  }
  function sandGradient() {
    const gr = ctx.createLinearGradient(0, iy - R, 0, iy + R);
    gr.addColorStop(0, rgb(PALETTE.sandTop)); gr.addColorStop(1, rgb(PALETTE.sandBot));
    return gr;
  }

  function drawSand(which, surfaceFn, rot, texRot, edge) {
    ctx.save();
    rotate(rot); chamberPath(which); ctx.clip();
    rotate(rot); surfacePath(surfaceFn, true); ctx.clip();
    base(); ctx.fillStyle = sandGradient(); ctx.fillRect(ix - R - 40, iy - R - 40, 2 * R + 80, 2 * R + 80);
    rotate(texRot);
    ctx.drawImage(tex, ix - R - 1 / s, iy - R - 1 / s, tex.width / s, tex.height / s);
    ctx.restore();
    // lit surface edge
    ctx.save();
    rotate(rot); chamberPath(which); ctx.clip();
    rotate(rot); surfacePath(surfaceFn, false);
    base(); ctx.globalAlpha = edge; ctx.strokeStyle = PALETTE.surface; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------- frame ---
  const dbg = Object.assign({ glow: true, particles: true }, opts.debug || {});
  const reducedMotion = opts.reducedMotion ?? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // In motion the stream falls behind the sand (into the top pile, out of the neck).
  // A still frame keeps the static logo's foreground line.
  const streamLayer = opts.streamLayer ?? (reducedMotion ? 'front' : 'behind-sand');
  // Sand leaving the neck: a column exactly as wide as the opening at the neck, in the sand's
  // own tone, with the moving grains on top. Drawn under both sand bodies.
  function columnPath(st) {
    const { y0, y1 } = st.column, N = 32;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) { const y = y0 + (y1 - y0) * i / N; i ? ctx.lineTo(ix + st.halfW(y), y) : ctx.moveTo(ix + st.halfW(y), y); }
    for (let i = N; i >= 0; i--) { const y = y0 + (y1 - y0) * i / N; ctx.lineTo(ix - st.halfW(y), y); }
    ctx.closePath();
  }
  function drawColumn(st) {
    ctx.save();
    base(); columnPath(st); ctx.clip();
    ctx.fillStyle = sandGradient(); ctx.fillRect(ix - 20, st.column.y0 - 2, 40, st.column.y1 - st.column.y0 + 4);
    base();
    ctx.lineCap = 'round';
    const BINS = 6, SB = 3, { rMin, rMax } = STREAM;
    const buckets = Array.from({ length: (BINS + 1) * SB }, () => []);
    for (const gr of st.neckGrains) {
      const tb = gr.shade > 1 ? BINS : Math.min(BINS - 1, Math.floor(gr.shade * BINS));
      const sb = Math.min(SB - 1, Math.floor(((gr.r - rMin) / (rMax - rMin)) * SB));
      buckets[tb * SB + sb].push(gr);
    }
    for (let tb = 0; tb <= BINS; tb++) {
      const c = tb === BINS ? PALETTE.glint : Math.round(PALETTE.stream[0] + (PALETTE.stream[1] - PALETTE.stream[0]) * ((tb + 0.5) / BINS));
      ctx.strokeStyle = `rgba(${c},${c},${c},${PALETTE.grainAlpha})`;
      for (let sb = 0; sb < SB; sb++) {
        const list = buckets[tb * SB + sb];
        if (!list.length) continue;
        ctx.lineWidth = 2 * (rMin + (rMax - rMin) * ((sb + 0.5) / SB));
        ctx.beginPath();
        for (const gr of list) { ctx.moveTo(gr.x0, gr.y0); ctx.lineTo(gr.x, gr.y); }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawStream(st, c2 = ctx) {
    const ctx = c2;
    {
      ctx.save();
      base(ctx);
      ctx.beginPath(); ctx.moveTo(...T[0]); ctx.lineTo(...T[1]); ctx.lineTo(...T[2]); ctx.closePath(); ctx.clip();
      if (st.core) {
        const { y0, y1 } = st.core;
        const yA = G.apex[1];
        const half = (y) => 1.3 * Math.min(1, Math.sqrt(Math.max(0, y - yA) / 46));
        ctx.beginPath();
        const N = 40;
        for (let i = 0; i <= N; i++) { const y = y0 + (y1 - y0) * i / N; i ? ctx.lineTo(ix + half(y), y) : ctx.moveTo(ix + half(y), y); }
        for (let i = N; i >= 0; i--) { const y = y0 + (y1 - y0) * i / N; ctx.lineTo(ix - half(y), y); }
        ctx.closePath();
        ctx.fillStyle = 'rgba(118,118,118,0.24)'; ctx.fill();
      }
      // grains, batched by tone and size
      const BINS = 6, SB = 3;
      const buckets = Array.from({ length: (BINS + 1) * SB }, () => []);
      const { rMin, rMax } = STREAM;
      for (const gr of st.grains) {
        const tb = gr.shade > 1 ? BINS : Math.min(BINS - 1, Math.floor(gr.shade * BINS));
        const sb = Math.min(SB - 1, Math.floor(((gr.r - rMin) / (rMax - rMin)) * SB));
        buckets[tb * SB + sb].push(gr);
      }
      ctx.lineCap = 'round';
      for (let tb = 0; tb <= BINS; tb++) {
        const c = tb === BINS ? PALETTE.glint : Math.round(PALETTE.stream[0] + (PALETTE.stream[1] - PALETTE.stream[0]) * ((tb + 0.5) / BINS));
        ctx.strokeStyle = `rgba(${c},${c},${c},${PALETTE.grainAlpha})`;
        for (let sb = 0; sb < SB; sb++) {
          const list = buckets[tb * SB + sb];
          if (!list.length) continue;
          ctx.lineWidth = 2 * (rMin + (rMax - rMin) * ((sb + 0.5) / SB));
          ctx.beginPath();
          for (const gr of list) { ctx.moveTo(gr.x0, gr.y0); ctx.lineTo(gr.x, gr.y); }
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  function render(st) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, W, Hh);

    // light behind the glass, brightening with every flip
    const P = st.pulse;
    const Ig = 1 + 1.1 * P, Is = 1 + 0.75 * P;
    ctx.globalCompositeOperation = 'lighter';
    if (dbg.glow) {
    ctx.save();
    base(); ctx.translate(512, 905); ctx.scale(1, 820 / 1250);
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1250);
    sg.addColorStop(0, `rgba(255,255,255,${0.22 * Is})`);
    sg.addColorStop(0.28, `rgba(255,255,255,${0.09 * Is})`);
    sg.addColorStop(0.6, `rgba(255,255,255,${0.025 * Is})`);
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(0, 0, 1250, 0, Math.PI * 2); ctx.fill();
    // dither, only where the spill exists
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ctx.createPattern(dither, 'repeat');
    ctx.fillRect(0, 0, W, Hh);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, Ig); ctx.drawImage(glow, 0, 0);
    if (Ig > 1) { ctx.globalAlpha = Ig - 1; ctx.drawImage(glow, 0, 0); }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // solid black face
    base(); ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.moveTo(...T[0]); ctx.lineTo(...T[1]); ctx.lineTo(...T[2]); ctx.closePath(); ctx.fill();

    if (dbg.particles && streamLayer === 'behind' && (st.grains.length || st.core)) drawStream(st);

    // sand, attached to the glass while it turns
    const texRot = st.rot + st.parity * Math.PI;
    // the lit surface edge fades in as a surface forms and out as a chamber fills or runs dry,
    // so no stray lines sit along the walls or under the ring
    // the column goes under both sand bodies: the pile covers its top, the mound its foot,
    // each with its own clean edge, so there is no seam where sand meets stream
    if (dbg.particles && st.column) drawColumn(st);
    if (st.fTop < 1) drawSand('top', (x) => C.crater(st.crater, x), st.rot, texRot, Math.min(1, (1 - st.fTop) / 0.12, st.fTop / 0.04));
    if (st.fBot > 0) drawSand('bot', (x) => C.mound(st.peak, x), st.rot, texRot, Math.min(1, st.fBot / 0.06, (1 - st.fBot) / 0.04));

    // splash + rolling grains (only exist while the glass is upright)
    if (dbg.particles && st.rot === 0 && (st.splash.length || st.rollers.length)) {
      ctx.save();
      base(); chamberPath('bot'); ctx.clip();
      ctx.lineCap = 'round';
      for (const p of st.splash) {
        const c = Math.round(PALETTE.stream[0] + (PALETTE.stream[1] - PALETTE.stream[0]) * Math.min(1, p.shade));
        ctx.strokeStyle = `rgb(${c},${c},${c})`; ctx.lineWidth = 2 * p.r;
        ctx.beginPath(); ctx.moveTo(p.x - p.vx / 240, p.y - p.vy / 240); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      for (const p of st.rollers) {
        const c = Math.round(96 + 50 * p.shade);
        ctx.fillStyle = `rgba(${c},${c},${c},${Math.max(0, Math.min(1, p.fade * 1.4))})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    // etched ring, over the sand so its inner half is never painted over
    // (fixed in place: a circle is unchanged by the flip)
    base(); ctx.strokeStyle = etchGradient(); ctx.lineWidth = H;
    ctx.beginPath(); ctx.arc(ix, iy, R, 0, Math.PI * 2); ctx.stroke();

    // the stream, from the apex
    if (dbg.particles && (st.grains.length || st.core)) {
      if (streamLayer === 'front') drawStream(st);
      else if (streamLayer === 'behind-sand') {
        // stream passes over the ring but behind the sand: draw it on its own layer,
        // cut the sand bodies out of that layer, then composite
        sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, W, Hh);
        drawStream(st, sctx);
        sctx.globalCompositeOperation = 'destination-out';
        if (st.fTop < 1) cutSand(sctx, 'top', (x) => C.crater(st.crater, x), st.rot);
        if (st.fBot > 0) cutSand(sctx, 'bot', (x) => C.mound(st.peak, x), st.rot);
        sctx.globalCompositeOperation = 'source-over';
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(scanvas, 0, 0);
      }
    }
    // glass walls, last: they cover every edge where sand meets glass
    rotate(st.rot);
    ctx.beginPath();
    ctx.moveTo(...G.tl); ctx.lineTo(...G.NL); ctx.lineTo(...G.bl);
    ctx.moveTo(...G.tr); ctx.lineTo(...G.NR); ctx.lineTo(...G.br);
    base(); ctx.strokeStyle = etchGradient(); ctx.lineWidth = L; ctx.lineJoin = 'miter'; ctx.miterLimit = 10; ctx.lineCap = 'butt';
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // -------------------------------------------------------------- clock ---
  const reduced = reducedMotion;
  let clock = opts.startTime ?? STATIC_PHASE;
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
    // deterministic: render the frame at absolute time t (seconds); t must not go backwards
    renderAt(t) { stop(); clock = t; render(stateAt(t)); },
    state: (t) => stateAt(t),
    destroy() { stop(); ro.disconnect(); io && io.disconnect(); document.removeEventListener('visibilitychange', onVis); },
    timing: TIMING,
  };
}
