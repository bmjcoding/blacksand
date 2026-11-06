// node --test test/: known vulnerabilities (lib/advisories.mjs) and the security
// fast lane (lib/fastlane.mjs, lib/device-tools.mjs toolFastLane). Three sources,
// read in full and merged by id and alias: OSV, GitHub's Advisory Database, and a
// watched package's own repository. agent-device's GHSA-6845-fcpx-jc45 and
// GHSA-xr68-vpwv-cgg9 (<=0.21.34, fixed in 0.21.35, Oct 30 2026) were in neither
// database a day later (test/fixtures/advisories: the recorded answers). A source
// that can't be read throws; one GitHub can't speak for is a gap the fast lane
// refuses to decide on. Who claimed what survives the merge: the fast lane trusts
// a fix a curated source states for that package, or the exact version an owner
// override signs, never a repository's word merged in by a shared alias.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { findAdvisories, mergeAdvisories, scanAdvisories } from "../lib/advisories.mjs";
import { lockEntry, toolFastLane } from "../lib/device-tools.mjs";
import { advisoryReport, openAdvisories } from "../lib/evaluate.mjs";
import { makeFastLane } from "../lib/fastlane.mjs";
import { reviewAddedDeviceTools } from "../lib/gates.mjs";
import { request } from "../lib/http.mjs";
import { inRange } from "../lib/semver.mjs";
import { reconcileAdvisories } from "../ci/reconcile.mjs";
import { ago, mockFetch as mockRoutes, npm } from "./trust-fixtures.mjs";

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/advisories/${name}`, import.meta.url), "utf8"));
const REPO_ADVISORIES = fixture("github-repo-advisories-callstack-agent-device.json");
const DATABASE_EMPTY = fixture("github-database-agent-device-0.21.31.json");
const DATABASE_SAMPLE = fixture("github-database-sample.json");
const DATABASE_MALWARE = fixture("github-database-malware.json");
const OSV_EMPTY = fixture("osv-agent-device-0.21.31.json");
const NPM = fixture("npm-agent-device.json");
const ATTESTATIONS = fixture("npm-attestations-agent-device-0.21.35.json");
const PIN = JSON.parse(fs.readFileSync(new URL("../pin.json", import.meta.url), "utf8"));
const DAY = 86_400_000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();
const TOOL = "alias-tool";
const DEP = "alias-dep";
const CVE = "CVE-2026-10000";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const REPO_URL = "https://api.github.com/repos/callstack/agent-device/security-advisories?state=published&per_page=100";
const isDatabase = (url) => url.startsWith("https://api.github.com/advisories?ecosystem=npm&per_page=100&");
const isMalware = (url) => url.startsWith("https://api.github.com/advisories?ecosystem=npm&per_page=100&type=malware&");
const affectsOf = (url) => new URL(url).searchParams.get("affects").split(",");

/** Routes fetch through `route(url, init)` (a Response, or undefined for a 404); records every call. */
function mockFetch(route) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers ?? {}) }, init });
    return (await route(String(url), init)) ?? new Response("not found", { status: 404 });
  };
  return calls;
}

/** The recorded world: OSV and GitHub's database know nothing about agent-device; its repository does. */
const recorded = (url, init) => {
  if (url === OSV_BATCH) return json({ results: JSON.parse(init.body).queries.map(() => OSV_EMPTY.body) });
  if (isDatabase(url)) return json(DATABASE_EMPTY.body);
  if (url === REPO_URL) return json(REPO_ADVISORIES.body);
};
const meta = async (name) => (name === "agent-device" ? NPM.body : null);

test("agent-device@0.21.31's repository advisories are found though OSV and GitHub's database have none (recorded)", async () => {
  const calls = mockFetch(recorded);
  const scan = await scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"], meta });
  assert.deepEqual(
    scan.advisories.map((a) => [a.id, a.severity, a.packages, a.sources, a.origins.map((o) => o.repository)]),
    [
      ["GHSA-6845-fcpx-jc45", "HIGH", [{ pkg: "agent-device@0.21.31", fixed: ["0.21.35"], curatedFixed: [], severity: "HIGH", records: [{ id: "GHSA-6845-fcpx-jc45", severity: "HIGH" }] }], ["github-repository"], ["callstack/agent-device"]],
      ["GHSA-xr68-vpwv-cgg9", "HIGH", [{ pkg: "agent-device@0.21.31", fixed: ["0.21.35"], curatedFixed: [], severity: "HIGH", records: [{ id: "GHSA-xr68-vpwv-cgg9", severity: "HIGH" }] }], ["github-repository"], ["callstack/agent-device"]],
    ],
    "the <0.21.25 and <=0.20.3 advisories in the same list don't cover 0.21.31",
  );
  assert.deepEqual(scan.sources.map((s) => s.source), ["OSV.dev", "GitHub Advisory Database", "GitHub repository advisories"]);
  assert.deepEqual(scan.sources[2].repositories, ["callstack/agent-device"]);
  assert.ok(scan.sources.every((s) => !Number.isNaN(Date.parse(s.at))), "each source says when it was read");
  assert.deepEqual(scan.gaps, []);
  assert.equal(calls.filter((c) => isDatabase(c.url)).length, 2, "the database is asked twice: its default list, then malware");
  // The fix isn't flagged anywhere.
  assert.deepEqual(await findAdvisories(["agent-device@0.21.35"], { watch: ["agent-device"], meta }), []);
  // Only watched packages cost a repository request.
  const quiet = mockFetch(recorded);
  assert.deepEqual(await findAdvisories(["agent-device@0.21.31"], { meta }), [], "unwatched, the repository isn't read: OSV and the database alone miss these");
  assert.ok(!quiet.some((c) => c.url === REPO_URL));
});

test("GitHub's database: attribution by package and range, prereleases included, withdrawn skipped, malware critical", async () => {
  const pkgs = ["@babel/traverse@7.22.0", "lodash@4.17.20", "agent-device@0.21.31", "semver@7.5.1", "@pcb-dp/qa-commons@1.0.0"];
  mockFetch((url, init) => {
    if (url === OSV_BATCH) return json({ results: JSON.parse(init.body).queries.map(() => ({})) });
    if (isMalware(url)) return json(DATABASE_MALWARE.body);
    if (isDatabase(url)) return json(DATABASE_SAMPLE.body);
  });
  const found = await findAdvisories(pkgs);
  const by = Object.fromEntries(found.map((a) => [a.id, a]));
  assert.deepEqual(by["GHSA-67hx-6x53-jw92"].packages, [{ pkg: "@babel/traverse@7.22.0", fixed: ["7.23.2"], curatedFixed: ["7.23.2"], severity: "CRITICAL", records: [{ id: "GHSA-67hx-6x53-jw92", severity: "CRITICAL" }] }]);
  assert.equal(by["GHSA-67hx-6x53-jw92"].severity, "CRITICAL");
  assert.deepEqual(by["GHSA-c2qf-rxjj-qqgw"].packages, [{ pkg: "semver@7.5.1", fixed: ["7.5.2"], curatedFixed: ["7.5.2"], severity: "HIGH", records: [{ id: "GHSA-c2qf-rxjj-qqgw", severity: "HIGH" }] }], "only the 7.x range covers 7.5.1");
  assert.equal(by["GHSA-8p5q-j9m2-g8wr"], undefined, "withdrawn");
  assert.equal(by["GHSA-29mw-wpgm-hmr9"].severity, "MODERATE", "GitHub's medium");
  assert.deepEqual(by["GHSA-w4v4-fj9q-cfj5"]?.severity, "CRITICAL", "a malware advisory, asked for separately");
  assert.ok(!found.some((a) => a.packages.some((p) => p.pkg === "agent-device@0.21.31")));
  assert.ok(found.every((a) => a.sources.includes("github")));
  // Advisory ranges keep prereleases (a canary below the fix is affected); npm's satisfies doesn't.
  assert.equal(inRange("0.19.0-canary-20261023-1357114", "< 0.19.1".replace(/,/g, " ")), true);
  assert.equal(inRange("8.0.0-alpha.3", ">= 8.0.0-alpha.0  < 8.0.0-alpha.4"), true);
  assert.equal(inRange("0.21.35", "<= 0.21.34"), false);
});

test("GitHub's database is asked in batches under its URL limit, every package once, every page followed", async () => {
  const pkgs = Array.from({ length: 450 }, (_, i) => `@scope-${i}/a-rather-long-package-name-${i}@1.${i}.0`);
  const asked = [];
  const calls = mockFetch((url, init) => {
    if (url === OSV_BATCH) return json({ results: JSON.parse(init.body).queries.map(() => ({})) });
    if (url.includes("&after=page2")) return json([]);
    if (isDatabase(url)) {
      if (!isMalware(url)) asked.push(...affectsOf(url));
      const last = !isMalware(url) && asked.length === pkgs.length;
      return json([], 200, last ? { link: `<${url}&after=page2>; rel="next"` } : {});
    }
  });
  await findAdvisories(pkgs);
  const database = calls.filter((c) => isDatabase(c.url));
  assert.ok(database.every((c) => c.url.length < 7000), "under GitHub's ~8 KB limit (it answers 414)");
  assert.deepEqual([...asked].sort(), [...pkgs].sort(), "each package in exactly one batch");
  assert.ok(database.length >= 4, "several batches");
  assert.ok(calls.some((c) => c.url.includes("&after=page2")), "a Link rel=next page is followed");
});

test("fail closed: an unreadable source throws; a watched package GitHub can't speak for is a gap", async () => {
  mockFetch((url, init) => (url === OSV_BATCH ? recorded(url, init) : isDatabase(url) ? json({ message: "Validation failed" }, 422) : undefined));
  await assert.rejects(findAdvisories(["agent-device@0.21.31"]), /GitHub Advisory Database answered 422/);
  mockFetch((url, init) => (url === OSV_BATCH ? recorded(url, init) : isDatabase(url) ? json({ message: "not a list" }) : undefined));
  await assert.rejects(findAdvisories(["agent-device@0.21.31"]), /GitHub Advisory Database: GitHub sent something other than a list/);
  const reset = String(Math.floor(Date.parse("2026-10-31T06:00:00Z") / 1000));
  mockFetch((url, init) =>
    url === OSV_BATCH ? recorded(url, init) : isDatabase(url) ? json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }) : undefined,
  );
  await assert.rejects(findAdvisories(["agent-device@0.21.31"]), /rate limit is used up for this address without a token \(60 requests an hour; give one, lib\/github-token\.mjs\) until 2026-10-31T06:00:00\.000Z/);
  mockFetch((url, init) => (url === REPO_URL ? json({ message: "Must have admin rights" }, 403) : recorded(url, init)));
  await assert.rejects(scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"], meta }), /security advisories of callstack\/agent-device answered 403/);
  // Gone, or not on GitHub at all: reported, not an answer of "none".
  mockFetch((url, init) => (url === REPO_URL ? undefined : recorded(url, init)));
  const gone = await scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"], meta });
  assert.deepEqual(gone.advisories, []);
  assert.match(gone.gaps[0], /agent-device@0\.21\.31's own security advisories: GitHub has no repository callstack\/agent-device/);
  const elsewhere = await scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"], meta: async () => ({ versions: { "0.21.31": { repository: "https://gitlab.com/x/y" } } }) });
  assert.match(elsewhere.gaps[0], /its repository \(https:\/\/gitlab\.com\/x\/y\) isn't one on GitHub/);
  // A short OSV answer still fails the whole scan, before GitHub is asked.
  const calls = mockFetch((url) => (url === OSV_BATCH ? json({ results: [] }) : undefined));
  await assert.rejects(findAdvisories(["agent-device@0.21.31"]), /0 results for 1 queries/);
  assert.ok(!calls.some((c) => c.url.startsWith("https://api.github.com/")));
});

test("lib/http.mjs: a 403 that asks to wait (GitHub's secondary limit) is retried; a spent primary limit isn't", async () => {
  let n = 0;
  mockFetch(() => (++n === 1 ? json({}, 403, { "retry-after": "0" }) : json(["ok"])));
  assert.deepEqual(await request("https://api.github.com/x", { backoffMs: 1 }), ["ok"]);
  n = 0;
  mockFetch(() => (++n, json({}, 403, { "x-ratelimit-remaining": "0" })));
  await assert.rejects(request("https://api.github.com/x", { backoffMs: 1 }), (error) => error.status === 403 && error.headers.get("x-ratelimit-remaining") === "0");
  assert.equal(n, 1);
});

test("merge: one advisory per vulnerability across sources, OSV's id kept, the highest severity, every fixed version, and which a curated source states", () => {
  const merged = mergeAdvisories([
    { id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2026-1"], summary: "from OSV", severity: "MODERATE", url: "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc", packages: [{ pkg: "x@1.0.0", fixed: ["1.0.2"] }], sources: ["osv"] },
    { id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2026-1"], summary: "from GitHub", severity: "HIGH", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", packages: [{ pkg: "x@1.0.0", fixed: ["1.0.1"] }, { pkg: "x@0.9.0", fixed: [] }], sources: ["github"] },
    { id: "GHSA-dddd-eeee-ffff", aliases: ["CVE-2026-1"], summary: "", severity: "UNKNOWN", url: "u", packages: [{ pkg: "x@1.0.0", fixed: [] }], sources: ["github-repository"], repository: "o/r" },
    { id: "GHSA-gggg-hhhh-jjjj", aliases: [], summary: "alone", severity: "LOW", url: "v", packages: [{ pkg: "y@1.0.0", fixed: [] }], sources: ["github"] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    id: "GHSA-aaaa-bbbb-cccc",
    aliases: ["CVE-2026-1", "GHSA-dddd-eeee-ffff"],
    summary: "from OSV",
    severity: "HIGH",
    // Each package's own claim: its severity, and each record that names it with that record's own rating (one id from two sources: the more alarming).
    packages: [
      { pkg: "x@0.9.0", fixed: [], curatedFixed: [], severity: "HIGH", records: [{ id: "GHSA-aaaa-bbbb-cccc", severity: "HIGH" }] },
      { pkg: "x@1.0.0", fixed: ["1.0.1", "1.0.2"], curatedFixed: ["1.0.1", "1.0.2"], severity: "HIGH", records: [{ id: "GHSA-aaaa-bbbb-cccc", severity: "HIGH" }, { id: "GHSA-dddd-eeee-ffff", severity: "UNKNOWN" }] },
    ],
    sources: ["github", "github-repository", "osv"],
    // Each id with the source that published it, and the summary it gave; the lead (OSV's) is no repository's.
    origins: [
      { id: "GHSA-aaaa-bbbb-cccc", source: "osv", summary: "from OSV" },
      { id: "GHSA-aaaa-bbbb-cccc", source: "github", summary: "from GitHub" },
      { id: "GHSA-dddd-eeee-ffff", source: "github-repository", repository: "o/r", summary: "" },
    ],
  });
  assert.equal(merged[1].id, "GHSA-gggg-hhhh-jjjj");
});

test("the fast lane: a fix for an advisory is waived, a repository's own only when the owner vouched for it; a candidate still flagged under another name isn't", async () => {
  const open = [{ id: "GHSA-6845-fcpx-jc45", aliases: ["CVE-2026-9"], severity: "HIGH", packages: [{ pkg: "agent-device@0.21.31", fixed: ["0.21.35"] }] }];
  const asked = [];
  const continuity = async (name, version, { accepted }) => ({ ok: true, summary: `continuity ${name}@${version} vs ${accepted}` });
  const clean = makeFastLane({ basePackages: ["agent-device@0.21.31"], openAdvisories: open, watch: ["agent-device"], continuity, advisories: async (pkgs, opts) => (asked.push([pkgs, opts]), []) });
  assert.equal(await clean("agent-device@0.21.35"), "fixes GHSA-6845-fcpx-jc45 (continuity agent-device@0.21.35 vs 0.21.31)");
  assert.deepEqual(asked, [[["agent-device@0.21.35"], { watch: ["agent-device"] }]], "the still-flagged check reads the tool's repository too");
  assert.equal(await clean("agent-device@0.21.34"), null, "below the fix");
  assert.equal(await clean("agent-device@0.22.0"), null, "another line");
  // Only a repository published it: nobody curated it, so it opens the lane only once the owner vouches for it.
  const repoOnly = [{ ...open[0], sources: ["github-repository"] }];
  const unvouched = makeFastLane({ basePackages: ["agent-device@0.21.31"], openAdvisories: repoOnly, continuity, advisories: async () => [] });
  assert.equal(await unvouched("agent-device@0.21.35"), null);
  const vouched = makeFastLane({ basePackages: ["agent-device@0.21.31"], openAdvisories: repoOnly, vouched: [{ pkg: "agent-device@0.21.35", advisories: ["GHSA-6845-fcpx-jc45"] }], continuity, advisories: async () => [] });
  assert.match(await vouched("agent-device@0.21.35"), /^fixes GHSA-6845-fcpx-jc45/);
  // The owner signed 0.21.35, not the advisory's word: another version it "fixes" isn't vouched for.
  assert.equal(await vouched("agent-device@0.21.36"), null);
  const elsewhere = makeFastLane({ basePackages: ["agent-device@0.21.31"], openAdvisories: repoOnly, vouched: [{ pkg: "agent-device@0.21.35", advisories: ["GHSA-other-othe-othe"] }], continuity, advisories: async () => [] });
  assert.equal(await elsewhere("agent-device@0.21.35"), null, "the right version, but for another advisory");
  const aliased = makeFastLane({ basePackages: ["agent-device@0.21.31"], openAdvisories: open, continuity, advisories: async () => [{ id: "OSV-2026-1", aliases: ["CVE-2026-9"], packages: [] }] });
  assert.equal(await aliased("agent-device@0.21.35"), null, "the same vulnerability under another id still flags it");
});

test("the fast lane records each decision on a fix as plain data, and reading them changes no decision", async () => {
  const open = [{ id: "GHSA-6845-fcpx-jc45", aliases: ["CVE-2026-9"], severity: "HIGH", packages: [{ pkg: "agent-device@0.21.31", fixed: ["0.21.35"] }] }];
  const lane = (o = {}) => makeFastLane({ basePackages: ["agent-device@0.21.31"], openAdvisories: open, continuity: async () => ({ ok: true, summary: "publisher maint" }), advisories: async () => [], ...o });
  const publishedAt = "2026-11-05T01:00:00.000Z";
  // Admitted; refused by continuity, with its code; a fix only a repository states; one a source still flags.
  const cases = [
    [{}, "fixes GHSA-6845-fcpx-jc45 (publisher maint)", "admitted", "fixes GHSA-6845-fcpx-jc45 (publisher maint)"],
    [{ continuity: async () => ({ ok: false, code: "publisher-changed", summary: "published by mallory, not by maint" }) }, null, "publisher-changed", "published by mallory, not by maint"],
    [{ openAdvisories: [{ ...open[0], sources: ["github-repository"] }] }, null, "no-curated-fix", "no curated source states this fix"],
    [{ advisories: async () => [{ id: "OSV-2026-1", aliases: ["CVE-2026-9"], packages: [] }] }, null, "still-flagged", "a source still flags it"],
  ];
  // A fix, then no fix at all (below it, another line, another package), then the fix again.
  const PKGS = ["agent-device@0.21.35", "agent-device@0.21.34", "agent-device@0.22.0", "left-pad@1.3.1", "agent-device@0.21.35"];
  for (const [options, expected, code, reason] of cases) {
    // Two lanes alike: one nobody reads, one read before each call, its copies tampered with.
    const unread = lane(options);
    const read = lane(options);
    const results = { unread: [], read: [] };
    for (const pkg of PKGS) {
      results.unread.push(await unread(pkg, { publishedAt }));
      for (const d of read.decisions()) Object.assign(d, { admitted: !d.admitted, code: "tampered" }).replaces.push("x@0.0.0");
      results.read.push(await read(pkg, { publishedAt }));
    }
    assert.deepEqual(results.read, results.unread);
    assert.deepEqual(results.unread, [expected, null, null, null, expected]);
    // One record per decision on the fix, nothing for the rest; plain JSON data, untouched by the tampering.
    const record = { pkg: "agent-device@0.21.35", publishedAt, admitted: code === "admitted", code, reason, advisories: ["GHSA-6845-fcpx-jc45"], replaces: ["agent-device@0.21.31"] };
    const records = read.decisions();
    assert.deepEqual(records, [record, record]);
    assert.deepEqual(unread.decisions(), records);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, "only JSON values");
    for (const r of records) assert.equal(Object.getPrototypeOf(r), Object.prototype);
  }
  // No publish time given: recorded as unknown.
  const untimed = lane();
  await untimed("agent-device@0.21.35");
  assert.equal(untimed.decisions()[0].publishedAt, null);
  // A check that throws is thrown as before, and isn't recorded.
  const failing = lane({ continuity: async () => { throw new Error("npm registry answered 500"); } });
  await assert.rejects(failing("agent-device@0.21.35"), /answered 500/);
  assert.deepEqual(failing.decisions(), []);
});

test("the alert job's report says which sources it read and when, with the vendor gaps; issues link where the advisory is", async () => {
  mockFetch(recorded);
  const pins = JSON.stringify({ "agent-device": "0.21.31" });
  const lock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-bGVmdA==}\n\nsnapshots:\n\n  left-pad@1.3.0: {}\n";
  const pin = { version: 1, channels: { nightly: { ref: "v0.1.6-nightly.20261030.3917", sha: "0".repeat(40), evaluatedAt: "2026-10-30T00:00:00Z", leftOut: [] } }, deviceTools: ["agent-device@0.21.31"] };
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? lock : file.endsWith("deviceToolVersions.json") ? pins : null),
    resolvedLock: () => null,
    toolPackages: (tool) => [tool],
    stageRecord: () => null,
    npmMeta: meta,
    toolOverrides: [],
    openAdvisories: (packages, opts) => openAdvisories(packages, { ...opts }),
  };
  // npm for the repository lookup comes through lib/gates.mjs npmMeta (cached), so it's routed too.
  mockFetch((url, init) => (url === "https://registry.npmjs.org/agent-device" ? json(NPM.body) : recorded(url, init)));
  const report = await advisoryReport({ pin, channel: "nightly", overrides: [], now: () => new Date("2026-10-31T06:00:00Z") }, io);
  assert.deepEqual(report.open.map((a) => a.id), ["GHSA-6845-fcpx-jc45", "GHSA-xr68-vpwv-cgg9"]);
  assert.deepEqual(report.sources.map((s) => s.source), ["OSV.dev", "GitHub Advisory Database", "GitHub repository advisories"]);
  assert.ok(!report.gaps.some((gap) => /own security advisories/.test(gap)));
  // The tool's repository gone: a gap, so the coverage issue opens and no issue closes.
  mockFetch((url, init) => (url === REPO_URL ? undefined : url === "https://registry.npmjs.org/agent-device" ? json(NPM.body) : recorded(url, init)));
  const blind = await advisoryReport({ pin, channel: "nightly", overrides: [] }, io);
  assert.ok(blind.gaps.some((gap) => /agent-device@0\.21\.31's own security advisories: GitHub has no repository callstack\/agent-device/.test(gap)), blind.gaps.join("\n"));
  mockFetch((url, init) => (url === "https://registry.npmjs.org/agent-device" ? json(NPM.body) : recorded(url, init)));
  // Issues: the repository's own advisory page, the sources named (not their times: the body would change every hour).
  const created = [];
  const gh = {
    ensureLabel: async () => {},
    openIssues: async () => [],
    comments: async () => [],
    createIssue: async (fields) => created.push(fields),
    updateIssue: async () => {},
    comment: async () => {},
  };
  await reconcileAdvisories(report, gh, { log: () => {} });
  const body = created.find((issue) => issue.title === "[security] agent-device (nightly)").body;
  assert.match(body, /\[GHSA-6845-fcpx-jc45\]\(https:\/\/github\.com\/callstack\/agent-device\/security\/advisories\/GHSA-6845-fcpx-jc45\)/);
  assert.match(body, /Checked against `OSV\.dev`, `GitHub Advisory Database`, `GitHub repository advisories` \(`callstack\/agent-device`\)\./);
  assert.doesNotMatch(body, /2026-10-31T/);
});

test("merge: severities rank UNKNOWN above LOW and MODERATE and below HIGH, so a rating merged in can't quiet an unrated one", () => {
  const record = (id, severity, sources = ["osv"]) => ({ id, aliases: [CVE], summary: id, severity, url: "u", packages: [{ pkg: "x@1.0.0", fixed: [] }], sources });
  const merge = (...severities) => mergeAdvisories(severities.map((s, i) => record(`GHSA-${"cfgh"[i]}222-3333-4444`, s)))[0];
  assert.equal(merge("UNKNOWN", "LOW").severity, "UNKNOWN");
  assert.equal(merge("MODERATE", "UNKNOWN").severity, "UNKNOWN");
  assert.equal(merge("UNKNOWN", "HIGH").severity, "HIGH");
  assert.equal(merge("LOW", "MODERATE").severity, "MODERATE");
  assert.equal(merge("CRITICAL", "LOW", "UNKNOWN").severity, "CRITICAL");
  assert.equal(merge("UNKNOWN", "LOW").packages[0].severity, "UNKNOWN", "each package's own claim too");
});

test("merge: the lead is OSV's record, else GitHub's database's, else a repository's; every id keeps its own source and repository", () => {
  const db = { id: "GHSA-xr68-vpwv-cgg9", aliases: [CVE], summary: "curated database summary", severity: "HIGH", url: "u", packages: [{ pkg: "dep@1.0.0", fixed: ["1.0.1"] }], sources: ["github"] };
  const repo = (id, repository, pkg) => ({ id, aliases: [CVE], summary: `${repository}'s`, severity: "LOW", url: "u", packages: [{ pkg, fixed: [] }], sources: ["github-repository"], repository });
  const [merged] = mergeAdvisories([repo("GHSA-6845-fcpx-jc45", "example/tool", "tool@0.21.35"), db]);
  assert.deepEqual([merged.id, merged.summary], ["GHSA-xr68-vpwv-cgg9", "curated database summary"], "the database's record leads, not the smaller repository id");
  assert.deepEqual(merged.origins, [
    { id: "GHSA-xr68-vpwv-cgg9", source: "github", summary: "curated database summary" },
    { id: "GHSA-6845-fcpx-jc45", source: "github-repository", repository: "example/tool", summary: "example/tool's" },
  ]);
  // Two repositories' advisories sharing a CVE: each id keeps its own repository.
  const [both] = mergeAdvisories([repo("GHSA-xr68-vpwv-cgg9", "aaa/tool", "tool@0.21.35"), repo("GHSA-6845-fcpx-jc45", "zzz/tool", "other@0.21.35")]);
  assert.equal(both.id, "GHSA-6845-fcpx-jc45");
  assert.deepEqual(both.origins.map((o) => [o.id, o.repository]), [["GHSA-6845-fcpx-jc45", "zzz/tool"], ["GHSA-xr68-vpwv-cgg9", "aaa/tool"]]);
});

