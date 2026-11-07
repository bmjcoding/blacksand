// Copied to apps/server/src/orchestration-v2/ in a stripped upstream checkout and run there
// (rule provider/automatic-updates-idle): upstream's session manager, with a test adapter,
// runs an automatic update only while no session of its driver is opening, open or closing,
// and a session that starts meanwhile waits for the update to end. A session that fails or is
// interrupted before it's published counts itself out once its CLI has stopped.
// @effect-diagnostics multipleEffectProvide:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AgentScope } from "@t3tools/shared/AgentScope";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const CODEX = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" } satisfies ModelSelection;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

/** Where the test adapter waits: inside openSession, before the session is published, and in its scope's close. */
interface Gates {
  readonly opening: Deferred.Deferred<void>;
  readonly open: Deferred.Deferred<void>;
  readonly closing: Deferred.Deferred<void>;
  readonly close: Deferred.Deferred<void>;
  opened: number;
  /** When set, the session manager's AgentScope.clear, just before the adapter opens, resolves the first and waits for the second. */
  beforeAdapter?: Deferred.Deferred<void> | undefined;
  releaseBeforeAdapter?: Deferred.Deferred<void> | undefined;
  /** openSession fails once its CLI is running. */
  fail?: boolean;
}

const adapter = (gates: Gates) =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: modelSelection.instanceId,
    driver: CODEX,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        gates.opened += 1;
        // The CLI is running from here: its process ends in this finalizer.
        yield* Effect.addFinalizer(() => Deferred.succeed(gates.closing, undefined).pipe(Effect.andThen(Deferred.await(gates.close))));
        if (gates.fail) return yield* new ProviderAdapter.ProviderAdapterProtocolError({ driver: CODEX, detail: "openSession failed" });
        yield* Deferred.succeed(gates.opening, undefined);
        yield* Deferred.await(gates.open);
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        const unused = (detail: string) => Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver: CODEX, detail }));
        return {
          instanceId: modelSelection.instanceId,
          driver: CODEX,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: CODEX,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: "gpt-5.4",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          backgroundTasksEndWithProcess: true as const,
          ensureThread: () => unused("ensureThread"),
          resumeThread: (thread) => Effect.succeed(thread.providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          unloadThread: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: () => unused("rollbackThread"),
          forkThread: () => unused("forkThread"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });

const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(SqlitePersistence.layerMemory));
const layerEventSink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, SqlitePersistence.layerMemory)));
const layerMcpRegistry = Layer.effect(McpSessionRegistry.McpSessionRegistry, McpSessionRegistry.__testing.make()).pipe(
  Layer.provide(
    Layer.succeed(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-blacksand-session-idle")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** Upstream's session manager over the test adapter, as upstream's own tests build it. */
const layer = (gates: Gates) => {
  const ingestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
          getInstance: () => Effect.succeed(undefined),
        }),
        layerEventSink,
        IdAllocator.layer,
        layerStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveBranchName: () => Effect.succeed(null) }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerStores,
    layerEventSink,
    IdAllocator.layer,
    ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          ProviderAdapterRegistry.layerSingle(adapter(gates)).pipe(Layer.provideMerge(McpProviderSessions.layer)),
          CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(layerEventSink, layerStores))),
          layerEventSink,
          IdAllocator.layer,
          ingestor,
          layerMcpRegistry,
          layerStores,
          Layer.succeed(AgentScope, {
            wrap: ({ command, args }) => Effect.succeed({ command, args }),
            oomKilled: () => Effect.succeed(false),
            stop: () => Effect.void,
            kill: () => Effect.succeed(false),
            clear: () =>
              gates.beforeAdapter && gates.releaseBeforeAdapter
                ? Deferred.succeed(gates.beforeAdapter, undefined).pipe(Effect.andThen(Deferred.await(gates.releaseBeforeAdapter)))
                : Effect.void,
          }),
        ),
      ),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
};

