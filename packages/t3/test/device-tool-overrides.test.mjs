// node --test test/: device tool security overrides. Upstream's
// nightlies pin agent-device@0.21.31, inside two high advisories fixed in 0.21.35;
// lib/overrides.json's deviceTools raises it within its line (rule
// server/device-tool-overrides), and everything that counts what a build installs
// counts 0.21.35: the evaluator, pin-check, self-update's review and the build,
// each holding a young fix to the security fast lane (lib/device-tools.mjs
// toolFastLane), worked out the same way everywhere. Recorded npm answers in
// test/fixtures/advisories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deviceToolPins } from "../lib/build.mjs";
import { deviceToolLocks, lockEntry, toolFastLane, verifyToolLock } from "../lib/device-tools.mjs";
import { evaluateChannel } from "../lib/evaluate.mjs";
import { makeFastLane } from "../lib/fastlane.mjs";
import { reviewAddedDeviceTools } from "../lib/gates.mjs";
import { alertInventory, deviceToolsInUse } from "../lib/inventory.mjs";
import { applyOverrides, overrideYamlLines, parseToolOverrides, raiseDeviceTools, raiseToolVersions, readToolOverrides, toolOverrideFor } from "../lib/overrides.mjs";
import { verifyCandidate } from "../lib/pincheck.mjs";
import { readPin } from "../lib/pin.mjs";
import { makeRules } from "../lib/rules.mjs";
import { featureIndex } from "../lib/features.mjs";
import { RuleDrift } from "../lib/strip-engine.mjs";
import { RESOLVED, UPSTREAM } from "./pipeline-fixtures.mjs";
import { NIGHTLY, mockFetch as mockRoutes } from "./trust-fixtures.mjs";

