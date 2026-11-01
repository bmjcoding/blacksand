// node --test test/: the folder agent accounts share with the updater
// (lib/shared-dir.mjs): its whole path is checked, ACLs included, and its
// operations stay in the folders checked.
import fsDefault, * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { aclWriteGrants, clearRequests, ensureRequestDir, ensureSharedDir, publishShared } from "../lib/shared-dir.mjs";
/** A private stand-in for /Users/Shared: <tmp>/Shared/t3blackout/update-requests. */
function sharedRoot() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-shared-")));
  const shared = path.join(base, "Shared");
  fs.mkdirSync(shared, { mode: 0o755 });
  const root = path.join(shared, "t3blackout");
  return { base, shared, root, requests: path.join(root, "update-requests") };
}

const mode = (file) => fs.lstatSync(file).mode & 0o7777;

test("the request folder is made 1733 inside a 755 shared folder", () => {
  const { root, requests } = sharedRoot();
  ensureRequestDir(requests);
  assert.equal(mode(root), 0o755);
  assert.equal(mode(requests), 0o1733);
  // Again, over what's there: still fine, and corrected if loosened.
  fs.chmodSync(requests, 0o777);
  ensureRequestDir(requests);
  assert.equal(mode(requests), 0o1733);
});

test("a symlink in place of the request folder is refused, and its target left alone", () => {
  const { base, root, requests } = sharedRoot();
  const victim = path.join(base, "victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, "id_ed25519"), "secret");
  ensureSharedDir(root);
  fs.symlinkSync(victim, requests);
  assert.throws(() => ensureRequestDir(requests), /isn't a real folder/);
  assert.equal(mode(victim), 0o700);
  // The updater's cleanup doesn't follow it either.
  clearRequests(requests);
  assert.equal(fs.readFileSync(path.join(victim, "id_ed25519"), "utf8"), "secret");
});

test("a symlinked or loosened shared folder is refused", () => {
  const { base, root, requests } = sharedRoot();
  fs.mkdirSync(path.join(base, "elsewhere"));
  fs.symlinkSync(path.join(base, "elsewhere"), root);
  assert.throws(() => ensureRequestDir(requests), /isn't a real folder/);
  fs.rmSync(root);
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o777);
  assert.throws(() => ensureRequestDir(requests), /writable by other accounts/);
});

test("the shared folder can't live where others can rename it", () => {
  const { shared, root, requests } = sharedRoot();
  fs.chmodSync(shared, 0o777);
  assert.throws(() => ensureRequestDir(requests), /not sticky/);
  fs.chmodSync(shared, 0o1777);
  ensureRequestDir(requests);
  assert.equal(mode(root), 0o755);
});

test("clearing requests handles each entry and never stops on one", () => {
  const { base, requests } = sharedRoot();
  ensureRequestDir(requests);
  const target = path.join(base, "keep.txt");
  fs.writeFileSync(target, "keep");
  fs.writeFileSync(path.join(requests, "501-1"), "");
  fs.symlinkSync(target, path.join(requests, "link"));
  fs.mkdirSync(path.join(requests, "empty-dir"));
  fs.mkdirSync(path.join(requests, "full-dir"));
  fs.writeFileSync(path.join(requests, "full-dir", "inside"), "x");
  const logged = [];
  assert.equal(clearRequests(requests, { log: (line) => logged.push(line) }), 4);
  assert.deepEqual(fs.readdirSync(requests), ["full-dir"]);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(requests, "full-dir", "inside"), "utf8"), "x");
  assert.match(logged.join("\n"), /left .*full-dir/);
  // A missing folder is nothing to do.
  assert.equal(clearRequests(path.join(base, "nope", "update-requests")), 0);
});

test("published files are 644 and replaced whole", () => {
  const { root } = sharedRoot();
  const file = publishShared(root, "usage-model-rates.json", "{\"a\":1}");
  assert.equal(mode(file), 0o644);
  publishShared(root, "usage-model-rates.json", "{\"a\":2}");
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":2}");
  assert.deepEqual(fs.readdirSync(root), ["usage-model-rates.json"]);
});

// ----------------------------------------------------------- paths and swaps --

const isMac = process.platform === "darwin";

/** <tmp>/a/b/Shared/t3blackout/update-requests, every level 755. */
function layout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-shared-")));
  const shared = path.join(base, "a", "b", "Shared");
  fs.mkdirSync(shared, { recursive: true, mode: 0o755 });
  const root = path.join(shared, "t3blackout");
  return { base, a: path.join(base, "a"), shared, root, requests: path.join(root, "update-requests") };
}

