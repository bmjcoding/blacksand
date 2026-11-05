// Recorded public registry/advisory responses; no package code is executed.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { beforeEach, test } from "node:test";
import { completeAdvisories, scanAdvisories } from "../lib/advisories.mjs";
import { publisherContinuity } from "../lib/fastlane.mjs";
import { dependencyAgeGate } from "../lib/gates.mjs";
import { checkedResolvedLock } from "../lib/inventory.mjs";
import { applyOverrides, overrideYamlLines, readOverrides } from "../lib/overrides.mjs";
import { checkResolution } from "../lib/resolution.mjs";
import { compareVersions } from "../lib/semver.mjs";

const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/advisories/node-forge-1.4.3.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-05T00:00:00Z");
const repoUrl = "https://api.github.com/repos/digitalbazaar/forge/security-advisories?state=published&per_page=100";
const meta = async (name) => name === "node-forge" ? recorded.metadata : null;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const newIds = ["GHSA-3cc4-3294-vgjf", "GHSA-6cv4-p8m7-4r25", "GHSA-j8rw-jp99-435v", "GHSA-w4xr-hqv8-ch44", "GHSA-6889-vf6x-f3g5"].sort();

// Each test intercepts every request, including the age gate's npm lookups.
function recordedFetch(input, init = {}) {
  const url = String(input);
  if (url === "https://registry.npmjs.org/node-forge") return json(recorded.metadata);
  if (url === "https://api.osv.dev/v1/querybatch") return json({ results: JSON.parse(init.body).queries.map((query) => {
    const index = recorded.osvQuery.queries.findIndex((q) => JSON.stringify(q) === JSON.stringify(query));
    assert.notEqual(index, -1, `unrecorded OSV query: ${JSON.stringify(query)}`);
    return recorded.osvBatch.results[index];
  }) });
  if (url.startsWith("https://api.osv.dev/v1/vulns/")) {
    const record = recorded.osv.find((r) => url.endsWith(r.id));
    assert.ok(record, `unrecorded OSV advisory: ${url}`);
    return json(record);
  }
  if (url.startsWith("https://api.github.com/advisories?")) return json(url.includes("type=malware") ? recorded.databaseMalware : recorded.database);
  if (url === repoUrl) return json(recorded.repository);
  throw new Error(`unexpected HTTP request: ${url}`);
}
beforeEach((t) => t.mock.method(globalThis, "fetch", recordedFetch));

