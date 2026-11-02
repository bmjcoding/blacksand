// Opt-in: large immutable upstream binaries, supplied as data, never executed.
// BLACKSAND_T3_NATIVE_SCAN_CACHE layout: docs/building/native-scan-contexts.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fetchPackage, npmMeta, reviewDeviceTool, scanPackage } from "../lib/gates.mjs";
import { lockEntry, reviewToolClosure, verifyToolLock } from "../lib/device-tools.mjs";

const cache = process.env.BLACKSAND_T3_NATIVE_SCAN_CACHE;
const entries = JSON.parse(fs.readFileSync(new URL("../lib/native-scan-contexts.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-03T00:00:00Z");
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const digest = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const summary = (scan) => ({ hosts: [...scan.hosts].sort(), analytics: [...scan.analytics].sort() });

test("retained native bytes: exact classification and real fetch/review refusal boundaries", { skip: !cache }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-native-contexts-"));
  const originalFetch = globalThis.fetch;
  const routes = new Map();
  const fetched = new Map();
  const root = "native-context-tool@1.0.0";
  const rootName = "native-context-tool";
  const old = "2026-10-01T00:00:00Z";
  const isKnownHost = (host) => host === "github.com";
  try {
    const quiet = path.join(work, "quiet");
    fs.mkdirSync(path.join(quiet, "package"), { recursive: true });
    fs.writeFileSync(path.join(quiet, "package/index.js"), "export const quiet = true;");
    const tgz = path.join(quiet, "package.tgz");
    assert.equal(spawnSync("tar", ["-czf", tgz, "-C", quiet, "package"]).status, 0);
    const quietBytes = fs.readFileSync(tgz);
    const packages = { "": { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [rootName]: "1.0.0" } } };
    const deps = Object.fromEntries(entries.map((e) => [e.name, e.version]));
    const rootUrl = `https://registry.npmjs.org/${rootName}/-/${rootName}-1.0.0.tgz`;
    packages[`node_modules/${rootName}`] = { version: "1.0.0", resolved: rootUrl, integrity: digest(quietBytes) };
    routes.set(`https://registry.npmjs.org/${rootName}`, () => json({ versions: { "1.0.0": { dependencies: deps, dist: { tarball: rootUrl, integrity: digest(quietBytes) } } }, time: { "1.0.0": old } }));
    for (const entry of entries) {
      const dir = path.join(cache, `${entry.name.replace("/", "__")}@${entry.version}`);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "packument.json"), "utf8"));
      const info = meta.versions[entry.version];
      const bytes = fs.readFileSync(path.join(dir, "package.tgz"));
      assert.equal(digest(bytes), entry.integrity);
      const previousUrl = info.dist.tarball.replace("0.33.6.tgz", "0.33.5.tgz");
      meta.versions["0.33.5"] = { dist: { tarball: previousUrl, integrity: digest(quietBytes) } };
      meta.time["0.33.5"] = old;
      routes.set(`https://registry.npmjs.org/${entry.name.replace("/", "%2f")}`, () => json(meta));
      routes.set(info.dist.tarball, () => new Response(bytes));
      routes.set(previousUrl, () => new Response(quietBytes));
      packages[`node_modules/${entry.name}`] = { version: entry.version, resolved: info.dist.tarball, integrity: entry.integrity };
    }
    globalThis.fetch = async (url) => {
      const route = routes.get(String(url));
      assert.ok(route, `unexpected network request: ${url}`);
      return route();
    };
    const lock = lockEntry(JSON.stringify({ lockfileVersion: 3, packages }));
    const opts = { lock, now, minDays: 3, isKnownHost };

    for (const [i, entry] of entries.entries()) await t.test(entry.name, async () => {
      const pkg = await fetchPackage(entry.name, entry.version, path.join(work, `native-${i}`));
      fetched.set(entry.name, pkg);
      assert.deepEqual(pkg.identity, { name: entry.name, version: entry.version, integrity: entry.integrity });
      assert.ok(Object.isFrozen(pkg.identity));
      const raw = scanPackage(pkg.dir);
      const corrected = scanPackage(pkg.dir, pkg.identity);
      assert.deepEqual(summary(corrected), { hosts: ["github.com"], analytics: [] });
      assert.ok(raw.analytics.has("sentry"));
      for (const host of Object.keys(entry.matches).filter((m) => m !== "sentry")) assert.ok(raw.hosts.has(host));
      const member = fs.readFileSync(path.join(pkg.dir, entry.path));
      assert.equal(createHash("sha256").update(member).digest("hex"), entry.sha256);
      if (entry.name.includes("win32")) {
        assert.equal(entry.matches.sentry.length, 1);
        assert.ok(member.toString("latin1").includes("%*sEntry %0d:"));
      }
      const review = await reviewDeviceTool(`${entry.name}@${entry.version}`, `${entry.name}@0.33.5`, { now, minDays: 3, isKnownHost });
      assert.equal(review.ok, true, review.reasons.join("; "));
      console.log(JSON.stringify({ probe: "exact-native", package: entry.name, sha256: entry.sha256, raw: summary(raw), corrected: summary(corrected), review }));
    });

    await t.test("production closure fetch and scanner", async () => {
      const review = await reviewToolClosure(root, null, opts);
      assert.equal(review.ok, true, review.reasons.join("; "));
      console.log(JSON.stringify({ probe: "real-closure", ok: review.ok, reasons: review.reasons, notes: review.notes, lockSha256: review.lock.sha256 }));
    });

    const entry = entries.find((e) => e.name === "@node-datachannel/linux-x64-gnu");
    const pkg = fetched.get(entry.name);
    const file = path.join(pkg.dir, entry.path);
    const bytes = fs.readFileSync(file);
    const reusedFetch = async (name) => fetched.get(name);
    await t.test("missing or wrong name/version/SRI/path/full-file identity retains detections", async () => {
      for (const identity of [undefined, {}, { ...pkg.identity, name: "other" }, { ...pkg.identity, version: "0.33.7" }, { ...pkg.identity, integrity: "sha512-substituted" }]) {
        const found = scanPackage(pkg.dir, identity);
        assert.ok(found.analytics.has("sentry")); assert.ok(found.hosts.has("gcc.gnu.org"));
        const held = await reviewToolClosure(root, null, { ...opts, fetch: async (name) => name === entry.name ? { ...pkg, identity } : fetched.get(name) });
        assert.equal(held.ok, false);
        assert.match(held.reasons.join(), /new analytics names: sentry/);
        assert.match(held.reasons.join(), /new network hosts: gcc\.gnu\.org/);
      }
      const moved = path.join(pkg.dir, "moved.node");
      fs.renameSync(file, moved);
      assert.ok(scanPackage(pkg.dir, pkg.identity).analytics.has("sentry"));
      assert.equal((await reviewToolClosure(root, null, { ...opts, fetch: reusedFetch })).ok, false);
      fs.renameSync(moved, file);
      for (const changed of [Buffer.concat([bytes, Buffer.from("\0sentry_init sentry_capture_event mixpanel https://unknown.example.org/events\0")]), Buffer.from(bytes)]) {
        if (changed.length === bytes.length) changed[0] ^= 1;
        fs.writeFileSync(file, changed);
        assert.ok(scanPackage(pkg.dir, pkg.identity).analytics.has("sentry"));
        assert.ok(scanPackage(pkg.dir, pkg.identity).hosts.has("gcc.gnu.org"));
        if (changed.length !== bytes.length) {
          const found = scanPackage(pkg.dir, pkg.identity);
          assert.ok(found.analytics.has("mixpanel")); assert.ok(found.hosts.has("unknown.example.org"));
        }
        assert.equal((await reviewToolClosure(root, null, { ...opts, fetch: reusedFetch })).ok, false);
      }
      fs.writeFileSync(file, bytes);
    });
    await t.test("exact native classification never waives provenance or own-package age", async () => {
      const meta = await npmMeta(entry.name);
      meta.versions["0.33.5"].dist.attestations = { url: "https://registry.npmjs.org/recorded-predecessor" };
      const review = await reviewDeviceTool(`${entry.name}@${entry.version}`, `${entry.name}@0.33.5`, { now, minDays: 3, isKnownHost });
      assert.equal(review.ok, false); assert.match(review.reasons.join(), /no npm provenance/);
      delete meta.versions["0.33.5"].dist.attestations;
      const at = meta.time[entry.version];
      for (const time of [undefined, "2026-11-02T23:00:00Z"]) {
        meta.time[entry.version] = time;
        const held = await reviewDeviceTool(`${entry.name}@${entry.version}`, `${entry.name}@0.33.5`, { now, minDays: 3, isKnownHost });
        assert.equal(held.ok, false); assert.match(held.reasons.join(), /under 3 days ago/);
      }
      meta.time[entry.version] = at;
    });
    await t.test("extra shipped JS remains a hold through real closure review", async () => {
      const probes = [
        ["sentry", "import * as Sentry from '@sentry/node'; Sentry.init({dsn:'https://ingest.example.org/1'});"],
        ["gcc.gnu.org", "fetch('https://gcc.gnu.org/real-request');"],
        ["android.googlesource.com", "fetch('https://android.googlesource.com/real-request');"],
        ["mixpanel", "mixpanel.init('key'); fetch('https://unknown.example.org/events');"],
      ];
      for (const [finding, text] of probes) {
        const target = finding === "android.googlesource.com" ? fetched.get("@node-datachannel/android-arm64") : pkg;
        const extra = path.join(target.dir, "client.js");
        fs.writeFileSync(extra, text);
        const review = await reviewToolClosure(root, null, { ...opts, fetch: reusedFetch });
        assert.equal(review.ok, false);
        assert.ok(review.reasons.join().includes(finding), review.reasons.join());
        console.log(JSON.stringify({ probe: "extra-js", finding, reasons: review.reasons }));
        fs.rmSync(extra);
      }
    });
    await t.test("lock SHA/URL/SRI and unknown/young age remain refusals", async () => {
      await assert.rejects(verifyToolLock(root, { ...lock, sha256: "0".repeat(64) }, { now }), /sha256/);
      for (const field of ["integrity", "resolved"]) {
        const changed = structuredClone(packages);
        changed[`node_modules/${entry.name}`][field] += "changed";
        await assert.rejects(verifyToolLock(root, lockEntry(JSON.stringify({ lockfileVersion: 3, packages: changed })), { now }), /isn't npm's|isn't a registry package/);
      }
      const meta = await npmMeta(entry.name);
      const at = meta.time[entry.version];
      for (const time of [undefined, "2026-11-02T23:00:00Z"]) {
        meta.time[entry.version] = time;
        const held = await reviewToolClosure(root, null, opts);
        assert.equal(held.ok, false);
        assert.match(held.reasons.join(), /no publish time|under 3 days/);
      }
      meta.time[entry.version] = at;
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(work, { recursive: true, force: true });
  }
});
