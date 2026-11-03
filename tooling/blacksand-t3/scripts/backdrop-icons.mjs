// Renders the icon backdrop (lib/icon-backdrop.mjs) into the images the build installs:
//
// - lib/files/icon-{rim,face,sand,etch,stream}.png: the glow logo's parts, 1024 x 1024 in the
//   icon body's points, for the Liquid Glass layers (rules desktop/app-icon-backdrop-*). The
//   stream is a light that only brightens what's behind it; Icon Composer layers composite
//   plainly, so its image is the stream already lightened onto the logo, opaque wherever it
//   shows and clear elsewhere.
// - lib/files/backdrop-{macos-1024,universal-1024,180}.png: upstream's flat icons with the
//   whole backdrop drawn behind their T3.
//
// Rerun it when upstream changes those icons, or the backdrop or the glow logo changes. Any
// platform with Chrome or Chromium:
//
//   node scripts/backdrop-icons.mjs <upstream checkout at the pin> lib/files
//
// CHROME=<path> picks the browser; otherwise lib/looks.mjs finds one.
//
// "Behind" without upstream's layers: inside the icon's body each pixel becomes the lighter of
// upstream's pixel and the backdrop's. Upstream's T3 is near-white on black and the backdrop is
// darker than the T3, so the T3 stays whole and in front, and the backdrop shows where upstream
// is black. The body is upstream's opaque area pulled in by 6 pixels (per 1024), so the glass
// rim and shadow stay upstream's. The macOS icon's body is inset 100 of 1024 pixels on each
// side, for its shadow; the others fill the image.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BACKDROP_FLAT, LOGO_SOURCES } from "../lib/icon-backdrop.mjs";
import { findChrome, launchChrome } from "../lib/looks.mjs";

const [checkout, outDir] = process.argv.slice(2);
if (!checkout || !outDir) {
  console.error("usage: node scripts/backdrop-icons.mjs <upstream checkout> <out dir>");
  process.exit(2);
}
const ICONS = [
  { from: "assets/prod/black-macos-1024.png", to: "backdrop-macos-1024.png", inset: 100 / 1024 },
  { from: "assets/prod/black-universal-1024.png", to: "backdrop-universal-1024.png", inset: 0 },
  { from: "assets/prod/t3-black-web-apple-touch-180.png", to: "backdrop-180.png", inset: 0 },
];
const svgUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const pngUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;

const binary = process.env.CHROME ?? findChrome();
if (!binary) throw new Error("no Chrome or Chromium found; set CHROME=<path>");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-backdrop-"));
const chrome = await launchChrome(binary, profile);
try {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const save = (name, dataUrl) => {
    fs.writeFileSync(path.join(outDir, name), Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(name);
  };

  // 1. the logo's parts
  const sources = Object.fromEntries(Object.entries(LOGO_SOURCES).map(([k, svg]) => [k, svgUrl(svg)]));
  const parts = await evaluate(`(${renderParts})(${JSON.stringify(sources)})`);
  for (const [name, png] of Object.entries(parts)) save(`icon-${name}.png`, png);

  // 2. the flat icons, from the same images
  const backdrop = BACKDROP_FLAT.map((part) => (part.svg ? svgUrl(part.svg) : pngUrl(path.join(outDir, part.png))));
  for (const icon of ICONS) {
    const base = pngUrl(path.join(checkout, icon.from));
    save(icon.to, await evaluate(`(${compose})(${JSON.stringify(base)}, ${JSON.stringify(backdrop)}, ${icon.inset})`));
  }
} finally {
  await chrome.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// Runs in the page. Each part as a 1024 PNG; the stream as `whole` where it differs from `under`.
async function renderParts(sources) {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("can't load a logo part"));
    image.src = src;
  });
  const pixels = (image) => {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 1024;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 1024, 1024);
    return { c, data: ctx.getImageData(0, 0, 1024, 1024) };
  };
  const out = {};
  for (const name of ["rim", "face", "sand", "etch"]) out[name] = pixels(await load(sources[name])).c.toDataURL("image/png");
  const under = pixels(await load(sources.under)).data.data;
  const whole = pixels(await load(sources.whole));
  const w = whole.data.data;
  const stream = new ImageData(1024, 1024);
  for (let i = 0; i < w.length; i += 4) {
    if (w[i] === under[i] && w[i + 1] === under[i + 1] && w[i + 2] === under[i + 2]) continue;
    stream.data.set([w[i], w[i + 1], w[i + 2], 255], i);
  }
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 1024;
  c.getContext("2d").putImageData(stream, 0, 0);
  out.stream = c.toDataURL("image/png");
  return out;
}

// Runs in the page: returns the composed PNG as a data URL.
async function compose(baseUrl, backdropUrls, inset) {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`can't load ${src.slice(0, 40)}`));
    image.src = src;
  });
  const base = await load(baseUrl);
  const parts = await Promise.all(backdropUrls.map(load));
  const size = base.naturalWidth;
  const canvas = (draw) => {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    draw(ctx);
    return ctx.getImageData(0, 0, size, size);
  };
  const up = canvas((ctx) => ctx.drawImage(base, 0, 0));
  const body = size * (1 - 2 * inset);
  const back = canvas((ctx) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = "high";
    for (const part of parts) ctx.drawImage(part, size * inset, size * inset, body, body);
  });
  // the body: opaque, and at least `pull` pixels from anything that isn't
  const pull = Math.max(1, Math.round((6 * size) / 1024));
  const opaque = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) opaque[i] = up.data[i * 4 + 3] >= 250 ? 1 : 0;
  const erode = (src, horizontal) => {
    const out = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let keep = 1;
        for (let d = -pull; d <= pull && keep; d++) {
          const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size || !src[yy * size + xx]) keep = 0;
        }
        out[y * size + x] = keep;
      }
    }
    return out;
  };
  const inside = erode(erode(opaque, true), false);
  const out = new ImageData(new Uint8ClampedArray(up.data), size, size);
  for (let i = 0; i < size * size; i++) {
    if (!inside[i]) continue;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.max(up.data[i * 4 + c], back.data[i * 4 + c]);
  }
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  c.getContext("2d").putImageData(out, 0, 0);
  return c.toDataURL("image/png");
}