/** Runs `body` with the manager, a function that opens a session in a fiber of its own, and the gates. */
const withManager = (body: (input: {
  readonly manager: ProviderSessionManager.ProviderSessionManagerV2["Service"];
  readonly openSession: (name: string) => Effect.Effect<Fiber.Fiber<unknown>>;
  readonly gates: Gates;
}) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const gates: Gates = {
      opening: yield* Deferred.make<void>(),
      open: yield* Deferred.make<void>(),
      closing: yield* Deferred.make<void>(),
      close: yield* Deferred.make<void>(),
      opened: 0,
    };
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const openSession = (name: string) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread-blacksand-session-idle-${name}`);
          const now = yield* DateTime.now;
          const providerSessionId = yield* ids.allocate.providerSession({ providerInstanceId: modelSelection.instanceId, threadId });
          const thread: OrchestrationV2AppThread = {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: yield* ids.allocate.project({ fixtureName: "blacksand-session-idle" }),
            title: "Session idle",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: ids.derive.providerThread({ driver: CODEX, nativeThreadId: `native-${name}` }),
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* eventSink.write({
            events: [{ id: yield* ids.allocate.event({ threadId }), type: "thread.created", threadId, occurredAt: now, payload: thread }],
          });
          return yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy }).pipe(Effect.orDie, Effect.forkDetach);
        }).pipe(Effect.orDie);
      yield* body({ manager, openSession, gates });
    }).pipe(Effect.provide(layer(gates)));
  });

/** What an automatic update of `driver` would do now: whether it ran, and whether it saw an open adapter while it ran. */
const tryUpdate = (manager: ProviderSessionManager.ProviderSessionManagerV2["Service"], driver: string, during: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    assert.ok(manager.whenDriverIdle, "the session manager offers the reservation");
    let ran = false;
    yield* manager.whenDriverIdle(driver, during.pipe(Effect.andThen(Effect.sync(() => (ran = true)))));
    return ran;
  });

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 500; turn++) yield* Effect.yieldNow;
});

it.effect("blacksand: a session that starts while an automatic update runs waits for it to end", () =>
  withManager(({ manager, openSession, gates }) =>
    Effect.gen(function* () {
      // The session's adapter opens and closes at once here.
      yield* Deferred.succeed(gates.open, undefined);
      yield* Deferred.succeed(gates.close, undefined);
      const decided = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The update has found the driver idle and is installing.
      const update = yield* tryUpdate(manager, "codex", Deferred.succeed(decided, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
        Effect.forkDetach,
      );
      yield* Deferred.await(decided);
      const session = yield* openSession("during-update");
      yield* settle;
      assert.strictEqual(gates.opened, 0, "the session's CLI doesn't start during the install");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(update), true);
      yield* Fiber.join(session);
      assert.strictEqual(gates.opened, 1);
    }),
  ),
);

it.effect("blacksand: no automatic update while a session is still opening, open, or closing", () =>
  withManager(({ manager, openSession, gates }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* tryUpdate(manager, "codex"), true, "idle");
      const session = yield* openSession("lifecycle");
      // Inside the adapter's openSession, before the manager publishes the session.
      yield* Deferred.await(gates.opening);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), false, "opening");
      // Another driver isn't held back.
      assert.strictEqual(yield* tryUpdate(manager, "grok"), true, "another driver");
      yield* Deferred.succeed(gates.open, undefined);
      yield* Fiber.join(session);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), false, "open");
      // Closing: the adapter's finalizer, which stops the CLI, hasn't finished.
      const closing = yield* manager.closeInstance(modelSelection.instanceId).pipe(Effect.orDie, Effect.forkDetach);
      yield* Deferred.await(gates.closing);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), false, "closing");
      yield* Deferred.succeed(gates.close, undefined);
      yield* Fiber.join(closing);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), true, "closed");
    }),
  ),
);

it.effect("blacksand: a session interrupted before its adapter opens counts itself out", () =>
  withManager(({ manager, openSession, gates }) =>
    Effect.gen(function* () {
      // Counted in, and waiting in AgentScope.clear, just before the adapter opens.
      gates.beforeAdapter = yield* Deferred.make<void>();
      gates.releaseBeforeAdapter = yield* Deferred.make<void>();
      const opening = yield* openSession("before-adapter");
      yield* Deferred.await(gates.beforeAdapter);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), false, "counted in");
      yield* Fiber.interrupt(opening);
      assert.strictEqual(gates.opened, 0);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), true, "interrupted before the adapter");
      gates.beforeAdapter = undefined;
      // Interrupted while it waits for an automatic update to end.
      const decided = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const update = yield* tryUpdate(manager, "codex", Deferred.succeed(decided, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
        Effect.forkDetach,
      );
      yield* Deferred.await(decided);
      const waiting = yield* openSession("behind-update");
      yield* settle;
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(update), true);
      assert.strictEqual(gates.opened, 0);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), true, "interrupted while waiting");
    }),
  ),
);

it.effect("blacksand: a session that fails or is interrupted inside its adapter counts itself out once its CLI has stopped", () =>
  withManager(({ manager, openSession, gates }) =>
    Effect.gen(function* () {
      const interrupted = yield* openSession("interrupted");
      yield* Deferred.await(gates.opening);
      const interrupting = yield* Fiber.interrupt(interrupted).pipe(Effect.forkDetach);
      // The adapter's finalizer, which stops the CLI, hasn't finished.
      yield* Deferred.await(gates.closing);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), false, "closing");
      yield* Deferred.succeed(gates.close, undefined);
      yield* Fiber.join(interrupting);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), true, "interrupted");
      gates.fail = true;
      const failed = yield* openSession("failed");
      yield* Fiber.await(failed);
      assert.strictEqual(gates.opened, 2);
      assert.strictEqual(yield* tryUpdate(manager, "codex"), true, "failed");
    }),
  ),
);
