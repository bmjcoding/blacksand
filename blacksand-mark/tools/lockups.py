"""Backlit-mark lockups: B (Geist, lowercase) primary, D (Geist Mono) for docs/CLI."""
import json, sys, os
sys.path.insert(0, '/home/claude/logo')
import wordmark as wm

HERE = os.path.dirname(os.path.abspath(__file__))
frag = json.load(open(f'{HERE}/out/mark_fragment.json'))
VB, IY = frag['vb'], frag['iy']
MY0, MY1, MX1 = 138, 878, 968
MH = MY1 - MY0

def lockup(text, font, axes, tracking, mark_to_cap, gap_to_cap, color):
    wm.TEXT = text
    d, cap, xmin, xmax = wm.shape(font, axes, tracking)
    capH = MH / mark_to_cap
    s = capH / cap
    tx = MX1 + capH * gap_to_cap - xmin * s
    base = IY + capH / 2                                # caps centred on the ring
    pad_l = 56 - VB['x']                                # same breathing room both sides
    x1 = tx + xmax * s + pad_l
    vb = f"{VB['x']} {VB['y']} {x1 - VB['x']:.0f} {VB['h']}"
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="blacksand">\n<title>blacksand</title>\n'
            f'{frag["body"]}\n<path fill="{color}" transform="translate({tx:.2f} {base:.2f}) scale({s:.5f})" d="{d}"/>\n</svg>\n')

TEXT_GREY = '#666666'   # just above the brightest sand (#5e5e5e); 3.7:1 on black
SPECS = {
    'blacksand_lockup':      ('blacksand', 'Geist[wght].ttf',     {'wght': 600}, -0.045, 1.90, 0.50),
    'blacksand_lockup_mono': ('blacksand', 'GeistMono[wght].ttf', {'wght': 500}, -0.030, 1.90, 0.50),
}
if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else f'{HERE}/out'
    colors = sys.argv[2].split(',') if len(sys.argv) > 2 else [TEXT_GREY]
    for name, spec in SPECS.items():
        for c in colors:
            suffix = '' if len(colors) == 1 else '_' + c.strip('#')
            open(f'{out}/{name}{suffix}.svg', 'w').write(lockup(*spec, c))
    print('ok')
