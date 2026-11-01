// node --test test/: the old verifier (lib/selfupdate.mjs) and the new one
// (src/trust) on signed histories. 500 generated ones (test/trust-histories.mjs;
// TRUST_HISTORIES sets how many, 10,000 nightly), each judged alike by both in
// today's layout and, where it crosses the monorepo move, by the new one alike on
// the moved layout; then what only the new verifier can judge: the cutover, raw
// trees and headers git accepts, principals as ssh-keygen reads them, and
// blacksand verify's working-tree comparison against git's own ways of hiding a
// change. Throwaway repositories and keys; npm and the advisory sources are
// mocked. (Every fixture in commit-trust, pin-trust and self-update runs through
// both verifiers too: test/trust-fixtures.mjs bothVerify, bothUpdate.)
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_PRINCIPAL } from "../lib/selfupdate.mjs";
import { NIGHTLY, OLD_DEPS, YOUNG, ago, fixture, mockFetch, npm, npmRoutes, pin, run } from "./trust-fixtures.mjs";
import { runShards } from "./trust-histories.mjs";
import { objectStore, sshKey } from "./trust-objects.mjs";

const { verifyHead } = await import("../lib/selfupdate.mjs");
const { checkHead, checkHistory, verifyHead: verifyHeadTs } = await import("../../../src/trust/check.ts");
const { localGit } = await import("../../../src/trust/git.ts");
const { verify } = await import("../../../src/commands/verify.ts");
const { t3Gates } = await import("../lib/trust-gates.mjs");

const COUNT = Number(process.env.TRUST_HISTORIES ?? 500);

test(`old and new verifiers agree on ${COUNT} generated signed histories, and the new one on each across the monorepo move`, async (t) => {
  const started = performance.now();
  const { stats, disagreements } = await runShards({ count: COUNT });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  t.diagnostic(`${stats.histories} histories, ${stats.commits} commits in ${seconds} s: ${JSON.stringify(stats)}`);
  // Any disagreement fails, and its world (objects, keys, seed and clone state) stays where it says.
  assert.deepEqual(
    disagreements.slice(0, 3).map(({ seed, layout, tip, kept, old, new: fresh }) => ({ seed, layout, tip, kept, old, new: fresh })),
    [],
    `${disagreements.length} disagreement(s), kept in ${[...new Set(disagreements.map((found) => found.kept))].join(", ")}; rerun one with runSeeds({ from: seed, count: 1 })`,
  );
  assert.equal(stats.histories, COUNT);
  // The histories reach every verdict, clone state and step, on both layouts.
  if (COUNT >= 500) {
    for (const result of ["verified", "refused", "held", "skipped"]) assert.ok(stats.results[result] > 0, `some histories are ${result}`);
    for (const state of ["fresh", "recordOnChain", "recordTip", "recordFuture", "recordNoTime", "recordOffChain", "shallow", "missing"]) assert.ok(stats.states[state] > 0, state);
    for (const op of ["edit", "pin", "list", "merge", "move", "foreign", "multi", "forge:badsig", "forge:double", "forge:openpgp", "forge:x509", "pin:remove", "pin:preview"]) assert.ok(stats.ops[op] > 0, op);
    for (const layout of ["across:verified", "across:verified after evaluator commits", "across:refused", "monorepo:verified", "monorepo:refused"]) assert.ok(stats.layouts[layout] > 0, layout);
  }
});

// ------------------------------------------------------------- the move --

/** The owner's (or `who`'s) commit moving the package's files under packages/t3/, as v1's first commit does. */
function move(f, who = f.owner) {
  fs.mkdirSync(path.join(f.origin, "packages/t3"), { recursive: true });
  run(f.origin, ["mv", "pin.json", "lib", "packages/t3/"]);
  return f.commit(who, {}, "move the package");
}

/** Both verifiers on a fresh clone of origin: { old, new } verdicts. */
async function judge(f, opts = {}) {
  const repo = f.fresh(`fresh-${Math.random().toString(36).slice(2)}`);
  const options = { upstream: f.upstream, reviewClosure: async (p) => ({ ok: true, pin: p, reasons: [], notes: [] }), advisories: async () => [], clock: async () => opts.now ?? Date.now(), now: Date.now(), ...opts };
  const old = await verifyHead({ repo, report: () => {}, ...options });
  fs.rmSync(path.join(repo, ".git", "t3blackout-verified"), { force: true });
  const fresh = await verifyHeadTs({ repo, now: options.now, gates: t3Gates({ ...options, report: () => {} }) });
  return { old, new: fresh, repo };
}

