// node --test test/: the packager's staged production install (lib/stage-install.mjs).
// Upstream's packager runs `vp install --prod` in a scratch stage, with install scripts on
// and nothing checking what it resolves. The rule desktop/stage-install-guarded routes
// both its installs through the guard, which resolves without scripts, checks the
// lockfile like WORK's, then installs it frozen; shims refuse every other package-manager
// command aimed at the stage; and before packaging the build checks the staged files
// byte for byte against what the guard installed (lib/build.mjs verifyStageInstalls).
// The case run with the real npm is in build-stage-install.deep.test.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyStageInstalls } from "../lib/build.mjs";
import { makeRules } from "../lib/rules.mjs";
import { classify, installedPackages, main, releaseAgeConfig, shimEnv, stageChanges, stageContents, stageDigest } from "../lib/stage-install.mjs";
import { applyRules } from "../lib/strip-engine.mjs";
import { fakeStage, lockfile, quietly, scratch } from "./stage-fixtures.mjs";


test("an install aimed at the stage is refused however it's spelled; reading what's installed, and anything elsewhere, passes", () => {
  const root = scratch("classify");
  const stage = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(stage, { recursive: true });
  const elsewhere = scratch("repo");
  const refused = [
    // From inside the stage: installs, script runners, links, and anything that isn't a read.
    ["vp", ["install", "--prod"]], // the guard runs upstream's install itself; one through PATH is a new, unrouted install
    ["vp", ["install", "--prod", "--no-frozen-lockfile"]],
    ["vp", ["--filter", "./x", "install"]],
    ["vp", ["list"]],
    ["pnpm", ["install"]],
    ["pnpm", ["--package=x", "dlx", "x"]],
    ["pnpm", ["postinstall"]], // an implicit script
    ["pnpm", ["--dir", stage, "list"]], // the command has to come first
    ["pnpm", ["store", "add", "x"]],
    ["pnpm", ["link", "../x"]],
    ["pnpm", ["-v", "install"]],
    ["npm", ["--prefix", "x", "ci"]],
    ["npm", ["ins", "--no-save", "--package-lock=false", "../replacement.tgz"]],
    ["npm", ["isntall"]], // npm's typo alias
    ["npm", ["rebuild"]],
    ["npm", ["run", "postinstall"]],
    ["npm", ["exec", "--", "whatever"]],
    ["npm", []],
    ["yarn", []], // installs
    ["yarn", ["list"]],
  ];
  for (const [tool, args] of refused) assert.equal(classify(tool, args, stage, root), "refuse", `${tool} ${args.join(" ")}`);
  // From outside: global options with values before the command, a destination option, or the environment.
  for (const [tool, args, env] of [
    ["pnpm", ["--dir", stage, "install", "--prod"]],
    ["pnpm", ["-C", stage, "add", "left-pad"]],
    ["npm", ["--prefix", stage, "install"]],
    ["npm", ["install", `--prefix=${stage}`]],
    ["npm", ["ins", `--prefix=${stage}`]],
    ["yarn", ["--cwd", path.relative(elsewhere, stage), "install"]],
    ["npm", ["i"], { npm_config_prefix: stage }],
  ]) {
    assert.equal(classify(tool, args, elsewhere, root, env), "refuse", `${tool} ${args.join(" ")}`);
  }
  // Reading what's installed, or a version, passes; so does what the packager and electron-builder really run.
  for (const [tool, args] of [
    ["pnpm", ["list", "--prod", "--json", "--depth", "Infinity"]],
    ["pnpm", ["why", "is-number"]],
    ["npm", ["ls", "--all", "--json"]],
    ["npm", ["--version"]],
    ["yarn", ["-v"]],
  ]) {
    assert.equal(classify(tool, args, stage, root), "pass", `${tool} ${args.join(" ")}`);
  }
  for (const [tool, args] of [
    ["vp", ["exec", "--filter", "@t3tools/desktop", "--", "electron-builder", "--projectDir", stage, "--mac", "--arm64"]],
    ["vp", ["run", "build:desktop"]],
    ["vp", ["install", "--prod"]],
    ["pnpm", ["install"]],
    ["npm", ["ins", "left-pad"]],
  ]) {
    assert.equal(classify(tool, args, elsewhere, root), "pass", `${tool} ${args.join(" ")}`);
  }
});

