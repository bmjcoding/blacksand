// node --test: every gated provider update (automatic, Update now, Update all) installs
// exactly the version its check showed at least 3 days old, or nothing (native Grok's
// pin aside, which a minimum Grok's own config requires can override), and every updater
// keeps Update to latest (lib/files/blacksandReleaseAge.ts: exactUpdateAction,
// onlyExactUpdates, latestUpdate; rules provider/updates-exact-version,
// provider/grok-native-updates, provider/update-to-latest). The module runs in a vm, with no upstream package.
// test/stripped/blacksandExactUpdates.test.ts and blacksandGrokUpdates.test.ts run the
// same code in upstream's checkout, through its update runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

import { makeRules } from "../lib/rules.mjs";
import { featureIndex } from "../lib/features.mjs";
import { hostsIn } from "../lib/strip-engine.mjs";
import { isKnownHost } from "../lib/build.mjs";

const source = fs.readFileSync(new URL("../lib/files/blacksandReleaseAge.ts", import.meta.url), "utf8");
// The first-seen record's schema and lock, which nothing here reaches.
const unused = new Proxy(function () {}, { get: () => unused, apply: () => unused });
const context = { Effect: { fn: () => (body) => body }, Schema: unused, Semaphore: unused };
vm.runInNewContext(
  `${stripTypeScriptTypes(source.replace(/^import[^;]*;\n/gm, "").replace(/^export /gm, ""))}\nthis.exports = { exactUpdateAction, onlyExactUpdates, latestUpdate, MIN_RELEASE_AGE_DAYS };`,
  context,
);
const { exactUpdateAction, onlyExactUpdates, latestUpdate, MIN_RELEASE_AGE_DAYS } = context.exports;
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
  // Grok's updater on a build its own installer downloaded (provider/grok-native-updates), and on any other install.
  grokNative: { lockKey: "grok-native", executable: "/Users/me/.grok/bin/grok", args: ["update"], command: "/Users/me/.grok/bin/grok update", env: { npm_config_allow_scripts: "@xai-official/grok" } },
  grok: { lockKey: "grok", executable: "/opt/tools/grok", args: ["update"], command: "/opt/tools/grok update", env: { npm_config_allow_scripts: "@xai-official/grok" } },
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
  assert.deepEqual(at("grokNative"), {
    ...UPDATES.grokNative,
    env: {
      npm_config_allow_scripts: "@xai-official/grok",
      GROK_INSTALLER: "internal",
      GROK_MINIMUM_VERSION: "1.4.2",
      GROK_MAXIMUM_VERSION: "1.4.2",
      GROK_DISABLE_AUTOUPDATER: "1",
    },
    command: "GROK_INSTALLER=internal GROK_MINIMUM_VERSION=1.4.2 GROK_MAXIMUM_VERSION=1.4.2 /Users/me/.grok/bin/grok update",
  });
});

test("native Grok's pinned update never takes `--version`, the branch that turns off Grok's own auto-update", () => {
  // xai-grok-update auto_update.rs, run_update: only the `--version` branch writes
  // cli.auto_update=false. Plain `grok update` with its range narrowed to one version installs that or nothing, unless Grok requires a newer minimum.
  const pinned = plain(exactUpdateAction(UPDATES.grokNative, "1.4.2"));
  assert.deepEqual(pinned.args, ["update"]);
  assert.doesNotMatch(pinned.command, /--version/);
  assert.equal(pinned.env.GROK_MINIMUM_VERSION, pinned.env.GROK_MAXIMUM_VERSION);
});