test("across the move, the new verifier takes an evaluator pin of packages/t3/pin.json through the gates; the old one refuses it as out of bounds", async () => {
  const f = fixture();
  mockFetch({});
  move(f);
  const tip = f.commit(f.bot, { "packages/t3/pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "Pin nightly");
  const both = await judge(f);
  // The move changes no pin, so the pin still rests on the first commit's.
  assert.deepEqual(both.new, { result: "verified", message: `${tip.slice(0, 10)} verified here (1 evaluator commit(s) since ${run(f.origin, ["rev-list", "--max-parents=0", "HEAD"]).slice(0, 10)})` });
  // Why today's machines mustn't follow v1: the old verifier reads only the root's pin.json.
  assert.deepEqual(both.old, { result: "refused", message: `evaluator commit ${tip.slice(0, 10)} changes packages/t3/pin.json, not just pin.json` });
  // The gates run on the moved pin: a tag naming another commit is refused.
  f.commit(f.bot, { "packages/t3/pin.json": pin(NIGHTLY(3999), f.shas[1]) }, "Pin nightly, wrong commit");
  assert.match((await judge(f)).new.message, /^evaluator commit \w+ pins nightly to v0\.1\.6-nightly\.20261030\.3999 at \w+, but upstream's v0\.1\.6-nightly\.20261030\.3999 is missing$/);
});

test("across the move, a young dependency holds the moved pin as it held the old one, and the owner's lists are read from the package folder", async () => {
  const name = "port-young";
  const T = Date.now();
  const later = T + 3 * 86_400_000;
  /** A moved fixture whose evaluator pin adds the young dependency and approves a tool only the known-tools list has an earlier version of; `relocate` leaves that list only at the root. */
  const world = (relocate) => {
    const f = fixture({ knownTools: "trust-su-net@1.0.0", locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, OLD_DEPS] });
    move(f);
    if (relocate) {
      fs.mkdirSync(path.join(f.origin, "lib"), { recursive: true });
      run(f.origin, ["mv", "packages/t3/lib/known-device-tools.txt", "lib/"]);
      f.commit(f.owner, {}, "the known tools at the root");
    }
    f.commit(f.bot, { "packages/t3/pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-net@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly, approving trust-su-net 1.1.0");
    return f;
  };
  mockFetch({
    ...npmRoutes({ [name]: { "1.0.0": { publishedAt: new Date(T - 3_600_000).toISOString(), integrity: YOUNG } } }),
    ...npm("trust-su-net", Object.fromEntries(["1.0.0", "1.1.0"].map((v) => [v, { files: { "index.js": "module.exports = {};\n" }, publishedAt: ago(30) }]))),
  });
  const f = world(false);
  const held = await judge(f, { now: T, clock: async () => T });
  assert.equal(held.new.result, "held");
  assert.match(held.new.message, /adds dependencies under 3 days old .*port-young@1\.0\.0/);
  // Three days on it's taken: the approval passed review against the known tools in packages/t3/lib.
  assert.equal((await judge(f, { now: later, clock: async () => later })).new.result, "verified");
  // A list left at the root, where today's layout had it, isn't the package's: the same approval has no reviewed version to compare with.
  const g = world(true);
  const stray = await judge(g, { now: later, clock: async () => later });
  assert.equal(stray.new.result, "refused");
  assert.match(stray.new.message, /no reviewed version to compare against/);
});

test("across the move, the gates read the owner's lists at the tip, in the tip's own layout", async () => {
  // An evaluator pin approving a tool that reaches two hosts the known-hosts list has; then the owner moves the package, pin and lists with it.
  const f = fixture({ knownHosts: "api.vendor.dev\ntelemetry.vendor.dev", knownTools: "trust-su-host@1.0.0" });
  mockFetch(
    npm("trust-su-host", {
      "1.0.0": { files: { "index.js": "fetch('https://api.vendor.dev/v1')" }, publishedAt: ago(30) },
      "1.1.0": { files: { "index.js": "fetch('https://api.vendor.dev/v2'); fetch('https://telemetry.vendor.dev/t')" }, publishedAt: ago(30) },
    }),
  );
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-host@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly, approving trust-su-host 1.1.0");
  const tip = move(f);
  const both = await judge(f);
  assert.deepEqual(both.new, { result: "verified", message: `${tip.slice(0, 10)} verified here (1 evaluator commit(s) since ${run(f.origin, ["rev-list", "--max-parents=0", "HEAD"]).slice(0, 10)})` });
});

test("an evaluator commit can't change the layout through an empty tree, which changes no file", async () => {
  const f = fixture();
  const repo = path.join(f.dir, "raw");
  run(f.dir, ["init", "-q", "-b", "main", repo]);
  const store = objectStore(path.join(repo, ".git"));
  const [owner, bot] = [sshKey(), sshKey()];
  const list = store.write("blob", `owner@example.com namespaces="git" ${owner.pub}\n${BOT_PRINCIPAL} namespaces="git" ${bot.pub}\n`);
  const entry = (mode, name, sha) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, "hex")]);
  const tree = (entries) => store.write("tree", Buffer.concat(entries));
  const root = store.commit({ tree: tree([entry("100644", ".allowed_signers", list), entry("100644", "pin.json", store.write("blob", pin(NIGHTLY(3904), f.shas[0])))]), message: "root", key: owner });
  // The pin moved forward, and a packages folder holding an empty t3 tree: diff-tree names pin.json alone.
  const empty = tree([]);
  const tip = store.commit({ tree: tree([entry("100644", ".allowed_signers", list), entry("40000", "packages", tree([entry("40000", "t3", empty)])), entry("100644", "pin.json", store.write("blob", pin(NIGHTLY(3917), f.shas[1])))]), parents: [root], message: "Pin nightly", key: bot });
  assert.equal(run(repo, ["diff-tree", "-r", "--name-only", "--no-commit-id", tip]), "pin.json");
  run(repo, ["fsck", "--strict", "--no-dangling"]);
  assert.deepEqual(checkHistory(localGit(repo), { tip, start: null }), { result: "refused", message: `evaluator commit ${tip.slice(0, 10)} changes the layout from root to monorepo; only a commit you sign may` });
});

