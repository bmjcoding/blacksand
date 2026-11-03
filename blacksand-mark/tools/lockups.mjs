// Backlit-mark lockups: B (Geist Semibold, tracking -4.5%) primary, D (Geist Mono Medium,
// tracking -3%) for docs/CLI. Mark height 1.9x cap height, gap 0.5x cap height, text #666666.
// The wordmark outlines were shaped once from the Geist fonts and are kept as paths in
// wordmark.json (with their placement), so no font tooling is needed to rebuild the lockups
// after the mark changes. Run build-static.mjs first; it writes tools/.build/mark-fragment.json.
//   node tools/lockups.mjs [outdir]       (default: lockups/)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] || fileURLToPath(new URL('../lockups', import.meta.url));
fs.mkdirSync(out, { recursive: true });
const frag = JSON.parse(fs.readFileSync(new URL('.build/mark-fragment.json', import.meta.url), 'utf8'));
const words = JSON.parse(fs.readFileSync(new URL('data/wordmark.json', import.meta.url), 'utf8'));

// Variants: the default no-glow mark (wordmark #666666, for dark surfaces) and the light-background
// mark (-light, wordmark #262626). Two cuts each, as for the marks: the base name for a mark 128 px
// tall and up (8-unit line), -small for 24-127 px (16-unit line, never under 1 px).
// The boxes are tight: no lighting in a lockup, so no margin for a pool. The approved spacing is
// kept (mark-to-text gap; equal breathing room left and right, 16 units).
// -glow: the backlit glow mark for black and near-black surfaces (dark-mode README headers, key
// art), its wordmark #d4d4d4 so it reads at full strength there (#666666 is 3.3:1 on GitHub's
// #0d1117, #d4d4d4 12.8:1). Its box keeps the glow mark's own margin, so the rim's light isn't cut.
const PAD = 16;
const cuts = [
  ['', 'darkLarge', '#666666'], ['-small', 'dark', '#666666'],
  ['-light', 'lightLarge', '#262626'], ['-light-small', 'light', '#262626'],
  ['-glow', 'glowLarge', '#d4d4d4', frag.glowPad], ['-glow-small', 'glow', '#d4d4d4', frag.glowPad],
];
// wordmark.json keys are the output base names: blacksand-lockup (Geist), blacksand-lockup-mono (Geist Mono)
for (const [name, w] of Object.entries(words)) {
  const [vx, vy, vw] = w.viewBox.split(/\s+/).map(Number);
  for (const [suffix, key, fill, pad = PAD] of cuts) {
    const right = vx + vw - (56 - vx) + pad;             // text's right edge + the same pad as on the left
    const box = { x: 56 - pad, y: 138 - pad, h: 740 + 2 * pad };
    box.w = right - box.x;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w.toFixed(0)} ${box.h}" role="img" aria-label="blacksand">\n<title>blacksand</title>\n` +
      `${frag[key]}\n<path fill="${fill}" transform="translate(${w.tx} ${w.ty}) scale(${w.scale})" d="${w.d}"/>\n</svg>\n`;
    fs.writeFileSync(`${out}/${name}${suffix}.svg`, svg);
    console.log(name + suffix, svg.length, 'bytes');
  }
}