test("native Grok downloads Grok's own build of that version, with its background updater off, whatever env it was given", () => {
  for (const env of [
    { KEEP: "yes" },
    { KEEP: "yes", GROK_INSTALLER: "npm" },
    { KEEP: "yes", GROK_INSTALLER: "gh-release" },
    { KEEP: "yes", GROK_DISABLE_AUTOUPDATER: "0" },
    // A range the instance set can't widen it: these are set after its env.
    { KEEP: "yes", GROK_MINIMUM_VERSION: "0.0.1", GROK_MAXIMUM_VERSION: "99.0.0" },
  ]) {
    const given = Object.freeze({ ...env });
    const pinned = plain(exactUpdateAction({ ...UPDATES.grokNative, env: given }, "1.4.2"));
    assert.deepEqual(pinned.env, { KEEP: "yes", GROK_INSTALLER: "internal", GROK_MINIMUM_VERSION: "1.4.2", GROK_MAXIMUM_VERSION: "1.4.2", GROK_DISABLE_AUTOUPDATER: "1" });
    assert.deepEqual(pinned.args, ["update"]);
    assert.deepEqual(given, env);
  }
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
  for (const name of ["claude", "codex", "opencode", "grokNative"]) {
    for (const version of [null, "", "latest", "stable", "v1.4.2", " 1.4.2", "1.4.2\n", "1.4.2-beta.1", "1.4.2 --force", "1.4", "1.4.2;id"]) {
      assert.equal(exactUpdateAction(UPDATES[name], version), null, `${name} ${JSON.stringify(version)}`);
    }
  }
});

test("an updater that can't take a version, or one blacksand doesn't know, installs nothing", () => {
  for (const update of [
    UPDATES.homebrew,
    UPDATES.pi,
    // Muse's launcher takes no version. A Grok install of no known kind could be any installer's.
    UPDATES.muse,
    UPDATES.grok,
    { ...UPDATES.grok, args: ["update", "--version", "1.4.2"], command: `${UPDATES.grok.command} --version 1.4.2` },
    { ...UPDATES.grokNative, lockKey: "grok-native2" },
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
    { ...UPDATES.grokNative, args: ["update", "--force-reinstall"], command: `${UPDATES.grokNative.command} --force-reinstall` },
    { ...UPDATES.grokNative, args: ["update", "--alpha"], command: `${UPDATES.grokNative.command} --alpha` },
    { ...UPDATES.claude, args: ["update"], command: "/Users/me/.local/bin/claude update --force" },
    { ...UPDATES.claude, args: ["upgrade"], command: "/Users/me/.local/bin/claude upgrade" },
  ]) {
    assert.equal(exactUpdateAction(update, "1.4.2"), null, update.command);
  }
});

test("an install whose updater can't take a version gets no gated update, saying why, and keeps Update to latest", () => {
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
      `T3 Code (blacksand) doesn't run \`${update.command}\` by itself: it can't install a specific version, so it can't keep to releases at least 3 days old. Use Update to latest to run it now. To have it updated automatically, 3 days after each release, install it with npm or pnpm instead.`,
    );
    // Update to latest runs the vendor's own command, unchanged.
    assert.equal(left.latestUpdate, update);
    // Its own version check goes with it: what's reported comes from npm, 3 days old.
    assert.deepEqual(Object.keys(left).sort(), ["compareVersions", "latestUpdate", "manualCommand", "manualReason", "packageName", "provider", "update"]);
  }
  // A provider with no npm package (Muse) isn't told to install it with npm.
  const muse = onlyExactUpdates({ provider: "muse", packageName: null, update: UPDATES.muse });
  assert.equal(
    muse.manualReason,
    `T3 Code (blacksand) doesn't run \`${UPDATES.muse.command}\` by itself: it can't install a specific version, so it can't keep to releases at least 3 days old. Use Update to latest to run it now.`,
  );
  assert.equal(muse.latestUpdate, UPDATES.muse);
  assert.equal(MIN_RELEASE_AGE_DAYS, 3);
});

