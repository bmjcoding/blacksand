// The app icon's backdrop: behind upstream's T3, a night sky with a few stars, a moonlit
// silver dune, and the blacksand glow logo (lib/files/blacksand-mark-glow.svg, made by
// blacksand-mark's tools/build-static.mjs) with its glowing sand stream. One source for
// both forms of the icon:
//
// - the Liquid Glass icon: each part is a layer of upstream's Icon Composer bundle, behind
//   its T3 (rules desktop/app-icon-backdrop-*, BACKDROP_LAYERS below);
// - the flat PNGs (DMG volume, Linux, splash): scripts/backdrop-icons.mjs draws the same
//   parts behind the T3 of upstream's PNGs.
//
// Coordinates are Icon Composer's: the icon's body is a 1024-point square, y down, and every
// part is a full-canvas image placed at scale 1, so the layers and the flat drawing line up.
// The logo's parts are rendered to PNG by scripts/backdrop-icons.mjs (lib/files/icon-*.png):
// the rim's glow is a blur, and the stream is a light that only brightens what's behind it,
// neither of which an Icon Composer layer can be trusted to draw from SVG.

import * as fs from "node:fs";

const files = new URL("./files/", import.meta.url);
const GLOW_SVG = fs.readFileSync(new URL("blacksand-mark-glow.svg", files), "utf8");

