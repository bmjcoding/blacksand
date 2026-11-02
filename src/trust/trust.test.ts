import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { EVALUATOR, isEvaluator, evaluatorShape, type EvaluatorCommit } from "./evaluator.ts";
import { gitEnv, type Git, type GitResult } from "./git.ts";
import { pinBasis } from "./history.ts";
import { LAYOUTS, ambiguous, layoutNames, layoutOf, packagePath, pinPath } from "./layout.ts";
import { signatureKind } from "./signers.ts";
import { compareWorktree } from "./worktree.ts";

const PIN = (ref: string) => `${JSON.stringify({ version: 1, channels: { nightly: { ref, sha: "a".repeat(40), evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } }, deviceTools: [] })}\n`;
const OLD = PIN("v0.1.6-nightly.20261030.3904");
const NEW = PIN("v0.1.6-nightly.20261030.3917");

test("each historical layout has one fixed pin path; any combination of component folders is ambiguous", () => {
  const folders = ["packages/t3", "tooling/t3code", "tooling/blacksand-t3"];
  assert.deepEqual(layoutNames("c"), folders.map((folder) => `c:${folder}`));
  const at = (types: Record<string, string>) => layoutOf("c", (name) => types[name] ?? null);
  assert.equal(at({}), "root");
  for (const [i, folder] of folders.entries()) {
    assert.equal(at({ [`c:${folder}`]: "tree" }), LAYOUTS[i + 1]);
    for (const type of ["blob", "commit"]) {
      assert.equal(at({ [`c:${folder}`]: type }), "root", type);
      for (const other of folders.filter((f) => f !== folder)) {
        assert.equal(at({ [`c:${folder}`]: "tree", [`c:${other}`]: type }), LAYOUTS[i + 1], type);
      }
    }
    for (const other of folders.filter((f) => f !== folder)) assert.equal(at({ [`c:${folder}`]: "tree", [`c:${other}`]: "tree" }), null);
  }
  assert.equal(at(Object.fromEntries(folders.map((folder) => [`c:${folder}`, "tree"]))), null);
  assert.equal(ambiguous("commit c"), "commit c has multiple component folders (packages/t3, tooling/t3code, tooling/blacksand-t3), so where its pin is can't be told; only one may hold the t3 package");
  assert.equal(layoutOf("c", (name) => (name === "d:tooling/t3code" ? "tree" : null)), "root");
  assert.deepEqual(LAYOUTS.map(pinPath), ["pin.json", ...folders.map((folder) => `${folder}/pin.json`)]);
  for (const [i, folder] of folders.entries()) assert.equal(packagePath(LAYOUTS[i + 1]!, "lib/overrides.json"), `${folder}/lib/overrides.json`);
});

test("an evaluator commit may change only the pin file of its parent's layout, only forward, and only as a regular file", () => {
  const commit = (fields: Partial<EvaluatorCommit>): EvaluatorCommit => ({ parents: 1, files: ["pin.json"], pinFile: "pin.json", before: OLD, after: NEW, beforeMode: "100644", afterMode: "100644", ...fields });
  const shape = (pinFile: string, files: string[], before = OLD, after = NEW) => evaluatorShape(commit({ files, pinFile, before, after }));
  for (const pinFile of LAYOUTS.map(pinPath)) {
    assert.equal(shape(pinFile, [pinFile]), null);
    for (const other of LAYOUTS.map(pinPath).filter((p) => p !== pinFile)) {
      assert.equal(shape(pinFile, [other]), `changes ${other}, not just ${pinFile}`);
      assert.equal(shape(pinFile, [other, pinFile]), `changes ${other}, ${pinFile}, not just ${pinFile}`);
    }
    assert.equal(shape(pinFile, [pinFile], NEW, OLD), "moves nightly back from v0.1.6-nightly.20261030.3917 to v0.1.6-nightly.20261030.3904");
    assert.equal(evaluatorShape(commit({ files: [pinFile], pinFile, before: null, beforeMode: null })), `creates ${pinFile}; its first version needs a commit you sign`);
    assert.equal(evaluatorShape(commit({ files: [pinFile], pinFile, afterMode: "120000" })), `makes ${pinFile} mode 120000; it must stay a regular file (100644)`);
  }
  assert.equal(evaluatorShape(commit({ parents: 2, files: [] })), "is a merge or a root commit");
  // A symlink whose target text is a valid pin, an executable pin, and one following an owner's symlink.
  assert.equal(evaluatorShape(commit({ afterMode: "120000" })), "makes pin.json mode 120000; it must stay a regular file (100644)");
  assert.equal(evaluatorShape(commit({ afterMode: "100755" })), "makes pin.json mode 100755; it must stay a regular file (100644)");
  assert.equal(evaluatorShape(commit({ beforeMode: "120000" })), "follows a pin.json of mode 120000, not a regular file (100644)");
});