// ----------------------------------------------------------- fast lane --

/** A device tool's lock as pin.json keeps it, for `routes` (lib/../trust-fixtures npm()). */
function lockFor(name, version, routes) {
  const tarball = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  return { tarball, lock: (meta) => lockEntry(JSON.stringify({ name: "t3blackout-device-tool", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [name]: version } }, [`node_modules/${name}`]: { version, resolved: tarball, integrity: meta.versions[version].dist.integrity } } }, null, 2) + "\n"), routes };
}

test("an edited repository advisory can't make the owner's device tool override vouch for another young version", async () => {
  // The owner signed agent-device 0.21.31 -> 0.21.35 for GHSA-6845. Later the
  // repository's advisory is edited: <=0.21.35 affected, fixed in an hour-old 0.21.36.
  const name = "vouch-tool";
  // 0.21.35 old enough to vouch for its publisher (lib/fastlane.mjs publisherContinuity), so only the binding decides.
  const routes = npm(name, { "0.21.35": { files: { "index.js": "35" }, publishedAt: ago(5) }, "0.21.36": { files: { "index.js": "36" }, publishedAt: ago(1 / 24) } });
  const packument = JSON.parse(await routes[`https://registry.npmjs.org/${name}`]().text());
  for (const info of Object.values(packument.versions)) Object.assign(info, { _npmUser: { name: "GitHub Actions" }, repository: `https://github.com/o/${name}` });
  routes[`https://registry.npmjs.org/${name}`] = () => json(packument);
  mockRoutes(routes);
  const lock = (version) => lockFor(name, version, routes).lock(packument);
  const edited = async (packages) =>
    packages.includes(`${name}@0.21.35`) ? [{ id: "GHSA-6845-fcpx-jc45", aliases: [], severity: "HIGH", packages: [{ pkg: `${name}@0.21.35`, fixed: ["0.21.36"] }], sources: ["github-repository"] }] : [];
  const review = (toolOverrides) =>
    reviewAddedDeviceTools([`${name}@0.21.35`], [`${name}@0.21.35`, `${name}@0.21.36`], {
      isKnownHost: () => false,
      latest: async () => `${name}@0.21.35`,
      locks: { [`${name}@0.21.36`]: lock("0.21.36") },
      previousLocks: { [`${name}@0.21.35`]: lock("0.21.35") },
      advisories: edited,
      toolOverrides,
    });
  const [held] = await review([{ selector: `${name}@0.21.31`, version: "0.21.35", advisories: ["GHSA-6845-fcpx-jc45"] }]);
  assert.equal(held.ok, false, JSON.stringify(held));
  assert.match(held.reasons.join(), /under 3 days ago; no security fast lane: it fixes no advisory open against vouch-tool@0\.21\.35's closure \(one only a repository published counts only for the version a device tool override names\)/);
  // What the owner signs is what's vouched for: an override naming 0.21.36 itself takes it.
  const [taken] = await review([{ selector: `${name}@0.21.31`, version: "0.21.36", advisories: ["GHSA-6845-fcpx-jc45"] }]);
  assert.equal(taken.ok, true, taken.reasons.join());
  assert.ok(taken.notes.some((note) => /^fast lane: vouch-tool@0\.21\.36: fixes GHSA-6845-fcpx-jc45/.test(note)));
});

/** The recorded world, but the tool's repository answers its second request (the candidate's) 404. */
function goneOnSecondAsk() {
  let repoAsks = 0;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push(url);
    if (url === "https://api.osv.dev/v1/querybatch") return json({ results: JSON.parse(init.body).queries.map(() => ({})) });
    if (url.startsWith("https://api.github.com/advisories?")) return json([]);
    if (url.startsWith("https://api.github.com/repos/callstack/agent-device/security-advisories")) return ++repoAsks === 1 ? json(REPO_ADVISORIES.body) : json({ message: "Not Found" }, 404);
    if (url === "https://registry.npmjs.org/agent-device") return json(NPM.body);
    if (url === "https://registry.npmjs.org/-/npm/v1/attestations/agent-device@0.21.35") return json(ATTESTATIONS.body);
    return new Response("not found", { status: 404 });
  };
  return calls;
}

