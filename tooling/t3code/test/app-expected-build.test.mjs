// node --test test/*.test.mjs: the app installs only the build it chose (lib/expect.mjs).
// A download names the checked commit, never the mutable tag; a staged build counts as
// built only if this checkout's strip rules made it, since `update` would rebuild one
// made with other rules, so `poll` offers that one as a download instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";

import { expectedBuild, isExpectedBuild, pollOffer, staleRulesProblem, unexpectedBuildMessage } from "../lib/expect.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const OTHER_RULES = "c".repeat(40);
const OLD_RULES = "1".repeat(40);
const RULES = "2".repeat(40);

test("no expectation accepts any build, as the hourly updater and launch need", () => {
  assert.equal(expectedBuild({}), null);
  assert.equal(isExpectedBuild({ sha: A, blacksand: OTHER_RULES }, null), true);
});

test("an expected commit must be a full SHA", () => {
  assert.deepEqual(expectedBuild({ "expect-sha": A }), { sha: A, blacksand: null });
  assert.deepEqual(expectedBuild({ "expect-sha": A, "expect-blacksand": OTHER_RULES }), { sha: A, blacksand: OTHER_RULES });
  for (const opts of [{ "expect-sha": "v0.1.6-nightly.20261030.3917" }, { "expect-sha": A.slice(0, 10) }, { "expect-blacksand": OTHER_RULES }, { "expect-sha": A, "expect-blacksand": "main" }]) {
    assert.throws(() => expectedBuild(opts));
  }
});

test("a moved release or a different staged build is refused", () => {
  const expected = expectedBuild({ "expect-sha": A, "expect-blacksand": OTHER_RULES });
  assert.equal(isExpectedBuild({ sha: A, blacksand: OTHER_RULES }, expected), true);
  assert.equal(isExpectedBuild({ sha: B, blacksand: OTHER_RULES }, expected), false, "the hourly updater staged another release");
  assert.equal(isExpectedBuild({ sha: A, blacksand: B }, expected), false, "the same release rebuilt with other rules");
  assert.equal(isExpectedBuild(null, expected), false);
  assert.equal(isExpectedBuild({ sha: A, blacksand: B }, expectedBuild({ "expect-sha": A })), true, "a download names only the commit");
  assert.match(unexpectedBuildMessage("the staged build", { version: "0.1.7", sha: B, blacksand: OTHER_RULES }, expected), /0\.1\.7 \(bbbbbbbbbb, rules cccccccccc\), not the aaaaaaaaaa \(rules cccccccccc\)/);
});

test("the app's updater passes what it chose to the CLI", () => {
  const updater = fs.readFileSync(new URL("../lib/files/BlacksandUpdater.ts", import.meta.url), "utf8");
  assert.match(updater, /"--expect-sha",\n\s+target\.sha,/, "download names the checked commit");
  assert.doesNotMatch(updater, /"--ref", target\.ref/, "download never names the mutable tag");
  assert.match(updater, /\["--expect-sha", build\.sha, \.\.\.\(build\.blacksand \? \["--expect-blacksand", build\.blacksand\] : \[\]\)\]/);
  const cli = fs.readFileSync(new URL("../bin/t3", import.meta.url), "utf8");
  assert.match(cli, /"expect-sha": \{ type: "string" \}/);
  assert.match(cli, /applyPending\(expectedBuild\(opts\)\)/);
  assert.match(cli, /emit\(\{ type: "staged", ref, sha, version, blacksand \}\)/);
});

