// node --test test/*.test.mjs: the rules fit both the pinned upstream release and
// 0.1.6-nightly.20261031.3956 and later (lib/rules.mjs shapes, addedAfter), stay strict
// when upstream moves on again (a rename or a move of new code is drift, never "not
// added yet"), and keep 3956's npm and GitHub lookups and 3973's `t3 up` out of the build.
// The snippets are upstream's code as it reads at 3940 (ae521d1d), 3956 (d92c437b) and
// 3973 (85bd3f2a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { featureIndex } from "../lib/features.mjs";
import { STOCK_GUIDANCE, makeRules } from "../lib/rules.mjs";
import { applyRules } from "../lib/strip-engine.mjs";

const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/t3b/bin/t3", path: "/usr/bin" }, build: null });
const byId = new Map(rules.map((rule) => [rule.id, rule]));
const index = featureIndex(rules);
const matchesStock = (text) => STOCK_GUIDANCE.some(({ pattern }) => pattern.test(text));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Runs `fn` with console.log quiet (applyRules reports each rule it applies). */
function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

/**
 * Applies rule `id` to `source` written at its file; returns { out, failures }.
 * `audited`: `source` stands in for an audited upstream file from before the code
 * an addedAfter edit expects; `shipped`, for one of the audited files a
 * shippedOnlyIn edit's code is in (its digest replaces the rule's own).
 */
