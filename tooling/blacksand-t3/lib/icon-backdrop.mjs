// The app icon's backdrop: a night sky, one low dune, and the blacksand static logo
// behind upstream's T3. One source for both forms of the icon:
//
// - the Liquid Glass icon: each part is a layer of upstream's Icon Composer bundle,
//   behind its T3 (rules desktop/app-icon-backdrop-*, BACKDROP_LAYERS below);
// - the flat PNGs (DMG volume, Linux, splash): scripts/backdrop-icons.mjs draws
//   BACKDROP_FLAT_SVG behind the T3 of upstream's PNGs.
//
// Coordinates are Icon Composer's: the icon's body is a 1024-point square, y down.
// Every part is a full-canvas SVG placed at scale 1, so the layers and the flat
// drawing line up exactly.

import * as fs from "node:fs";

const files = new URL("./files/", import.meta.url);

/**
 * lib/files/blacksand-mark.svg is the static logo (the default, no-glow mark). In
 * the icon its sand line is dimmed from #8e8e8e to #555555: at Dock sizes the
 * bright line reads as a seam through the T.
 */
export const MARK_LINE = { from: "#8e8e8e", to: "#555555" };
const MARK_SVG = fs.readFileSync(new URL("blacksand-mark.svg", files), "utf8");
if (MARK_SVG.split(MARK_LINE.from).length !== 2) throw new Error("lib/files/blacksand-mark.svg: expected one #8e8e8e line");

// The logo's triangle (56..968 x 138..878 in its own units) is 870 wide, its centroid
// at y 572, clear of the body's rounded corners. Its centre line runs through the gap
// between upstream's T and 3, not the icon's centre: in upstream's text.svg (128
// units, placed at scale 8.5) the T's bar ends at x 64.33 and the 3's starts at 68.17,
// so the gap's middle, 66.25, is 2.25 units (19 points) right of centre.
const T3_GAP_X = 512 + (66.25 - 64) * 8.5;
const LOGO = { centerX: T3_GAP_X, width: 870, centroidY: 572, opacity: 0.85 };
const DUNE = { base: 957, amp: 24 };
const SKY = { top: "#0d0d0f", mid: "#121214", horizon: "#1f1f22" };

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n${body}\n</svg>\n`;

function logoGroup() {
  const s = LOGO.width / 912;
  const tx = LOGO.centerX - 512 * s;
  const ty = LOGO.centroidY - ((138 + 878 + 878) / 3) * s;
  // the logo's own <svg> becomes a group, its ids prefixed so they can't collide
  const inner = MARK_SVG.replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replaceAll(MARK_LINE.from, MARK_LINE.to)
    .replaceAll('id="bs-', 'id="t3b-icon-')
    .replaceAll("url(#bs-", "url(#t3b-icon-");
  return `<g transform="translate(${round(tx)} ${round(ty)}) scale(${round(s, 5)})">${inner.trim()}</g>`;
}

function duneGroup() {
  const pts = [];
  const waves = [[1, 1, 0.4], [2, 0.55, 2.1], [3, 0.2, 0.9]];
  for (let x = 0; x <= 1024; x += 8) {
    let y = DUNE.base;
    for (const [k, a, phase] of waves) {
      const t = (2 * Math.PI * k * x) / 1024 + phase;
      y -= DUNE.amp * a * Math.sin(t + 0.55 * Math.sin(t)); // wind-shaped, as in the sidebar
    }
    pts.push(`${x} ${round(y)}`);
  }
  return `<defs><linearGradient id="t3b-icon-dune" x1="0" y1="${DUNE.base - DUNE.amp * 1.6}" x2="0" y2="1024" gradientUnits="userSpaceOnUse">` +
    `<stop stop-color="#3a3a3e"/><stop offset=".4" stop-color="#1c1c1f"/><stop offset="1" stop-color="#0f0f10"/></linearGradient></defs>\n` +
    `<path d="M0 1024L${pts.join("L")}L1024 1024Z" fill="url(#t3b-icon-dune)"/>`;
}

const skyGroup = () =>
  `<defs><linearGradient id="t3b-icon-sky" x1="0" y1="0" x2="0" y2="820" gradientUnits="userSpaceOnUse">` +
  `<stop stop-color="${SKY.top}"/><stop offset=".3" stop-color="${SKY.mid}"/><stop offset="1" stop-color="${SKY.horizon}"/></linearGradient></defs>\n` +
  `<rect width="1024" height="1024" fill="url(#t3b-icon-sky)"/>`;

/** The Icon Composer image files, by name. */
export const BACKDROP_ASSETS = {
  "blacksand-dune.svg": svg(duneGroup()),
  "blacksand-logo.svg": svg(logoGroup()),
  "blacksand-sky.svg": svg(skyGroup()),
};

/**
 * Upstream's T3 group gets these after its own layers, so they sit behind it,
 * front to back as Icon Composer lists them (as upstream's nightly bundle does
 * with its clouds and background). Only the sky is glass; the logo and the dune
 * aren't, so no glass edge or specular rims them. With a system tint the logo
 * and dune become faint white shapes.
 */
export const BACKDROP_LAYERS = [
  {
    glass: false,
    "image-name": "blacksand-dune.svg",
    name: "Blacksand dune",
    position: { scale: 1, "translation-in-points": [0, 0] },
    "fill-specializations": [{ appearance: "tinted", value: { solid: "srgb:1.00000,1.00000,1.00000,0.12000" } }],
  },
  {
    glass: false,
    "image-name": "blacksand-logo.svg",
    name: "Blacksand logo",
    opacity: LOGO.opacity,
    position: { scale: 1, "translation-in-points": [0, 0] },
    "fill-specializations": [{ appearance: "tinted", value: { solid: "srgb:1.00000,1.00000,1.00000,0.20000" } }],
  },
  {
    glass: true,
    "image-name": "blacksand-sky.svg",
    name: "Blacksand sky",
    position: { scale: 1, "translation-in-points": [0, 0] },
  },
];

/** The same backdrop as one drawing, for the flat PNGs. */
export const BACKDROP_FLAT_SVG = svg(
  `${skyGroup()}\n<g opacity="${LOGO.opacity}">${logoGroup()}</g>\n${duneGroup()}`,
);

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
