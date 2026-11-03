// Reviewed upstream excerpts run through the production rules, with no network or app runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

import { makeRules } from "../lib/rules.mjs";
import { applyRules, hostsIn } from "../lib/strip-engine.mjs";
import { featureIndex } from "../lib/features.mjs";
import { isKnownHost } from "../lib/build.mjs";

const { fixtures } = JSON.parse(fs.readFileSync(new URL("./fixtures/upstream-compatibility.json", import.meta.url), "utf8"));
const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
const byId = new Map(rules.map((rule) => [rule.id, rule]));

function apply(id, source) {
  const rule = byId.get(id);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-compatibility-"));
  const log = console.log;
  try {
    const file = path.join(root, rule.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    console.log = () => {};
    const failures = applyRules(root, [rule]);
    return { failures, out: fs.readFileSync(file, "utf8") };
  } finally {
    console.log = log;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function applies(id, source) {
  const result = apply(id, source);
  assert.deepEqual(result.failures.map((failure) => failure.message), []);
  return result.out;
}
const drifts = (id, source) => assert.equal(apply(id, source).failures.length, 1, `${id} must stop`);

// A tiny effect interpreter for the injected control flow. Its services are fakes;
// it cannot load upstream packages, run a CLI, bind a port or reach the network.
const effect = (run) => ({
  run,
  pipe(...ops) { return ops.reduce((value, op) => op(value), this); },
  *[Symbol.iterator]() { return yield this; },
});
function run(generator) {
  let step = generator.next();
  while (!step.done) {
    try { step = generator.next(step.value.run()); }
    catch (error) { step = generator.throw(error); }
  }
  return step.value;
}
const Effect = {
  succeed: (value) => effect(() => value),
  fail: (error) => effect(() => { throw error; }),
  gen: (fn) => effect(() => run(fn())),
  orDie: (value) => value,
  catchTags: (handlers) => (value) => effect(() => {
    try { return value.run(); }
    catch (error) { if (handlers[error._tag]) return handlers[error._tag](error).run(); throw error; }
  }),
  mapError: (map) => (value) => effect(() => {
    try { return value.run(); } catch (error) { throw map(error); }
  }),
};

for (const [version, fixture] of Object.entries(fixtures)) {
  test(`${version}: analytics is a no-op and its exact layer alternatives stay strict`, () => {
    const id = "server/analytics-noop-layer";
    const out = applies(id, fixture.analytics);
    const sentinel = {};
    const service = vm.runInNewContext(`[${out}][0]`, {
      Effect: { void: sentinel },
      Layer: { provideMerge: (value) => value, succeed: (_, value) => value },
      AnalyticsService: { AnalyticsService: { of: (value) => value } },
    });
    assert.equal(service.record(), sentinel);
    assert.equal(service.recordOwners(), sentinel);
    assert.equal(service.flush, sentinel);
    assert.doesNotMatch(out, /AnalyticsService\.layer|ManagedPolicy\.layer/);
    drifts(id, fixture.analytics + fixture.analytics);
    drifts(id, fixture.analytics.replace("AnalyticsService.layer", "AnalyticsService.newLayer"));
    drifts(id, fixtures["3991"].analytics + fixtures["4093"].analytics);
  });

  test(`${version}: disabled cloud parks activation before acquiring any cloud service`, () => {
    const id = "server/cloud-reconcile-off";
    const out = applies(id, fixture.cloud);
    let parked = 0;
    const guard = out.slice(out.indexOf("        if (!hasCloudPublicConfig)"), out.indexOf("        const cloudLink ="));
    const task = vm.runInNewContext(`Effect.gen(function* () { ${guard} throw Error("cloud guard fell through"); })`, {
      hasCloudPublicConfig: false, cloudLinkParked: {}, Effect,
      Deferred: { succeed: () => effect(() => { parked++; }) },
      Layer: { effectDiscard: (value) => value },
      CloudLink: { get CloudLink() { throw Error("cloud service acquired"); } },
    });
    task.run();
    assert.equal(parked, 1);
    assert.equal(out.split("yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);").length - 1, 2);
    drifts(id, fixture.cloud.replaceAll("cloudLinkParked", "renamedParked"));
    drifts(id, fixture.cloud + "yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);\n");
    drifts(id, fixture.cloud + fixture.cloud);
    if (version === "4093") drifts(id, fixture.cloud.replace("ManagedLimits.allowsConnect", "ManagedLimits.newAllowsConnect"));
  });

  test(`${version}: manual update reasons preserve the upstream capabilities`, () => {
    const id = "provider/updates-manual-reason";
    const out = applies(id, fixture.maintenance);
    assert.match(out, /readonly manualReason\?: string/);
    assert.equal(out.includes("readonly manualCommand?: string"), version === "4093");
    drifts(id, fixture.maintenance + fixture.maintenance);
    drifts(id, fixture.maintenance.replace("readonly installPath?", "readonly renamedPath?"));
    if (version === "4093") drifts(id, fixture.maintenance.replace("readonly manualCommand?", "readonly renamedCommand?"));
  });

  test(`${version}: packaged update UI uses Blacksand while retaining managed off and development guards`, () => {
    const id = "desktop/updater-enabled";
    const out = applies(id, fixture.desktop);
    const reason = vm.runInNewContext(`${stripTypeScriptTypes(out)}\ngetAutoUpdateDisabledReason`);
    const args = { policy: { mode: "default", message: null }, isDevelopment: false, isPackaged: true, platform: "darwin", isDebPackage: false, disabledByEnv: false, hasUpdateFeedConfig: false };
    assert.equal(reason(args), null, "Blacksand needs no stock feed");
    assert.match(reason({ ...args, isDevelopment: true }), /no update feed/);
    assert.match(reason({ ...args, isPackaged: false, hasUpdateFeedConfig: true }), /packaged production/);
    if (version === "4093") {
      assert.equal(reason({ ...args, policy: { mode: "off", message: "Managed off" } }), "Managed off");
      assert.match(reason({ ...args, policy: { mode: "off", message: null } }), /turned off/);
      drifts(id, fixture.desktop.replace('args.policy.mode === "off"', 'args.policy.mode === "disabled"'));
    }
    drifts(id, fixture.desktop + fixture.desktop);
    drifts(id, fixture.desktop.replace("!args.hasUpdateFeedConfig", "!args.feedConfigured"));
  });

  test(`${version}: Tailscale import/bind alternatives fail closed on unknown shapes`, () => {
    const id = "server/no-tailscale-serve-config";
    const out = applies(id, fixture.tailscale);
    assert.match(out, /ensureTailscaleServe as upstreamEnsureTailscaleServe/);
    assert.doesNotMatch(out, /upstreamEnsureTailscaleServe\(/);
    assert.doesNotMatch(out, /ManagedLimits\.closeTailscaleServeTo\(/);
    drifts(id, fixture.tailscale + fixture.tailscale);
    drifts(id, fixture.tailscale.replace("  ensureTailscaleServe,", "  newEnsureTailscaleServe,").replace("disableTailscaleServe, ensureTailscaleServe }", "disableTailscaleServe, newEnsureTailscaleServe }"));
    drifts(id, fixture.tailscale.replace("host: config.host", "host: config.bindHost").replace("ManagedLimits.closeTailscaleServeTo", "ManagedLimits.newCloseTailscaleServeTo"));
  });

  test(`${version}: privacy wording survives upstream managed-policy text`, () => {
    for (const [id, text] of [["web/privacy-text-welcome", fixture.welcome], ["web/privacy-text-about", fixture.about]]) {
      const out = applies(id, text);
      assert.match(out, /collects no usage data/);
      assert.doesNotMatch(out, /collects anonymous usage data/);
      assert.equal(out.includes("telemetryOff"), version === "4093", "retain the managed policy message");
      drifts(id, text + text);
      drifts(id, text.replace("anonymous usage data", "different usage data"));
    }
  });
}

test("managed Tailscale startup checks routes without invoking any writer", () => {
  const out = applies("server/no-tailscale-serve-config", fixtures["4093"].tailscale);
  const check = out.slice(out.indexOf("    // blacksand: check managed restrictions"));
  assert.doesNotMatch(check, /disableTailscale|ensureTailscale|closeTailscale/);
  const cases = [
    { remote: true, routes: [1], reads: 0, binds: true },
    { routes: [], reads: 1, binds: true },
    { routes: [1], reads: 1, binds: false },
    { listen: false, reads: 0, binds: false },
    { error: { _tag: "TailscaleCommandSpawnError", cause: { _tag: "PlatformError", reason: { _tag: "NotFound" } } }, reads: 1, binds: true },
    ...["not-running", "not-logged-in"].map((stderrDiagnostic) => ({ error: { _tag: "TailscaleCommandExitError", stderrDiagnostic }, reads: 1, binds: true })),
    ...["permission-denied", undefined].map((stderrDiagnostic) => ({ error: { _tag: "TailscaleCommandExitError", stderrDiagnostic }, reads: 1, binds: false })),
    { error: { _tag: "TailscaleCommandSpawnError", cause: Error("denied") }, reads: 1, binds: false },
    { error: { _tag: "TailscaleCommandTimeoutError" }, reads: 1, binds: false },
    { error: { _tag: "TailscaleCommandSpawnError", cause: Object.assign(Error("not a directory"), { code: "ENOTDIR" }) }, reads: 1, binds: true },
    { error: { _tag: "TailscaleCommandSpawnError", cause: Object.assign(Error("missing"), { code: "ENOENT" }) }, reads: 1, binds: false },
  ];
  for (const input of cases) {
    let reads = 0;
    const fn = vm.runInNewContext(`(function* () { ${check}\nreturn "bound"; })`, {
      Effect, Error, policy: {}, config: { port: 12345 }, bindHost: "127.0.0.1",
      ManagedLimits: { allowsRemoteClients: () => input.remote ?? false, refuseRemoteClients: (_, message) => {
        const error = Error(message);
        error[Symbol.iterator] = function* () { return yield Effect.fail(error); };
        return error;
      } },
      NetService: { NetService: Effect.succeed({ canListenOnHost: () => Effect.succeed(input.listen ?? true) }) },
      BlacksandPlatformError: { isPlatformError: (error) => error?._tag === "PlatformError" },
      readTailscaleServeRoutesTo: () => effect(() => { reads++; if (input.error) throw input.error; return input.routes ?? []; }),
    });
    if (input.binds) assert.equal(run(fn()), "bound");
    else assert.throws(() => run(fn()), /server does not start/);
    assert.equal(reads, input.reads);
  }
});

test("Cursor catalog admission is exact, through the production URL parser and host policy", () => {
  for (const url of ["https://api.cursor.com/v1/me", "https://API.CURSOR.COM.:443/v1/models"]) {
    assert.equal(isKnownHost(hostsIn(url)[0].host), true);
  }
  for (const url of ["https://telemetry.cursor.com", "https://updates.cursor.com", "https://api.cursor.com.evil.org", "https://api.cursor.com@evil.org", "https://sub.api.cursor.com"]) {
    assert.equal(isKnownHost(hostsIn(url)[0].host), false, url);
  }
  const hosts = fs.readFileSync(new URL("../lib/known-hosts.txt", import.meta.url), "utf8");
  assert.doesNotMatch(hosts, /\*.*cursor|\.cursor\.com\s*$/m);
  for (const id of ["server/analytics-noop-layer", "server/cloud-reconcile-off", "provider/updates-minimum-age", "provider/updates-manual-reason", "desktop/updater-enabled", "server/no-tailscale-serve-config"]) {
    assert.equal(featureIndex(rules).get(id), undefined, `${id} stays strict`);
  }
});
