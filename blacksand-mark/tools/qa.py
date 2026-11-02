"""Frame-by-frame QA for the blacksand hero.

    python3 tools/qa.py [dpr] [workdir]

Frames come from tools/capture.mjs, which opens index.html from disk (file://). Timeline:
phase 0 is the 148 deg point of the flip; the vessel settles at landEnd, the top runs dry
at flow, the flip starts there and runs through the wrap of the cycle.

Pass A (glow off): every pixel that must be pure black is pure black
    - outside the triangle
    - on the face, outside the ring, away from the stream column
    - inside the ring, in the two side gaps between the walls (rotation-aware, with the
      motion-blur travel as a margin while the glass turns)
    - inside a chamber, above its sand surface (no sand leaks), away from stream/splash
Pass B (glow + particles off): no pops. Consecutive-frame difference must be smooth.
Pass C (full render): pixel identity across every phase boundary and across the loop seam.
Pass D: identical frames for the same phase two cycles apart (texture rides the glass).
Pass E: in motion the stream is hidden inside both sand bodies.
Pass F: the neck's negative space beside the column is pure black.
Pass G: the apex stream crosses the full ring band (visible over the band in every frame).
Pass H: at rest the frame is exactly the sharp render (blur on == blur off); onset and
    release of the blur are smooth (no step in the frame-difference series).
Pass I: glow crest timing and size.
"""
import json, sys, math, os, subprocess
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
G = json.load(open(os.path.join(HERE, 'geom.json')))
TM = G['timing']
ix, iy, R, Rin, H, L = G['ix'], G['iy'], G['R'], G['Rin'], G['H'], G['L']
W, Hh, MARK = 1200, 900, 420
DPR = float(sys.argv[1]) if len(sys.argv) > 1 else 1
WORK = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('QA_WORK', '/tmp/blacksand-qa')
SHUTTER = 1 / 120

def capture(name, times, debug='', layer=''):
    out = os.path.join(WORK, f'{name}_{DPR:g}x')
    if os.path.exists(os.path.join(out, 'meta.json')) and os.environ.get('QA_REUSE'):
        return out, json.load(open(os.path.join(out, 'meta.json')))
    subprocess.run(['node', os.path.join(HERE, 'capture.mjs'), out, '--times', json.dumps(times), str(W), str(Hh), str(DPR), str(MARK), debug, layer], check=True)
    return out, json.load(open(os.path.join(out, 'meta.json')))

def load(dirn, i, mode='L'):
    return np.asarray(Image.open(f'{dirn}/f{i:05d}.png').convert(mode))

def transform():
    s = MARK / 1024 * DPR
    ox = W * DPR / 2 - ix * s; ox = round(ox + ix * s) - ix * s
    oy = Hh * DPR * 0.5 - 508 * s; oy = round(oy + iy * s) - iy * s
    return s, ox, oy

def grid():
    s, ox, oy = transform()
    ys, xs = np.mgrid[0:int(Hh * DPR), 0:int(W * DPR)]
    return s, (xs + 0.5 - ox) / s, (ys + 0.5 - oy) / s

def ringbox():
    """slice of the frame that holds the ring (plus margin): the rotation-aware checks run there"""
    s, ox, oy = transform()
    e = R + H / 2 + 10
    x0, x1 = int(ox + (ix - e) * s), int(ox + (ix + e) * s) + 1
    y0, y1 = int(oy + (iy - e) * s), int(oy + (iy + e) * s) + 1
    return (slice(y0, y1), slice(x0, x1))

def in_tri(u, v, margin):
    T = G['T']; inside = np.ones_like(u, bool)
    cx = sum(p[0] for p in T) / 3; cy = sum(p[1] for p in T) / 3
    for i in range(3):
        (x1, y1), (x2, y2) = T[i], T[(i + 1) % 3]
        nx, ny = -(y2 - y1), (x2 - x1); n = math.hypot(nx, ny); nx /= n; ny /= n
        if (cx - x1) * nx + (cy - y1) * ny < 0: nx, ny = -nx, -ny
        inside &= ((u - x1) * nx + (v - y1) * ny) > margin
    return inside

def seg_dist(u, v, a, b):
    ax, ay = a; bx, by = b; dx, dy = bx - ax, by - ay
    t = np.clip(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy), 0, 1)
    return np.hypot(u - (ax + t * dx), v - (ay + t * dy))

