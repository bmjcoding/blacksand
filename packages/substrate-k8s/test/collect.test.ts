import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { cleanPath, collectPatch, readTar } from "../src/collect.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", COPYFILE_DISABLE: "1" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { env }).toString().trim();

/** A base repository, its bundle, and an agent's workspace cloned from it. */
function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-collect-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "README.md"), "base\n");
  fs.writeFileSync(path.join(origin, ".gitignore"), "node_modules/\n*.log\n");
  fs.writeFileSync(path.join(origin, "kept.log"), "tracked though ignored\n");
  git(origin, "add", "README.md", ".gitignore");
  git(origin, "add", "-f", "kept.log");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD");
  const bundle = execFileSync("git", ["-C", origin, "bundle", "create", "-", "HEAD"], { env, stdio: ["ignore", "pipe", "ignore"] });
  const ws = path.join(root, "ws");
  git(root, "clone", "-q", origin, ws);
  /** The workspace as the sandbox's export step sends it: a pax archive with every .git left out. */
  const exportTar = () => {
    const file = path.join(root, "export.tar");
    execFileSync("tar", ["-C", ws, "--format", "pax", "--exclude", ".git", "-cf", file, "."], { env });
    return file;
  };
  return { root, base, bundle, ws, exportTar };
}

test("the patch is every change from the base to the exported tree, made outside the agent's git", () => {
  const { base, bundle, ws, exportTar } = scene();
  fs.writeFileSync(path.join(ws, "README.md"), "changed\n");
  fs.writeFileSync(path.join(ws, "new.txt"), "new\n");
  fs.writeFileSync(path.join(ws, "kept.log"), "changed too\n");
  fs.writeFileSync(path.join(ws, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync("README.md", path.join(ws, "link"));
  fs.mkdirSync(path.join(ws, "node_modules"));
  fs.writeFileSync(path.join(ws, "node_modules", "dep.js"), "ignored\n");
  fs.writeFileSync(path.join(ws, "debug.log"), "ignored\n");
  const out = collectPatch(bundle, base, exportTar());
  const patch = out.patch.toString();
  assert.match(patch, /^\+changed$/m);
  assert.match(patch, /^\+\+\+ b\/new\.txt$/m);
  assert.match(patch, /^\+changed too$/m, "a tracked file is compared even though .gitignore matches it");
  assert.match(patch, /^new file mode 100755\n.*\n--- \/dev\/null\n\+\+\+ b\/run\.sh$/m);
  assert.match(patch, /^new file mode 120000$/m);
  assert.doesNotMatch(patch, /node_modules|debug\.log/);
  assert.deepEqual({ files: out.files, ignored: out.ignored, skipped: out.skipped }, { files: 5, ignored: 2, skipped: 0 });
});

test("an agent that replaces the base commit in its own .git can't hide its change", () => {
  const { base, bundle, ws, exportTar } = scene();
  fs.writeFileSync(path.join(ws, "hidden.txt"), "the agent wants this unseen\n");
  // The attack: a replacement object for the base whose tree already holds the change.
  git(ws, "add", "--all");
  const tree = git(ws, "write-tree");
  const forged = git(ws, "commit-tree", tree, "-p", base, "-m", "forged");
  git(ws, "replace", base, forged);
  assert.equal(git(ws, "diff", "--cached", base), "", "the agent's own git now reports nothing");
  const patch = collectPatch(bundle, base, exportTar()).patch.toString();
  assert.match(patch, /^\+the agent wants this unseen$/m);
});

test("a tracked file the agent hides behind a new ignore rule still shows, and so does the rule", () => {
  const { base, bundle, ws, exportTar } = scene();
  fs.appendFileSync(path.join(ws, ".gitignore"), "README.md\n");
  fs.writeFileSync(path.join(ws, "README.md"), "changed under cover\n");
  const patch = collectPatch(bundle, base, exportTar()).patch.toString();
  assert.match(patch, /^\+changed under cover$/m, "tracked in the base, so never ignored");
  assert.match(patch, /^\+README\.md$/m, "the new ignore rule is in the patch");
});

test("the patch applies to the base and reproduces the exported tree", () => {
  const { root, base, bundle, ws, exportTar } = scene();
  fs.writeFileSync(path.join(ws, "README.md"), "changed\n");
  fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([0, 1, 2, 255, 0]));
  fs.rmSync(path.join(ws, "kept.log"));
  const out = collectPatch(bundle, base, exportTar());
  const check = path.join(root, "check");
  git(root, "clone", "-q", path.join(root, "origin"), check);
  execFileSync("git", ["-C", check, "apply", "--binary", "-"], { input: out.patch, env });
  assert.equal(fs.readFileSync(path.join(check, "README.md"), "utf8"), "changed\n");
  assert.deepEqual([...fs.readFileSync(path.join(check, "bin.dat"))], [0, 1, 2, 255, 0]);
  assert.equal(fs.existsSync(path.join(check, "kept.log")), false);
});

/** A ustar archive of exactly these entries, in this order: each name with its own bytes, as GNU tar --hard-dereference writes them. */
function ustar(entries: { path: string; data?: string; type?: "0" | "1" | "6"; link?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const h = Buffer.alloc(512);
    h.write(e.path, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(e.type ?? "0", 156);
    h.write(e.link ?? "", 157, 100);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

test("a tracked name hard-linked to an ignored name keeps its new bytes, whichever comes first in the archive", () => {
  const { root, base, bundle } = scene();
  const changed = "changed tracked data\n";
  for (const order of [["ignored.log", "README.md"], ["README.md", "ignored.log"]]) {
    const file = path.join(root, `deref-${order[0]}.tar`);
    // As the sandbox's exporter writes them: both names of the link, each with the bytes, and the ignore rule.
    fs.writeFileSync(file, ustar([...order.map((name) => ({ path: `./${name}`, data: changed })), { path: "./.gitignore", data: "ignored.log\n" }, { path: "./kept.log", data: "tracked though ignored\n" }]));
    const out = collectPatch(bundle, base, file);
    const check = path.join(root, `check-${order[0]}`);
    git(root, "clone", "-q", path.join(root, "origin"), check);
    execFileSync("git", ["-C", check, "apply", "--binary", "-"], { input: out.patch, env });
    assert.equal(fs.readFileSync(path.join(check, "README.md"), "utf8"), changed, order.join(" then "));
    assert.equal(fs.existsSync(path.join(check, "ignored.log")), false, "the ignored name stays out");
    assert.equal(out.ignored, 1);
  }
});

test("an archive with a hard-link entry is refused: the run's exporter never writes one", () => {
  const { root, base, bundle, ws } = scene();
  // Real hard links, archived by a tar that keeps them as links.
  fs.unlinkSync(path.join(ws, "README.md"));
  fs.writeFileSync(path.join(ws, "ignored.log"), "changed tracked data\n");
  fs.linkSync(path.join(ws, "ignored.log"), path.join(ws, "README.md"));
  fs.writeFileSync(path.join(ws, ".gitignore"), "ignored.log\n");
  const file = path.join(root, "hardlink.tar");
  execFileSync("tar", ["-C", ws, "--format", "pax", "-cf", file, "ignored.log", "README.md", ".gitignore"], { env });
  assert.ok(readTar(file).some((e) => e.kind === "hardlink"), "the archive really has a link entry");
  assert.throws(() => collectPatch(bundle, base, file), /hard-link entry/);
  assert.throws(() => collectPatch(bundle, base, (fs.writeFileSync(path.join(root, "l.tar"), ustar([{ path: "./x", type: "1", link: "./README.md" }])), path.join(root, "l.tar"))), /hard-link entry/);
});

test("a tracked file that can't be compared fails collection, rather than showing as deleted", () => {
  const { root, base, bundle } = scene();
  const file = path.join(root, "fifo.tar");
  fs.writeFileSync(file, ustar([{ path: "./README.md", type: "6" }, { path: "./.gitignore", data: "node_modules/\n*.log\n" }, { path: "./kept.log", data: "tracked though ignored\n" }]));
  assert.throws(() => collectPatch(bundle, base, file), /base tracks/);
  fs.writeFileSync(file, ustar([{ path: "./README.md", data: "base\n" }, { path: "./new-pipe", type: "6" }, { path: "./.gitignore", data: "node_modules/\n*.log\n" }, { path: "./kept.log", data: "tracked though ignored\n" }]));
  assert.equal(collectPatch(bundle, base, file).skipped, 1, "a new pipe is simply not part of the patch");
});

test("a bundle whose HEAD isn't the recorded base is refused", () => {
  const { bundle, exportTar } = scene();
  assert.throws(() => collectPatch(bundle, "1".repeat(40), exportTar()), /isn't the run's base/);
});

test("export paths git mustn't hold are left out", () => {
  for (const bad of ["", ".", "/etc/passwd", "../x", "a/../b", ".git/config", "sub/.GIT/hooks/x", "a\nb"]) assert.equal(cleanPath(bad), null, JSON.stringify(bad));
  assert.equal(cleanPath("./src/a.ts"), "src/a.ts");
});

test("a truncated or foreign archive is refused, not half-read", () => {
  const { root, ws } = scene();
  fs.writeFileSync(path.join(ws, "a.txt"), "x".repeat(2000));
  const file = path.join(root, "t.tar");
  execFileSync("tar", ["-C", ws, "--format", "pax", "--exclude", ".git", "-cf", file, "."], { env });
  fs.truncateSync(file, 1024 + 512);
  assert.throws(() => readTar(file), /past its end|closing blocks/);
  fs.writeFileSync(file, Buffer.alloc(2048, 1));
  assert.throws(() => readTar(file), /ustar/);
});