test("the evaluator can't make the move, can't write the moved pin before it, nor the old one after it", async () => {
  {
    const f = fixture();
    const sha = move(f, f.bot);
    const both = await judge(f);
    assert.match(both.new.message, new RegExp(`^evaluator commit ${sha.slice(0, 10)} changes .*packages/t3/pin\\.json.*, not just pin\\.json$`));
  }
  {
    const f = fixture();
    const sha = f.commit(f.bot, { "packages/t3/pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "a moved pin, early");
    assert.equal((await judge(f)).new.message, `evaluator commit ${sha.slice(0, 10)} changes packages/t3/pin.json, not just pin.json`);
  }
  {
    const f = fixture();
    move(f);
    const sha = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "the old pin, late");
    assert.equal((await judge(f)).new.message, `evaluator commit ${sha.slice(0, 10)} changes pin.json, not just packages/t3/pin.json`);
  }
  {
    // An owner merge of a branch from before the move, keeping the pre-move tree, puts the pin back at the root: the evaluator follows that.
    const f = fixture();
    mockFetch({});
    const base = run(f.origin, ["rev-parse", "HEAD"]);
    const moved = move(f);
    run(f.origin, ["reset", "-q", "--hard", base]);
    const side = f.commit(f.owner, { "README.md": "side\n" }, "side");
    f.merge([moved, side], run(f.origin, ["rev-parse", `${side}^{tree}`]));
    f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "Pin nightly");
    const both = await judge(f);
    assert.deepEqual([both.new.result, both.old.result], ["verified", "verified"]);
  }
});

// ------------------------------------------------------- blacksand verify --


/** A scratch repository of commits written as objects, signed by throwaway keys: owner, and the evaluator as `bot`. */
function rawRepo(f, name) {
  const repo = path.join(f.dir, name);
  run(f.dir, ["init", "-q", "-b", "main", repo]);
  return { repo, store: objectStore(path.join(repo, ".git")), owner: sshKey(), bot: sshKey() };
}

test("header lines are git's: a CR, U+2028 or U+2029 inside the author line starts no signature header", async () => {
  const f = fixture();
  const { repo, store, owner } = rawRepo(f, "headers");
  const files = { ".allowed_signers": `owner@example.com namespaces="git" ${owner.pub}\n`, "pin.json": pin(NIGHTLY(3904), f.shas[0]) };
  const root = store.commit({ tree: store.tree(files), message: "root", key: owner });
  const armor = owner.sign("something else").replaceAll("\n", "\n ");
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    // An unsigned commit whose author line holds text that looks like a signature header.
    const body = `tree ${store.tree({ ...files, "README.md": JSON.stringify(separator) })}\nparent ${root}\nauthor t <t@example.com> 1761800000 +0000${separator}gpgsig ${armor}\ncommitter t <t@example.com> 1761800000 +0000\n\nlooks signed\n`;
    const sha = store.write("commit", body);
    assert.deepEqual(checkHistory(localGit(repo), { tip: sha, start: null }), { result: "refused", message: `commit ${sha.slice(0, 10)} isn't signed` }, JSON.stringify(separator));
  }
});

