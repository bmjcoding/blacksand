// Copied to apps/server/src/provider/ in a stripped upstream checkout and run there
// (rules provider/automatic-updates-file, provider/automatic-updates-idle,
// provider/automatic-updates-last-check, provider/automatic-updates-setting,
// provider/update-to-latest, provider/updates-exact-version):
// T3 updates a provider by itself to exactly the version its check shows 3 days old, only
// while the session manager says the driver is idle, and not when switched off; Update to
// latest runs the vendor's own update to its newest release, for every updater. Both go
// through upstream's update runner, one per server, with a spawner that records what it
// would run. Codex's install and daemon layouts are real files in a temporary directory.
// npm's publish times are real dates, and Grok's config a real file:
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics multipleEffectProvide:off
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateError,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { makeProviderMaintenanceCapabilities, type ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { onlyExactUpdates } from "@t3tools/provider-core/server/blacksandReleaseAge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as BlacksandProviderAutoUpdates from "./blacksandProviderAutoUpdates.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** npm's document: 1.0.9 is the latest tag, a day old; 1.0.8 is 4 days old. */
const npmDocument = {
  "dist-tags": { latest: "1.0.9" },
  versions: Object.fromEntries(["1.0.7", "1.0.8", "1.0.9"].map((version) => [version, { name: "pkg", version }])),
  time: { "1.0.7": ago(9), "1.0.8": ago(4), "1.0.9": ago(1) },
};

const capabilities = (
  provider: string,
  packageName: string | null,
  updateExecutable: string,
  updateArgs: ReadonlyArray<string>,
  updateLockKey: string,
  env?: NodeJS.ProcessEnv,
) =>
  // What every driver's capabilities pass through (provider/updates-exact-version).
  onlyExactUpdates(
    makeProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make(provider),
      packageName,
      updateExecutable,
      updateArgs,
      updateLockKey,
      platform: "linux",
      ...(env ? { env } : {}),
    }),
  );

type Spawned = { readonly command: string; readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv | undefined };

/** A provider snapshot as upstream's version check leaves it: the check's version, and whether a gated update exists. */
const snapshot = (maintenance: ProviderMaintenanceCapabilities, status: "behind_latest" | "current" = "behind_latest"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(String(maintenance.provider)),
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
  versionAdvisory: {
    status,
    currentVersion: "1.0.0",
    latestVersion: "1.0.8",
    updateCommand: null,
    canUpdate: maintenance.update !== null,
    checkedAt: null,
    message: null,
  },
});

/** What the harness's registry, npm and spawner do; tests change them as they go. */
type World = {
  /** npm's document for every package. */
  document: typeof npmDocument;
  /** Instances, and whether each is enabled, as the registry's snapshots show them. */
  enabled: Map<string, boolean>;
  /** Each spawned command waits for its own gate when set. */
  blockSpawns: boolean;
  exitCode: number;
  /** Runs on each fresh (pre-execution) capability resolution. */
  onFresh: () => void;
  /** The compatibility manifest the runner checks the version it resolves against. */
  manifest: ModelManifest.ModelManifestData;
  /** What the registry streams once an update state changes; nothing unless a test streams it. */
  publish: (instanceId: ProviderInstanceId, state: ServerProviderUpdateState | null) => Effect.Effect<void>;
};

/**
 * Upstream's runner over one provider, recording what it would spawn and the states it
 * publishes. `changes` is what the registry streams; `done` resolves with the runner's
 * last state, once an update finishes. `services` carries the server's one runner.
 */
