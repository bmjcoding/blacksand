// node --test test/: device tools' dependency closures (lib/device-tools.mjs). A tool's
// closure is kept in pin.json as an exact package-lock.json, checked on its bytes against
// npm and never resolved again at build time. Every package in it is the registry's own
// tarball, old enough, in a plain node_modules folder where npm's own resolution from the
// tool down puts what each package's registry manifest asks for (names, `npm:` aliases,
// ranges), and nothing else is in it: a lock can't put another package at the tool's path
// and the tool in a decoy folder. Which packages need native files is read from the
// packages themselves, not the lock's flags. Offline: npm's metadata and tarballs are
// stand-ins.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { NPM_FALLBACK, checkToolClosure, closurePackages, deviceToolLocks, installScriptPackages, lockEntry, reviewToolClosure, verifyToolLock } from "../lib/device-tools.mjs";
import { reviewAddedDeviceTools } from "../lib/gates.mjs";
import { nativeAssetsFor } from "../lib/native-assets.mjs";
import { makeRules } from "../lib/rules.mjs";

const REG = "https://registry.npmjs.org/";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const OLD = "2026-10-01T00:00:00.000Z";
const NO_ASSETS = { version: 1, packages: {} };
const tarball = (name, version) => `${REG}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
const integrity = (pkg) => `sha512-${createHash("sha512").update(pkg).digest("base64")}`;
const split = (pkg) => [pkg.slice(0, pkg.lastIndexOf("@")), pkg.slice(pkg.lastIndexOf("@") + 1)];

/**
 * A package-lock.json (v3) for `tool` (name@version). `folders` maps each node_modules
 * folder to the name@version in it (one named for another package is an alias);
 * `extra` adds entry fields per folder.
 */
function lockText(tool, folders, extra = {}) {
  const [name, version] = split(tool);
  const packages = { "": { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [name]: version } } };
  for (const [folder, pkg] of Object.entries(folders)) {
    const [n, v] = split(pkg);
    const own = folder.slice(folder.lastIndexOf("node_modules/") + "node_modules/".length);
    packages[folder] = { ...(n === own ? {} : { name: n }), version: v, resolved: tarball(n, v), integrity: integrity(pkg), ...extra[folder] };
  }
  return `${JSON.stringify({ name: "t3blackout-device-tool", version: "0.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}
/** Each package at the top of node_modules. */
const flat = (...pkgs) => Object.fromEntries(pkgs.map((pkg) => [`node_modules/${split(pkg)[0]}`, pkg]));

/**
 * npm metadata as the registry would send it for `manifests` ({ "name@version": its
 * dependencies and the like }): each published OLD unless `time` says otherwise, and
 * `dist` changed per package.
 */
const registry = (manifests, { time = {}, dist = {} } = {}) => async (name) => {
  const versions = {};
  const times = {};
  for (const [pkg, manifest] of Object.entries(manifests)) {
    const [n, version] = split(pkg);
    if (n !== name) continue;
    versions[version] = { ...manifest, dist: { tarball: tarball(n, version), integrity: integrity(pkg), ...dist[pkg] } };
    times[version] = time[pkg] ?? OLD;
  }
  return Object.keys(versions).length ? { versions, time: times } : null;
};
/** tool@1.0.0, depending on each of `deps` (any version). */
const toolNeeding = (...deps) => ({ "tool@1.0.0": { dependencies: Object.fromEntries(deps.map((dep) => [dep, "*"])) } });

/** Stand-in tarballs: `files` per name@version under package/ (else a plain package.json). */
const fetchFrom = (files = {}) => async (name, version, into) => {
  const dir = path.join(into, "package");
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files[`${name}@${version}`] ?? { "package.json": JSON.stringify({ name, version }) })) fs.writeFileSync(path.join(dir, file), content);
  return { dir };
};

test("a closure must be the registry's own tarballs with integrity hashes, inside node_modules", () => {
  assert.deepEqual([...closurePackages(lockText("tool@1.0.0", flat("tool@1.0.0", "@s/helper@1.0.1"))).keys()], ["tool@1.0.0", "@s/helper@1.0.1"]);
  for (const extra of [{ resolved: "https://evil.example.org/tool.tgz" }, { resolved: `${REG}tool/-/tool-6.6.6.tgz` }, { integrity: undefined }, { link: true }]) {
    assert.throws(() => closurePackages(lockText("tool@1.0.0", flat("tool@1.0.0"), { "node_modules/tool": extra })), /isn't a registry package/, JSON.stringify(extra));
  }
  assert.throws(() => closurePackages(lockText("tool@1.0.0", { ...flat("tool@1.0.0"), "../elsewhere/node_modules/tool": "tool@1.0.0" })), /outside its node_modules/);
});

test("a kept lock is checked on its exact bytes against npm, never resolved again", async () => {
  const text = lockText("tool@1.0.0", flat("tool@1.0.0", "helper@1.0.0"));
  const entry = lockEntry(text);
  const published = { ...toolNeeding("helper"), "helper@1.0.0": {} };
  const meta = registry(published);
  assert.deepEqual((await verifyToolLock("tool@1.0.0", entry, { now: NOW, meta })).packages, ["helper@1.0.0", "tool@1.0.0"]);
  // Bytes that don't match the recorded SHA-256.
  await assert.rejects(verifyToolLock("tool@1.0.0", { ...entry, lock: text.replace("1.0.0", "1.0.1") }, { now: NOW, meta }), /doesn't match its sha256/);
  // A lock for something else, or with more at its root.
  await assert.rejects(verifyToolLock("tool@2.0.0", entry, { now: NOW, meta }), /isn't for tool@2\.0\.0 alone/);
  const extraRoot = JSON.parse(text);
  extraRoot.packages[""].dependencies.evil = "1.0.0";
  await assert.rejects(verifyToolLock("tool@1.0.0", lockEntry(JSON.stringify(extraRoot)), { now: NOW, meta }), /isn't for tool@1\.0\.0 alone/);
  // The registry publishes different bytes for that version, or it's young, undated or gone.
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry(published, { dist: { "helper@1.0.0": { integrity: "sha512-BBBB" } } }) }), /helper@1\.0\.0 \(its tarball or integrity isn't npm's\)/);
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry(published, { time: { "helper@1.0.0": "2026-10-29T00:00:00.000Z" } }) }), /helper@1\.0\.0 \(published 2026-10-29.*under 3 days/);
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry(published, { time: { "helper@1.0.0": "soon" } }) }), /helper@1\.0\.0 \(no publish time/);
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry(toolNeeding("helper")) }), /helper@1\.0\.0 \(not on npm\)/);
  // A lock without the tool in it.
  await assert.rejects(verifyToolLock("tool@1.0.0", lockEntry(lockText("tool@1.0.0", flat("helper@1.0.0"))), { now: NOW, meta }), /doesn't contain tool@1\.0\.0/);
});