test("native Grok keeps its update, with no version until its driver adds the check on Grok's own channel", () => {
  const compareVersions = () => 0;
  const kept = onlyExactUpdates({
    provider: "grok",
    packageName: "@xai-official/grok",
    update: UPDATES.grokNative,
    latestVersion: "1.4.2",
    lookupLatestVersion: { npm: true },
    latestVersionCacheKey: "npm",
    compareVersions,
  });
  // Never npm's version, nor any upstream adds: latestVersion null stops the npm fallback.
  assert.deepEqual(Object.keys(kept).sort(), ["compareVersions", "latestUpdate", "latestVersion", "packageName", "provider", "update"]);
  assert.equal(kept.update, UPDATES.grokNative);
  // Update to latest is plain `grok update`, the branch that leaves Grok's auto-update setting alone.
  assert.equal(kept.latestUpdate, UPDATES.grokNative);
  assert.equal(kept.latestVersion, null);
  assert.equal(kept.compareVersions, compareVersions);
});

test("an install whose updater installs an exact version, or holds the whole install to the age, keeps it", () => {
  // npm and pnpm, and native Claude Code, whose channel is only the ceiling for npm's version.
  for (const name of ["claude", "npm", "pnpm"]) {
    const capabilities = { provider: name, packageName: null, update: UPDATES[name], lookupLatestVersion: {} };
    const kept = onlyExactUpdates(capabilities);
    assert.equal(kept.update, UPDATES[name], name);
    assert.equal(kept.lookupLatestVersion, capabilities.lookupLatestVersion, name);
    assert.deepEqual(Object.keys(kept).sort(), ["latestUpdate", "lookupLatestVersion", "packageName", "provider", "update"], name);
  }
  // Codex's and OpenCode's versions come from npm, dated: never a lookup or version of their own.
  for (const name of ["codex", "opencode"]) {
    const capabilities = { provider: name, packageName: "pkg", update: UPDATES[name], lookupLatestVersion: {}, latestVersionCacheKey: "k", latestVersion: "9.0.0" };
    const kept = onlyExactUpdates(capabilities);
    assert.deepEqual(Object.keys(kept).sort(), ["latestUpdate", "packageName", "provider", "update"], name);
    assert.equal(kept.update, UPDATES[name]);
    assert.equal(kept.latestUpdate, UPDATES[name]);
  }
  const manual = { provider: "cursor", packageName: null, update: null };
  assert.equal(onlyExactUpdates(manual), manual);
});

test("the rules are strict", () => {
  const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
  for (const id of [
    "provider/updates-exact-version",
    "provider/grok-npm-updates",
    "provider/grok-native-updates",
    "provider/muse-version-check-off",
    "provider/grok-autoupdater-off",
    "provider/opencode-autoupdate-off",
    "provider/claude-autoupdater-off",
    "provider/muse-autoupdate-off",
    "provider/update-to-latest",
    "provider/update-to-latest-input",
    "provider/update-to-latest-advisory",
    "provider/automatic-updates-file",
    "provider/automatic-updates",
    "provider/automatic-updates-idle",
    "provider/automatic-updates-last-check",
    "provider/one-update-runner",
    "provider/automatic-updates-setting",
    "web/automatic-provider-updates-setting",
    "web/automatic-provider-updates-search",
    "web/provider-update-to-latest",
    "web/provider-update-to-latest-request",
  ]) {
    assert.equal(rules.filter((rule) => rule.id === id).length, 1, id);
    assert.equal(featureIndex(rules).get(id), undefined, `${id} stays strict`);
  }
});

