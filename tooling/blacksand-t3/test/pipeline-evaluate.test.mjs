// node --test test/*.test.mjs: the evaluator (lib/evaluate.mjs) against fakes for
// the mirror, the build and the network: candidate order, per-candidate
// approvals and failures, one strip check per candidate, the resolved lockfiles
// it hands the commit and alert jobs, and the alert job's inventory.
import { test } from "node:test";
import assert from "node:assert/strict";

import { lockEntry } from "../lib/device-tools.mjs";
import { advisoryReport, evaluateChannel, MAX_FALLBACK, MAX_LOOKBACK, releaseCandidates } from "../lib/evaluate.mjs";
import { dependencyAgeGate, lockPackages } from "../lib/gates.mjs";
import { ago, mockFetch } from "./trust-fixtures.mjs";
import { OVERRIDES, RESOLVED, UPSTREAM, npmMeta } from "./pipeline-fixtures.mjs";

const sha = (c) => c.repeat(40);
const PINNED = "v0.1.6-nightly.20261030.3917";
const NEWEST = "v0.1.7-nightly.20261031.4001";
const OLDER = "v0.1.7-nightly.20261031.4000";
const SHAS = { [PINNED]: sha("0"), [NEWEST]: sha("a"), [OLDER]: sha("b"), "v0.1.5-nightly.20261029.3877": sha("c"), "v0.1.7-nightly.badformat": sha("d"), "v0.1.6": sha("e") };
const TOOLS = (version) => JSON.stringify({ "agent-device": version });
/** A stand-in for a device tool's reviewed package-lock.json, as pin.json keeps it. */
const LOCK = (tool) => lockEntry(`${JSON.stringify({ lockfileVersion: 3, tool })}\n`);
const PIN = {
  version: 1,
  channels: { nightly: { ref: PINNED, sha: sha("0"), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } },
  deviceTools: ["agent-device@0.21.31"],
  deviceToolLocks: { "agent-device@0.21.31": LOCK("agent-device@0.21.31") },
};
const clean = { ok: true, added: 0, young: [], waived: [], unknown: [] };

/** A fake io: every release has the fixture lockfile; `files[sha]` overrides per file. */
function fakeIo({ files = {}, checks = {}, gate = async () => clean, builds = {}, reviews = {} } = {}) {
  const calls = { checkRules: [], resolveLock: [], build: [], reviews: [], advisories: [], proposed: [] };
  let checked = null;
  const io = {
    show: (at, file) => (files[at] && file in files[at] ? files[at][file] : file === "pnpm-lock.yaml" ? UPSTREAM : TOOLS("0.21.31")),
    revParse: (ref) => SHAS[ref] ?? sha("f"),
    tags: () => Object.keys(SHAS),
    knownDeviceTools: () => new Set(["agent-device@0.21.25"]),
    toolOverrides: [],
    reviewAddedDeviceTools: async (previous, next, known) => {
      const reviewed = new Set([...known, ...previous]);
      const added = [...new Set(next)].filter((tool) => !reviewed.has(tool));
      calls.reviews.push(added);
      return added.map((tool) => ({ tool, lock: LOCK(tool), ...(reviews[tool] ?? { ok: true, reasons: [] }) }));
    },
    proposeToolLock: async (tool) => {
      calls.proposed.push(tool);
      return LOCK(tool);
    },
    dependencyAgeGate: (base, lock, opts) => gate(base, lock, opts),
    openAdvisories: async (packages) => {
      calls.advisories.push(packages);
      return [];
    },
    makeFastLane: () => async () => null,
    checkRules: (ref, at, opts) => {
      calls.checkRules.push({ ref, sha: at, approvals: opts.approvals });
      checked = at;
      return checks[at] ?? { ok: true, skipped: [] };
    },
    resolveLock: () => {
      calls.resolveLock.push(checked);
      return UPSTREAM;
    },
    build: async (ref, at, opts) => {
      calls.build.push({ ref, sha: at, approvals: opts.approvals });
      if (builds[at] instanceof Error) throw builds[at];
      return builds[at] ?? { skipped: [] };
    },
    log: () => {},
  };
  return { io, calls };
}

