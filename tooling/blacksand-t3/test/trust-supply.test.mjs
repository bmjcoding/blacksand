// node --test test/: the evaluator's network-facing gates against a mocked npm,
// OSV and release index: bounded fetches, dependency ages, device-tool re-review,
// the security fast lane's publisher, provenance and 0.x rules (unverified npm
// provenance never earns trust: a registry can claim anything in it), and OSV
// paging and severity. Every gate fails closed: what it can't read holds the update.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as advisories from "../lib/advisories.mjs";
import { findAdvisories, fixedVersions, isAlerting, severityOf } from "../lib/advisories.mjs";
import { electronSecurityReason, makeFastLane, publisherContinuity, repoOf, runtimeAdvisories } from "../lib/fastlane.mjs";
import { dependencyAgeGate, fetchPackage, reviewAddedDeviceTools, reviewDeviceTool, scanPackage } from "../lib/gates.mjs";
import { request } from "../lib/http.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Routes fetch to `handlers` (url -> (init) => Response); anything else is a 404. Returns the calls made. */
function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = handlers[String(url)];
    return handler ? handler(init, calls.length) : new Response("not found", { status: 404 });
  };
  return calls;
}

const registry = (name) => `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
/** GitHub Advisory Database routes answering "none" for `pkgs` (lib/advisories.mjs asks once by default, once for malware). */
const noGithubAdvisories = (...pkgs) =>
  Object.fromEntries(["", "&type=malware"].map((type) => [`https://api.github.com/advisories?ecosystem=npm&per_page=100${type}&affects=${pkgs.map(encodeURIComponent).join(",")}`, () => json([])]));

/** A gzipped npm tarball of `files` (under package/) and its sha512 integrity. */
function tarball(files, top = "package") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-tgz-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, top, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, top, name), content);
  }
  const out = path.join(dir, "out.tgz");
  assert.equal(spawnSync("tar", ["-czf", out, "-C", dir, top]).status, 0);
  const bytes = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

// ------------------------------------------------------------------ fetch --

test("verified fetch scans npm's sole top folder even when it isn't named package", async () => {
  const { bytes, integrity } = tarball({ "index.js": "fetch('https://unreviewed.example.org/events'); sentry_init();" }, "types-entry");
  const url = "https://registry.npmjs.org/trust-top-folder/-/trust-top-folder-1.0.0.tgz";
  const badUrl = url.replace("1.0.0.tgz", "1.0.1.tgz");
  mockFetch({
    [registry("trust-top-folder")]: () => json({ versions: { "1.0.0": { dist: { tarball: url, integrity } }, "1.0.1": { dist: { tarball: badUrl, integrity } } } }),
    [url]: () => new Response(bytes),
    [badUrl]: () => new Response(Buffer.concat([bytes, Buffer.from("substituted")])),
  });
  const into = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-top-folder-"));
  try {
    const fetched = await fetchPackage("trust-top-folder", "1.0.0", into);
    assert.equal(path.basename(fetched.dir), "types-entry");
    assert.deepEqual(fetched.identity, { name: "trust-top-folder", version: "1.0.0", integrity });
    assert.ok(scanPackage(fetched.dir, fetched.identity).hosts.has("unreviewed.example.org"));
    assert.ok(scanPackage(fetched.dir, fetched.identity).analytics.has("sentry"));
    await assert.rejects(fetchPackage("trust-top-folder", "1.0.1", path.join(into, "bad")), /doesn't match the registry's integrity hash/);
  } finally { fs.rmSync(into, { recursive: true, force: true }); }
});

test("request retries 5xx and transport errors, and fails fast on other statuses", async () => {
  let n = 0;
  mockFetch({
    "https://x.test/flaky": () => (++n === 1 ? json({}, 503) : n === 2 ? Promise.reject(new TypeError("fetch failed")) : json({ ok: true })),
    "https://x.test/bad": () => json({}, 400),
  });
  assert.deepEqual(await request("https://x.test/flaky", { backoffMs: 1 }), { ok: true });
  assert.equal(n, 3);
  const calls = mockFetch({ "https://x.test/bad": () => json({}, 400) });
  await assert.rejects(request("https://x.test/bad", { backoffMs: 1 }), /answered 400/);
  assert.equal(calls.length, 1);
  mockFetch({});
  assert.equal(await request("https://x.test/missing", { notFound: "null" }), null);
  await assert.rejects(request("https://x.test/missing"), /answered 404/);
});