const harness = (
  maintenance: ProviderMaintenanceCapabilities,
  changes: Stream.Stream<ReadonlyArray<ServerProvider>> = Stream.empty,
  installed = "1.0.0",
) =>
  Effect.gen(function* () {
    const spawned: Array<Spawned> = [];
    const states: Array<ServerProviderUpdateState> = [];
    const asked: Array<string> = [];
    const gates: Array<Deferred.Deferred<void>> = [];
    const running = { now: 0, most: 0 };
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [{ driver: maintenance.provider, t3CodeRange: ">=0.0.42", ranges: [] }],
    };
    const world: World = { document: npmDocument, enabled: new Map(), blockSpawns: false, exitCode: 0, onFresh: () => {}, manifest, publish: () => Effect.void };
    const done = yield* Deferred.make<ServerProviderUpdateState>();
    const provider = snapshot(maintenance);
    const listed = () =>
      [provider, ...[...world.enabled.keys()].filter((id) => id !== provider.instanceId).map((id) => ({ ...provider, instanceId: ProviderInstanceId.make(id) }))].map(
        (entry) => ({ ...entry, enabled: world.enabled.get(entry.instanceId) ?? true }),
      );
    const providers = Effect.sync(listed);
    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: providers,
      refresh: () => providers,
      // A fresh check of what's installed: upstream's "already up to date" compares it with the settled version.
      refreshInstance: (instanceId) =>
        Effect.sync(() => listed().filter((entry) => entry.instanceId === instanceId).map((entry) => ({ ...entry, version: installed, checkedAt: "2026-11-01T00:05:00.000Z" }))),
      reloadSecretsAndRefresh: () => providers,
      refreshAfterUpdate: () => Effect.succeed([{ ...provider, version: "1.0.8", versionAdvisory: { ...provider.versionAdvisory!, status: "current" } }]),
      refreshWorkspaceSnapshot: () => providers,
      invalidateModelCaches: () => Effect.void,
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, _driver, options) =>
        Effect.sync(() => (options?.fresh ? world.onFresh() : undefined, maintenance)),
      setProviderMaintenanceActionState: (input) =>
        Effect.gen(function* () {
          if (input.state) {
            states.push(input.state);
            if (!["queued", "running"].includes(input.state.status)) yield* Deferred.succeed(done, input.state);
          }
          yield* world.publish(input.instanceId, input.state);
          return listed();
        }),
      streamChanges: changes,
    };
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
      const child = command as unknown as Spawned & { readonly options: { readonly env?: NodeJS.ProcessEnv } };
      spawned.push({ command: child.command, args: child.args, env: child.options.env });
      running.now += 1;
      running.most = Math.max(running.most, running.now);
      const gate = yield* Deferred.make<void>();
      gates.push(gate);
      if (!world.blockSpawns) yield* Deferred.succeed(gate, undefined);
      const exitCode = ChildProcessSpawner.ExitCode(world.exitCode);
      return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Deferred.await(gate).pipe(
            Effect.andThen(Effect.sync(() => (running.now -= 1))),
            Effect.as(exitCode),
          ),
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
      }),
    );
    const client = HttpClient.make((request) =>
      Effect.sync(() => (asked.push(request.url), HttpClientResponse.fromWeb(request, Response.json(world.document)))),
    );
    const services = Layer.mergeAll(
      Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
      Layer.succeed(ModelManifest.ModelManifest, {
        current: Effect.sync(() => world.manifest),
        refresh: Effect.sync(() => world.manifest),
        forceRefresh: Effect.sync(() => world.manifest),
        refreshInBackground: Effect.void,
      }),
      ProviderLatestVersions.layer,
      Layer.succeed(HostProcess.Platform, "linux"),
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    // The server's one runner, as server.ts provides it to the automatic updates and every socket.
    return { spawned, states, asked, done, provider, gates, running, world, services: Layer.provideMerge(ProviderMaintenanceRunner.layer, services) };
  });

/** Update to latest, as Settings asks for it. */
const updateToLatest = (maintenance: ProviderMaintenanceCapabilities, installed?: string) =>
  Effect.gen(function* () {
    const h = yield* harness(maintenance, Stream.empty, installed);
    const exit = yield* Effect.gen(function* () {
      const runner = yield* ProviderMaintenanceRunner.make();
      return yield* Effect.exit(runner.updateProvider({ provider: maintenance.provider, instanceId: h.provider.instanceId, latest: true }));
    }).pipe(Effect.provide(h.services));
    return { ...h, exit, last: h.states.at(-1) };
  });

/** Update now, as Settings asks for it: the gated update, pinned to the settled version. */
const updateNow = (maintenance: ProviderMaintenanceCapabilities) =>
  Effect.gen(function* () {
    const h = yield* harness(maintenance);
    yield* Effect.gen(function* () {
      const runner = yield* ProviderMaintenanceRunner.make();
      return yield* Effect.exit(runner.updateProvider({ provider: maintenance.provider, instanceId: h.provider.instanceId }));
    }).pipe(Effect.provide(h.services));
    return { ...h, last: h.states.at(-1) };
  });

/** Lets every fiber that can run, run. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 500; turn++) yield* Effect.yieldNow;
});

/** Runs fibers until `done` holds; fails if it never does. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 20_000 && !done(); turn++) yield* Effect.yieldNow;
    assert.ok(done(), "never happened");
  });

/** npm's document with `settled` the newest version at least 3 days old. */
const settledAt = (settled: "1.0.7" | "1.0.8"): typeof npmDocument => ({
  ...npmDocument,
  time: { "1.0.7": ago(9), "1.0.8": ago(settled === "1.0.8" ? 4 : 1), "1.0.9": ago(1) },
});

/**
 * The automatic updates, running, with snapshots offered one at a time (`offer`), the settings
 * and the registry's world changeable as it goes, and the server's one runner at hand for the
 * updates Settings asks for. The session manager's reservation finds every driver idle. As the
 * registry does, each update state the runner records is streamed too, with the instance's last
 * snapshot (`published`).
 */
