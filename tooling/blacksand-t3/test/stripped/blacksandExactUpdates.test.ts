// Copied to apps/server/src/provider/ in a stripped upstream checkout and run there
// (rules provider/updates-exact-version, provider/updates-minimum-age,
// provider/claude-native-updates-minimum-age, server/provider-update-manual-reason):
// what Update all runs for each installer, through upstream's update runner, and which
// installs it leaves to the user.
// Install fixtures are real files, and npm's publish times real dates:
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics multipleEffectProvide:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider, type ServerProviderUpdateState } from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  createProviderVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  resolveLatestProviderUpdateAction,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { onlyExactUpdates } from "@t3tools/provider-core/server/blacksandReleaseAge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { makeClaudeMaintenanceResolution } from "./Drivers/ClaudeMaintenance.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** npm's document: 1.0.9 is the latest tag, a day old; 1.0.8 is 4 days old. */
const npmDocument = (ages: Record<string, number> = { "1.0.7": 9, "1.0.8": 4, "1.0.9": 1 }) => ({
  "dist-tags": { latest: "1.0.9" },
  versions: Object.fromEntries(Object.keys(ages).map((version) => [version, { name: "pkg", version }])),
  time: Object.fromEntries(Object.entries(ages).map(([version, days]) => [version, ago(days)])),
});

const capabilities = (
  provider: string,
  packageName: string | null,
  updateExecutable: string,
  updateArgs: ReadonlyArray<string>,
  updateLockKey: string,
  extra: { readonly env?: NodeJS.ProcessEnv; readonly latestVersion?: string | null; readonly lookupLatestVersion?: Effect.Effect<string | null> } = {},
) => makeProviderMaintenanceCapabilities({ provider: ProviderDriverKind.make(provider), packageName, updateExecutable, updateArgs, updateLockKey, platform: "linux", ...extra });

type Spawned = { readonly command: string; readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv | undefined };

/**
 * Update all for one provider, through upstream's runner: what it asked npm, what it
 * spawned, its states and its exit. A null `document` is a registry that fails.
 */
const run = (maintenance: ProviderMaintenanceCapabilities, document: unknown = npmDocument()) => {
  const spawned: Array<Spawned> = [];
  const states: Array<ServerProviderUpdateState> = [];
  const asked: Array<string> = [];
  const instanceId = ProviderInstanceId.make(String(maintenance.provider));
  const provider: ServerProvider = {
    instanceId,
    driver: maintenance.provider,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const providers = Effect.succeed([provider]);
  const registry: ProviderRegistry.ProviderRegistry["Service"] = {
    getProviders: providers,
    refresh: () => providers,
    refreshInstance: () => providers,
    reloadSecretsAndRefresh: () => providers,
    refreshAfterUpdate: () => Effect.succeed([{ ...provider, version: "1.0.8" }]),
    refreshWorkspaceSnapshot: () => providers,
    invalidateModelCaches: () => Effect.void,
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(maintenance),
    setProviderMaintenanceActionState: (input) => Effect.sync(() => (input.state && states.push(input.state), [provider])),
    streamChanges: Stream.empty,
  };
  // No known-broken ranges, as upstream's runner tests have it: only the age decides here.
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [{ driver: maintenance.provider, t3CodeRange: ">=0.0.42", ranges: [] }],
  };
  const spawner = ChildProcessSpawner.make((command) => {
    const child = command as unknown as Spawned & { readonly options: { readonly env?: NodeJS.ProcessEnv } };
    spawned.push({ command: child.command, args: child.args, env: child.options.env });
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const client = HttpClient.make((request) =>
    Effect.sync(() => (
      asked.push(request.url),
      HttpClientResponse.fromWeb(request, document === null ? new Response("unavailable", { status: 503 }) : Response.json(document))
    )),
  );
  return Effect.gen(function* () {
    const runner = yield* Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner);
    const exit = yield* Effect.exit(runner.updateProvider({ provider: maintenance.provider, instanceId }));
    return { spawned, states, asked, exit, last: states.at(-1) };
  }).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
            }),
            ProviderLatestVersions.layer,
          ),
        ),
      ),
    ),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
};