const fixtureJson = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/advisories/${name}`, import.meta.url), "utf8"));
const NPM = fixtureJson("npm-agent-device.json").body;
const ATTESTATIONS = fixtureJson("npm-attestations-agent-device-0.21.35.json").body;
const REPO_ADVISORIES = fixtureJson("github-repo-advisories-callstack-agent-device.json").body;

const AGENT = { selector: "agent-device@0.21.31", version: "0.21.35", advisories: ["GHSA-6845-fcpx-jc45", "GHSA-xr68-vpwv-cgg9"] };
const OVERRIDES_TEXT = (deviceTools) => JSON.stringify({ overrides: [], deviceTools });
/** 2026-10-31 12:00 UTC: 0.21.35 (published 2026-10-29T19:10:31Z) is 1.7 days old. */
const MORNING = Date.parse("2026-10-31T12:00:00Z");
const PIN = readPin();
const meta = async (name) => (name === "agent-device" ? NPM : null);
/** Advisories as the sources answer for agent-device (recorded): 0.21.31 has the two, 0.21.35 none. */
const recordedAdvisories = async (packages) =>
  packages.includes("agent-device@0.21.31")
    ? REPO_ADVISORIES.filter((a) => a.ghsa_id === "GHSA-6845-fcpx-jc45" || a.ghsa_id === "GHSA-xr68-vpwv-cgg9").map((a) => ({ id: a.ghsa_id, aliases: [], severity: "HIGH", packages: [{ pkg: "agent-device@0.21.31", fixed: ["0.21.35"] }], sources: ["github-repository"] }))
    : [];

test("lib/overrides.json deviceTools: the shape and the rules an entry is held to", () => {
  assert.deepEqual(parseToolOverrides(JSON.stringify({ overrides: [] })), [], "none is fine");
  assert.deepEqual(parseToolOverrides(OVERRIDES_TEXT([AGENT])), [AGENT]);
  for (const [entry, why] of [
    [{ ...AGENT, version: "0.22.0" }, /newer version in the same major line/],
    [{ ...AGENT, version: "0.21.30" }, /newer version in the same major line/],
    [{ ...AGENT, advisories: [] }, /must name the advisories it fixes/],
    [{ ...AGENT, advisories: ["see the issue"] }, /must name the advisories it fixes/],
    [{ ...AGENT, selector: "agent-device@latest" }, /invalid deviceTools entry/],
    [{ ...AGENT, version: "v0.21.35" }, /invalid deviceTools entry/],
  ]) {
    assert.throws(() => parseToolOverrides(OVERRIDES_TEXT([entry])), why, JSON.stringify(entry));
  }
  assert.throws(() => parseToolOverrides(OVERRIDES_TEXT([AGENT, { ...AGENT, selector: "agent-device@0.21.20", version: "0.21.40" }])), /two entries for agent-device@0\.21\.20's line/);
  assert.throws(() => parseToolOverrides(JSON.stringify({ overrides: [], deviceTools: {} })), /deviceTools isn't a list/);
});

test("a span is the selector's line, prereleases in it included, up to the fix; nothing else moves", () => {
  const canary = { selector: "expo-device-hub@0.19.0-canary-20261023-1357114", version: "0.19.1", advisories: ["GHSA-test-test-test"] };
  assert.deepEqual(
    raiseDeviceTools(["agent-device@0.21.31", "agent-device@0.21.33", "agent-device@0.21.0-rc.1", "agent-device@0.21.35", "agent-device@0.21.36", "agent-device@0.20.9", "agent-device@0.22.0", "other@0.21.31"], [AGENT]),
    ["agent-device@0.21.35", "agent-device@0.21.35", "agent-device@0.21.35", "agent-device@0.21.35", "agent-device@0.21.36", "agent-device@0.20.9", "agent-device@0.22.0", "other@0.21.31"],
  );
  assert.deepEqual(raiseDeviceTools(["expo-device-hub@0.19.0-canary-20261023-1357114"], [canary]), ["expo-device-hub@0.19.1"], "a canary is raised by its own entry");
  assert.equal(toolOverrideFor("agent-device@not-semver", [AGENT]), null);
  // Applied twice, the same: a fix is never inside a span.
  assert.deepEqual(raiseDeviceTools(raiseDeviceTools(["agent-device@0.21.31"], [AGENT]), [AGENT]), ["agent-device@0.21.35"]);
});

test("rule server/device-tool-overrides rewrites what the app installs, and is strict", () => {
  const upstream = `{\n  "agent-device": "0.21.31",\n  "expo-device-hub": "0.19.0-canary-20261023-1357114"\n}\n`;
  assert.equal(raiseToolVersions(upstream, [AGENT]), `{\n  "agent-device": "0.21.35",\n  "expo-device-hub": "0.19.0-canary-20261023-1357114"\n}\n`);
  assert.equal(raiseToolVersions(upstream, []), upstream, "nothing to raise: upstream's bytes");
  assert.throws(() => raiseToolVersions('{"agent-device": "^0.21.31"}', [AGENT]), RuleDrift);
  assert.throws(() => raiseToolVersions("[]", [AGENT]), RuleDrift);
  const rules = makeRules({ updater: { node: "/n", launcher: "/l", path: "/p" }, build: null });
  const rule = rules.find((r) => r.id === "server/device-tool-overrides");
  assert.equal(rule.kind, "transform");
  assert.equal(rule.file, "apps/server/src/device/deviceToolVersions.json");
  assert.equal(featureIndex(rules).has(rule.id), false, "strict: a build without it stops");
  // The build counts what the rule will install, before and after the rules run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-tool-overrides-"));
  try {
    fs.mkdirSync(path.join(dir, "apps/server/src/device"), { recursive: true });
    fs.writeFileSync(path.join(dir, "apps/server/src/device/deviceToolVersions.json"), upstream);
    const before = deviceToolPins(dir);
    fs.writeFileSync(path.join(dir, "apps/server/src/device/deviceToolVersions.json"), rule.transform(upstream));
    assert.deepEqual(deviceToolPins(dir), before);
    assert.deepEqual(before, raiseDeviceTools(["agent-device@0.21.31", "expo-device-hub@0.19.0-canary-20261023-1357114"]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("this repo: the agent-device overrides, and pin.json keeps the reviewed lock every device tool override's fix installs from", () => {
  const overrides = readToolOverrides();
  assert.deepEqual(overrides.find((o) => o.selector === "agent-device@0.21.31"), AGENT);
  const known = fs.readFileSync(new URL("../lib/known-device-tools.txt", import.meta.url), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim());
  for (const o of overrides) {
    const fix = `${o.selector.slice(0, o.selector.lastIndexOf("@"))}@${o.version}`;
    assert.ok(known.includes(fix) || PIN.deviceTools.includes(fix), `${fix} is reviewed`);
    assert.ok(PIN.deviceToolLocks[fix], `pin.json keeps ${fix}'s lock`);
  }
  const lock = PIN.deviceToolLocks["agent-device@0.21.35"];
  assert.equal(lock.sha256, "f4947eac438f3652220296135333c4c984d0b228d2800e849ea085b3fa4b44e6");
  assert.deepEqual(Object.keys(JSON.parse(lock.lock).packages), ["", "node_modules/agent-device"], "no dependencies, as 0.21.31");
  assert.deepEqual(deviceToolsInUse(JSON.stringify({ "agent-device": "0.21.31", "expo-device-hub": "0.19.0-canary-20261023-1357114" })), ["agent-device@0.21.35", "expo-device-hub@0.19.0-canary-20261023-1357114"]);
  // Upstream's scripts/ workspace (its mobile test tooling) depends on agent-device@0.21.32 through
  // the lockfile, a build-time copy the advisories cover too: a pnpm override raises it to the same fix.
  assert.deepEqual(applyOverrides(["agent-device@0.21.32"]), ["agent-device@0.21.35"]);
  assert.match(overrideYamlLines(), /^ {2}"agent-device@>=0\.21\.0 <0\.21\.35": 0\.21\.35$/m);
});