const live = (
  maintenance: ProviderMaintenanceCapabilities,
  body: (t: Effect.Success<ReturnType<typeof harness>> & {
    readonly settings: { enableAutomaticProviderUpdates: boolean; enableProviderUpdateChecks: boolean };
    readonly runner: ProviderMaintenanceRunner.ProviderMaintenanceRunnerShape;
    readonly offer: (version: string, instanceId?: string, checkedAt?: string) => Effect.Effect<void>;
    readonly published: Array<ServerProvider>;
  }) => Effect.Effect<void, ServerProviderUpdateError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const h = yield* harness(maintenance, Stream.fromQueue(queue));
    const current = { enableAutomaticProviderUpdates: true, enableProviderUpdateChecks: true };
    const sessions = { whenDriverIdle: (_driver: string, effect: Effect.Effect<unknown>) => Effect.asVoid(effect) } as unknown as ProviderSessionManagerV2["Service"];
    const settings = { getSettings: Effect.succeed(current) } as unknown as ServerSettingsService["Service"];
    const shown = new Map<string, ServerProvider>();
    const published: Array<ServerProvider> = [];
    h.world.publish = (instanceId, state) => {
      const last = shown.get(instanceId);
      if (last === undefined) return Effect.void;
      const { updateState: _, ...rest } = last;
      const next = { ...rest, enabled: h.world.enabled.get(instanceId) ?? true, ...(state ? { updateState: state } : {}) };
      published.push(next);
      return Queue.offer(queue, [next]).pipe(Effect.asVoid);
    };
    const offer = (version: string, instanceId = String(h.provider.instanceId), checkedAt = h.provider.checkedAt) => {
      const next = { ...h.provider, instanceId: ProviderInstanceId.make(instanceId), checkedAt, versionAdvisory: { ...h.provider.versionAdvisory!, latestVersion: version } };
      shown.set(instanceId, next);
      return Queue.offer(queue, [next]).pipe(Effect.asVoid);
    };
    yield* Effect.gen(function* () {
      yield* Layer.build(BlacksandProviderAutoUpdates.layer);
      const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      yield* body({ ...h, settings: current, runner, offer, published });
    }).pipe(
      Effect.provide(Layer.mergeAll(h.services, Layer.succeed(ProviderSessionManagerV2, sessions), Layer.succeed(ServerSettingsService, settings))),
      Effect.scoped,
    );
  });

/**
 * The automatic updates over `snapshots`, as the registry streams them. `busy` answers each
 * "is a session of the driver opening, open or closing?" in turn; `settings` is what the server's settings say. Resolves once
 * every snapshot has been looked at and, when `runs`, the update it started has finished;
 * otherwise after giving any update it wrongly started time to show.
 */
const automatic = (
  maintenance: ProviderMaintenanceCapabilities,
  options: {
    readonly snapshots?: number;
    readonly busy?: ReadonlyArray<boolean>;
    readonly settings?: { readonly enableAutomaticProviderUpdates: boolean; readonly enableProviderUpdateChecks: boolean };
    readonly withoutIdleCheck?: true;
    readonly runs?: boolean;
    /** Snapshots of the same version, from later health checks, that arrive only once the first update has finished. */
    readonly later?: number;
    readonly status?: "behind_latest" | "current";
  } = {},
) =>
  Effect.gen(function* () {
    const looked = yield* Deferred.make<void>();
    const busy = [...(options.busy ?? [false])];
    const asks: Array<string> = [];
    const gate = yield* Deferred.make<void>();
    const first = snapshot(maintenance, options.status);
    const late = Stream.fromEffect(Deferred.await(gate)).pipe(
      Stream.flatMap(() =>
        Stream.fromIterable(Array.from({ length: options.later ?? 0 }, (_, index) => [{ ...first, checkedAt: `2026-11-01T0${index + 1}:00:00.000Z` }])),
      ),
    );
    // Snapshots come minutes apart: each one's update has started, or been passed over, before the next.
    const changes = Stream.fromIterable(Array.from({ length: options.snapshots ?? 1 }, () => [first])).pipe(
      Stream.mapEffect((providers) => settle.pipe(Effect.as(providers))),
      Stream.concat(options.later ? late : Stream.empty),
      Stream.ensuring(Deferred.succeed(looked, undefined)),
    );
    let statesWhenDone = -1;
    const h = yield* harness(maintenance, changes);
    const sessions = {
      ...(options.withoutIdleCheck
        ? {}
        : {
            whenDriverIdle: (driver: string, effect: Effect.Effect<unknown>) =>
              Effect.suspend(() => {
                asks.push(driver);
                const isBusy = busy.length > 1 ? busy.shift()! : busy[0]!;
                return isBusy ? Effect.void : Effect.asVoid(effect);
              }),
          }),
    } as unknown as ProviderSessionManagerV2["Service"];
    const settings = {
      getSettings: Effect.succeed(options.settings ?? { enableAutomaticProviderUpdates: true, enableProviderUpdateChecks: true }),
    } as unknown as ServerSettingsService["Service"];
    yield* Effect.gen(function* () {
      yield* Layer.build(BlacksandProviderAutoUpdates.layer);
      if (options.later) {
        // The first update has finished, and its request is no longer in flight, before the later snapshots arrive.
        yield* Deferred.await(h.done);
        yield* settle;
        statesWhenDone = h.states.length;
        yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(looked);
        yield* settle;
        return;
      }
      yield* Deferred.await(looked);
      // The update runs in a fiber of its own: wait for its last state, or give it time to start.
      if (options.runs ?? true) yield* Deferred.await(h.done);
      else yield* settle;
    }).pipe(
      Effect.provide(Layer.mergeAll(h.services, Layer.succeed(ProviderSessionManagerV2, sessions), Layer.succeed(ServerSettingsService, settings))),
      Effect.scoped,
    );
    return { ...h, asks, last: h.states.at(-1), statesWhenDone };
  });