test("the staged install resolves without scripts, is checked, then installs frozen with a strict release age", async () => {
  const stage = fakeStage();
  await stage.install();
  assert.deepEqual(stage.calls(), ["install --prod --lockfile-only --ignore-scripts", "install --prod --frozen-lockfile"]);
  assert.match(fs.readFileSync(path.join(stage.app, "pnpm-workspace.yaml"), "utf8"), /minimumReleaseAge: \d+\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude:\n {2}- "is-number@7\.0\.0"/);
  assert.equal(JSON.parse(fs.readFileSync(stage.env.BLACKSAND_T3_STAGE_RECORD, "utf8")).dir, stage.app);
  // The build's check afterwards: every node_modules in the stage was checked.
  verifyStageInstalls(stage.stages, stage.env.BLACKSAND_T3_STAGE_RECORD);
  // What the config says: the minimum age in minutes, strict, and the verified versions excluded.
  const config = releaseAgeConfig(new Set(["a@1.0.0", "a@1.1.0", "@s/b@2.0.0"]), 3);
  assert.match(config, /^minimumReleaseAge: 4320$/m);
  assert.match(config, /^minimumReleaseAgeStrict: true$/m);
  assert.match(config, /^ {2}- "@s\/b@2\.0\.0"$/m);
  assert.match(config, /^ {2}- "a@1\.0\.0 \|\| 1\.1\.0"$/m);
});

test("a staged resolution that fails the check installs nothing: no script ever ran", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0", "body-parser@2.3.0"]));
  await assert.rejects(stage.install(), /security overrides didn't take/);
  assert.deepEqual(stage.calls(), ["install --prod --lockfile-only --ignore-scripts"]);
  assert.equal(fs.existsSync(path.join(stage.app, "node_modules")), false);
});

test("the staged install may not install from the stage's own folders, which no commit's tree backs", async () => {
  const resolved = lockfile(["is-number@7.0.0"]).replace("      is-number:\n", "      local:\n        specifier: file:sub\n        version: file:sub\n      is-number:\n").replace("packages:\n\n", "packages:\n\n  local@file:sub:\n    resolution: {directory: sub, type: directory}\n\n").replace("snapshots:\n\n", "snapshots:\n\n  local@file:sub: {}\n\n");
  const stage = fakeStage(resolved);
  await assert.rejects(stage.install(), /would install local@file:sub from the stage itself/);
  assert.deepEqual(stage.calls(), ["install --prod --lockfile-only --ignore-scripts"], "nothing was installed");
});

test("the guard runs only as the rule calls it, once per stage folder, inside the build's temp folder, and refuses loosened settings", async () => {
  const stage = fakeStage();
  await assert.rejects(main("guard", ["install"], { cwd: stage.app, env: stage.env }), /the guard runs `vp install --prod` only/);
  assert.equal(await quietly(() => main("guard", ["install", "--prod"], { cwd: stage.app, env: stage.env, installer: () => stage.env.BLACKSAND_T3_REAL_VP })), 0);
  await assert.rejects(stage.install(), /already installed once/);
  await assert.rejects(stage.install(scratch("outside")), /isn't in the build's private temp folder/);
  // Upstream turning off pnpm's checks in the stage's own config.
  const loose = fakeStage();
  fs.appendFileSync(path.join(loose.app, "pnpm-workspace.yaml"), "trustLockfile: true\n");
  await assert.rejects(loose.install(), /sets trustLockfile/);
});

