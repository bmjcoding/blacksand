// node --test test/: what the pin a tip builds rests on, and which gates it
// passes, worked out by the check hourly self-update and a fresh clone share
// (lib/selfupdate.mjs checkTip, pinBasis): along the tip's first parents only, an
// owner commit vouches for a pin by changing pin.json over its own first parent,
// so an owner pin on a merged side branch vouches for nothing on main; device
// tools are checked for each evaluator commit that approves one, against the
// release it moves to; dependencies once, from the pin trusted on the line to the
// pin built. (test/commit-trust.test.mjs: who may sign along the history.)
// Throwaway repositories and keys (test/trust-fixtures.mjs); npm is mocked.
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { NIGHTLY, OLD_DEPS, YOUNG, ago, fixture, mockFetch, npm, npmRoutes, pin, recorded, run } from "./trust-fixtures.mjs";

const T = Date.now();
const noAdvisories = async () => [];
/** verifyHead at T, with the registry's clock at T. */
const verify = (f, repo, opts = {}) => f.verify(repo, { now: T, clock: async () => T, ...opts });
/** Hourly self-update of the fixture's clone at T. */
const hourly = (f, opts = {}) => f.update({ now: T, advisories: noAdvisories, ...opts });
const head = (repo) => run(repo, ["rev-parse", "HEAD"]);
const treeOf = (f, rev = "HEAD") => run(f.origin, ["rev-parse", `${rev}^{tree}`]);

test("an owner pin on a merged side branch vouches for nothing on main: the evaluator pin main keeps goes through the gates, hourly as fresh", async () => {
  for (const mode of ["mismatched-tag", "young-dependency"]) {
    const name = `hist-side-${mode}`;
    const f = mode === "young-dependency" ? fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, OLD_DEPS] }) : fixture();
    mockFetch(mode === "young-dependency" ? npmRoutes({ [name]: { "1.0.0": { publishedAt: new Date(T - 3_600_000).toISOString(), integrity: YOUNG } } }) : {});
    const base = head(f.origin);
    assert.equal((await verify(f, f.clone)).result, "verified");
    // Main: the evaluator's pin, needing the gates (a tag another commit than it names, or an hour-old dependency).
    const bot = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), mode === "young-dependency" ? f.shas[1] : f.shas[0]) }, "evaluator pin");
    const botTree = treeOf(f);
    // A side branch from the base where the owner pins something else; the owner merges it, keeping the evaluator's pin.
    run(f.origin, ["reset", "-q", "--hard", base]);
    const side = f.commit(f.owner, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "owner side branch");
    f.merge([bot, side], botTree);
    const want = mode === "young-dependency" ? "held" : "refused";
    assert.equal((await verify(f, f.fresh())).result, want, mode);
    assert.equal(await hourly(f), want, mode);
    assert.deepEqual([f.head(), recorded(f.clone)], [base, base], `${mode}: nothing lands, the record stays the base's`);
    assert.match(f.logs.at(-1), new RegExp(`^self-update ${want}: evaluator commit ${bot.slice(0, 10)} pins `), mode);
  }
});

