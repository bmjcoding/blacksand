// Real SSH-signed histories for the owner-authorized label and folder changes.
// Historical differential cases keep the frozen oracle; its intentional gaps
// after these transitions are asserted here against the active verifiers.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { checkHistory, checkTip } from "../../../src/trust/check.ts";
import { localGit } from "../../../src/trust/git.ts";
import { ambiguous } from "../../../src/trust/layout.ts";
import * as active from "../lib/selfupdate.mjs";
import { t3Gates } from "../lib/trust-gates.mjs";
import { NIGHTLY, OLD_DEPS, YOUNG, fixture, mockFetch, npm, npmRoutes, pin, run } from "./trust-fixtures.mjs";
import { objectStore, sshKey } from "./trust-objects.mjs";
import { oracle } from "./trust-oracle.mjs";

const LABELS = ["t3blackout-evaluator", "blacksand-evaluator"];
const FOLDERS = ["", "packages/t3/", "tooling/t3code/", "tooling/blacksand-t3/"];
const CURRENT = FOLDERS[3];
const short = (sha) => sha.slice(0, 10);
const list = (owner, bot, evaluator, ownerLabel = "blacksand-owner") => `${ownerLabel} namespaces="git" ${owner.pub}\n${evaluator} namespaces="git" ${bot.pub}\n`;

function world(options) {
  const f = fixture(options);
  const repo = path.join(f.dir, "transition");
  run(f.dir, ["init", "-q", "-b", "main", repo]);
  const store = objectStore(path.join(repo, ".git"));
  const owner = sshKey();
  const bot = sshKey();
  const files = (folder, evaluator = LABELS[0]) => ({
    ".allowed_signers": list(owner, bot, evaluator, "t3blackout-owner"),
    [`${folder}pin.json`]: pin(NIGHTLY(3904), f.shas[0]),
    [`${folder}lib/rules.mjs`]: "export const trusted = true;\n",
  });
  const commit = (files, key = owner, parents = []) => store.commit({ tree: store.tree(files), parents, key, message: "fixture change" });
  return { ...f, repo, store, owner, bot, files, commit, git: localGit(repo) };
}

const optionsOf = (w, now = Date.now()) => ({ upstream: w.upstream, now, clock: async () => now, report: () => {}, advisories: async () => [], reviewClosure: async (p) => ({ ok: true, pin: p, reasons: [], notes: [] }) });
const tsVerdict = (w, tip, now) => checkTip(w.git, { tip, start: null, gates: t3Gates(optionsOf(w, now)) });
async function mjsVerdict(w, tip, verifier = active, now) {
  run(w.repo, ["update-ref", "refs/heads/main", tip]);
  fs.rmSync(path.join(w.repo, ".git", "t3blackout-verified"), { force: true });
  return verifier.verifyHead({ repo: w.repo, ...optionsOf(w, now) });
}

test("owner label migration preserves historical parent lists and both evaluator pins in every layout", async () => {
  const w = world();
  mockFetch({});
  for (const folder of FOLDERS) {
    const files = w.files(folder);
    const root = w.commit(files);
    const beforeFiles = { ...files, [`${folder}pin.json`]: pin(NIGHTLY(3917), w.shas[1]) };
    const before = w.commit(beforeFiles, w.bot, [root]);
    const renamedFiles = { ...beforeFiles, ".allowed_signers": list(w.owner, w.bot, LABELS[1]) };
    const renamed = w.commit(renamedFiles, w.owner, [before]);
    const tip = w.commit({ ...renamedFiles, [`${folder}pin.json`]: pin(NIGHTLY(3940), w.shas[2]) }, w.bot, [renamed]);
    const history = checkHistory(w.git, { tip, start: null });
    assert.equal(history.result, "verified", folder);
    assert.deepEqual(history.commits.map((c) => c.principal), ["t3blackout-owner", LABELS[0], "t3blackout-owner", LABELS[1]]);
    assert.deepEqual({ trusted: history.trusted, bot: history.bot }, { trusted: root, bot: [before, tip] });
    assert.deepEqual(active.pinBasis([root, before, renamed, tip], new Map(history.commits.map((c) => [c.sha, c]))), { trusted: root, bot: [before, tip] });
    const expected = `${short(tip)} verified here (2 evaluator commit(s) since ${short(root)})`;
    assert.equal((await tsVerdict(w, tip)).message, expected);
    const updater = await mjsVerdict(w, tip);
    if (!folder) assert.deepEqual(updater, { result: "verified", message: expected });
    else assert.deepEqual(updater, { result: "refused", message: `evaluator commit ${short(before)} changes ${folder}pin.json, not just pin.json` }, "root-only updater remains blocked on moved pins");
    // Renaming the current list cannot relabel old signatures during verification.
    assert.equal(run(w.repo, ["show", `${root}:.allowed_signers`]), files[".allowed_signers"].trim());
  }
});