test("the build refuses a stage installed around the guard, or changed after its check", async () => {
  const stage = fakeStage();
  const record = stage.env.BLACKSAND_T3_STAGE_RECORD;
  assert.throws(() => verifyStageInstalls(stage.stages, record), /never ran/);
  await stage.install();
  const checked = verifyStageInstalls(stage.stages, record);
  assert.equal(checked.locks.length, 1);
  assert.match(checked.locks[0], /is-number@7\.0\.0/);
  // Another stage folder has node_modules nothing checked.
  const other = path.join(stage.root, "t3code-desktop-mac-stage-y", "server", "node_modules");
  fs.mkdirSync(other, { recursive: true });
  assert.throws(() => verifyStageInstalls(stage.stages, record), /installed dependencies nothing checked/);
  fs.rmSync(path.dirname(path.dirname(other)), { recursive: true });
  // An npm started by absolute path (past the shims) adds a package.
  fs.mkdirSync(path.join(stage.app, "node_modules", "evil"), { recursive: true });
  fs.writeFileSync(path.join(stage.app, "node_modules", "evil", "package.json"), '{"name":"evil","version":"1.0.0"}');
  assert.throws(() => verifyStageInstalls(stage.stages, record), /has packages its checked lockfile doesn't: evil@1\.0\.0/);
  fs.rmSync(path.join(stage.app, "node_modules", "evil"), { recursive: true });
  verifyStageInstalls(stage.stages, record);
  // The manifest the check was for isn't the one there now.
  fs.writeFileSync(path.join(stage.app, "package.json"), '{"name":"blacksand-t3","dependencies":{"is-number":"^7.0.0","evil":"*"}}\n');
  assert.throws(() => verifyStageInstalls(stage.stages, record), /isn't the one checked/);
});

test("a stage record that doesn't list the installed files fails the build instead of passing unchecked", async () => {
  const stage = fakeStage();
  await stage.install();
  const record = stage.env.BLACKSAND_T3_STAGE_RECORD;
  const { files, ...rest } = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.ok(files);
  fs.writeFileSync(record, `${JSON.stringify(rest)}\n`);
  assert.throws(() => verifyStageInstalls(stage.stages, record), /has no record of the files it installed/);
});

/** A small package tree in a fresh folder: `files` (path below node_modules -> text). */
function tree(files) {
  const dir = scratch("tree");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, "node_modules", name)), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", name), text);
  }
  return dir;
}