const codex = capabilities("codex", "@openai/codex", "/home/me/.codex/packages/standalone/current/bin/codex", ["update"], "codex-native", {
  CODEX_HOME: "/home/me/.codex",
});

describe("blacksand: T3 updates each provider by itself, 3 days after a release, while it's idle", () => {
  it.effect("runs exactly the settled version, through the same gated update as Update now", () =>
    Effect.gen(function* () {
      const { spawned, asks, last } = yield* automatic(codex);
      assert.deepStrictEqual(asks, ["codex"]);
      assert.strictEqual(spawned.length, 1);
      assert.deepStrictEqual(spawned[0]!.args, ["update"]);
      // npm's newest release 3 days old, never its latest tag (1.0.9, a day old).
      assert.strictEqual(spawned[0]!.env?.CODEX_RELEASE, "1.0.8");
      assert.strictEqual(last?.status, "succeeded");
    }),
  );

  it.effect("waits while a session of that provider is open, then runs once it's idle", () =>
    Effect.gen(function* () {
      const busy = yield* automatic(codex, { busy: [true], runs: false });
      assert.deepStrictEqual(busy.asks, ["codex"]);
      assert.deepStrictEqual(busy.spawned, []);
      // The next snapshot, once the session has closed.
      const later = yield* automatic(codex, { snapshots: 2, busy: [true, false] });
      assert.deepStrictEqual(later.asks, ["codex", "codex"]);
      assert.deepStrictEqual(later.spawned.map((call) => call.env?.CODEX_RELEASE), ["1.0.8"]);
    }),
  );

  it.effect("reads a session manager with no idle check as busy", () =>
    Effect.gen(function* () {
      const { spawned, states } = yield* automatic(codex, { withoutIdleCheck: true, runs: false });
      assert.deepStrictEqual(spawned, []);
      assert.deepStrictEqual(states, []);
    }),
  );

  it.effect("runs nothing when switched off, or when the version checks it acts on are off", () =>
    Effect.gen(function* () {
      for (const settings of [
        { enableAutomaticProviderUpdates: false, enableProviderUpdateChecks: true },
        { enableAutomaticProviderUpdates: true, enableProviderUpdateChecks: false },
      ]) {
        const { spawned, states, asks } = yield* automatic(codex, { settings, runs: false });
        assert.deepStrictEqual(spawned, [], JSON.stringify(settings));
        assert.deepStrictEqual(states, []);
        assert.deepStrictEqual(asks, []);
      }
    }),
  );

  it.effect("runs nothing when the check shows the installed version is current", () =>
    Effect.gen(function* () {
      const { spawned, states, asks } = yield* automatic(codex, { status: "current", runs: false });
      assert.deepStrictEqual(spawned, []);
      assert.deepStrictEqual(states, []);
      assert.deepStrictEqual(asks, []);
    }),
  );

  it.effect("tries each version once, and never an install with no gated update", () =>
    Effect.gen(function* () {
      const repeated = yield* automatic(codex, { snapshots: 3 });
      assert.strictEqual(repeated.spawned.length, 1);
      // Snapshots still showing that version after its update finished don't start it again.
      const after = yield* automatic(codex, { later: 2 });
      assert.strictEqual(after.spawned.length, 1);
      assert.ok(after.statesWhenDone > 0);
      assert.strictEqual(after.states.length, after.statesWhenDone);
      // Homebrew can't install a specific version: its snapshot shows no gated update.
      const brew = capabilities("codex", "@openai/codex", "/opt/homebrew/bin/brew", ["upgrade", "--cask", "codex"], "homebrew");
      const { spawned, asks } = yield* automatic(brew, { runs: false });
      assert.deepStrictEqual(spawned, []);
      assert.deepStrictEqual(asks, []);
    }),
  );
});