describe("blacksand: Update all installs exactly a version 3 days old, with every installer (native Grok's minimum aside)", () => {
  const codex = capabilities("codex", "@openai/codex", "/home/me/.codex/packages/standalone/current/bin/codex", ["update"], "codex-native", {
    env: { CODEX_HOME: "/home/me/.codex" },
  });

  it.effect("Codex's standalone updater installs CODEX_RELEASE, the newest npm release 3 days old", () =>
    Effect.gen(function* () {
      const { spawned, asked, last } = yield* run(codex);
      assert.deepStrictEqual([...new Set(asked)], ["https://registry.npmjs.org/%40openai%2Fcodex"]);
      assert.strictEqual(spawned.length, 1);
      assert.strictEqual(spawned[0]!.command, "/home/me/.codex/packages/standalone/current/bin/codex");
      assert.deepStrictEqual(spawned[0]!.args, ["update"]);
      assert.strictEqual(spawned[0]!.env?.CODEX_RELEASE, "1.0.8");
      assert.strictEqual(spawned[0]!.env?.CODEX_HOME, "/home/me/.codex");
      assert.strictEqual(last?.status, "succeeded");
    }),
  );

  it.effect("Codex and OpenCode take npm's dated version, never one a lookup of their own names", () =>
    Effect.gen(function* () {
      // A lookup upstream might add, naming 1.0.9, a day old on npm.
      const own = { latestVersion: "1.0.9", lookupLatestVersion: Effect.succeed("1.0.9") };
      for (const maintenance of [
        capabilities("codex", "@openai/codex", "/home/me/.codex/packages/standalone/current/bin/codex", ["update"], "codex-native", { env: { CODEX_HOME: "/home/me/.codex" }, ...own }),
        capabilities("opencode", "opencode-ai", "/home/me/.opencode/bin/opencode", ["upgrade"], "opencode-native", own),
      ]) {
        const filtered = onlyExactUpdates(maintenance);
        const { spawned } = yield* run(filtered);
        const pinned = spawned.map((call) => call.env?.CODEX_RELEASE ?? call.args.at(-1));
        assert.deepStrictEqual(pinned, ["1.0.8"], maintenance.update?.lockKey);
        // npm failing: nothing, not the lookup's version.
        assert.deepStrictEqual((yield* run(filtered, null)).spawned, [], maintenance.update?.lockKey);
      }
    }),
  );

  it.effect("OpenCode and native Claude Code each install exactly that version", () =>
    Effect.gen(function* () {
      for (const [maintenance, args] of [
        [capabilities("opencode", "opencode-ai", "/home/me/.opencode/bin/opencode", ["upgrade"], "opencode-native"), ["upgrade", "1.0.8"]],
        [capabilities("claudeAgent", "@anthropic-ai/claude-code", "/home/me/.local/bin/claude", ["update"], "claudeAgent-native"), ["install", "1.0.8"]],
      ] as const) {
        const { spawned } = yield* run(maintenance);
        assert.deepStrictEqual(spawned.map((call) => call.args), [args], maintenance.update?.lockKey);
        // OpenCode's own updater stays off while it upgrades (provider/opencode-autoupdate-off).
        if (maintenance.update?.lockKey === "opencode-native") assert.strictEqual(spawned[0]!.env?.OPENCODE_DISABLE_AUTOUPDATE, "1");
      }
    }),
  );

  it.effect("runs nothing while no release is 3 days old, and says so", () =>
    Effect.gen(function* () {
      const { spawned, last } = yield* run(codex, npmDocument({ "1.0.8": 2, "1.0.9": 1 }));
      assert.deepStrictEqual(spawned, []);
      assert.strictEqual(last?.status, "failed");
      assert.strictEqual(last?.message, "T3 Code (blacksand) found no release at least 3 days old to install. Try again later.");
    }),
  );

  it.effect("runs nothing for an updater that can't take a version, even when its own channel names one", () =>
    Effect.gen(function* () {
      for (const maintenance of [
        capabilities("codex", "@openai/codex", "/opt/homebrew/bin/brew", ["upgrade", "--cask", "codex"], "homebrew", {
          latestVersion: null,
          lookupLatestVersion: Effect.succeed("1.0.9"),
        }),
        capabilities("pi", "@earendil-works/pi-coding-agent", "/home/me/.pi/bin/pi", ["update", "--self"], "pi-native"),
      ]) {
        const { spawned, last } = yield* run(maintenance);
        assert.deepStrictEqual(spawned, [], maintenance.update?.lockKey);
        assert.strictEqual(last?.status, "failed");
      }
    }),
  );

  // Muse's launcher takes no version: it installs whatever its channel names when it
  // runs. A Grok install of no known kind (lock key `grok`) could be any of Grok's
  // installers; native Grok is grok-native (blacksandGrokUpdates.test.ts). Both are left
  // to the user, and even handed a settled version, the runner spawns neither.
  const muse = (latestVersion: string | null) =>
    capabilities("muse", null, "/home/me/.local/bin/muse", ["--version"], "muse:/home/me/.local/bin/muse", {
      env: { MUSE_NO_AUTO_UPDATE: "0", MUSE_SYNC_UPDATE: "1", MUSE_UPDATE_INTERVAL_SECONDS: "0" },
      latestVersion,
    });
  const grok = capabilities("grok", "@xai-official/grok", "/home/me/.grok/bin/grok", ["update"], "grok", {
    env: { npm_config_allow_scripts: "@xai-official/grok" },
  });

  it.effect("never runs Muse's launcher, or Grok's updater on an install of no known kind, even with a settled version", () =>
    Effect.gen(function* () {
      for (const maintenance of [muse(null), muse("1.2.0-R4"), grok]) {
        const { spawned, last } = yield* run(maintenance);
        assert.deepStrictEqual(spawned, [], maintenance.update?.lockKey);
        assert.strictEqual(last?.status, "failed", maintenance.update?.lockKey);
      }
      // Asked directly, the resolver has no command for either.
      assert.strictEqual(resolveLatestProviderUpdateAction(muse("1.2.0-R4"), "1.2.0-R4"), null);
      assert.strictEqual(resolveLatestProviderUpdateAction(grok, "1.0.8"), null);
    }),
  );

  it.effect("leaves Muse and a Grok install of no known kind to the user, showing the command and why", () =>
    Effect.gen(function* () {
      for (const maintenance of [muse("1.2.0-R4"), grok]) {
        const left = yield* resolveProviderMaintenanceCapabilitiesEffect({ resolve: () => Effect.succeed(maintenance) }).pipe(
          Effect.provide(NodeServices.layer),
        );
        const command = maintenance.update!.command;
        assert.strictEqual(left.update, null);
        assert.strictEqual(left.manualCommand, command);
        // Grok is on npm, so it's told how to have it updated automatically; Muse isn't.
        assert.strictEqual(
          left.manualReason,
          `T3 Code (blacksand) doesn't run \`${command}\` by itself: it can't install a specific version, so it can't keep to releases at least 3 days old. Use Update to latest to run it now.` +
            (maintenance.packageName ? " To have it updated automatically, 3 days after each release, install it with npm or pnpm instead." : ""),
        );
        const { spawned, exit } = yield* run(left);
        assert.deepStrictEqual(spawned, []);
        assert.ok(Exit.isFailure(exit));
        assert.include(String(exit.cause), `doesn't run \`${command}\``);
      }
    }),
  );

  it.effect("refuses a gated update for an install with none, with its reason, running nothing", () =>
    Effect.gen(function* () {
      const pi = capabilities("pi", "@earendil-works/pi-coding-agent", "/home/me/.pi/bin/pi", ["update", "--self"], "pi-native");
      const left = yield* resolveProviderMaintenanceCapabilitiesEffect({ resolve: () => Effect.succeed(pi) }).pipe(
        Effect.provide(NodeServices.layer),
      );
      const { spawned, exit } = yield* run(left);
      assert.deepStrictEqual(spawned, []);
      assert.ok(Exit.isFailure(exit));
      assert.include(String(exit.cause), "doesn't run `/home/me/.pi/bin/pi update --self` by itself: it can't install a specific version");
    }),
  );
});

