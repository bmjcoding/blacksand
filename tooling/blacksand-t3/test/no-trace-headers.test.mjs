// node --test: no outgoing HTTP request from the server, a `t3` command or the desktop
// app carries b3, traceparent or tracestate (rules server/no-trace-headers and
// desktop/no-trace-headers). The rules are applied to upstream's lines as they read at
// 0.1.7-nightly.20261102.4093 and 0.1.8-nightly.20261104.4179, the pin (identical in
// these lines). test/stripped/blacksandTraceHeaders.test.ts runs the server's setting in
// upstream's checkout, with Effect's real HTTP client.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeRules } from "../lib/rules.mjs";
import { applyRules } from "../lib/strip-engine.mjs";
import { featureIndex } from "../lib/features.mjs";

const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/blacksand/bin/t3", path: "/usr/bin" }, build: null });
const byId = (id) => rules.find((rule) => rule.id === id);
const SERVER = "server/no-trace-headers";
const DESKTOP = "desktop/no-trace-headers";

const BIN_CLI =
  'import * as NodeRuntime from "@effect/platform-node/NodeRuntime";\n' +
  'import * as NodeServices from "@effect/platform-node/NodeServices";\n' +
  'import * as Effect from "effect/Effect";\n' +
  'import * as Layer from "effect/Layer";\n' +
  'import { Argument, Command } from "effect/cli";\n' +
  "\n" +
  "export const cli = makeCli();\n" +
  "\n" +
  "export function runCli() {\n" +
  "  extendConnectionAttemptTimeout();\n" +
  "  keepOutboundFetchOnHttp1();\n" +
  "  Command.run(cli, { version: packageJson.version }).pipe(\n" +
  "    Effect.scoped,\n" +
  "    Effect.provide(layerCliRuntime),\n" +
  "    NodeRuntime.runMain,\n" +
  "  );\n" +
  "}\n";

const DESKTOP_MAIN =
  'import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";\n' +
  'import * as NodeRuntime from "@effect/platform-node/NodeRuntime";\n' +
  'import * as Effect from "effect/Effect";\n' +
  'import * as Layer from "effect/Layer";\n' +
  "\n" +
  "  Layer.provideMerge(NodeHttpClient.layerUndici),\n" +
  "\n" +
  "DesktopApp.program.pipe(Effect.provide(layerDesktopRuntime), NodeRuntime.runMain);\n";

/** Applies `ids` to `source` written at `file`: the failures, and the file after. */
function apply(ids, file, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trace-"));
  const log = console.log;
  try {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
    console.log = () => {};
    const failures = applyRules(root, ids.map(byId));
    return { failures: failures.map((failure) => failure.message), out: fs.readFileSync(path.join(root, file), "utf8") };
  } finally {
    console.log = log;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the server's root, runCli, runs the server and every t3 command with trace propagation off", () => {
  // With server/headless-telemetry-env, which edits the same function.
  const { failures, out } = apply(["server/headless-telemetry-env", SERVER], byId(SERVER).file, BIN_CLI);
  assert.deepEqual(failures, []);
  assert.equal(byId(SERVER).file, "apps/server/src/binCli.ts");
  assert.match(out, /^import \* as HttpClient from "effect\/http\/HttpClient";$/m);
  assert.match(out, /^export const blacksandWithoutTraceHeaders = Effect\.provideService\(HttpClient\.TracerPropagationEnabled, false\);$/m);
  // Outermost, after the layers are provided: it covers building them and everything they run.
  assert.match(out, /\n {4}Effect\.scoped,\n {4}Effect\.provide\(layerCliRuntime\),\n {4}blacksandWithoutTraceHeaders,\n {4}NodeRuntime\.runMain,\n {2}\);\n\}\n$/);
});

test("the desktop app's root runs with trace propagation off", () => {
  const { failures, out } = apply([DESKTOP], byId(DESKTOP).file, DESKTOP_MAIN);
  assert.deepEqual(failures, []);
  assert.equal(byId(DESKTOP).file, "apps/desktop/src/main.ts");
  assert.match(out, /^import \* as HttpClient from "effect\/http\/HttpClient";$/m);
  assert.match(
    out,
    /\nDesktopApp\.program\.pipe\(\n {2}Effect\.provide\(layerDesktopRuntime\),\n {2}\/\/ blacksand: .*\n {2}Effect\.provideService\(HttpClient\.TracerPropagationEnabled, false\),\n {2}NodeRuntime\.runMain,\n\);\n$/,
  );
});

test("the rules stop when upstream's code moves", () => {
  for (const [from, to] of [
    ['import * as Layer from "effect/Layer";\n', 'import { Layer } from "effect";\n'],
    ["export const cli = makeCli();\n", "export const cli = makeCli({});\n"],
    ["    Effect.provide(layerCliRuntime),\n    NodeRuntime.runMain,\n", "    Effect.provide(layerCliRuntime),\n    Effect.orDie,\n    NodeRuntime.runMain,\n"],
  ]) {
    assert.equal(apply([SERVER], byId(SERVER).file, BIN_CLI.replace(from, to)).failures.length, 1, to);
  }
  assert.equal(apply([SERVER], byId(SERVER).file, BIN_CLI + BIN_CLI).failures.length, 1);
  for (const [from, to] of [
    ['import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";\n', ""],
    ["DesktopApp.program.pipe(Effect.provide(layerDesktopRuntime), NodeRuntime.runMain);\n", "NodeRuntime.runMain(DesktopApp.program.pipe(Effect.provide(layerDesktopRuntime)));\n"],
  ]) {
    assert.equal(apply([DESKTOP], byId(DESKTOP).file, DESKTOP_MAIN.replace(from, to)).failures.length, 1, to);
  }
});

test("both rules are strict, and nothing else sets trace propagation", () => {
  const features = featureIndex(rules);
  for (const id of [SERVER, DESKTOP]) assert.equal(features.get(id), undefined, `${id} stays strict`);
  const setters = rules.filter((rule) => JSON.stringify(rule.edits ?? rule.content ?? "").includes("TracerPropagationEnabled")).map((rule) => rule.id);
  assert.deepEqual(setters.sort(), [DESKTOP, SERVER]);
});