test("over every merge shape (which line has the evaluator's pin, which the owner's, which parent is first, whose tree is kept), hourly self-update and a fresh walk agree, and what's recorded is the tip checked", async () => {
  let cases = 0;
  const outcomes = { updated: 0, refused: 0 };
  // One fixture, put back to its first commit for each shape.
  const f = fixture();
  const base = head(f.origin);
  mockFetch({});
  for (const botOnFirst of [true, false]) {
    for (const ownerPins of [true, false]) {
      for (const keepFirst of [true, false]) {
        for (const ownerSide of ["same", "other"]) {
          const why = `evaluator pin on the ${botOnFirst ? "first" : "second"} parent; owner ${ownerPins ? "pins" : "edits the README"} on the ${ownerSide} line; the merge keeps the ${keepFirst ? "first" : "second"} parent's tree`;
          for (const repo of [f.origin, f.clone]) run(repo, ["reset", "-q", "--hard", base]);
          assert.equal((await verify(f, f.clone)).result, "verified");
          // The evaluator's pin needs the gates, and fails them (its tag names another commit).
          const bot = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[0]) }, "evaluator pin");
          const owner = (onto) => {
            run(f.origin, ["reset", "-q", "--hard", onto]);
            return f.commit(f.owner, ownerPins ? { "pin.json": pin(NIGHTLY(3940), f.shas[2]) } : { "README.md": "owner\n" }, "owner");
          };
          // The owner's commit on the evaluator's line (after it), or on the other line (from the base).
          const evaluatorLine = ownerSide === "same" ? owner(bot) : bot;
          const otherLine = ownerSide === "same" ? (run(f.origin, ["reset", "-q", "--hard", base]), f.commit(f.owner, { "README.md": "other\n" }, "other line")) : owner(base);
          const [first, second] = botOnFirst ? [evaluatorLine, otherLine] : [otherLine, evaluatorLine];
          const tip = f.merge([first, second], treeOf(f, keepFirst ? first : second));
          const fresh = await verify(f, f.fresh(`fresh-${cases}`));
          const result = await hourly(f);
          assert.equal(result === "updated", fresh.result === "verified", `${why}: hourly ${result}, fresh ${fresh.result} (${fresh.message})`);
          outcomes[result === "updated" ? "updated" : "refused"]++;
          assert.equal(recorded(f.clone), result === "updated" ? tip : base, why);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 16);
  // Most shapes are the owner changing pin.json on the line that is built (an override); three keep the evaluator's unvouched pin.
  assert.deepEqual(outcomes, { updated: 13, refused: 3 });
});

test("this clone's HEAD only a merge's second parent: the walk falls back to the first-parent line from the first commit, as a fresh clone's does", async () => {
  for (const [line, want] of [
    ["owner-readme", "verified"],
    ["bad-evaluator-pin", "refused"],
  ]) {
    const f = fixture();
    mockFetch({});
    const base = head(f.origin);
    const good = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "evaluator pin");
    assert.equal(await hourly(f), "updated");
    assert.equal((await verify(f, f.clone)).result, "verified");
    assert.equal(recorded(f.clone), good);
    run(f.origin, ["reset", "-q", "--hard", base]);
    const other = line === "owner-readme" ? f.commit(f.owner, { "README.md": "line\n" }, "owner line") : f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[0]) }, "evaluator pin, wrong commit for its tag");
    // The merge keeps the first parent's tree: what's built is that line's pin, which HEAD's record says nothing about.
    const tip = f.merge([other, good], treeOf(f, other));
    assert.equal((await verify(f, f.fresh())).result, want, line);
    assert.equal(await hourly(f), want === "verified" ? "updated" : "refused", line);
    assert.equal(f.head(), want === "verified" ? tip : good, line);
  }
});

test("an evaluator pin under HEAD that was never gated on its own (a later pin replaced it), brought back by a merge's first parent, goes through the gates, hourly as fresh", async () => {
  const f = fixture();
  mockFetch({});
  assert.equal((await verify(f, f.clone)).result, "verified");
  // In one batch: a pin whose tag names another commit, then a good one. Only the pin built is gated: taken.
  const bad = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[0]) }, "evaluator pin, wrong commit for its tag");
  const good = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "evaluator pin");
  assert.equal(await hourly(f), "updated");
  assert.equal(recorded(f.clone), good);
  // The owner works on from the bad pin and merges the good one in second, keeping the bad pin's tree.
  run(f.origin, ["reset", "-q", "--hard", bad]);
  const line = f.commit(f.owner, { "README.md": "owner\n" }, "owner, on the bad pin");
  f.merge([line, good], treeOf(f, line));
  const fresh = await verify(f, f.fresh());
  const result = await hourly(f);
  assert.deepEqual([fresh.result, result, f.head(), recorded(f.clone)], ["refused", "refused", good, good]);
  assert.match(f.logs.at(-1), new RegExp(`evaluator commit ${bad.slice(0, 10)} pins nightly to v0\\.1\\.6-nightly\\.20261030\\.3917 at `));
});