it.layer(NodeServices.layer)("blacksand: installs with no gated update", (it) => {
  /** A file at `relative` under a fresh real directory, and that directory. */
  const install = (relative: string, content = "") =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3b-exact-" }));
      const file = NodePath.join(root, relative);
      yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, content);
      yield* fs.chmod(file, 0o755);
      return { root, file };
    });

  /** npm's and pnpm's capabilities for Codex, as upstream's resolver finds them in real install layouts. */
  const packageManagers = Effect.gen(function* () {
    const empty = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "t3b-exact-path-" });
    // No pnpm on PATH: the version comes from npm's registry, as with npm.
    const env = { PATH: empty };
    const definition = { provider: ProviderDriverKind.make("codex"), npmPackageName: "@openai/codex", nativeUpdate: null };
    const resolve = (file: string) =>
      resolveProviderMaintenanceCapabilitiesEffect(
        { resolve: (context) => resolvePackageManagedProviderMaintenance(definition, context) },
        { binaryPath: file, env },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, silent));
    const npm = yield* install("lib/node_modules/@openai/codex/bin/codex.js");
    const npmLink = NodePath.join(npm.root, "bin", "codex");
    NodeFS.mkdirSync(NodePath.dirname(npmLink), { recursive: true });
    NodeFS.symlinkSync(npm.file, npmLink);
    const pnpm = yield* install("pnpm/global/5/node_modules/@openai/codex/bin/codex.js");
    return { npm: yield* resolve(npmLink), pnpm: yield* resolve(pnpm.file) };
  });
  /** Answers every probe (`pnpm --version`) with nothing. */
  const silent = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

  it.effect("npm and pnpm install exactly the newest version 3 days old, with their own age flags too", () =>
    Effect.gen(function* () {
      const { npm, pnpm } = yield* packageManagers;
      assert.match(npm.update?.lockKey ?? "", /^npm-global:/);
      assert.strictEqual(pnpm.update?.lockKey, "pnpm-global");
      const npmRun = yield* run(npm);
      assert.strictEqual(npmRun.spawned.length, 1);
      assert.strictEqual(npmRun.spawned[0]!.command, "npm");
      assert.include(npmRun.spawned[0]!.args, "@openai/codex@1.0.8");
      assert.ok(npmRun.spawned[0]!.args.some((arg) => /^--before=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(arg)));
      const pnpmRun = yield* run(pnpm);
      assert.strictEqual(pnpmRun.spawned.length, 1);
      assert.strictEqual(pnpmRun.spawned[0]!.command, "pnpm");
      assert.includeMembers([...pnpmRun.spawned[0]!.args], [
        "@openai/codex@1.0.8",
        "--config.minimum-release-age=4320",
        "--config.minimum-release-age-strict=true",
      ]);
      for (const { spawned } of [npmRun, pnpmRun]) {
        assert.notInclude(spawned[0]!.args, "@openai/codex@latest");
        assert.notInclude(spawned[0]!.args, "@openai/codex");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("npm and pnpm run nothing when the registry fails, no release is 3 days old, or the version can't be put in", () =>
    Effect.gen(function* () {
      const { npm, pnpm } = yield* packageManagers;
      for (const maintenance of [npm, pnpm]) {
        const update = maintenance.update!;
        const failed = yield* run(maintenance, null);
        const young = yield* run(maintenance, npmDocument({ "1.0.8": 2, "1.0.9": 1 }));
        for (const { spawned, last } of [failed, young]) {
          assert.deepStrictEqual(spawned, [], update.lockKey);
          assert.strictEqual(last?.message, "T3 Code (blacksand) found no release at least 3 days old to install. Try again later.");
        }
        // An updater whose package argument isn't `<package>@latest` or `<package>`: no exact install, so nothing.
        const other = {
          ...maintenance,
          update: {
            ...update,
            args: update.args.map((arg) => (arg === "@openai/codex@latest" ? "@openai/codex@next" : arg)),
            command: update.command.replace("@openai/codex@latest", "@openai/codex@next"),
          },
        };
        const unpinned = yield* run(other);
        assert.deepStrictEqual(unpinned.spawned, [], update.lockKey);
        assert.strictEqual(
          unpinned.last?.message,
          `T3 Code (blacksand) can't make \`${other.update.command}\` install exactly 1.0.8, so it ran nothing. Use Update to latest to run it now.`,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("keeps upstream's native Claude Code updater, which installs an exact version", () =>
    Effect.gen(function* () {
      const { file } = yield* install(".local/bin/claude");
      const resolve = yield* makeClaudeMaintenanceResolution({ binaryPath: file, env: { PATH: "/usr/bin:/bin" } }).pipe(
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("no channel lookup here"))),
      );
      const claude = yield* resolve();
      assert.strictEqual(claude.update?.lockKey, "claudeAgent-native");
      assert.deepStrictEqual(resolveLatestProviderUpdateAction(claude, "1.0.8")?.args, ["install", "1.0.8"]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves Pi's own updater and Homebrew to the user, showing the command and why", () =>
    Effect.gen(function* () {
      const pi = yield* install("bin/pi");
      const piDefinition = {
        provider: ProviderDriverKind.make("pi"),
        npmPackageName: "@earendil-works/pi-coding-agent",
        nativeUpdate: { args: ["update", "--self"] },
      };
      const piLeft = yield* resolveProviderMaintenanceCapabilitiesEffect(
        { resolve: (context) => resolvePackageManagedProviderMaintenance(piDefinition, context) },
        { binaryPath: pi.file, env: { PATH: "/usr/bin:/bin" } },
      );
      assert.strictEqual(piLeft.update, null);
      assert.strictEqual(piLeft.manualCommand, `${pi.file} update --self`);

      // A cask keg whose brew vouches for its prefix (upstream's resolveHomebrewProviderMaintenance).
      const keg = yield* install("Caskroom/codex/1.0.0/codex");
      const brew = NodePath.join(keg.root, "bin", "brew");
      NodeFS.mkdirSync(NodePath.dirname(brew), { recursive: true });
      NodeFS.writeFileSync(brew, `#!/bin/sh\n[ "$1" = --prefix ] && echo '${keg.root}'\n`, { mode: 0o755 });
      const codexDefinition = {
        provider: ProviderDriverKind.make("codex"),
        npmPackageName: "@openai/codex",
        nativeUpdate: { args: ["update"], isCommandPath: () => false, requiresCommandPath: true },
      };
      const brewLeft = yield* resolveProviderMaintenanceCapabilitiesEffect(
        { resolve: (context) => resolvePackageManagedProviderMaintenance(codexDefinition, context) },
        { binaryPath: keg.file, env: { PATH: "/usr/bin:/bin" } },
      );
      assert.strictEqual(brewLeft.update, null);
      assert.strictEqual(brewLeft.manualCommand, "brew upgrade --cask codex");
      // Brew's own version check goes with it: the version reported is npm's, 3 days old.
      assert.strictEqual(brewLeft.lookupLatestVersion, undefined);
      const advisory = createProviderVersionAdvisory({
        driver: ProviderDriverKind.make("codex"),
        currentVersion: "1.0.0",
        latestVersion: "1.0.8",
        maintenanceCapabilities: brewLeft,
      });
      assert.deepStrictEqual(
        { canUpdate: advisory.canUpdate, canUpdateToLatest: advisory.canUpdateToLatest, updateCommand: advisory.updateCommand, message: advisory.message },
        {
          canUpdate: false,
          // Update to latest runs `brew upgrade` when the user asks.
          canUpdateToLatest: true,
          updateCommand: "brew upgrade --cask codex",
          message:
            "Version 1.0.8 is out. T3 Code (blacksand) doesn't run `brew upgrade --cask codex` by itself: it can't install a specific version, so it can't keep to releases at least 3 days old. Use Update to latest to run it now. To have it updated automatically, 3 days after each release, install it with npm or pnpm instead.",
        },
      );
    }).pipe(Effect.scoped),
  );

  // Codex's, Grok's and Pi's updaters aren't exported: their definitions are read here,
  // so a change to one is seen (exactUpdateAction refuses arguments it doesn't know).
  it("upstream's updaters are still the ones blacksand pins or leaves to the user", () => {
    const read = (file: string) => NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");
    assert.include(read("Drivers/CodexDriver.ts"), 'nativeUpdate: {\n      args: ["update"],\n      isCommandPath: (commandPath) => codexStandaloneHome(commandPath) !== null,');
    assert.include(read("Drivers/ClaudeMaintenance.ts"), 'nativeUpdate: {\n    args: ["update"],');
    const opencode = read("../../../../packages/provider-opencode/src/server/driver.ts");
    assert.include(opencode, 'nativeUpdate: {\n      args: ["upgrade"],\n      isCommandPath: isOpenCodeNativeCommandPath,');
    assert.include(
      read("../../../../packages/provider-grok/src/server/driver.ts"),
      'updateArgs: ["update"],\n      updateLockKey: isGrokDownload(context.realCommandPath) ? "grok-native" : "grok",',
    );
    assert.include(read("../../../../packages/provider-pi/src/server/driver.ts"), 'nativeUpdate: { args: ["update", "--self"] },');
    assert.include(read("../../../../packages/provider-muse/src/server/maintenance.ts"), 'updateLockKey: `muse:${context.realCommandPath}`,');
  });
});