describe("blacksand: Update to latest runs the vendor's own update, skipping the 3-day wait", () => {
  it.effect("npm and pnpm install @latest, without the age flags", () =>
    Effect.gen(function* () {
      const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-latest-"));
      const npm = capabilities("codex", "@openai/codex", "npm", ["install", "-g", "--prefix", prefix, "--allow-scripts=@openai/codex", "--before=2026-11-03T20:00:00Z", "@openai/codex@latest"], `npm-global:${prefix}`, { PATH: "/usr/bin" });
      const pnpm = capabilities("codex", "@openai/codex", "pnpm", ["add", "-g", "--config.minimum-release-age=4320", "--config.minimum-release-age-strict=true", "@openai/codex@latest"], "pnpm-global");
      const ran: Array<Array<string>> = [];
      for (const maintenance of [npm, pnpm]) {
        const { spawned, last } = yield* updateToLatest(maintenance);
        assert.strictEqual(last?.status, "succeeded");
        ran.push(spawned.map((call) => [call.command, ...call.args].join(" ")));
      }
      assert.deepStrictEqual(ran, [
        [`npm install -g --prefix ${prefix} --allow-scripts=@openai/codex @openai/codex@latest`],
        ["pnpm add -g @openai/codex@latest"],
      ]);
    }),
  );

  it.effect("native updaters run as their vendor ships them: no version, no pin", () =>
    Effect.gen(function* () {
      for (const [maintenance, args] of [
        [capabilities("claudeAgent", "@anthropic-ai/claude-code", "/home/me/.local/bin/claude", ["update"], "claudeAgent-native", { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }), ["update"]],
        [codex, ["update"]],
        [capabilities("opencode", "opencode-ai", "/home/me/.opencode/bin/opencode", ["upgrade"], "opencode-native"), ["upgrade"]],
        [capabilities("grok", "@xai-official/grok", "/home/me/.grok/bin/grok", ["update"], "grok-native"), ["update"]],
      ] as const) {
        const { spawned, last } = yield* updateToLatest(maintenance);
        const lockKey = maintenance.update?.lockKey;
        assert.strictEqual(last?.status, "succeeded", lockKey);
        assert.deepStrictEqual(spawned.map((call) => call.args), [args], lockKey);
        const env = spawned[0]!.env ?? {};
        for (const pin of ["CODEX_RELEASE", "GROK_MINIMUM_VERSION", "GROK_MAXIMUM_VERSION"]) assert.strictEqual(env[pin], undefined, `${lockKey} ${pin}`);
        // Claude Code's background switches stay: `claude update` still runs with them (Anthropic's setup docs).
        if (lockKey === "claudeAgent-native") assert.strictEqual(env.DISABLE_AUTOUPDATER, "1");
      }
    }),
  );

  it.effect("Homebrew, Pi and Muse, which get no gated update, run their own command", () =>
    Effect.gen(function* () {
      for (const [maintenance, command] of [
        [capabilities("codex", "@openai/codex", "/opt/homebrew/bin/brew", ["upgrade", "--cask", "codex"], "homebrew"), "/opt/homebrew/bin/brew upgrade --cask codex"],
        [capabilities("pi", "@earendil-works/pi-coding-agent", "/home/me/.pi/bin/pi", ["update", "--self"], "pi-native"), "/home/me/.pi/bin/pi update --self"],
        [capabilities("muse", null, "/home/me/.local/bin/muse", ["--version"], "muse:/home/me/.local/bin/muse", { MUSE_NO_AUTO_UPDATE: "0", MUSE_SYNC_UPDATE: "1", MUSE_UPDATE_INTERVAL_SECONDS: "0" }), "/home/me/.local/bin/muse --version"],
      ] as const) {
        assert.strictEqual(maintenance.update, null);
        const { spawned, last } = yield* updateToLatest(maintenance);
        assert.deepStrictEqual(spawned.map((call) => [call.command, ...call.args].join(" ")), [command]);
        assert.strictEqual(last?.status, "succeeded", command);
      }
    }),
  );

  it.effect("runs even when the settled version is installed, which upstream's check calls up to date", () =>
    Effect.gen(function* () {
      const { spawned, last } = yield* updateToLatest(codex, "1.0.8");
      assert.deepStrictEqual(spawned.map((call) => call.args), [["update"]]);
      assert.strictEqual(last?.status, "succeeded");
    }),
  );

  it.effect("leaves the caller's capabilities and env as they were", () =>
    Effect.gen(function* () {
      const given = { CODEX_HOME: "/home/me/.codex", KEEP: "yes" };
      const maintenance = capabilities("codex", "@openai/codex", "/home/me/.codex/packages/standalone/current/bin/codex", ["update"], "codex-native", given);
      const before = JSON.stringify(maintenance);
      const { spawned } = yield* updateToLatest(maintenance);
      assert.strictEqual(spawned[0]!.env?.KEEP, "yes");
      assert.strictEqual(JSON.stringify(maintenance), before);
      assert.deepStrictEqual(given, { CODEX_HOME: "/home/me/.codex", KEEP: "yes" });
    }),
  );

  it.effect("an install with no updater at all runs nothing", () =>
    Effect.gen(function* () {
      const none = onlyExactUpdates(
        makeProviderMaintenanceCapabilities({ provider: ProviderDriverKind.make("cursor"), packageName: null, updateExecutable: null, updateArgs: [], updateLockKey: null }),
      );
      const { spawned, exit } = yield* updateToLatest(none);
      assert.deepStrictEqual(spawned, []);
      assert.ok(Exit.isFailure(exit));
    }),
  );
});