test("candidates: canonical tags on the channel, newer than the pin, newest release first", () => {
  const tags = ["v0.1.7-nightly.20261031.4000", "v0.1.7-nightly.badformat", "v0.1.6-nightly.20261030.3917", "v0.1.10-nightly.20261101.1", "v0.1.7-nightly.20261031.4001", "v0.1.8", "v00.1.9-nightly.20261101.2", "v0.1.7-preview.20261031.1"];
  assert.deepEqual(releaseCandidates(tags, "nightly", PINNED), ["v0.1.10-nightly.20261101.1", "v0.1.7-nightly.20261031.4001", "v0.1.7-nightly.20261031.4000"]);
  assert.deepEqual(releaseCandidates(tags, "nightly", PINNED, 1), ["v0.1.10-nightly.20261101.1"]);
  assert.deepEqual(releaseCandidates(tags, "stable", null), ["v0.1.8"]);
});

test("a held candidate's device tool approval doesn't carry over: the one pinned approves its own", async () => {
  const files = { [sha("a")]: { "apps/server/src/device/deviceToolVersions.json": TOOLS("0.21.40") }, [sha("b")]: { "apps/server/src/device/deviceToolVersions.json": TOOLS("0.21.40") } };
  const { io, calls } = fakeIo({ files, checks: { [sha("a")]: { ok: false, message: "1 strict rule(s) no longer match upstream. Nothing was installed." } } });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.pin.channels.nightly.ref, OLDER);
  assert.deepEqual(result.pin.deviceTools, ["agent-device@0.21.31", "agent-device@0.21.40"]);
  assert.deepEqual(calls.reviews, [["agent-device@0.21.40"], ["agent-device@0.21.40"]], "reviewed again for the second candidate");
  assert.deepEqual(
    calls.checkRules.map(({ sha: at, approvals }) => [at[0], approvals]),
    [["0", []], ["a", ["agent-device@0.21.40"]], ["b", ["agent-device@0.21.40"]]],
    "one strip check for the pinned release and one per candidate, each with only its own approvals",
  );
  assert.match(result.report, /Passed over v0\.1\.7-nightly\.20261031\.4001:\n- 1 strict rule/);
  assert.deepEqual([...result.resolved.keys()], [sha("0"), sha("b")], "resolved lockfiles for the pinned release and the new pin");
});

test("a candidate that fails to evaluate is held, the next is still evaluated, and the report is written", async () => {
  const gate = async (base, lock, opts) => {
    if (opts?.waive !== undefined && lock === "broken") throw new Error("npm registry answered 500 for left-pad");
    return clean;
  };
  const { io } = fakeIo({ files: { [sha("a")]: { "pnpm-lock.yaml": "broken" } }, gate });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.pin.channels.nightly.ref, OLDER);
  assert.match(result.report, /Passed over v0\.1\.7-nightly\.20261031\.4001 \(held at the age prefilter; no other gate ran\):\n- couldn't be evaluated: npm registry answered 500/);
});

