// node --test test/: the one check hourly self-update and a fresh clone's
// verifyHead share (lib/selfupdate.mjs checkTip). Trust comes from the history,
// never from HEAD: forward from the clone's first commit (or the one verified
// here), every commit needs a good SSH signature from a key its first parent's
// .allowed_signers lists, side branches included, and an evaluator commit only
// moves pin.json forward. The pin the tip builds rests on the newest owner pin
// along its first parents, and passes the gates from there: device tools per
// evaluator commit that approves one, dependencies once. A shallow or incomplete
// clone is refused; an age is taken only by a clock no more than 10 minutes ahead
// of the registry's; what's verified is recorded, and a record dated after the
// clock is checked again. (test/pin-trust.test.mjs: what the built pin rests
// on.) Throwaway repositories and keys (test/trust-fixtures.mjs); npm and the
// advisory sources are mocked, and so is the registry's clock unless a test says
// otherwise.
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_PRINCIPAL } from "../lib/selfupdate.mjs";
import { DAY, NIGHTLY, OLD_DEPS, YOUNG, fixture, forgeSigned, mockFetch, npmRoutes, pin, recorded, run, youngPin } from "./trust-fixtures.mjs";

const { verifyHead } = await import("../lib/selfupdate.mjs");
const { readPin } = await import("../lib/pin.mjs");
const { unpinnedProblem } = await import("../lib/channels.mjs");
const { registryTime } = await import("../lib/gates.mjs");

const T = Date.now();
const noAdvisories = async () => [];
const AHEAD = process.platform === "darwin" ? /this Mac's clock is ahead; turn on Set time automatically/ : /this machine's clock is ahead; turn on network time/;
/** verifyHead at T, with the registry's clock at `server` (T unless said). */
const verify = (f, repo, { server = T, ...opts } = {}) => f.verify(repo, { now: T, clock: async () => server, ...opts });
/** Hourly self-update of the fixture's clone at T. */
const hourly = (f, opts = {}) => f.update({ now: T, advisories: noAdvisories, ...opts });
const head = (repo) => run(repo, ["rev-parse", "HEAD"]);
const list = (entries) => entries.map(([principal, key]) => `${principal} namespaces="git" ${key.pub}\n`).join("");
const treeOf = (f, rev = "HEAD") => run(f.origin, ["rev-parse", `${rev}^{tree}`]);

// ---------------------------------------------------------- a fresh clone --

test("a fresh clone's evaluator pin adding a dependency under 3 days old isn't built until it's old enough, then is recorded and checked no more", async () => {
  const f = youngPin("hist-young", T);
  const tip = run(f.origin, ["rev-parse", "HEAD"]);
  const fresh = f.fresh();
  mockFetch(f.routes);
  const held = await verify(f, fresh);
  assert.equal(held.result, "held");
  assert.match(held.message, /pins v0\.1\.6-nightly\.20261030\.3917, which adds dependencies under 3 days old over v0\.1\.6-nightly\.20261030\.3904.*hist-young@1\.0\.0/);
  assert.equal(recorded(fresh), null, "nothing recorded");
  const later = T + 3 * DAY;
  const verified = await verify(f, fresh, { now: later, server: later });
  assert.equal(verified.result, "verified");
  assert.match(verified.message, /1 evaluator commit\(s\) since/);
  assert.equal(recorded(fresh), tip);
  mockFetch({}, () => assert.fail("a recorded HEAD needs no network"));
  assert.match((await verify(f, fresh, { now: later + 60_000 })).message, /^\w+ was verified here$/);
});

test("self-update records what it verified only on top of a HEAD verified here: a fresh clone's young pin stays checked", async () => {
  const f = youngPin("hist-record", T);
  const fresh = f.fresh();
  // The owner's README change lands by self-update, from the unverified fresh HEAD.
  const readme = f.commit(f.owner, { "README.md": "notes\n" }, "README");
  assert.equal(await hourly(f, { repo: fresh }), "updated");
  assert.equal(head(fresh), readme);
  assert.equal(recorded(fresh), null, "not recorded: the young pin it came with was never checked");
  mockFetch(f.routes);
  assert.equal((await verify(f, fresh)).result, "held");
  // Once verified, what self-update verifies on top is recorded.
  const later = T + 3 * DAY;
  assert.equal((await verify(f, fresh, { now: later, server: later })).result, "verified");
  const next = f.commit(f.owner, { "lib/rules.mjs": "// a rule fix\n" }, "rule fix");
  assert.equal(await hourly(f, { repo: fresh, now: later + 60_000 }), "updated");
  assert.equal(recorded(fresh), next);
});