describe("blacksand: Grok's own auto-update setting is left as the user had it", () => {
  it.effect("neither Update now nor Update to latest takes Grok's `--version` branch, or writes Grok's config", () =>
    Effect.gen(function* () {
      // xai-grok-update auto_update.rs, run_update: only `grok update --version` writes
      // cli.auto_update=false. T3 runs plain `grok update`, its range narrowed to one version.
      const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-grok-home-"));
      const config = NodePath.join(grokHome, "config.toml");
      NodeFS.writeFileSync(config, "[cli]\nauto_update = true\n");
      const grok = capabilities("grok", "@xai-official/grok", "/home/me/.grok/bin/grok", ["update"], "grok-native", { GROK_HOME: grokHome });
      // Grok's version is first seen on its channel, so the gated update is given it directly.
      const pinned = { ...grok, latestVersion: "1.0.8" };
      const now = yield* updateNow(pinned);
      const latest = yield* updateToLatest(grok);
      const runs = [...now.spawned, ...latest.spawned];
      assert.strictEqual(runs.length, 2);
      for (const call of runs) {
        assert.deepStrictEqual(call.args, ["update"]);
        assert.strictEqual(call.env?.GROK_HOME, grokHome);
      }
      assert.strictEqual(now.spawned[0]!.env?.GROK_MINIMUM_VERSION, "1.0.8");
      assert.strictEqual(now.spawned[0]!.env?.GROK_MAXIMUM_VERSION, "1.0.8");
      assert.strictEqual(NodeFS.readFileSync(config, "utf8"), "[cli]\nauto_update = true\n");
    }),
  );
});

describe("blacksand: native Grok never updates by itself; a minimum Grok requires would win over its range", () => {
  it.effect("runs nothing by itself for native Grok, with or without a required minimum, and still runs npm Grok", () =>
    Effect.gen(function* () {
      // xai-grok-shell config/resolve/version.rs, clamp_version: required_minimum_version, from
      // Grok's config or env, raises the target above the range T3 sets; env can only raise it.
      const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-grok-floor-"));
      NodeFS.writeFileSync(NodePath.join(grokHome, "config.toml"), '[cli]\nrequired_minimum_version = "1.0.9"\n');
      for (const env of [{ GROK_HOME: grokHome }, { GROK_HOME: grokHome, GROK_REQUIRED_MINIMUM_VERSION: "1.0.9" }, {}]) {
        const grok = { ...capabilities("grok", "@xai-official/grok", "/home/me/.grok/bin/grok", ["update"], "grok-native", env), latestVersion: "1.0.8" };
        const auto = yield* automatic(grok, { runs: false });
        assert.deepStrictEqual(auto.spawned, [], JSON.stringify(env));
        assert.deepStrictEqual(auto.states, []);
        // Update to latest is still there, for the user.
        const latest = yield* updateToLatest(grok);
        assert.deepStrictEqual(latest.spawned.map((call) => call.args), [["update"]]);
      }
      const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-grok-npm-"));
      const npm = capabilities("grok", "@xai-official/grok", "npm", ["install", "-g", "--prefix", prefix, "--allow-scripts=@xai-official/grok", "--before=2026-11-03T20:00:00Z", "@xai-official/grok@latest"], `npm-global:${prefix}`);
      const { spawned } = yield* automatic(npm);
      assert.deepStrictEqual(spawned.map((call) => call.args.at(-1)), ["@xai-official/grok@1.0.8"]);
    }),
  );
});

/** A standalone Codex install under a temporary CODEX_HOME, with the daemon files given. */
const codexHome = (files: ReadonlyArray<string> = [], links: ReadonlyArray<string> = []) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-codex-home-"));
  const release = "0.166.0-aarch64-apple-darwin";
  const standalone = NodePath.join(home, "packages/standalone");
  NodeFS.mkdirSync(NodePath.join(standalone, "releases", release, "bin"), { recursive: true });
  NodeFS.symlinkSync(NodePath.join("releases", release), NodePath.join(standalone, "current"));
  NodeFS.writeFileSync(NodePath.join(standalone, "auto-update-version"), release);
  for (const file of files) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(home, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, file), "");
  }
  for (const link of links) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(home, link)), { recursive: true });
    NodeFS.symlinkSync("releases/elsewhere", NodePath.join(home, link));
  }
  const maintenance = capabilities("codex", "@openai/codex", NodePath.join(standalone, "current/bin/codex"), ["update"], "codex-native", { CODEX_HOME: home });
  return { home, release, marker: NodePath.join(standalone, "auto-update-version"), maintenance };
};