test("stageChanges allows only what packaging adds: copies of installed binaries and native rebuild output", () => {
  const pty = ".pnpm/node-pty@1.0.0/node_modules/node-pty";
  const dir = tree({
    ".pnpm/a@1.0.0/node_modules/a/package.json": '{"name":"a","version":"1.0.0"}',
    ".pnpm/a@1.0.0/node_modules/a/index.js": "module.exports = 1;\n",
    ".pnpm/keyring-darwin@1.0.0/node_modules/keyring-darwin/keyring.node": "BINARY",
    ".pnpm/keyring@1.0.0/node_modules/keyring/package.json": "{}",
    [`${pty}/package.json`]: '{"name":"node-pty","version":"1.0.0"}',
    [`${pty}/binding.gyp`]: "{}",
    [`${pty}/lib/index.js`]: "require('../build/Release/pty.node');\n",
  });
  fs.symlinkSync(".pnpm/a@1.0.0/node_modules/a", path.join(dir, "node_modules", "a"));
  const before = stageContents(dir);
  assert.match(before[".pnpm/a@1.0.0/node_modules/a/index.js"], /^file 6\d\d [0-9a-f]{64}$/);
  assert.equal(before.a, "link .pnpm/a@1.0.0/node_modules/a");
  const at = (name) => path.join(dir, "node_modules", name);
  // What the packager and electron-builder do: copy a binary beside its loader, rebuild node-pty.
  fs.copyFileSync(at(".pnpm/keyring-darwin@1.0.0/node_modules/keyring-darwin/keyring.node"), at(".pnpm/keyring@1.0.0/node_modules/keyring/keyring.darwin-arm64.node"));
  fs.mkdirSync(at(`${pty}/build/Release/.deps`), { recursive: true });
  fs.writeFileSync(at(`${pty}/build/Release/pty.node`), "COMPILED", { mode: 0o755 });
  fs.mkdirSync(at(".pnpm/node-pty@1.0.0/node-addon-api@7.1.1/node_modules/node-addon-api"), { recursive: true });
  fs.writeFileSync(at(".pnpm/node-pty@1.0.0/node-addon-api@7.1.1/node_modules/node-addon-api/x.target.mk"), "");
  // node-gyp's scratch for a dependency also lands inside the package, run to run (seen in a real build).
  fs.mkdirSync(at(`${pty}/node-addon-api@7.1.1/node_modules/node-addon-api`), { recursive: true });
  fs.writeFileSync(at(`${pty}/node-addon-api@7.1.1/node_modules/node-addon-api/node_addon_api_except.stamp`), "");
  assert.deepEqual(stageChanges(before, stageContents(dir)), []);
  // Anything else is a change, wherever it is.
  const probe = (change, expected) => {
    const copy = scratch("probe");
    fs.cpSync(dir, copy, { recursive: true, verbatimSymlinks: true });
    change((name) => path.join(copy, "node_modules", name));
    assert.deepEqual(stageChanges(before, stageContents(copy)), expected);
  };
  probe((p) => fs.writeFileSync(p(".pnpm/a@1.0.0/node_modules/a/index.js"), "module.exports = 'replaced';\n"), [".pnpm/a@1.0.0/node_modules/a/index.js"]);
  probe((p) => fs.chmodSync(p(".pnpm/a@1.0.0/node_modules/a/index.js"), 0o755), [".pnpm/a@1.0.0/node_modules/a/index.js"]);
  probe((p) => fs.rmSync(p(".pnpm/a@1.0.0/node_modules/a/index.js")), [".pnpm/a@1.0.0/node_modules/a/index.js"]);
  probe((p) => fs.writeFileSync(p(".pnpm/a@1.0.0/node_modules/a/index.mjs"), "export default 2;\n"), [".pnpm/a@1.0.0/node_modules/a/index.mjs"]);
  probe((p) => {
    fs.rmSync(p("a"));
    fs.symlinkSync(".pnpm/keyring@1.0.0/node_modules/keyring", p("a"));
  }, ["a"]);
  // A binary nothing installed, even under a native package's own folder.
  probe((p) => fs.writeFileSync(p(".pnpm/a@1.0.0/node_modules/a/evil.node"), "NEW"), [".pnpm/a@1.0.0/node_modules/a/evil.node"]);
  probe((p) => fs.writeFileSync(p(`${pty}/lib/evil.node`), "NEW"), [`${pty}/lib/evil.node`]);
  // A new node_modules in the native package, where its own require() calls would look first.
  probe((p) => {
    fs.mkdirSync(p(`${pty}/node_modules/evil@1.0.0`), { recursive: true });
    fs.writeFileSync(p(`${pty}/node_modules/evil@1.0.0/index.js`), "");
  }, [`${pty}/node_modules`, `${pty}/node_modules/evil@1.0.0`, `${pty}/node_modules/evil@1.0.0/index.js`]);
  // A file beside the native package's code (index.json would answer require("./lib/index")'s fallback).
  probe((p) => fs.writeFileSync(p(`${pty}/lib/index.json`), "{}"), [`${pty}/lib/index.json`]);
  // A package dropped into the native package's store entry, where Node would resolve it from.
  probe((p) => {
    fs.mkdirSync(p(".pnpm/node-pty@1.0.0/node_modules/evil"));
    fs.writeFileSync(p(".pnpm/node-pty@1.0.0/node_modules/evil/package.json"), "{}");
  }, [".pnpm/node-pty@1.0.0/node_modules/evil", ".pnpm/node-pty@1.0.0/node_modules/evil/package.json"]);
  // A link in the rebuild output.
  probe((p) => fs.symlinkSync("/etc", p(`${pty}/build/Release/elsewhere`)), [`${pty}/build/Release/elsewhere`]);
});