test("both exact evaluator labels refuse code, signer edits, self-relabeling and merges in both active verifiers", async () => {
  const w = world();
  mockFetch({});
  for (const label of LABELS) for (const folder of FOLDERS) {
    const files = w.files(folder, label);
    const root = w.commit(files);
    const side = w.commit({ ...files, "README.md": "side\n" }, w.owner, [root]);
    const cases = [
      ["code", { ...files, [`${folder}lib/rules.mjs`]: "export const trusted = false;\n" }, [root], /changes .*lib\/rules\.mjs, not just/],
      ["signers", { ...files, ".allowed_signers": list(w.owner, w.bot, label, "another-owner") }, [root], /changes \.allowed_signers, not just/],
      ["self-relabel", { ...files, ".allowed_signers": list(w.owner, w.bot, label === LABELS[0] ? LABELS[1] : LABELS[0]) }, [root], /changes \.allowed_signers, not just/],
      ["owner escalation", { ...files, ".allowed_signers": list(w.owner, w.bot, "pretend-owner") }, [root], /changes \.allowed_signers, not just/],
      ["merge", files, [root, side], /is a merge or a root commit$/],
    ];
    for (const [name, next, parents, why] of cases) {
      const tip = w.commit(next, w.bot, parents);
      for (const verdict of [checkHistory(w.git, { tip, start: null }), await mjsVerdict(w, tip)]) {
        assert.equal(verdict.result, "refused", `${label} ${folder} ${name}`);
        assert.match(verdict.message, why);
      }
    }
  }
  // The frozen oracle's post-rename escalation is deliberate evidence, not a new expectation for active code.
  const files = w.files("", LABELS[1]);
  const root = w.commit(files);
  const tip = w.commit({ ...files, "lib/rules.mjs": "untrusted code\n" }, w.bot, [root]);
  assert.deepEqual(await mjsVerdict(w, tip, oracle), { result: "verified", message: `${short(tip)} verified here` });
  assert.equal((await mjsVerdict(w, tip)).result, "refused");
});

test("neither evaluator label can be the trusted root in any layout", async () => {
  const w = world();
  for (const label of LABELS) for (const folder of FOLDERS) {
    const files = w.files(folder, label);
    const root = w.commit(files, w.bot);
    for (const verdict of [checkHistory(w.git, { tip: root, start: null }), await mjsVerdict(w, root)]) {
      assert.deepEqual(verdict, { result: "refused", message: `the first commit, ${short(root)}, is the evaluator's; it needs one you sign` });
    }
  }
});

test("an owner can rename and move together; evaluator moves and wrong parent pin paths stay refused", async () => {
  const w = world();
  mockFetch({});
  for (const folder of FOLDERS.slice(0, -1)) for (const label of LABELS) {
    const files = w.files(folder, label);
    const root = w.commit(files);
    const movedFiles = { ...w.files(CURRENT, LABELS[1]), ".allowed_signers": list(w.owner, w.bot, LABELS[1]) };
    const moved = w.commit(movedFiles, w.owner, [root]);
    const tip = w.commit({ ...movedFiles, [`${CURRENT}pin.json`]: pin(NIGHTLY(3940), w.shas[2]) }, w.bot, [moved]);
    const history = checkHistory(w.git, { tip, start: null });
    assert.equal(history.result, "verified");
    assert.deepEqual({ trusted: history.trusted, bot: history.bot }, { trusted: root, bot: [tip] }, "moving identical pin bytes does not establish a new owner pin basis");
    assert.equal((await tsVerdict(w, tip)).result, "verified");
    const unauthorized = w.commit(movedFiles, w.bot, [root]);
    for (const verdict of [checkHistory(w.git, { tip: unauthorized, start: null }), await mjsVerdict(w, unauthorized)]) {
      assert.equal(verdict.result, "refused");
      assert.match(verdict.message, /^evaluator commit \w+ changes /);
    }
    // Neither a future path before the move nor the old path after it is the parent's pin.
    for (const [base, content, wrong, expected] of [[root, files, CURRENT, folder], [moved, movedFiles, folder, CURRENT]]) {
      const bad = w.commit({ ...content, [`${wrong}pin.json`]: pin(NIGHTLY(3940), w.shas[2]) }, w.bot, [base]);
      assert.deepEqual(checkHistory(w.git, { tip: bad, start: null }), { result: "refused", message: `evaluator commit ${short(bad)} changes ${wrong}pin.json, not just ${expected}pin.json` });
    }
  }
});