describe("blacksand: no automatic Codex update while a legacy daemon runs from the standalone package", () => {
  it("reads the daemon's package as Codex does, and anything it can't read as a legacy daemon", () => {
    // openai/codex app-server-daemon managed_install.rs, package_root.
    assert.strictEqual(BlacksandProviderAutoUpdates.legacyCodexDaemon(codexHome().home), false, "no daemon state");
    for (const file of ["app-server.pid", "app-server.stderr.log", "app-server-updater.pid", "app-server-updater.stderr.log"]) {
      assert.strictEqual(BlacksandProviderAutoUpdates.legacyCodexDaemon(codexHome([`app-server-daemon/${file}`]).home), true, file);
      assert.strictEqual(BlacksandProviderAutoUpdates.legacyCodexDaemon(codexHome([`app-server-daemon/${file}`, "app-server-daemon/daemon.pid"]).home), false, `${file} with a current daemon`);
      // A dangling link counts, as Codex's symlink_metadata does.
      assert.strictEqual(BlacksandProviderAutoUpdates.legacyCodexDaemon(codexHome([`app-server-daemon/${file}`], ["packages/app-server-daemon/current"]).home), false, `${file} with a dedicated package`);
    }
    const file = NodePath.join(codexHome().home, "packages/standalone/auto-update-version");
    for (const home of [undefined, "", "relative/.codex", file]) assert.strictEqual(BlacksandProviderAutoUpdates.legacyCodexDaemon(home), true, String(home));
  });

  it.effect("leaves the marker alone and runs nothing, while Update to latest still runs `codex update`", () =>
    Effect.gen(function* () {
      const codexInstall = codexHome(["app-server-daemon/app-server.pid"]);
      const { spawned, states } = yield* automatic(codexInstall.maintenance, { runs: false });
      assert.deepStrictEqual(spawned, []);
      assert.deepStrictEqual(states, []);
      assert.strictEqual(NodeFS.readFileSync(codexInstall.marker, "utf8"), codexInstall.release);
      const latest = yield* updateToLatest(codexInstall.maintenance);
      assert.deepStrictEqual(latest.spawned.map((call) => call.args), [["update"]]);
    }),
  );

  it.effect("updates a standalone install with no legacy daemon, or a daemon of its own, by itself", () =>
    Effect.gen(function* () {
      for (const codexInstall of [
        codexHome(),
        codexHome(["app-server-daemon/app-server.pid", "app-server-daemon/daemon.pid"]),
        codexHome(["app-server-daemon/app-server.pid", "packages/app-server-daemon/auto-update-version"], ["packages/app-server-daemon/current"]),
      ]) {
        const { spawned } = yield* automatic(codexInstall.maintenance);
        assert.deepStrictEqual(spawned.map((call) => [call.env?.CODEX_HOME, call.env?.CODEX_RELEASE]), [[codexInstall.home, "1.0.8"]]);
      }
    }),
  );

  it.effect("checks again on the fresh resolution, just before it runs", () =>
    Effect.gen(function* () {
      const codexInstall = codexHome();
      yield* live(codexInstall.maintenance, (t) =>
        Effect.gen(function* () {
          // A legacy daemon starts after the cached resolution the snapshot was checked against.
          t.world.onFresh = () => {
            NodeFS.mkdirSync(NodePath.join(codexInstall.home, "app-server-daemon"), { recursive: true });
            NodeFS.writeFileSync(NodePath.join(codexInstall.home, "app-server-daemon/app-server.pid"), "");
          };
          yield* t.offer("1.0.8");
          yield* settle;
          assert.deepStrictEqual(t.spawned, []);
          assert.strictEqual(NodeFS.readFileSync(codexInstall.marker, "utf8"), codexInstall.release);
        }),
      );
    }),
  );
});

/** npm Codex installed under one prefix, which other instances can share. */
const npmCodex = () => {
  const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-npm-prefix-"));
  return capabilities("codex", "@openai/codex", "npm", ["install", "-g", "--prefix", prefix, "--allow-scripts=@openai/codex", "--before=2026-11-03T20:00:00Z", "@openai/codex@latest"], `npm-global:${prefix}`);
};
const OTHER = "codex-other";

describe("blacksand: automatic updates and the ones Settings asks for share one runner", () => {
  it.effect("an install Settings asks for waits for an automatic one into the same prefix", () =>
    live(npmCodex(), (t) =>
      Effect.gen(function* () {
        t.world.blockSpawns = true;
        t.world.enabled.set(OTHER, true);
        yield* t.offer("1.0.8");
        yield* until(() => t.spawned.length === 1);
        // Update now on another instance of the same install, through the server's runner.
        const asked = yield* t.runner.updateProvider({ provider: t.provider.driver, instanceId: ProviderInstanceId.make(OTHER) }).pipe(Effect.forkScoped);
        yield* settle;
        assert.strictEqual(t.spawned.length, 1, "waits for the automatic install");
        yield* Deferred.succeed(t.gates[0]!, undefined);
        yield* until(() => t.spawned.length === 2);
        yield* Deferred.succeed(t.gates[1]!, undefined);
        yield* Fiber.join(asked);
        assert.strictEqual(t.running.most, 1);
      }),
    ),
  );
});

