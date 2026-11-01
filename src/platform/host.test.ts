import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EXEC_ENV, rootRunProblem, systemHost } from "./host.ts";

test("a program runs only by absolute path, with nothing of the caller's environment", () => {
  const host = systemHost();
  assert.match(host.exec("env", []).error ?? "", /isn't an absolute path/);
  const before = process.env.BLACKSAND_SECRET_PROBE;
  process.env.BLACKSAND_SECRET_PROBE = "leaked";
  try {
    const out = host.exec("/usr/bin/env", []);
    assert.equal(out.status, 0, out.stderr);
    const env = Object.fromEntries(out.stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
    assert.deepEqual(env, { ...EXEC_ENV });
  } finally {
    if (before === undefined) delete process.env.BLACKSAND_SECRET_PROBE;
    else process.env.BLACKSAND_SECRET_PROBE = before;
  }
  assert.equal(host.exec("/nonexistent/blacksand-probe", []).error, "not found");
});

test("a program gets no stdin: one that reads it sees end of file at once", () => {
  const out = systemHost().exec("/bin/cat", []);
  assert.deepEqual([out.status, out.stdout], [0, ""]);
});

/** lstat over a made-up tree: path -> [owner, mode] (S_IFDIR 0o40000, S_IFREG 0o100000, S_IFLNK 0o120000). */
function tree(entries: { [path: string]: readonly [number, number] }) {
  return (at: string) => {
    const entry = entries[at];
    if (!entry) throw Object.assign(new Error(`ENOENT ${at}`), { code: "ENOENT" });
    const [uid, mode] = entry;
    const type = mode & 0o170000;
    return { uid, mode, isDirectory: () => type === 0o40000, isFile: () => type === 0o100000, isSymbolicLink: () => type === 0o120000 } as unknown as Stats;
  };
}
const SYSTEM = { "/": [0, 0o40755], "/usr": [0, 0o40755], "/usr/bin": [0, 0o40755], "/usr/bin/true": [0, 0o100755] } as const;
const noAcl = () => null;

test("as root, a program is refused unless every name on its path is a real, root-owned folder or executable that only root can write", () => {
  const lstat = tree({
    ...SYSTEM,
    "/usr/bin/notes": [0, 0o100644],
    "/opt": [0, 0o40755],
    "/opt/homebrew": [501, 0o40755],
    "/opt/homebrew/bin": [501, 0o40755],
    "/opt/homebrew/bin/git": [501, 0o120755],
    "/srv": [0, 0o40775],
    "/srv/tool": [0, 0o100755],
    "/usr/local": [0, 0o40755],
    "/usr/local/bin": [0, 0o40755],
    "/usr/local/bin/dir": [0, 0o40755],
  });
  const problem = (file: string) => rootRunProblem(file, { lstat, acl: noAcl });
  assert.equal(problem("/usr/bin/true"), null);
  assert.equal(problem("/opt/homebrew/bin/git"), "/opt/homebrew isn't root's");
  assert.equal(problem("/srv/tool"), "/srv is writable by others");
  assert.equal(problem("/usr/bin/notes"), "/usr/bin/notes isn't executable");
  assert.equal(problem("/usr/local/bin/dir"), "/usr/local/bin/dir isn't a regular file");
  assert.equal(problem("/missing"), "/missing doesn't exist");
  assert.equal(problem("/usr/bin/../bin/true"), "/usr/bin/../bin/true isn't a plain absolute path");
});

test("as root, a symbolic link anywhere on the path is refused, even one pointing at a safe program: it could be swapped after the check", () => {
  // Root-owned on the way down, and the link itself root's: still refused, since the check can't follow what the spawn will.
  const lstat = tree({ ...SYSTEM, "/usr/local": [0, 0o40755], "/usr/local/bin": [0, 0o40755], "/usr/local/bin/true": [0, 0o120755], "/usr/sbin": [0, 0o120755] });
  assert.equal(rootRunProblem("/usr/local/bin/true", { lstat, acl: noAcl }), "/usr/local/bin/true is a symbolic link");
  assert.equal(rootRunProblem("/usr/sbin/sshd", { lstat, acl: noAcl }), "/usr/sbin is a symbolic link");
  // The real thing: a link this account made, to /usr/bin/true.
  const dir = mkdtempSync(join(tmpdir(), "blacksand-link-"));
  try {
    symlinkSync("/usr/bin/true", join(dir, "true"));
    assert.match(rootRunProblem(join(dir, "true")) ?? "", /is a symbolic link|isn't root's/);
    assert.match(rootRunProblem(`${realpathSync(dir)}/true`) ?? "", /isn't root's/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("as root, an access control list granting more than root on the program or a folder above it is refused (Apple's ls reads it)", { skip: process.platform !== "darwin" && "macOS ACLs" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "blacksand-acl-"));
  try {
    const file = join(realpathSync(dir), "tool");
    writeFileSync(file, "", { mode: 0o755 });
    assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow write", file]).status, 0);
    // The modes still say 0755: only the ACL tells.
    const parts = file.split("/").filter(Boolean).map((_, i, all) => `/${all.slice(0, i + 1).join("/")}`);
    const lstat = tree({ "/": [0, 0o40755], ...Object.fromEntries(parts.map((p) => [p, [0, p === file ? 0o100755 : 0o40755] as const])) });
    assert.match(rootRunProblem(file, { lstat }) ?? "", /\/tool has an access control list that allows more than root \((?:group:)?everyone allow write\)/);
    // On a folder above it, a grant to add or delete entries would let someone replace the program.
    assert.equal(spawnSync("/bin/chmod", ["-a", "everyone allow write", file]).status, 0);
    assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow add_file,delete_child", realpathSync(dir)]).status, 0);
    assert.match(rootRunProblem(file, { lstat }) ?? "", /blacksand-acl-\w+ has an access control list that allows more than root/);
    assert.equal(rootRunProblem("/usr/bin/true"), null, "Apple's own programs pass the real checks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
