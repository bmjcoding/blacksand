// Backlit-mark lockups: B (Geist Semibold, tracking -4.5%) primary, D (Geist Mono Medium,
// tracking -3%) for docs/CLI. Mark height 1.9x cap height, gap 0.5x cap height, text #666666.
// The wordmark outlines were shaped once from the Geist fonts and are kept as paths in
// wordmark.json (with their placement), so no font tooling is needed to rebuild the lockups
// after the mark changes. Run build-static.mjs first; it writes mark_fragment.json.
//   node tools/lockups.mjs [outdir]
import fs from 'node:fs';

const out = process.argv[2] || new URL('..', import.meta.url).pathname;
const frag = JSON.parse(fs.readFileSync(new URL('mark_fragment.json', import.meta.url), 'utf8'));
const words = JSON.parse(fs.readFileSync(new URL('wordmark.json', import.meta.url), 'utf8'));

for (const [name, w] of Object.entries(words)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${w.viewBox}" role="img" aria-label="blacksand">\n<title>blacksand</title>\n` +
    `${frag.body}\n<path fill="${w.fill}" transform="translate(${w.tx} ${w.ty}) scale(${w.scale})" d="${w.d}"/>\n</svg>\n`;
  fs.writeFileSync(`${out}/${name}.svg`, svg);
  console.log(name, svg.length, 'bytes');
}
