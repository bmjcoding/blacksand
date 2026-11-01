// CI (.github/workflows/build.yml): which pinned channels to build. A change to
// pin.json alone builds the channels whose pin changed (all of them when what it
// approves for every channel, its device tools, changed); any other change, or a
// base that can't be read, builds every pinned channel. Never fewer than changed.
// Usage (in packages/t3): node ci/build-channels.mjs [base commit]   prints a JSON list

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { isMain } from "./is-main.mjs";

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The channels of `pin` to build, sorted. `basePin`: pin.json before the change
 * (null: unknown, or there was none); `changedFiles`: the paths the change
 * touched (null: unknown).
 */
export function channelsToBuild({ pin, basePin, changedFiles }) {
  const all = Object.keys(pin?.channels ?? {}).sort();
  if (!basePin || !Array.isArray(changedFiles) || changedFiles.some((file) => file !== "pin.json")) return all;
  const keys = new Set([...Object.keys(pin), ...Object.keys(basePin)]);
  keys.delete("channels");
  if ([...keys].some((key) => !same(pin[key], basePin[key]))) return all;
  return all.filter((channel) => !same(pin.channels[channel], basePin.channels?.[channel]));
}

const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout : null;
};

if (isMain(import.meta.url)) {
  const base = process.argv[2] ?? "";
  const pin = JSON.parse(fs.readFileSync("pin.json", "utf8"));
  let basePin = null;
  let changedFiles = null;
  if (/^[0-9a-f]{40}$/.test(base) && !/^0+$/.test(base)) {
    // ./pin.json: this package's, read from where it's run.
    const text = git(["show", `${base}:./pin.json`]);
    try {
      basePin = text === null ? null : JSON.parse(text);
    } catch {
      basePin = null;
    }
    // Relative to here, as pin.json is: anything outside the package starts with ../ and never passes for it.
    const here = git(["rev-parse", "--show-prefix"])?.trim();
    const files = here === undefined ? null : git(["diff", "--name-only", base, "HEAD"])?.split("\n").filter(Boolean);
    changedFiles = files?.map((file) => path.posix.relative(here || ".", file)) ?? null;
  }
  console.log(JSON.stringify(channelsToBuild({ pin, basePin, changedFiles })));
}
