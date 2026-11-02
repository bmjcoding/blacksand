// node --test test/ (deep): the CLI shim (~/.blacksand/t3/bin/t3) never replaces or
// writes through to the CLI, and configure refuses an empty, relative or in-clone
// BLACKSAND_T3_HOME before writing anything. Deep because each case copies bin/ and lib/
// and starts the real CLI; the location rules themselves are checked in
// install-config.test.mjs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const REPO = fs.realpathSync(path.dirname(path.dirname(new URL(import.meta.url).pathname)));

/** A scratch clone (bin/ and lib/), a home, and every location in the scratch folder. */
function clone() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-config-")));
  const repo = path.join(dir, "repo/tooling/blacksand-t3");
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(new URL("../../../src/trust", import.meta.url), path.join(dir, "repo/src/trust"), { recursive: true });
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(REPO, part), path.join(repo, part), { recursive: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const launcher = path.join(repo, "bin", "t3");
  const original = fs.readFileSync(launcher, "utf8");
  const env = { PATH: process.env.PATH, HOME: home, BLACKSAND_T3_APPS: path.join(dir, "Apps"), BLACKSAND_T3_UPDATE_REQUESTS: path.join(dir, "Shared", "requests"), XDG_DATA_HOME: path.join(dir, "data"), XDG_CONFIG_HOME: path.join(dir, "config"), BLACKSAND_T3_HEADLESS: "1" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [launcher, ...args], { cwd: repo, encoding: "utf8", env: { ...env, ...extra }, timeout: 60_000 });
  const intact = () => fs.readFileSync(launcher, "utf8") === original;
  return { dir, repo, home, launcher, run, intact };
}

test("configure with an empty, relative or in-clone BLACKSAND_T3_HOME never overwrites the CLI", () => {
  // Empty: unset, so the shim goes to the default home and configure works.
  const empty = clone();
  const saved = empty.run(["configure", "--role", "ui"], { BLACKSAND_T3_HOME: "" });
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  assert.ok(empty.intact(), "the CLI is untouched");
  assert.match(fs.readFileSync(path.join(empty.home, ".blacksand/t3", "bin", "t3"), "utf8"), /^#!\/bin\/sh\n# Written by blacksand/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(empty.repo, "state", "install.json"), "utf8")).env.BLACKSAND_T3_HOME, null);
  assert.equal(empty.run(["configure", "--role", "ui"], { BLACKSAND_T3_HOME: "" }).status, 0, "and it still runs");
  // Relative, the clone itself, and inside it: refused before anything is written.
  for (const value of [".", "REPO", "REPO/lib"]) {
    const c = clone();
    const home = value.replace("REPO", c.repo);
    for (const args of [["configure", "--role", "ui"], ["drift"]]) {
      const refused = c.run(args, { BLACKSAND_T3_HOME: home });
      assert.equal(refused.status, 1, `${value} ${args[0]}`);
      assert.match(refused.stdout, /BLACKSAND_T3_HOME=.* (isn't an absolute path|is this clone)/, `${value} ${args[0]}`);
      assert.ok(c.intact(), `${value} ${args[0]}: the CLI is untouched`);
    }
    assert.equal(fs.existsSync(path.join(c.repo, "state", "install.json")), false, `${value}: nothing saved`);
    assert.equal(fs.existsSync(path.join(c.repo, "lib", "bin")), false, `${value}: no shim inside the clone`);
    assert.equal(c.run(["drift"]).status, 0, `${value}: the CLI still runs`);
  }
});

test("a shim path that leads to the CLI is replaced, never written through", () => {
  // The shim is a symlink to the CLI: replaced by the shim itself.
  const link = clone();
  const t3bHome = path.join(link.home, ".blacksand/t3");
  fs.mkdirSync(path.join(t3bHome, "bin"), { recursive: true });
  fs.symlinkSync(link.launcher, path.join(t3bHome, "bin", "t3"));
  assert.equal(link.run(["drift"], { BLACKSAND_T3_HOME: t3bHome }).status, 0);
  assert.ok(link.intact(), "the CLI is untouched");
  const shim = path.join(t3bHome, "bin", "t3");
  assert.equal(fs.lstatSync(shim).isSymbolicLink(), false);
  assert.match(fs.readFileSync(shim, "utf8"), /exec .*'\S*\/repo\/tooling\/blacksand-t3\/bin\/t3' "\$@"/);
  // The shim's folder is the clone's bin/ by another path: left alone.
  const folder = clone();
  const other = path.join(folder.home, ".blacksand/t3");
  fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(path.join(folder.repo, "bin"), path.join(other, "bin"));
  assert.equal(folder.run(["drift"], { BLACKSAND_T3_HOME: other }).status, 0);
  assert.ok(folder.intact(), "the CLI is untouched");
});