test("verifyToolLock: the young fix installs only through the fast lane, against the closure reviewed before (recorded npm)", async () => {
  const entry = PIN.deviceToolLocks["agent-device@0.21.35"];
  await assert.rejects(verifyToolLock("agent-device@0.21.35", entry, { now: MORNING, meta }), /agent-device@0\.21\.35 \(published 2026-10-29T19:10:31\.794Z, under 3 days ago\)/);
  const continuity = async (name, version, { accepted }) => ({ ok: name === "agent-device" && version === "0.21.35" && accepted.includes("0.21.31"), summary: "publisher GitHub Actions" });
  const lane = (o) => makeFastLane({ ...o, continuity });
  const waive = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: PIN.deviceToolLocks["agent-device@0.21.31"], now: MORNING, advisories: recordedAdvisories, lane });
  const ok = await verifyToolLock("agent-device@0.21.35", entry, { now: MORNING, meta, waive });
  assert.deepEqual(ok.waived, [{ pkg: "agent-device@0.21.35", reason: "fixes GHSA-6845-fcpx-jc45, GHSA-xr68-vpwv-cgg9 (publisher GitHub Actions)" }]);
  // Only agent-device's repository published these: without an override the owner signed naming them, they open nothing.
  const unvouched = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: PIN.deviceToolLocks["agent-device@0.21.31"], now: MORNING, toolOverrides: [], advisories: recordedAdvisories, lane });
  await assert.rejects(verifyToolLock("agent-device@0.21.35", entry, { now: MORNING, meta, waive: unvouched }), /no security fast lane: it fixes no advisory open against agent-device@0\.21\.31's closure \(one only a repository published counts only for the version a device tool override names\)/);
  const other = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: PIN.deviceToolLocks["agent-device@0.21.31"], now: MORNING, toolOverrides: [{ ...AGENT, advisories: ["GHSA-xr68-vpwv-cgg9"] }], advisories: recordedAdvisories, lane });
  assert.equal((await other("agent-device@0.21.35")).reason, "fixes GHSA-xr68-vpwv-cgg9 (publisher GitHub Actions)", "only the vouched one");
  // Nothing open against the previous closure: no fast lane, and why.
  const none = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: PIN.deviceToolLocks["agent-device@0.21.31"], now: MORNING, advisories: async () => [], lane });
  await assert.rejects(verifyToolLock("agent-device@0.21.35", entry, { now: MORNING, meta, waive: none }), /no security fast lane: it fixes no advisory open against agent-device@0\.21\.31's closure/);
  // An advisory source down: fail closed.
  const down = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", now: MORNING, advisories: async () => { throw new Error("GitHub's API rate limit is used up"); }, lane });
  await assert.rejects(verifyToolLock("agent-device@0.21.35", entry, { now: MORNING, meta, waive: down }), /no security fast lane: the advisories against agent-device@0\.21\.31 couldn't be read \(GitHub's API rate limit is used up\)/);
  // No earlier version reviewed: nothing to measure a fix against.
  const first = toolFastLane("agent-device@0.21.35", { now: MORNING, advisories: recordedAdvisories, lane });
  assert.match((await first("agent-device@0.21.35")).why, /no earlier reviewed version of agent-device/);
  // A previous lock that isn't what was reviewed is refused, not used.
  const forged = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: { ...PIN.deviceToolLocks["agent-device@0.21.31"], sha256: "0".repeat(64) }, now: MORNING, advisories: recordedAdvisories, lane });
  assert.match((await forged("agent-device@0.21.35")).why, /kept lockfile doesn't match its sha256/);
  // On 2026-11-01T19:10:31Z it's 3 days old: no fast lane needed.
  assert.deepEqual((await verifyToolLock("agent-device@0.21.35", entry, { now: Date.parse("2026-11-01T19:11:00Z"), meta })).waived, []);
});