test("a build staged with other strip rules isn't installed", () => {
  assert.equal(staleRulesProblem({ sha: "a", blacksand: RULES }, RULES), null);
  assert.match(staleRulesProblem({ sha: "a", blacksand: OLD_RULES }, RULES), /made with blacksand-t3 111111111111, not this checkout's 222222222222/);
  assert.match(staleRulesProblem({ sha: "a" }, RULES), /\(unknown\)/);
  // No checkout identity (not a git clone): nothing to compare against.
  assert.equal(staleRulesProblem({ sha: "a", blacksand: OLD_RULES }, null), null);
});

// ------------------------------------------------------------------ poll --

const installed = { sha: B, ref: "v0.1.6", blacksand: OLD_RULES, installedAt: "2026-10-30T10:00:00.000Z" };
const staged = (sha, blacksand) => ({ sha, ref: sha === A ? "v0.1.7" : "v0.1.6", version: sha === A ? "0.1.7" : "0.1.6", blacksand, stagedAt: "2026-10-30T12:00:00.000Z" });
const newer = { ref: "v0.1.7", sha: A };
const same = { ref: "v0.1.6", sha: B };

test("poll offers a newer release as built only if this checkout's rules made it", () => {
  assert.deepEqual(pollOffer({ current: installed, pending: staged(A, RULES), target: newer, rules: RULES }), { ref: "v0.1.7", sha: A, staged: true, from: "target" });
  // Staged with older rules, then the repo self-updated to these: offered to build again.
  assert.deepEqual(pollOffer({ current: installed, pending: staged(A, OLD_RULES), target: newer, rules: RULES }), { ref: "v0.1.7", sha: A, staged: false, from: "target" });
  assert.equal(pollOffer({ current: installed, pending: staged(A, RULES), target: newer, rules: null }).staged, false, "no rules commit, nothing counts as built");
  // Without a mirror the staged build still needs this checkout's rules.
  assert.equal(pollOffer({ current: installed, pending: staged(A, RULES), target: null, rules: RULES }).staged, true);
  assert.deepEqual(pollOffer({ current: installed, pending: staged(A, OLD_RULES), target: null, rules: RULES }), { ref: "v0.1.7", sha: A, staged: false, from: "pending" });
});

test("poll: the installed release rebuilt with these rules waits for a restart; with older rules it's built again", () => {
  assert.deepEqual(pollOffer({ current: installed, pending: staged(B, RULES), target: same, rules: RULES }), { ref: "v0.1.6", sha: B, staged: true, from: "pending" });
  assert.deepEqual(pollOffer({ current: { ...installed, blacksand: "0".repeat(40) }, pending: staged(B, OLD_RULES), target: same, rules: RULES }), { ref: "v0.1.6", sha: B, staged: false, from: "pending" });
});

test("poll never offers a build of another release than update's, one staged before the install, or the one installed", () => {
  // The newer release is held now (its rules fail), so update stays on what's installed.
  assert.equal(pollOffer({ current: installed, pending: staged(A, RULES), target: same, rules: RULES }), null);
  assert.equal(pollOffer({ current: installed, pending: staged(A, OLD_RULES), target: same, rules: RULES }), null);
  assert.equal(pollOffer({ current: { ...installed, installedAt: "2026-10-30T13:00:00.000Z" }, pending: staged(B, RULES), target: same, rules: RULES }), null);
  assert.equal(pollOffer({ current: { ...installed, blacksand: RULES }, pending: staged(B, OLD_RULES), target: same, rules: RULES }), null);
  assert.equal(pollOffer({ current: installed, pending: null, target: same, rules: RULES }), null);
});

/** cmdPoll from bin/t3, run against stubbed records. */
function runPoll({ pending, target, rules }) {
  const source = fs.readFileSync(new URL("../bin/t3", import.meta.url), "utf8");
  const start = source.indexOf("async function cmdPoll(opts)");
  const end = source.indexOf("\nconst waitFor =", start);
  assert.ok(start !== -1 && end !== -1, "bin/t3's cmdPoll moved; update this test");
  const events = [];
  const context = vm.createContext({
    CURRENT: "current",
    console: { log: () => {} },
    process: { env: {} },
    readJson: () => installed,
    readPending: () => pending,
    hasMirror: () => target !== null,
    chooseTarget: async () => ({ ...target, held: [], verdict: null }),
    pollOffer,
    blacksandCommit: () => rules,
    versionOf: (ref) => ref.replace(/^v/, ""),
    notesFor: () => [],
    heldLine: () => "held",
    emit: (event) => events.push(event),
  });
  return vm.runInContext(`${source.slice(start, end)}\ncmdPoll({ offline: true, json: true })`, context).then(() => events);
}

test("the CLI's poll announces a build made with older rules as a download, which update rebuilds", async () => {
  const [stale] = await runPoll({ pending: staged(A, OLD_RULES), target: newer, rules: RULES });
  assert.deepEqual(JSON.parse(JSON.stringify(stale)), { type: "poll", update: { ref: "v0.1.7", sha: A, version: "0.1.7", staged: false, blacksand: null, releaseNotes: [] } });
  const [built] = await runPoll({ pending: staged(A, RULES), target: newer, rules: RULES });
  assert.equal(built.update.staged, true);
  assert.equal(built.update.blacksand, RULES, "apply is told the rules it was built with");
  const [fallback] = await runPoll({ pending: staged(B, OLD_RULES), target: same, rules: RULES });
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.update)), { ref: "v0.1.6", sha: B, version: "0.1.6", staged: false, blacksand: null, releaseNotes: [] });
});