test("only the two exact evaluator labels have the restricted role", () => {
  for (const name of [EVALUATOR, "t3blackout-evaluator"]) assert.equal(isEvaluator(name), true);
  for (const name of [undefined, "owner@example.com", "blacksand-owner", "other-evaluator", "blacksand-evaluator-extra", "BLACKSAND-EVALUATOR", "blacksand-evaluator "]) assert.equal(isEvaluator(name), false, name);
});

test("a tip's pin rests on the newest owner commit on its first-parent line that changes it", () => {
  const of = new Map([
    ["b", { principal: "t3blackout-evaluator", pinChanged: true }],
    ["c", { principal: "owner@example.com", pinChanged: true }],
    ["d", { principal: EVALUATOR, pinChanged: true }],
    ["e", { principal: "owner@example.com", pinChanged: false }],
  ]);
  assert.deepEqual(pinBasis(["a", "b", "c", "d", "e"], of), { trusted: "c", bot: ["d"] });
  assert.deepEqual(pinBasis(["a", "b"], of), { trusted: "a", bot: ["b"] });
});

test("signature headers are read as git reads them: LF-separated lines up to the first empty one, named by their literal start", () => {
  const SSH = "-----BEGIN SSH SIGNATURE-----";
  const commit = (headers: string, message = "message\n") => `tree x\n${headers}\n\n${message}`;
  assert.equal(signatureKind(commit(`gpgsig ${SSH}\n a\n -----END SSH SIGNATURE-----`)), "ssh");
  assert.equal(signatureKind(commit("gpgsig -----BEGIN PGP SIGNATURE-----")), "openpgp");
  assert.equal(signatureKind(commit("gpgsig -----BEGIN SIGNED MESSAGE-----")), "x509");
  assert.equal(signatureKind(commit(`gpgsig ${SSH}\ngpgsig-sha256 ${SSH}`)), "unknown");
  // A CR, U+2028 or U+2029 is a byte inside a line, not a line break: none starts a header.
  for (const separator of ["\r", "\u2028", "\u2029"]) assert.equal(signatureKind(commit(`author t <t@example.com> 1 +0000${separator}gpgsig ${SSH}`)), null, JSON.stringify(separator));
  // A header name in the middle of a line, in a continuation line, or in the message is nothing.
  assert.equal(signatureKind(commit(`author t <t@example.com> 1 +0000 gpgsig ${SSH}`)), null);
  assert.equal(signatureKind(commit(`gpgsig -----BEGIN PGP SIGNATURE-----\n gpgsig ${SSH}`)), "openpgp");
  assert.equal(signatureKind(commit("parent y", `gpgsig ${SSH}\n`)), null);
  // The armor is matched exactly, not trimmed.
  for (const armor of [` ${SSH}`, `${SSH} `, `${SSH}\r`, ""]) assert.equal(signatureKind(commit(`gpgsig ${armor}`)), "unknown", JSON.stringify(armor));
  for (const name of ["constructor", "__proto__", "toString"]) assert.equal(signatureKind(commit(`gpgsig ${name}`)), "unknown");
});

