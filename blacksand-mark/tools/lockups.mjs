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

// Variants (design panel, review 3): the default no-glow mark (wordmark #666666, for dark
// surfaces) and the light-background mark (wordmark #262626). Two cuts each: the default for
// marks under 128 px tall (16-unit static line, never under 1 px) and _large for 128 px and up.
// The boxes are tight: no lighting in a lockup, so no margin for a pool. The approved spacing is
// kept (mark-to-text gap; equal breathing room left and right, 16 units).
const PAD = 16;
const cuts = [
  ['', 'dark', '#666666'], ['_large', 'darkLarge', '#666666'],
  ['_light', 'light', '#262626'], ['_light_large', 'lightLarge', '#262626'],
];
for (const [name, w] of Object.entries(words)) {
  const [vx, vy, vw] = w.viewBox.split(/\s+/).map(Number);
  const right = vx + vw - (56 - vx) + PAD;               // text's right edge + the same pad as on the left
  const box = { x: 56 - PAD, y: 138 - PAD, h: 740 + 2 * PAD };
  box.w = right - box.x;
  for (const [suffix, key, fill] of cuts) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w.toFixed(0)} ${box.h}" role="img" aria-label="blacksand">\n<title>blacksand</title>\n` +
      `${frag[key]}\n<path fill="${fill}" transform="translate(${w.tx} ${w.ty}) scale(${w.scale})" d="${w.d}"/>\n</svg>\n`;
    fs.writeFileSync(`${out}/${name}${suffix}.svg`, svg);
    console.log(name + suffix, svg.length, 'bytes');
  }
}