test("request honors Retry-After, and gives up when it wouldn't fit the deadline", async () => {
  let n = 0;
  mockFetch({ "https://x.test/limited": () => (++n === 1 ? json({}, 429, { "retry-after": "1" }) : json({ ok: true })) });
  const started = Date.now();
  assert.deepEqual(await request("https://x.test/limited", { backoffMs: 1 }), { ok: true });
  assert.ok(Date.now() - started >= 950, "waited for Retry-After");
  const calls = mockFetch({ "https://x.test/later": () => json({}, 429, { "retry-after": "3600" }) });
  const before = Date.now();
  await assert.rejects(request("https://x.test/later", { deadlineMs: 10_000 }), /wouldn't fit/);
  assert.ok(Date.now() - before < 1000);
  assert.equal(calls.length, 1);
});

test("a body that trickles past the deadline is abandoned, and size is capped", async () => {
  mockFetch({
    "https://x.test/trickle": () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
        }),
        { status: 200 },
      ),
    "https://x.test/huge": () => new Response("x".repeat(2048), { status: 200 }),
  });
  const started = Date.now();
  await assert.rejects(request("https://x.test/trickle", { timeoutMs: 150, attempts: 2, backoffMs: 1 }), /Timeout|timed out|aborted/i);
  assert.ok(Date.now() - started < 2000, "the deadline covered the body");
  await assert.rejects(request("https://x.test/huge", { as: "text", maxBytes: 1024 }), /over the 1024-byte limit/);
});

// ------------------------------------------------------------- age gate --

test("dependency ages: invalid or missing publish times are unknown, never old", async () => {
  mockFetch({
    [registry("trust-dates")]: () =>
      json({
        versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "1.3.0": {}, "1.4.0": {} },
        time: { "1.0.0": ago(30), "1.1.0": "not-a-date", "1.2.0": ago(1), "1.3.0": "2026-10-01", "1.5.0": ago(30) },
      }),
  });
  const gate = await dependencyAgeGate(["trust-dates@1.0.0"], ["trust-dates@1.1.0", "trust-dates@1.2.0", "trust-dates@1.3.0", "trust-dates@1.4.0", "trust-dates@1.5.0"], { now: NOW });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.unknown, ["trust-dates@1.1.0", "trust-dates@1.3.0", "trust-dates@1.4.0", "trust-dates@1.5.0"]);
  assert.deepEqual(gate.young.map((y) => y.pkg), ["trust-dates@1.2.0"]);
  await assert.rejects(dependencyAgeGate([], [], { minDays: Number.NaN }), /non-negative number/);
});

test("a dependency under a commented packages header is still age-checked", async () => {
  const calls = mockFetch({ [registry("trust-fresh")]: () => json({ versions: { "1.0.0": {} }, time: { "1.0.0": ago(0.5) } }) });
  const lock = (pkgs) => ["lockfileVersion: '9.0'", "importers:", "  .: {}", "packages: # valid YAML comment", ...pkgs].join("\n");
  const gate = await dependencyAgeGate(lock(["  trust-base@1.0.0: {resolution: {integrity: sha512-a}}"]), lock(["  trust-base@1.0.0: {resolution: {integrity: sha512-a}}", "  trust-fresh@1.0.0: {resolution: {integrity: sha512-test}}"]), { now: NOW });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.young.map((y) => y.pkg), ["trust-fresh@1.0.0"]);
  assert.equal(calls.length, 1);
});

// --------------------------------------------------------- device tools --