/** Runs `fn` with fs.`name` wrapped by `wrap(real)`, as every module sees it. */
function withFs(name, wrap, fn) {
  const real = fsDefault[name];
  fsDefault[name] = wrap(real);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsDefault[name] = real;
    syncBuiltinESMExports();
  }
}

test("an ancestor other accounts can write, however far up, is refused", () => {
  const { a, requests } = layout();
  fs.chmodSync(a, 0o777);
  assert.throws(() => ensureRequestDir(requests), /a is writable by other accounts and not sticky/);
  assert.throws(() => publishShared(path.dirname(requests), "x.json", "{}"), /not sticky/);
  const logged = [];
  assert.equal(clearRequests(requests, { log: (line) => logged.push(line) }), 0);
  fs.chmodSync(a, 0o1777);
  ensureRequestDir(requests);
  assert.equal(mode(requests), 0o1733);
});

test("an ACL that lets others write an ancestor is refused; one on the shared folder is removed", { skip: !isMac && "macOS ACLs" }, () => {
  const { a, root, requests } = layout();
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow add_subdirectory,delete_child", a]).status, 0);
  assert.deepEqual(aclWriteGrants(a), ["group:everyone allow add_subdirectory,delete_child"]);
  assert.throws(() => ensureRequestDir(requests), /has ACL entries other accounts could write through/);
  spawnSync("/bin/chmod", ["-N", a]);
  // Read-only grants are fine; deny entries too.
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow list,search", a]).status, 0);
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone deny delete", a]).status, 0);
  ensureSharedDir(root);
  // The shared folder is yours: a write grant on it goes, as its 755 says.
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow add_file,delete_child", root]).status, 0);
  assert.equal(mode(root), 0o755);
  ensureRequestDir(requests);
  assert.deepEqual(aclWriteGrants(root), []);
  assert.deepEqual(aclWriteGrants(requests), []);
  // Until then the updater doesn't read requests from under it.
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow delete_child", root]).status, 0);
  const logged = [];
  clearRequests(requests, { log: (line) => logged.push(line) });
  assert.match(logged.join("\n"), /not reading update requests: .*ACL/);
});

test("a folder swapped after it was checked doesn't redirect the request folder's setup", () => {
  const { base, root, requests } = layout();
  ensureSharedDir(root);
  const victim = path.join(base, "victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  const moved = `${root}.moved`;
  // Just as the request folder is made, the shared folder is renamed away and
  // one of your own private folders put in its place. (Whether the call then
  // fails, on the ACL check that finds the path changed, doesn't matter here.)
  try {
    withFs("mkdirSync", (real) => (dir, options) => {
      if (dir === "update-requests" && !fs.existsSync(moved)) {
        fs.renameSync(root, moved);
        fs.symlinkSync(victim, root);
      }
      return real(dir, options);
    }, () => ensureRequestDir(requests));
  } catch {}
  assert.equal(mode(victim), 0o700, "the victim's mode is untouched");
  assert.deepEqual(fs.readdirSync(victim), []);
  assert.equal(mode(path.join(moved, "update-requests")), 0o1733, "made in the folder that was checked");
});

test("a request folder swapped mid-cleanup never loses another folder's files", () => {
  const { base, requests } = layout();
  ensureRequestDir(requests);
  fs.writeFileSync(path.join(requests, "501-1"), "");
  const victim = path.join(base, "victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "501-1"), "precious");
  const moved = `${requests}.moved`;
  withFs("readdirSync", (real) => (dir, ...rest) => {
    const names = real(dir, ...rest);
    if (!fs.existsSync(moved)) {
      fs.renameSync(requests, moved);
      fs.symlinkSync(victim, requests);
    }
    return names;
  }, () => clearRequests(requests));
  assert.equal(fs.readFileSync(path.join(victim, "501-1"), "utf8"), "precious");
  assert.deepEqual(fs.readdirSync(moved), [], "the checked folder was the one cleared");
});

test("the working folder is back as it was after each operation", () => {
  const { root, requests } = layout();
  const before = process.cwd();
  ensureRequestDir(requests);
  publishShared(root, "usage-model-rates.json", "{}");
  clearRequests(requests);
  assert.equal(process.cwd(), before);
});
