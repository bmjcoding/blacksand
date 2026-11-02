// blacksand-engine.js
// Pure geometry + sand simulation for the blacksand mark. No DOM. Shared by the
// canvas hero renderer (browser) and the static SVG builder (node), so the static
// logo and the animation come from identical state.
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

  const sa = xs.map((x) => smoothAbs(x - ix));
  const areaBot = (p) => { let a = 0; for (let i = 0; i < n; i++) { const d = hiB[i] - Math.max(loB[i], p + K_BOT * sa[i]); if (d > 0) a += d; } return a; };
  const areaTop = (c) => { let a = 0; for (let i = 0; i < n; i++) { const d = hiT[i] - Math.max(loT[i], c - K_TOP * sa[i]); if (d > 0) a += d; } return a; };

  // search ranges that bracket "full" and "empty"
  const pFull = iy - K_BOT * Rin - 20, pEmpty = iy + Rin + 2;
  // "full" sits wholly under the ring stroke, so a full chamber shows no surface line at all
  const cFull = iy - G.R - G.H / 2 - 4, cEmpty = iy + K_TOP * Rin * 1.2 + 40;

  function solve(fn, lo, hi, target) {           // fn decreasing in its argument
    while (hi - lo > 1e-5) { const m = (lo + hi) / 2; if (fn(m) > target) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  // f = fraction of sand that has left the top / landed in the bottom. Both levels are
  // solved once on a fine grid (the sim asks 240 times a second) and read back linearly;
  // the grid is fine enough that the error is well under a tenth of a unit.
  // The grid is square-spaced (dense near empty, where a level rises like sqrt(f)).
  const NT = 512;
  const peakTab = new Float64Array(NT + 1), craterTab = new Float64Array(NT + 1);
  peakTab[0] = pEmpty; craterTab[0] = cFull;
  for (let i = 1; i <= NT; i++) {
    const f = Math.min(1 - 1e-7, (i / NT) * (i / NT));   // the last cell stops just short of full
    peakTab[i] = solve(areaBot, pFull, peakTab[i - 1], f * full);
    craterTab[i] = solve(areaTop, craterTab[i - 1], cEmpty, (1 - f) * full);
  }
  const lookup = (tab, f) => {
    if (f <= 0) return tab[0];
    if (f >= 1) return tab === peakTab ? pFull : cEmpty;   // full / empty: no surface at all
    const x = Math.sqrt(f) * NT, i = Math.min(NT - 1, Math.floor(x)), u = x - i;
    return tab[i] + (tab[i + 1] - tab[i]) * u;
  };
  const peakFor = (f) => lookup(peakTab, f);
  const craterFor = (f) => lookup(craterTab, f);

  // where a falling grain stops: visible floor, or the sand surface, whichever is higher.
  // The floor is a circle about the pivot, so for the world-vertical column through the
  // pivot this is also right while the glass is still turning (the mound is negligible then).
  function impactY(p, x) {
    const dx = x - ix;
    if (Math.abs(dx) >= Rin) return iy + 0;
    const floor = iy + Math.sqrt(Rin * Rin - dx * dx);
    const lineR = iy + (x - (ix + nk)) * slope + wallV;
    const lineL = iy + ((ix - nk) - x) * slope + wallV;
    const lo = Math.max(iy, lineR, lineL);
    return Math.min(floor, Math.max(mound(p, x), lo));
  }
  return { full, peakFor, craterFor, mound, crater, impactY, K_BOT, K_TOP, pFull, pEmpty, cFull, cEmpty };
}

// --------------------------------------------------------------- timeline ---
// Phase zero is the 148 deg point of the flip: the moment the neck starts to flow again,
// world-vertical from the pivot, while the glass is still turning. The glass settles at
// landEnd, the top runs dry at flow, and the flip begins at that very instant (no settle).
// The clock is an integer number of 1/240 s steps, so every boundary is exact.

export const DT = 1 / 240;
export const TIMING = {
  flow: 5.4,                 // neck flow, from phase zero until the top runs dry
  flip: 0.85,                // 180 deg, cubic-bezier(0.4, 0, 0.2, 1)
  restart: 110 * DT,         // time into the flip at which the neck flows again (147.7 deg)
  ramp: 0.12,                // flow rate ramps in over this long, then the mass rate is constant
};
TIMING.cycle = TIMING.flow + TIMING.restart;            // 1406 steps = 5.858333 s
TIMING.landEnd = TIMING.flip - TIMING.restart;          // phase at which the vessel settles
TIMING.flipStart = TIMING.flow;
TIMING.steps = Math.round(TIMING.cycle / DT);

// CSS cubic-bezier(0.4, 0, 0.2, 1): y(x) and dy/dx
export function cubicBezier(p1x, p1y, p2x, p2y) {
  const X = (u) => 3 * (1 - u) * (1 - u) * u * p1x + 3 * (1 - u) * u * u * p2x + u * u * u;
  const Y = (u) => 3 * (1 - u) * (1 - u) * u * p1y + 3 * (1 - u) * u * u * p2y + u * u * u;
  const dX = (u) => 3 * (1 - u) * (1 - u) * p1x + 6 * (1 - u) * u * (p2x - p1x) + 3 * u * u * (1 - p2x);
  const dY = (u) => 3 * (1 - u) * (1 - u) * p1y + 6 * (1 - u) * u * (p2y - p1y) + 3 * u * u * (1 - p2y);
  const uFor = (x) => { let lo = 0, hi = 1; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (X(m) < x) lo = m; else hi = m; } return (lo + hi) / 2; };
  return {
    at: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Y(uFor(x))),
    slope: (x) => { if (x <= 0 || x >= 1) return 0; const u = uFor(x); return dY(u) / dX(u); },
  };
}
export const FLIP_EASE = cubicBezier(0.4, 0, 0.2, 1);

