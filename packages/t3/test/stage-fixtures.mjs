// Shared by the staged-install tests: a stage folder with a fake vp, the lockfiles it
// resolves, and a way to run the guard quietly.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findOnPath, guardedInstall } from "../lib/stage-install.mjs";


export const scratch = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t3b-stage-${name}-`)));

/** A pnpm 9.0 lockfile (as pnpm 12 writes it) with `packages` (name@version) as direct dependencies. */
export function lockfile(packages) {
  const split = (pkg) => [pkg.slice(0, pkg.lastIndexOf("@")), pkg.slice(pkg.lastIndexOf("@") + 1)];
  const quote = (key) => (key.startsWith("@") ? `'${key}'` : key);
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    ...packages.flatMap((pkg) => [`      ${quote(split(pkg)[0])}:`, `        specifier: ${split(pkg)[1]}`, `        version: ${split(pkg)[1]}`]),
    "",
    "packages:",
    "",
    ...packages.flatMap((pkg) => [`  ${quote(pkg)}:`, "    resolution: {integrity: sha512-AAAA}", ""]),
    "snapshots:",
    "",
    ...packages.flatMap((pkg) => [`  ${quote(pkg)}: {}`, ""]),
  ].join("\n");
}

/**
 * A stage folder in a build's temp folder, with a fake vp: its lockfile-only resolution
 * writes `resolved`, its frozen install lays `installed` out as pnpm does. It records its
 * calls. The verified lockfile it's checked against has is-number@7.0.0.
 */
export function fakeStage(resolved = lockfile(["is-number@7.0.0"]), installed = { "is-number": "7.0.0" }) {
  const root = scratch("root");
  const app = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), '{"name":"t3blackout","dependencies":{"is-number":"^7.0.0"}}\n');
  fs.writeFileSync(path.join(app, "pnpm-workspace.yaml"), "supportedArchitectures:\n  os:\n    - darwin\n");
  const vp = path.join(root, "real-vp.cjs");
  fs.writeFileSync(
    vp,
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.log"))}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.includes("--lockfile-only")) fs.writeFileSync("pnpm-lock.yaml", ${JSON.stringify(resolved)});
else {
  for (const [name, version] of Object.entries(${JSON.stringify(installed)})) {
    const store = "node_modules/.pnpm/" + name + "@" + version + "/node_modules/" + name;
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(store + "/package.json", JSON.stringify({ name, version }));
    fs.writeFileSync(store + "/index.js", "module.exports = (n) => typeof n === 'number';\\n");
    fs.symlinkSync(".pnpm/" + name + "@" + version + "/node_modules/" + name, "node_modules/" + name);
  }
  fs.writeFileSync("node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.0'");
}`,
  );
  const real = path.join(root, "vp");
  fs.writeFileSync(real, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(vp)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "verified.yaml"), lockfile(["is-number@7.0.0"]));
  const env = {
    PATH: process.env.PATH,
    T3BLACKOUT_REAL_VP: real,
    T3BLACKOUT_REAL_NPM: findOnPath("npm", process.env.PATH, "/nonexistent") ?? "",
    T3BLACKOUT_SHIM_DIR: path.join(root, "shims"),
    T3BLACKOUT_STAGE_ROOT: root,
    T3BLACKOUT_VERIFIED_LOCK: path.join(root, "verified.yaml"),
    T3BLACKOUT_STAGE_RECORD: path.join(root, "record.jsonl"),
  };
  const calls = () => fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n");
  // Runs the guard on `dir` (the app folder by default), quietly: it reports what it checked.
  const install = (dir = app, options = env) => quietly(() => guardedInstall(dir, options, { installer: () => real }));
  return { root, app, env, calls, install, stages: { tmpdir: root } };
}

/** Runs `step` with console.log and console.error quiet. */
export async function quietly(step) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await step();
  } finally {
    Object.assign(console, { log, error });
  }
}
