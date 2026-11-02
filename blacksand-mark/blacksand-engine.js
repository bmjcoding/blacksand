// blacksand-engine.js
// Pure geometry + sand simulation for the blacksand mark. No DOM. Shared by the
// canvas hero renderer (browser) and the static SVG builder (node), so the static
// logo and the first frame of the animation come from identical state.
//
// Coordinate space: the 1024x1024 mark space of blacksand_v3.svg (y down).

export const DEG = Math.PI / 180;

// ---------------------------------------------------------------- geometry ---

function insetTri(T, d) {
  const n = T.length;
  const cx = T.reduce((s, p) => s + p[0], 0) / n;
  const cy = T.reduce((s, p) => s + p[1], 0) / n;
  const lines = T.map((p, i) => {
    const q = T[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    let nx = -dy / len, ny = dx / len;
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
    return { p: [p[0] + nx * d, p[1] + ny * d], r: [dx, dy] };
  });
  return lines.map((_, i) => {
    const a = lines[(i + n - 1) % n], b = lines[i];
    const den = a.r[0] * b.r[1] - a.r[1] * b.r[0];
    const t = ((b.p[0] - a.p[0]) * b.r[1] - (b.p[1] - a.p[1]) * b.r[0]) / den;
    return [a.p[0] + t * a.r[0], a.p[1] + t * a.r[1]];
  });
}

function incircle([[ax, ay], [bx, by], [cx, cy]]) {
  const a = Math.hypot(bx - cx, by - cy), b = Math.hypot(ax - cx, ay - cy), c = Math.hypot(ax - bx, ay - by);
  const p = a + b + c;
  const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  return [(a * ax + b * bx + c * cx) / p, (a * ay + b * by + c * cy) / p, (2 * area) / p];
}

export function createGeometry(opts = {}) {
  const T = [[512, 138], [968, 878], [56, 878]];   // triangle face (solid black in the backlit treatment)
  const Ti = insetTri(T, 40);                      // inner contour of the white-outline version; fixes the ring
  const [ix, iy, ir] = incircle(Ti);
  const H = 34;                                    // ring stroke
  const L = 22;                                    // wall stroke
  const R = ir - H / 2;                            // ring centreline radius
  const Rin = R - H / 2;                           // visible chamber radius (inner edge of ring)
  const th = 40 * DEG;
  const rim = (a) => [ix + R * Math.sin(a), iy - R * Math.cos(a)];
  const tl = rim(-th), tr = rim(th), bl = rim(Math.PI + th), br = rim(Math.PI - th);
  // The walls pinch to an opening of 2a between their inner faces. Solve for the centreline
  // half-width nk so the inner faces meet exactly at x = ix +/- a (the wall angle depends on nk).
  const a = opts.opening ?? 5;
  let nk = opts.neck ?? a + L;
  if (opts.neck == null) {
    for (let k = 0; k < 60; k++) {
      const sl = (br[1] - iy) / (br[0] - (ix + nk));
      nk = a + (L / 2) / Math.sin(Math.atan(sl));
    }
  }
  const NL = [ix - nk, iy], NR = [ix + nk, iy];
  // right bottom wall: NR -> br. slope dy/dx, and vertical offset of its inner face
  const slope = (br[1] - iy) / (br[0] - NR[0]);
  const alpha = Math.atan(slope);
  const wallV = (L / 2) / Math.cos(alpha);
  const hx = (L / 2) / Math.sin(alpha);            // horizontal half-thickness of a wall
  return { T, Ti, ix, iy, R, Rin, H, L, tl, tr, bl, br, nk, NL, NR, slope, wallV, hx, a: nk - hx, apex: T[0] };
}

// ---------------------------------------------------- chamber column model ---
// Volume conservation: the top chamber loses exactly the area the bottom gains.
// Each chamber is integrated column by column over its visible interior.

const K_BOT = Math.tan(33 * DEG);   // mound flank: angle of repose
const K_TOP = Math.tan(24 * DEG);   // crater walls in the draining chamber
const RHO = 7;                      // tip rounding of mound / crater

export const smoothAbs = (dx) => Math.sqrt(dx * dx + RHO * RHO) - RHO;

export function createChambers(G) {
  const { ix, iy, Rin, nk, slope, wallV } = G;
  const xs = [], loB = [], hiB = [];
  for (let x = ix - Rin + 0.5; x < ix + Rin; x += 1) {
    const dx = x - ix;
    const lineR = iy + (x - (ix + nk)) * slope;
    const lineL = iy + ((ix - nk) - x) * slope;
    xs.push(x);
    loB.push(Math.max(iy, lineR + wallV, lineL + wallV));
    hiB.push(iy + Math.sqrt(Rin * Rin - dx * dx));
  }
  // top chamber is the point reflection of the bottom one through (ix, iy)
  const n = xs.length;
  const loT = new Array(n), hiT = new Array(n);
  for (let i = 0; i < n; i++) { loT[i] = 2 * iy - hiB[n - 1 - i]; hiT[i] = 2 * iy - loB[n - 1 - i]; }

  let full = 0;
  for (let i = 0; i < n; i++) full += Math.max(0, hiB[i] - loB[i]);

  const mound = (p, x) => p + K_BOT * smoothAbs(x - ix);
  const crater = (c, x) => c - K_TOP * smoothAbs(x - ix);

  const areaBot = (p) => { let a = 0; for (let i = 0; i < n; i++) a += Math.max(0, hiB[i] - Math.max(loB[i], mound(p, xs[i]))); return a; };
  const areaTop = (c) => { let a = 0; for (let i = 0; i < n; i++) a += Math.max(0, hiT[i] - Math.max(loT[i], crater(c, xs[i]))); return a; };

  // search ranges that bracket "full" and "empty"
  const pFull = iy - K_BOT * Rin - 20, pEmpty = iy + Rin + 2;
  // "full" sits wholly under the ring stroke, so a full chamber shows no surface line at all
  const cFull = iy - G.R - G.H / 2 - 4, cEmpty = iy + K_TOP * Rin * 1.2 + 40;

  function solve(fn, lo, hi, target) {           // fn decreasing in its argument
    for (let k = 0; k < 48; k++) { const m = (lo + hi) / 2; if (fn(m) > target) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  // f = fraction of sand that has left the top / landed in the bottom
  const peakFor = (f) => f <= 0 ? pEmpty : f >= 1 ? pFull : solve(areaBot, pFull, pEmpty, f * full);
  const craterFor = (f) => f <= 0 ? cFull : f >= 1 ? cEmpty : solve(areaTop, cFull, cEmpty, (1 - f) * full);

  // where a falling grain stops: visible floor, or the sand surface, whichever is higher
  function impactY(p, x) {
    const dx = x - ix;
    if (Math.abs(dx) >= Rin) return iy + 0;
    const floor = iy + Math.sqrt(Rin * Rin - dx * dx);
    const lineR = iy + (x - (ix + nk)) * slope + wallV;
    const lineL = iy + ((ix - nk) - x) * slope + wallV;
    const lo = Math.max(iy, lineR, lineL);
    return Math.min(floor, Math.max(mound(p, x), lo));
  }
  return { full, peakFor, craterFor, mound, crater, impactY, K_BOT, K_TOP };
}

// --------------------------------------------------------------- timeline ---

export const TIMING = {
  flow: 5.4,      // the top drains through the neck; starts the instant the glass is upright
  tail: 0.85,     // last grains fall, splash and roll to rest (all particles dead before the flip)
  hold: 0.15,
  flip: 1.15,     // vessel rotates 180 deg
  rest: 0,        // none: sand never hangs in a full top chamber
};
TIMING.cycle = TIMING.flow + TIMING.tail + TIMING.hold + TIMING.flip + TIMING.rest;
TIMING.flipStart = TIMING.flow + TIMING.tail + TIMING.hold;
TIMING.flipEnd = TIMING.flipStart + TIMING.flip;

export const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const smooth = (u) => u * u * (3 - 2 * u);

// glow pulse, continuous in absolute time
export function pulseAt(t) {
  const { cycle, flipStart, flip, flipEnd } = TIMING;
  const k = Math.floor(t / cycle), ph = t - k * cycle;
  const tau = 0.95;
  const lastEnd = ph >= flipEnd ? k * cycle + flipEnd : (k - 1) * cycle + flipEnd;
  const decay = Math.exp(-(t - lastEnd) / tau);
  if (ph >= flipStart && ph < flipEnd) return Math.max(decay, smooth((ph - flipStart) / flip));
  return decay;
}

// ------------------------------------------------------------------- PRNG ---

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- simulation ---
// Fixed-step, seeded, deterministic. Grain positions are evaluated analytically
// at render time (exact ballistic extrapolation from the last step), so motion is
// smooth at any display refresh rate.

export const STREAM = {
  g: 3400,          // units / s^2
  v0: 40,           // exit speed at the apex
  sigma: 1.75,      // lateral spread of the apex stream (units)
  fan: 46,          // distance over which the apex stream opens from the apex point
  rate: 3200,       // grains / s (both streams)
  rMin: 0.5, rMax: 1.12,
  v0Neck: 70,       // speed sand leaves the neck
  taper: 0.14,      // the neck column narrows by this fraction over a full drop
};

export function createSim(G, C, seed = 7) {
  let rnd = mulberry32(seed);
  let simCycle = 0;
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const { g, v0, v0Neck } = STREAM;
  const yA = G.apex[1], yN = G.iy;
  const DT = 1 / 240;

  const apex = [];       // stream from the apex; it disappears into the top pile at the neck line
  const neck = [];       // sand leaving the neck, inside the column
  const splash = [];     // ballistic bounce grains
  const rollers = [];    // grains sliding down the mound flanks
  let n = 0, t = 0, accA = 0, accN = 0;      // integer step counter: no float drift across cycles
  const NC = Math.round(TIMING.cycle / DT);   // steps per cycle (exact: cycle is a multiple of 1/240 s)
  let peak = C.peakFor(0);

  const dist = (tt, v) => v * tt + 0.5 * g * tt * tt;
  const fall = (dy, v) => (-v + Math.sqrt(v * v + 2 * g * dy)) / g;
  // the apex stream stops so that its tail reaches the neck exactly as the top runs dry
  const apexStop = TIMING.flow - fall(yN - yA, v0);

  function levels(tt, phase) {
    const { cycle, flow } = TIMING;
    const ph = phase ?? tt - Math.floor(tt / cycle) * cycle;
    const fTop = Math.min(1, ph / flow);                         // drains from the moment it is upright
    const lag = fall(Math.max(1, C.impactY(peak, G.ix) - yN), v0Neck);
    const fBot = ph < lag ? 0 : Math.min(1, (ph - lag) / flow);
    return { ph, fTop, fBot };
  }
  const radius = () => STREAM.rMin + (STREAM.rMax - STREAM.rMin) * Math.pow(rnd(), 1.6);
  const tone = () => (rnd() < 0.025 ? 1.25 : rnd());

  function spawnApex(age) {
    let q = gauss(); q = Math.max(-2.6, Math.min(2.6, q));
    apex.push({ off: q * STREAM.sigma, drift: gauss() * 0.9, y: yA + dist(age, v0), vy: v0 + g * age, age, r: radius(), shade: tone() });
  }
  function spawnNeck(age) {
    neck.push({ u: rnd() * 2 - 1, y: yN + dist(age, v0Neck), vy: v0Neck + g * age, age, r: radius(), shade: tone() });
  }
  const apexX = (gr, y, age) => G.ix + gr.off * Math.min(1, Math.sqrt(Math.max(0, y - yA) / STREAM.fan)) + gr.drift * age;
  // column half-width: exactly the opening at the neck, narrowing slightly as it accelerates
  const halfW = (y) => G.a * (1 - STREAM.taper * Math.min(1, Math.max(0, (y - yN) / G.Rin)));
  const neckX = (gr, y) => G.ix + gr.u * (halfW(y) - gr.r * 0.6);

  function step() {
    // every pour replays the same grains: no particle outlives a cycle, so reseeding at the
    // cycle start makes the whole animation exactly periodic (and the loop seamless)
    const kc = Math.floor(n / NC);
    if (kc !== simCycle) { simCycle = kc; rnd = mulberry32(seed); accA = 0; accN = 0; }
    const { ph, fBot } = levels(t, (n - kc * NC) * DT);
    peak = C.peakFor(fBot);

    for (let i = apex.length - 1; i >= 0; i--) {
      const gr = apex[i];
      gr.y += gr.vy * DT + 0.5 * g * DT * DT; gr.vy += g * DT; gr.age += DT;
      if (gr.y >= yN) apex.splice(i, 1);                         // joined the sand at the neck
    }
    for (let i = neck.length - 1; i >= 0; i--) {
      const gr = neck[i];
      gr.y += gr.vy * DT + 0.5 * g * DT * DT; gr.vy += g * DT; gr.age += DT;
      const x = neckX(gr, gr.y);
      const hitY = C.impactY(peak, x);
      if (gr.y >= hitY) {
        neck.splice(i, 1);
        const q = rnd();
        if (q < 0.30) {
          splash.push({ x, y: hitY - 0.5, vx: (rnd() - 0.5) * 2 * (40 + 150 * rnd()), vy: -(50 + 190 * rnd()), r: 0.8 + 0.7 * rnd(), shade: rnd(), age: 0 });
        } else if (q < 0.62) {
          const dir = rnd() < 0.5 ? -1 : 1;
          rollers.push({ x: x + dir * (1 + 2 * rnd()), v: dir * (70 + 150 * rnd()), r: 0.9 + 0.6 * rnd(), shade: rnd(), age: 0, life: 0.12 + 0.35 * rnd() });
        }
      }
    }
    for (let i = splash.length - 1; i >= 0; i--) {
      const sp = splash[i];
      sp.x += sp.vx * DT; sp.y += sp.vy * DT + 0.5 * g * DT * DT; sp.vy += g * DT; sp.age += DT;
      if ((sp.vy > 0 && sp.y >= C.impactY(peak, sp.x)) || sp.age > 0.5) splash.splice(i, 1);
    }
    for (let i = rollers.length - 1; i >= 0; i--) {
      const r = rollers[i];
      r.x += r.v * DT; r.v *= Math.pow(0.02, DT); r.age += DT;
      if (r.age > r.life || Math.abs(r.x - G.ix) > G.Rin - 4) rollers.splice(i, 1);
    }
    // emission, born at uniformly spread instants inside the step (no step banding)
    if (ph < apexStop) { accA += STREAM.rate * DT; while (accA >= 1) { accA -= 1; spawnApex(rnd() * DT); } }
    if (ph < TIMING.flow) { accN += STREAM.rate * DT; while (accN >= 1) { accN -= 1; spawnNeck(rnd() * DT); } }
    n += 1; t = n * DT;
  }

  function advanceTo(tt) { while (t + DT <= tt + 1e-9) step(); }

  // full render state at time tt (>= sim time, < sim time + DT)
  function stateAt(tt) {
    advanceTo(tt);
    const tau = tt - t;                    // extrapolation inside the current step
    const { cycle, flow, flipStart, flip } = TIMING;
    const k = Math.floor(tt / cycle), ph = tt - k * cycle;
    const { fTop, fBot } = levels(tt);
    const pk = C.peakFor(fBot), cr = C.craterFor(fTop);
    const impactC = C.impactY(pk, G.ix);

    let rot = 0;
    if (ph >= flipStart) rot = Math.PI * easeInOutCubic(Math.min(1, (ph - flipStart) / flip));
    const parity = k % 2;                 // sand texture is attached to the glass
    const sh0 = 1 / 120;                  // shutter: streak back along the path for half a 60 Hz frame

    const grains = [];
    for (const gr of apex) {
      const age = gr.age + tau, y = gr.y + gr.vy * tau + 0.5 * g * tau * tau, vy = gr.vy + g * tau;
      if (y >= yN) continue;
      const sh = Math.min(sh0, age), y0 = y - vy * sh + 0.5 * g * sh * sh;
      grains.push({ x0: apexX(gr, y0, age - sh), y0, x: apexX(gr, y, age), y, r: gr.r, shade: gr.shade });
    }
    const neckGrains = [];
    for (const gr of neck) {
      const age = gr.age + tau, y = gr.y + gr.vy * tau + 0.5 * g * tau * tau, vy = gr.vy + g * tau;
      const x = neckX(gr, y);
      if (y >= C.impactY(pk, x)) continue;
      const sh = Math.min(sh0, age), y0 = Math.max(yN, y - vy * sh + 0.5 * g * sh * sh);
      neckGrains.push({ x0: neckX(gr, y0), y0, x, y, r: gr.r, shade: gr.shade });
    }
    const S2 = splash.map((sp) => ({
      x: sp.x + sp.vx * tau, y: sp.y + sp.vy * tau + 0.5 * g * tau * tau, vx: sp.vx, vy: sp.vy + g * tau, r: sp.r, shade: sp.shade,
    })).filter((sp) => sp.y < C.impactY(pk, sp.x));
    const R2 = rollers.map((r) => {
      const x = r.x + r.v * tau;
      return { x, y: C.impactY(pk, x) - r.r * 0.8, r: r.r, shade: r.shade, fade: 1 - (r.age + tau) / r.life };
    });

    // faint core of the apex stream, from its tail (or the apex) to its head (or the neck line)
    let core = null;
    {
      const headY = Math.min(yA + dist(ph, v0), yN);
      const tailY = ph < apexStop ? yA : yA + dist(ph - apexStop, v0);
      if (ph < flow + 1 && tailY < headY) core = { y0: tailY, y1: headY };
    }
    // the neck column: sand leaving the neck. While the top still has sand its top tucks just
    // above the neck line, under the pile; after the top runs dry the tail falls away.
    let column = null;
    {
      const head = Math.min(yN + dist(ph, v0Neck), impactC + 4);
      const tuck = 6 * Math.min(1, (1 - fTop) / 0.04);          // shrinks to nothing as the top runs dry
      const top = ph < flow ? Math.min(yN, Math.max(yN - tuck, cr)) : yN + dist(ph - flow, v0Neck);
      if (ph < flow + 1 && top < head) column = { y0: top, y1: head };
    }
    return { t: tt, ph, cycleIndex: k, fTop, fBot, peak: pk, crater: cr, rot, parity, grains, neckGrains, column, halfW,
      splash: S2, rollers: R2, core, pulse: pulseAt(tt) };
  }

  return { stateAt, get t() { return t; }, DT };
}

// the static logo / first frame: part-way through a pour
export const STATIC_PHASE = 0.42 * TIMING.flow;