test("every candidate held: exit 3, the pin stays, each reason reported", async () => {
  const young = async (base, lock, opts) => (opts?.waive !== undefined ? { ...clean, ok: false, young: [{ pkg: "fresh@1.0.0", publishedAt: "2026-10-30T00:00:00Z" }] } : clean);
  const { io } = fakeIo({ gate: young });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(result.exitCode, 3);
  assert.equal(result.pin, null);
  assert.match(result.report, /## v0\.1\.7-nightly\.20261031\.4001 \(held at the age prefilter; no other gate ran\)\n- dependency fresh@1\.0\.0 published/);
  assert.match(result.report, /## v0\.1\.7-nightly\.20261031\.4000 \(held at the age prefilter; no other gate ran\)\n/);
  assert.deepEqual([...result.resolved.keys()], [sha("0")], "the pinned release's lockfile still goes to the alert job");
});

test("the run's metrics: what the age gate held per candidate and what the fast lane decided, reported only", async () => {
  const at = "2026-11-05T01:00:00Z";
  const files = { [sha("a")]: { "pnpm-lock.yaml": "lock-a" } };
  // The newest has a young fix the lane refuses and a young version besides; the older one nothing young.
  const gate = async (base, lock, { waive } = {}) => {
    if (lock !== "lock-a") return clean;
    assert.equal(await waive("dep@1.0.1", { publishedAt: at }), null);
    return { ...clean, ok: false, young: [{ pkg: "dep@1.0.1", publishedAt: at }, { pkg: "fresh@2.0.0", publishedAt: at }] };
  };
  const { io } = fakeIo({ files, gate });
  // A lane that refuses, recording its decision as lib/fastlane.mjs does: the evaluator reads them once it's done.
  io.makeFastLane = () => {
    const seen = [];
    const waive = async (pkg, { publishedAt }) => {
      seen.push({ pkg, publishedAt, admitted: false, code: "publisher-changed", reason: "published by mallory", advisories: ["GHSA-2222-3333-4444"], replaces: ["dep@1.0.0"] });
      return null;
    };
    waive.decisions = () => structuredClone(seen);
    return waive;
  };
  const result = await evaluateChannel({ channel: "nightly", pin: PIN, now: () => new Date("2026-11-05T02:00:00Z") }, io);
  assert.equal(result.pin.channels.nightly.ref, OLDER, "the decision is the evaluator's as before");
  assert.deepEqual(result.metrics, {
    v: 1,
    channel: "nightly",
    at: "2026-11-05T02:00:00.000Z",
    minAgeDays: 3,
    pinned: PINNED,
    pinnedTo: OLDER,
    fastLane: true,
    candidates: [
      { ref: NEWEST, held: true, young: [{ pkg: "dep@1.0.1", publishedAt: at }, { pkg: "fresh@2.0.0", publishedAt: at }] },
      { ref: OLDER, held: false, young: [] },
    ],
    decisions: [{ pkg: "dep@1.0.1", publishedAt: at, admitted: false, code: "publisher-changed", reason: "published by mallory", advisories: ["GHSA-2222-3333-4444"], replaces: ["dep@1.0.0"] }],
  });
  // A candidate that couldn't be evaluated: the age gate's word on it is unknown, not "nothing young".
  const broken = fakeIo({ gate: async () => { throw new Error("npm registry answered 500"); } });
  const failed = await evaluateChannel({ channel: "nightly", pin: PIN }, broken.io);
  assert.deepEqual(failed.metrics.candidates.map((c) => [c.held, c.young]), [[true, null], [true, null]]);
});

const FRESH = ago(1);

/** `n` nightly tags newer than PINNED, newest first, each with its own sha (index i -> "1" + i padded). */
function nightlies(n) {
  const tags = Array.from({ length: n }, (_, i) => `v0.1.8-nightly.20261104.${5000 - i}`);
  const shas = Object.fromEntries(tags.map((tag, i) => [tag, `1${String(i).padStart(39, "0")}`]));
  return { tags, shas };
}

/** fakeIo over `tags` (and PINNED), the age gate holding the releases in `young`. */
function lookbackIo(tags, shas, young) {
  const gate = async (base, lock, opts) => (opts?.waive !== undefined && young.has(lock) ? { ...clean, ok: false, young: [{ pkg: "@effect/tsgo@0.67.1", publishedAt: "2026-11-04T12:19:00Z" }] } : clean);
  // A young release's lockfile is its tag, which the fake gate holds; every other is the fixture.
  const files = Object.fromEntries([...young].map((tag) => [shas[tag], { "pnpm-lock.yaml": tag }]));
  const { io, calls } = fakeIo({ files, gate });
  io.tags = () => [PINNED, ...tags];
  io.revParse = (ref) => shas[ref] ?? sha("0");
  return { io, calls };
}

test("five newest held by a young dependency, an older one eligible: the age prefilter skips them and the older one is pinned", async () => {
  const { tags, shas } = nightlies(MAX_FALLBACK + 3);
  const { io, calls } = lookbackIo(tags, shas, new Set(tags.slice(0, MAX_FALLBACK + 1)));
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  const chosen = tags[MAX_FALLBACK + 1];
  assert.equal(result.exitCode, 0);
  assert.equal(result.pin.channels.nightly.ref, chosen, "the newest release past the young ones, outside the old five-release window");
  assert.deepEqual(calls.checkRules.map((c) => c.ref), [PINNED, chosen], "no other gate ran on a release the age gate held");
  for (const tag of tags.slice(0, MAX_FALLBACK + 1)) assert.match(result.report, new RegExp(`Passed over ${tag.replaceAll(".", "\\.")} \\(held at the age prefilter; no other gate ran\\):\n- dependency @effect/tsgo@0\\.67\\.1 published`));
  // The metrics still count each age hold; the release older than the new pin isn't a candidate.
  assert.deepEqual(result.metrics.candidates.map((c) => [c.ref, c.held, c.young?.length]), [...tags.slice(0, MAX_FALLBACK + 1).map((tag) => [tag, true, 1]), [chosen, false, 0]]);
});

test("every release held: those the age gate held at the prefilter, and every gate only on the newest MAX_FALLBACK that pass it", async () => {
  const { tags, shas } = nightlies(12);
  // Young: 0, 1, 3. The rest pass the age gate, and the strict rules hold them all.
  const { io, calls } = lookbackIo(tags, shas, new Set([tags[0], tags[1], tags[3]]));
  io.checkRules = (ref, at) => (at === sha("0") ? { ok: true, skipped: [] } : (calls.checkRules.push({ ref }), { ok: false, message: "1 strict rule(s) no longer match upstream." }));
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.deepEqual([result.exitCode, result.pin], [3, null]);
  const tried = tags.filter((_, i) => ![0, 1, 3].includes(i)).slice(0, MAX_FALLBACK);
  assert.deepEqual(calls.checkRules.map((c) => c.ref), tried, "every gate on the newest five the age gate passed, newest first");
  assert.match(result.report, new RegExp(`## ${tags[3].replaceAll(".", "\\.")} \\(held at the age prefilter; no other gate ran\\)\n- dependency @effect/tsgo`));
  assert.match(result.report, new RegExp(`## ${tried[0].replaceAll(".", "\\.")}\n- 1 strict rule`));
  assert.match(result.report, new RegExp(`Not evaluated further, though the age gate passed them \\(at most 5 are, newest first\\): ${tags.slice(-4).join(", ").replaceAll(".", "\\.")}\\.`));
  assert.deepEqual(result.metrics.candidates.map((c) => [c.ref, c.held, c.young?.length]), tags.map((tag, i) => [tag, true, [0, 1, 3].includes(i) ? 1 : 0]), "every release the age check saw, held this run");
  // Every release held by age, none passing it: no other gate runs at all.
  const all = lookbackIo(tags, shas, new Set(tags));
  const none = await evaluateChannel({ channel: "nightly", pin: PIN }, all.io);
  assert.deepEqual([none.exitCode, all.calls.checkRules.map((c) => c.ref)], [3, [PINNED]]);
  assert.equal(none.metrics.candidates.length, tags.length);
});

test("the look-back is bounded: only the newest MAX_LOOKBACK releases newer than the pin get the age check", async () => {
  const { tags, shas } = nightlies(MAX_LOOKBACK + 7);
  assert.deepEqual(releaseCandidates(tags, "nightly", PINNED), tags.slice(0, MAX_LOOKBACK));
  const seen = [];
  const { io, calls } = lookbackIo(tags, shas, new Set(tags));
  const inner = io.dependencyAgeGate;
  io.dependencyAgeGate = (base, lock, opts) => (opts?.waive !== undefined && seen.push(lock), inner(base, lock, opts));
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.deepEqual(seen, tags.slice(0, MAX_LOOKBACK), "the age gate once per release, newest first, none past the bound");
  assert.deepEqual([result.exitCode, calls.checkRules.length], [3, 1]);
  // Even an eligible release past the bound isn't looked at.
  const late = lookbackIo(tags, shas, new Set(tags.slice(0, MAX_LOOKBACK)));
  assert.equal((await evaluateChannel({ channel: "nightly", pin: PIN }, late.io)).exitCode, 3);
});

test("the prefilter is the age gate: on the same candidate the same young versions and verdict, and the gate called once", async () => {
  // The real gate (lib/gates.mjs), npm faked: a release adding one young and one old version.
  const fetch = globalThis.fetch;
  mockFetch({
    "https://registry.npmjs.org/prefilter-fresh": () => new Response(JSON.stringify({ versions: { "1.0.0": {} }, time: { "1.0.0": FRESH } }), { status: 200 }),
    "https://registry.npmjs.org/prefilter-old": () => new Response(JSON.stringify({ versions: { "1.0.0": {} }, time: { "1.0.0": ago(30) } }), { status: 200 }),
  });
  try {
    const youngLock = [...lockPackages(UPSTREAM), "prefilter-fresh@1.0.0", "prefilter-old@1.0.0"];
    const { tags, shas } = nightlies(2);
    const { io, calls } = lookbackIo(tags, shas, new Set());
    io.show = (at, file) => (file === "pnpm-lock.yaml" ? (at === shas[tags[0]] ? youngLock : UPSTREAM) : TOOLS("0.21.31"));
    const gated = [];
    io.dependencyAgeGate = (base, lock, opts) => (gated.push(lock), dependencyAgeGate(base, lock, opts));
    const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
    const direct = await dependencyAgeGate(UPSTREAM, youngLock);
    assert.deepEqual([direct.ok, direct.young], [false, [{ pkg: "prefilter-fresh@1.0.0", publishedAt: FRESH }]]);
    assert.deepEqual(result.metrics.candidates, [
      { ref: tags[0], held: true, young: direct.young },
      { ref: tags[1], held: false, young: [] },
    ]);
    assert.match(result.report, new RegExp(`Passed over ${tags[0].replaceAll(".", "\\.")} \\(held at the age prefilter; no other gate ran\\):\n- dependency prefilter-fresh@1\\.0\\.0 published`));
    assert.equal(result.pin.channels.nightly.ref, tags[1], "the other passes the same gate and is pinned");
    assert.equal(gated.filter((lock) => lock === youngLock).length, 1, "one gate call per release: the full evaluation reuses the prefilter's");
    assert.deepEqual(calls.checkRules.map((c) => c.ref), [PINNED, tags[1]]);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("nothing newer: exit 0, no pin, the pinned release resolved for the alert job", async () => {
  const { io, calls } = fakeIo();
  io.tags = () => [PINNED, "v0.1.5-nightly.20261029.3877"];
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.deepEqual([result.exitCode, result.pin], [0, null]);
  assert.match(result.report, /Already on the newest release/);
  assert.deepEqual(calls.resolveLock, [sha("0")]);
});

test("with --build: built once per passing candidate, what it left out pinned; a build failure holds it", async () => {
  const { io, calls } = fakeIo({ builds: { [sha("a")]: new Error("the app doesn't typecheck against upstream (1 error(s)).\n  - apps/web/x.ts(1): TS2322") , [sha("b")]: { skipped: ["names"] } } });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, io);
  assert.equal(result.pin.channels.nightly.ref, OLDER);
  assert.deepEqual(result.pin.channels.nightly.leftOut, ["names"]);
  assert.deepEqual(calls.build.map(({ sha: at }) => at[0]), ["a", "b"]);
  assert.equal(calls.checkRules.length, 3);
  assert.match(result.report, /built and smoke-tested/);
});

test("the pinned release can't be resolved: candidates are still evaluated, the fast lane built from git alone", async () => {
  const { io } = fakeIo({ checks: { [sha("0")]: { ok: false, message: "1 strict rule(s) no longer match upstream." } } });
  let lanes = 0;
  io.makeFastLane = () => {
    lanes++;
    return async () => null;
  };
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(lanes, 1, "the fast lane never needed the evaluate job's own resolution");
  assert.doesNotMatch(result.report, /no security fix skips the age gate/);
  assert.equal(result.pin.channels.nightly.ref, NEWEST);
  assert.ok(!result.resolved.has(sha("0")));
});

test("the alert inventory is the resolved graph plus the release's own device tools", async () => {
  const pin = { ...PIN, deviceTools: ["agent-device@0.21.20", "agent-device@0.21.31"] };
  const seen = [];
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : TOOLS("0.21.31")),
    resolvedLock: (at) => (at === sha("0") ? RESOLVED : null),
    // Device tool closures and the staged install: test/pipeline-inventory.test.mjs.
    toolPackages: (tool) => [tool],
    stageRecord: () => null,
    npmMeta,
    toolOverrides: [],
    openAdvisories: async (packages) => {
      seen.push(packages);
      return [{ id: "GHSA-x", severity: "HIGH", packages: [{ pkg: "newdep@3.0.0", fixed: [] }] }];
    },
  };
  const report = await advisoryReport({ pin, channel: "nightly", overrides: OVERRIDES, now: () => new Date("2026-10-30T20:00:00Z") }, io);
  const gaps = [`the staged production install: the evaluate job left no stage record for ${sha("0").slice(0, 10)}`];
  assert.deepEqual(report, { checkedAt: "2026-10-30T20:00:00.000Z", channel: "nightly", release: PINNED, sha: sha("0"), packages: seen[0].length, sources: [], gaps, open: [{ id: "GHSA-x", severity: "HIGH", packages: [{ pkg: "newdep@3.0.0", fixed: [], ships: { how: "unknown", via: [] } }] }] });
  assert.ok(seen[0].includes("newdep@3.0.0") && !seen[0].includes("only-via-vuln@1.0.0"));
  assert.ok(seen[0].includes("agent-device@0.21.31") && !seen[0].includes("agent-device@0.21.20"), "an old approval isn't installed");
  // No resolved lockfile (a failed evaluation): still checked, upstream's lockfile standing in, with a gap.
  const fallback = await advisoryReport({ pin: { ...pin, channels: { nightly: { ...pin.channels.nightly, sha: sha("9") } } }, channel: "nightly", overrides: OVERRIDES }, io);
  assert.match(fallback.gaps[0], /left no resolved lockfile for 9999999999; upstream's lockfile with the overrides applied stands in/);
  await assert.rejects(advisoryReport({ pin, channel: "stable", overrides: OVERRIDES }, io), /no stable pin/);
});
