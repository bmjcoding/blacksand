// node --test test/: device tools install with scripts off; the native files a package's
// install script would have fetched come from lib/native-assets.json instead: a reviewed
// archive, its SHA-256 and each listed file's. The app's installer (lib/files/
// blackoutNativeAssets.ts) is exercised for real (node -e, as DeviceToolchain.ts runs it)
// against a local HTTP server, and keeps every write inside the install folder on its own:
// whatever package path the lock gives and whatever file path the manifest lists, it writes
// only to a plain node_modules package path, through real folders, never through a link.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { approvedToolLock } from "../lib/device-tools.mjs";
import { nativeAssetsFor, readNativeAssets, validateNativeAssets } from "../lib/native-assets.mjs";
import { BLACKOUT_NATIVE_ASSETS_SCRIPT, BLACKOUT_NATIVE_ASSETS_SOURCE } from "../lib/files/blackoutNativeAssets.ts";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t3b-native-${name}-`)));
const HEX = "a".repeat(64);
const BINARY = Buffer.from("native binary\u0000\u0001");
const asset = (extra = {}) => ({ platform: "darwin", arch: "arm64", url: "https://example.org/x.tar.gz", sha256: HEX, files: { "build/Release/x.node": HEX }, ...extra });
const manifest = (packages) => ({ version: 1, packages });

test("lib/native-assets.json is exactly its shape: reviewed archives, plain paths inside the package, hashes", () => {
  assert.ok(readNativeAssets().packages["node-datachannel@0.32.3"]);
  const valid = manifest({ "native@1.0.0": { why: "its prebuild", assets: [asset()] } });
  assert.equal(validateNativeAssets(valid), valid);
  const invalid = (packages) => assert.throws(() => validateNativeAssets(manifest(packages)), /native-assets\.json is invalid/);
  invalid({ "native@1.0.0": { why: "", assets: [] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ url: "http://example.org/x.tar.gz" })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ sha256: "ABC" })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ files: { "../../etc/x": HEX } })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ files: { "/abs/x.node": HEX } })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ files: {} })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset(), asset()] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ platform: "plan9" })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [{ ...asset(), extra: 1 }] } });
});

/** A package-lock.json with an install-script package at `node_modules/<name>`. */
const scriptedLock = (...pkgs) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, ...Object.fromEntries(pkgs.map((pkg) => [`node_modules/${pkg.slice(0, pkg.lastIndexOf("@"))}`, { version: pkg.slice(pkg.lastIndexOf("@") + 1), hasInstallScript: true }])) },
  });

test("a package with an install script must be listed: its archives, or none with why; else the owner is told what to add", () => {
  const listed = manifest({ "native@1.0.0": { why: "prebuild", assets: [asset(), asset({ platform: "linux", arch: "x64" })] }, "noop@2.0.0": { why: "prints a banner", assets: [] } });
  const { needs, assets } = nativeAssetsFor(scriptedLock("native@1.0.0", "noop@2.0.0"), listed);
  assert.deepEqual(needs, [{ path: "node_modules/native", package: "native@1.0.0" }]);
  assert.deepEqual(assets.map((a) => `${a.path} ${a.platform}-${a.arch}`), ["node_modules/native darwin-arm64", "node_modules/native linux-x64"]);
  assert.throws(() => nativeAssetsFor(scriptedLock("native@1.0.1"), listed, "tool@1.0.0"), /tool@1\.0\.0's dependencies native@1\.0\.1 have install scripts.*lib\/native-assets\.json/);
});

test("today's pinned device tools are covered: node-datachannel@0.32.3's prebuilds for darwin-arm64 and linux-x64", () => {
  const pin = JSON.parse(fs.readFileSync(new URL("../pin.json", import.meta.url), "utf8"));
  const lib = readNativeAssets();
  for (const tool of pin.deviceTools) nativeAssetsFor(approvedToolLock(tool, pin), lib, tool);
  const hub = pin.deviceTools.find((tool) => tool.startsWith("expo-device-hub@"));
  const { needs, assets } = nativeAssetsFor(approvedToolLock(hub, pin), lib, hub);
  assert.deepEqual(needs, [{ path: "node_modules/node-datachannel", package: "node-datachannel@0.32.3" }]);
  assert.deepEqual(assets.map((a) => `${a.platform}-${a.arch}`).sort(), ["darwin-arm64", "linux-x64"]);
  for (const a of assets) assert.match(a.url, /^https:\/\/github\.com\/murat-dogan\/node-datachannel\/releases\/download\/v0\.32\.3\/node-datachannel-v0\.32\.3-napi-v8-/);
});

// ------------------------------------------------------- the app's installer --

/** A .tar.gz of `files` ({ path: content }), made with the system tar. */
function tarball(files) {
  const dir = scratch("src");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const out = `${dir}.tar.gz`;
  const made = spawnSync("tar", ["-czf", out, "-C", dir, ...Object.keys(files)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const bytes = fs.readFileSync(out);
  fs.rmSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Serves `routes` ({ "/path": bytes }) on 127.0.0.1, counting requests; resolves { base, url, hits, close }. */
async function serve(routes) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    const body = routes[req.url];
    res.writeHead(body ? 200 : 404).end(body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/x.tar.gz`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** This machine's platform key as the installer computes it. */