// The logo's triangle (56..968 x 138..878 in its units) is 870 wide, its centroid at y 547.
// Its stream runs through the gap between upstream's T and 3, not the icon's centre: in
// upstream's text.svg (128 units, placed at scale 8.5) the T's bar ends at x 64.33 and the
// 3's starts at 68.17, so the gap's middle, 66.25, is 2.25 units (19 points) right of centre.
export const T3_GAP_X = 512 + (66.25 - 64) * 8.5;
const LOGO = { centerX: T3_GAP_X, width: 870, centroidY: 547 };
const SCALE = LOGO.width / 912;
export const LOGO_TRANSFORM = `translate(${round(LOGO.centerX - 512 * SCALE)} ${round(LOGO.centroidY - ((138 + 878 + 878) / 3) * SCALE)}) scale(${round(SCALE, 5)})`;

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n${body}\n</svg>\n`;

// The scene was drawn on the flat macOS PNG, whose body is inset 100 of 1024 pixels: this
// maps those coordinates onto the body.
const FROM_FLAT = `scale(${round(1024 / 824, 5)}) translate(-100 -100)`;

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function stars() {
  const r = rng(7), out = [];
  for (let i = 0; out.length < 14 && i < 4000; i++) {
    const x = 110 + r() * 804, y = 110 + Math.pow(r(), 1.3) * 430;
    const rad = 2.2 + Math.pow(r(), 4) * 2.6, o = (0.35 + r() * 0.5) * (1 - (0.5 * (y - 110)) / 470);
    if (out.every(([px, py]) => Math.hypot(px - x, py - y) > 60)) out.push([x, y, rad, o]);
  }
  return `<g fill="#f4f4f5">${out.map(([x, y, rad, o]) => `<circle cx="${round(x, 1)}" cy="${round(y, 1)}" r="${round(rad)}" fill-opacity="${round(o)}"/>`).join("")}</g>`;
}

function ridge(base, amp, waves) {
  const pts = [];
  for (let x = 0; x <= 1024; x += 8) {
    let y = base;
    for (const [k, a, ph] of waves) {
      const t = (2 * Math.PI * k * x) / 1024 + ph;
      y -= amp * a * Math.sin(t + 0.55 * Math.sin(t)); // wind-shaped, as in the sidebar
    }
    pts.push(`${x} ${round(y, 1)}`);
  }
  return `M0 1024L${pts.join("L")}L1024 1024Z`;
}

const SKY =
  `<defs><linearGradient id="t3b-sky" x1="0" y1="100" x2="0" y2="760" gradientUnits="userSpaceOnUse">` +
  `<stop stop-color="#0d0d0f"/><stop offset=".3" stop-color="#121214"/><stop offset="1" stop-color="#2a2a2e"/></linearGradient></defs>\n` +
  `<g transform="${FROM_FLAT}"><rect x="-100" y="-100" width="1224" height="1224" fill="url(#t3b-sky)"/>${stars()}</g>`;
const DUNE =
  `<defs><linearGradient id="t3b-dune" x1="0" y1="775" x2="0" y2="1000" gradientUnits="userSpaceOnUse">` +
  `<stop stop-color="#a6a6ac"/><stop offset=".5" stop-color="#4c4c51"/><stop offset="1" stop-color="#1a1a1c"/></linearGradient></defs>\n` +
  `<g transform="${FROM_FLAT}"><path d="${ridge(815, 34, [[1, 1, 2.2], [2, 0.45, 0.6]])}" fill="url(#t3b-dune)"/></g>`;

// ---- the glow logo, in parts ----
// Lines of lib/files/blacksand-mark-glow.svg, in drawing order. Each must be there exactly once.
const lines = GLOW_SVG.split("\n");
const one = (name, test) => {
  const hits = lines.filter(test);
  if (hits.length !== 1) throw new Error(`lib/files/blacksand-mark-glow.svg: expected one ${name}, found ${hits.length}`);
  return hits[0];
};
const DEFS = GLOW_SVG.slice(GLOW_SVG.indexOf("<defs>"), GLOW_SVG.indexOf("</defs>") + "</defs>".length);
const PART = {
  rim: one("rim", (l) => l.includes('filter="url(#bs-rim)"')),
  face: one("face", (l) => l === '<path d="M512 138L968 878L56 878Z" fill="#000"/>'),
  sand: [one("top sand", (l) => l.startsWith('<g clip-path="url(#bs-ct)">')), one("bottom sand", (l) => l.startsWith('<g clip-path="url(#bs-cb)">'))].join("\n"),
  etch: [one("ring", (l) => l.startsWith("<circle ")), one("walls", (l) => l.startsWith('<path d="M384.97'))].join("\n"),
  stream: one("stream", (l) => l.startsWith('<g style="mix-blend-mode:lighten">')),
};
// In the icon the stream sits in the T-3 gap: only its tight halo, no haze, so no light
// reaches the T3's edges.
const haze = PART.stream.match(/<path [^>]*filter="url\(#bs-haze\)"\/>/);
if (!haze) throw new Error("lib/files/blacksand-mark-glow.svg: the stream has no haze to drop");
// Without the haze the core needs more light of its own to keep the logo's brightness (122 of
// 255): white at 34% instead of 18%, which also keeps it above the brightest sand it crosses.
const core = PART.stream.match(/stroke-opacity="([\d.]+)" stroke-width="[\d.]+" stroke-linecap="butt"/);
if (!core) throw new Error("lib/files/blacksand-mark-glow.svg: the stream has no core");
const ICON_STREAM = PART.stream.replace(haze[0], "").replace(core[0], core[0].replace(`stroke-opacity="${core[1]}"`, 'stroke-opacity="0.34"'));

const logo = (...parts) => svg(`${DEFS}\n<g transform="${LOGO_TRANSFORM}">\n${parts.join("\n")}\n</g>`);

/** SVG sources the PNG script renders: each logo part alone, and the logo whole (with and without its stream). */
export const LOGO_SOURCES = {
  rim: logo(PART.rim),
  face: logo(PART.face),
  sand: logo(PART.sand),
  etch: logo(PART.etch),
  // what lies under the stream, and the logo with it: the stream layer is where they differ
  under: logo(PART.face, PART.sand, PART.etch),
  whole: logo(PART.face, PART.sand, PART.etch, ICON_STREAM),
};

/** Icon Composer images: SVG text, or the name of a PNG in lib/files. */
export const BACKDROP_ASSETS = {
  "blacksand-sky.svg": { svg: svg(SKY) },
  "blacksand-dune.svg": { svg: svg(DUNE) },
  "blacksand-rim.png": { png: "icon-rim.png" },
  "blacksand-face.png": { png: "icon-face.png" },
  "blacksand-sand.png": { png: "icon-sand.png" },
  "blacksand-etch.png": { png: "icon-etch.png" },
  "blacksand-stream.png": { png: "icon-stream.png" },
};

const layer = (image, name, { glass = false, tinted = null } = {}) => ({
  glass,
  "image-name": image,
  name,
  position: { scale: 1, "translation-in-points": [0, 0] },
  ...(tinted === null ? {} : { "fill-specializations": [{ appearance: "tinted", value: { solid: `srgb:1.00000,1.00000,1.00000,${tinted.toFixed(5)}` } }] }),
});

/**
 * After upstream's T3, front to back. Only the sky is glass; nothing on the logo is, so no
 * glass edge or specular rims it. Under a system tint each logo part becomes white at its
 * own strength (the stream brightest, then the rim and the hourglass, then the sand), and
 * the face stays black, so the whole mark survives instead of collapsing to a triangle.
 */
export const BACKDROP_LAYERS = [
  layer("blacksand-stream.png", "Blacksand stream", { tinted: 0.6 }),
  layer("blacksand-etch.png", "Blacksand ring and walls", { tinted: 0.45 }),
  layer("blacksand-sand.png", "Blacksand sand", { tinted: 0.35 }),
  layer("blacksand-face.png", "Blacksand face"),
  layer("blacksand-rim.png", "Blacksand rim", { tinted: 0.45 }),
  layer("blacksand-dune.svg", "Blacksand dune", { tinted: 0.12 }),
  layer("blacksand-sky.svg", "Blacksand sky", { glass: true }),
];

/** Back to front, for the flat PNGs: SVG text, or a PNG name in lib/files. */
export const BACKDROP_FLAT = [
  { svg: svg(SKY) },
  { svg: svg(DUNE) },
  { png: "icon-rim.png" },
  { png: "icon-face.png" },
  { png: "icon-sand.png" },
  { png: "icon-etch.png" },
  { png: "icon-stream.png" },
];

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