function toolRegistry(name, versions) {
  const routes = {};
  const meta = { versions: {}, time: {} };
  for (const [version, { files, publishedAt, attestations }] of Object.entries(versions)) {
    const { bytes, integrity } = tarball(files);
    const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    routes[url] = () => new Response(bytes, { status: 200 });
    meta.versions[version] = { dist: { tarball: url, integrity, ...(attestations ? { attestations: { url: "x" } } : {}) } };
    meta.time[version] = publishedAt;
  }
  routes[registry(name)] = () => json(meta);
  return routes;
}

test("device tool review: age, provenance and new hosts; invalid dates fail", async () => {
  const quiet = { "index.js": "connect('ws://localhost:1234')" };
  mockFetch(
    toolRegistry("trust-tool", {
      "1.0.0": { files: quiet, publishedAt: ago(40), attestations: true },
      "1.1.0": { files: quiet, publishedAt: ago(10), attestations: true },
      "1.2.0": { files: { "index.js": "fetch('https://collector.evil.test.io/x')" }, publishedAt: ago(10), attestations: true },
      "1.3.0": { files: quiet, publishedAt: "garbage", attestations: true },
      "1.4.0": { files: quiet, publishedAt: ago(10) },
      "1.5.0": { files: { "index.js": "fetch('https://registry.npmjs.org@sink.evil.test.io/x')" }, publishedAt: ago(10), attestations: true },
    }),
  );
  const isKnownHost = () => false;
  assert.equal((await reviewDeviceTool("trust-tool@1.1.0", "trust-tool@1.0.0", { isKnownHost, now: NOW })).ok, true);
  assert.match((await reviewDeviceTool("trust-tool@1.2.0", "trust-tool@1.0.0", { isKnownHost, now: NOW })).reasons.join(), /new network hosts: collector\.evil\.test\.io/);
  assert.match((await reviewDeviceTool("trust-tool@1.3.0", "trust-tool@1.0.0", { isKnownHost, now: NOW })).reasons.join(), /under 3 days ago/);
  assert.match((await reviewDeviceTool("trust-tool@1.4.0", "trust-tool@1.0.0", { isKnownHost, now: NOW })).reasons.join(), /no npm provenance/);
  assert.match((await reviewDeviceTool("trust-tool@1.5.0", "trust-tool@1.0.0", { isKnownHost: (host) => host === "registry.npmjs.org", now: NOW })).reasons.join(), /new network hosts: sink\.evil\.test\.io$/, "userinfo doesn't hide the real host");
  const closures = [];
  const closure = async (tool, previous) => {
    closures.push([tool, previous]);
    return { ok: false, pin: tool, reasons: ["dependency helper@2.0.0: new network hosts: sink.test"], notes: [] };
  };
  const added = await reviewAddedDeviceTools(["trust-tool@1.0.0"], ["trust-tool@1.0.0", "trust-tool@1.1.0", "trust-tool@1.2.0", "other@9.9.9"], { knownDeviceTools: ["other@9.9.9"], isKnownHost, now: NOW, closure });
  assert.deepEqual(added.map(({ tool, ok }) => [tool, ok]), [["trust-tool@1.1.0", false], ["trust-tool@1.2.0", false]]);
  assert.deepEqual(added[0].reasons, ["dependency helper@2.0.0: new network hosts: sink.test"], "the closure's verdict counts");
  assert.deepEqual(closures, [["trust-tool@1.1.0", "trust-tool@1.0.0"]], "the closure is reviewed only once the tool's own code passes");
});

// ------------------------------------------------------------ fast lane --

const ATTACKER = { name: "attacker" };
const MAINTAINER = { name: "maint" };