const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "linuxmusl" : process.platform;

/** Runs node with `args` without blocking this process (the test's HTTP server answers it); resolves { status, stderr }. */
function node(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

/** Runs the app's installer (node -e, as DeviceToolchain.ts does) on `dir`. */
const install = (dir, assets, needs) => node(["-e", BLACKOUT_NATIVE_ASSETS_SCRIPT, dir, JSON.stringify(assets), JSON.stringify(needs)]);

/** Installs native@1.0.0 at lock path `where` from `url`, its archive `archive` and listed `files`. */
const installAt = (dir, where, url, archive, files = { "build/Release/x.node": sha256(BINARY) }) =>
  install(dir, [{ path: where, package: "native@1.0.0", platform, arch: process.arch, url, sha256: sha256(archive), files }], [{ path: where, package: "native@1.0.0" }]);

/** A scratch parent with the install folder `dir` in it, and every file found under the parent afterwards. */
function installFolder() {
  const parent = scratch("parent");
  const dir = path.join(parent, "install");
  fs.mkdirSync(path.join(dir, "node_modules", "native"), { recursive: true });
  const files = () => {
    const found = [];
    const walk = (at) => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(path.relative(parent, full) + (entry.isSymbolicLink() ? " (link)" : ""));
      }
    };
    walk(parent);
    return found.sort();
  };
  return { parent, dir, files };
}

test("the app downloads the reviewed archive, checks both hashes, and writes only the listed files where the package expects them", { timeout: 60_000 }, async () => {
  const longName = `build/Release/${"deep/".repeat(22)}x.node`;
  const archive = tarball({ "build/Release/x.node": BINARY, "build/Release/extra.sh": "echo planted", [longName]: "long" });
  const tampered = tarball({ "build/Release/x.node": "something else" });
  const server = await serve({ "/x.tar.gz": archive, "/tampered.tar.gz": tampered });
  try {
    const dir = scratch("dir");
    const needs = [{ path: "node_modules/native", package: "native@1.0.0" }];
    const here = { ...needs[0], platform, arch: process.arch, url: server.url, sha256: sha256(archive), files: { "build/Release/x.node": sha256(BINARY), [longName]: sha256("long") } };
    const done = await install(dir, [here], needs);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, "node_modules/native/build/Release/x.node")), BINARY);
    assert.equal(fs.readFileSync(path.join(dir, "node_modules/native", longName), "utf8"), "long");
    assert.equal(fs.existsSync(path.join(dir, "node_modules/native/build/Release/extra.sh")), false);

    // The archive isn't the reviewed one: nothing is written.
    const other = scratch("dir");
    const swapped = await install(other, [{ ...here, url: `${server.base}/tampered.tar.gz` }], needs);
    assert.notEqual(swapped.status, 0);
    assert.match(swapped.stderr, /doesn't match the SHA-256 reviewed for it/);
    assert.equal(fs.existsSync(path.join(other, "node_modules")), false);
    // The archive is, but a listed file inside it isn't what was reviewed.
    const wrongFile = await install(other, [{ ...here, files: { "build/Release/x.node": HEX } }], needs);
    assert.match(wrongFile.stderr, /has no build\/Release\/x\.node matching the SHA-256 reviewed for it/);
    // No reviewed archive for this platform: the install fails, saying so.
    const elsewhere = await install(other, [{ ...here, arch: process.arch === "arm64" ? "x64" : "arm64" }], needs);
    assert.match(elsewhere.stderr, new RegExp(`no reviewed native files of native@1\\.0\\.0 for ${platform}-${process.arch}`));
    // Nothing needed, nothing fetched.
    assert.equal((await install(other, [], [])).status, 0);
  } finally {
    await server.close();
  }
});

test("the SSH device host script embeds the same installer as a plain function", { timeout: 60_000 }, async () => {
  const archive = tarball({ "build/Release/x.node": BINARY });
  const server = await serve({ "/x.tar.gz": archive });
  try {
    const dir = scratch("ssh");
    const needs = [{ path: "node_modules/native", package: "native@1.0.0" }];
    const assets = [{ ...needs[0], platform, arch: process.arch, url: server.url, sha256: sha256(archive), files: { "build/Release/x.node": sha256(BINARY) } }];
    // As sshDeviceScript.ts puts it into the remote script's text.
    const script = `const installNativeAssets = ${BLACKOUT_NATIVE_ASSETS_SOURCE};\n(async () => { await installNativeAssets(${JSON.stringify(dir)}, ${JSON.stringify(assets)}, ${JSON.stringify(needs)}); })().catch((error) => { console.error(error.message); process.exitCode = 1; });`;
    const run = await node(["-e", script]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, "node_modules/native/build/Release/x.node")), BINARY);
  } finally {
    await server.close();
  }
});