test("installedPackages reads real package folders (pnpm's store, nested, scoped), skipping links and bundled dependencies", () => {
  const dir = scratch("installed");
  const pkg = (where, manifest) => {
    fs.mkdirSync(path.join(dir, where), { recursive: true });
    fs.writeFileSync(path.join(dir, where, "package.json"), JSON.stringify(manifest));
  };
  pkg("node_modules/.pnpm/a@1.0.0/node_modules/a", { name: "a", version: "1.0.0" });
  pkg("node_modules/.pnpm/@s+b@2.0.0/node_modules/@s/b", { name: "@s/b", version: "2.0.0", bundleDependencies: ["inner"] });
  pkg("node_modules/.pnpm/@s+b@2.0.0/node_modules/@s/b/node_modules/inner", { name: "inner", version: "9.9.9" });
  pkg("node_modules/c", { name: "c", version: "3.0.0" });
  pkg("node_modules/c/node_modules/d", { name: "d", version: "4.0.0" });
  fs.symlinkSync(".pnpm/a@1.0.0/node_modules/a", path.join(dir, "node_modules", "a"));
  fs.writeFileSync(path.join(dir, "node_modules/.pnpm/lock.yaml"), "");
  fs.mkdirSync(path.join(dir, "node_modules/.bin"));
  assert.deepEqual([...installedPackages(dir)].sort(), ["@s/b@2.0.0", "a@1.0.0", "c@3.0.0", "d@4.0.0"]);
  fs.mkdirSync(path.join(dir, "node_modules/stray"));
  assert.throws(() => installedPackages(dir), /stray is in node_modules without a readable package\.json/);
});

test("a staged install's digest covers its manifest, workspace config and lockfile", () => {
  const dir = scratch("digest");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const before = stageDigest(dir);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "x");
  assert.notEqual(stageDigest(dir), before);
});

/** The two staged installs in scripts/build-desktop-artifact.ts, as upstream writes them (plus `extra`). */
const packager = (extra = "") =>
  [
    'export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;',
    "function stageApp() {",
    '  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);',
    "}",
    "function stageSidecar() {",
    '  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);',
    "}",
    extra,
  ].join("\n");

test("the rule routes upstream's two staged installs through the guard, and a third install stops the build", async () => {
  const rule = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((r) => r.id === "desktop/stage-install-guarded");
  const apply = async (text) => {
    const root = scratch("rule");
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, rule.file), text);
    return { failures: await quietly(() => applyRules(root, [rule])), text: fs.readFileSync(path.join(root, rule.file), "utf8") };
  };
  const done = await apply(packager());
  assert.deepEqual(done.failures, []);
  assert.equal(done.text.match(/const installCommand = blacksandStageInstall\(\);/g).length, 2);
  assert.doesNotMatch(done.text, /resolveSpawnCommand\("vp", \[\.\.\.STAGE_INSTALL_ARGS\]\)/);
  assert.match(done.text, /process\.env\.BLACKSAND_T3_STAGE_GUARD/);
  assert.equal((await apply(packager('function more() {\n  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);\n}'))).failures.length, 1);
  assert.equal((await apply(packager("const again = [...STAGE_INSTALL_ARGS];"))).failures.length, 1);
});

test("shims stand in for vp, pnpm, npm and yarn, and refuse an unexpected install in the stage", async () => {
  const stage = fakeStage();
  const env = shimEnv({ dir: path.join(stage.root, "shims"), env: { PATH: process.env.PATH }, stageRoot: stage.root, verifiedLock: stage.env.BLACKSAND_T3_VERIFIED_LOCK, record: stage.env.BLACKSAND_T3_STAGE_RECORD });
  for (const tool of ["vp", "pnpm", "npm", "yarn"]) assert.ok(fs.statSync(path.join(stage.root, "shims", tool)).mode & 0o100, tool);
  assert.ok(env.PATH.startsWith(path.join(stage.root, "shims") + ":"));
  assert.ok(!env.BLACKSAND_T3_REAL_NPM.startsWith(path.join(stage.root, "shims")));
  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.equal(await main("pnpm", ["add", "left-pad"], { cwd: stage.app, env }), 1);
  } finally {
    console.error = error;
  }
  assert.match(errors.join("\n"), /refused `pnpm add left-pad` in the packager's stage/);
});
