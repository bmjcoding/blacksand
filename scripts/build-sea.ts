// Builds blacksand as one executable for this machine (a Node single executable
// application): node scripts/build-sea.ts [--node PATH]
//
// 1. esbuild bundles src/main.ts into one ESM file, dist/blacksand.mjs. Only
//    this repository's code goes in: a bundle that would include anything from
//    node_modules is refused, so the build-only bundler adds no runtime code.
// 2. `node --build-sea` copies the Node it runs as and embeds the bundle, with
//    the three files sandboxFile reads from substrates/kubernetes/sandbox/ as
//    assets (`sandbox/NAME`), by name: nothing else in that folder goes in.
//    No snapshot or code cache; execArgvExtension "none", so NODE_OPTIONS
//    can't load code into it.
// 3. On macOS, signs it ad hoc (codesign --sign -), which an arm64 Mac needs
//    before it runs anything; a release signs with its own identity instead.
// 4. Runs it from outside the repository: help answers, and verify refuses
//    (a single binary has nothing to verify against until init exists).
//
// --node: the Node to embed (default: the one running this). Its bytes must be
// the official NODE_VERSION build for this platform (NODE_SHA256), checked
// before it first runs; Homebrew's is another build, without single executable
// support. ESBUILD_BINARY_PATH is refused: it would swap the lockfile's esbuild
// binary for any program.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const SANDBOX = path.join(ROOT, "substrates", "kubernetes", "sandbox");
/** The Node every binary embeds: bumped on purpose, never whatever is installed. */
const NODE_VERSION = "v26.13.0";
/**
 * SHA-256 of bin/node in the official NODE_VERSION archive, by platform; a
 * platform not here isn't built until its digest is added. Adding or bumping
 * one, once, by hand: download node-VERSION-PLATFORM.tar.xz, SHASUMS256.txt and
 * SHASUMS256.txt.sig from https://nodejs.org/dist/VERSION/; check the signature
 * (gpgv --keyring KEYRING SHASUMS256.txt.sig SHASUMS256.txt) with a key whose
 * full fingerprint is in that version's README.md "Release keys" list
 * (v26.13.0 was signed by C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C); check the
 * archive's line in SHASUMS256.txt (shasum -a 256 -c --ignore-missing); then
 * pin `tar -xOf ARCHIVE node-VERSION-PLATFORM/bin/node | shasum -a 256`.
 */
const NODE_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4",
};
/** What goes in from substrates/kubernetes/sandbox/: the files sandboxFile reads, and nothing else. */
const ASSETS = ["fake-agent.ts", "proxy.ts", "steps.sh"];

function fail(text: string): never {
  console.error(`build-sea: ${text}`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

// Before esbuild loads: it reads ESBUILD_BINARY_PATH as it's imported.
if (process.env.ESBUILD_BINARY_PATH) fail("ESBUILD_BINARY_PATH is set: unset it, so the build runs the esbuild binary package-lock.json pins");
const { values } = parseArgs({ options: { node: { type: "string", default: process.execPath } } });
const node = path.resolve(values.node);
const platform = `${process.platform}-${process.arch}`;
const pinned = NODE_SHA256[platform];
if (!pinned) fail(`no official Node ${NODE_VERSION} digest is pinned for ${platform}: add one to NODE_SHA256 (it says how)`);
// Its bytes before it runs at all: a different program can print any version.
const digest = createHash("sha256").update(fs.readFileSync(node)).digest("hex");
if (digest !== pinned) fail(`${node} isn't the official Node ${NODE_VERSION} for ${platform} (SHA-256 ${digest}, not ${pinned})`);
const version = run(node, ["--version"]).trim();
if (version !== NODE_VERSION) fail(`${node} is Node ${version}, not ${NODE_VERSION}`);

// Paths relative to ROOT (where --build-sea runs): the blob records them as given, so absolute ones
// would put this checkout's path in every binary, and make two checkouts' builds differ.
const assets = Object.fromEntries(
  ASSETS.map((name) => {
    const file = path.join(SANDBOX, name);
    if (!fs.lstatSync(file).isFile()) fail(`${file} isn't a regular file (a link, say): only the file itself goes in`);
    return [`sandbox/${name}`, path.relative(ROOT, file)];
  }),
);

const started = performance.now();
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
const bundle = path.join(DIST, "blacksand.mjs");
const { build } = await import("esbuild");
const bundled = await build({ absWorkingDir: ROOT, entryPoints: [path.join(ROOT, "src", "main.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node26", metafile: true, logLevel: "warning" });
const outside = Object.keys(bundled.metafile.inputs).filter((file) => file.includes("node_modules"));
if (outside.length) fail(`the bundle would include code from node_modules: ${outside.join(", ")}`);

const exe = path.join(DIST, "blacksand");
const config = { main: path.relative(ROOT, bundle), mainFormat: "module", output: path.relative(ROOT, exe), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: "none", assets };
fs.writeFileSync(path.join(DIST, "sea.json"), `${JSON.stringify(config, null, 2)}\n`);
const sea = spawnSync(node, ["--build-sea", path.join(DIST, "sea.json")], { cwd: ROOT, encoding: "utf8" });
if (sea.status !== 0) fail(`${node} can't build a single executable${/disabled/.test(sea.stderr) ? " (it was built without support: use the official build from nodejs.org)" : ""}:\n${sea.stderr}`);
if (process.platform === "darwin") run("/usr/bin/codesign", ["--sign", "-", "--force", exe]);
const ms = Math.round(performance.now() - started);

// From a folder outside the repository, so nothing is found beside it by accident.
const away = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-sea-"));
const call = (...args: string[]) => spawnSync(exe, args, { cwd: away, encoding: "utf8" });
const [help, verify] = [call("--json", "help"), call("--json", "verify")];
fs.rmSync(away, { recursive: true, force: true });
if (help.status !== 0 || !help.stdout.includes('"schema": "blacksand.help/1"')) fail(`${exe} --json help didn't answer:\n${help.stdout}${help.stderr}`);
if (verify.status !== 4 || !verify.stdout.includes('"code": "verify/no-anchor"')) fail(`${exe} verify didn't refuse:\n${verify.stdout}${verify.stderr}`);
console.log(`${path.relative(ROOT, exe)}: ${(fs.statSync(exe).size / 1e6).toFixed(1)} MB, Node ${version}, built in ${(ms / 1000).toFixed(1)} s; help answers and verify refuses from outside the repository`);