test("the build bakes the kept bytes even when the registry would now resolve something else, and stops without them", async () => {
  const kept = lockText("tool@1.0.0", flat("tool@1.0.0", "helper@1.0.0"));
  const pinJson = { deviceToolLocks: { "tool@1.0.0": lockEntry(kept) } };
  // helper@1.1.0 exists now (a moved dist-tag would pick it up on a fresh resolution); the build doesn't resolve.
  const opts = { nativeAssets: NO_ASSETS, now: NOW, meta: registry({ ...toolNeeding("helper"), "helper@1.0.0": {}, "helper@1.1.0": {} }), fetch: fetchFrom() };
  const locks = await deviceToolLocks(["tool@1.0.0"], { ...opts, pinJson });
  assert.equal(locks["tool@1.0.0"].lock, kept);
  assert.match(locks["tool@1.0.0"].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(locks["tool@1.0.0"].manifest), { name: "t3blackout-device-tool", version: "0.0.0", private: true, dependencies: { tool: "1.0.0" } });
  // No kept lock: the build stops, saying what to do.
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { ...opts, pinJson: { deviceToolLocks: {} } }), /no reviewed dependency lockfile for device tool tool@1\.0\.0/);
  // A tampered kept lock.
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { ...opts, pinJson: { deviceToolLocks: { "tool@1.0.0": { sha256: "0".repeat(64), lock: kept } } } }), /doesn't match its sha256/);
});

