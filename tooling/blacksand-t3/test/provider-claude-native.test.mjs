// node --test: a native Claude Code install (lock key claudeAgent-native) keeps to the
// 3-day minimum release age (rule provider/claude-native-updates-minimum-age). The
// rule is applied to upstream's resolver code as it reads at 0.1.7-nightly.20261102.4093
// (the pin) and 0.1.8-nightly.20261104.4179 (identical in these functions), and the
// result runs in a vm with lib/files/blacksandReleaseAge.ts and fake services: no
// upstream package, network or CLI. test/stripped/blacksandReleaseAge.test.ts runs the
// same rule in upstream's checkout, with Effect's real HTTP client.
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

const ID = "provider/claude-native-updates-minimum-age";
const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
const rule = rules.find((candidate) => candidate.id === ID);

// Upstream's code, with the npm check as provider/updates-minimum-age leaves it.
const RESOLVER =
  "export function resolveLatestProviderUpdateAction(\n" +
  "  capabilities: ProviderMaintenanceCapabilities,\n" +
  "  latestVersion: string | null,\n" +
  "): ProviderMaintenanceCommandAction | null {\n" +
  "  const update = capabilities.update;\n" +
  '  if (!/^(?:pnpm-global$|npm-global:)/.test(update?.lockKey ?? "") || latestVersion === null) return update;\n' +
  "  return makeTargetedProviderUpdateAction(capabilities, latestVersion) ?? update;\n" +
  "}\n\n" +
  'const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {\n' +
  "  const client = yield* HttpClient.HttpClient;\n" +
  "  const request = HttpClientRequest.get(\n" +
  "    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,\n" +
  '  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));\n' +
  "  // The deadline covers the body too: headers can arrive before the JSON stalls.\n" +
  "  const payload = yield* client.execute(request).pipe(\n" +
  "    Effect.flatMap(HttpClientResponse.filterStatusOk),\n" +
  "    Effect.flatMap((response) => response.json),\n" +
  "    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),\n" +
  "    Effect.orElseSucceed(() => Option.none()),\n" +
  "  );\n" +
  "  return Option.isSome(payload) ? newestSettledVersion(payload.value) : null;\n" +
  "});\n\n" +
  "function installerLatestVersionKey(capabilities: ProviderMaintenanceCapabilities) {\n" +
  "  if (!capabilities.lookupLatestVersion) return null;\n" +
  "  if (capabilities.latestVersionCacheKey) return capabilities.latestVersionCacheKey;\n" +
  "  const update = capabilities.update;\n" +
  '  if (update) return [update.lockKey, update.executable, ...update.args].join("\\0");\n' +
  "  return capabilities.installPath\n" +
  '    ? ["manual", capabilities.installPath].join("\\0")\n' +
  "    : capabilities.packageName && `npm-registry\\0${capabilities.packageName}`;\n" +
  "}\n\n" +
  'export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (\n' +
  "  maintenanceCapabilities: ProviderMaintenanceCapabilities,\n" +
  ") {\n" +
  "  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;\n" +
  "  const installerKey = installerLatestVersionKey(maintenanceCapabilities);\n" +
  "  if (installerKey && maintenanceCapabilities.lookupLatestVersion) {\n" +
  "    const installable = yield* latestVersions.cached(\n" +
  "      installerKey,\n" +
  "      maintenanceCapabilities.lookupLatestVersion,\n" +
  "    );\n" +
  "    if (installable !== null) return installable;\n" +
  "  }\n" +
  "  if (maintenanceCapabilities.latestVersion !== undefined) {\n" +
  "    return maintenanceCapabilities.latestVersion;\n" +
  "  }\n" +
  "  const packageName = maintenanceCapabilities.packageName;\n" +
  "  if (!packageName) {\n" +
  "    return null;\n" +
  "  }\n\n" +
  "  return yield* latestVersions.cached(packageName, fetchNpmLatestVersion(packageName));\n" +
  "});\n";

