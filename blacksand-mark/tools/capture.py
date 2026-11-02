"""Deterministic frame capture: drives renderer.renderAt(t) and dumps PNGs."""
import asyncio, base64, sys, os, http.server, threading, functools, json
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    h = functools.partial(Q, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

async def run(out, t0, t1, fps, w, h, dpr, mark, debug='', times=None, layer=''):
    os.makedirs(out, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=dpr)
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in (m.location or {}).get('url', '') else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(f'http://127.0.0.1:8765/index.html?autoplay=0&dpr={dpr}&mark={mark}&debug={debug}&layer={layer}')
        await pg.wait_for_function('window.heroReady === true')
        ts = times if times is not None else [t0 + i / fps for i in range(int(round((t1 - t0) * fps)))]
        n = len(ts)
        meta = []
        for i, t in enumerate(ts):
            data = await pg.evaluate(f'(() => {{ hero.renderAt({t!r}); const s = hero.state({t!r}); return [document.getElementById("blacksand").toDataURL("image/png"), {{t: s.t, ph: s.ph, rot: s.rot, fTop: s.fTop, fBot: s.fBot, peak: s.peak, crater: s.crater, pulse: s.pulse, g: s.grains.length, sp: s.splash.length, ro: s.rollers.length}}]; }})()')
            open(f'{out}/f{i:05d}.png', 'wb').write(base64.b64decode(data[0].split(',')[1]))
            meta.append(data[1])
        json.dump(meta, open(f'{out}/meta.json', 'w'))
        await b.close()
        if errs: print('ERRORS', errs); sys.exit(1)
    print('frames', n)

if __name__ == '__main__':
    out, t0, t1, fps, w, h, dpr, mark = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), float(sys.argv[7]), float(sys.argv[8])
    debug = sys.argv[9] if len(sys.argv) > 9 else ''
    srv = serve()
    asyncio.run(run(out, t0, t1, fps, w, h, dpr, mark, debug))