test("install scripts are read from the packages, not the lock's flags; one the native-assets manifest doesn't cover holds the build", async () => {
  const manifests = { "tool@1.0.0": { dependencies: { native: "^2.0.0", gyp: "1.0.0", plain: "1.0.0", nogyp: "1.0.0" } }, "native@2.0.0": {}, "gyp@1.0.0": {}, "plain@1.0.0": {}, "nogyp@1.0.0": {} };
  const fetch = fetchFrom({
    "native@2.0.0": { "package.json": JSON.stringify({ name: "native", scripts: { install: "prebuild-install || cmake-js rebuild" } }) },
    "gyp@1.0.0": { "package.json": JSON.stringify({ name: "gyp" }), "binding.gyp": "{}" },
    "nogyp@1.0.0": { "package.json": JSON.stringify({ name: "nogyp", gypfile: false }), "binding.gyp": "{}" },
  });
  const folders = flat("tool@1.0.0", "native@2.0.0", "gyp@1.0.0", "plain@1.0.0", "nogyp@1.0.0");
  // No hasInstallScript flags at all in this lock.
  const entry = lockEntry(lockText("tool@1.0.0", folders));
  assert.deepEqual(await installScriptPackages(entry.lock, { fetch }), [
    { path: "node_modules/native", package: "native@2.0.0" },
    { path: "node_modules/gyp", package: "gyp@1.0.0" },
  ]);
  const opts = { pinJson: { deviceToolLocks: { "tool@1.0.0": entry } }, now: NOW, meta: registry(manifests), fetch };
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { ...opts, nativeAssets: NO_ASSETS }), /dependencies native@2\.0\.0, gyp@1\.0\.0 have install scripts.*lib\/native-assets\.json/);
  const asset = { platform: "darwin", arch: "arm64", url: "https://example.org/native.tar.gz", sha256: "a".repeat(64), files: { "build/Release/native.node": "b".repeat(64) } };
  const listed = { version: 1, packages: { "native@2.0.0": { why: "prebuilds", assets: [asset] }, "gyp@1.0.0": { why: "builds nothing the tool uses", assets: [] } } };
  const built = await deviceToolLocks(["tool@1.0.0"], { ...opts, nativeAssets: listed });
  assert.deepEqual(built["tool@1.0.0"].needs, [{ path: "node_modules/native", package: "native@2.0.0" }]);
  // A lock flag still adds to what the packages say; it can't take anything away.
  const flagged = lockEntry(lockText("tool@1.0.0", folders, { "node_modules/plain": { hasInstallScript: true } }));
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { ...opts, pinJson: { deviceToolLocks: { "tool@1.0.0": flagged } }, nativeAssets: listed }), /dependencies plain@1\.0\.0 have install scripts/);
});

const verify = (tool, folders, manifests) => verifyToolLock(tool, lockEntry(lockText(tool, folders)), { now: NOW, meta: registry(manifests) });

test("another package at the tool's path, the tool in a decoy folder, is refused", async () => {
  const manifests = { "is-number@1.0.0": {}, "is-positive@1.0.0": {} };
  await assert.rejects(
    verify("is-number@1.0.0", { "node_modules/is-number": "is-positive@1.0.0", "node_modules/decoy": "is-number@1.0.0" }, manifests),
    /doesn't install as npm resolves is-number@1\.0\.0: it doesn't contain is-number@1\.0\.0 as the package npm installs for it/,
  );
  // The honest lock passes.
  assert.deepEqual((await verify("is-number@1.0.0", { "node_modules/is-number": "is-number@1.0.0" }, manifests)).packages, ["is-number@1.0.0"]);
  // A package nothing asks for is a decoy too, even beside the real tool.
  await assert.rejects(verify("is-number@1.0.0", { "node_modules/is-number": "is-number@1.0.0", "node_modules/decoy": "is-positive@1.0.0" }, manifests), /node_modules\/decoy \(is-positive@1\.0\.0\) is nothing npm installs from is-number@1\.0\.0/);
});