test("a source that can't cover the candidate shuts the fast lane; alerts keep the partial result and its gap", async () => {
  goneOnSecondAsk();
  const waive = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: PIN.deviceToolLocks["agent-device@0.21.31"], now: Date.parse("2026-10-31T12:00:00Z") });
  const result = await waive("agent-device@0.21.35");
  assert.equal(result.reason, null, "the review's 404 isn't 'not flagged'");
  assert.match(result.why, /couldn't be checked \(advisory coverage is incomplete, so nothing is decided on it: agent-device@0\.21\.35's own security advisories: GitHub has no repository callstack\/agent-device\)/);
  // The interfaces: findAdvisories and the fast lane's openAdvisories refuse; scanAdvisories and partial openAdvisories report.
  for (const ask of [() => findAdvisories(["agent-device@0.21.35"], { watch: ["agent-device"] }), () => openAdvisories(["agent-device@0.21.35"], { watch: ["agent-device"] })]) {
    goneOnSecondAsk();
    await findAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"] }); // the first ask succeeds
    await assert.rejects(ask(), /advisory coverage is incomplete/);
  }
  goneOnSecondAsk();
  await scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"] });
  const scan = await scanAdvisories(["agent-device@0.21.35"], { watch: ["agent-device"] });
  assert.deepEqual(scan.advisories, []);
  assert.equal(scan.gaps.length, 1);
  goneOnSecondAsk();
  await scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"] });
  let seen = null;
  assert.deepEqual(await openAdvisories(["agent-device@0.21.35"], { watch: ["agent-device"], partial: true, onCoverage: (coverage) => (seen = coverage) }), []);
  assert.match(seen.gaps[0], /GitHub has no repository callstack\/agent-device/);
});