function apply(id, source, { audited = false, shipped = false } = {}) {
  const real = byId.get(id);
  const audit = (edit) => ({
    ...edit,
    ...(audited && edit.absentIn ? { absentIn: [sha256(source)] } : {}),
    ...(shipped && edit.onlyIn ? { onlyIn: [sha256(source)] } : {}),
  });
  const rule = { ...real, edits: real.edits.map(audit) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-strip-rules-"));
  try {
    fs.mkdirSync(path.join(root, path.dirname(rule.file)), { recursive: true });
    fs.writeFileSync(path.join(root, rule.file), source);
    const failures = quiet(() => applyRules(root, [rule]));
    return { out: fs.readFileSync(path.join(root, rule.file), "utf8"), failures };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const applies = (id, source, options) => {
  const { out, failures } = apply(id, source, options);
  assert.deepEqual(failures.map((failure) => failure.message), [], `${id} should apply`);
  return out;
};
const drifts = (id, source, pattern, options) => {
  const { failures } = apply(id, source, options);
  assert.equal(failures.length, 1, `${id} should stop`);
  if (pattern) assert.match(failures[0].message, pattern);
};

// ----------------------------------------------------- provider version check --

const RESOLVER_HEAD = 'import * as HttpClientRequest from "effect/http/HttpClientRequest";\n';
/** Every other anchor of provider/updates-minimum-age, unchanged since 3917. */
const RESOLVER_COMMON =
  "const LATEST_VERSION_TIMEOUT_MS = 4_000;\n" +
  "        `--allow-scripts=${packageName}`,\n" +
  'updateArgs: ["add", "-g", ...allowBuild, `${packageName}@latest`],\n' +
  '["outdated", "-g", "--reporter=silent", "--format", "json", packageName],\n' +
  '  const update = capabilities.update;\n  if (update?.lockKey !== "pnpm-global" || latestVersion === null) return update;\n' +
  "  if (!/^\\d+\\.\\d+\\.\\d+$/.test(version)) return null;\n" +
  "    !/^(?:npm-global:|bun-global$|pnpm-global$|vite-plus-global$|yarn-global$|volta$)/.test(\n" +
  ["vp", "bun", "yarn", "volta"]
    .map(
      (exe) =>
        `    return makeProviderMaintenanceCapabilities({\n      provider: definition.provider,\n      packageName,\n      updateExecutable: "${exe}",\n      updateArgs: ${{ vp: '["i", "-g", packageName]', bun: '["i", "-g", `${packageName}@latest`]', yarn: '["global", "add", `${packageName}@latest`]', volta: '["install", `${packageName}@latest`]' }[exe]},\n      updateLockKey: "${{ vp: "vite-plus-global", bun: "bun-global", yarn: "yarn-global", volta: "volta" }[exe]}",\n    });\n`,
    )
    .join("") +
  "function manualUpdateMessage(latestVersion: string, installPath: string | undefined): string {\n" +
  "          ? manualUpdateMessage(input.latestVersion, input.capabilities.installPath)\n" +
  "    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,\n";

const FETCH_3940 =
  "  const httpResponse = response.value;\n" +
  "  const payload = yield* httpResponse.json.pipe(\n" +
  "    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),\n" +
  "    Effect.orElseSucceed(() => null),\n" +
  "  );\n" +
  "  return payload ? nonEmptyString(payload.version) : null;\n";
const FETCH_3956 =
  "  // The deadline covers the body too: headers can arrive before the JSON stalls.\n" +
  "  const payload = yield* client.execute(request).pipe(\n" +
  "    Effect.flatMap(HttpClientResponse.filterStatusOk),\n" +
  "    Effect.flatMap(HttpClientResponse.schemaBodyJson(NpmLatestVersionResponse)),\n" +
  "    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),\n" +
  "    Effect.orElseSucceed(() => Option.none()),\n" +
  "  );\n" +
  "  return Option.isSome(payload) ? nonEmptyString(payload.value.version) : null;\n";
const NPM_VIEW_3956 =
  "const withConfiguredNpmVersionLookup = Effect.fn(\"withConfiguredNpmVersionLookup\")(function* (\n" +
  "  const lookup = runProbe(\n    npmPath,\n    [\n      \"view\",\n      \"--global\",\n      \"--json\",\n      `${packageName}@latest`,\n      \"version\",\n    ],\n" +
  "  return yield* resolver.resolve({ binaryPath });\n" +
  "}, Effect.flatMap(withConfiguredNpmVersionLookup));\n";

test("the provider check reads the full document at 3940 and at 3956, and keeps to 3 days", () => {
  const old = applies("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3940, { audited: true });
  assert.match(old, /return yield\* httpResponse\.json\.pipe\(\n {4}Effect\.timeoutOption\(LATEST_VERSION_TIMEOUT_MS\),\n {4}Effect\.map\(\(document\) => \(Option\.isSome\(document\) \? newestSettledVersion\(document\.value\) : null\)\),/);
  assert.doesNotMatch(old, /NpmLatestVersionResponse|nonEmptyString\(payload/);
  const next = applies("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3956 + NPM_VIEW_3956);
  assert.match(next, /Effect\.flatMap\(HttpClientResponse\.filterStatusOk\),\n {4}Effect\.flatMap\(\(response\) => response\.json\),\n {4}Effect\.timeoutOption\(LATEST_VERSION_TIMEOUT_MS\),/);
  assert.match(next, /return Option\.isSome\(payload\) \? newestSettledVersion\(payload\.value\) : null;/);
  assert.doesNotMatch(next, /schemaBodyJson|payload\.value\.version/);
  for (const out of [old, next]) {
    assert.match(out, /`https:\/\/registry\.npmjs\.org\/\$\{encodeURIComponent\(packageName\)\}`,/, "the full document, not /latest");
    assert.match(out, /LATEST_VERSION_TIMEOUT_MS = 30_000/);
  }
  // Both shapes at once, or neither, is drift.
  drifts("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3940 + FETCH_3956, /found 2/);
  drifts("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON, /found 0/);
});

test("3956's `npm view <package>@latest` lookup never replaces the 3-day check", () => {
  const out = applies("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3956 + NPM_VIEW_3956);
  assert.match(out, /return yield\* resolver\.resolve\(\{ binaryPath \}\);\n\}\);\n/);
  assert.doesNotMatch(out, /Effect\.flatMap\(withConfiguredNpmVersionLookup\)/);
  // npm view still in the file, but wired in some other way: stop, don't guess.
  const rewired = NPM_VIEW_3956.replace("}, Effect.flatMap(withConfiguredNpmVersionLookup));\n", "}, Effect.flatMap(withNpmLookup));\n");
  drifts("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3956 + rewired, /found 0/);
  // Before 3956 there is no npm view in the file, and nothing to cut: in an audited file only.
  assert.doesNotMatch(applies("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3940, { audited: true }), /"view"/);
  drifts("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3940, /found 0 \(and this file is none of the audited upstream versions/);
  // Renamed: the wrapper and its quoting changed, the lookup kept. Drift, not "not added yet".
  const renamed = NPM_VIEW_3956.replaceAll("withConfiguredNpmVersionLookup", "withNpmVersionLookup").replace('"view",', "'view',");
  drifts("provider/updates-minimum-age", RESOLVER_HEAD + RESOLVER_COMMON + FETCH_3956 + renamed, /withConfiguredNpmVersionLookup[\s\S]*found 0/);
});

// ---------------------------------------------------------- npm release lookups --

const WEB_3940 =
  "      const response = yield* HttpClient.get(\n        `https://registry.npmjs.org/t3/${encodeURIComponent(spec)}`,\n      );\n";
const WEB_3956 =
  "function unsupportedLookup(config: ServerConfig | null): ServerNpmReleaseError | null {\n" +
  "  if (config === null) {\n" +
  '    return new ServerNpmReleaseError({ reason: "Connect to this server to check releases." });\n' +
  "  }\n" +
  "  return config.environment.capabilities.npmReleaseLookup === true\n" +
  "    ? null\n" +
  "    : new ServerNpmReleaseError({\n" +
  '        reason: "This server does not support registry lookups. Update it before switching tracks.",\n' +
  "      });\n" +
  "}\n";

test("the web never looks up T3's npm releases, itself (3940) or through a server (3956)", () => {
  assert.match(applies("web/no-npm-release-poll", WEB_3940), /HttpClient\.get\(\n {8}"data:application\/json,\{\}",/);
  assert.match(applies("web/no-npm-release-poll", WEB_3940.replace("(spec)", "(version)")), /"data:application\/json,\{\}"/);
  const next = applies("web/no-npm-release-poll", WEB_3956);
  assert.match(next, /return new ServerNpmReleaseError\(\{ reason: "blacksand-t3 doesn't look up releases on npm: .*`blacksand t3 update --channel nightly`/);
  assert.doesNotMatch(next, /npmReleaseLookup === true/);
  drifts("web/no-npm-release-poll", WEB_3940 + WEB_3956, /found 2/);
  drifts("web/no-npm-release-poll", "export const npmReleaseAtom = 1;\n", /found 0/);
});

const WS_3940 =
  'import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";\n' +
  "        [WS_METHODS.serverUpdateServer]: (input) => serverSelfUpdate.update(input),\n" +
  "export const layer = Layer.unwrap(\n  Effect.gen(function* () {\n    return HttpRouter.add();\n  }),\n);\n";
const WS_3956 =
  'import * as NpmRelease from "./cloud/npmRelease.ts";\n' +
  "      const npmRelease = yield* NpmRelease.NpmRelease;\n" +
  "        [WS_METHODS.serverGetNpmRelease]: (input) => npmRelease.get(input),\n" +
  "export const layer = Layer.unwrap(\n  Effect.gen(function* () {\n    return HttpRouter.add();\n  }),\n).pipe(Layer.provide(NpmRelease.layer));\n";

test("the server answers every npm release lookup itself, never with npm or the registry (3956)", () => {
  assert.equal(applies("server/no-npm-release-lookup", WS_3940, { audited: true }), WS_3940, "an audited file from before 3956 has no lookup, and nothing changes");
  drifts("server/no-npm-release-lookup", WS_3940, /none of the audited upstream versions/);
  const next = applies("server/no-npm-release-lookup", WS_3956);
  assert.match(next, /import \* as NpmRelease from "\.\/cloud\/npmRelease\.ts";\nimport \{ ServerNpmReleaseError as BlacksandNpmReleaseError \} from "@t3tools\/contracts";\n/);
  assert.match(next, /Layer\.succeed\(\n {6}NpmRelease\.NpmRelease,\n {6}NpmRelease\.NpmRelease\.of\(\{\n {8}get: \(\) => Effect\.fail\(new BlacksandNpmReleaseError\(\{ reason: "blacksand-t3 doesn't look up releases on npm/);
  assert.doesNotMatch(next, /Layer\.provide\(NpmRelease\.layer\)/);
  // The RPC method still served, the service renamed or provided elsewhere: stop.
  drifts("server/no-npm-release-lookup", WS_3940 + "        [WS_METHODS.serverGetNpmRelease]: (input) => releases.get(input),\n", /found 0/);
  drifts("server/no-npm-release-lookup", WS_3956.replace(").pipe(Layer.provide(NpmRelease.layer));\n", ");\n"), /found 0/);
  drifts("server/no-npm-release-lookup", WS_3956 + ").pipe(Layer.provide(NpmRelease.layer));\n", /found 2/);
  // Renamed: the service and its RPC method, the registry layer kept.
  drifts("server/no-npm-release-lookup", WS_3956.replaceAll("NpmRelease", "ReleaseLookup").replaceAll("serverGetNpmRelease", "serverGetRelease"), /found 0/);
  assert.equal(index.get("server/no-npm-release-lookup"), undefined, "strict");
  assert.ok(rules.findIndex((rule) => rule.id === "server/no-npm-release-lookup") > rules.findIndex((rule) => rule.id === "web/no-npm-release-poll"));
});

// ---------------------------------------------------------------- GitHub star --

const COMPOSER_3940 = 'import { type ChatMessage } from "../../types";\nimport { stackedThreadToast, toastManager } from "../ui/toast";\n          handleNewThreadInActiveProject();\n        }\n      }\n';
const COMPOSER_3956 =
  'import { type ChatMessage } from "../../types";\nimport { recordPromptSent } from "../GitHubStarPrompt";\nimport { stackedThreadToast, toastManager } from "../ui/toast";\n' +
  "          handleNewThreadInActiveProject();\n        }\n        void recordPromptSent(environmentId);\n      }\n";

test("no GitHub star prompt, and no automatic GitHub check of the server's account behind it (3956)", () => {
  assert.equal(applies("web/no-github-star-check", COMPOSER_3940, { audited: true }), COMPOSER_3940);
  drifts("web/no-github-star-check", COMPOSER_3940, /none of the audited upstream versions/);
  // Renamed: module and function, the trigger kept.
  drifts("web/no-github-star-check", COMPOSER_3956.replaceAll("GitHubStarPrompt", "ProjectSupportPrompt").replaceAll("recordPromptSent", "recordConversationSent"), /found 0/);
  const next = applies("web/no-github-star-check", COMPOSER_3956);
  assert.doesNotMatch(next, /recordPromptSent|GitHubStarPrompt/, "nothing imports the prompt, so none of it ships");
  drifts("web/no-github-star-check", COMPOSER_3956 + "        void recordPromptSent(environmentId);\n", /found 2/);
  drifts("web/no-github-star-check", COMPOSER_3956.replace("        void recordPromptSent(environmentId);\n", "        queueMicrotask(() => recordPromptSent(environmentId));\n"), /found 0/);
  assert.equal(index.get("web/no-github-star-check"), undefined, "strict");
});

// ------------------------------------------------------------------ onboarding --

const WIZARD_COMMON = '<CommandBlock command="npx t3 connect" className="mt-3" />\n<CommandBlock command="npx t3 pair" className="mt-2" />\n';
const WIZARD_3940 =
  WIZARD_COMMON +
  '              Start T3 Code first, or run <code className="font-mono">npx t3 serve</code>. Add{" "}\n' +
  '              <code className="font-mono">--tailscale</code> to use your tailnet.\n';
const WIZARD_3956 =
  WIZARD_COMMON +
  '              On the computer with your code, start T3 Code or run{" "}\n' +
  '              <code className="font-mono">npx t3 serve</code>, then run:\n' +
  '              On a tailnet, run <code className="font-mono">npx t3 pair --tailscale</code> instead.\n';

test("onboarding names blacksand-t3's t3 command at 3940 and 3956, tailnet pairing included", () => {
  for (const [source, tailnet] of [
    [WIZARD_3940, '<code className="font-mono">--tailscale</code> to pair over your tailnet once the host\'s admin has run{" "}'],
    [WIZARD_3956, 'On a tailnet, run <code className="font-mono">t3 pair --tailscale</code> instead, once the host\'s admin has run{" "}'],
  ]) {
    const out = applies("web/no-stock-commands-onboarding", source);
    assert.ok(!out.split("\n").some(matchesStock), out);
    assert.ok(out.includes(tailnet), out);
    assert.match(out, /<code className="font-mono">t3 serve<\/code> \(Settings → About installs the t3 command\)/);
    assert.match(out, /command="t3 connect"[\s\S]*command="t3 pair"/);
    // The Serve mapping is the admin's (scripts/add-phone-service.sh), never the agent account's.
    assert.match(out, /<code className="font-mono">sudo scripts\/add-phone-service\.sh<\/code> for this account \(blacksand-t3's phone service\)\./);
  }
  // A tailnet hint dropped, or worded some third way, stops the update.
  drifts("web/no-stock-commands-onboarding", WIZARD_3956.replace(/ {14}On a tailnet.*\n/, ""), /found 0/);
});

// ------------------------------------------------- t3 up and how devices pair --

const BINCLI_3956 =
  'import { pairCommand } from "./cli/pair.ts";\n' +
  '    Command.withDescription("Run the T3 Code server."),\n' +
  "      threadCommand,\n      serviceCommand,\n";
const BINCLI_3973 =
  'import { connectCommand, statusCommand, upCommand } from "./cli/up.ts";\n' +
  '    Command.withDescription(\n      "Run T3 Code in this terminal and open it in your browser. To use it from your other devices, run `t3 up`.",\n    ),\n' +
  "      threadCommand,\n      upCommand,\n      statusCommand,\n      serviceCommand,\n";
const SERVE_3973 =
  '    "Run T3 Code in this terminal without opening a browser, and print pairing details. The background service runs this. To set up access from your other devices, run `t3 up`.",\n';
const SERVICE_3973 =
  '  Command.withDescription(\n    "Install T3 Code as a background service for this user. `t3 up` also chooses how your other devices reach it.",\n  ),\n' +
  "        yield* Console.log(formatServiceChange(result));\n" +
  '        if (!result.previouslyInstalled) {\n          yield* Console.log("Run `t3 up` to choose how your other devices reach it.");\n        }\n';
const SERVICE_3956 = '  Command.withDescription("Install T3 Code as a background service for this user."),\n        yield* Console.log(formatServiceChange(result));\n';
const noT3Up = (text) => assert.doesNotMatch(text, /`t3 up\b|\bt3 up --|upCommand,|statusCommand,/);

test("3973's `t3 up` and `t3 status` leave the CLI, and nothing points to them", () => {
  const cli = applies("server/no-t3-up", BINCLI_3973);
  noT3Up(cli.replace('import { connectCommand, statusCommand, upCommand } from "./cli/up.ts";\n', ""));
  assert.match(cli, /Other Macs reach T3 Code \(blacksand\) over SSH[^"]*sudo scripts\/add-phone-service\.sh <agent account> --pair/);
  assert.equal(applies("server/no-t3-up", BINCLI_3956, { audited: true }), BINCLI_3956);
  drifts("server/no-t3-up", BINCLI_3956, /none of the audited upstream versions/);
  // Renamed, the commands are still registered: drift.
  drifts("server/no-t3-up", BINCLI_3973.replaceAll("upCommand", "setupCommand").replaceAll("statusCommand", "showCommand"), /found 0/);
  noT3Up(applies("server/no-t3-up-serve", SERVE_3973));
  noT3Up(applies("server/no-t3-up-service", SERVICE_3973 + SERVICE_TEXTS));
  assert.doesNotMatch(applies("server/no-t3-up-service", SERVICE_3956 + serviceTexts("const"), { audited: true }), /`t3 up\b/);
  drifts("server/no-t3-up-service", SERVICE_3973.replace("        if (!result.previouslyInstalled) {\n", "        if (result.previouslyInstalled === false) {\n") + SERVICE_TEXTS, /found 0/);
  for (const id of ["server/no-t3-up", "server/no-t3-up-serve", "server/no-t3-up-service"]) assert.equal(index.get(id), undefined, `${id} is strict`);
});

const PAIR_COMMON =
  "    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \\`tailscale serve --https=${String(this.servePort)} --bg <local-url>\\` by hand to see why.`;\n" +
  "    yield* ensureTailscaleServe({\n" +
  "      localPort: localTarget.localPort,\n" +
  "      servePort: input.servePort,\n" +
  "      ...(localTarget.localHost !== undefined ? { localHost: localTarget.localHost } : {}),\n" +
  "    }).pipe(\n" +
  "      Effect.mapError(\n" +
  "        (cause) => new TailscaleServeFailedError({ servePort: input.servePort, cause }),\n" +
  "      ),\n" +
  "    );\n" +
  '            "This URL works only from this machine\'s local network. From elsewhere, re-run with --tailscale or use T3 Connect.",\n';
const PAIR_3956 = PAIR_COMMON + '            "This URL is only reachable from this machine. Re-run with --tailscale, or restart the server with a reachable --host.",\n';
const PAIR_3973 = PAIR_COMMON + '            "This URL is only reachable from this machine. To reach it from your other devices, run `t3 up`, or re-run with --tailscale.",\n';

test("`t3 pair` points to SSH and the host's phone service, and never writes a Tailscale Serve mapping", () => {
  for (const source of [PAIR_3956, PAIR_3973]) {
    const out = applies("server/pair-blacksand-routes", source);
    noT3Up(out);
    assert.doesNotMatch(out, /T3 Connect|re-run with --tailscale|ensureTailscaleServe\(/);
    assert.match(out, /\n {4}yield\* new TailscaleServeFailedError\(\{ servePort: input\.servePort, cause: localTarget \}\);\n/);
    assert.match(out, /leaves Serve to the host's admin\. From the admin account, in the blacksand-t3 clone, run \\`sudo scripts\/add-phone-service\.sh <agent account> --https-port \$\{String\(this\.servePort\)\}\\`/);
    assert.equal((out.match(/sudo scripts\/add-phone-service\.sh <agent account> --pair/g) ?? []).length, 2, "both notes name the phone service");
  }
  drifts("server/pair-blacksand-routes", PAIR_3956.replace("    yield* ensureTailscaleServe({\n", "    yield* configureServe({\n"), /found 0/);
  assert.equal(index.get("server/pair-blacksand-routes"), undefined, "strict");
});

// --------------------------------------------- upstream's background service --

/** service.ts's texts and reconcileService, declared `const` up to 3969 and `export const` since 3973. */
const serviceTexts = (declare) =>
  `${declare} reconcileService = Effect.fn("cli.service.reconcile")(function* (options?: {\n  readonly allowDowngrade?: boolean;\n  readonly start?: boolean;\n}) {\n` +
  '    return "T3 Code service\\n  Status: not installed\\n  Next: Run `t3 service install`.";\n' +
  "      `  Next: Run \\`t3 update ${installedVersion}\\` to match it, or pass \\`--allow-downgrade\\` to \\`t3 service install\\` explicitly.`,\n" +
  '    ...(status.current ? [] : ["  Next: Run `t3 service install` to repair it."]),\n' +
  '          "`t3 service update` is deprecated: run `t3 update` to move to a newer release, or `t3 service install` to repair the service. Repairing now.",\n';
const SERVICE_TEXTS = serviceTexts("export const");
const SERVICE_CLI_3940 = '  Command.withDescription("Install T3 Code as a background service for this user."),\n        yield* Console.log(formatServiceChange(result));\n' + serviceTexts("const");
const SERVICE_CLI_3956 = SERVICE_CLI_3940 + '      "Not a terminal, so background setup was skipped. Run `t3 service install` to set it up.",\n';
const SERVICE_CLI_3977 = SERVICE_3973 + SERVICE_TEXTS;
const BOOT_SERVICE =
  '    return "Could not set up the T3 Code background service.";\n' +
  "  }) {\n    const manager = yield* requireManager;\n    yield* fs\n      .makeDirectory(input.logsDir, { recursive: true })\n" +
  '      return "The service is not enabled to start automatically. Run `t3 service install` to repair it.";\n' +
  '      return "The service is not running. Check the service log and `systemctl --user status t3code.service`, then run `t3 service install`.";\n';
const serviceGuidance = (text) => STOCK_GUIDANCE.find(({ label }) => label === "t3 service install").pattern.test(text);

test("`t3 service install` and its repair route say what blacksand-t3 does instead, and the install itself is refused", () => {
  // The guidance pattern: the service's install and repair, not its removal or restart.
  for (const text of ["run `t3 service install`", "~/.local/bin/t3 service install", "`t3 service update` repairs"]) assert.ok(serviceGuidance(text), text);
  for (const text of ["remove it with `t3 service uninstall`", "`t3 service restart`", "`t3 service status`"]) assert.ok(!serviceGuidance(text), text);
  for (const [source, options] of [[SERVICE_CLI_3940, { audited: true }], [SERVICE_CLI_3956, { audited: true, shipped: true }], [SERVICE_CLI_3977, {}]]) {
    const out = applies("server/no-t3-up-service", source, options);
    assert.ok(!out.split("\n").some(serviceGuidance), out);
    assert.match(out, /Command\.withDescription\("Not in T3 Code \(blacksand\)\. blacksand-t3 sets up no background service\. Other Macs reach T3 Code \(blacksand\) over SSH/);
    assert.match(out, /Status: not installed\\n {2}blacksand-t3 sets up no background service\./);
    assert.equal((out.match(/blacksand-t3 sets up no background service, so remove this one with `t3 service uninstall`\./g) ?? []).length, 2, "the downgrade and repair hints");
    assert.match(out, /reconcileService = Effect\.fn\("cli\.service\.reconcile"\)\(function\* \(options\?: \{\n[^]*?\}\) \{\n {2}\/\/ blacksand: no background service[^\n]*\n {2}yield\* new BootService\.BootServiceInstallError\(\{ cause: "blacksand" \}\);\n/, "install and update stop before anything is written");
  }
  // 3956 and 3969's extra hint: once in exactly those files, nowhere else.
  drifts("server/no-t3-up-service", SERVICE_CLI_3956, /found 1 \(and this file is none of the audited upstream versions that have it\)/, { audited: true });
  const boot = applies("server/no-stock-service-install", BOOT_SERVICE);
  assert.ok(!boot.split("\n").some(serviceGuidance), boot);
  assert.match(boot, /\}\) \{\n {4}\/\/ blacksand: no background service[^\n]*\n {4}yield\* new BootServiceInstallError\(\{ cause: "blacksand" \}\);\n {4}const manager = yield\* requireManager;/, "refused before anything is set up or downloaded");
  assert.match(boot, /return this\.cause === "blacksand" \? "blacksand-t3 sets up no background service\. Other Macs/);
  assert.equal(index.get("server/no-stock-service-install"), undefined, "strict");
  const order = rules.map((rule) => rule.id);
  for (const id of ["server/no-stock-service-install", "server/no-t3-up-service"]) assert.ok(order.indexOf(id) < order.indexOf("stock/no-stock-guidance"));
});

test("the server never writes Tailscale Serve itself; `--tailscale-serve` says the admin does", () => {
  const server = applies("server/no-tailscale-serve-config", 'import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";\n        host: config.host ?? "127.0.0.1",\n              return yield* ensureTailscaleServe({\n');
  assert.match(server, /import \{ disableTailscaleServe, ensureTailscaleServe as upstreamEnsureTailscaleServe \} from "@t3tools\/tailscale";\n/);
  assert.match(server, /const ensureTailscaleServe = \(_input: Parameters<typeof upstreamEnsureTailscaleServe>\[0\]\) =>\n {2}Effect\.fail\(new Error\("blacksand-t3 leaves Tailscale Serve to the host's admin: [^"]*sudo scripts\/add-phone-service\.sh <agent account>[^"]*without --tailscale-serve\."\)\);\n/);
  assert.doesNotMatch(server.slice(server.indexOf("const ensureTailscaleServe")), /upstreamEnsureTailscaleServe\(/, "upstream's writer is never called");
  const flag = applies("server/no-tailscale-serve-flag", '    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",\n');
  assert.match(flag, /"Not in T3 Code \(blacksand\), which leaves Tailscale Serve to the host's admin \(`sudo scripts\/add-phone-service\.sh <agent account>`\)\.",/);
  for (const id of ["server/no-tailscale-serve-config", "server/no-tailscale-serve-flag"]) assert.equal(index.get(id), undefined, `${id} is strict`);
});

test("a shippedOnlyIn edit matches once in exactly its audited files, and nowhere else", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-strip-rules-"));
  try {
    const file = "src/a.ts";
    fs.mkdirSync(path.join(root, "src"));
    const run = (source, onlyIn) => {
      fs.writeFileSync(path.join(root, file), source);
      return quiet(() => applyRules(root, [{ id: "only", file, edits: [{ find: "hint();\n", replace: "", onlyIn }] }])).map((failure) => failure.message);
    };
    assert.deepEqual(run("hint();\n", [sha256("hint();\n")]), []);
    assert.deepEqual(run("other();\n", [sha256("hint();\n")]), [], "absent from a file that isn't one of them");
    assert.match(run("other();\nhint();\n", [sha256("hint();\n")])[0], /expected 0 match\(es\)[\s\S]*none of the audited upstream versions that have it/);
    assert.deepEqual(run("hint();\nmore();\n", [sha256("hint();\nmore();\n")]), []);
    assert.match(run("nothing();\n", [sha256("nothing();\n")])[0], /expected 1 match\(es\)/, "an audited file that lost it is drift");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------- audited upstream files --

test("an addedAfter edit skips only an audited upstream file, digested before any rule wrote it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-strip-rules-"));
  try {
    const file = "src/a.ts";
    const upstream = "export const a = 1;\n";
    fs.mkdirSync(path.join(root, "src"));
    const run = (rules, source = upstream) => {
      fs.writeFileSync(path.join(root, file), source);
      return quiet(() => applyRules(root, rules)).map((failure) => failure.message);
    };
    const earlier = { id: "earlier", file, edits: [{ find: "= 1", replace: "= 2" }] };
    const later = (absentIn) => ({ id: "later", file, edits: [{ find: "added();\n", replace: "", absentIn }] });
    // Its digest is upstream's file, though an earlier rule already changed it.
    assert.deepEqual(run([earlier, later([sha256(upstream)])]), []);
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), "export const a = 2;\n");
    // Any other file must have the code: here it doesn't.
    assert.match(run([earlier, later([sha256("something else\n")])])[0], /later: expected 1 match\(es\) of added\(\);\n in src\/a\.ts, found 0 \(and this file is none of the audited/);
    // An audited file that has the code after all is drift too: exactly 0 there.
    assert.match(run([later([sha256("added();\n")])], "added();\n")[0], /expected 0 match\(es\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every addedAfter edit names audited releases by tag and sha-256, and writes no stock guidance", () => {
  const audited = rules.flatMap((rule) => (rule.edits ?? []).filter((edit) => "absentIn" in edit).map((edit) => [rule.id, edit]));
  assert.deepEqual([...new Set(audited.map(([id]) => id))].sort(), ["provider/updates-minimum-age", "server/no-npm-release-lookup", "server/no-t3-up", "server/no-t3-up-service", "web/no-github-star-check"]);
  for (const [id, edit] of audited) {
    assert.equal(typeof edit.find, "string", id);
    assert.ok(Object.keys(edit.before).length > 0, id);
    for (const [release, digest] of Object.entries(edit.before)) {
      assert.match(release, /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/, `${id}: ${release}`);
      assert.match(digest, /^[0-9a-f]{64}$/, `${id}: ${release}`);
    }
    assert.deepEqual(edit.absentIn, [...new Set(Object.values(edit.before))], id);
    assert.ok(!edit.replace.split("\n").some(matchesStock), `${id} writes stock text: ${edit.replace}`);
  }
});

// ------------------------------------------------------- no stock T3 runtime --

const NO_RUNTIME = /blacksand-t3 runs only the build its own updater makes: update it with `~\/\.blacksand\/t3\/bin\/t3 update` on each Mac\. blacksand-t3 sets up no background service, so remove this one with `t3 service uninstall`\./;
const PINNED_RUNTIME_3977 =
  "  override get message(): string {\n    return this.exitCode === undefined\n      ? `Pinned runtime install failed while ${this.step}.`\n      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;\n  }\n" +
  'const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (\n  input: PinnedRuntimeInstallInput,\n) {\n  const { fs } = input;\n  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version, input.platform);\n' +
  "  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([\n    fs.exists(paths.versionDir),\n";
const UPDATE_CLI_3977 =
  '  Command.withDescription(\n    "Download a newer t3 and switch this machine to it, including the background service when one is installed.",\n  ),\n' +
  "  Command.withHandler((flags) =>\n    Effect.gen(function* () {\n      const logLevel = yield* GlobalFlag.LogLevel;\n      const config = yield* resolveCliAuthConfig(flags, logLevel);\n      return yield* runUpdate({\n";
const SELF_UPDATE_TAIL = "\n    const unsafeCrossing = crossesTrackUnsafely(input);\n    if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);\n    const targetVersion = input.targetVersion.trim();\n";
const SELF_UPDATE_DESKTOP =
  '    if (capability === "desktop-managed") {\n      const unsafeCrossing = input.channel === undefined ? null : crossesTrackUnsafely(input);\n      if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);\n' +
  '      return yield* failWith(\n        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",\n      );\n    }\n    if (capability === null) {\n';
const SELF_UPDATE_STOCK = SELF_UPDATE_DESKTOP + '      return yield* failWith(\n        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",\n      );\n    }\n' + SELF_UPDATE_TAIL;
const SELF_UPDATE_HOST = SELF_UPDATE_DESKTOP + '      return { targetVersion: input.targetVersion, method: "blacksand-host" as const };\n    }\n' + SELF_UPDATE_TAIL;

test("the pinned-runtime installer refuses before its cache lookup, so no cached stock runtime runs", () => {
  const out = applies("server/no-stock-runtime", PINNED_RUNTIME_3977);
  const refusal = out.indexOf('  yield* new PinnedRuntimeInstallError({ step: "blacksand" });\n');
  assert.ok(refusal > 0, out);
  for (const later of ["const { fs } = input;", "pinnedRuntimePaths(", "fs.exists(paths.versionDir)"]) assert.ok(out.indexOf(later) > refusal, `${later} comes after the refusal`);
  assert.match(out, /if \(this\.step === "blacksand"\) return "blacksand-t3 runs only the build/);
  assert.match(JSON.parse(/return ("[^\n]*");\n/.exec(out)[1]), NO_RUNTIME);
  assert.match(out, /Pinned runtime install failed while \$\{this\.step\}\./, "its other failures read as before");
  drifts("server/no-stock-runtime", PINNED_RUNTIME_3977.replace("  const { fs } = input;\n", "  const { fs, path } = input;\n"), /found 0/);
  assert.equal(index.get("server/no-stock-runtime"), undefined, "strict");
});

test("`t3 update` says what blacksand-t3 does and is refused before it looks anything up", () => {
  const out = applies("server/no-stock-update-cli", UPDATE_CLI_3977);
  assert.match(out, /"Not in T3 Code \(blacksand\)\. blacksand-t3 runs only the build its own updater makes/);
  assert.doesNotMatch(out, /Download a newer t3/);
  const refusal = out.indexOf("      yield* new CliUpdateError({ reason: ");
  assert.ok(refusal > 0 && refusal < out.indexOf("resolveCliAuthConfig(") && refusal < out.indexOf("runUpdate("), out);
  for (const line of out.split("\n")) assert.ok(!matchesStock(line), `stock guidance: ${line}`);
  drifts("server/no-stock-update-cli", UPDATE_CLI_3977.replace("      return yield* runUpdate({\n", "      return yield* runUpdateCommand({\n"), /found 0/);
  assert.equal(index.get("server/no-stock-update-cli"), undefined, "strict");
});

test("a server's self-update never switches runtimes, with host-update-requests built in or left out", () => {
  for (const [shape, source] of [["host update built in", SELF_UPDATE_HOST], ["host update left out", SELF_UPDATE_STOCK]]) {
    const out = applies("server/no-stock-runtime-self-update", source);
    const refusal = out.indexOf("    yield* failWith(");
    assert.ok(refusal > 0 && refusal < out.indexOf("    const unsafeCrossing = crossesTrackUnsafely(input);\n"), `${shape}: refused before the boot-service switch`);
    assert.match(JSON.parse(/ {4}yield\* failWith\(("[^\n]*")\);\n/.exec(out)[1]), NO_RUNTIME, shape);
    assert.match(out, /This server is managed by the T3 Code desktop app/, `${shape}: the desktop app's own update stays`);
    for (const line of out.split("\n")) assert.ok(!matchesStock(line), `${shape}: stock guidance: ${line}`);
  }
  assert.match(applies("server/no-stock-runtime-self-update", SELF_UPDATE_HOST), /method: "blacksand-host" as const/, "the host build request stays");
  drifts("server/no-stock-runtime-self-update", SELF_UPDATE_HOST.replace("crossesTrackUnsafely(input);\n    if", "crossesTrackUnsafely(input, track);\n    if"), /found 0/);
  assert.equal(index.get("server/no-stock-runtime-self-update"), undefined, "strict");
  // It runs after host-update-requests, which rewrites the text the left-out shape expects.
  const order = rules.map((rule) => rule.id);
  assert.ok(order.indexOf("server/self-update-requests-host-build") < order.indexOf("server/no-stock-runtime-self-update"));
});

const SERVICE_LAUNCHER_3977 =
  "export class Launcher {\n  readonly #baseDir: string;\n  readonly #statePath: string;\n" +
  "  constructor(\n    baseDir: string,\n    state: ServiceState,\n    options: {\n      readonly environment?: Readonly<NodeJS.ProcessEnv>;\n    } = {},\n  ) {\n    this.#baseDir = baseDir;\n  }\n}\n\n" +
  "export async function main(): Promise<void> {\n  const baseDir = process.env.T3CODE_HOME?.trim();\n  const state = await readServiceState(statePath);\n  await new Launcher(baseDir, state, { environment }).run();\n}\n";

test("upstream's service launcher refuses before it reads the T3 home, and no Launcher can start or recover a cached runtime", () => {
  const out = applies("server/no-stock-service-launcher", SERVICE_LAUNCHER_3977);
  assert.match(JSON.parse(/function refuseStockRuntime\(\): void \{\n {2}throw new Error\(("[^\n]*")\);\n\}\n/.exec(out)[1]), NO_RUNTIME);
  assert.ok(out.indexOf("function refuseStockRuntime") < out.indexOf("export class Launcher {"), "declared before the class");
  assert.match(out, /export async function main\(\): Promise<void> \{\n {2}refuseStockRuntime\(\);\n {2}const baseDir = process\.env\.T3CODE_HOME/, "first in main, before T3CODE_HOME and the state");
  assert.match(out, /\) \{\n {4}refuseStockRuntime\(\);\n {4}this\.#baseDir = baseDir;/, "first in the constructor");
  assert.equal(out.match(/refuseStockRuntime\(\);/g).length, 2);
  for (const line of out.split("\n")) assert.ok(!matchesStock(line), `stock guidance: ${line}`);
  drifts("server/no-stock-service-launcher", SERVICE_LAUNCHER_3977.replace("export async function main(): Promise<void> {\n", "export async function main(options?: LauncherOptions): Promise<void> {\n"), /found 0/);
  drifts("server/no-stock-service-launcher", SERVICE_LAUNCHER_3977.replace("    this.#baseDir = baseDir;\n", "    this.#baseDir = NodePath.resolve(baseDir);\n"), /found 0/);
  assert.equal(index.get("server/no-stock-service-launcher"), undefined, "strict");
});

// ---------------------------------------------------- fail-open features too --

test("the update-track note and Update everything's host wait fit 3940 and 3956", () => {
  const dialog = (description) =>
    "  // npm dist-tags match the desktop channel names.\n  const release = useAtomValue(npmReleaseAtom(channel));\n  if (AsyncResult.isSuccess(release) && release.value !== null) {\n    return <SwitchPlan release={{ channel, ...release.value }} onClose={onClose} />;\n  }\n" +
    description;
  for (const description of [
    "            {AsyncResult.isFailure(release) || AsyncResult.isSuccess(release)\n              ? `Could not find the latest ${label} release on npm. Try again later.`\n              : \"Checking releases…\"}\n",
    "            {AsyncResult.isFailure(release)\n              ? npmReleaseFailureMessage(release.cause)\n              : AsyncResult.isSuccess(release)\n                ? `Could not find the latest ${label} release in this environment's npm registry.`\n                : \"Checking releases…\"}\n",
  ]) {
    const out = applies("web/update-track-pinned", dialog(description));
    assert.match(out, /pin\.json pins for each track[\s\S]*blacksand t3 update --channel \$\{channel === "nightly" \? "nightly" : "stable"\}/);
    assert.doesNotMatch(out, /npmReleaseAtom\(|release\.cause|Try again later/);
  }
  const wait3940 = '    if (\n      selfUpdate !== "desktop-managed" &&\n      (!releaseArchivesPublished ||\n';
  assert.match(applies("web/self-update-blacksand-host-no-npm-wait", wait3940), /selfUpdate !== "blacksand-host" &&\n {6}\(!releaseArchivesPublished/);
  const collector3956 = "  targetVersion: string,\n): {\n  readonly targets: ServerUpdateTarget[];\n  readonly skipped: SkippedMachine[];\n} {\n";
  assert.equal(applies("web/self-update-blacksand-host-no-npm-wait", collector3956), collector3956, "3956 waits for no registry: nothing to change");
  drifts("web/self-update-blacksand-host-no-npm-wait", collector3956.replace("  targetVersion: string,\n", "  targetVersion: string,\n  releaseArchivesPublished: boolean,\n"), /found 0/);
});

// ------------------------------------------------------------------- the helpers --

test("every shaped edit is text in, text out, and none writes stock T3 guidance", () => {
  const shaped = rules.flatMap((rule) => (rule.edits ?? []).filter((edit) => edit.alternatives).map((edit) => [rule.id, edit]));
  assert.ok(shaped.length >= 9, `${shaped.length} shaped edits`);
  for (const [id, edit] of shaped) {
    assert.ok(edit.find instanceof RegExp && !edit.find.flags.includes("m"), `${id}: ^ must mean the file's start`);
    for (const shape of edit.alternatives) {
      assert.equal(typeof shape.find, "string", id);
      assert.equal(typeof shape.replace, "string", id);
      assert.ok(!shape.replace.split("\n").some(matchesStock), `${id} writes stock text: ${shape.replace}`);
    }
  }
});

test("each ungated installer is manual with or without its provider environment, and changed commands stop", () => {
  const id = "provider/updates-minimum-age";
  for (const environment of ["", "      env: context.env,\n"]) {
    const common = RESOLVER_COMMON.replace(/(      updateLockKey: "(?:vite-plus-global|bun-global|yarn-global|volta)",\n)/g, `$1${environment}`);
    const source = RESOLVER_HEAD + common + FETCH_3956 + NPM_VIEW_3956;
    const out = applies(id, source);
    for (const label of ["Vite+", "bun", "yarn", "Volta"]) assert.ok(out.includes(`return blacksandUngatedInstall(manual, "${label}");`));
    assert.doesNotMatch(out, /updateExecutable: "(?:vp|bun|yarn|volta)"/);
    for (const executable of ["vp", "bun", "yarn", "volta"]) {
      drifts(id, source.replace(`updateExecutable: "${executable}"`, 'updateExecutable: "unknown"'));
    }
    drifts(id, source.replace('updateLockKey: "bun-global"', 'updateLockKey: "yarn-global"'));
    drifts(id, source.replace('updateArgs: ["install", `${packageName}@latest`]', 'updateArgs: ["install", "--new", `${packageName}@latest`]'));
    if (environment) drifts(id, source.replace("env: context.env,", "env: unknown.env,"));
    const bun = /    return makeProviderMaintenanceCapabilities\(\{\n      provider: definition\.provider,\n      packageName,\n      updateExecutable: "bun",[^]*?    \}\);\n/.exec(source)[0];
    drifts(id, source + bun);
    drifts(id, source.replace(bun, ""));
  }
});
