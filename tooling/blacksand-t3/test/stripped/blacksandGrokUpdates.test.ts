// Copied to apps/server/src/provider/ in a stripped upstream checkout and run there
// (rules provider/grok-native-updates, provider/grok-npm-updates,
// provider/updates-exact-version, provider/release-age-file): what Update all runs for each
// kind of Grok install, through upstream's Grok driver and update runner. A build Grok's own
// installer downloaded gets its range pinned to the version first seen on Grok's channel 3 days
// ago (a minimum Grok's own config requires still wins, so it never updates by itself); an
// npm or pnpm global install goes through npm or pnpm; any other gets Update to latest only.
// Install fixtures are real files, and npm's publish times real dates:
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics multipleEffectProvide:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider, type ServerProviderUpdateState } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { GrokDriver } from "@t3tools/provider-grok/server";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const DAY = 86_400_000;
const CHANNEL = "https://x.ai/cli/stable";
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** npm's document for @xai-official/grok: 1.0.9 is the latest tag, a day old; 1.0.8 is 4 days old. */
const NPM = {
  "dist-tags": { latest: "1.0.9" },
  versions: { "1.0.8": { name: "@xai-official/grok", version: "1.0.8" }, "1.0.9": { name: "@xai-official/grok", version: "1.0.9" } },
  time: { "1.0.8": ago(4), "1.0.9": ago(1) },
};

type Spawned = { readonly command: string; readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv | undefined };

const handle = () =>
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
  });
/** Answers every probe (`pnpm --version`) with nothing. */
const silent = ChildProcessSpawner.make(() => Effect.succeed(handle()));

/** What Grok's channel answers, and every request it got. */
const channel = { answer: (): Response => new Response("1.0.9\n"), asked: [] as Array<string> };
const channelClient = HttpClient.make((request) =>
  Effect.sync(() => (channel.asked.push(request.url), HttpClientResponse.fromWeb(request, channel.answer()))),
);

const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers)),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, channelClient)),
);

/**
 * Update all for one Grok install, through upstream's runner: what it asked npm, what it
 * spawned, its states. The capabilities come from the real Grok driver.
 */
const run = (maintenance: ProviderMaintenanceCapabilities) => {
  const spawned: Array<Spawned> = [];
  const states: Array<ServerProviderUpdateState> = [];
  const asked: Array<string> = [];
  const instanceId = ProviderInstanceId.make("grok");
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
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [{ driver: maintenance.provider, t3CodeRange: ">=0.0.42", ranges: [] }],
  };
  const spawner = ChildProcessSpawner.make((command) => {
    const child = command as unknown as Spawned & { readonly options: { readonly env?: NodeJS.ProcessEnv } };
    spawned.push({ command: child.command, args: child.args, env: child.options.env });
    return Effect.succeed(handle());
  });
  const npm = HttpClient.make((request) =>
    Effect.sync(() => (asked.push(request.url), HttpClientResponse.fromWeb(request, Response.json(NPM)))),
  );
  return Effect.gen(function* () {
    const runner = yield* Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner);
    yield* Effect.exit(runner.updateProvider({ provider: maintenance.provider, instanceId }));
    return { spawned, asked, last: states.at(-1) };
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
        Layer.succeed(HttpClient.HttpClient, npm),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
};