test("the fast lane's publisher continuity for 0.21.35, from npm's recorded packument and provenance", async () => {
  mockRoutes({
    "https://registry.npmjs.org/agent-device": () => new Response(JSON.stringify(NPM), { status: 200 }),
    "https://registry.npmjs.org/-/npm/v1/attestations/agent-device@0.21.35": () => new Response(JSON.stringify(ATTESTATIONS), { status: 200 }),
  });
  const waive = toolFastLane("agent-device@0.21.35", { previous: "agent-device@0.21.31", previousLock: PIN.deviceToolLocks["agent-device@0.21.31"], now: MORNING, advisories: recordedAdvisories });
  assert.deepEqual(await waive("agent-device@0.21.35"), {
    reason: "fixes GHSA-6845-fcpx-jc45, GHSA-xr68-vpwv-cgg9 (publisher GitHub Actions, provenance (unverified) names https://github.com/callstack/agent-device refs/tags/v0.21.35)",
  });
  assert.equal((await waive("agent-device@0.21.34")).reason, null, "still vulnerable: no fix");
});

test("reviewAddedDeviceTools hands the tool's review and its closure one fast lane, against the version and lock reviewed before", async () => {
  const seen = [];
  const results = await reviewAddedDeviceTools(["agent-device@0.21.31"], ["agent-device@0.21.31", "agent-device@0.21.35"], {
    isKnownHost: () => false,
    now: MORNING,
    latest: async () => "agent-device@0.21.31",
    locks: { "agent-device@0.21.35": PIN.deviceToolLocks["agent-device@0.21.35"] },
    previousLocks: { "agent-device@0.21.31": PIN.deviceToolLocks["agent-device@0.21.31"] },
    advisories: recordedAdvisories,
    review: async (tool, previous, opts) => {
      seen.push(["review", previous, opts.waive]);
      return { ok: true, pin: tool, reasons: [], notes: ["fast lane: agent-device@0.21.35: x"] };
    },
    closure: async (tool, previous, opts) => {
      seen.push(["closure", previous, opts.waive, opts.previousLock, opts.lock]);
      return { ok: true, pin: tool, reasons: [], notes: [], lock: opts.lock };
    },
  });
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[0].notes, ["fast lane: agent-device@0.21.35: x"]);
  assert.equal(seen[0][2], seen[1][2], "the same lane");
  assert.equal(typeof seen[0][2], "function");
  assert.deepEqual(seen[1].slice(3), [PIN.deviceToolLocks["agent-device@0.21.31"], PIN.deviceToolLocks["agent-device@0.21.35"]]);
});