test("who signed is what ssh-keygen finds in the parent's list, byte for byte: a,,b, an unterminated quote, a trailing no-break space, a control byte", async () => {
  const f = fixture();
  for (const [field, want] of [
    ["a,,b", { result: "verified", principal: "a" }],
    ['"unterminated', { result: "refused" }],
    ['"owner\u00a0"', { result: "verified", principal: "owner\u00a0" }],
    // A control byte inside a quoted principal is part of the name, not a record boundary.
    ['"owner\u0002x"', { result: "verified", principal: "owner\u0002x" }],
  ]) {
    const { repo, store, owner } = rawRepo(f, `principal-${Buffer.from(field).toString("hex")}`);
    const files = { ".allowed_signers": `${field} namespaces="git" ${owner.pub}\n`, "pin.json": pin(NIGHTLY(3904), f.shas[0]) };
    const root = store.commit({ tree: store.tree(files), message: "root", key: owner });
    const tip = store.commit({ tree: store.tree({ ...files, "README.md": "next\n" }), parents: [root], message: "next", key: owner });
    const taken = checkHistory(localGit(repo), { tip, start: null });
    assert.equal(taken.result, want.result, field);
    if (want.principal) assert.deepEqual(taken.commits.map((c) => c.principal), [want.principal, want.principal], field);
    else assert.match(taken.message, /^the first commit, \w+, isn't signed by a key in \.allowed_signers \(\w\)$/, field);
  }
});

// ------------------------------------------------------- blacksand verify --

/** A fresh clone of the fixture's origin, with a .gitignore for node_modules/, a tracked script, and one more owner commit to check out. */
function verifiable(f) {
  if (!fs.existsSync(path.join(f.origin, ".gitignore"))) {
    f.commit(f.owner, { ".gitignore": "node_modules/\n", "src/run.sh": "#!/bin/sh\n" }, "ignore node_modules");
    fs.chmodSync(path.join(f.origin, "src/run.sh"), 0o755);
    f.commit(f.owner, {}, "an executable script");
    f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "Pin nightly");
  }
  return f.fresh(`verify-${Math.random().toString(36).slice(2)}`);
}

/** blacksand verify --json on `repo`'s real head check: its exit code and envelope. */
async function verifyJson(repo, git = localGit(repo)) {
  const out = [];
  const ctx = { json: true, io: { out: (text) => out.push(text), err: () => {} }, clock: { now: () => Date.now(), sleep: async () => {} }, run: () => ({ status: 0, signal: null }), headCheck: () => checkHead(git) };
  const exit = await verify.run([], ctx);
  return { exit, envelope: JSON.parse(out.join("")) };
}

test("blacksand verify reports the clone's real history and its files, names the verified commit, writes nothing and reaches no network", async () => {
  const f = fixture();
  mockFetch({}, (url) => assert.fail(`verify fetched ${url}`));
  const repo = verifiable(f);
  const head = run(repo, ["rev-parse", "HEAD"]);
  fs.mkdirSync(path.join(repo, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/x/index.js"), "module.exports = 1;\n");
  const listing = () => fs.readdirSync(path.join(repo, ".git")).sort().join(",");
  const before = listing();
  const index = fs.readFileSync(path.join(repo, ".git", "index"));
  const clean = await verifyJson(repo);
  assert.equal(clean.exit, 4, "no receipt yet");
  assert.equal(clean.envelope.schema, "blacksand.verify/1");
  assert.equal(clean.envelope.blacksand.commit, head);
  assert.deepEqual(clean.envelope.checks.map((c) => [c.id, c.ok]), [["trust/history", true], ["trust/working-tree", true]]);
  assert.match(clean.envelope.checks[0].text, /1 evaluator pin commit\(s\) since \w+, which blacksand t3 update gates before it builds$/);
  assert.equal(clean.envelope.checks[1].text, `every file is ${head.slice(0, 10)}'s (ignored, so outside the comparison: node_modules/)`);
  assert.equal(listing(), before, "nothing written into the clone's git directory");
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), index, "nor its index");
  // An extra file nothing ignores, a changed one, an executable bit gone: each differs.
  for (const [change, path_] of [
    [() => fs.writeFileSync(path.join(repo, "extra.ts"), "x\n"), "extra.ts"],
    [() => fs.writeFileSync(path.join(repo, "README.md"), "changed\n"), "README.md"],
    [() => fs.chmodSync(path.join(repo, "src/run.sh"), 0o644), "src/run.sh"],
  ]) {
    change();
    const dirty = await verifyJson(repo);
    assert.deepEqual([dirty.envelope.blacksand.commit, dirty.envelope.checks[1].ok], [null, false], path_);
    assert.match(dirty.envelope.checks[1].text, new RegExp(`^1 path\\(s\\) differ from \\w+, .*: ${path_.replace(".", "\\.")}$`), path_);
    run(repo, ["checkout", "-q", "--", "."]);
    fs.rmSync(path.join(repo, "extra.ts"), { force: true });
    fs.chmodSync(path.join(repo, "src/run.sh"), 0o755);
  }
  // An unsigned commit on top: the history is refused, and a record is no shortcut past that.
  run(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "unsigned"]);
  fs.writeFileSync(path.join(repo, ".git", "t3blackout-verified"), `${run(repo, ["rev-parse", "HEAD"])} 1\n`);
  const refused = await verifyJson(repo);
  assert.deepEqual([refused.envelope.blacksand.commit, refused.envelope.checks[0].ok], [null, false]);
  assert.match(refused.envelope.checks[0].text, /isn't signed$/);
});

