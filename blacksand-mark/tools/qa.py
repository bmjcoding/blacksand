"""Frame-by-frame QA for the blacksand hero.

Pass A (glow off): every pixel that must be pure black is pure black
    - outside the triangle
    - on the face, outside the ring, away from the stream column
    - inside the ring, in the two side gaps between the walls (rotation-aware)
    - inside a chamber, above its sand surface (no sand leaks), away from stream/splash
Pass B (glow + particles off): no pops. Consecutive-frame difference must be smooth,
    and exactly zero where nothing is supposed to move.
Pass C (full render): exact pixel identity across every phase boundary and across
    the loop seam, and identical frames for the same phase in consecutive cycles.
"""
import json, sys, math, asyncio, os
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from capture import serve, run

G = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geom.json')))
TM = G['timing']
ix, iy, R, Rin, H, L = G['ix'], G['iy'], G['R'], G['Rin'], G['H'], G['L']
W, Hh, DPR, MARK = 1200, 900, 1, 420

def transform(W, Hh, dpr, mark):
    s = mark / 1024 * dpr
    ox = round(W * dpr / 2 - ix * s); ox = round(ox + ix * s) - ix * s
    oy = Hh * dpr * 0.5 - 508 * s; oy = round(oy + iy * s) - iy * s
    return s, ox, oy

def grid(W, Hh, dpr, mark):
    s, ox, oy = transform(W, Hh, dpr, mark)
    ys, xs = np.mgrid[0:int(Hh * dpr), 0:int(W * dpr)]
    return s, (xs + 0.5 - ox) / s, (ys + 0.5 - oy) / s

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

def chambers(u, v, rot):
    # rotate pixel into glass space
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

def passA(dirn, meta):
    s, u, v = grid(W, Hh, DPR, MARK)
    tol = 1.6 / s                       # AA tolerance in mark units
    outside = ~in_tri(u, v, -tol)
    r = np.hypot(u - ix, v - iy)
    band = np.abs(u - ix) <= 6.5 + tol  # stream column
    face_ring = in_tri(u, v, tol) & (r > R + H / 2 + tol) & ~band
    bad = []
    for i, m in enumerate(meta):
        im = np.asarray(Image.open(f'{dirn}/f{i:05d}.png').convert('L'))
        x, y, b, t, wd = chambers(u, v, m['rot'])
        inner = r < Rin - tol
        gap = inner & ~b & ~t & (wd > L / 2 + tol) & ~band
        # empty part of each chamber (only meaningful upright; during the flip it is checked via gap)
        emp = np.zeros_like(gap); empB = emp; empT = emp
        if m['rot'] == 0:
            dx = x - ix
            mound = m['peak'] + G['KB'] * smoothabs(dx)
            crater = m['crater'] - G['KT'] * smoothabs(dx)
            empB = b & (y < mound - 30) & (wd > L / 2 + tol) & inner & ~band    # splash allowance (ballistic grains)
            empT = t & (y < crater - tol) & (wd > L / 2 + tol) & inner & ~band
            emp = empB | empT
        checks = {'outside_triangle': outside, 'face_outside_ring': face_ring, 'side_gaps': gap, 'empty_bottom': empB if m['rot'] == 0 else emp, 'empty_top': empT if m['rot'] == 0 else emp}
        for k, mask in checks.items():
            n = int((im[mask] > 0).sum())
            if n: bad.append((i, round(m['t'], 4), k, n, int(im[mask].max())))
    return bad

def passB(dirn, meta):
    prev = None; d = []
    for i in range(len(meta)):
        im = np.asarray(Image.open(f'{dirn}/f{i:05d}.png').convert('L')).astype(np.int16)
        if prev is not None: d.append(float(np.abs(im - prev).mean()))
        prev = im
    d = np.array(d)
    spikes = []
    for i in range(1, len(d) - 1):
        nb = max(d[i - 1], d[i + 1])
        if d[i] > 3 * nb + 0.02: spikes.append((i + 1, round(meta[i + 1]['t'], 3), round(d[i], 4), round(nb, 4)))
    # nothing should move in these windows (no particles, no glow): exact zero difference
    still = []
    for i in range(len(d)):
        t0, t1 = meta[i]['ph'], meta[i + 1]['ph']
        ph = t1
        quiet = (TM['flow'] + 0.75 < ph < TM['flipStart'] - 1e-6) or (TM['flipEnd'] + 1e-6 < ph < TM['cycle'] - 1e-6)
        if quiet and meta[i]['ph'] < meta[i + 1]['ph'] and d[i] != 0: still.append((i + 1, round(ph, 3), d[i]))
    return d, spikes, still

def identical(a, b):
    A = np.asarray(Image.open(a).convert('RGB')).astype(np.int16); B = np.asarray(Image.open(b).convert('RGB')).astype(np.int16)
    diff = np.abs(A - B).max(axis=2)
    n = int((diff > 0).sum())
    where = ''
    if n:
        s, ox, oy = transform(W, Hh, DPR, MARK)
        ys, xs = np.nonzero(diff)
        where = f'mark-space y {((ys.min()+.5-oy)/s):.0f}..{((ys.max()+.5-oy)/s):.0f}, x {((xs.min()+.5-ox)/s):.0f}..{((xs.max()+.5-ox)/s):.0f}'
    return int(diff.max()), n, where

