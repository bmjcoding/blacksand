// Builds hero/index.html as a single self-contained file (engine + renderer inlined as a
// classic script), so it opens straight from disk. The ES modules stay the source of truth.
import fs from 'node:fs';
const strip = (src) => src
  .replace(/^import .*?;\s*$/gm, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export function /gm, 'function ');
const engine = strip(fs.readFileSync(new URL('../hero/blacksand-engine.js', import.meta.url), 'utf8'));
const hero = strip(fs.readFileSync(new URL('../hero/blacksand-hero.js', import.meta.url), 'utf8'));
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>blacksand</title>
<style>
  html,body{margin:0;height:100%;background:#000}
  .hero{position:relative;height:100vh;background:#000}
  .hero canvas{display:block;width:100%;height:100%}
</style>
</head>
<body>
<section class="hero"><canvas id="blacksand" aria-label="blacksand" role="img"></canvas></section>
<script>
(() => {
${engine}
${hero}
  const p = new URLSearchParams(location.search);
  window.hero = mountBlacksand(document.getElementById('blacksand'), {
    autoplay: p.get('autoplay') !== '0',
    dpr: p.has('dpr') ? +p.get('dpr') : undefined,
    markSize: p.has('mark') ? +p.get('mark') : undefined,
    streamLayer: p.get('layer') || undefined,
    debug: p.has('debug') ? Object.fromEntries(p.get('debug').split(',').filter(Boolean).map((k) => [k, false])) : undefined,
    profile: p.has('profile'),
    webgl: p.get('webgl') === '0' ? false : undefined,
    pointerLight: p.get('pointer') !== '0',
  });
  window.heroReady = true;
})();
</script>
</body>
</html>
`;
fs.writeFileSync(new URL('../hero/index.html', import.meta.url), html);
console.log('hero/index.html', html.length, 'bytes');