test("a rename cannot authorize its own signing key: both verifiers use the original first-parent list", async () => {
  const w = world();
  const stranger = sshKey();
  const files = w.files("");
  const root = w.commit(files);
  const tip = w.commit({ ...files, ".allowed_signers": list(stranger, w.bot, LABELS[1]) }, stranger, [root]);
  for (const verdict of [checkHistory(w.git, { tip, start: null }), await mjsVerdict(w, tip)]) {
    assert.equal(verdict.result, "refused");
    assert.match(verdict.message, /isn't signed by a key in \.allowed_signers/);
  }
});

test("both labels keep the pin gates after renaming; the new layout holds a young dependency and rejects a false tag", async () => {
  const now = Date.now();
  const later = now + 3 * 86_400_000;
  const name = "naming-young";
  const w = world({ locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, OLD_DEPS] });
  mockFetch(npmRoutes({ [name]: { "1.0.0": { publishedAt: new Date(now - 3_600_000).toISOString(), integrity: YOUNG } } }));
  for (const folder of ["", CURRENT]) for (const label of LABELS) {
    const files = w.files(folder, label);
    const root = w.commit(files);
    const tip = w.commit({ ...files, [`${folder}pin.json`]: pin(NIGHTLY(3917), w.shas[1]) }, w.bot, [root]);
    const held = await tsVerdict(w, tip, now);
    assert.equal(held.result, "held");
    assert.match(held.message, /adds dependencies under 3 days old .*naming-young@1\.0\.0/);
    assert.equal((await tsVerdict(w, tip, later)).result, "verified");
    if (!folder) {
      assert.deepEqual(await mjsVerdict(w, tip, active, now), { result: held.result, message: held.message });
      assert.equal((await mjsVerdict(w, tip, active, later)).result, "verified");
      if (label === LABELS[1]) assert.deepEqual(await mjsVerdict(w, tip, oracle, now), { result: "verified", message: `${short(tip)} verified here` }, "frozen oracle treats the new label as owner; active verifiers must not");
    }
    const bad = w.commit({ ...files, [`${folder}pin.json`]: pin(NIGHTLY(3999), w.shas[1]) }, w.bot, [root]);
    const refused = await tsVerdict(w, bad, now);
    assert.equal(refused.result, "refused");
    assert.match(refused.message, /pins nightly to .*3999.*missing/);
    if (!folder) assert.deepEqual(await mjsVerdict(w, bad), { result: refused.result, message: refused.message });
  }
  // An owner move that leaves pin bytes untouched must not erase the earlier evaluator's age gate.
  const files = w.files("tooling/t3code/", LABELS[1]);
  const root = w.commit(files);
  const pinned = w.commit({ ...files, "tooling/t3code/pin.json": pin(NIGHTLY(3917), w.shas[1]) }, w.bot, [root]);
  const movedFiles = { ...w.files(CURRENT, LABELS[1]), [`${CURRENT}pin.json`]: pin(NIGHTLY(3917), w.shas[1]) };
  const moved = w.commit(movedFiles, w.owner, [pinned]);
  const history = checkHistory(w.git, { tip: moved, start: null });
  assert.deepEqual({ trusted: history.trusted, bot: history.bot }, { trusted: root, bot: [pinned] });
  assert.equal((await tsVerdict(w, moved, now)).result, "held");
});

test("the new layout reads owner tool approvals from its own folder through the third move", async () => {
  const w = world();
  const now = Date.now();
  mockFetch(npm("trust-su-net", Object.fromEntries(["1.0.0", "1.1.0"].map((v) => [v, { files: { "index.js": "module.exports = {};\n" }, publishedAt: new Date(now - 30 * 86_400_000).toISOString() }]))));
  const folder = "tooling/t3code/";
  const files = { ...w.files(folder, LABELS[1]), [`${folder}lib/known-device-tools.txt`]: "trust-su-net@1.0.0\n" };
  const root = w.commit(files);
  const moved = { ...w.files(CURRENT, LABELS[1]), [`${CURRENT}lib/known-device-tools.txt`]: "trust-su-net@1.0.0\n" };
  const parent = w.commit(moved, w.owner, [root]);
  const pinned = { ...moved, [`${CURRENT}pin.json`]: pin(NIGHTLY(3917), w.shas[1], ["trust-su-tool@1.0.0", "trust-su-net@1.1.0"]) };
  const tip = w.commit(pinned, w.bot, [parent]);
  assert.equal((await tsVerdict(w, tip, now)).result, "verified");
  // Moving the list to the historical root leaves no reviewed predecessor in the new layout.
  const misplaced = { ...moved, "lib/known-device-tools.txt": moved[`${CURRENT}lib/known-device-tools.txt`] };
  delete misplaced[`${CURRENT}lib/known-device-tools.txt`];
  const wrongParent = w.commit(misplaced, w.owner, [root]);
  const bad = w.commit({ ...misplaced, [`${CURRENT}pin.json`]: pinned[`${CURRENT}pin.json`] }, w.bot, [wrongParent]);
  const refused = await tsVerdict(w, bad, now);
  assert.equal(refused.result, "refused");
  assert.match(refused.message, /no reviewed version to compare against/);
});