async def main():
    serve()
    cyc = TM['cycle']; fps = 60
    span = [i / fps for i in range(int(round(cyc * 1.25 * fps)))]       # one cycle and a quarter, crosses the seam
    await run('/tmp/qaA', 0, 0, fps, W, Hh, DPR, MARK, 'glow', span)
    await run('/tmp/qaB', 0, 0, fps, W, Hh, DPR, MARK, 'glow,particles', span)
    e = 1e-6
    pairs = []
    for name, tt in [('flow end', TM['flow']), ('flip start', TM['flipStart']), ('flip end', TM['flipEnd']), ('loop seam', cyc), ('loop seam 2', 2 * cyc)]:
        pairs += [tt - e, tt + e]
    same = []
    for ph in [0.42 * TM['flow'], 1.0, 3.3, TM['flow'] + 0.4, TM['flipStart'] + 0.3, TM['flipStart'] + 0.6, TM['flipEnd'] + 0.1, cyc - 0.05]:
        same += [ph, ph + 2 * cyc]          # texture rides the glass, so the exact period is two flips
    await run('/tmp/qaC', 0, 0, fps, W, Hh, DPR, MARK, '', sorted(pairs))
    await run('/tmp/qaD', 0, 0, fps, W, Hh, DPR, MARK, '', same)

    mA = json.load(open('/tmp/qaA/meta.json')); mB = json.load(open('/tmp/qaB/meta.json'))
    bad = passA('/tmp/qaA', mA)
    print(f'PASS A stray pixels: {len(bad)} violations over {len(mA)} frames')
    for b in bad[:25]: print('   ', b)
    d, spikes, still = passB('/tmp/qaB', mB)
    print(f'PASS B pops: {len(spikes)} spikes; frames that moved when they should not: {len(still)}; diff mean {d.mean():.4f} max {d.max():.4f}')
    for x in spikes[:20]: print('    spike', x)
    for x in still[:10]: print('    moved', x)
    print('PASS C boundaries (max channel diff, pixels differing):')
    names = ['flow end', 'flip start', 'flip end', 'loop seam', 'loop seam 2']
    for k, nm in enumerate(names):
        print(f'    {nm:12s}', identical(f'/tmp/qaC/f{2*k:05d}.png', f'/tmp/qaC/f{2*k+1:05d}.png'))
    print('PASS D same phase, two cycles apart (incl. mid-pour with particles):')
    mD = json.load(open('/tmp/qaD/meta.json'))
    for k in range(0, len(mD), 2):
        print(f'    ph {mD[k]["ph"]:.3f}', identical(f'/tmp/qaD/f{k:05d}.png', f'/tmp/qaD/f{k+1:05d}.png'))
    np.save('/tmp/qaB_diff.npy', d)

    # PASS E: in motion the stream falls behind the sand. Inside both sand bodies the full
    # render must match a render with no particles at all (stream completely hidden there).
    await run('/tmp/qaE1', 0, 0, fps, W, Hh, DPR, MARK, '', span)
    await run('/tmp/qaE2', 0, 0, fps, W, Hh, DPR, MARK, 'particles', span)
    mE = json.load(open('/tmp/qaE1/meta.json'))
    s, u, v = grid(W, Hh, DPR, MARK)
    tol = 1.6 / s
    r = np.hypot(u - ix, v - iy)
    leaks = []
    for i, m in enumerate(mE):
        if m['rot'] != 0: continue
        a = np.asarray(Image.open(f'/tmp/qaE1/f{i:05d}.png').convert('L')).astype(int)
        b = np.asarray(Image.open(f'/tmp/qaE2/f{i:05d}.png').convert('L')).astype(int)
        x, y, bm, tm, wd = chambers(u, v, 0)
        dx = x - ix
        inside = (r < Rin - tol) & (wd > L / 2 + tol)
        sandT = tm & (y > m['crater'] - G['KT'] * smoothabs(dx) + 3 * tol) & inside & (m['fTop'] < 1)
        surfB = np.maximum(m['peak'] + G['KB'] * smoothabs(dx), iy)          # a pile at the neck is flush with it
        sandB = bm & (y > surfB + 3 * tol) & inside & (m['fBot'] > 0)
        for nm, mask in (('top sand', sandT), ('bottom sand', sandB)):
            n = int((a[mask] != b[mask]).sum())
            if n: leaks.append((i, round(m['t'], 3), nm, n, int(np.abs(a[mask] - b[mask]).max())))
    print(f'PASS E stream hidden inside sand: {len(leaks)} frames with leaks over {len(mE)} frames')
    for x in leaks[:15]: print('   ', x)

    # PASS F: the neck. Beside the column, between the walls' inner faces, below the pinch:
    # pure black on every frame (glow off). No grain fragments, no fringes.
    mA = json.load(open('/tmp/qaA/meta.json'))
    s, u, v = grid(W, Hh, DPR, MARK)
    tol = 1.6 / s
    a, sl, taper = G['a'], G['slope'], G['taper']
    dy = v - iy
    halfw = a * (1 - taper * np.clip(dy / Rin, 0, 1))
    inner = a + dy / sl                                   # wall inner face, opening out below the pinch
    dirty = []
    for i, m in enumerate(mA):
        if m['rot'] != 0: continue
        im = np.asarray(Image.open(f'/tmp/qaA/f{i:05d}.png').convert('L'))
        surfB = np.maximum(m['peak'] + G['KB'] * smoothabs(u - ix), iy)
        rr = np.hypot(u - ix, v - iy)
        side = (dy > tol) & (np.abs(u - ix) > halfw + tol) & (np.abs(u - ix) < inner - tol) & (v < surfB - 30) & (rr < Rin - tol)
        n = int((im[side] > 0).sum())
        if n: dirty.append((i, round(m['t'], 3), n, int(im[side].max())))
    print(f'PASS F neck sides pure black: {len(dirty)} dirty frames over {len(mA)}')
    for x in dirty[:15]: print('   ', x)

if __name__ == '__main__':
    asyncio.run(main())