test("the build's deviceToolLocks measures a young fix against the tool's newest other reviewed version and its lock", async () => {
  const lanes = [];
  await assert.rejects(
    deviceToolLocks(["agent-device@0.21.35"], {
      pinJson: PIN,
      nativeAssets: { assets: [] },
      reviewed: ["agent-device@0.21.25", "agent-device@0.21.31", "agent-device@0.21.35"],
      latest: async (name, others) => (lanes.push(others), "agent-device@0.21.31"),
      lane: (pin, opts) => {
        lanes.push([pin, opts.previous, opts.previousLock]);
        return async () => ({ reason: null, why: "test lane" });
      },
      now: MORNING,
      meta,
    }),
    /no security fast lane: test lane/,
  );
  assert.deepEqual(lanes, [["agent-device@0.21.25", "agent-device@0.21.31"], ["agent-device@0.21.35", "agent-device@0.21.31", PIN.deviceToolLocks["agent-device@0.21.31"]]]);
  // Through the lane, the lock is baked in and the build log says why it went early.
  const logged = [];
  const built = await deviceToolLocks(["agent-device@0.21.35"], {
    pinJson: PIN,
    nativeAssets: { packages: {} },
    latest: async () => "agent-device@0.21.31",
    lane: () => async () => ({ reason: "fixes GHSA-6845-fcpx-jc45" }),
    report: (line) => logged.push(line),
    fetch: async (name, version, into) => {
      fs.mkdirSync(path.join(into, "package"), { recursive: true });
      fs.writeFileSync(path.join(into, "package", "package.json"), JSON.stringify({ name, version }));
      return { dir: path.join(into, "package") };
    },
    now: MORNING,
    meta,
  });
  assert.equal(built["agent-device@0.21.35"].lock, PIN.deviceToolLocks["agent-device@0.21.35"].lock);
  assert.deepEqual(built["agent-device@0.21.35"].needs, []);
  assert.deepEqual(logged, ["device tool agent-device@0.21.35: fast lane: agent-device@0.21.35: fixes GHSA-6845-fcpx-jc45"]);
});

/** A pin-check io: upstream's release `at` pins agent-device@`tools[at]`; everything else passes. */
function pincheckIo({ tools, toolOverrides, reviews = [] }) {
  return {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : JSON.stringify({ "agent-device": tools[at] })),
    unreleasedPin: () => null,
    knownDeviceTools: () => new Set(),
    toolOverrides,
    reviewAddedDeviceTools: async (previous, next) => {
      const added = next.filter((tool) => !previous.includes(tool));
      reviews.push(added);
      return added.map((tool) => ({ tool, ok: true, reasons: [] }));
    },
    resolvedLock: () => UPSTREAM,
    dependencyAgeGate: async () => ({ ok: true, added: 0, young: [], waived: [], unknown: [], substituted: [] }),
    openAdvisories: async () => [],
    makeFastLane: () => async () => null,
    npmMeta: async () => null,
    checkRules: () => ({ ok: true, skipped: [] }),
    log: () => {},
  };
}