// ---------------------------------------------------- claims and aliases --

/**
 * npm, OSV and GitHub for a tool whose closure holds DEP@1.0.0. OSV has a
 * curated advisory for DEP (fixed 1.0.1) under CVE; the tool's repository has
 * one of its own naming the same CVE that calls 0.21.35 vulnerable and the
 * hour-old 0.21.36 its fix. `osvClaimsTool`: OSV's record names the tool too.
 */
function world({ osvClaimsTool = false } = {}) {
  const sha = (n) => `sha512-${Buffer.alloc(64, n).toString("base64")}`;
  const version = (v, n, days) => ({ _npmUser: { name: "usual-maintainer" }, repository: `https://github.com/example/${TOOL}`, dependencies: { [DEP]: "1.0.0" }, dist: { integrity: sha(n), tarball: `https://registry.npmjs.org/${TOOL}/-/${TOOL}-${v}.tgz` }, published: daysAgo(days) });
  const tool = { "0.21.35": version("0.21.35", 1, 5), "0.21.36": version("0.21.36", 2, 1 / 24) };
  const meta = {
    [TOOL]: { versions: tool, time: Object.fromEntries(Object.entries(tool).map(([v, info]) => [v, info.published])) },
    [DEP]: { versions: { "1.0.0": { repository: "https://github.com/example/dep", dist: { integrity: sha(3), tarball: `https://registry.npmjs.org/${DEP}/-/${DEP}-1.0.0.tgz` } } }, time: { "1.0.0": daysAgo(100) } },
  };
  const osvRecord = {
    id: "GHSA-67hx-6x53-jw92",
    aliases: [CVE],
    summary: "a curated advisory for the dependency",
    database_specific: { severity: "HIGH" },
    affected: [
      { package: { ecosystem: "npm", name: DEP }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] },
      ...(osvClaimsTool ? [{ package: { ecosystem: "npm", name: TOOL }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "0.21.36" }] }] }] : []),
    ],
  };
  const repoAdvisory = {
    ghsa_id: "GHSA-6845-fcpx-jc45",
    cve_id: CVE, // a repository advisory's CVE is the maintainer's to edit
    state: "published",
    severity: "high",
    summary: "edited",
    identifiers: [{ type: "GHSA", value: "GHSA-6845-fcpx-jc45" }, { type: "CVE", value: CVE }],
    vulnerabilities: [{ package: { ecosystem: "npm", name: TOOL }, vulnerable_version_range: "<= 0.21.35", patched_versions: "0.21.36" }],
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === "https://api.osv.dev/v1/querybatch") {
      const flagged = (q) => (q.package.name === DEP && q.version === "1.0.0") || (osvClaimsTool && q.package.name === TOOL && q.version === "0.21.35");
      return json({ results: JSON.parse(init.body).queries.map((q) => (flagged(q) ? { vulns: [{ id: osvRecord.id }] } : {})) });
    }
    if (url === `https://api.osv.dev/v1/vulns/${osvRecord.id}`) return json(osvRecord);
    if (url.startsWith("https://api.github.com/advisories?")) return json([]);
    if (url === `https://api.github.com/repos/example/${TOOL}/security-advisories?state=published&per_page=100`) return json([repoAdvisory]);
    const name = /^https:\/\/registry\.npmjs\.org\/([^/]+)$/.exec(url)?.[1];
    if (name && meta[name]) return json(meta[name]);
    if (url.includes("/-/npm/v1/attestations/")) return json({ message: "none" }, 404);
    return new Response("not found", { status: 404 });
  };
  const closure = JSON.stringify({
    name: "t3blackout-device-tool",
    lockfileVersion: 3,
    packages: {
      "": { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [TOOL]: "0.21.35" } },
      [`node_modules/${TOOL}`]: { version: "0.21.35", resolved: tool["0.21.35"].dist.tarball, integrity: tool["0.21.35"].dist.integrity },
      [`node_modules/${DEP}`]: { version: "1.0.0", resolved: meta[DEP].versions["1.0.0"].dist.tarball, integrity: meta[DEP].versions["1.0.0"].dist.integrity },
    },
  });
  return { previousLock: lockEntry(closure) };
}