const wrap = (t) => { const k = Math.floor(t / TIMING.cycle); return { k, ph: t - k * TIMING.cycle }; };

// time since the most recent flip began, for a phase (the flip straddles the wrap)
const sinceFlip = (ph) => (ph >= TIMING.flow ? ph - TIMING.flow : ph + TIMING.restart);

// glass rotation for a phase, in this cycle's frame: -32 deg .. 0 while landing, 0 while
// pouring, 0 .. 148 deg while flipping
export function rotAt(ph) {
  const { flow, flip, landEnd } = TIMING;
  if (ph < landEnd) return Math.PI * FLIP_EASE.at((ph + TIMING.restart) / flip) - Math.PI;
  if (ph < flow) return 0;
  return Math.PI * FLIP_EASE.at((ph - flow) / flip);
}
// angular speed (rad/s), always >= 0
export function omegaAt(ph) {
  const { flow, flip, landEnd } = TIMING;
  if (ph >= landEnd && ph < flow) return 0;
  return Math.PI * FLIP_EASE.slope(sinceFlip(ph) / flip) / flip;
}

// cumulative flow: fraction of the top chamber that has passed the neck by phase p
export function flowQ(p) {
  const { flow, ramp } = TIMING;
  const r = 1 / (flow - ramp / 2);
  if (p <= 0) return 0;
  if (p < ramp) return r * p * p / (2 * ramp);
  if (p < flow) return r * (p - ramp / 2);
  return 1;
}
export const flowRate = (p) => (p < 0 || p >= TIMING.flow ? 0 : Math.min(1, p / TIMING.ramp));

