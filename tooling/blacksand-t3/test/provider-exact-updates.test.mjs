// node --test: every one-click provider update installs exactly the version its check
// showed at least 3 days old, or is left to the user (lib/files/blacksandReleaseAge.ts:
// exactUpdateAction, onlyExactUpdates; rule provider/updates-exact-version). The module
// runs in a vm, with no upstream package. test/stripped/blacksandExactUpdates.test.ts
// runs the same code in upstream's checkout, through its update runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

import { makeRules } from "../lib/rules.mjs";
import { featureIndex } from "../lib/features.mjs";

const source = fs.readFileSync(new URL("../lib/files/blacksandReleaseAge.ts", import.meta.url), "utf8");
const context = { Effect: { fn: () => (body) => body } };
vm.runInNewContext(
  `${stripTypeScriptTypes(source.replace(/^import[^;]*;\n/gm, "").replace(/^export /gm, ""))}\nthis.exports = { exactUpdateAction, onlyExactUpdates, MIN_RELEASE_AGE_DAYS };`,
  context,
);
const { exactUpdateAction, onlyExactUpdates, MIN_RELEASE_AGE_DAYS } = context.exports;
// Plain objects, so deepEqual doesn't trip over the vm's own Array and Object.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Upstream's update commands as maintenanceResolver.ts, the drivers and Muse's launcher build them.
const UPDATES = {
  claude: { lockKey: "claudeAgent-native", executable: "/Users/me/.local/bin/claude", args: ["update"], command: "/Users/me/.local/bin/claude update" },
  codex: {
    lockKey: "codex-native",
    executable: "/Users/me/.codex/packages/standalone/current/bin/codex",
    args: ["update"],
    command: "/Users/me/.codex/packages/standalone/current/bin/codex update",
    env: { CODEX_HOME: "/Users/me/.codex" },
  },
  opencode: { lockKey: "opencode-native", executable: "/Users/me/.opencode/bin/opencode", args: ["upgrade"], command: "/Users/me/.opencode/bin/opencode upgrade" },
  grok: { lockKey: "grok", executable: "/Users/me/.grok/bin/grok", args: ["update"], command: "/Users/me/.grok/bin/grok update", env: { npm_config_allow_scripts: "@xai-official/grok" } },
  muse: {
    lockKey: "muse:/Users/me/.local/bin/muse",
    executable: "/Users/me/.local/bin/muse",
    args: ["--version"],
    command: "MUSE_NO_AUTO_UPDATE=0 MUSE_SYNC_UPDATE=1 MUSE_UPDATE_INTERVAL_SECONDS=0 /Users/me/.local/bin/muse --version",
  },
  homebrew: { lockKey: "homebrew", executable: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"], command: "brew upgrade --cask codex" },
  pi: { lockKey: "pi-native", executable: "/Users/me/.pi/bin/pi", args: ["update", "--self"], command: "/Users/me/.pi/bin/pi update --self" },
  npm: { lockKey: "npm-global:/usr/local", executable: "npm", args: ["install", "-g", "@openai/codex@latest"], command: "npm install -g @openai/codex@latest" },
  pnpm: { lockKey: "pnpm-global", executable: "pnpm", args: ["add", "-g", "@openai/codex@latest"], command: "pnpm add -g @openai/codex@latest" },
};

test("each native updater installs exactly the version offered", () => {
  const at = (name) => plain(exactUpdateAction(UPDATES[name], "1.4.2"));
  assert.deepEqual(at("claude"), { ...UPDATES.claude, args: ["install", "1.4.2"], command: "/Users/me/.local/bin/claude install 1.4.2" });
  assert.deepEqual(at("codex"), {
    ...UPDATES.codex,
    env: { CODEX_HOME: "/Users/me/.codex", CODEX_RELEASE: "1.4.2" },
    command: "CODEX_RELEASE=1.4.2 /Users/me/.codex/packages/standalone/current/bin/codex update",
  });
  assert.deepEqual(at("opencode"), {
    ...UPDATES.opencode,
    args: ["upgrade", "1.4.2"],
    env: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
    command: "/Users/me/.opencode/bin/opencode upgrade 1.4.2",
  });
});

test("OpenCode upgrades with its background updater off, whatever env it was given", () => {
  for (const env of [{ KEEP: "yes" }, { KEEP: "yes", OPENCODE_DISABLE_AUTOUPDATE: "0" }]) {
    const given = Object.freeze({ ...env });
    const pinned = plain(exactUpdateAction({ ...UPDATES.opencode, env: given }, "1.4.2"));
    assert.deepEqual(pinned.env, { KEEP: "yes", OPENCODE_DISABLE_AUTOUPDATE: "1" });
    assert.deepEqual(given, env);
  }
});

test("no version, or not a plain x.y.z one, installs nothing", () => {
  for (const name of ["claude", "codex", "opencode"]) {
    for (const version of [null, "", "latest", "stable", "v1.4.2", " 1.4.2", "1.4.2\n", "1.4.2-beta.1", "1.4.2 --force", "1.4", "1.4.2;id"]) {
      assert.equal(exactUpdateAction(UPDATES[name], version), null, `${name} ${JSON.stringify(version)}`);
    }
  }
});

test("an updater that can't take a version, or one blacksand doesn't know, installs nothing", () => {
  for (const update of [
    UPDATES.homebrew,
    UPDATES.pi,
    // Muse's launcher takes no version; native Grok's `--version` installs a build nothing ties to npm's publish times.
    UPDATES.muse,
    UPDATES.grok,
    { ...UPDATES.grok, args: ["update", "--version", "1.4.2"], command: `${UPDATES.grok.command} --version 1.4.2` },
    { ...UPDATES.claude, lockKey: "nativeCli-native" },
    { ...UPDATES.claude, lockKey: "claudeAgent-native2" },
    { ...UPDATES.claude, lockKey: "constructor" },
    { ...UPDATES.claude, lockKey: "__proto__" },
  ]) {
    for (const version of ["1.4.2", "1.2.0-R4"]) assert.equal(exactUpdateAction(update, version), null, `${update.lockKey} ${version}`);
  }
});

test("an updater whose arguments upstream changed installs nothing", () => {
  for (const update of [
    { ...UPDATES.codex, args: ["update", "--yes"], command: `${UPDATES.codex.command} --yes` },
    { ...UPDATES.opencode, args: ["upgrade", "--method", "curl"], command: `${UPDATES.opencode.command} --method curl` },
    { ...UPDATES.claude, args: ["update"], command: "/Users/me/.local/bin/claude update --force" },
    { ...UPDATES.claude, args: ["upgrade"], command: "/Users/me/.local/bin/claude upgrade" },
  ]) {
    assert.equal(exactUpdateAction(update, "1.4.2"), null, update.command);
  }
});

test("an install whose updater can't take a version is left to the user, saying why", () => {
  for (const update of [UPDATES.homebrew, UPDATES.pi, UPDATES.muse, UPDATES.grok, { ...UPDATES.claude, lockKey: "nativeCli-native" }]) {
    const compareVersions = () => 0;
    const left = onlyExactUpdates({
      provider: "codex",
      packageName: "@openai/codex",
      update,
      latestVersion: null,
      lookupLatestVersion: { brewInfo: true },
      latestVersionCacheKey: "brew",
      compareVersions,
    });
    assert.equal(left.update, null);
    assert.equal(left.compareVersions, compareVersions);
    assert.equal(left.manualCommand, update.command);
    assert.equal(
      left.manualReason,
      `T3 Code (blacksand) doesn't run \`${update.command}\`: it can't install a specific version, so it can't keep to releases at least 3 days old. Run it yourself when you choose to update.`,
    );
    // Its own version check goes with it: what's reported comes from npm, 3 days old.
    assert.deepEqual(Object.keys(left).sort(), ["compareVersions", "manualCommand", "manualReason", "packageName", "provider", "update"]);
  }
  assert.equal(MIN_RELEASE_AGE_DAYS, 3);
});

test("an install whose updater installs an exact version, or holds the whole install to the age, keeps it", () => {
  for (const name of ["claude", "codex", "opencode", "npm", "pnpm"]) {
    const capabilities = { provider: name, packageName: null, update: UPDATES[name], lookupLatestVersion: {} };
    assert.equal(onlyExactUpdates(capabilities), capabilities, name);
  }
  const manual = { provider: "cursor", packageName: null, update: null };
  assert.equal(onlyExactUpdates(manual), manual);
});

test("the rules are strict", () => {
  const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
  for (const id of [
    "provider/updates-exact-version",
    "provider/muse-version-check-off",
    "provider/grok-autoupdater-off",
    "provider/opencode-autoupdate-off",
    "provider/claude-autoupdater-off",
    "provider/muse-autoupdate-off",
  ]) {
    assert.equal(rules.filter((rule) => rule.id === id).length, 1, id);
    assert.equal(featureIndex(rules).get(id), undefined, `${id} stays strict`);
  }
});