test("dependencies are measured once, from the pin trusted on the line to the pin built: a young release passed over isn't asked about, one the owner pinned isn't asked again", async () => {
  // Two evaluator pins after the owner's: 3917 (adds the young dependency), then 3940 (drops it).
  {
    const name = "hist-span";
    const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, OLD_DEPS] });
    f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
    const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "Pin nightly");
    const asked = [];
    mockFetch({}, (url) => asked.push(url));
    // What's built is 3940, which adds nothing over the owner's 3904: no dependency asked for, no clock either.
    const verdict = await verify(f, f.fresh(), { clock: async () => assert.fail("nothing was taken on its age") });
    assert.equal(verdict.result, "verified", verdict.message);
    assert.match(verdict.message, new RegExp(`^${tip.slice(0, 10)} verified here \\(2 evaluator commit\\(s\\) since \\w+\\)$`));
    assert.deepEqual(asked, []);
  }
  // 3917 and 3940 both add an hour-old dependency over 3904: the owner pins 3917 (vouching for it), the evaluator moves on to 3940.
  {
    const name = "hist-vouched";
    const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }] });
    mockFetch(npmRoutes({ [name]: { "1.0.0": { publishedAt: new Date(T - 3_600_000).toISOString(), integrity: YOUNG } } }));
    assert.equal((await verify(f, f.clone)).result, "verified");
    f.commit(f.owner, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "owner pin");
    const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "evaluator pin");
    assert.equal((await verify(f, f.fresh())).result, "verified");
    assert.equal(await hourly(f), "updated");
    assert.equal(recorded(f.clone), tip);
  }
});

// ------------------------------------------------------------ device tools --

/** Upstream release `n`, installing `version` of the fixture's device tool. */
function release(f, n, version) {
  fs.writeFileSync(path.join(f.upstream, "apps/server/src/device/deviceToolVersions.json"), JSON.stringify({ "trust-su-tool": version }));
  run(f.upstream, ["add", "-A"]);
  run(f.upstream, ["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", `release ${n}`]);
  const sha = run(f.upstream, ["rev-parse", "HEAD"]);
  run(f.upstream, ["tag", NIGHTLY(n), sha]);
  return sha;
}
const toolVersions = () => npm("trust-su-tool", Object.fromEntries(["1.0.0", "1.1.0", "1.2.0"].map((v) => [v, { files: { "index.js": "module.exports = {};\n" }, publishedAt: ago(30) }])));

test("a device tool approval is checked against the release of the evaluator commit that adds it: carried forward through two releases, it passes one at a time, as one batch, and on a fresh clone", async () => {
  const f = fixture({ knownTools: "trust-su-tool@1.0.0" });
  mockFetch(toolVersions());
  const sequential = f.fresh("sequential");
  assert.equal((await verify(f, f.clone)).result, "verified");
  assert.equal((await verify(f, sequential)).result, "verified");
  const first = f.commit(f.bot, { "pin.json": pin(NIGHTLY(4000), release(f, 4000, "1.1.0"), ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0"]) }, "tool 1.1.0");
  assert.equal(await hourly(f, { repo: sequential }), "updated");
  assert.equal(recorded(sequential), first);
  const second = f.commit(f.bot, { "pin.json": pin(NIGHTLY(4100), release(f, 4100, "1.2.0"), ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0", "trust-su-tool@1.2.0"]) }, "tool 1.2.0, 1.1.0 still approved");
  assert.equal(await hourly(f, { repo: sequential }), "updated");
  assert.equal(recorded(sequential), second);
  // The same two commits in one batch, and in a fresh clone.
  assert.equal(await hourly(f), "updated");
  assert.equal(recorded(f.clone), second);
  assert.equal((await verify(f, f.fresh())).result, "verified");
});

test("an approval its own release doesn't install is refused, though the release built later does install it", async () => {
  const f = fixture({ knownTools: "trust-su-tool@1.0.0" });
  mockFetch(toolVersions());
  const base = f.head();
  assert.equal((await verify(f, f.clone)).result, "verified");
  // 4000 installs 1.1.0, but this commit approves 1.2.0 too; the next one moves to 4100, which does install it.
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(4000), release(f, 4000, "1.1.0"), ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0", "trust-su-tool@1.2.0"]) }, "approval its release doesn't install");
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(4100), release(f, 4100, "1.2.0"), ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0", "trust-su-tool@1.2.0"]) }, "the release that installs it");
  assert.equal(await hourly(f), "refused");
  assert.match(f.logs.at(-1), /approves trust-su-tool@1\.2\.0, which v0\.1\.6-nightly\.20261030\.4000 doesn't pin/);
  assert.equal(f.head(), base);
  assert.equal((await verify(f, f.fresh())).result, "refused");
});
