// Draws the icon backdrop (lib/icon-backdrop.mjs: night sky, dune, blacksand logo)
// behind the T3 of upstream's flat PNG icons, making the lib/files/backdrop-*.png the
// build installs (rules desktop/app-icon-*). Rerun it when upstream changes those
// icons or the backdrop changes. Any platform with Chrome or Chromium:
//
//   node scripts/backdrop-icons.mjs <upstream checkout at the pin> lib/files
//
// CHROME=<path> picks the browser; otherwise lib/looks.mjs finds one.
//
// "Behind" without upstream's layers: inside the icon's body each pixel becomes the
// lighter of upstream's pixel and the backdrop's. Upstream's T3 is near-white on
// black and the backdrop is dark grey, so the T3 stays whole and in front, and the
// backdrop shows only where upstream is black. The body is upstream's opaque area
// pulled in by 6 pixels (per 1024), so the glass rim and shadow stay upstream's.
// The macOS icon's body is inset 100 of 1024 pixels on each side, for its shadow;
// the others fill the image.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BACKDROP_FLAT_SVG } from "../lib/icon-backdrop.mjs";
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
  const backdrop = `data:image/svg+xml;base64,${Buffer.from(BACKDROP_FLAT_SVG).toString("base64")}`;
  for (const icon of ICONS) {
    const base = `data:image/png;base64,${fs.readFileSync(path.join(checkout, icon.from)).toString("base64")}`;
    const png = await evaluate(`(${compose})(${JSON.stringify(base)}, ${JSON.stringify(backdrop)}, ${icon.inset})`);
    fs.writeFileSync(path.join(outDir, icon.to), Buffer.from(png.split(",")[1], "base64"));
    console.log(icon.to);
  }
} finally {
  await chrome.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// Runs in the page: returns the composed PNG as a data URL.
async function compose(baseUrl, backdropUrl, inset) {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`can't load ${src.slice(0, 40)}`));
    image.src = src;
  });
  const [base, backdrop] = await Promise.all([load(baseUrl), load(backdropUrl)]);
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
    ctx.drawImage(backdrop, size * inset, size * inset, body, body);
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