test("a lock path that isn't a plain node_modules package path, or a listed file with .., writes nothing anywhere and fetches nothing", { timeout: 60_000 }, async () => {
  const archive = tarball({ "build/Release/x.node": BINARY });
  const server = await serve({ "/x.tar.gz": archive });
  try {
    const { dir, files } = installFolder();
    const refused = [
      "node_modules/../../escaped",
      "node_modules/native/../../../escaped",
      "/tmp/escaped",
      "escaped",
      "node_modules",
      "node_modules/.bin",
      "node_modules/@scope/../escaped",
      "node_modules/native//x",
      "node_modules/native/build",
      "node_modules/..\\..\\escaped",
    ].map((where) => [where, installAt(dir, where, server.url, archive)]);
    refused.push(["../../escaped.node listed", installAt(dir, "node_modules/native", server.url, archive, { "../../escaped.node": sha256(BINARY) })]);
    for (const [where, running] of refused) {
      const done = await running;
      assert.notEqual(done.status, 0, where);
      assert.match(done.stderr, /refuses to write native files/, where);
    }
    assert.equal(server.state.hits, 0);
    assert.deepEqual(files(), []);
    // Plain, scoped and nested package paths are fine.
    for (const where of ["node_modules/native", "node_modules/@scope/native", "node_modules/a/node_modules/@s/b"]) {
      const done = await installAt(dir, where, server.url, archive);
      assert.equal(done.status, 0, `${where}: ${done.stderr}`);
      assert.deepEqual(fs.readFileSync(path.join(dir, where, "build/Release/x.node")), BINARY);
    }
  } finally {
    await server.close();
  }
});

test("a link anywhere on the way out of the install folder is refused, and one at the file is replaced, not followed", { timeout: 60_000 }, async () => {
  const archive = tarball({ "build/Release/x.node": BINARY });
  const server = await serve({ "/x.tar.gz": archive });
  try {
    // The package folder is a link to a folder outside.
    const a = installFolder();
    fs.mkdirSync(path.join(a.parent, "outside"));
    fs.rmSync(path.join(a.dir, "node_modules", "native"), { recursive: true });
    fs.symlinkSync(path.join(a.parent, "outside"), path.join(a.dir, "node_modules", "native"));
    let done = await installAt(a.dir, "node_modules/native", server.url, archive);
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /refuses to write native files to .*node_modules\/native \(a link or a file\)/);
    assert.deepEqual(fs.readdirSync(path.join(a.parent, "outside")), []);
    // A folder below the package is a link outside.
    const b = installFolder();
    fs.mkdirSync(path.join(b.parent, "outside"));
    fs.symlinkSync(path.join(b.parent, "outside"), path.join(b.dir, "node_modules", "native", "build"));
    done = await installAt(b.dir, "node_modules/native", server.url, archive);
    assert.notEqual(done.status, 0);
    assert.deepEqual(fs.readdirSync(path.join(b.parent, "outside")), []);
    // The file itself is a link to a file outside: replaced by the reviewed file, the outside file untouched.
    const c = installFolder();
    fs.writeFileSync(path.join(c.parent, "victim"), "untouched");
    fs.mkdirSync(path.join(c.dir, "node_modules", "native", "build", "Release"), { recursive: true });
    fs.symlinkSync(path.join(c.parent, "victim"), path.join(c.dir, "node_modules", "native", "build", "Release", "x.node"));
    done = await installAt(c.dir, "node_modules/native", server.url, archive);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(fs.readFileSync(path.join(c.parent, "victim"), "utf8"), "untouched");
    assert.equal(fs.lstatSync(path.join(c.dir, "node_modules", "native", "build", "Release", "x.node")).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(path.join(c.dir, "node_modules", "native", "build", "Release", "x.node")), BINARY);
    assert.deepEqual(c.files(), ["install/node_modules/native/build/Release/x.node", "victim"]);
    // The install folder reached through a link (as /tmp is on macOS) is fine: only what's below it counts.
    const d = installFolder();
    fs.symlinkSync(d.dir, path.join(d.parent, "via-link"));
    done = await installAt(path.join(d.parent, "via-link"), "node_modules/native", server.url, archive);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(fs.readFileSync(path.join(d.dir, "node_modules", "native", "build", "Release", "x.node")), BINARY);
  } finally {
    await server.close();
  }
});