it.layer(layer)("blacksand: Update all for each kind of Grok install", (it) => {
  /** A Grok install whose executable is `relative`, linked from `link` when given, and the real Grok driver's capabilities for it. */
  const grokAt = (relative: string, link?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3b-grok-" }));
      const file = NodePath.join(root, relative);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
      const binaryPath = link ? NodePath.join(root, link) : file;
      if (link) {
        NodeFS.mkdirSync(NodePath.dirname(binaryPath), { recursive: true });
        NodeFS.symlinkSync(file, binaryPath);
      }
      // No pnpm or npm on PATH: every version comes from the registry or Grok's channel.
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-grok-path-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok"),
        displayName: "Grok",
        enabled: false,
        environment: [{ name: "PATH", value: empty, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, silent));
      const host = yield* ProviderHost.ProviderHost;
      return {
        binaryPath,
        maintenance: yield* instance.snapshot.resolveMaintenance({ fresh: true }),
        record: NodePath.join(host.paths.stateDir, "blacksand-first-seen.json"),
      };
    });
  const native = grokAt(".grok/downloads/grok-1.0.0-macos-aarch64", ".grok/bin/grok");
  const firstSeen = (record: string, seen: Record<string, number>) => NodeFS.writeFileSync(record, JSON.stringify({ [CHANNEL]: seen }));
  /** A fresh channel, no first-seen record, and the clock at now, which it returns. */
  const reset = Effect.gen(function* () {
    channel.answer = () => new Response("1.0.9\n");
    channel.asked.length = 0;
    NodeFS.rmSync(NodePath.join((yield* ProviderHost.ProviderHost).paths.stateDir, "blacksand-first-seen.json"), { force: true });
    const now = Date.now();
    yield* TestClock.setTime(now);
    return now;
  });

  it.effect("a build Grok's installer downloaded is pinned to the version first seen on Grok's channel 3 days ago", () =>
    Effect.gen(function* () {
      const now = yield* reset;
      const { binaryPath, maintenance, record } = yield* native;
      assert.strictEqual(maintenance.update?.lockKey, "grok-native");
      firstSeen(record, { "1.0.8": now - 4 * DAY });
      const given = JSON.stringify(maintenance.update?.env);
      const { spawned, asked, last } = yield* run(maintenance);
      assert.strictEqual(spawned.length, 1);
      assert.strictEqual(spawned[0]!.command, binaryPath);
      // Plain `grok update` with Grok's own range narrowed to 1.0.8: that build, or nothing,
      // unless Grok requires a newer minimum. Never `--version`, which also writes cli.auto_update=false to Grok's config.
      assert.deepStrictEqual(spawned[0]!.args, ["update"]);
      assert.strictEqual(spawned[0]!.env?.GROK_MINIMUM_VERSION, "1.0.8");
      assert.strictEqual(spawned[0]!.env?.GROK_MAXIMUM_VERSION, "1.0.8");
      // Grok's own build of that version; npm 12 still lets Grok's npm postinstall run.
      assert.strictEqual(spawned[0]!.env?.GROK_INSTALLER, "internal");
      // Grok's own updater stays off while it installs (provider/grok-autoupdater-off).
      assert.strictEqual(spawned[0]!.env?.GROK_DISABLE_AUTOUPDATER, "1");
      assert.strictEqual(spawned[0]!.env?.npm_config_allow_scripts, "@xai-official/grok");
      assert.strictEqual(last?.status, "succeeded");
      // Grok's channel, never npm's dates, and the caller's environment untouched.
      assert.deepStrictEqual(asked, []);
      assert.deepStrictEqual([...new Set(channel.asked)], [CHANNEL]);
      assert.strictEqual(JSON.stringify(maintenance.update?.env), given);
      assert.strictEqual(maintenance.update?.env?.GROK_INSTALLER, undefined);
      // The channel's newest, 1.0.9, is recorded and waits its turn.
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(record, "utf8")), { [CHANNEL]: { "1.0.8": now - 4 * DAY, "1.0.9": now } });
    }).pipe(Effect.scoped),
  );

  it.effect("runs nothing while the version was first seen under 3 days ago, then pins that one", () =>
    Effect.gen(function* () {
      yield* reset;
      const { maintenance } = yield* native;
      for (const wait of [0, 3 * DAY - 1]) {
        yield* TestClock.adjust(wait);
        const { spawned, last } = yield* run(maintenance);
        assert.deepStrictEqual(spawned, []);
        assert.strictEqual(last?.message, "T3 Code (blacksand) found no release at least 3 days old to install. Try again later.");
      }
      yield* TestClock.adjust(1);
      const { spawned } = yield* run(maintenance);
      assert.deepStrictEqual(spawned.map((call) => [call.args, call.env?.GROK_MINIMUM_VERSION, call.env?.GROK_MAXIMUM_VERSION]), [[["update"], "1.0.9", "1.0.9"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("runs nothing when Grok's channel can't be read, or names no plain version", () =>
    Effect.gen(function* () {
      const now = yield* reset;
      const { maintenance, record } = yield* native;
      firstSeen(record, { "1.0.8": now - 4 * DAY });
      for (const answer of [() => new Response("1.0.9", { status: 503 }), () => new Response("latest"), () => new Response("")]) {
        channel.answer = answer;
        const { spawned, asked, last } = yield* run(maintenance);
        assert.deepStrictEqual(spawned, []);
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(last?.message, "T3 Code (blacksand) found no release at least 3 days old to install. Try again later.");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("without the driver's check on Grok's channel, a native install has no version, never npm's", () =>
    Effect.gen(function* () {
      yield* reset;
      const { maintenance } = yield* native;
      const { lookupLatestVersion: _lookup, latestVersionCacheKey: _key, latestVersion: _version, ...upstream } = maintenance;
      const resolved = yield* resolveProviderMaintenanceCapabilitiesEffect({ resolve: () => Effect.succeed(upstream) });
      assert.strictEqual(resolved.update?.lockKey, "grok-native");
      assert.strictEqual(resolved.latestVersion, null);
      const { spawned, asked } = yield* run(resolved);
      assert.deepStrictEqual(spawned, []);
      assert.deepStrictEqual(asked, []);
    }).pipe(Effect.scoped),
  );

  it.effect("npm and pnpm global installs update through npm and pnpm, exactly the newest release 3 days old", () =>
    Effect.gen(function* () {
      yield* reset;
      const npm = yield* grokAt("lib/node_modules/@xai-official/grok/bin/grok", "bin/grok");
      const pnpm = yield* grokAt("pnpm/global/5/node_modules/@xai-official/grok/bin/grok");
      assert.match(npm.maintenance.update?.lockKey ?? "", /^npm-global:/);
      assert.strictEqual(pnpm.maintenance.update?.lockKey, "pnpm-global");
      const npmRun = yield* run(npm.maintenance);
      assert.deepStrictEqual(npmRun.spawned.map((call) => call.command), ["npm"]);
      assert.include(npmRun.spawned[0]!.args, "@xai-official/grok@1.0.8");
      assert.include(npmRun.spawned[0]!.args, "--allow-scripts=@xai-official/grok");
      assert.ok(npmRun.spawned[0]!.args.some((arg) => /^--before=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(arg)));
      const pnpmRun = yield* run(pnpm.maintenance);
      assert.deepStrictEqual(pnpmRun.spawned.map((call) => call.command), ["pnpm"]);
      assert.includeMembers([...pnpmRun.spawned[0]!.args], ["@xai-official/grok@1.0.8", "--config.minimum-release-age=4320", "--config.minimum-release-age-strict=true"]);
      assert.deepStrictEqual(channel.asked, []);
    }).pipe(Effect.scoped),
  );

  it.effect("any other Grok install gets no gated update, showing `grok update` and why", () =>
    Effect.gen(function* () {
      yield* reset;
      for (const relative of ["tools/grok", ".grok/downloads/grok-latest", "Downloads/grok-1.0.0-macos-aarch64"]) {
        const { binaryPath, maintenance } = yield* grokAt(relative);
        assert.strictEqual(maintenance.update, null, relative);
        assert.strictEqual(maintenance.manualCommand, `${binaryPath} update`);
        assert.strictEqual(
          maintenance.manualReason,
          `T3 Code (blacksand) doesn't run \`${binaryPath} update\` by itself: it can't install a specific version, so it can't keep to releases at least 3 days old. Use Update to latest to run it now. To have it updated automatically, 3 days after each release, install it with npm or pnpm instead.`,
        );
        const { spawned } = yield* run(maintenance);
        assert.deepStrictEqual(spawned, [], relative);
      }
      assert.deepStrictEqual(channel.asked, []);
    }).pipe(Effect.scoped),
  );
});
