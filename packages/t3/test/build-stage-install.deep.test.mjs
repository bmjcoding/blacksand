// node --test test/ (deep): a package replaced under its own name and version, by the
// real npm installing a local tarball. Deep because it runs npm; the shims and the
// build's byte-for-byte check are in build-stage-install.test.mjs.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyStageInstalls } from "../lib/build.mjs";
import { findOnPath, main } from "../lib/stage-install.mjs";
import { fakeStage, quietly } from "./stage-fixtures.mjs";

test("a package replaced under its own name and version through npm: refused by the shim, and failing the build when run past it", async (t) => {
  const npm = findOnPath("npm", process.env.PATH, "/nonexistent");
  if (!npm) return t.skip("no npm on PATH");
  const stage = fakeStage();
  await stage.install();
  verifyStageInstalls(stage.stages, stage.env.T3BLACKOUT_STAGE_RECORD);
  // is-number@7.0.0 again, same name and version, other bytes and an install script.
  const pkg = path.join(stage.root, "fixture", "package");
  fs.mkdirSync(pkg, { recursive: true });
  const marker = path.join(stage.root, "script-ran");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "is-number", version: "7.0.0", scripts: { install: "node install.cjs" } }));
  fs.writeFileSync(path.join(pkg, "install.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = () => 'unreviewed replacement';\n");
  const tarball = path.join(stage.root, "replacement.tgz");
  assert.equal(spawnSync("tar", ["-czf", tarball, "-C", path.dirname(pkg), "package"]).status, 0);
  const args = ["ins", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "--offline", "--cache", path.join(stage.root, "npm-cache"), tarball];
  // Through the shim (the PATH the packager has): refused before npm runs.
  assert.equal(await quietly(() => main("npm", args, { cwd: stage.app, env: stage.env })), 1);
  assert.equal(fs.existsSync(marker), false);
  verifyStageInstalls(stage.stages, stage.env.T3BLACKOUT_STAGE_RECORD);
  // By absolute path, past the shims: npm replaces the package's files under the same name and version.
  const real = spawnSync(npm, [...args.slice(0, -1), "--ignore-scripts", tarball], { cwd: stage.app, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" } });
  assert.equal(real.status, 0, real.stderr);
  assert.match(fs.readFileSync(path.join(stage.app, "node_modules", "is-number", "index.js"), "utf8"), /unreviewed replacement/);
  assert.throws(() => verifyStageInstalls(stage.stages, stage.env.T3BLACKOUT_STAGE_RECORD), /isn't what was installed from its checked lockfile: node_modules\/.*is-number/);
});