test("a repository advisory sharing a CVE with a curated one can't launder its claim into the fast lane", async () => {
  const { previousLock } = world();
  // The two did merge into one advisory, under OSV's id: that is the laundering setup.
  const [merged] = await findAdvisories([`${TOOL}@0.21.35`, `${DEP}@1.0.0`], { watch: [TOOL] });
  assert.equal(merged.id, "GHSA-67hx-6x53-jw92");
  assert.deepEqual(merged.sources, ["github-repository", "osv"]);
  assert.deepEqual(merged.packages, [
    { pkg: `${DEP}@1.0.0`, fixed: ["1.0.1"], curatedFixed: ["1.0.1"], severity: "HIGH", records: [{ id: "GHSA-67hx-6x53-jw92", severity: "HIGH" }] },
    { pkg: `${TOOL}@0.21.35`, fixed: ["0.21.36"], curatedFixed: [], severity: "HIGH", records: [{ id: "GHSA-6845-fcpx-jc45", severity: "HIGH" }] },
  ]);
  // The owner signed 0.21.35, not 0.21.36: held.
  const owner = [{ selector: `${TOOL}@0.21.31`, version: "0.21.35", advisories: ["GHSA-6845-fcpx-jc45"] }];
  const lane = toolFastLane(`${TOOL}@0.21.36`, { previous: `${TOOL}@0.21.35`, previousLock, toolOverrides: owner });
  const held = await lane(`${TOOL}@0.21.36`);
  assert.equal(held.reason, null, JSON.stringify(held));
  assert.match(held.why, /it fixes no advisory open against alias-tool@0\.21\.35's closure/);
});

test("the same fix stated by a curated source itself, or signed by the owner, is taken", async () => {
  // OSV's own record names the tool fixed in 0.21.36: a curated claim.
  let { previousLock } = world({ osvClaimsTool: true });
  const curated = toolFastLane(`${TOOL}@0.21.36`, { previous: `${TOOL}@0.21.35`, previousLock, toolOverrides: [] });
  assert.match((await curated(`${TOOL}@0.21.36`)).reason ?? "", /^fixes GHSA-67hx-6x53-jw92 \(publisher usual-maintainer, no provenance \(none before either\)\)$/);
  // The owner's override names 0.21.36 for the repository's advisory: the signed tuple.
  ({ previousLock } = world());
  const signed = toolFastLane(`${TOOL}@0.21.36`, { previous: `${TOOL}@0.21.35`, previousLock, toolOverrides: [{ selector: `${TOOL}@0.21.31`, version: "0.21.36", advisories: ["GHSA-6845-fcpx-jc45"] }] });
  assert.match((await signed(`${TOOL}@0.21.36`)).reason ?? "", /^fixes GHSA-67hx-6x53-jw92/);
});
