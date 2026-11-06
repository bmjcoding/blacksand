// Copied to apps/server/src/provider/ in a stripped upstream checkout and run there
// (rules provider/grok-autoupdater-off, provider/opencode-autoupdate-off,
// provider/claude-autoupdater-off, provider/muse-autoupdate-off): every Grok, OpenCode,
// Claude Code and Muse process T3
// starts has its CLI's background updater switched off, set after the environment it's
// given, so neither the host's env nor an instance's turns it back on. A spawner that
// records each command and then stops it stands in for the CLIs: nothing runs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import { makeGrokAcpRuntime, makeGrokTextGeneration } from "@t3tools/provider-grok/testing";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { mergeClaudeProcessEnvironment } from "./Drivers/ClaudeHome.ts";

type Spawned = { readonly command: string; readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv | undefined; readonly extendEnv: boolean | undefined };

/** Records every spawn, then stops it there. */
const recording = () => {
  const spawned: Array<Spawned> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const child = command as unknown as Omit<Spawned, "env" | "extendEnv"> & {
      readonly options: { readonly env?: NodeJS.ProcessEnv; readonly extendEnv?: boolean };
    };
    spawned.push({ command: child.command, args: child.args, env: child.options.env, extendEnv: child.options.extendEnv });
    return Effect.die("recorded, not run");
  });
  return { spawned, spawner };
};

const random = Layer.succeed(SecureRandom.SecureRandom, SecureRandom.make((size) => new Uint8Array(size)));
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

// Each case: the caller's env without the switch, and with it turned off.
const inputs = (name: string) => [{ PATH: "/usr/bin:/bin" }, { PATH: "/usr/bin:/bin", [name]: "0" }] as const;
const frozen = (env: NodeJS.ProcessEnv) => Object.freeze({ ...env });

it.layer(NodeServices.layer)("blacksand: no provider CLI updates itself in the background", (it) => {
  it.effect("every `grok agent stdio` runs with GROK_DISABLE_AUTOUPDATER=1: sessions and text generation", () =>
    Effect.gen(function* () {
      for (const input of inputs("GROK_DISABLE_AUTOUPDATER")) {
        const environment = frozen(input);
        const { spawned, spawner } = recording();
        // A session, as the adapter and the status probe start one.
        const session = yield* Effect.exit(
          makeGrokAcpRuntime({
            grokSettings: { binaryPath: "/opt/grok/bin/grok" },
            environment,
            cwd: "/tmp",
            clientInfo: { name: "t3-code", version: "0.0.0" },
            linuxCgroupController: null,
          }).pipe(Effect.scoped, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.provide(random)),
        );
        // Text generation.
        const textGeneration = yield* makeGrokTextGeneration(decodeGrokSettings({ binaryPath: "/opt/grok/bin/grok" }), environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(random),
        );
        const generated = yield* Effect.exit(
          textGeneration.generateCommitMessage({
            cwd: "/tmp",
            branch: "main",
            stagedSummary: "M a.ts",
            stagedPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-build"),
          }),
        );
        assert.ok(Exit.isFailure(session) && Exit.isFailure(generated));
        assert.strictEqual(spawned.length, 2, JSON.stringify(input));
        for (const call of spawned) {
          assert.includeMembers([...call.args], ["agent", "stdio"]);
          assert.strictEqual(call.env?.GROK_DISABLE_AUTOUPDATER, "1", JSON.stringify(input));
          assert.strictEqual(call.env?.PATH, "/usr/bin:/bin");
        }
        assert.deepStrictEqual(environment, input, "the caller's env is untouched");
      }
    }),
  );

  it.effect("every OpenCode process runs with OPENCODE_DISABLE_AUTOUPDATE=1: `opencode serve` and its version probe", () =>
    Effect.gen(function* () {
      for (const input of [undefined, ...inputs("OPENCODE_DISABLE_AUTOUPDATE")]) {
        const environment = input && frozen(input);
        const { spawned, spawner } = recording();
        const runtime = OpenCodeRuntime.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(OpenCodeServerLedger.layerTest),
        );
        const probe = yield* Effect.exit(
          Effect.flatMap(OpenCodeRuntime.OpenCodeRuntime, (opencode) =>
            opencode.runOpenCodeCommand({ binaryPath: "/opt/opencode/bin/opencode", args: ["--version"], ...(environment ? { environment } : {}) }),
          ).pipe(Effect.provide(runtime)),
        );
        const serve = yield* Effect.exit(
          Effect.flatMap(OpenCodeRuntime.OpenCodeRuntime, (opencode) =>
            opencode.startOpenCodeServerProcess({ binaryPath: "/opt/opencode/bin/opencode", directory: "/tmp", port: 4096, ...(environment ? { environment } : {}) }),
          ).pipe(Effect.scoped, Effect.provide(runtime)),
        );
        assert.ok(Exit.isFailure(probe) && Exit.isFailure(serve));
        assert.deepStrictEqual(spawned.map((call) => call.args[0]), ["--version", "serve"], JSON.stringify(input));
        for (const call of spawned) {
          assert.strictEqual(call.env?.OPENCODE_DISABLE_AUTOUPDATE, "1", JSON.stringify(input));
          // Upstream's inheritance is unchanged: the parent's env only when none is given.
          assert.strictEqual(call.extendEnv, input === undefined);
          if (input) assert.strictEqual(call.env?.PATH, "/usr/bin:/bin");
        }
        if (input) assert.deepStrictEqual(environment, input, "the caller's env is untouched");
      }
    }),
  );

  it.effect("every Claude Code process runs with DISABLE_AUTOUPDATER=1, whatever an instance's env says", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-claude-home-" });
      const host = frozen({ PATH: "/usr/bin:/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
      for (const instance of [
        undefined,
        [{ name: "DISABLE_AUTOUPDATER", value: "0", sensitive: false }],
        [
          { name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", value: "0", sensitive: false },
          { name: "DISABLE_AUTOUPDATER", value: "", sensitive: false },
        ],
      ]) {
        const env = yield* mergeClaudeProcessEnvironment({ homePath }, instance, host);
        assert.strictEqual(env.DISABLE_AUTOUPDATER, "1", JSON.stringify(instance));
        assert.strictEqual(env.PATH, "/usr/bin:/bin");
      }
      assert.deepStrictEqual(host, { PATH: "/usr/bin:/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    }).pipe(Effect.scoped),
  );

  // Muse's driver builds one environment for its status probe, sessions and text
  // generation, and upstream exports no way to build the driver here, so the line
  // that builds it is read: the switch comes after the instance's env is merged in.
  it("every Muse process runs with MUSE_NO_AUTO_UPDATE=1, whatever an instance's env says", () => {
    const driver = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "../../../../packages/provider-muse/src/server/driver.ts"), "utf8");
    assert.include(
      driver,
      "    const processEnvironment = {\n" +
        "      ...(yield* mergeProviderInstanceEnvironment(\n" +
        "        environment,\n        makeMuseEnvironment(hostEnvironment),\n      )),\n" +
        "      // blacksand: Muse never updates itself in the background (provider/muse-autoupdate-off).\n" +
        '      MUSE_NO_AUTO_UPDATE: "1",\n    };\n',
    );
    assert.strictEqual(driver.match(/const processEnvironment\b/g)?.length, 1, "one environment for every Muse process");
  });
});