test("git for reading a history sees none of the environment's git settings, agents or prompts, and no replaced or grafted commits", () => {
  const env = gitEnv({ PATH: "/bin", HOME: "/home/x", GIT_DIR: "/elsewhere/.git", GIT_CONFIG_PARAMETERS: "'gpg.ssh.program'='evil'", GIT_CONFIG_COUNT: "1", SSH_AUTH_SOCK: "/agent" });
  assert.equal(env.PATH, "/bin");
  for (const name of ["GIT_DIR", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "SSH_AUTH_SOCK"]) assert.equal(env[name], undefined, name);
  assert.deepEqual(
    [env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_NOSYSTEM, env.GIT_TERMINAL_PROMPT, env.GIT_NO_LAZY_FETCH, env.GIT_OPTIONAL_LOCKS, env.GIT_NO_REPLACE_OBJECTS, env.GIT_GRAFT_FILE],
    ["/dev/null", "1", "0", "1", "0", "1", "/dev/null"],
  );
});

// ----------------------------------------------------------- working tree --

const sha1 = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/**
 * A folder holding `files`, and a Git that answers compareWorktree's questions about it as a clone whose HEAD
 * has `tree` would: `ignored` paths are what check-ignore names; `fail` makes one command fail.
 */
function world({ files, tree, ignored = [], fail = null }: { files: Record<string, string>; tree: Record<string, string>; ignored?: string[]; fail?: string | null }) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-tree-")));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  }
  fs.mkdirSync(path.join(repo, ".git"));
  const ok = (stdout: string): GitResult<string> => ({ status: 0, stdout, stderr: "" });
  const answers: Record<string, (input: string) => GitResult<string>> = {
    "rev-parse --show-toplevel": () => ok(`${repo}\n`),
    "config --list --show-scope --includes -z": () => ok(""),
    "ls-files -v -z": () => ok(Object.keys(tree).map((name) => `H ${name}\0`).join("")),
    "rev-parse --show-object-format": () => ok("sha1\n"),
    "ls-tree -r -z --full-tree HEAD": () => ok(Object.entries(tree).map(([name, text]) => `100644 blob ${sha1(text)}\t${name}\0`).join("")),
    "check-ignore --no-index -z --stdin": (input) => {
      const hits = input.split("\0").filter((name) => ignored.includes(name));
      return { status: hits.length ? 0 : 1, stdout: hits.map((name) => `${name}\0`).join(""), stderr: "" };
    },
  };
  const git: Git = {
    repo,
    text(args, call = {}) {
      const key = args.join(" ");
      if (key === fail) return { status: 128, stdout: "", stderr: "fatal" };
      const answer = answers[key];
      if (!answer) throw new Error(`unexpected git ${key}`);
      return answer(call.input ?? "");
    },
    bytes: () => {
      throw new Error("not used");
    },
  };
  return { git, repo, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

test("the working tree is compared file by file with the commit's tree: changed, missing and unignored extra files differ, ignored ones are outside", () => {
  const tree = { "src/a.ts": "a\n", "README.md": "r\n", ".gitignore": "node_modules/\n" };
  const same = world({ files: tree, tree });
  assert.deepEqual(compareWorktree(same.git, "HEAD"), { refused: null, differs: [], outside: [] });
  same.done();
  const changed = world({ files: { ...tree, "src/a.ts": "b\n", "extra.ts": "x\n", "node_modules/x/index.js": "x\n" }, tree, ignored: ["node_modules/"] });
  fs.rmSync(path.join(changed.repo, "README.md"));
  assert.deepEqual(compareWorktree(changed.git, "HEAD"), { refused: null, differs: ["README.md", "extra.ts", "src/a.ts"], outside: ["node_modules/"] });
  // A symlink where the tree has a file differs, whatever it points at.
  fs.writeFileSync(path.join(changed.repo, "elsewhere"), "r\n");
  fs.symlinkSync(path.join(changed.repo, "elsewhere"), path.join(changed.repo, "README.md"));
  assert.ok(compareWorktree(changed.git, "HEAD").differs.includes("README.md"));
  changed.done();
});

test("a working tree that can't be compared is refused, never reported as the commit", () => {
  const tree = { "a.ts": "a\n" };
  for (const fail of ["rev-parse --show-toplevel", "config --list --show-scope --includes -z", "ls-files -v -z", "rev-parse --show-object-format", "ls-tree -r -z --full-tree HEAD", "check-ignore --no-index -z --stdin"]) {
    const w = world({ files: { ...tree, "extra.ts": "x\n" }, tree, fail });
    const result = compareWorktree(w.git, "HEAD");
    assert.notEqual(result.refused, null, fail);
    w.done();
  }
});
