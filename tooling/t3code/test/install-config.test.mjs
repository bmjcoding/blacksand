// node --test test/: the install's saved role and locations (state/install.json,
// lib/install-config.mjs, lib/load-install-config.mjs) fail closed: absent is "no
// config", anything unreadable or invalid is an error; it's written whole; the
// host roles can't move what agent accounts rely on; empty locations are unset,
// relative or in-the-clone BLACKSAND_T3_HOME is refused. What the real CLI does with
// them (configure, and its shim) is in install-config.deep.test.mjs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { HOST_LOCATIONS, applyInstallConfig, hostLocationProblem, locationsOf, readInstallConfig, saveInstallConfig, useLocations } from "../lib/install-config.mjs";

// ---------------------------------------------------------- the saved config --

const configFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-config-")), "state", "install.json");

test("a missing config is none; a truncated or malformed one is an error, never the defaults", () => {
  const file = configFile();
  assert.equal(readInstallConfig(file), null);
  saveInstallConfig({ role: "ui", env: { BLACKSAND_T3_HOME: "/Volumes/t3b" }, file });
  const whole = fs.readFileSync(file, "utf8");
  for (const [label, text] of [
    ["truncated", whole.slice(0, 20)],
    ["empty", ""],
    ["not an object", "[]"],
    ["unknown role", JSON.stringify({ role: "server", env: {} })],
    ["no env", JSON.stringify({ role: "ui" })],
    ["unknown setting", JSON.stringify({ role: "ui", env: { PATH: "/bin" } })],
    ["relative path", JSON.stringify({ role: "ui", env: { BLACKSAND_T3_HOME: "t3b" } })],
    ["not a string", JSON.stringify({ role: "ui", env: { BLACKSAND_T3_HOME: 7 } })],
    ["host role, moved apps", JSON.stringify({ role: "host", env: { BLACKSAND_T3_APPS: "/Volumes/Apps" } })],
  ]) {
    fs.writeFileSync(file, text);
    assert.throws(() => readInstallConfig(file), /install\.json (is invalid|isn't valid JSON)/, label);
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readInstallConfig(file), /can't read .*install\.json/, "a folder");
});

test("saving replaces the file whole, owner-only, and repairs an invalid one only given a role", () => {
  const file = configFile();
  saveInstallConfig({ role: "both", env: {}, file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["install.json"], "no temporary left behind");
  fs.writeFileSync(file, "{\"role\":");
  assert.throws(() => saveInstallConfig({ env: {}, file }), /give the role/);
  assert.equal(saveInstallConfig({ role: "ui", env: {}, file }).role, "ui");
  assert.equal(readInstallConfig(file).role, "ui");
  // Empty is unset; relative paths are refused.
  assert.equal(saveInstallConfig({ role: "ui", env: { BLACKSAND_T3_APPS: "" }, file }).env.BLACKSAND_T3_APPS, null);
  assert.throws(() => saveInstallConfig({ role: "ui", env: { BLACKSAND_T3_HOME: "./t3b" }, file }), /isn't an absolute path/);
});

test("the host roles can't move the apps or request folders agent accounts use", () => {
  const file = configFile();
  for (const role of ["host", "both"]) {
    assert.throws(() => saveInstallConfig({ role, env: { BLACKSAND_T3_APPS: "/Volumes/Apps" }, file }), /can't use BLACKSAND_T3_APPS/);
    assert.throws(() => saveInstallConfig({ role, env: { BLACKSAND_T3_UPDATE_REQUESTS: "/tmp/requests" }, file }), /can't use BLACKSAND_T3_UPDATE_REQUESTS/);
    // Their own values, spelled out, are fine; so are locations only you use.
    assert.equal(saveInstallConfig({ role, env: { BLACKSAND_T3_APPS: "/Applications/", BLACKSAND_T3_UPDATE_REQUESTS: HOST_LOCATIONS.BLACKSAND_T3_UPDATE_REQUESTS, BLACKSAND_T3_HOME: "/Volumes/t3b" }, file }).role, role);
  }
  assert.equal(hostLocationProblem("ui", { BLACKSAND_T3_APPS: "/Volumes/Apps" }), null);
  assert.equal(saveInstallConfig({ role: "ui", env: { BLACKSAND_T3_APPS: "/Volumes/Apps" }, file }).env.BLACKSAND_T3_APPS, "/Volumes/Apps");
});

// ------------------------------------------------ locations and the CLI shim --

const REPO = fs.realpathSync(path.dirname(path.dirname(new URL(import.meta.url).pathname)));

test("empty locations are unset; relative ones and a BLACKSAND_T3_HOME in this clone are refused", () => {
  const locations = locationsOf({ BLACKSAND_T3_HOME: "", BLACKSAND_T3_APPS: "/Volumes/Apps/", XDG_DATA_HOME: "/data/../store" });
  assert.equal(locations.BLACKSAND_T3_HOME, null);
  assert.equal(locations.BLACKSAND_T3_APPS, "/Volumes/Apps");
  assert.equal(locations.XDG_DATA_HOME, "/store");
  assert.throws(() => locationsOf({ BLACKSAND_T3_HOME: "." }), /BLACKSAND_T3_HOME=\. isn't an absolute path/);
  assert.throws(() => locationsOf({ XDG_CONFIG_HOME: "config" }), /isn't an absolute path/);
  for (const inside of [REPO, `${REPO}/`, path.join(REPO, "state"), path.join(REPO, "bin", "..")]) {
    assert.throws(() => locationsOf({ BLACKSAND_T3_HOME: inside }), /is this clone .* or inside it/, inside);
  }
  // Through a symlink, and in another letter case where the disk ignores case.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-config-")));
  fs.symlinkSync(REPO, path.join(dir, "link"));
  assert.throws(() => locationsOf({ BLACKSAND_T3_HOME: path.join(dir, "link", "home") }), /or inside it/);
  const upper = REPO.toUpperCase();
  if (upper !== REPO && fs.existsSync(upper)) assert.throws(() => locationsOf({ BLACKSAND_T3_HOME: upper }), /or inside it/);
  // Beside the clone is fine.
  assert.equal(locationsOf({ BLACKSAND_T3_HOME: path.join(path.dirname(REPO), "t3b-home") }).BLACKSAND_T3_HOME, path.join(path.dirname(REPO), "t3b-home"));
  // Applied to the environment: empties are gone even when another location is refused.
  const env = { BLACKSAND_T3_HOME: "", BLACKSAND_T3_APPS: "/Volumes/Apps/" };
  useLocations(env);
  assert.deepEqual(env, { BLACKSAND_T3_APPS: "/Volumes/Apps" });
  const refused = { BLACKSAND_T3_HOME: "", XDG_DATA_HOME: "data" };
  assert.throws(() => useLocations(refused));
  assert.deepEqual(refused, { XDG_DATA_HOME: "data" });
});

test("a saved BLACKSAND_T3_HOME in the clone is an invalid config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-config-"));
  const file = path.join(dir, "install.json");
  fs.writeFileSync(file, JSON.stringify({ role: "ui", env: { BLACKSAND_T3_HOME: REPO } }));
  assert.throws(() => readInstallConfig(file), /install\.json is invalid \(BLACKSAND_T3_HOME=.* is this clone/);
});

test("an install's locations apply to every later run, whatever its environment", () => {
  const file = configFile();
  saveInstallConfig({ role: "ui", env: { BLACKSAND_T3_APPS: "/Volumes/Apps", XDG_DATA_HOME: undefined }, file });
  const config = readInstallConfig(file);
  assert.equal(config.role, "ui");
  // A scheduled run: nothing set. A manual one from another shell: set differently.
  const scheduled = {};
  assert.deepEqual(applyInstallConfig(config, scheduled), []);
  assert.equal(scheduled.BLACKSAND_T3_APPS, "/Volumes/Apps");
  const manual = { BLACKSAND_T3_APPS: "/Applications", XDG_DATA_HOME: "/elsewhere", PATH: "/bin" };
  assert.deepEqual(applyInstallConfig(config, manual).sort(), ["BLACKSAND_T3_APPS", "XDG_DATA_HOME"]);
  assert.deepEqual(manual, { BLACKSAND_T3_APPS: "/Volumes/Apps", PATH: "/bin" });
  // The role stays unless a new one is given; bad roles are refused.
  saveInstallConfig({ role: "host", env: {}, file });
  assert.equal(saveInstallConfig({ env: {}, file }).role, "host");
  assert.throws(() => saveInstallConfig({ role: "server", env: {}, file }), /unknown role/);
  assert.deepEqual(applyInstallConfig(null, manual), []);
});