function apply(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-claude-native-"));
  const log = console.log;
  try {
    const file = path.join(root, rule.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    console.log = () => {};
    const failures = applyRules(root, [rule]);
    return { failures: failures.map((failure) => failure.message), out: fs.readFileSync(file, "utf8") };
  } finally {
    console.log = log;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A tiny synchronous effect interpreter: an effect is a thunk, a failure a throw.
// `provided` holds the services provideService has set while an effect runs.
const provided = [];
const current = (tag, fallback) => provided.findLast(([key]) => key === tag)?.[1] ?? fallback;
class Thunk {
  constructor(run) {
    this.run = run;
  }
  pipe(...steps) {
    return steps.reduce((value, step) => step(value), this);
  }
  *[Symbol.iterator]() {
    return yield this;
  }
}
const effect = (run) => new Thunk(run);
function runGenerator(generator) {
  let step = generator.next();
  while (!step.done) step = generator.next(step.value.run());
  return step.value;
}
const dataLast = (body) => (...args) => (args[0] instanceof Thunk ? body(...args) : (self) => body(self, ...args));
const Effect = {
  fn: () => (body) => (...args) => effect(() => runGenerator(body(...args))),
  succeed: (value) => effect(() => value),
  flatMap: dataLast((self, f) => effect(() => f(self.run()).run())),
  timeoutOption: dataLast((self) => effect(() => Option.some(self.run()))),
  orElseSucceed: dataLast((self, f) =>
    effect(() => {
      try {
        return self.run();
      } catch {
        return f();
      }
    }),
  ),
  provideService: dataLast((self, tag, value) =>
    effect(() => {
      provided.push([tag, value]);
      try {
        return self.run();
      } finally {
        provided.pop();
      }
    }),
  ),
};
const Option = { some: (value) => ({ _tag: "Some", value }), none: () => ({ _tag: "None" }), isSome: (option) => option._tag === "Some" };

/** TypeScript as a vm script: imports dropped, exports made plain, types stripped. */
const script = (source) =>
  stripTypeScriptTypes(source.replace(/^import[^;]*;\n/gm, "").replace(/^export /gm, ""));

// The clock newestSettledVersion reads, so the 3-day boundary is exact.
const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;
class FixedDate extends Date {
  static now() {
    return NOW;
  }
}

const releaseAge = (() => {
  const source = fs.readFileSync(new URL("../lib/files/blacksandReleaseAge.ts", import.meta.url), "utf8");
  const context = { Effect, Date: FixedDate };
  vm.runInNewContext(`${script(source)}\nthis.exports = { newestSettledVersion };`, context);
  return context.exports;
})();

const { out, failures } = apply(RESOLVER);
const TracerPropagationEnabled = { key: "effect/http/HttpClient/TracerPropagationEnabled" };
const services = {
  Effect,
  Option,
  LATEST_VERSION_TIMEOUT_MS: 30_000,
  newestSettledVersion: releaseAge.newestSettledVersion,
  makeTargetedProviderUpdateAction: () => "targeted",
  HttpClientRequest: {
    get: (url) => ({ url, headers: {}, pipe: Thunk.prototype.pipe }),
    setHeader: (name, value) => (request) => ({ ...request, headers: { ...request.headers, [name]: value } }),
  },
  HttpClientResponse: {
    filterStatusOk: (response) =>
      effect(() => {
        if (response.status !== 200) throw new Error(`status ${response.status}`);
        return response;
      }),
  },
};
vm.runInNewContext(`${script(out)}\nthis.exports = { resolveLatestProviderUpdateAction, resolveLatestProviderVersion };`, services);
const resolver = services.exports;

const NPM_URL = "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code";
const CHANNEL_URL = "https://downloads.claude.ai/claude-code-releases/";

/** npm's document for @anthropic-ai/claude-code: { version: days old, or a raw time }. 2.1.318 is the latest tag. */
const npmDocument = (releases) => ({
  "dist-tags": { latest: "2.1.318" },
  versions: Object.fromEntries(Object.keys(releases).map((version) => [version, {}])),
  time: Object.fromEntries(
    Object.entries(releases).flatMap(([version, age]) =>
      age === undefined ? [] : [[version, typeof age === "number" ? new FixedDate(NOW - age * DAY).toISOString() : age]],
    ),
  ),
});
const RELEASES = { "2.1.309": 12, "2.1.311": 10, "2.1.316": 4, "2.1.318": 1 };

const native = (command = "/Users/me/.local/bin/claude update", args = ["update"], lockKey = "claudeAgent-native") => ({
  packageName: "@anthropic-ai/claude-code",
  update: { lockKey, executable: "/Users/me/.local/bin/claude", args, command },
});

/**
 * What a native install is offered, and the Update all action for it, with each
 * lookup faked. The channel lookup stands in for ClaudeMaintenance.ts's
 * `client.get(url)`: `channel` is its answer (null when it fails), `undefined`
 * for the pin, which has no such lookup.
 */
function offered({ channel, name = "stable", releases = RELEASES, registryUp = true, lockKey = "claudeAgent-native" }) {
  const asked = [];
  const sent = [];
  const send = (request) => sent.push({ url: request.url, headers: request.headers, propagation: current(TracerPropagationEnabled, true) });
  const document = npmDocument(releases);
  services.HttpClient = {
    TracerPropagationEnabled,
    HttpClient: effect(() => ({
      execute: (request) =>
        effect(() => {
          send(request);
          const status = request.url === NPM_URL && registryUp ? 200 : 500;
          return { status, json: effect(() => document) };
        }),
    })),
  };
  const latestVersions = { cached: (key, lookup) => effect(() => (asked.push(key), lookup.run())) };
  services.ProviderLatestVersions = { ProviderLatestVersions: effect(() => latestVersions) };
  const url = `${CHANNEL_URL}${name}`;
  const capabilities = {
    ...native(undefined, undefined, lockKey),
    ...(channel === undefined
      ? {}
      : { latestVersion: null, latestVersionCacheKey: url, lookupLatestVersion: effect(() => (send({ url, headers: {} }), channel)) }),
  };
  const version = run(resolver.resolveLatestProviderVersion(capabilities));
  const action = resolver.resolveLatestProviderUpdateAction(capabilities, version);
  return { version, action, asked, sent, document };
}
const run = (thunk) => thunk.run();

/** Every action offered names a release whose own npm publish time is at least 3 days old. */
function assertProvenOld({ action, document, version }) {
  if (action === null) return;
  assert.equal(action.args.length, 2);
  assert.equal(action.args[0], "install");
  const target = action.args[1];
  assert.equal(target, version);
  assert.ok(document.versions[target], `${target} is an npm release`);
  const published = Date.parse(document.time[target]);
  assert.ok(published <= NOW - 3 * DAY, `${target} was published ${document.time[target]}, under 3 days ago`);
}
const offer = (input) => {
  const result = offered(input);
  if (result.action !== "targeted") assertProvenOld(result);
  return result;
};

test("the rule applies to upstream's resolver at the pin and at 4179", () => {
  assert.deepEqual(failures, []);
  assert.doesNotMatch(out, /claude update|"update"\]/);
});

test("a native install is offered the newest npm release at least 3 days old, no higher than its channel's version", () => {
  // The latest channel names 2.1.318, a day old: offer 2.1.316, the newest 3 days old.
  const latest = offer({ channel: "2.1.318", name: "latest" });
  assert.equal(latest.version, "2.1.316");
  assert.deepEqual([...latest.action.args], ["install", "2.1.316"]);
  // The stable channel trails at 2.1.311, with newer settled releases: it's the ceiling.
  assert.equal(offer({ channel: "2.1.311" }).version, "2.1.311");
  assert.equal(offer({ channel: "2.1.310" }).version, null, "2.1.310 isn't an npm release");
  // Before 4106 there is no channel lookup: npm's 3-day-old release alone.
  const pin = offer({});
  assert.equal(pin.version, "2.1.316");
  assert.deepEqual(pin.asked, ["@anthropic-ai/claude-code"]);
});

test("a lower channel version is offered only when its own publish time is 3 days old", () => {
  // A day-old stable-line release below a settled 2.1.316: the newest settled release under it.
  const young = offer({ channel: "2.1.311", releases: { ...RELEASES, "2.1.311": 1 } });
  assert.equal(young.version, "2.1.309");
  // The boundary: exactly 3 days old qualifies, a second younger doesn't.
  assert.equal(offer({ channel: "2.1.311", releases: { ...RELEASES, "2.1.311": 3 } }).version, "2.1.311");
  const second = new FixedDate(NOW - 3 * DAY + 1000).toISOString();
  assert.equal(offer({ channel: "2.1.311", releases: { ...RELEASES, "2.1.311": second } }).version, "2.1.309");
  assert.equal(offer({ channel: "2.1.318", name: "latest", releases: { ...RELEASES, "2.1.318": 3 } }).version, "2.1.318");
});

test("a native install is offered nothing when npm can't prove the channel's version old", () => {
  // Missing from npm, or with no publish time, or one that isn't a date.
  assert.equal(offer({ channel: "2.1.312" }).action, null);
  assert.equal(offer({ channel: "2.1.311", releases: { ...RELEASES, "2.1.311": undefined } }).action, null);
  assert.equal(offer({ channel: "2.1.311", releases: { ...RELEASES, "2.1.311": "not a date" } }).action, null);
  // Nothing at all qualifies.
  assert.equal(offer({ channel: "2.1.318", name: "latest", releases: { "2.1.316": 2, "2.1.318": 1 } }).action, null);
});

test("a native install is offered nothing when either lookup fails", () => {
  assert.equal(offer({ channel: null }).version, null);
  assert.equal(offer({ channel: "2.1.318", registryUp: false }).version, null);
  assert.equal(offer({ registryUp: false }).version, null);
  for (const channel of ["latest", "2.1.311-beta.1", "v2.1.311", " 2.1.311", "2.1.311\n"]) {
    const result = offer({ channel });
    assert.equal(result.version, null, JSON.stringify(channel));
    assert.deepEqual(result.sent.map((request) => request.url), [`${CHANNEL_URL}stable`], "npm isn't asked");
  }
  // Any other installer keeps upstream's path, under its own rules.
  assert.equal(offered({ channel: "9.9.9", lockKey: "homebrew" }).version, "9.9.9");
});

test("the channel request carries no trace headers, and asks npm only after it", () => {
  const { sent, asked } = offer({ channel: "2.1.311" });
  assert.deepEqual(asked, [`${CHANNEL_URL}stable`], "cached under the channel's key, which a refresh clears");
  assert.deepEqual(sent.map((request) => request.url), [`${CHANNEL_URL}stable`, NPM_URL]);
  assert.equal(sent[0].propagation, false, "HttpClient.TracerPropagationEnabled is off for the channel request");
  // The rule turns it off around the channel lookup alone.
  assert.match(out, /lookup\.pipe\(Effect\.provideService\(HttpClient\.TracerPropagationEnabled, false\)\)/);
});

test("Update all runs `claude install <exact version>`, never `claude update`", () => {
  const action = resolver.resolveLatestProviderUpdateAction(native(), "2.1.316");
  assert.deepEqual([...action.args], ["install", "2.1.316"]);
  assert.equal(action.command, "/Users/me/.local/bin/claude install 2.1.316");
  assert.equal(action.executable, "/Users/me/.local/bin/claude");
  for (const version of [null, "latest", "stable", "2.1.316-beta.1", "2.1.316 --force", ""]) {
    assert.equal(resolver.resolveLatestProviderUpdateAction(native(), version), null, String(version));
  }
  // An updater upstream changed (other arguments): stop rather than guess.
  assert.equal(resolver.resolveLatestProviderUpdateAction(native("claude update --force", ["update", "--force"]), "2.1.316"), null);
  // npm and pnpm keep their targeted install.
  const npm = { packageName: "x", update: { lockKey: "npm-global:/usr/local", args: [], command: "npm" } };
  assert.equal(resolver.resolveLatestProviderUpdateAction(npm, "1.0.0"), "targeted");
});

test("the rule stops when upstream's code moves", () => {
  for (const [from, to] of [
    ["  latestVersion: string | null,\n): ProviderMaintenanceCommandAction | null {\n", "  version: string | null,\n): ProviderMaintenanceCommandAction | null {\n"],
    ["  const installerKey = installerLatestVersionKey(maintenanceCapabilities);\n", "  const installerKey = installerKeyOf(maintenanceCapabilities);\n"],
    ["(function* (packageName: string) {\n", "(function* (name: string) {\n"],
    ["newestSettledVersion(payload.value) : null;\n", "newestSettledVersion(payload) : null;\n"],
  ]) {
    assert.equal(apply(RESOLVER.replace(from, to)).failures.length, 1, to);
  }
  assert.equal(apply(RESOLVER + RESOLVER).failures.length, 1);
});

test("the native channel lookup and the ADMX namespace are listed, and the rule is strict", () => {
  const listed = fs.readFileSync(new URL("../lib/known-hosts.txt", import.meta.url), "utf8");
  for (const url of ["https://downloads.claude.ai/claude-code-releases/latest", "http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions"]) {
    assert.equal(isKnownHost(hostsIn(url)[0].host), true, url);
  }
  assert.match(listed, new RegExp(`^downloads\\.claude\\.ai # .*3 days old .*\\(rule ${ID.replace("/", "\\/")}\\)$`, "m"));
  assert.match(listed, /^schemas\.microsoft\.com # XML namespace in the generated Windows Group Policy \(ADMX\) template; never fetched$/m);
  assert.equal(isKnownHost("claude-code-releases.downloads.claude.ai"), false);
  assert.equal(featureIndex(rules).get(ID), undefined, `${ID} stays strict`);
});