test("publisher continuity is anchored to accepted, aged versions, deprecated ones included", async () => {
  const versions = { "1.0.0": { _npmUser: MAINTAINER, repository: { url: "git+https://github.com/Original/Repo.git" }, deprecated: "old" } };
  const time = { "1.0.0": ago(60) };
  for (let i = 1; i <= 6; i++) {
    versions[`1.0.${i}`] = { _npmUser: ATTACKER, repository: { url: "git+https://github.com/original/repo.git" } };
    time[`1.0.${i}`] = ago(0.01 * (7 - i));
  }
  versions["1.0.7"] = { _npmUser: MAINTAINER, repository: "github:original/repo" };
  time["1.0.7"] = ago(0.001);
  mockFetch({ [registry("trust-burst")]: () => json({ versions, time, repository: { url: "https://github.com/attacker/repo" } }) });
  assert.equal((await publisherContinuity("trust-burst", "1.0.6", { accepted: ["1.0.0"], now: NOW })).ok, false, "five fresh attacker releases don't vouch for a sixth");
  assert.match((await publisherContinuity("trust-burst", "1.0.6", { accepted: ["1.0.0"], now: NOW })).summary, /published by attacker/);
  assert.equal((await publisherContinuity("trust-burst", "1.0.6", { accepted: ["1.0.5"], now: NOW })).ok, false, "a young accepted version isn't a baseline");
  assert.match((await publisherContinuity("trust-burst", "1.0.7", { accepted: [], now: NOW })).summary, /no version .* to compare with/);
  // Each refusal names its reason for the metrics issue (ci/metrics.mjs), beside the summary.
  assert.equal((await publisherContinuity("trust-burst", "1.0.6", { accepted: ["1.0.0"], now: NOW })).code, "publisher-changed");
  assert.equal((await publisherContinuity("trust-burst", "1.0.7", { accepted: [], now: NOW })).code, "no-aged-baseline");
  assert.equal((await publisherContinuity("trust-burst", "9.9.9", { accepted: ["1.0.0"], now: NOW })).code, "not-on-npm");
  assert.deepEqual(await publisherContinuity("trust-burst", "1.0.7", { accepted: ["1.0.0"], now: NOW }), { ok: true, summary: "publisher maint, no provenance (none before either)" });
});

/** An npm attestation bundle naming `name@version` with `digest`, built from `repository` at `ref`. */
function attestation(name, version, sha512, repository, ref) {
  const statement = {
    subject: [{ name: `pkg:npm/${name.replace(/^@/, "%40")}@${version}`, digest: { sha512 } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository, ref, path: ".github/workflows/release.yml" } } } },
  };
  return { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
}