test("pin-check: a release pinning agent-device@0.21.31 installs 0.21.35 under the override, so that's the approval in scope", async () => {
  const sha = (c) => c.repeat(40);
  const LOCK = (tool) => lockEntry(`${JSON.stringify({ lockfileVersion: 3, tool })}\n`);
  const entry = (ref, at) => ({ ref, sha: at, evaluatedAt: "2026-10-31T00:00:00.000Z", leftOut: [] });
  const current = { version: 1, channels: { nightly: entry(NIGHTLY(3917), sha("0")) }, deviceTools: ["agent-device@0.21.31"], deviceToolLocks: { "agent-device@0.21.31": LOCK("agent-device@0.21.31") } };
  const candidate = {
    ...current,
    channels: { nightly: entry(NIGHTLY(3940), sha("a")) },
    deviceTools: ["agent-device@0.21.31", "agent-device@0.21.35"],
    deviceToolLocks: { ...current.deviceToolLocks, "agent-device@0.21.35": LOCK("agent-device@0.21.35") },
  };
  const tools = { [sha("0")]: "0.21.31", [sha("a")]: "0.21.31" };
  const reviews = [];
  // (The resolved lockfile is upstream's own here: it fits.)
  assert.equal(await verifyCandidate({ current, candidate, channel: "nightly" }, pincheckIo({ tools, toolOverrides: [AGENT], reviews })), "changed");
  assert.deepEqual(reviews, [["agent-device@0.21.35"]]);
  await assert.rejects(verifyCandidate({ current, candidate, channel: "nightly" }, pincheckIo({ tools, toolOverrides: [] })), /approves device tools v0\.1\.6-nightly\.20261030\.3940 doesn't pin: agent-device@0\.21\.35/);
  // Under the override, the release's vulnerable pin needs no approval of its own, and its fix needs its lock.
  const unlocked = { ...candidate, deviceToolLocks: current.deviceToolLocks };
  await assert.rejects(verifyCandidate({ current, candidate: unlocked, channel: "nightly" }, pincheckIo({ tools, toolOverrides: [AGENT] })), /no dependency lockfile for device tools it pins: agent-device@0\.21\.35/);
});

test("the evaluator reviews the raised version, keeps its lock, and reports a fast-laned fix", async () => {
  const sha = (c) => c.repeat(40);
  const LOCK = (tool) => lockEntry(`${JSON.stringify({ lockfileVersion: 3, tool })}\n`);
  const pin = { version: 1, channels: { nightly: { ref: NIGHTLY(3917), sha: sha("0"), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } }, deviceTools: ["agent-device@0.21.31"], deviceToolLocks: { "agent-device@0.21.31": LOCK("agent-device@0.21.31") } };
  const reviewed = [];
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : JSON.stringify({ "agent-device": "0.21.31" })),
    revParse: (ref) => (ref === NIGHTLY(3940) ? sha("a") : sha("0")),
    tags: () => [NIGHTLY(3917), NIGHTLY(3940)],
    knownDeviceTools: () => new Set(),
    toolOverrides: [AGENT],
    reviewAddedDeviceTools: async (previous, next) => {
      const added = next.filter((tool) => !previous.includes(tool));
      reviewed.push(added);
      return added.map((tool) => ({ tool, ok: true, reasons: [], notes: [`fast lane: ${tool}: fixes GHSA-6845-fcpx-jc45`], lock: LOCK(tool) }));
    },
    proposeToolLock: async () => assert.fail("the review kept a lock"),
    dependencyAgeGate: async () => ({ ok: true, added: 0, young: [], waived: [], unknown: [], substituted: [] }),
    openAdvisories: async () => [],
    makeFastLane: () => async () => null,
    checkRules: () => ({ ok: true, skipped: [] }),
    resolveLock: () => UPSTREAM,
    npmMeta: async () => null,
    log: () => {},
  };
  const result = await evaluateChannel({ channel: "nightly", pin, now: () => new Date("2026-10-31T06:00:00Z") }, io);
  assert.equal(result.exitCode, 0, result.report);
  assert.deepEqual(reviewed, [["agent-device@0.21.35"]]);
  assert.deepEqual(result.pin.deviceTools, ["agent-device@0.21.31", "agent-device@0.21.35"]);
  assert.ok(result.pin.deviceToolLocks["agent-device@0.21.35"]);
  assert.match(result.report, /Security fixes taken ahead of the age gate:\n- agent-device@0\.21\.35: fixes GHSA-6845-fcpx-jc45/);
});

test("the alert inventory holds the raised tool and its frozen closure, not the vulnerable pin", async () => {
  const show = (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : JSON.stringify({ "agent-device": "0.21.31" }));
  const asked = [];
  const { packages, tools } = await alertInventory(
    { sha: "0".repeat(40), show, resolvedLock: RESOLVED, toolPackages: (tool) => (asked.push(tool), [tool]), stage: null, overrides: [{ selector: "vuln@1.0.0", version: "1.0.1", advisories: ["GHSA-test"] }], toolOverrides: [AGENT], blackout: "b" },
    { meta: async (name) => ({ "newdep": { versions: { "3.0.0": {} } }, vuln: { versions: { "1.0.1": { dependencies: { newdep: "^3.0.0" } } } } })[name] ?? null },
  );
  assert.deepEqual(tools, ["agent-device@0.21.35"]);
  assert.deepEqual(asked, ["agent-device@0.21.35"]);
  assert.ok(packages.includes("agent-device@0.21.35") && !packages.includes("agent-device@0.21.31"));
});