def glass(u, v, rot):
    """pixel -> glass space; chamber membership (bottom, top) and distance to the nearest wall"""
    c, s_ = math.cos(-rot), math.sin(-rot)
    x = ix + (u - ix) * c - (v - iy) * s_
    y = iy + (u - ix) * s_ + (v - iy) * c
    nk, sl = G['nk'], G['slope']
    def bot(x, y):
        lr = iy + (x - (ix + nk)) * sl; ll = iy + ((ix - nk) - x) * sl
        return (y >= iy) & (y >= lr) & (y >= ll) & (np.hypot(x - ix, y - iy) <= R)
    b = bot(x, y); t = bot(2 * ix - x, 2 * iy - y)
    NL, NR = (ix - nk, iy), (ix + nk, iy)
    segs = [(G['tl'], NL), (NL, G['bl']), (G['tr'], NR), (NR, G['br'])]
    wd = np.min([seg_dist(x, y, a, b_) for a, b_ in segs], axis=0)
    return x, y, b, t, wd

def smoothabs(dx): return np.sqrt(dx * dx + 49) - 7
# crater profile with the eased centre (engine: shapeTop, CRATER_W = 0.25 Rin)
def crater_shape(dx, k):
    w = 0.25 * Rin; sw = smoothabs(w); d = np.abs(dx)
    return np.where(d < w, k * smoothabs(d), k * sw + (smoothabs(d) - sw))

def passA(dirn, meta):
    s, u, v = grid()
    tol = 1.6 / s                       # AA tolerance in mark units
    outside = ~in_tri(u, v, -tol)
    r = np.hypot(u - ix, v - iy)
    band = (np.abs(u - ix) <= 6.5 + tol)            # the stream / column
    face_ring = in_tri(u, v, tol) & (r > R + H / 2 + tol) & ~band
    rb = ringbox(); u, v, r, band = u[rb], v[rb], r[rb], band[rb]
    inner = r < Rin - tol
    cache = {}
    def glass_c(rot):
        k = round(rot, 6)
        if k not in cache: cache[k] = glass(u, v, rot)
        return cache[k]
    bad = []
    for i, m in enumerate(meta):
        im = load(dirn, i); imr = im[rb]
        rot, om = m['rot'], m['omega']
        # side gaps: clean under every rotation inside the shutter (blur margin) plus half a degree
        marg = om * SHUTTER / 2 + 0.5 * math.pi / 180
        gap = inner & ~band
        for rr in (rot - marg, rot, rot + marg):
            x, y, b, t, wd = glass_c(rr)
            gap &= ~b & ~t & (wd > L / 2 + tol)
        emp = np.zeros_like(gap); empB = emp; empT = emp
        if rot == 0:
            x, y, b, t, wd = glass_c(0)
            dx = x - ix
            mound = m['peak'] + G['KB'] * smoothabs(dx)
            crater = m['crater'] - G['KT'] * crater_shape(dx, m['craterK'])
            empB = b & (y < mound - 30) & (wd > L / 2 + tol) & inner & ~band    # splash allowance (ballistic grains)
            empT = t & (y < crater - tol) & (wd > L / 2 + tol) & inner & ~band
        if len(cache) > 64: cache.clear()
        checks = {'outside_triangle': (im, outside), 'face_outside_ring': (im, face_ring), 'side_gaps': (imr, gap), 'empty_bottom': (imr, empB), 'empty_top': (imr, empT)}
        for k, (img, mask) in checks.items():
            n = int((img[mask] > 0).sum())
            if n: bad.append((i, round(m['t'], 4), k, n, int(img[mask].max())))
    return bad

def diffs(dirn, n):
    prev = None; d = []
    for i in range(n):
        im = load(dirn, i).astype(np.int16)
        if prev is not None: d.append(float(np.abs(im - prev).mean()))
        prev = im
    return np.array(d)

def spikes(d, meta, k=3.0, floor=0.02):
    out = []
    for i in range(1, len(d) - 1):
        nb = max(d[i - 1], d[i + 1])
        if d[i] > k * nb + floor: out.append((i + 1, round(meta[i + 1]['t'], 3), round(d[i], 4), round(nb, 4)))
    return out

def identical(a, b):
    """(max channel diff, pixels differing, pixels differing by more than 2 levels, where)"""
    A = np.asarray(Image.open(a).convert('RGB')).astype(np.int16); B = np.asarray(Image.open(b).convert('RGB')).astype(np.int16)
    diff = np.abs(A - B).max(axis=2)
    n = int((diff > 0).sum()); n2 = int((diff > 2).sum())
    where = ''
    if n:
        s, ox, oy = transform()
        ys, xs = np.nonzero(diff)
        where = f'mark-space y {((ys.min()+.5-oy)/s):.0f}..{((ys.max()+.5-oy)/s):.0f}, x {((xs.min()+.5-ox)/s):.0f}..{((xs.max()+.5-ox)/s):.0f}'
    return int(diff.max()), n, n2, where