test("provenance must come from the accepted versions' repository and name this tarball", async () => {
  const integrity = (seed) => `sha512-${createHash("sha512").update(seed).digest("base64")}`;
  const hex = (seed) => createHash("sha512").update(seed).digest("hex");
  const base = { _npmUser: MAINTAINER, repository: { url: "git+https://github.com/original/repo.git" }, dist: { integrity: integrity("base"), attestations: {} } };
  const candidate = (version, repo, user = MAINTAINER) => ({ _npmUser: user, repository: { url: repo }, dist: { integrity: integrity(version), attestations: {} } });
  mockFetch({
    [registry("@trust/prov")]: () =>
      json({
        repository: { url: "https://github.com/attacker/repo" },
        versions: {
          "2.0.0": base,
          "2.0.1": candidate("2.0.1", "https://github.com/attacker/repo"),
          "2.0.2": candidate("2.0.2", "https://github.com/original/repo"),
          "2.0.3": candidate("2.0.3", "https://github.com/original/repo"),
          "2.0.4": candidate("2.0.4", "https://github.com/original/repo", { name: "GitHub Actions" }),
          "2.0.5": candidate("2.0.5", "https://github.com/original/repo"),
        },
        time: { "2.0.0": ago(90), "2.0.1": ago(0.1), "2.0.2": ago(0.1), "2.0.3": ago(0.1), "2.0.4": ago(0.1), "2.0.5": ago(0.1) },
      }),
    "https://registry.npmjs.org/-/npm/v1/attestations/@trust%2fprov@2.0.2": () => json(attestation("@trust/prov", "2.0.2", hex("2.0.2"), "https://github.com/attacker/repo", "refs/tags/evil")),
    "https://registry.npmjs.org/-/npm/v1/attestations/@trust%2fprov@2.0.3": () => json(attestation("@trust/prov", "2.0.3", hex("2.0.3"), "https://github.com/original/repo", "refs/tags/v2.0.3")),
    "https://registry.npmjs.org/-/npm/v1/attestations/@trust%2fprov@2.0.4": () => json(attestation("@trust/prov", "2.0.4", hex("2.0.4"), "https://github.com/original/repo", "refs/heads/main")),
    "https://registry.npmjs.org/-/npm/v1/attestations/@trust%2fprov@2.0.5": () => json(attestation("@trust/prov", "2.0.5", hex("something else"), "https://github.com/original/repo", "refs/heads/main")),
  });
  const check = (version) => publisherContinuity("@trust/prov", version, { accepted: ["2.0.0"], now: NOW });
  assert.match((await check("2.0.1")).summary, /declares repository https:\/\/github.com\/attacker\/repo/);
  assert.match((await check("2.0.2")).summary, /provenance from https:\/\/github.com\/attacker\/repo, not https:\/\/github.com\/original\/repo/);
  assert.deepEqual(await check("2.0.3"), { ok: true, summary: "publisher maint, provenance (unverified) names https://github.com/original/repo refs/tags/v2.0.3" });
  // Unverified provenance never earns trust: a switch to trusted publishing waits out the minimum age.
  assert.match((await check("2.0.4")).summary, /published by GitHub Actions, not by maint/);
  assert.match((await check("2.0.5")).summary, /doesn't name this tarball/);
  assert.deepEqual(await Promise.all(["2.0.1", "2.0.2", "2.0.4", "2.0.5"].map(async (v) => (await check(v)).code)), ["repository-changed", "provenance-mismatch", "publisher-changed", "provenance-mismatch"]);
  assert.equal(repoOf("git@github.com:Owner/Repo.git"), "https://github.com/owner/repo");
  assert.equal(repoOf("owner/repo"), "https://github.com/owner/repo");
  assert.equal(repoOf({ url: "git+ssh://git@github.com/owner/repo.git" }), "https://github.com/owner/repo");
});

test("a fix from a new publisher gets no fast lane, though its unverified provenance names the usual repository", async () => {
  const repo = "https://github.com/original/trusted";
  const waive = (name, publisher) => {
    const bytes = `${name} tarball`;
    mockFetch({
      [registry(name)]: () =>
        json({
          versions: {
            "1.0.0": { _npmUser: MAINTAINER, repository: repo, dist: { attestations: {} } },
            "1.0.1": { _npmUser: publisher, repository: repo, dist: { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, attestations: {} } },
          },
          time: { "1.0.0": ago(30), "1.0.1": ago(1 / 24) },
        }),
      // No signature, certificate, signed checkpoint, inclusion proof or log entry.
      [`https://registry.npmjs.org/-/npm/v1/attestations/${name}@1.0.1`]: () => json(attestation(name, "1.0.1", createHash("sha512").update(bytes).digest("hex"), repo, "refs/heads/main")),
    });
    const lane = makeFastLane({ basePackages: [`${name}@1.0.0`], openAdvisories: [{ id: "GHSA-known-fix", packages: [{ pkg: `${name}@1.0.0`, fixed: ["1.0.1"] }] }], advisories: async () => [], now: NOW });
    return lane(`${name}@1.0.1`);
  };
  assert.equal(await waive("trust-new-publisher", { name: "GitHub Actions" }), null, "the hour-old fix waits out the minimum age");
  assert.match(await waive("trust-usual-publisher", MAINTAINER), /^fixes GHSA-known-fix \(publisher maint, provenance \(unverified\) names https:\/\/github\.com\/original\/trusted refs\/heads\/main/);
});

test("the fast lane stays in the vulnerable version's 0.x line", async () => {
  const calls = mockFetch({
    "https://api.osv.dev/v1/querybatch": () => json({ results: [{}] }),
    ...noGithubAdvisories("trust-zero@0.35.5"),
    [registry("trust-zero")]: () =>
      json({
        versions: { "0.35.4": { _npmUser: MAINTAINER }, "0.35.5": { _npmUser: MAINTAINER }, "0.99.0": { _npmUser: MAINTAINER } },
        time: { "0.35.4": ago(100), "0.35.5": ago(0.5), "0.99.0": ago(0.5) },
      }),
  });
  const waive = makeFastLane({ basePackages: ["trust-zero@0.35.4"], openAdvisories: [{ id: "GHSA-zero", packages: [{ pkg: "trust-zero@0.35.4", fixed: ["0.35.5"] }] }], now: NOW });
  assert.equal(await waive("trust-zero@0.99.0"), null);
  assert.equal(calls.length, 0, "no lookups for a version outside the line");
  assert.match(await waive("trust-zero@0.35.5"), /^fixes GHSA-zero \(publisher maint/);
});

test("Electron runtime advisories come from the release lists", async () => {
  mockFetch({
    "https://releases.electronjs.org/releases.json": () => json([
      { version: "44.10.1", node: "24.22.1", chrome: "152.0.7977.169" },
      { version: "44.10.0", node: "24.22.0", chrome: "152.0.7977.167" },
      { version: "45.0.0", node: "25.0.0", chrome: "153.0.0.0" },
    ]),
    "https://nodejs.org/dist/index.json": () => json([{ version: "v24.22.1", security: true }, { version: "v24.22.0", security: false }]),
  });
  const [advisory] = await runtimeAdvisories(["react@19.0.0", "electron@44.10.0"]);
  assert.equal(advisory.severity, "HIGH");
  assert.match(advisory.summary, /Node\.js security release v24\.22\.1; Chromium/);
  assert.equal(await electronSecurityReason("44.10.0", "45.0.0"), null, "another major isn't a security update");
  await assert.rejects(runtimeAdvisories(["electron@44.9.9"]), /isn't in Electron's release list/);
});

// ----------------------------------------------------------- advisories --

test("OSV continuations are followed and a short answer fails the scan", async () => {
  const bodies = [];
  mockFetch({
    "https://api.osv.dev/v1/querybatch": (init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.queries[0].page_token) return json({ results: [{ vulns: [{ id: "GHSA-crit" }] }] });
      return json({ results: [{ vulns: [{ id: "GHSA-low" }], next_page_token: "page-2" }, {}] });
    },
    "https://api.osv.dev/v1/vulns/GHSA-low": () => json({ id: "GHSA-low", database_specific: { severity: "LOW" }, affected: [] }),
    "https://api.osv.dev/v1/vulns/GHSA-crit": () => json({ id: "GHSA-crit", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }], affected: [] }),
    ...noGithubAdvisories("trust-a@1.0.0", "trust-b@1.0.0"),
  });
  const found = await findAdvisories(["trust-a@1.0.0", "trust-b@1.0.0"]);
  assert.deepEqual(found.map((a) => [a.id, a.severity, a.packages.map((p) => p.pkg).join()]), [["GHSA-crit", "CRITICAL", "trust-a@1.0.0"], ["GHSA-low", "LOW", "trust-a@1.0.0"]]);
  assert.deepEqual(bodies[1].queries, [{ package: { ecosystem: "npm", name: "trust-a" }, version: "1.0.0", page_token: "page-2" }]);
  mockFetch({ "https://api.osv.dev/v1/querybatch": () => json({ results: [{}] }) });
  await assert.rejects(findAdvisories(["trust-a@1.0.0", "trust-b@1.0.0"]), /1 results for 2 queries/);
});

test("severity: CVSS vectors count, malicious packages are critical, unrated ones alert", () => {
  assert.equal(severityOf({ id: "X", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] }), "CRITICAL");
  assert.equal(severityOf({ id: "X", database_specific: { severity: "MODERATE" }, affected: [{ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H" }] }] }), "HIGH");
  assert.equal(severityOf({ id: "MAL-2026-1" }), "CRITICAL");
  assert.equal(severityOf({ id: "X", severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N" }] }), "UNKNOWN");
  assert.equal(isAlerting("UNKNOWN"), true);
  assert.equal(isAlerting("MODERATE"), false);
  const vuln = { affected: [{ package: { ecosystem: "npm", name: "p" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "2.0.9" }] }, { events: [{ fixed: "1.0.3" }, { fixed: "1.0.10" }] }] }] };
  assert.deepEqual(fixedVersions(vuln, "p"), ["1.0.3", "1.0.10", "2.0.9"]);
  assert.equal("fastLaneNames" in advisories, false);
});
