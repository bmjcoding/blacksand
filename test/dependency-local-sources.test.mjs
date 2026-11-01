// node --test test/: what a lockfile installs from the checkout is what the pinned
// commit has there. A `link:` or `file:` dependency has no registry source or
// integrity anyone checked, so: every link must be an importer's and name a folder
// inside upstream's tree, never in node_modules, which both dependency gates read
// from the lockfile itself (lib/lockfile.mjs); and before the frozen install every
// workspace project, link target, `file:` folder and tarball must lead, after
// symlinks, to something the pinned commit tracks (lib/resolution.mjs
// checkLinksInTree, given `git ls-tree` of that commit), and a copied folder may hold
// nothing else. (The staged production install, which no commit's tree backs, may
// not install from local folders at all: test/build-stage-install.test.mjs.)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { dependencyAgeGate, lockIdentities, resolutionKind } from "../lib/gates.mjs";
import { inTree, parseLockfile } from "../lib/lockfile.mjs";
import { checkLinksInTree, checkResolution, localSources, trackedTree } from "../lib/resolution.mjs";
import { COMMON, UPSTREAM, lockfile } from "./pipeline-fixtures.mjs";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-local-sources-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const INTEGRITY = "sha512-chlxkgJp4PZIiff6kUe/MWLp5+soELWNYA2IsOTus1YwKj8d9JZS6QsU7Ryqwhb1f4i0nQ5SsoUj6d5kGgq0KQ==";
const OLD = { versions: { "1.0.0": { dist: { integrity: INTEGRITY } } }, time: { "1.0.0": "2015-01-01T00:00:00.000Z" } };
globalThis.fetch = async (url) => (String(url) === "https://registry.npmjs.org/is-number" ? Response.json(OLD) : new Response("not found", { status: 404 }));

/**
 * A pnpm 12 lockfile: the root depends on is-number and `deps` ([name, version]
 * as pnpm writes them), packages/app links ../lib, and `packages` ([key,
 * resolution]) are the local packages those name.
 */
function lock(deps = [], packages = []) {
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      is-number:",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    ...deps.flatMap(([name, version]) => [`      ${name}:`, `        specifier: ${version}`, `        version: ${version}`]),
    "  packages/app:",
    "    dependencies:",
    "      lib:",
    "        specifier: workspace:*",
    "        version: link:../lib",
    "packages:",
    "  is-number@1.0.0:",
    `    resolution: {integrity: ${INTEGRITY}}`,
    ...packages.flatMap(([key, resolution]) => [`  '${key}':`, `    resolution: ${resolution}`]),
    "snapshots:",
    "  is-number@1.0.0: {}",
    ...packages.map(([key]) => `  '${key}': {}`),
    "",
  ].join("\n");
}

const FOLDER = ["pkg@file:vendor/pkg", "{directory: vendor/pkg, type: directory}"];
const TARBALL = ["md@file:vendor/md-1.0.0.tgz", "{integrity: sha512-AAAA, tarball: file:vendor/md-1.0.0.tgz}"];
const LOCAL = lock([["pkg", "file:vendor/pkg"], ["md", "file:vendor/md-1.0.0.tgz"], ["also", "link:packages/also"]], [FOLDER, TARBALL]);

const git = (cwd, args) => {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const write = (file, content = "x\n") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/**
 * A committed checkout: the workspace projects, a vendored folder and tarball, and
 * packages/also, a tracked symlink to packages/lib. `extra(root)` adds to it
 * before the commit. Returns { root, tree } (tree: trackedTree of the commit).
 */
function checkout(name, extra = () => {}) {
  const root = path.join(dir, name);
  for (const file of ["package.json", "packages/app/package.json", "packages/lib/package.json", "vendor/pkg/package.json", "vendor/pkg/src/index.js", "vendor/md-1.0.0.tgz"]) write(path.join(root, file));
  fs.symlinkSync("lib", path.join(root, "packages/also"));
  git(root, ["init", "-q", "-b", "main"]);
  extra(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "pinned"]);
  return { root, tree: trackedTree(git(root, ["ls-tree", "-r", "-t", "-z", "HEAD"])) };
}