test("Forge's complete sources cover all 22 vulnerabilities, dedupe aliases, and clear only 1.4.3", async (t) => {
  const scan = await scanAdvisories(["node-forge@1.4.0"], { meta });
  const all = completeAdvisories(scan);
  assert.equal(all.filter((a) => a.severity === "HIGH").length, 9);
  assert.equal(all.length, 22, "the existing eight, five new reports, and nine lower-rated reports");
  const forge = readOverrides().find((o) => o.selector === "node-forge@1.4.0");
  assert.deepEqual(all.map((a) => a.id).sort(), [...forge.advisories].sort(), "the override names every merged advisory, at every severity");
  for (const advisory of all) {
    assert.ok(advisory.packages[0].fixed.some((v) => compareVersions(v, "1.4.3") <= 0), `${advisory.id} is fixed by 1.4.3`);
  }
  for (const id of ["GHSA-6qrw-m8cv-hcxf", "GHSA-rhr8-3pm8-cq29", ...newIds]) {
    const report = all.find((a) => a.id === id);
    assert.deepEqual(report.sources, ["github-repository"]);
    assert.deepEqual(report.packages[0].curatedFixed, []);
    assert.deepEqual(report.packages[0].fixed, [newIds.includes(id) ? "1.4.3" : "1.4.1"]);
  }
  const nested = all.filter((a) => [a.id, ...a.aliases].includes("GHSA-2g46-22mc-6gwp"));
  assert.equal(nested.length, 1);
  assert.equal(nested[0].id, "GHSA-86w9-cpqp-85rv");
  assert.deepEqual(nested[0].packages[0].fixed, ["1.4.1"]);
  assert.deepEqual(nested[0].packages[0].curatedFixed, [], "maintainer metadata never becomes a curated fix");
  for (const version of ["1.4.1", "1.4.2"]) {
    const vulnerable = await scanAdvisories([`node-forge@${version}`], { meta });
    assert.deepEqual(completeAdvisories(vulnerable).map((a) => a.id).sort(), newIds, `${version} still has all five new advisories`);
  }
  const fixed = await scanAdvisories(["node-forge@1.4.3"], { meta });
  assert.deepEqual(completeAdvisories(fixed), []);
  assert.deepEqual(fixed.sources[2].repositories, ["digitalbazaar/forge"]);
  assert.equal(fixed.sources[2].packages, 1);
  assert.ok(globalThis.fetch.mock.calls.some(({ arguments: [url] }) => url === repoUrl), "Forge's own reports are read without a caller adding watch");
  assert.deepEqual(await publisherContinuity("node-forge", "1.4.3", { accepted: ["1.4.0", "1.4.1"], now }), { ok: true, summary: "publisher davidlehn, no provenance (none before either)" });
  t.mock.method(globalThis, "fetch", (url, init) => String(url) === repoUrl ? json({}, 404) : recordedFetch(url, init));
  const gapped = await scanAdvisories(["node-forge@1.4.3"], { meta });
  assert.throws(() => completeAdvisories(gapped), /coverage is incomplete/);
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
  assert.equal(forge.version, "1.4.3");
  assert.equal(forge.advisories.length, 22);
  assert.match(overrideYamlLines([forge]), /node-forge@>=1\.0\.0 <1\.4\.3/);
  assert.deepEqual(applyOverrides(["node-forge@1.4.0", "node-forge@1.4.1", "node-forge@1.4.2", "uuid@7.0.3", "zod@3.25.76"]), ["node-forge@1.4.3", "uuid@7.0.3", "zod@3.25.76"]);
  const upstreamLock = forgeLock("1.4.0");
  const resolvedLock = forgeLock("1.4.3");
  const good = await checkedResolvedLock({ upstreamLock, resolvedLock, overrides: [forge] }, { meta });
  assert.deepEqual(good.problems, []);
  assert.ok(good.packages.includes("node-forge@1.4.3"));
  assert.ok(!good.packages.includes("node-forge@1.4.0"));
  const bad = await checkedResolvedLock({ upstreamLock, resolvedLock: upstreamLock, overrides: [forge] }, { meta });
  assert.match(bad.problems.join(), /overridden versions: node-forge@1\.4\.0/);
});

test("the owner override admits exactly young Forge 1.4.3 while preserving the age and integrity gates", async () => {
  const forge = readOverrides().find((o) => o.selector === "node-forge@1.4.0");
  const upstreamLock = forgeLock("1.4.0");
  const resolvedLock = forgeLock("1.4.3");
  const gate = (base, next) => dependencyAgeGate(base, next, { minDays: 3, now });
  const raw = await gate(upstreamLock, resolvedLock);
  assert.equal(raw.ok, false, "1.4.3 is still under three days old");
  assert.deepEqual(raw.young, [{ pkg: "node-forge@1.4.3", publishedAt: "2026-11-04T01:06:47.014Z" }]);
  assert.deepEqual([raw.unknown, raw.substituted, raw.waived], [[], [], []]);
  const accepted = await checkResolution(upstreamLock, resolvedLock, { overrides: [forge], gate });
  assert.ok(accepted.packages.has("node-forge@1.4.3"));
  assert.deepEqual(accepted.added, [], "the owner chose this exact fix");
  await assert.rejects(checkResolution(upstreamLock, resolvedLock, { overrides: [], gate }), /under 3 days old/);
  await assert.rejects(checkResolution(upstreamLock, resolvedLock, { overrides: [{ ...forge, version: "1.4.2" }], gate }), /node-forge@1\.4\.3/);
  const wrongBytes = resolvedLock.replace(recorded.metadata.versions["1.4.3"].dist.integrity, "sha512-Zml4dHVyZQ==");
  await assert.rejects(checkResolution(upstreamLock, wrongBytes, { overrides: [forge], gate }), /not the registry's bytes/);
});
