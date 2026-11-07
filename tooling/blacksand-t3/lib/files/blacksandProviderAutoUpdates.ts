// Injected by blacksand (rule provider/automatic-updates-file).
// T3 updates each provider by itself to the newest release at least
// MIN_RELEASE_AGE_DAYS old, through the server's one update runner and the same
// gated, exact-version path as Update now (providerMaintenanceRunner.ts,
// blacksandReleaseAge.ts), so it waits for any other update into the same place.
// It acts on upstream's own version checks: when a provider's snapshot shows a
// settled version newer than the installed one (versionAdvisory behind_latest,
// with a gated update to run).
//
// It runs only while no session of that driver is opening, open or still closing,
// and holds new sessions back until it ends (the session manager's whenDriverIdle),
// so a CLI is never replaced under a session. A busy provider is looked at again
// on its next snapshot, which upstream's health refresh republishes. Just before
// the command starts, it checks again that both settings are on and the provider is
// still enabled; if not, it runs nothing and tries again on a later snapshot. Each
// instance and version it runs is tried once per server run, so a failing install
// doesn't repeat. Otherwise, once a request has reached the runner, it isn't made
// again until a health check or advisory changes what the snapshot says, so one the
// runner ended without running anything (a version known broken, an install that
// changed, a command it doesn't run by itself) doesn't come back on the update states
// it published meanwhile. A version the snapshot already shows broken or unsupported
// isn't asked for at all.
// Settings → Maintenance → Automatic provider updates turns it off; so does
// turning off the version checks it acts on.
// The Codex daemon's state is a few file names, read where Codex reads them:
// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { ProviderMaintenanceCommandAction } from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/** The settled version an automatic update would install now, or null. */
export function automaticUpdateVersion(provider: ServerProvider): string | null {
  const advisory = provider.versionAdvisory;
  const updating = provider.updateState?.status === "queued" || provider.updateState?.status === "running";
  if (!provider.enabled || !provider.installed || updating) return null;
  if (advisory?.status !== "behind_latest") return null;
  // The runner would refuse a version the compatibility manifest marks broken or unsupported.
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  if (compatibility === "broken" || compatibility === "unsupported") return null;
  return advisory.latestVersion;
}

/** What a snapshot says about the install, apart from the update state the runner publishes. */
const observation = (provider: ServerProvider) =>
  JSON.stringify([provider.checkedAt, provider.version, provider.versionAdvisory ?? null, provider.compatibilityAdvisory ?? null]);

/**
 * Whether a legacy Codex app-server daemon in `codexHome` runs from the standalone
 * package, by Codex's own choice of package (openai/codex app-server-daemon
 * managed_install.rs, package_root): no `packages/app-server-daemon/current`, none of
 * its daemon's files in `app-server-daemon/`, and one of the legacy daemon's there.
 * Installing a specific version deletes that package's `auto-update-version`
 * (install.sh), which that daemon needs to keep updating itself (lib.rs,
 * ensure_managed_updater). Anything it can't read counts as yes.
 */
export function legacyCodexDaemon(codexHome: string | undefined): boolean {
  if (!codexHome || !NodePath.isAbsolute(codexHome)) return true;
  const exists = (path: string) => NodeFS.lstatSync(NodePath.join(codexHome, path), { throwIfNoEntry: false }) !== undefined;
  const daemonFiles = (names: ReadonlyArray<string>) => names.some((name) => exists(NodePath.join("app-server-daemon", name)));
  try {
    if (exists("packages/app-server-daemon/current")) return false;
    if (daemonFiles(["daemon.pid", "daemon.stderr.log", "daemon-updater.pid", "daemon-updater.stderr.log"])) return false;
    return daemonFiles(["app-server.pid", "app-server.stderr.log", "app-server-updater.pid", "app-server-updater.stderr.log"]);
  } catch {
    return true;
  }
}

/**
 * Whether T3 runs this gated update by itself. Update now and Update to latest still
 * run the two it doesn't:
 * - Native Grok: a minimum Grok's own config requires (required_minimum_version) wins
 *   over the one-version range the update sets, so Grok could install a newer build
 *   than the one shown 3 days old, and no environment can lower it (xai-grok-shell
 *   config/resolve/version.rs: resolve_version_bound, clamp_version).
 * - Standalone Codex, while a legacy daemon runs from its package (legacyCodexDaemon),
 *   checked in the executable's own CODEX_HOME, the one its update installs into.
 */
export function runsByItself(update: ProviderMaintenanceCommandAction | null): boolean {
  if (update === null || update.lockKey === "grok-native") return false;
  if (update.lockKey === "codex-native") return !legacyCodexDaemon(update.env?.CODEX_HOME);
  return true;
}

export const make = Effect.fn("BlacksandProviderAutoUpdates.make")(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sessions = yield* ProviderSessionManagerV2;
  const settings = yield* ServerSettingsService;
  const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const scope = yield* Effect.scope;
  /** Instance and version pairs run this server run, and instances with a request in flight. */
  const tried = new Set<string>();
  const inFlight = new Set<ProviderInstanceId>();
  /** Each instance's last snapshot a request reached the runner for, unless settings withdrew it. */
  const answered = new Map<ProviderInstanceId, string>();
  const triedKey = (instanceId: ProviderInstanceId, version: string) => `${instanceId}\u0000${version}`;

  /** Both settings on, and the instance still enabled; settings it can't read count as off. */
  const allowed = Effect.fn("BlacksandProviderAutoUpdates.allowed")(function* (instanceId: ProviderInstanceId) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!current?.enableAutomaticProviderUpdates || !current.enableProviderUpdateChecks) return false;
    return (yield* registry.getProviders).some((provider) => provider.instanceId === instanceId && provider.enabled);
  });

  const consider = Effect.fn("BlacksandProviderAutoUpdates.consider")(function* (provider: ServerProvider) {
    const version = automaticUpdateVersion(provider);
    const { instanceId, driver } = provider;
    if (version === null || inFlight.has(instanceId) || tried.has(triedKey(instanceId, version))) return;
    const seen = observation(provider);
    if (answered.get(instanceId) === seen) return;
    if (!(yield* allowed(instanceId))) return;
    if (!runsByItself((yield* registry.getProviderMaintenanceCapabilitiesForInstance(instanceId, driver)).update)) return;
    // Without the session manager's reservation, every provider counts as busy.
    if (!sessions.whenDriverIdle) return;
    let withdrawn = false;
    // The runner's last check, with the exact command it resolved, after any wait.
    const beforeRun = Effect.fn("BlacksandProviderAutoUpdates.beforeRun")(function* (
      command: ProviderMaintenanceCommandAction,
      resolved: string | null,
    ) {
      if (resolved === null || tried.has(triedKey(instanceId, resolved)) || !runsByItself(command)) return false;
      if (!(yield* allowed(instanceId))) {
        withdrawn = true;
        return false;
      }
      tried.add(triedKey(instanceId, resolved));
      return true;
    });
    // Runs only once the driver is idle; a busy driver's request never reaches the runner.
    const update = runner.updateProvider({ provider: driver, instanceId, beforeRun }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!withdrawn) answered.set(instanceId, seen);
        }),
      ),
    );
    inFlight.add(instanceId);
    yield* sessions.whenDriverIdle(driver, update).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(Effect.sync(() => inFlight.delete(instanceId))),
      Effect.forkIn(scope),
    );
  });

  yield* registry.streamChanges.pipe(
    Stream.runForEach((providers) =>
      Effect.forEach(providers, (provider) => consider(provider).pipe(Effect.ignoreCause({ log: true })), {
        discard: true,
      }),
    ),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make());