test("Grok's channel host is listed, saying why", () => {
  const listed = fs.readFileSync(new URL("../lib/known-hosts.txt", import.meta.url), "utf8");
  assert.equal(isKnownHost(hostsIn("https://x.ai/cli/stable")[0].host), true);
  assert.match(listed, /^x\.ai # .*first seen .*3 days .*\(rule provider\/grok-native-updates\)$/m);
  assert.equal(isKnownHost("cli.x.ai"), false);
});

test("Update to latest runs the vendor's own update: upstream's command, without the age flags for npm and pnpm", () => {
  const cutoff = "--before=2026-11-03T20:00:00Z";
  const npm = Object.freeze({
    ...UPDATES.npm,
    args: Object.freeze(["install", "-g", "--prefix", "/usr/local", "--allow-scripts=@openai/codex", cutoff, "@openai/codex@latest"]),
    command: `npm install -g --prefix /usr/local --allow-scripts=@openai/codex ${cutoff} @openai/codex@latest`,
    env: Object.freeze({ PATH: "/usr/bin" }),
  });
  assert.deepEqual(plain(latestUpdate(npm)), {
    ...plain(npm),
    args: ["install", "-g", "--prefix", "/usr/local", "--allow-scripts=@openai/codex", "@openai/codex@latest"],
    command: "npm install -g --prefix /usr/local --allow-scripts=@openai/codex @openai/codex@latest",
  });
  const pnpm = Object.freeze({
    ...UPDATES.pnpm,
    args: Object.freeze(["add", "-g", "--config.minimum-release-age=4320", "--config.minimum-release-age-strict=true", "@openai/codex@latest"]),
    command: "pnpm add -g --config.minimum-release-age=4320 --config.minimum-release-age-strict=true @openai/codex@latest",
  });
  assert.deepEqual(plain(latestUpdate(pnpm)), { ...plain(pnpm), args: ["add", "-g", "@openai/codex@latest"], command: "pnpm add -g @openai/codex@latest" });
  // The caller's action and env are left as they were.
  assert.equal(npm.args.length, 7);
  assert.deepEqual(npm.env, { PATH: "/usr/bin" });
  // Native updaters run as upstream builds them: `claude update`, `codex update`, `opencode upgrade`, `grok update`.
  for (const name of ["claude", "codex", "opencode", "grokNative", "grok", "muse", "homebrew", "pi"]) {
    assert.equal(latestUpdate(UPDATES[name]), UPDATES[name], name);
  }
  // Only an npm or pnpm install loses an age flag: elsewhere the words are the vendor's own.
  const odd = { ...UPDATES.claude, args: ["update", cutoff], command: `${UPDATES.claude.command} ${cutoff}` };
  assert.equal(latestUpdate(odd), odd);
});

test("Update to latest is the only ungated command, and only the user runs it", () => {
  const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
  const auto = rules.find((rule) => rule.id === "provider/automatic-updates-file").content;
  // The automatic path asks the runner for the gated update, never latest or a target version.
  assert.match(auto, /runner\.updateProvider\(\{ provider: driver, instanceId, beforeRun \}\)/);
  assert.doesNotMatch(auto, /latest: true|targetVersion/);
  const ui = rules.find((rule) => rule.id === "web/provider-update-to-latest-request").edits.map((edit) => edit.replace).join("");
  assert.match(ui, /\.\.\.\(latest \? \{ latest: true \} : \{\}\)/);
  const label = rules.find((rule) => rule.id === "web/provider-update-to-latest").edits.map((edit) => edit.replace).join("");
  assert.match(label, /without waiting the 3 days/);
});

test("automatic updates and every socket share the server's one update runner", () => {
  const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
  const edits = (id) => rules.find((rule) => rule.id === id).edits.map((edit) => edit.replace).join("");
  // server.ts builds it once, for the server's lifetime, beside the automatic updates.
  assert.match(edits("provider/automatic-updates"), /Layer\.provideMerge\(ProviderMaintenanceRunner\.layer\)/);
  // ws.ts hands each socket that runner instead of building one per socket.
  const ws = edits("provider/one-update-runner");
  assert.match(ws, /Layer\.succeed\(ProviderMaintenanceRunner\.ProviderMaintenanceRunner, providerMaintenanceRunner\)/);
  assert.doesNotMatch(ws, /ProviderMaintenanceRunner\.layer/);
  // The automatic updates take that runner, never one of their own.
  const auto = rules.find((rule) => rule.id === "provider/automatic-updates-file").content;
  assert.match(auto, /yield\* ProviderMaintenanceRunner\.ProviderMaintenanceRunner;/);
  assert.doesNotMatch(auto, /ProviderMaintenanceRunner\.make\(/);
});