describe("blacksand: an automatic update checks its settings and provider again just before it runs", () => {
  for (const setting of ["enableAutomaticProviderUpdates", "enableProviderUpdateChecks"] as const) {
    it.effect(`runs nothing queued once ${setting} is off, and runs again once it's back on`, () =>
      live(npmCodex(), (t) =>
        Effect.gen(function* () {
          t.world.blockSpawns = true;
          t.world.enabled.set(OTHER, true);
          // Update now on another instance holds the install lock; the automatic update queues behind it.
          const held = yield* t.runner.updateProvider({ provider: t.provider.driver, instanceId: ProviderInstanceId.make(OTHER) }).pipe(Effect.forkScoped);
          yield* until(() => t.spawned.length === 1);
          yield* t.offer("1.0.8");
          yield* settle;
          t.settings[setting] = false;
          yield* Deferred.succeed(t.gates[0]!, undefined);
          yield* Fiber.join(held);
          yield* settle;
          assert.strictEqual(t.spawned.length, 1);
          // Withdrawn, not tried: back on, the next snapshot runs it.
          t.settings[setting] = true;
          t.world.blockSpawns = false;
          yield* t.offer("1.0.8");
          yield* until(() => t.spawned.length === 2);
          assert.strictEqual(t.spawned[1]!.args.at(-1), "@openai/codex@1.0.8");
        }),
      ),
    );
  }

  it.effect("runs nothing queued for a provider turned off meanwhile, and runs again once it's back on", () =>
    live(npmCodex(), (t) =>
      Effect.gen(function* () {
        t.world.blockSpawns = true;
        t.world.enabled.set(OTHER, true);
        const held = yield* t.runner.updateProvider({ provider: t.provider.driver, instanceId: ProviderInstanceId.make(OTHER) }).pipe(Effect.forkScoped);
        yield* until(() => t.spawned.length === 1);
        yield* t.offer("1.0.8");
        yield* settle;
        t.world.enabled.set(String(t.provider.instanceId), false);
        yield* Deferred.succeed(t.gates[0]!, undefined);
        yield* Fiber.join(held);
        yield* settle;
        assert.strictEqual(t.spawned.length, 1);
        t.world.enabled.set(String(t.provider.instanceId), true);
        t.world.blockSpawns = false;
        yield* t.offer("1.0.8");
        yield* until(() => t.spawned.length === 2);
      }),
    ),
  );
});

describe("blacksand: each version an automatic update ran is tried once per server run", () => {
  it.effect("tries A, then B, and not A again, when installs fail", () =>
    live(codex, (t) =>
      Effect.gen(function* () {
        t.world.exitCode = 1;
        for (const version of ["1.0.8", "1.0.7", "1.0.8"] as const) {
          t.world.document = settledAt(version);
          yield* t.offer(version);
          yield* settle;
        }
        assert.deepStrictEqual(t.spawned.map((call) => call.env?.CODEX_RELEASE), ["1.0.8", "1.0.7"]);
      }),
    ),
  );

  it.effect("remembers the version it resolved and ran, not the one the snapshot showed", () =>
    live(codex, (t) =>
      Effect.gen(function* () {
        t.world.exitCode = 1;
        // The snapshot shows 1.0.8; by the time it runs, npm's newest settled release is 1.0.7.
        t.world.document = settledAt("1.0.7");
        yield* t.offer("1.0.8");
        yield* settle;
        yield* t.offer("1.0.7");
        yield* settle;
        // A snapshot of a version it hasn't tried, which still resolves to 1.0.7 when it runs.
        yield* t.offer("1.0.9");
        yield* settle;
        assert.deepStrictEqual(t.spawned.map((call) => call.env?.CODEX_RELEASE), ["1.0.7"]);
      }),
    ),
  );
});

describe("blacksand: a request the runner ended without running anything waits for a new health check or advisory", () => {
  it.effect("asks once for a version the manifest marks broken, not again on its own update states, and again after a health check", () =>
    live(codex, (t) =>
      Effect.gen(function* () {
        t.world.manifest = { ...t.world.manifest, compatibility: [{ driver: codex.provider, t3CodeRange: ">=0.0.42", ranges: [{ range: ">=1.0.0", status: "broken" }] }] };
        const failed = () => t.states.filter((state) => state.status === "failed").length;
        yield* t.offer("1.0.8");
        yield* settle;
        assert.strictEqual(failed(), 1);
        // Its update states were streamed back, the failure last, and started nothing.
        assert.strictEqual(t.published.at(-1)?.updateState?.status, "failed");
        yield* settle;
        assert.strictEqual(failed(), 1);
        // A health check of the same version, later.
        yield* t.offer("1.0.8", undefined, "2026-11-01T01:00:00.000Z");
        yield* settle;
        assert.strictEqual(failed(), 2);
        assert.deepStrictEqual(t.spawned, []);
      }),
    ),
  );

  it("leaves a version the snapshot already shows broken or unsupported alone", () => {
    const shown = snapshot(codex);
    const compatibility = (latestVersionStatus: "supported" | "broken" | "unsupported") => ({
      ...shown,
      compatibilityAdvisory: { status: "supported" as const, latestVersionStatus, message: null, recommendedVersion: null, recommendedRange: null },
    });
    assert.strictEqual(BlacksandProviderAutoUpdates.automaticUpdateVersion(compatibility("supported")), "1.0.8");
    assert.strictEqual(BlacksandProviderAutoUpdates.automaticUpdateVersion(compatibility("broken")), null);
    assert.strictEqual(BlacksandProviderAutoUpdates.automaticUpdateVersion(compatibility("unsupported")), null);
  });
});