/** bin/t3blackout's update(), run with what it builds, installs and asks stubbed, a staged build of the pinned release waiting. */
async function updateBody({ verdict, scheduled, role = "host" }) {
  const src = fs.readFileSync(new URL("../bin/t3blackout", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function update(opts)"), src.indexOf("/** Takes the update lock if it's free"));
  const chosen = { ref: NIGHTLY(3917), sha: "a".repeat(40) };
  const seen = { build: 0, install: 0, events: [], process: { exitCode: 0 } };
  const quiet = () => {};
  const context = vm.createContext({
    fetchUpstream: async () => {}, progress: quiet, CURRENT: "", readJson: () => ({}),
    chooseTarget: async () => ({ ...chosen, held: [] }), versionOf: () => "v", blackoutCommit: () => "b",
    expectedBuild: () => null, isExpectedBuild: () => true, readPending: () => ({ ...chosen, blackout: "b" }),
    platform: { isRunning: () => false, notify: quiet, pendingPath: "/scratch/pending", isScheduled: () => scheduled },
    installConfig: role ? { role } : null, pinnedFor: () => chosen, appChannel: () => "nightly", verifyHead: async () => verdict,
    log: quiet, emit: (event) => seen.events.push(event), process: seen.process,
    buildUpstream: async () => { seen.build++; throw new Error("scratch build boundary"); }, buildChanges: () => ({}), install: () => seen.install++, fs: { rmSync: quiet },
  });
  await vm.runInContext(`${body}\nupdate({})`, context);
  return { ...seen, message: seen.events.at(-1)?.message };
}

test("update builds and installs nothing until a pinned release is verified here, and says what tries again", async () => {
  const held = { result: "held", message: "evaluator commit abc pins v0.1.6-nightly.20261030.3917, which adds dependencies under 3 days old" };
  const skipped = { result: "skipped", message: "couldn't check the tags evaluator commit abc pins upstream (timed out)" };
  const refused = { result: "refused", message: "commit abc isn't signed" };
  for (const verdict of [held, skipped, refused]) {
    for (const [scheduled, role, ending] of [
      // A first install: install.sh stops at a failed first update (set -e), before it schedules any.
      [false, "host", "; rerun ./install.sh --role host to try again"],
      [false, null, "; rerun ./install.sh --role ui to try again"],
      ["LaunchDaemon", "host", verdict.result === "refused" ? "" : "; the scheduled update tries again"],
    ]) {
      const seen = await updateBody({ verdict, scheduled, role });
      assert.deepEqual([seen.build, seen.install, seen.process.exitCode], [0, 0, 1], `${verdict.result}, scheduled ${scheduled}`);
      assert.equal(seen.message, `not building ${NIGHTLY(3917)}: pin.json here can't be verified yet (${verdict.message})${ending}`);
    }
  }
  // Verified: the staged build installs.
  assert.equal((await updateBody({ verdict: { result: "verified", message: "ok" }, scheduled: false })).install, 1);
  const install = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  assert.match(install, /^set -euo pipefail$/m);
  assert.ok(install.indexOf("\n  bin/t3blackout update\n") < install.indexOf("bin/t3blackout schedule --hour"));
});

test("git settings in the environment can't point the check at another repository", async () => {
  const f = fixture();
  const good = f.fresh("good");
  f.commit(null, { "lib/x.mjs": "evil\n" }, "unsigned");
  const bad = f.fresh("bad");
  const saved = process.env.GIT_DIR;
  // As a hook in a linked worktree has it: an absolute GIT_DIR naming another, signed clone.
  process.env.GIT_DIR = path.join(good, ".git");
  try {
    const verdict = await verify(f, bad);
    assert.equal(verdict.result, "refused");
    assert.match(verdict.message, /isn't signed/);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
  assert.equal(recorded(good), null, "nothing recorded in the other clone");
  assert.equal(recorded(bad), null);
});

test("an evaluator pin that isn't a regular file is refused, however valid what it holds or names", async () => {
  for (const [make, mode] of [
    ["symlink", "120000"],
    ["executable", "100755"],
  ]) {
    const f = fixture();
    mockFetch({}, () => assert.fail("refused on the history alone"));
    const file = path.join(f.origin, "pin.json");
    // A symlink whose target text is a valid forward pin: git stores that text as the blob, a checkout makes it a link.
    const text = pin(NIGHTLY(3917), f.shas[1]);
    fs.rmSync(file);
    if (make === "symlink") fs.symlinkSync(text, file);
    else fs.writeFileSync(file, text, { mode: 0o755 });
    const sha = f.commit(f.bot, {}, "Pin nightly");
    assert.equal(run(f.origin, ["ls-tree", "HEAD", "pin.json"]).split(" ")[0], mode);
    assert.deepEqual(await verify(f, f.fresh()), { result: "refused", message: `evaluator commit ${sha.slice(0, 10)} makes pin.json mode ${mode}; it must stay a regular file (100644)` });
  }
  // One the owner made a symlink can't be moved on by the evaluator either.
  const f = fixture();
  mockFetch({});
  const file = path.join(f.origin, "pin.json");
  fs.rmSync(file);
  fs.symlinkSync(pin(NIGHTLY(3904), f.shas[0]), file);
  f.commit(f.owner, {}, "a symlinked pin");
  fs.rmSync(file);
  const sha = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  assert.deepEqual(await verify(f, f.fresh()), { result: "refused", message: `evaluator commit ${sha.slice(0, 10)} follows a pin.json of mode 120000, not a regular file (100644)` });
});

/**
 * bin/t3blackout's update, with its own target, chooseTarget, pinnedFor and requirePinned, and the real
 * readPin and unpinnedProblem reading `file`; upstream's newest release is NEWEST, and verifying,
 * building and installing are stubbed (update reports the stubbed build's failure itself). What it
 * verified and built, and the error it stopped on, if any.
 */
async function updateWithPin(file) {
  const src = fs.readFileSync(new URL("../bin/t3blackout", import.meta.url), "utf8");
  const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + from.length));
  const body = [
    between("const pinnedFor = ", "/**"),
    between("function requirePinned(", "/**"),
    between("async function chooseTarget(", "/** One line"),
    between("function target(opts, current) {", "/** Downloads the pricing"),
    between("async function update(opts) {", "/** Takes the update lock"),
  ].join("\n");
  const NEWEST = NIGHTLY(3940);
  const seen = { verified: 0, built: [] };
  const quiet = () => {};
  const context = vm.createContext({
    readPin: () => readPin(file), unpinnedProblem, SOAK_HOURS: 3, cliChannel: (channel) => channel, appChannel: () => "nightly",
    soakOf: () => ({}), resolveRef: () => NEWEST, revParse: (ref) => (ref === NEWEST ? "b".repeat(40) : ref), channelOfRef: () => "nightly", commitTime: () => 0,
    soakedTags: () => [NEWEST], MAX_FALLBACK: 5, verdictFor: async () => ({ ok: true }), heldLine: () => "",
    fetchUpstream: async () => {}, progress: quiet, CURRENT: "", readJson: () => ({}), versionOf: () => "v", blackoutCommit: () => "signed",
    expectedBuild: () => null, isExpectedBuild: () => true, readPending: () => null, platform: { isRunning: () => false, notify: quiet },
    verifyHead: async () => (seen.verified++, { result: "verified", message: "ok" }), log: quiet, emit: quiet, process: { exitCode: 0 },
    buildUpstream: async (sha) => {
      seen.built.push(sha);
      throw new Error("scratch build boundary");
    },
    buildChanges: () => ({}), install: quiet, fs: { rmSync: quiet },
  });
  const stopped = await vm.runInContext(`${body}\nupdate({})`, context).then(() => null, (error) => error.message);
  return { ...seen, stopped };
}

test("an update given a pin.json that isn't a regular file stops before it picks a release or builds; only a missing pin is unpinned", async () => {
  const f = fixture();
  const dir = path.join(f.dir, "pins");
  fs.mkdirSync(dir);
  const text = pin(NIGHTLY(3917), "a".repeat(40));
  const regular = path.join(dir, "regular.json");
  fs.writeFileSync(regular, text);
  // The pinned release is verified, then built.
  assert.deepEqual(await updateWithPin(regular), { verified: 1, built: ["a".repeat(40)], stopped: null });
  // A symlink named by a pin's text (what a checkout of a symlinked pin makes), one to a valid pin, and a folder: none is "no pin".
  const named = path.join(dir, "named.json");
  fs.symlinkSync(text, named);
  const linked = path.join(dir, "linked.json");
  fs.symlinkSync(regular, linked);
  const folder = path.join(dir, "folder.json");
  fs.mkdirSync(folder);
  for (const file of [named, linked, folder]) {
    const seen = await updateWithPin(file);
    assert.deepEqual([seen.verified, seen.built], [0, []], file);
    assert.match(seen.stopped, /pin\.json is invalid: .* isn't a regular file$/, file);
  }
  assert.throws(() => readPin(named), /isn't a regular file/);
  // Only no pin.json at all is the unpinned path, which builds the newest soaked release without the pin's checks.
  assert.deepEqual(await updateWithPin(path.join(dir, "missing.json")), { verified: 0, built: ["b".repeat(40)], stopped: null });
});

test("replace refs and a grafts file don't change which history is checked", async () => {
  const f = fixture();
  mockFetch({});
  const root = run(f.origin, ["rev-parse", "HEAD"]);
  const unsigned = f.commit(null, { "lib/x.mjs": "evil\n" }, "unsigned");
  // A replace ref standing the signed first commit in for the unsigned tip.
  const replaced = f.fresh("replaced");
  run(replaced, ["replace", unsigned, root]);
  const swapped = await verify(f, replaced);
  assert.equal(swapped.result, "refused");
  assert.match(swapped.message, new RegExp(`^commit ${unsigned.slice(0, 10)} isn't signed$`));
  // A graft that makes a later signed commit parentless, hiding the unsigned one behind it.
  f.commit(f.owner, { "README.md": "after\n" }, "after");
  const grafted = f.fresh("grafted");
  fs.writeFileSync(path.join(grafted, ".git", "info", "grafts"), `${run(grafted, ["rev-parse", "HEAD"])}\n`);
  assert.equal(run(grafted, ["rev-parse", "--is-shallow-repository"]), "false", "a graft isn't a shallow clone");
  const hidden = await verify(f, grafted);
  assert.equal(hidden.result, "refused");
  assert.match(hidden.message, new RegExp(`^commit ${unsigned.slice(0, 10)} isn't signed$`));
});

test("an OpenPGP or X.509 commit is refused without running a signature program the clone configures", async () => {
  const f = fixture();
  mockFetch({});
  const marker = path.join(f.dir, "ran");
  const program = path.join(f.dir, "marker.sh");
  fs.writeFileSync(program, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  for (const armor of ["PGP SIGNATURE", "SIGNED MESSAGE"]) {
    const sha = forgeSigned(f, armor);
    const repo = f.fresh(`forged-${armor.length}`);
    for (const key of ["gpg.program", "gpg.openpgp.program", "gpg.x509.program"]) run(repo, ["config", key, program]);
    const verdict = await verify(f, repo);
    assert.equal(verdict.result, "refused");
    assert.match(verdict.message, new RegExp(`^commit ${sha.slice(0, 10)} is signed with (openpgp|x509), not an SSH key in \\.allowed_signers$`));
    assert.equal(fs.existsSync(marker), false, `${armor}: no signature program ran`);
    run(f.origin, ["reset", "-q", "--hard", "HEAD^"]);
  }
});

// ------------------------------------------------------- who may sign what --

test("an evaluator commit that relabels its own key as an owner's is refused, not its own anchor, in one step or two", async () => {
  {
    const f = fixture();
    const promoted = `owner@example.com namespaces="git" ${f.owner.pub}\nowner-alias@example.com namespaces="git" ${f.bot.pub}\n`;
    f.commit(f.bot, { ".allowed_signers": promoted, "pin.json": pin(NIGHTLY(3999), f.shas[1]), "lib/owner-only-file": "changed by evaluator\n" }, "Pin nightly");
    mockFetch({}, () => assert.fail("refused on the history alone, before any network"));
    const verdict = await verify(f, f.fresh());
    assert.equal(verdict.result, "refused");
    // Judged by the list its parent has, the key is the evaluator's, and the commit is out of bounds.
    assert.match(verdict.message, /^evaluator commit \w+ changes \.allowed_signers, lib\/owner-only-file, pin\.json, not just pin\.json$/);
  }
  {
    const f = fixture();
    const relabel = `owner@example.com namespaces="git" ${f.owner.pub}\nowner-alias@example.com namespaces="git" ${f.bot.pub}\n`;
    const step = f.commit(f.bot, { ".allowed_signers": relabel }, "relabel");
    f.commit(f.bot, { "pin.json": pin(NIGHTLY(3999), f.shas[1]) }, "Pin nightly (as owner-alias)");
    const verdict = await verify(f, f.fresh());
    assert.equal(verdict.result, "refused");
    assert.equal(verdict.message, `evaluator commit ${step.slice(0, 10)} changes .allowed_signers, not just pin.json`);
  }
  // A stranger's commit that lists the stranger as an owner, and pins: refused by the parent's list.
  {
    const f = fixture();
    const self = `owner@example.com namespaces="git" ${f.owner.pub}\nstranger@example.com namespaces="git" ${f.stranger.pub}\n`;
    f.commit(f.stranger, { ".allowed_signers": self, "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "promote and pin");
    const verdict = await verify(f, f.fresh());
    assert.equal(verdict.result, "refused");
    assert.match(verdict.message, /isn't signed by a key in \.allowed_signers/);
  }
});

test("the first commit stands on its own signature, and only the owner's", async () => {
  for (const [who, why] of [
    [null, /^the first commit, \w+, isn't signed$/],
    ["bot", /^the first commit, \w+, is the evaluator's; it needs one you sign$/],
  ]) {
    const f = fixture();
    // A new history whose first commit lists keys as the fixture's does, signed by `who`.
    const rooted = path.join(f.dir, "rooted");
    run(f.dir, ["init", "-q", "-b", "main", rooted]);
    for (const name of [".allowed_signers", "pin.json", "lib/known-device-tools.txt", "lib/known-hosts.txt", "README.md"]) {
      fs.mkdirSync(path.dirname(path.join(rooted, name)), { recursive: true });
      fs.copyFileSync(path.join(f.origin, name), path.join(rooted, name));
    }
    run(rooted, ["add", "-A"]);
    run(rooted, who ? ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${f[who].file}`, "commit", "-q", "-S", "-m", "root"] : ["commit", "-q", "--no-gpg-sign", "-m", "root"]);
    const verdict = await verify(f, rooted);
    assert.equal(verdict.result, "refused", who);
    assert.match(verdict.message, why);
  }
});

test("an owner commit that drops the evaluator, then an evaluator pin, in one batch: refused hourly as on a fresh clone; nothing lands or is recorded", async () => {
  const f = fixture();
  mockFetch({});
  const base = f.head();
  assert.equal((await verify(f, f.clone)).result, "verified");
  f.commit(f.owner, { ".allowed_signers": list([["owner@example.com", f.owner]]) }, "revoke evaluator");
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "pin after revocation");
  assert.equal((await verify(f, f.fresh())).result, "refused");
  assert.equal(await hourly(f), "refused");
  assert.equal(f.logs.at(-1), `self-update refused: commit ${tip.slice(0, 10)} isn't signed by a key in .allowed_signers (U)`);
  assert.deepEqual([f.head(), recorded(f.clone)], [base, base], "nothing landed; the record is the base's");
  assert.match((await verify(f, f.clone)).message, new RegExp(`^${base.slice(0, 10)} was verified here$`));
});

test("an owner key rotation and a commit after it, in one batch: the new key's is taken hourly, recorded, and verifies fresh; the old key's is refused by both", async () => {
  for (const signer of ["stranger", "owner"]) {
    const f = fixture();
    mockFetch({});
    assert.equal((await verify(f, f.clone)).result, "verified");
    const base = f.head();
    f.commit(f.owner, { ".allowed_signers": list([["owner@example.com", f.stranger], [BOT_PRINCIPAL, f.bot]]) }, "rotate owner key");
    const tip = f.commit(f[signer], { "lib/rules.mjs": `// a rule fix signed by ${signer}\n` }, "code after rotation");
    const fresh = await verify(f, f.fresh());
    const result = await hourly(f);
    if (signer === "stranger") {
      assert.deepEqual([fresh.result, result, f.head(), recorded(f.clone)], ["verified", "updated", tip, tip], "the new key signs from the commit after the rotation");
    } else {
      assert.deepEqual([fresh.result, result, f.head(), recorded(f.clone)], ["refused", "refused", base, base], "the old key signs nothing after the rotation");
      assert.match(f.logs.at(-1), new RegExp(`commit ${tip.slice(0, 10)} isn't signed by a key in \\.allowed_signers`));
    }
  }
});

test("merges: every new commit is signed by a key its first parent lists, side branches included; an evaluator merge and another history's first commit are refused", async () => {
  for (const [sideSigner, result] of [
    ["owner", "updated"],
    [null, "refused"],
    ["stranger", "refused"],
  ]) {
    const f = fixture();
    mockFetch({});
    const root = f.head();
    assert.equal((await verify(f, f.clone)).result, "verified");
    const side = f.commit(sideSigner ? f[sideSigner] : null, { "side.txt": "side\n" }, "side branch");
    run(f.origin, ["reset", "-q", "--hard", root]);
    const main = f.commit(f.owner, { "README.md": "main\n" }, "main line");
    f.merge([main, side], treeOf(f));
    const fresh = await verify(f, f.fresh());
    assert.equal(await hourly(f), result, `side signed by ${sideSigner}`);
    assert.equal(fresh.result, result === "updated" ? "verified" : "refused", `side signed by ${sideSigner}`);
  }
  const f = fixture();
  mockFetch({});
  const root = f.head();
  assert.equal((await verify(f, f.clone)).result, "verified");
  const foreign = run(f.origin, ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${f.owner.file}`, "commit-tree", treeOf(f), "-S", "-m", "another first commit"]);
  f.merge([root, foreign], treeOf(f));
  assert.equal(await hourly(f), "refused");
  assert.match(f.logs.at(-1), /has no parent: a history that isn't this clone's/);
  assert.equal((await verify(f, f.fresh())).result, "refused");
  const g = fixture();
  mockFetch({});
  const groot = g.head();
  assert.equal((await verify(g, g.clone)).result, "verified");
  const a = g.commit(g.bot, { "pin.json": pin(NIGHTLY(3917), g.shas[1]) }, "pin");
  run(g.origin, ["reset", "-q", "--hard", groot]);
  const b = g.commit(g.owner, { "README.md": "x\n" }, "owner");
  g.merge([b, a], treeOf(g), g.bot);
  assert.equal(await hourly(g), "refused");
  assert.match(g.logs.at(-1), /evaluator commit \w+ is a merge or a root commit/);
});

function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: over random signer changes, signers and batch splits, hourly self-update and a fresh walk agree with a model of the rule, and a recorded tip always verifies fresh", async () => {
  const seen = { histories: 0, refused: 0, rotations: 0, batches: 0, recordedTips: 0 };
  // One fixture, put back to its first commit for each history.
  const f = fixture();
  const base = f.head();
  mockFetch({});
  for (let seed = 1; seed <= 8; seed++) {
    const random = prng(seed);
    const pick = (items) => items[Math.floor(random() * items.length)];
    for (const repo of [f.origin, f.clone]) run(repo, ["reset", "-q", "--hard", base]);
    assert.equal((await verify(f, f.clone)).result, "verified");
    // The model: who may sign, as each commit's parent lists it; and the first commit taken wrongly.
    let allowed = new Map([["owner", "owner@example.com"], ["bot", BOT_PRINCIPAL]]);
    let wrong = false;
    // Pins only move forward (3904, then 3917, then 3940): the evaluator's are in bounds.
    let pinned = 0;
    for (let step = 0; step < 6; step++) {
      // Mostly a step the rule takes (a key the parent lists, in its role); sometimes any.
      const valid = random() < 0.85;
      const signer = valid ? pick([...allowed].filter(([, role]) => role !== BOT_PRINCIPAL || pinned < 2).map(([key]) => key)) : pick(["owner", "stranger", "bot", null]);
      const role = signer && allowed.get(signer);
      let kind = valid && role === BOT_PRINCIPAL ? "pin" : pick(["readme", "pin", "list"]);
      if (kind === "pin" && pinned === 2) kind = "readme";
      let files;
      let lists = null;
      if (kind === "pin") {
        pinned++;
        files = { "pin.json": pin(NIGHTLY([3904, 3917, 3940][pinned]), f.shas[pinned]) };
      } else if (kind === "readme") files = { "README.md": `step ${step}\n` };
      else {
        // An owner list change: drop the evaluator, put it back, add the stranger as an owner, or rotate the owner key to it.
        lists = pick([
          [["owner", "owner@example.com"]],
          [["owner", "owner@example.com"], ["bot", BOT_PRINCIPAL]],
          [["owner", "owner@example.com"], ["stranger", "second@example.com"], ["bot", BOT_PRINCIPAL]],
          [["stranger", "owner@example.com"], ["bot", BOT_PRINCIPAL]],
        ]);
        files = { ".allowed_signers": `${list(lists.map(([key, principal]) => [principal, f[key]]))}# step ${step}\n` };
        seen.rotations++;
      }
      f.commit(signer ? f[signer] : null, files, `step ${step}`);
      // As the rule has it: signed by a key the parent lists; the evaluator's only moving pin.json (forward, or not at all).
      const ok = role && (role !== BOT_PRINCIPAL || kind === "pin");
      if (!ok) wrong = true;
      else if (lists) allowed = new Map(lists);
      // Sometimes the hour comes now: a batch of what's new.
      if (random() < 0.4) {
        await hourly(f);
        seen.batches++;
      }
    }
    await hourly(f);
    const tip = head(f.origin);
    const fresh = await verify(f, f.fresh(`fresh-${seed}`));
    const landed = f.head() === tip;
    assert.equal(fresh.result, wrong ? "refused" : "verified", `seed ${seed}: the fresh walk, against the model (${fresh.message})`);
    assert.equal(landed, !wrong, `seed ${seed}: hourly self-update reached the tip only if the model takes every commit`);
    // What self-update recorded, a fresh walk verifies: the cache never stands in for a refusal.
    const record = recorded(f.clone);
    if (record === tip) {
      seen.recordedTips++;
      assert.equal(fresh.result, "verified", `seed ${seed}: recorded, but refused fresh`);
    }
    if (record) {
      const at = f.fresh(`at-record-${seed}`);
      run(at, ["checkout", "-q", record]);
      assert.equal((await verify(f, at)).result, "verified", `seed ${seed}: the recorded ${record.slice(0, 10)} verifies fresh`);
    }
    seen.histories++;
    seen.refused += wrong;
  }
  for (const [what, n] of Object.entries(seen)) assert.ok(n >= 2, `the histories exercise ${what} (${n})`);
  assert.ok(seen.refused < seen.histories, `some histories are taken (${seen.refused} of ${seen.histories} refused)`);
});

// -------------------------------------------------- shallow and incomplete --

test("a shallow clone is refused with how to make a full one, whatever its tip, by both; unshallowed, it's checked like the full clone", async () => {
  const f = youngPin("hist-shallow", T);
  f.commit(f.owner, { "README.md": "notes only\n" }, "README only");
  mockFetch(f.routes);
  assert.equal((await verify(f, f.fresh("full"))).result, "held", "the full clone holds the young pin");
  for (const depth of ["--depth=1", "--depth=2"]) {
    const shallow = f.fresh(`shallow${depth.slice(-1)}`, [depth]);
    const verdict = await verify(f, shallow);
    assert.equal(verdict.result, "refused", depth);
    assert.match(verdict.message, /^this clone is shallow: .*; make a full clone \(git fetch --unshallow\)$/);
    assert.equal(recorded(shallow), null);
    // Hourly self-update in it is refused the same way, before anything lands.
    f.commit(f.owner, { "README.md": `more notes ${depth}\n` }, "README again");
    assert.equal(await hourly(f, { repo: shallow }), "refused", depth);
    assert.match(f.logs.at(-1), /^self-update refused: this clone is shallow/);
    run(shallow, ["fetch", "-q", "--unshallow"]);
    assert.equal((await verify(f, shallow)).result, "held", depth);
  }
  // An evaluator tip, shallow.
  const g = fixture();
  g.commit(g.bot, { "pin.json": pin(NIGHTLY(3917), g.shas[1]) }, "Pin nightly");
  const verdict = await verify(g, g.fresh("shallow-bot", ["--depth=1"]));
  assert.equal(verdict.result, "refused");
  assert.match(verdict.message, /make a full clone \(git fetch --unshallow\)/);
});

test("a commit missing from a clone that isn't shallow is refused the same way", async () => {
  const f = youngPin("hist-missing", T);
  f.commit(f.owner, { "README.md": "notes only\n" }, "README only");
  const repo = f.fresh("missing", ["--no-local"]);
  // Every object loose, then the evaluator's commit (HEAD's parent) gone.
  const packs = path.join(repo, ".git", "objects", "pack");
  for (const pack of fs.readdirSync(packs).filter((file) => file.endsWith(".pack"))) {
    const bytes = fs.readFileSync(path.join(packs, pack));
    for (const file of fs.readdirSync(packs)) fs.rmSync(path.join(packs, file));
    run(repo, ["unpack-objects", "-q"], { input: bytes });
  }
  const parent = run(repo, ["rev-parse", "HEAD^"]);
  fs.rmSync(path.join(repo, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
  assert.equal(run(repo, ["rev-parse", "--is-shallow-repository"]), "false");
  const verdict = await verify(f, repo);
  assert.equal(verdict.result, "refused");
  assert.match(verdict.message, /^this clone's history behind \w+ can't be read; make a full clone \(git fetch --unshallow\)$/);
});

test("a pin the owner creates over a parent without one is trusted; one the evaluator creates is refused", async () => {
  for (const [who, result] of [
    ["bot", "refused"],
    ["owner", "verified"],
  ]) {
    const f = fixture();
    run(f.origin, ["rm", "-q", "pin.json"]);
    f.commit(f.owner, {}, "no pin for now");
    f.commit(f[who], { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
    mockFetch({}, () => assert.fail("decided on the history alone"));
    const verdict = await verify(f, f.fresh());
    assert.equal(verdict.result, result, who);
    if (who === "bot") assert.match(verdict.message, /creates pin\.json; its first version needs a commit you sign/);
  }
});

// -------------------------------------------------------- clock and record --

test("a clock four days ahead doesn't admit an hour-old dependency, and says how to fix it; within 10 minutes is taken, behind only holds more", async () => {
  const f = youngPin("hist-clock", T);
  const repo = f.fresh();
  mockFetch(f.routes);
  assert.equal((await verify(f, repo)).result, "held", "at the right time, it's young");
  const ahead = await verify(f, repo, { now: T + 4 * DAY });
  assert.equal(ahead.result, "held");
  assert.match(ahead.message, AHEAD);
  assert.match(ahead.message, /it's 4 days ahead of the npm registry's/);
  assert.equal(recorded(repo), null, "nothing recorded");
  assert.equal((await verify(f, repo, { now: T + 3 * DAY, server: T + 3 * DAY - 9 * 60_000 })).result, "verified");
  fs.rmSync(path.join(repo, ".git", "t3blackout-verified"));
  assert.match((await verify(f, repo, { now: T + 3 * DAY, server: T + 3 * DAY - 11 * 60_000 })).message, AHEAD);
  assert.equal((await verify(f, repo, { now: T + 3 * DAY, server: T + 5 * DAY })).result, "verified");
});

test("self-update takes no age by a clock that's ahead either, and records with the time; an owner pin needs no clock", async () => {
  const name = "hist-selfupdate";
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, OLD_DEPS] });
  assert.equal((await verify(f, f.clone)).result, "verified");
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch(npmRoutes({ [name]: { "1.0.0": { publishedAt: new Date(T - 3_600_000).toISOString(), integrity: YOUNG } } }));
  assert.equal(await f.update({ now: T + 4 * DAY, clock: async () => T }), "held");
  assert.match(f.logs.at(-1), AHEAD);
  assert.equal(await f.update({ now: T + 4 * DAY, clock: async () => T + 4 * DAY }), "updated");
  assert.equal(fs.readFileSync(path.join(f.clone, ".git", "t3blackout-verified"), "utf8"), `${f.head()} ${T + 4 * DAY}\n`);
  f.commit(f.owner, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "Pin nightly (owner)");
  assert.equal(await f.update({ now: T + 4 * DAY, clock: async () => assert.fail("no age was taken") }), "updated");
});

test("a record dated after the clock, or without a time, is checked again; one from the past stands", async () => {
  const f = youngPin("hist-dated", T);
  const repo = f.fresh();
  mockFetch(f.routes);
  // Verified with the clock (and the registry) three days on: recorded with that time.
  const later = T + 3 * DAY;
  assert.equal((await verify(f, repo, { now: later, server: later })).result, "verified");
  assert.equal(fs.readFileSync(path.join(repo, ".git", "t3blackout-verified"), "utf8"), `${head(repo)} ${later}\n`);
  assert.match((await verify(f, repo, { now: later + DAY })).message, /^\w+ was verified here$/, "after it: the record stands");
  // The clock reads earlier than the record (it was ahead, and is right now): checked again, and held.
  const corrected = await verify(f, repo, { now: T });
  assert.equal(corrected.result, "held");
  assert.match(corrected.message, /adds dependencies under 3 days old/);
  fs.writeFileSync(path.join(repo, ".git", "t3blackout-verified"), `${head(repo)}\n`);
  assert.equal((await verify(f, repo, { now: T })).result, "held");
});

test("the registry's clock is its HTTPS Date header, whatever the status; with none, or no answer, an age-based admission is skipped, not taken", async () => {
  const at = Date.UTC(2026, 9, 31, 16, 58, 22);
  for (const status of [200, 404]) {
    mockFetch({ "https://registry.npmjs.org/": () => new Response(null, { status, headers: { date: new Date(at).toUTCString() } }) });
    assert.equal(await registryTime(), at, `status ${status}`);
  }
  mockFetch({ "https://registry.npmjs.org/": () => new Response(null, { status: 200 }) });
  await assert.rejects(registryTime(), /no Date header/);
  // verifyHead's default clock is the registry's.
  const f = youngPin("hist-noclock", T);
  const later = { repo: f.fresh(), upstream: f.upstream, report: () => {}, advisories: noAdvisories, reviewClosure: async (p) => ({ ok: true, pin: p, reasons: [], notes: [] }), now: T + 3 * DAY };
  mockFetch({ ...f.routes, "https://registry.npmjs.org/": () => new Response(null, { status: 200 }) });
  const verdict = await verifyHead(later);
  assert.equal(verdict.result, "skipped");
  assert.match(verdict.message, /^couldn't check this machine's clock against the npm registry's \(npm registry sent no Date header\)$/);
  mockFetch({ ...f.routes, "https://registry.npmjs.org/": () => { throw new TypeError("fetch failed"); } });
  assert.equal((await verifyHead(later)).result, "skipped");
  assert.equal(recorded(later.repo), null);
});