test("trackedTree reads git ls-tree: folders, files, executables and symlinks", () => {
  const { tree } = checkout("tree", (root) => {
    write(path.join(root, "run.sh"));
    fs.chmodSync(path.join(root, "run.sh"), 0o755);
  });
  assert.equal(tree.get("vendor"), "dir");
  assert.equal(tree.get("vendor/pkg/src/index.js"), "file");
  assert.equal(tree.get("run.sh"), "file");
  assert.equal(tree.get("packages/also"), "symlink");
  assert.throws(() => trackedTree("100644 blob abc"), /can't read git ls-tree's entry/);
});

test("what the lockfile installs from the checkout: workspace projects, links, file: folders and tarballs", () => {
  const sources = localSources(parseLockfile(LOCAL)).map(({ where, kind }) => `${kind} ${where}`);
  assert.deepEqual(sources.sort(), ["copy vendor/pkg", "link .", "link packages/also", "link packages/app", "link packages/lib", "tarball vendor/md-1.0.0.tgz"]);
  // A package resolved from somewhere its version doesn't name, or the checkout itself.
  for (const [key, resolution] of [
    ["pkg@file:vendor/pkg", "{directory: vendor/other, type: directory}"],
    ["md@file:vendor/md-1.0.0.tgz", "{integrity: sha512-AAAA, tarball: 'file:vendor/md-2.0.0.tgz'}"],
    ["md@file:vendor/md-1.0.0.tgz", "{integrity: sha512-AAAA}"],
    ["root@file:.", "{directory: ., type: directory}"],
  ]) {
    assert.throws(() => localSources(parseLockfile(lock([], [[key, resolution]]))), /isn't resolved from the folder or file its version names/, `${key} ${resolution}`);
  }
});

test("a link or file: name outside the tree, or in node_modules, fails in the lockfile itself, for both dependency gates", async () => {
  const base = lock();
  assert.equal(inTree("packages/lib"), true);
  for (const where of ["node_modules/unchecked", "packages/lib/node_modules/x", "../outside", "/tmp/x"]) assert.equal(inTree(where), false, where);
  for (const link of ["link:../../outside", "link:/tmp/outside", "link:packages/../../outside"]) {
    const next = lock([["outside", link]]);
    await assert.rejects(dependencyAgeGate(base, next), /links outside to .*, outside upstream's tree/, link);
    await assert.rejects(checkResolution(base, next, { overrides: [] }), /outside upstream's tree/, link);
  }
  assert.equal((await dependencyAgeGate(base, lock([["outside", "link:packages/outside"]]))).ok, true, "a link inside the tree is upstream's own");
  // A link to an untracked folder, and the same through a file: folder.
  const linked = lock([["outside", "link:node_modules/unchecked"]]);
  const copied = lock([["outside", "file:node_modules/unchecked"]], [["outside@file:node_modules/unchecked", "{directory: node_modules/unchecked, type: directory}"]]);
  for (const next of [linked, copied]) {
    await assert.rejects(dependencyAgeGate(base, next), /node_modules\/unchecked/);
    await assert.rejects(checkResolution(base, next, { overrides: [] }), /node_modules\/unchecked/);
  }
  assert.throws(() => parseLockfile(linked), /links outside to node_modules\/unchecked, outside upstream's tree \(or in node_modules/);
  // pnpm writes links only for importers; one among the packages is upstream's own only inside the tree.
  assert.throws(() => resolutionKind("x@link:../outside", { directory: "../outside" }, new Map()), /isn't resolved inside upstream's tree/);
  assert.equal(resolutionKind("x@link:packages/x", { directory: "packages/x" }, new Map()), "local");
  assert.throws(() => resolutionKind("x@file:vendor/node_modules/x", { directory: "vendor/node_modules/x", type: "directory" }, new Map()), /isn't resolved inside upstream's tree/);
  // And a workspace project there.
  const project = lock().replace(/ {2}packages\/app:\n(?: {4}.*\n)+/, "  node_modules/app: {}\n");
  assert.throws(() => localSources(parseLockfile(project)), /workspace project node_modules\/app isn't a path in upstream's tree/);
  // Upstream's own vendored folders and tarballs are still its own.
  assert.equal(lockIdentities(LOCAL).size, 1);
  assert.equal((await dependencyAgeGate(base, LOCAL)).ok, true);
});

test("the pinned commit's folders, tarballs and in-tree symlinks pass; node_modules in a copied folder is left out, as pnpm does", () => {
  const { root, tree } = checkout("good");
  checkLinksInTree(LOCAL, root, tree);
  // Installed dependencies inside a file: folder, which pnpm doesn't copy.
  write(path.join(root, "vendor/pkg/node_modules/dep/index.js"));
  checkLinksInTree(LOCAL, root, tree);
  // The check can't run without the commit's files.
  assert.throws(() => checkLinksInTree(LOCAL, root), /needs the pinned commit's files/);
  assert.throws(() => checkLinksInTree(LOCAL, root, new Map()), /needs the pinned commit's files/);
});

test("a file: folder or tarball that is a symlink out of the checkout is refused, though the symlink is committed", () => {
  const outside = path.join(dir, "outside");
  write(path.join(outside, "package.json"), '{"name":"outside","version":"1.0.0"}');
  // Committed, even: a tracked symlink doesn't make what it points at tracked.
  const { root, tree } = checkout("escape", (top) => fs.symlinkSync(outside, path.join(top, "packages/local")));
  const next = lock([["outside", "file:packages/local"]], [["outside@file:packages/local", "{directory: packages/local, type: directory}"]]);
  assert.throws(() => checkLinksInTree(next, root, tree), /outside@file:packages\/local leads out of upstream's checkout, to .*outside/);
  // The same for a tarball.
  write(path.join(outside, "md.tgz"));
  fs.symlinkSync(path.join(outside, "md.tgz"), path.join(root, "vendor/linked.tgz"));
  const tarball = lock([["md", "file:vendor/linked.tgz"]], [["md@file:vendor/linked.tgz", "{integrity: sha512-AAAA, tarball: file:vendor/linked.tgz}"]]);
  assert.throws(() => checkLinksInTree(tarball, root, tree), /leads out of upstream's checkout/);
});

test("untracked or generated targets are refused: build output, node_modules behind a symlink, missing paths", () => {
  const { root, tree } = checkout("untracked", (top) => {
    // A tracked symlink into node_modules, which no commit holds.
    fs.symlinkSync("../node_modules/unchecked", path.join(top, "packages/cached"));
  });
  write(path.join(root, "dist/lib/package.json"));
  write(path.join(root, "node_modules/unchecked/package.json"));
  write(path.join(root, "vendor/built.tgz"));
  const refused = [
    [lock([["out", "link:dist/lib"]]), /'s link out \(dist\/lib\) is dist\/lib, which isn't a folder upstream's pinned commit has/],
    [lock([["cached", "link:packages/cached"]]), /is node_modules\/unchecked, which isn't a folder upstream's pinned commit has/],
    [lock([["out", "file:dist/lib"]], [["out@file:dist/lib", "{directory: dist/lib, type: directory}"]]), /out@file:dist\/lib is dist\/lib, which isn't a folder/],
    [lock([["md", "file:vendor/built.tgz"]], [["md@file:vendor/built.tgz", "{integrity: sha512-AAAA, tarball: file:vendor/built.tgz}"]]), /is vendor\/built\.tgz, which isn't a file upstream's pinned commit has/],
    [lock([["md", "file:vendor/pkg"]], [["md@file:vendor/pkg", "{integrity: sha512-AAAA, tarball: file:vendor/pkg}"]]), /is vendor\/pkg, which isn't a file/],
    [lock([["gone", "link:packages/gone"]]), /link gone \(packages\/gone\) isn't in upstream's checkout/],
    [lock([["unchecked", "link:node_modules/unchecked"]]), /outside upstream's tree \(or in node_modules/],
  ];
  for (const [next, why] of refused) assert.throws(() => checkLinksInTree(next, root, tree), why);
});

test("a copied file: folder may hold nothing the commit doesn't, and no symlink", () => {
  const { root, tree } = checkout("contents");
  write(path.join(root, "vendor/pkg/src/generated.js"));
  assert.throws(() => checkLinksInTree(LOCAL, root, tree), /pkg@file:vendor\/pkg holds vendor\/pkg\/src\/generated\.js, which upstream's pinned commit doesn't/);
  fs.rmSync(path.join(root, "vendor/pkg/src/generated.js"));
  // pnpm follows symlinks when it copies a folder: even one to a tracked file brings that file's bytes.
  fs.symlinkSync("../../package.json", path.join(root, "vendor/pkg/src/root.json"));
  assert.throws(() => checkLinksInTree(LOCAL, root, tree), /holds a symlink, vendor\/pkg\/src\/root\.json/);
  // A linked (not copied) workspace folder may hold build output; the build makes some.
  fs.rmSync(path.join(root, "vendor/pkg/src/root.json"));
  write(path.join(root, "packages/lib/dist/index.js"));
  checkLinksInTree(LOCAL, root, tree);
});
test("links resolve from their importer; only importers may link", () => {
  const workspace = (desktopLink) =>
    [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a:",
      "        specifier: workspace:*",
      "        version: link:packages/a",
      "  apps/desktop:",
      "    dependencies:",
      "      a:",
      "        specifier: workspace:*",
      `        version: ${desktopLink}`,
      "      web:",
      "        specifier: workspace:*",
      "        version: link:../web",
      "packages: {}",
      "snapshots: {}",
      "",
    ].join("\n");
  assert.deepEqual(parseLockfile(workspace("link:../../packages/a")).links, [
    { importer: ".", name: "a", target: "packages/a" },
    { importer: "apps/desktop", name: "a", target: "packages/a" },
    { importer: "apps/desktop", name: "web", target: "apps/web" },
  ]);
  assert.throws(() => parseLockfile(workspace("link:../../../packages/a")), /apps\/desktop links a to \.\.\/\.\.\/\.\.\/packages\/a, outside upstream's tree/);
  assert.deepEqual(parseLockfile(UPSTREAM).links, [{ importer: ".", name: "local", target: "packages/local" }]);
  const linkedSnapshot = lockfile({ ...COMMON, "app@1.0.0": ["helper: link:../helper"] });
  assert.throws(() => parseLockfile(linkedSnapshot), /app@1\.0\.0\(peer@2\.0\.0\) links helper; only workspace projects may link/);
});

test("the build's check: no workspace folder or link target leads out of the checkout through a symlink", () => {
  const root = path.join(dir, "linked");
  const outside = path.join(dir, "linked-outside");
  fs.mkdirSync(path.join(root, "packages/local"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // What the pinned commit has (git ls-tree; the tests above run the real one).
  const tree = new Map([["packages", "dir"], ["packages/local", "dir"], ["packages/real", "dir"]]);
  checkLinksInTree(UPSTREAM, root, tree);
  // The same name, now a symlink out of the tree.
  fs.rmSync(path.join(root, "packages/local"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "packages/local"));
  // (packages/local is both a workspace project and the root's link target.)
  assert.throws(() => checkLinksInTree(UPSTREAM, root, tree), /packages\/local leads out of upstream's checkout/);
  // A symlinked folder that stays inside is fine; a missing one isn't.
  fs.rmSync(path.join(root, "packages/local"));
  fs.mkdirSync(path.join(root, "packages/real"));
  fs.symlinkSync("real", path.join(root, "packages/local"));
  checkLinksInTree(UPSTREAM, root, tree);
  fs.rmSync(path.join(root, "packages/local"));
  assert.throws(() => checkLinksInTree(UPSTREAM, root, tree), /isn't in upstream's checkout/);
});