# frames that must be the same picture: rasteriser noise only, never a shape or a tone. Grain
# streaks are thin round-capped strokes; a sub-pixel shift flips their subpixel coverage on a
# few pixels (scattered along the stream, up to ~20 levels on a glint). Scales with pixel count.
def same_picture(r, px=120 * DPR * DPR, big=15 * DPR * DPR): return r[1] <= px and r[2] <= big

def main():
    cyc = TM['cycle']; fps = 60; e = 1e-6
    span = [i / fps for i in range(int(round(cyc * 1.25 * fps)))]       # one cycle and a quarter, crosses the seam
    fails = 0
    def report(ok, msg):
        nonlocal fails
        print(('PASS ' if ok else 'FAIL ') + msg)
        if not ok: fails += 1

    dA, mA = capture('A', span, 'glow')
    bad = passA(dA, mA)
    report(not bad, f'A stray pixels: {len(bad)} violations over {len(mA)} frames at {DPR:g}x')
    for b in bad[:25]: print('   ', b)

    dB, mB = capture('B', span, 'glow,particles')
    d = diffs(dB, len(mB)); sp = spikes(d, mB)
    report(not sp, f'B pops (glow+particles off): {len(sp)} spikes; diff mean {d.mean():.4f} max {d.max():.4f}')
    for x in sp[:20]: print('    spike', x)

    pairs = []
    names = ['flow end', 'land end', 'loop seam', 'loop seam 2']
    for tt in [TM['flow'], TM['landEnd'], cyc, 2 * cyc]: pairs += [tt - e, tt + e]
    dC, mC = capture('C', pairs)
    print('PASS C boundaries (max channel diff, pixels differing):') if True else None
    okC = True
    for k, nm in enumerate(names):
        r = identical(f'{dC}/f{2*k:05d}.png', f'{dC}/f{2*k+1:05d}.png')
        okC &= same_picture(r)
        print(f'    {nm:12s}', r)
    report(okC, 'C boundaries: the same picture 2 us either side (rounding noise only)')

    same = []
    for ph in [G['staticPhase'], 0.1, 0.3, 0.6, 1.0, 3.3, TM['flow'] - 0.05, TM['flow'] + 0.2, TM['flow'] + 0.3, cyc - 0.05]:
        same += [ph, ph + 2 * cyc]          # texture rides the glass, so the exact period is two flips
    dD, mD = capture('D', same)
    okD = True
    print('PASS D same phase, two cycles apart (incl. mid-flip and mid-pour with particles):')
    for k in range(0, len(mD), 2):
        r = identical(f'{dD}/f{k:05d}.png', f'{dD}/f{k+1:05d}.png')
        okD &= same_picture(r)
        print(f'    ph {mD[k]["ph"]:.3f}', r)
    report(okD, 'D two-cycle periodicity: the same picture (rounding noise only)')

    # PASS E: in motion the stream falls behind the sand. Inside both sand bodies the full
    # render must match a render with no particles at all (stream completely hidden there).
    dE1, mE = capture('E1', span)
    dE2, _ = capture('E2', span, 'particles')
    s, u, v = grid()
    tol = 1.6 / s
    rb = ringbox(); u, v = u[rb], v[rb]
    r = np.hypot(u - ix, v - iy)
    leaks = []; band_ok = 0; band_n = 0; band_cut = 0
    inner_band = (r > Rin + tol) & (r < R + H / 2 - tol) & (np.abs(u - ix) < 3) & (v < iy)   # ring band on the stream line, top
    x, y, bm, tm, wd = glass(u, v, 0)
    for i, m in enumerate(mE):
        a = load(dE1, i)[rb].astype(int); b = load(dE2, i)[rb].astype(int)
        # PASS G: grains visible over the full ring band in every frame whose stream reaches
        # below the band. While the glass turns, a wall's end sweeping under the ring is the
        # stream's first contact (the agreed first-hit rule), so there it may end in the band.
        if m['coreEnd'] > iy - Rin + 2:
            band_n += 1
            if (a[inner_band] != b[inner_band]).sum() > 0: band_ok += 1
        else: band_cut += 1
        if m['rot'] != 0: continue
        dx = x - ix
        inside = (r < Rin - tol) & (wd > L / 2 + tol)
        sandT = tm & (y > m['crater'] - G['KT'] * crater_shape(dx, m['craterK']) + 3 * tol) & inside & (m['fTop'] < 1)
        surfB = np.maximum(m['peak'] + G['KB'] * smoothabs(dx), iy)          # a pile at the neck is flush with it
        sandB = bm & (y > surfB + 3 * tol) & inside & (m['fBot'] > 0)
        for nm, mask in (('top sand', sandT), ('bottom sand', sandB)):
            n = int((a[mask] != b[mask]).sum())
            if n: leaks.append((i, round(m['t'], 3), nm, n, int(np.abs(a[mask] - b[mask]).max())))
    report(not leaks, f'E stream hidden inside sand: {len(leaks)} frames with leaks over {len(mE)} frames')
    for x in leaks[:15]: print('   ', x)
    report(band_ok == band_n, f'G stream crosses the ring band: visible in {band_ok}/{band_n} frames ({band_cut} frames end at a wall under the ring)')

    # PASS F: the neck. Beside the column, between the walls' inner faces, below the pinch:
    # pure black on every upright frame (glow off). No grain fragments, no fringes.
    a_, sl, taper = G['a'], G['slope'], G['taper']
    dy = v - iy
    halfw = a_ * (1 - taper * np.clip(dy / Rin, 0, 1))
    inner = a_ + dy / sl                                   # wall inner face, opening out below the pinch
    dirty = []
    for i, m in enumerate(mA):
        if m['rot'] != 0: continue
        im = load(dA, i)[rb]
        surfB = np.maximum(m['peak'] + G['KB'] * smoothabs(u - ix), iy)
        side = (dy > tol) & (np.abs(u - ix) > halfw + tol) & (np.abs(u - ix) < inner - tol) & (v < surfB - 30) & (r < Rin - tol)
        n = int((im[side] > 0).sum())
        if n: dirty.append((i, round(m['t'], 3), n, int(im[side].max())))
    report(not dirty, f'F neck sides pure black: {len(dirty)} dirty frames over {len(mA)}')
    for x in dirty[:15]: print('   ', x)

    # PASS H: blur. At rest (omega == 0) blur on must equal blur off exactly; around the onset
    # (flow .. flow+0.1) and the release (landEnd-0.1 .. landEnd) the difference series is smooth.
    rest = [1.0, 3.0, TM['flow'] - 1 / fps, TM['landEnd'] + 1 / fps]
    dH1, mH = capture('H1', rest); dH2, _ = capture('H2', rest, 'blur')
    okH = True
    for k in range(len(rest)):
        r_ = identical(f'{dH1}/f{k:05d}.png', f'{dH2}/f{k:05d}.png')
        okH &= r_[1] == 0
        print(f'    rest t={rest[k]:.4f} blur on vs off', r_)
    report(okH, 'H1 at rest the frame is exactly the sharp render')
    onset = [TM['flow'] - 0.05 + i / 240 for i in range(48)]         # 240 fps around the onset
    release = [TM['landEnd'] - 0.15 + i / 240 for i in range(48)]
    for nm, ts in (('onset', onset), ('release', release)):
        dd, mm = capture('H_' + nm, ts, 'glow')                        # the mark alone; the glow has its own pass
        d = diffs(dd, len(mm)); sp = spikes(d, mm, k=2.0, floor=0.01)
        report(not sp, f'H2 blur {nm}: {len(sp)} steps in the 240 fps difference series (max {d.max():.4f})')
        for x in sp[:10]: print('    step', x)

    # PASS J: the glow alone (particles and blur off, measured outside the triangle) changes
    # smoothly through the whole pulse: no frame moves the backlight by a visible step.
    ts = [TM['flow'] - 0.1 + i / 60 for i in range(int(round(cyc * 60)))]   # a full cycle from just before the flip
    dJ, mJ = capture('J', ts, 'particles,blur')
    s, u, v = grid()
    outside = ~in_tri(u, v, 1)
    prev = None; dj = []
    for i in range(len(mJ)):
        im = load(dJ, i).astype(np.int16)
        if prev is not None: dj.append(float(np.abs(im - prev)[outside].mean()))
        prev = im
    # the glow breathes continuously, so it changes every frame: smooth means small and with no
    # frame standing out from its neighbours (design panel limits)
    dj = np.array(dj)
    spj = [(i + 1, round(mJ[i + 1]['t'], 3), round(dj[i], 4)) for i in range(len(dj))
           if dj[i] > 3 * max(1e-3, np.median(dj[max(0, i - 5):i + 6]))]
    report(dj.mean() <= 0.05 and dj.max() <= 0.35 and not spj,
           f'J glow smoothness: per-frame change outside the mark mean {dj.mean():.4f} (<= 0.05), max {dj.max():.4f} (<= 0.35), {len(spj)} frames > 3x their neighbours')
    for x in spj[:10]: print('    spike', x)

    # PASS K (design panel acceptance for the glow). The particles are off; the glow alone.
    # K1: at the breath's trough the frame is the approved static look: pixel-identical to a
    #     render with the breath forced off (debug 'breath').
    trough = (G['breathCrest'] + cyc / 2) % cyc
    dK1, _ = capture('K1', [trough, trough + cyc], 'particles')
    dK0, _ = capture('K0', [trough, trough + cyc], 'particles,breath')
    okK1 = all(identical(f'{dK1}/f{k:05d}.png', f'{dK0}/f{k:05d}.png')[1] == 0 for k in range(2))
    report(okK1, f'K1 breath trough (ph {trough:.3f}) is the static rest look, pixel-identical')
    # K2: the rim never moves more than 2 levels between 60 fps frames, wrap included
    #     (frames captured with particles and blur off, over a cycle and a bit)
    s_, u, v = grid()
    rimband = in_tri(u, v, -0.035 * 912) & ~in_tri(u, v, 2)       # just outside the triangle edge
    # (reuses pass J's frames: the same cycle at 60 fps, particles and blur off)
    prev = None; worst = 0; at = None
    for i in range(len(mJ)):
        im = load(dJ, i).astype(np.int16)
        if prev is not None:
            dd = np.abs(im - prev)[rimband]
            q = float(np.percentile(dd, 99.9))
            if q > worst: worst, at = q, mJ[i]['t']
        prev = im
    report(worst <= 2.0, f'K2 rim change between 60 fps frames: 99.9th percentile max {worst:.1f} levels (at t={at})')
    # K3: at rot 45 deg (the swing's peak) the halo 0.1 side out from the left and right edges
    #     differs by at least 30% (halo = frame minus the rest render)
    import math as _m
    # at the swing's peak (a quarter of the way through the flip)
    t45 = TM['flow'] + 0.25 * TM['flip']
    dA, mR = capture('K3', [t45], 'particles,blur'); best = 0
    dB, _ = capture('K3r', [t45], 'particles,blur,breath')
    A = load(dA, 0).astype(float); B = load(dB, 0).astype(float)
    T_ = G['T']; side = G['side']
    def out_pt(P, Q, frac):
        mx, my = (P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2
        dx, dy = Q[0] - P[0], Q[1] - P[1]; n = _m.hypot(dx, dy); nx, ny = dy / n, -dx / n
        cx = sum(p[0] for p in T_) / 3; cy = sum(p[1] for p in T_) / 3
        if (cx - mx) * nx + (cy - my) * ny > 0: nx, ny = -nx, -ny
        return mx + nx * frac * side, my + ny * frac * side
    s0, ox_, oy_ = transform()
    def sample(img, pt):
        x = int(ox_ + pt[0] * s0); y = int(oy_ + pt[1] * s0)
        return float(img[y - 3:y + 4, x - 3:x + 4].mean())
    Lpt = out_pt(T_[0], T_[2], 0.1); Rpt = out_pt(T_[0], T_[1], 0.1)
    hl = sample(A, Lpt) - sample(B, Lpt); hr = sample(A, Rpt) - sample(B, Rpt)
    ratio = max(hl, hr) / max(1e-6, min(hl, hr))
    report(ratio >= 1.3, f'K3 swing peak (u = 0.25), rot {mR[best]["rot"] * 57.2958:.1f} deg the halo 0.1 side out: left {hl:.1f}, right {hr:.1f} levels (ratio {ratio:.2f}, need >= 1.3)')
    # K4: the pulse is visible with the pointer off: crest vs trough, near the base edge
    crest = G['breathCrest']
    dC, _ = capture('K4', [crest, trough], 'particles')
    base_pt = out_pt(T_[1], T_[2], 0.05)
    cr_v = sample(load(dC, 0).astype(float), base_pt); tr_v = sample(load(dC, 1).astype(float), base_pt)
    report(cr_v - tr_v >= 12, f'K4 breath amplitude near the base edge: crest {cr_v:.1f} vs trough {tr_v:.1f} (+{cr_v - tr_v:.1f} levels, need >= 12)')

    print(f'\n{"ALL CHECKS PASSED" if fails == 0 else str(fails) + " CHECK(S) FAILED"} at {DPR:g}x')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
