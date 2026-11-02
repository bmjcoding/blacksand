// Recorded public registry/advisory responses; no package code is executed.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { completeAdvisories, scanAdvisories } from "../lib/advisories.mjs";
import { publisherContinuity } from "../lib/fastlane.mjs";
import { dependencyAgeGate } from "../lib/gates.mjs";
import { checkedResolvedLock } from "../lib/inventory.mjs";
import { applyOverrides, overrideYamlLines, readOverrides } from "../lib/overrides.mjs";

const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/advisories/node-forge-1.4.1.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-03T00:00:00Z");
const repoUrl = "https://api.github.com/repos/digitalbazaar/forge/security-advisories?state=published&per_page=100";
const meta = async (name) => name === "node-forge" ? recorded.metadata : null;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("Forge's complete sources retain eight high vulnerabilities, dedupe nested-Digest aliases, and clear 1.4.1", async () => {
  const original = globalThis.fetch;
  let missingRepo = false;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url); calls.push(url);
    if (url === "https://registry.npmjs.org/node-forge") return json(recorded.metadata);
    if (url === "https://api.osv.dev/v1/querybatch") return json({ results: JSON.parse(init.body).queries.map((q) => q.version === "1.4.0" ? { vulns: recorded.osv.map((r) => ({ id: r.id })) } : {}) });
    if (url.startsWith("https://api.osv.dev/v1/vulns/")) return json(recorded.osv.find((r) => url.endsWith(r.id)));
    if (url.startsWith("https://api.github.com/advisories?")) return json(url.includes("type=malware") ? [] : recorded.database);
    if (url === repoUrl) return json(missingRepo ? {} : recorded.repository, missingRepo ? 404 : 200);
    throw new Error(`unexpected HTTP request: ${url}`);
  };
  try {
    const scan = await scanAdvisories(["node-forge@1.4.0"], { meta });
    assert.deepEqual(scan.gaps, []);
    assert.equal(scan.advisories.filter((a) => a.severity === "HIGH").length, 8);
    assert.equal(scan.advisories.length, 17, "lower-rated maintainer reports remain visible too");
    for (const id of ["GHSA-6qrw-m8cv-hcxf", "GHSA-rhr8-3pm8-cq29"]) {
      const report = scan.advisories.find((a) => a.id === id);
      assert.deepEqual(report.sources, ["github-repository"]);
      assert.deepEqual(report.packages[0].curatedFixed, []);
      assert.deepEqual(report.packages[0].fixed, ["1.4.1"]);
    }
    const nested = scan.advisories.filter((a) => [a.id, ...a.aliases].includes("GHSA-2g46-22mc-6gwp"));
    assert.equal(nested.length, 1);
    assert.equal(nested[0].id, "GHSA-86w9-cpqp-85rv");
    assert.deepEqual(nested[0].packages[0].fixed, ["1.4.1"]);
    assert.deepEqual(nested[0].packages[0].curatedFixed, [], "maintainer metadata never becomes a curated fix");
    const fixed = await scanAdvisories(["node-forge@1.4.1"], { meta });
    assert.deepEqual(completeAdvisories(fixed), []);
    assert.deepEqual(fixed.sources[2].repositories, ["digitalbazaar/forge"]);
    assert.equal(fixed.sources[2].packages, 1);
    assert.ok(calls.includes(repoUrl), "Forge's own reports are read without a caller adding watch");
    assert.deepEqual(await publisherContinuity("node-forge", "1.4.1", { accepted: ["1.4.0"], now }), { ok: true, summary: "publisher davidlehn, no provenance (none before either)" });
    missingRepo = true;
    const gapped = await scanAdvisories(["node-forge@1.4.1"], { meta });
    assert.throws(() => completeAdvisories(gapped), /coverage is incomplete/);
  } finally { globalThis.fetch = original; }
});

const forgeLock = (version) => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@expo/code-signing-certificates': {specifier: 0.0.7, version: 0.0.7}
packages:
  '@expo/code-signing-certificates@0.0.7': {resolution: {integrity: sha512-Zml4dHVyZQ==}}
  node-forge@${version}: {resolution: {integrity: ${recorded.metadata.versions[version].dist.integrity}}}
snapshots:
  '@expo/code-signing-certificates@0.0.7':
    dependencies:
      node-forge: ${version}
  node-forge@${version}: {}
`;

test("same-major Forge override resolves structurally, refuses retained 1.4.0, and leaves UUID/Zod majors visible", async () => {
  const forge = readOverrides().find((o) => o.selector === "node-forge@1.4.0");
  assert.equal(forge.version, "1.4.1");
  assert.equal(forge.advisories.length, 8);
  assert.match(overrideYamlLines([forge]), /node-forge@>=1\.0\.0 <1\.4\.1/);
  assert.deepEqual(applyOverrides(["node-forge@1.4.0", "uuid@7.0.3", "zod@3.25.76"]), ["node-forge@1.4.1", "uuid@7.0.3", "zod@3.25.76"]);
  const upstreamLock = forgeLock("1.4.0");
  const resolvedLock = forgeLock("1.4.1");
  const good = await checkedResolvedLock({ upstreamLock, resolvedLock, overrides: [forge] }, { meta });
  assert.deepEqual(good.problems, []);
  assert.ok(good.packages.includes("node-forge@1.4.1"));
  assert.ok(!good.packages.includes("node-forge@1.4.0"));
  const bad = await checkedResolvedLock({ upstreamLock, resolvedLock: upstreamLock, overrides: [forge] }, { meta });
  assert.match(bad.problems.join(), /overridden versions: node-forge@1\.4\.0/);
  assert.equal((await dependencyAgeGate(upstreamLock, resolvedLock, { now })).ok, true);
});
