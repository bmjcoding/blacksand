// Renders the icon backdrop (lib/icon-backdrop.mjs) into the images the build installs:
//
// - lib/files/icon-{rim,face,sand,etch,stream}.png: the glow logo's parts, 1024 x 1024 in the
//   icon body's points, for the Liquid Glass layers (rules desktop/app-icon-backdrop-*). The
//   stream is a light that only brightens what's behind it; Icon Composer layers composite
//   plainly, so its image is the stream already lightened onto the logo, opaque wherever it
//   shows and clear elsewhere.
// - lib/files/backdrop-{macos-1024,universal-1024,180}.png: upstream's flat icons with the
//   whole backdrop drawn behind their T3.
// - lib/files/backdrop-favicon-{16,32}.png and backdrop-favicon.ico: the browser tab's icon,
//   the full-bleed icon scaled down as upstream's favicons are (the .ico holds the same seven
//   sizes as upstream's, each a PNG).
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
// is black. It follows upstream's own anti-aliased edge, so the backdrop's edge is as smooth
// as upstream's, its glass rim highlight stays on top, and its shadow stays its own. The macOS
// icon's body is inset 100 of 1024 pixels on each side, for its shadow; the others fill the
// image.

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

  // 3. favicons, from the full-bleed icon
  const full = pngUrl(path.join(outDir, "backdrop-universal-1024.png"));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const scaled = await evaluate(`(${downscale})(${JSON.stringify(full)}, ${JSON.stringify(sizes)})`);
  const png = (size) => Buffer.from(scaled[size].split(",")[1], "base64");
  save("backdrop-favicon-16.png", scaled[16]);
  save("backdrop-favicon-32.png", scaled[32]);
  fs.writeFileSync(path.join(outDir, "backdrop-favicon.ico"), ico(sizes.map((size) => [size, png(size)])));
  console.log("backdrop-favicon.ico");
} finally {
  await chrome.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

/** An .ico of PNG images (the Vista format every browser reads). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(([, data]) => data)]);
}

// Runs in the page: the image at each size, halved step by step for a clean small result.
async function downscale(url, sizes) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const out = {};
  for (const size of sizes) {
    let src = image, w = image.naturalWidth;
    while (w / 2 >= size) {
      const c = document.createElement("canvas");
      c.width = c.height = Math.round(w / 2);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, c.width, c.height);
      src = c;
      w = c.width;
    }
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, size, size);
    out[size] = c.toDataURL("image/png");
  }
  return out;
}

// Runs in the page. Copy the stream's composited colors within its own alpha support;
// separate SVG rasters can differ by one RGB level even far outside the stream.
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
  const support = pixels(await load(sources.stream)).data.data;
  const whole = pixels(await load(sources.whole));
  const w = whole.data.data;
  const stream = new ImageData(1024, 1024);
  for (let i = 0; i < w.length; i += 4) {
    if (support[i + 3] === 0) continue;
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
  // Where upstream's body is, by its own anti-aliased edge: a pixel lightens in proportion to
  // its coverage, so the backdrop's edge is as smooth as upstream's. The lighten keeps
  // upstream's bright rim highlight on top, and the shadow outside the body stays upstream's.
  const out = new ImageData(new Uint8ClampedArray(up.data), size, size);
  for (let i = 0; i < size * size; i++) {
    const a = up.data[i * 4 + 3] / 255;
    if (a === 0) continue;
    // upstream's macOS shadow is at most 13% opaque and stays its own; the body's anti-aliased
    // edge (the rounded corners, 15% opaque and up) takes the backdrop in proportion
    const k = Math.min(1, Math.max(0, (a - 0.15) / 0.35));
    for (let c = 0; c < 3; c++) {
      const u = up.data[i * 4 + c];
      out.data[i * 4 + c] = Math.round(u + (Math.max(u, back.data[i * 4 + c]) - u) * k);
    }
  }
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  c.getContext("2d").putImageData(out, 0, 0);
  return c.toDataURL("image/png");
}