export const smoothstep = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// -------------------------------------------------------------- glow pulse ---
// The light flares with the flip: a short rise to a crest 0.13 s after the fastest rotation,
// an exponential decay (tau 0.7 s), rounded by a 0.08 s one-pole follower. Tabulated once
// as a periodic function of phase, so it is a pure function of time and loops exactly.
export const PULSE = { rise: 0.30, lead: 0.13, tau: 0.7, follow: 0.08 };
const pulseTable = (() => {
  const { flip, cycle, steps } = TIMING;
  let fastest = 0, best = -1;
  for (let i = 0; i <= 2000; i++) { const u = (i / 2000) * flip; const w = omegaAt(u + TIMING.flow); if (w > best) { best = w; fastest = u; } }
  const target = fastest + PULSE.lead;                   // the visible crest, from the flip start
  const a = DT / PULSE.follow;
  const build = (tp) => {
    const env = (u) => {                                 // u: time since this flip began
      const prev = Math.exp(-(u + cycle - tp) / PULSE.tau); // tail of the previous flip's pulse
      if (u < tp) return prev + smoothstep((u - (tp - PULSE.rise)) / PULSE.rise);
      return prev + Math.exp(-(u - tp) / PULSE.tau);
    };
    const tab = new Float64Array(steps + 1);
    let y = 0;
    for (let pass = 0; pass < 4; pass++) {               // settle to the periodic solution
      for (let i = 0; i < steps; i++) { y += (env(sinceFlip(i * DT)) - y) * a; if (pass === 3) tab[i] = y; }
    }
    tab[steps] = tab[0];
    let mx = 0, at = 0; for (let i = 0; i < steps; i++) if (tab[i] > mx) { mx = tab[i]; at = i; }
    for (let i = 0; i <= steps; i++) tab[i] /= mx;       // crest is exactly 1
    return { tab, crest: sinceFlip(at * DT) };
  };
  // the follower delays the crest; pull the envelope forward so the visible crest lands on target
  let tp = target, res = build(tp);
  for (let k = 0; k < 4; k++) { tp += target - res.crest; res = build(tp); }
  return { tab: res.tab, fastest, crest: res.crest };
})();
export const PULSE_CREST = pulseTable.crest;               // seconds after the flip start
export function pulseAt(t) {
  const { ph } = wrap(t);
  const x = ph / DT, i = Math.min(TIMING.steps - 1, Math.floor(x)), f = x - i;
  return pulseTable.tab[i] + (pulseTable.tab[i + 1] - pulseTable.tab[i]) * f;
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
  headFade: 30,     // the falling column's leading head fades in over this length
  tailFade: 12,     // and its trailing end, once the top has run dry, fades out over this
  splash: 0.10,     // share of landing grains that bounce (was 0.30)
  roll: 0.18,       // share that roll down the flank (was 0.32)
};