test("mixed component trees, including empty new trees, refuse at roots, tips and trusted first parents", () => {
  const w = world();
  const entry = (mode, name, sha) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, "hex")]);
  const treeKey = (entry) => {
    const [mode, name] = entry.subarray(0, entry.indexOf(0)).toString().split(" ");
    return Buffer.from(`${name}${mode === "40000" ? "/" : ""}`);
  };
  const tree = (entries) => w.store.write("tree", Buffer.concat(entries.sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)))));
  const empty = tree([]);
  const signers = entry("100644", ".allowed_signers", w.store.write("blob", list(w.owner, w.bot, LABELS[1])));
  const packageTree = (next) => tree([entry("100644", "pin.json", w.store.write("blob", pin(NIGHTLY(next ? 3917 : 3904), w.shas[next ? 1 : 0])))]);
  const layouts = FOLDERS.slice(1).map((f) => f.slice(0, -1));
  const withFolders = (mine, other = null) => {
    const top = new Map();
    for (const [folder, contents] of [[mine, packageTree(other !== null)], ...(other ? [[other, empty]] : [])]) {
      const [area, component] = folder.split("/");
      top.set(area, [...(top.get(area) ?? []), entry("40000", component, contents)]);
    }
    return tree([signers, ...[...top].map(([area, entries]) => entry("40000", area, tree(entries)))]);
  };
  for (const mine of layouts) for (const other of layouts.filter((f) => f !== mine)) {
    const root = w.store.commit({ tree: withFolders(mine), key: w.owner, message: "one layout" });
    const mixed = withFolders(mine, other);
    for (const key of [w.owner, w.bot]) {
      const tip = w.store.commit({ tree: mixed, parents: [root], key, message: "ambiguous" });
      assert.deepEqual(checkHistory(w.git, { tip, start: null }), { result: "refused", message: ambiguous(`commit ${short(tip)}`) });
    }
    const first = w.store.commit({ tree: mixed, key: w.owner, message: "mixed root" });
    assert.deepEqual(checkHistory(w.git, { tip: first, start: null }), { result: "refused", message: ambiguous(`the first commit, ${short(first)},`) });
    const trusted = w.store.commit({ tree: mixed, parents: [root], key: w.owner, message: "mixed trusted parent" });
    const next = w.store.commit({ tree: withFolders(mine), parents: [trusted], key: w.owner, message: "after mixed trusted parent" });
    assert.deepEqual(checkHistory(w.git, { tip: next, start: trusted }), { result: "refused", message: ambiguous(`commit ${short(trusted)}, which ${short(next)} follows,`) });
  }
  // An empty component folder is invisible to changed-file lists but still changes the layout.
  for (const label of LABELS) {
    const rootFiles = w.files("", label);
    const root = w.commit(rootFiles);
    const baseTree = w.store.tree({ ...rootFiles, "pin.json": pin(NIGHTLY(3917), w.shas[1]) });
    const entries = run(w.repo, ["ls-tree", "-z", baseTree]).split("\0").filter(Boolean).map((row) => {
      const [mode, , sha, name] = row.split(/[\t ]/);
      return entry(mode === "040000" ? "40000" : mode, name, sha);
    });
    const moved = tree([...entries, entry("40000", "tooling", tree([entry("40000", "blacksand-t3", empty)]))]);
    const tip = w.store.commit({ tree: moved, parents: [root], key: w.bot, message: "empty layout move" });
    assert.deepEqual(checkHistory(w.git, { tip, start: null }), { result: "refused", message: `evaluator commit ${short(tip)} changes the layout from root to blacksand; only a commit you sign may` });
  }
  run(w.repo, ["fsck", "--strict", "--no-dangling"]);
});

test("the active updater counts both labels as evaluator commits through an owner rename", async () => {
  const f = fixture();
  mockFetch({});
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  f.commit(f.owner, { ".allowed_signers": list(f.owner, f.bot, LABELS[1]) }, "Rename signer labels");
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "Pin nightly");
  const reports = [];
  assert.equal(await active.selfUpdate({ repo: f.clone, remote: f.origin, ...optionsOf(f), report: (line) => reports.push(line) }), "updated");
  assert.match(reports.at(-1), /3 signed commit\(s\), 2 from the evaluator/);
});