test("blacksand verify doesn't take git's word that files are unchanged: index flags, filters, sparse checkouts and another work tree are refused", async () => {
  const f = fixture();
  mockFetch({});
  const cases = [
    ["assume-unchanged", (repo) => run(repo, ["update-index", "--assume-unchanged", "README.md"]), /^README\.md is marked assume-unchanged in the index/],
    ["skip-worktree", (repo) => run(repo, ["update-index", "--skip-worktree", "README.md"]), /^README\.md is marked skip-worktree in the index/],
    // A clean filter that turns any README back into the committed bytes: git status would call the file unchanged.
    ["filter", (repo) => (fs.writeFileSync(path.join(repo, ".git/info/attributes"), "README.md filter=same\n"), run(repo, ["config", "filter.same.clean", `cat ${path.join(f.origin, "README.md")}`])), /^this clone sets filter\.same\.clean, which this check doesn't model$/],
    ["sparse", (repo) => run(repo, ["config", "core.sparseCheckout", "true"]), /^this clone sets core\.sparsecheckout, which this check doesn't model$/],
    ["worktree", (repo) => run(repo, ["config", "core.worktree", f.origin]), /^git reads .* working tree, not /],
  ];
  for (const [name, setUp, why] of cases) {
    const repo = verifiable(f);
    setUp(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "unsigned bytes\n");
    const { envelope } = await verifyJson(repo);
    assert.deepEqual([envelope.blacksand.commit, envelope.checks[1].ok], [null, false], name);
    assert.match(envelope.checks[1].text, why, name);
  }
});

test("blacksand verify runs no program the clone configures, and a checkout while it runs is refused, not reported as the commit it left", async () => {
  const f = fixture();
  mockFetch({});
  const repo = verifiable(f);
  const marker = path.join(f.dir, "fsmonitor-ran");
  fs.writeFileSync(path.join(f.dir, "fsmonitor.sh"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  run(repo, ["config", "core.fsmonitor", path.join(f.dir, "fsmonitor.sh")]);
  run(repo, ["config", "core.untrackedCache", "true"]);
  const { envelope } = await verifyJson(repo);
  assert.equal(envelope.checks[1].ok, true, envelope.checks[1].text);
  assert.equal(fs.existsSync(marker), false, "the clone's fsmonitor program never ran");
  run(repo, ["config", "--unset", "core.fsmonitor"]);
  // HEAD moves to its parent between the tree read and the end of the check.
  const git = localGit(repo);
  const moving = {
    repo,
    bytes: (args, call) => git.bytes(args, call),
    text(args, call) {
      const result = git.text(args, call);
      if (args[0] === "ls-tree") run(repo, ["checkout", "-q", "--detach", "HEAD^"]);
      return result;
    },
  };
  const raced = await verifyJson(repo, moving);
  assert.deepEqual([raced.envelope.blacksand.commit, raced.envelope.checks[1].ok], [null, false]);
  assert.match(raced.envelope.checks[1].text, /^HEAD moved from \w+ to \w+ while it was checked$/);
});

test("blacksand verify refuses a tree it doesn't compare: a symlink in the commit", async () => {
  const f = fixture();
  mockFetch({});
  fs.symlinkSync("README.md", path.join(f.origin, "link"));
  f.commit(f.owner, {}, "a symlink");
  const { envelope } = await verifyJson(f.fresh("symlinked"));
  assert.equal(envelope.checks[0].ok, true);
  assert.match(envelope.checks[1].text, /^\w+ has link as mode 120000, which this check doesn't compare$/);
});