export function createSim(G, C, seed = 7) {
  let rnd = mulberry32(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const { g, v0, v0Neck } = STREAM;
  const yA = G.apex[1], yN = G.iy;
  const { cycle, flow } = TIMING;
  const NC = TIMING.steps;                  // steps per cycle (exact)

  // Grains are ballistic, so each one is stored as its birth time plus its own traits and
  // evaluated analytically whenever it is needed; nothing is integrated per step.
  let apex = [], apexHead = 0;   // stream from the apex, a FIFO: it never stops, and crosses the wrap
  let neck = [];                 // sand leaving the neck, inside the column
  const splash = [];             // ballistic bounce grains
  const rollers = [];            // grains sliding down the mound flanks
  // integer step clock: no float drift across cycles. The sim starts one cycle early
  // (a pre-roll), so the apex stream is already in steady state at t = 0 and every
  // cycle from 0 on is identical.
  let n = -NC, t = n * DT, accA = 0, accN = 0;
  let simCycle = -1;
  let peak = C.peakFor(0);

  const dist = (tt, v) => v * tt + 0.5 * g * tt * tt;
  const fall = (dy, v) => (-v + Math.sqrt(v * v + 2 * g * dy)) / g;
  const apexLife = fall(yN - yA, v0);          // apex to neck
  const SPLASH_LIFE = 0.5;

  // Bottom level: what has left the neck, delayed by the fall to the pile, which itself rises.
  // Integrated once at step resolution and read back linearly, so the sim and the renderer
  // share one smooth curve (it reaches exactly 1 before the wrap).
  // The pile's tip never rises faster than RISE_MAX: as the funnel under the neck narrows the
  // last few units would otherwise land within a single frame (a visible pop at the neck);
  // the mass still arrives, a few frames later, from the column that is still falling.
  const RISE_MAX = 240;                        // units / s
  const pTop = C.peakFor(1 - 1e-7);            // tip at the neck line
  const fForPeak = (p, lo) => {                // inverse of peakFor on [lo, 1)
    if (p <= pTop) return 1;
    let hi = 1 - 1e-7;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (C.peakFor(m) > p) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const fBotTab = new Float64Array(NC + 1);
  let pPrev = C.peakFor(0);
  for (let i = 1; i <= NC; i++) {
    const lag = fall(Math.max(1, C.impactY(pPrev, G.ix) - yN), v0Neck);
    let f = Math.max(fBotTab[i - 1], flowQ(i * DT - lag));
    let p = C.peakFor(f);
    if (pPrev - p > RISE_MAX * DT) { p = pPrev - RISE_MAX * DT; f = fForPeak(p, fBotTab[i - 1]); }
    fBotTab[i] = f; pPrev = C.peakFor(f);
  }
  if (fBotTab[NC] < 1) throw new Error('bottom chamber must be full at the wrap');
  function levels(ph) {
    const x = ph / DT, i = Math.min(NC - 1, Math.floor(x)), u = x - i;
    return { fTop: flowQ(ph), fBot: fBotTab[i] + (fBotTab[i + 1] - fBotTab[i]) * u };
  }
  const radius = () => STREAM.rMin + (STREAM.rMax - STREAM.rMin) * Math.pow(rnd(), 1.6);
  const tone = () => (rnd() < 0.025 ? 1.25 : rnd());

  function spawnApex(born) {
    let q = gauss(); q = Math.max(-2.6, Math.min(2.6, q));
    apex.push({ born, off: q * STREAM.sigma, drift: gauss() * 0.9, r: radius(), shade: tone() });
  }
  function spawnNeck(born) {
    // what happens when it lands is drawn now, so the outcome never depends on the order in
    // which landings are processed (exact periodicity, whatever floating point does)
    neck.push({ born, u: rnd() * 2 - 1, r: radius(), shade: tone(), q: rnd(), a: rnd(), b: rnd(), c: rnd(), d: rnd(), e: rnd(), f: rnd() });
  }
  const apexX = (gr, y, age) => G.ix + gr.off * Math.min(1, Math.sqrt(Math.max(0, y - yA) / STREAM.fan)) + gr.drift * age;
  // column half-width: exactly the opening at the neck, narrowing slightly as it accelerates
  const halfW = (y) => G.a * (1 - STREAM.taper * Math.min(1, Math.max(0, (y - yN) / G.Rin)));
  const neckX = (gr, y) => G.ix + gr.u * (halfW(y) - gr.r * 0.6);

  // One step covers [t, t + DT). Every event inside it gets its exact time: grains are born at
  // spread instants, a landing grain gets its hit time and spawns its splash there. Deaths are
  // judged at the start of the step, so the state after the step is valid for any render time
  // inside it (the renderer skips what is not yet born and what has already landed). The sim
  // therefore runs through the step that contains the render time, and the rendered picture
  // is a continuous function of time: no event ever appears a step late.
  function step() {
    // every cycle replays the same grains: reseeding at the wrap makes the whole animation
    // exactly periodic (and the loop seamless). The apex grains in flight at the wrap were
    // spawned by the identical tail of the previous cycle; settled grains are long faded.
    const kc = Math.floor(n / NC);
    if (kc !== simCycle) { simCycle = kc; rnd = mulberry32(seed); accA = 0; accN = 0; splash.length = 0; rollers.length = 0; }
    const ph = (n - kc * NC) * DT;
    const { fBot } = levels(ph);
    peak = C.peakFor(fBot);
    const tn = t + DT;

    // apex grains die in birth order, at the neck
    while (apexHead < apex.length && t - apex[apexHead].born >= apexLife) apexHead++;
    if (apexHead > 512) { apex = apex.slice(apexHead); apexHead = 0; }

    // settled grains: judged at the step start, then moved through the step
    for (let i = splash.length - 1; i >= 0; i--) {
      const sp = splash[i];
      if ((sp.vy > 0 && sp.y >= C.impactY(peak, sp.x)) || t - sp.born >= SPLASH_LIFE || sp.y < yN) { splash[i] = splash[splash.length - 1]; splash.pop(); continue; }
      sp.x += sp.vx * DT; sp.y += sp.vy * DT + 0.5 * g * DT * DT; sp.vy += g * DT;
    }
    for (let i = rollers.length - 1; i >= 0; i--) {
      const r = rollers[i];
      if (t - r.born >= r.life || Math.abs(r.x - G.ix) > G.Rin - 4) { rollers[i] = rollers[rollers.length - 1]; rollers.pop(); continue; }
      r.x += r.v * DT; r.v *= Math.pow(0.02, DT);
    }
    // neck grains: drop those that landed before this step; find those landing inside it.
    // The landing instant is solved against the rising pile (the level at that instant).
    const peakEnd = C.peakFor(levels(ph + DT).fBot);
    const surfAt = (tt, x) => C.impactY(C.peakFor(levels(ph + (tt - t)).fBot), x);
    for (let i = neck.length - 1; i >= 0; i--) {
      const gr = neck[i];
      if (gr.hit !== undefined) { if (gr.hit <= t) { neck[i] = neck[neck.length - 1]; neck.pop(); } continue; }
      const yEnd = yN + dist(tn - gr.born, v0Neck);
      if (yEnd < C.impactY(peakEnd, neckX(gr, yEnd))) continue;      // still falling at the end of the step
      {
        const yAt = (tt) => yN + dist(tt - gr.born, v0Neck);
        const gap = (tt) => yAt(tt) - surfAt(tt, neckX(gr, yAt(tt)));
        let lo = t, hi = tn;
        if (gap(lo) >= 0) hi = lo;               // the pile rose into it between steps
        for (let k = 0; k < 14 && hi - lo > 1e-7; k++) { const m = (lo + hi) / 2; if (gap(m) >= 0) hi = m; else lo = m; }
        const h = hi;
        gr.hit = h;
        const y = yAt(h), x = neckX(gr, y);
        const dt = tn - h;                       // the rest of this step, after the landing
        if (gr.q < STREAM.splash) {
          const sp = { born: h, x, y: y - 0.5, vx: (gr.a - 0.5) * 2 * (30 + 110 * gr.b), vy: -(40 + 130 * gr.c), r: 0.7 + 0.6 * gr.d, shade: gr.e };
          sp.x += sp.vx * dt; sp.y += sp.vy * dt + 0.5 * g * dt * dt; sp.vy += g * dt;
          splash.push(sp);
        } else if (gr.q < STREAM.splash + STREAM.roll) {
          const dir = gr.a < 0.5 ? -1 : 1;
          const r = { born: h, x: x + dir * (1 + 2 * gr.b), v: dir * (70 + 150 * gr.c), r: 0.9 + 0.6 * gr.d, shade: gr.e, life: 0.12 + 0.35 * gr.f };
          r.x += r.v * dt; r.v *= Math.pow(0.02, dt);
          rollers.push(r);
        }
      }
    }
    // emission, born at uniformly spread instants inside the step (no step banding)
    accA += STREAM.rate * DT; while (accA >= 1) { accA -= 1; spawnApex(tn - rnd() * DT); }
    const rate = flowRate(ph);
    if (rate > 0) { accN += STREAM.rate * rate * DT; while (accN >= 1) { accN -= 1; spawnNeck(tn - rnd() * DT); } }
    n += 1; t = n * DT;
  }

  function advanceTo(tt) { while (t < tt) step(); }
  advanceTo(0);                                   // pre-roll

  // full render state at time tt (the sim has run through the step containing tt)
  function stateAt(tt) {
    advanceTo(tt);
    const tau = tt - t;                    // extrapolation back from the end of the step, <= 0
    const { k, ph } = wrap(tt);
    const { fTop, fBot } = levels(ph);
    const pk = C.peakFor(fBot), cr = C.craterFor(fTop);
    const impactC = C.impactY(pk, G.ix);

    const rot = rotAt(ph), omega = omegaAt(ph);
    const parity = ((k % 2) + 2) % 2;      // sand texture is attached to the glass
    const sh0 = 1 / 120;                   // shutter: streak back along the path for half a 60 Hz frame
    // settled splash / rollers fade out as the glass starts to turn, rather than holding it
    const flipFade = ph >= flow ? Math.max(0, 1 - (ph - flow) / 0.22) : 1;

    const grains = [];
    for (let i = apexHead; i < apex.length; i++) {
      const gr = apex[i], age = tt - gr.born;
      if (age < 0) continue;
      const y = yA + dist(age, v0), vy = v0 + g * age;
      if (y >= yN) continue;
      const sh = Math.min(sh0, age), y0 = y - vy * sh + 0.5 * g * sh * sh;
      grains.push({ x0: apexX(gr, y0, age - sh), y0, x: apexX(gr, y, age), y, r: gr.r, shade: gr.shade });
    }
    const neckGrains = [];
    for (const gr of neck) {
      const age = tt - gr.born;
      if (age < 0 || (gr.hit !== undefined && tt >= gr.hit)) continue;
      const y = yN + dist(age, v0Neck), vy = v0Neck + g * age;
      const x = neckX(gr, y);
      if (y >= C.impactY(pk, x)) continue;
      const sh = Math.min(sh0, age), y0 = Math.max(yN, y - vy * sh + 0.5 * g * sh * sh);
      neckGrains.push({ x0: neckX(gr, y0), y0, x, y, r: gr.r, shade: gr.shade });
    }
    const S2 = [];
    for (const sp of splash) {
      const age = tt - sp.born;
      if (age < 0 || age >= SPLASH_LIFE) continue;
      const x = sp.x + sp.vx * tau, y = sp.y + sp.vy * tau + 0.5 * g * tau * tau;
      if (y >= C.impactY(pk, x) || y < yN) continue;
      S2.push({ x, y, vx: sp.vx, vy: sp.vy + g * tau, r: sp.r, shade: sp.shade });
    }
    const R2 = [];
    for (const r of rollers) {
      const age = tt - r.born;
      if (age < 0 || age >= r.life) continue;
      const x = r.x + r.v * tau;
      R2.push({ x, y: C.impactY(pk, x) - r.r * 0.8, r: r.r, shade: r.shade, fade: 1 - age / r.life });
    }

    // faint core of the apex stream: it never stops, apex to neck
    const core = { y0: yA, y1: yN };
    // the neck column: sand leaving the neck. While the top still has sand its top tucks just
    // above the neck line, under the pile; after the top runs dry the tail falls away. Its
    // leading head, while falling free, fades in rather than ending in a flat cap.
    let column = null;
    {
      const free = yN + dist(ph, v0Neck);                        // where the head would be in free fall
      const head = Math.min(free, impactC + 4);
      const tuck = 6 * Math.min(1, (1 - fTop) / 0.04);          // shrinks to nothing as the top runs dry
      const top = ph < flow ? Math.min(yN, Math.max(yN - tuck, cr)) : yN + dist(ph - flow, v0Neck);
      const fadeLen = Math.min(STREAM.headFade, Math.max(0, impactC + 4 - free), Math.max(0, head - top));
      const tailFade = ph >= flow ? Math.min(STREAM.tailFade, Math.max(0, head - top) / 2) : 0;   // the tail, falling away
      if (top < head) column = { y0: top, y1: head, fadeLen, tailFade };
    }
    return { t: tt, ph, cycleIndex: k, fTop, fBot, peak: pk, crater: cr, impactC, rot, omega, parity, flipFade,
      grains, neckGrains, column, halfW, splash: S2, rollers: R2, core, pulse: pulseAt(tt) };
  }

  return { stateAt, get t() { return t; }, DT };
}

// the static logo / poster / reduced-motion frame: part-way through a pour, stream in front
export const STATIC_PHASE = 2.5;
// playback opens upright with the pour already under way
export const OPEN_PHASE = 0.6;