test("each dependency's folder holds the package asked for, aliases and nesting as npm resolves them", async () => {
  const manifests = {
    "tool@1.0.0": { dependencies: { a: "^1.0.0", b: "1.0.0", helper: "npm:real-helper@^2.0.0" }, optionalDependencies: { "fsevents-like": "^1.0.0" }, peerDependencies: { ai: ">=6" }, peerDependenciesMeta: { ai: { optional: true } } },
    "a@1.0.0": {},
    "a@2.0.0": {},
    "b@1.0.0": { dependencies: { a: "^2.0.0" } },
    "real-helper@2.1.0": {},
    "evil@1.0.0": {},
  };
  const honest = { "node_modules/tool": "tool@1.0.0", "node_modules/a": "a@1.0.0", "node_modules/b": "b@1.0.0", "node_modules/b/node_modules/a": "a@2.0.0", "node_modules/helper": "real-helper@2.1.0" };
  assert.deepEqual((await verify("tool@1.0.0", honest, manifests)).packages, ["a@1.0.0", "a@2.0.0", "b@1.0.0", "real-helper@2.1.0", "tool@1.0.0"]);
  // b's own a@2 left out: Node would find the top-level a@1, which b doesn't ask for.
  const { "node_modules/b/node_modules/a": _, ...hoisted } = honest;
  await assert.rejects(verify("tool@1.0.0", { ...hoisted, "node_modules/a-two": "a@2.0.0" }, manifests), /node_modules\/a holds a@1\.0\.0, but b@1\.0\.0 asks for a@\^2\.0\.0/);
  // A dependency's folder holding another package (an alias npm wasn't asked for), or a version out of range.
  await assert.rejects(verify("tool@1.0.0", { ...honest, "node_modules/a": "evil@1.0.0" }, manifests), /node_modules\/a holds evil@1\.0\.0, but tool@1\.0\.0 asks for a@\^1\.0\.0/);
  await assert.rejects(verify("tool@1.0.0", { ...honest, "node_modules/helper": "evil@1.0.0" }, manifests), /node_modules\/helper holds evil@1\.0\.0, but tool@1\.0\.0 asks for helper@npm:real-helper@\^2\.0\.0/);
  await assert.rejects(verify("tool@1.0.0", { ...honest, "node_modules/a": "a@2.0.0", "node_modules/b/node_modules/a": "a@2.0.0" }, manifests), /node_modules\/a holds a@2\.0\.0, but tool@1\.0\.0 asks for a@\^1\.0\.0/);
  // A dependency it needs that isn't there; an optional one may be missing (another platform's).
  const { "node_modules/b": __, "node_modules/b/node_modules/a": ___, ...withoutB } = honest;
  await assert.rejects(verify("tool@1.0.0", withoutB, manifests), /tool@1\.0\.0 needs b@1\.0\.0, which isn't where npm looks from node_modules\/tool/);
});

test("a lock folder outside node_modules, or with odd parts, is refused before anything else, in the lock and the native-asset list", async () => {
  const manifests = { "tool@1.0.0": {}, "node-datachannel@0.32.3": {} };
  for (const folder of ["node_modules/../../escaped", "node_modules/tool/../../x", "node_modules/@s/../x", "/node_modules/x", "node_modules/.bin", "node_modules/tool/node_modules"]) {
    await assert.rejects(verify("tool@1.0.0", { "node_modules/tool": "tool@1.0.0", [folder]: "node-datachannel@0.32.3" }, manifests), /outside its node_modules, or isn't a plain package folder there/, folder);
  }
  const manifest = { version: 1, packages: { "node-datachannel@0.32.3": { why: "test", assets: [] } } };
  assert.throws(() => nativeAssetsFor([{ path: "node_modules/../../escaped", package: "node-datachannel@0.32.3" }], manifest, "tool@1.0.0"), /puts node-datachannel@0\.32\.3 at node_modules\/\.\.\/\.\.\/escaped, which isn't a plain folder/);
  const flagged = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/../../escaped": { name: "node-datachannel", version: "0.32.3", hasInstallScript: true } } });
  assert.throws(() => nativeAssetsFor(flagged, manifest, "tool@1.0.0"), /isn't a plain folder inside its node_modules/);
});

test("a proposed closure is resolved as of the tool's publish time, then checked like a kept one", async () => {
  let asked = null;
  const resolve = (pin, { before }) => {
    asked = before;
    return { manifest: "{}", lock: lockText("tool@1.0.0", flat("tool@1.0.0", "helper@1.0.1")) };
  };
  const published = async () => "2026-10-20T00:00:00.000Z";
  const manifests = { ...toolNeeding("helper"), "helper@1.0.1": {} };
  const young = registry(manifests, { time: { "helper@1.0.1": "2026-10-29T00:00:00.000Z" } });
  await assert.rejects(checkToolClosure("tool@1.0.0", { resolve, publishedAt: published, now: NOW, verify: (pin, entry, opts) => verifyToolLock(pin, entry, { ...opts, meta: young }) }), /helper@1\.0\.1 \(published 2026-10-29/);
  assert.equal(asked, "2026-10-20T00:00:00.000Z");
  const meta = registry(manifests);
  const ok = await checkToolClosure("tool@1.0.0", { resolve, publishedAt: published, now: NOW, verify: (pin, entry, opts) => verifyToolLock(pin, entry, { ...opts, meta }) });
  assert.deepEqual(ok.packages, ["helper@1.0.1", "tool@1.0.0"]);
  assert.equal(ok.entry.sha256, createHash("sha256").update(ok.entry.lock).digest("hex"));
});

/** Stand-in package fetch and scan: what each package version reaches. */
function scanner(scans) {
  const fetch = async (name, version, into) => {
    fs.mkdirSync(into, { recursive: true });
    return { dir: `${name}@${version}` };
  };
  const scan = (dir) => ({ hosts: new Set(scans[dir] ?? []), analytics: new Set(dir === "fresh@1.0.0" ? ["posthog"] : []) });
  return { fetch, scan };
}
const isKnownHost = (host) => ["github.com", "registry.npmjs.org"].includes(host);

test("a dependency the previous kept lock didn't have is scanned like the tool; registry trouble holds it", async () => {
  const next = lockEntry(lockText("tool@2.0.0", flat("tool@2.0.0", "helper@1.1.0", "fresh@1.0.0")));
  const previous = lockEntry(lockText("tool@1.0.0", flat("tool@1.0.0", "helper@1.0.0")));
  const verify = async (pin, entry) => ({ pin, packages: [...closurePackages(entry.lock).keys()].sort() });
  const { fetch, scan } = scanner({ "helper@1.0.0": ["github.com"], "helper@1.1.0": ["github.com", "collector.evil.example.org"], "fresh@1.0.0": ["registry.npmjs.org"] });
  const check = async () => {
    throw new Error("a kept lock must not be resolved again");
  };
  const review = await reviewToolClosure("tool@2.0.0", "tool@1.0.0", { isKnownHost, lock: next, previousLock: previous, check, verify, fetch, scan });
  assert.equal(review.ok, false);
  assert.deepEqual(review.reasons, ["dependency fresh@1.0.0: new analytics names: posthog", "dependency helper@1.1.0: new network hosts: collector.evil.example.org"]);
  assert.equal(review.lock, next);
  // Without a kept previous lock nothing counts as reviewed: helper@1.1.0 is compared with nothing.
  const fresh = await reviewToolClosure("tool@2.0.0", "tool@1.0.0", { isKnownHost, lock: next, check, verify, fetch, scan });
  assert.ok(fresh.reasons.includes("dependency helper@1.1.0: new network hosts: collector.evil.example.org"));
  const failing = await reviewToolClosure("tool@2.0.0", "tool@1.0.0", { isKnownHost, verify: async () => { throw new Error("npm is down"); }, lock: next });
  assert.deepEqual(failing, { ok: false, pin: "tool@2.0.0", reasons: ["npm is down"], notes: [], lock: null });
});

test("an added tool needs a kept lock; a newly kept lock is reviewed; a lock added alongside is no baseline", async () => {
  const seen = [];
  const closure = async (tool, previous, opts) => {
    seen.push({ tool, previous, lock: opts.lock ?? null, previousLock: opts.previousLock ?? null });
    return { ok: true, reasons: [], lock: opts.lock ?? { sha256: "proposed" } };
  };
  const review = async () => ({ ok: true, reasons: [] });
  // Offline: the newest reviewed version by its version number, not npm's publish times.
  const latest = async (name, reviewed) => [...reviewed].filter((t) => t.startsWith(`${name}@`)).sort().at(-1) ?? null;
  const a = lockEntry(lockText("tool@1.0.0", flat("tool@1.0.0")));
  const b = lockEntry(lockText("tool@2.0.0", flat("tool@2.0.0")));
  // An added tool with no kept lock fails; nothing is resolved for it.
  const missing = await reviewAddedDeviceTools(["tool@1.0.0"], ["tool@1.0.0", "tool@2.0.0"], { isKnownHost, closure, review, latest, locks: { "tool@1.0.0": a }, previousLocks: { "tool@1.0.0": a } });
  assert.deepEqual(missing.map(({ tool, ok }) => ({ tool, ok })), [{ tool: "tool@2.0.0", ok: false }]);
  assert.match(missing[0].reasons[0], /keeps no reviewed dependency lockfile for tool@2\.0\.0/);
  assert.equal(seen.length, 0);
  // With one: reviewed against the previous version's kept lock.
  const added = await reviewAddedDeviceTools(["tool@1.0.0"], ["tool@1.0.0", "tool@2.0.0"], { isKnownHost, closure, review, latest, locks: { "tool@1.0.0": a, "tool@2.0.0": b }, previousLocks: { "tool@1.0.0": a } });
  assert.equal(added[0].ok, true);
  assert.deepEqual(seen.at(-1), { tool: "tool@2.0.0", previous: "tool@1.0.0", lock: b, previousLock: a });
  // A tool reviewed by hand gets its first kept lock: its closure is reviewed; the baseline lock added in the same pin doesn't count.
  seen.length = 0;
  const relocked = await reviewAddedDeviceTools([], [], { knownDeviceTools: ["tool@1.0.0", "tool@2.0.0"], isKnownHost, closure, review, latest, locks: { "tool@1.0.0": a, "tool@2.0.0": b }, previousLocks: {} });
  assert.deepEqual(relocked.map(({ tool }) => tool), ["tool@1.0.0", "tool@2.0.0"]);
  assert.ok(seen.every(({ previousLock }) => previousLock === null));
  // Proposing (the evaluate job): no kept locks, the result carries the lock to keep.
  const proposed = await reviewAddedDeviceTools(["tool@1.0.0"], ["tool@1.0.0", "tool@2.0.0"], { isKnownHost, closure, review, latest, previousLocks: { "tool@1.0.0": a } });
  assert.deepEqual(proposed[0].lock, { sha256: "proposed" });
  assert.deepEqual(seen.at(-1).previousLock, a);
});

test("the app installs device tools from the kept closures, with npm ci and no install scripts, and the npm fallback is exact", () => {
  const locks = { "agent-device@0.21.31": { manifest: '{"dependencies":{"agent-device":"0.21.31"}}', lock: "{}", digest: "d".repeat(64), needs: [], assets: [] } };
  const rules = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: { version: "1", sha: "a".repeat(40), changes: null, skipped: [], driftReport: null, deviceToolLocks: locks } });
  const local = rules.find((rule) => rule.id === "server/device-tools-frozen");
  const ssh = rules.find((rule) => rule.id === "server/device-tools-frozen-ssh");
  const replaced = (rule) => rule.edits.map((edit) => edit.replace).join("\n");
  assert.match(replaced(local), /BLACKOUT_DEVICE_TOOL_LOCKS[^=]*= \{"agent-device@0\.21\.31"/);
  assert.match(replaced(local), /\["ci", "--ignore-scripts", "--no-fund", "--no-audit"\]/);
  assert.match(replaced(local), new RegExp(`--package=${NPM_FALLBACK}`));
  assert.doesNotMatch(replaced(local), /npm@11"/);
  assert.match(replaced(ssh), /run\('npm', \['ci', '--ignore-scripts'/);
  assert.match(NPM_FALLBACK, /^npm@\d+\.\d+\.\d+$/);
  // A dry run (no build) installs nothing.
  const dry = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((rule) => rule.id === "server/device-tools-frozen");
  assert.match(replaced(dry), /= \{\};/);
});
