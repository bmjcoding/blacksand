// Copied to apps/server/src/ in a stripped upstream checkout and run there
// (rules server/no-t3-up, server/no-t3-up-serve, server/no-t3-up-service, server/pair-blacksand-routes,
// server/no-stock-service-install, server/no-tailscale-serve-flag, server/no-stock-runtime,
// server/no-stock-update-cli, server/no-stock-service-launcher).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeCli } from "./binCli.ts";
import { TailscaleServeFailedError } from "./cli/pair.ts";
import { BootServiceInstallError } from "./cloud/bootService.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimeVersionsDir } from "./cloud/pinnedRuntime.ts";
import { Launcher, main as runServiceLauncher } from "./serviceLauncher.ts";

afterEach(() => vi.restoreAllMocks());

/** What `t3 <args>` prints (help included), with the message of the error it fails with, if any. */
async function cli(args: ReadonlyArray<string>): Promise<string> {
  const printed: Array<string> = [];
  for (const method of ["log", "info", "error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: Array<unknown>) => {
      printed.push(parts.map(String).join(" "));
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  }
  const exit = await Effect.runPromise(
    Command.runWith(makeCli({ cloudEnabled: false }), { version: "0.0.0" })(args).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
      Effect.exit,
    ),
  );
  // What a command's handler leaves running (the service launcher's promise) reports first.
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    printed.push(error instanceof Error ? error.message : String(error));
  }
  return printed.join("\n");
}

describe("blacksand CLI routes", () => {
  it("never offers `t3 up` or `t3 status` (upstream's service, T3 Connect and LAN setup)", async () => {
    for (const args of [["--help"], ["serve", "--help"], ["service", "install", "--help"], ["pair", "--help"]]) {
      const help = await cli(args);
      expect(help.length, args.join(" ")).toBeGreaterThan(0);
      expect(help, args.join(" ")).not.toMatch(/`t3 up\b|\bt3 up --|t3 status/);
    }
    const root = await cli(["--help"]);
    expect(root).not.toMatch(/^\s*up\b/m);
    expect(root).not.toMatch(/^\s*status\b/m);
    expect(root).toMatch(/^\s*pair\b/m);
  });

  it("never offers upstream's background service: its install is refused, saying what Blacksand T3 does", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-service-"));
    try {
      for (const args of [["service", "--help"], ["service", "install", "--help"], ["service", "status", "--base-dir", baseDir]]) {
        const out = await cli(args);
        expect(out.length, args.join(" ")).toBeGreaterThan(0);
        // Its own usage line names it; nothing may recommend it.
        const recommends = out.split("\n").filter((line) => /\bt3 service (?:install|update)\b/.test(line) && !/^t3 service (?:install|update)(?:\s|$)/.test(line.trim()));
        expect(recommends, args.join(" ")).toEqual([]);
      }
      expect(await cli(["service", "status", "--base-dir", baseDir])).toMatch(/Blacksand T3 sets up no background service/);
      // The install fails before it sets up or downloads anything.
      const install = await cli(["service", "install", "--base-dir", baseDir]);
      expect(install).toMatch(/Blacksand T3 sets up no background service\. Other Macs reach Blacksand T3 over SSH/);
      expect(NodeFS.readdirSync(baseDir).filter((name) => /runtime|service/.test(name))).toEqual([]);
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    expect(new BootServiceInstallError({ cause: "blacksand" }).message).toMatch(/^Blacksand T3 sets up no background service\./);
    expect(new BootServiceInstallError({ cause: new Error("disk full") }).message).toBe("Could not set up the T3 Code (blacksand) background service.");
  });

  it("never runs or installs a T3 runtime, a cached stock one included (`t3 update`, a server's self-update)", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-runtime-"));
    try {
      // A T3 home with a complete cached runtime, as a stock install leaves one.
      const versionDir = NodePath.join(pinnedRuntimeVersionsDir(NodePath as never, baseDir), "1.2.3");
      const ran = NodePath.join(baseDir, "ran");
      NodeFS.mkdirSync(versionDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(versionDir, "t3"), `#!/bin/sh\necho ran > '${ran}'\necho 1.2.3\n`, { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(versionDir, ".install-complete"), "1.2.3\n");
      const help = await cli(["update", "--help"]);
      expect(help).toMatch(/Not in Blacksand T3\. Blacksand T3 runs only the build its own updater makes/);
      const update = await cli(["update", "1.2.3", "--yes", "--base-dir", baseDir]);
      expect(update).toMatch(/Blacksand T3 runs only the build its own updater makes: update it with `~\/\.blacksand\/t3\/bin\/t3 update`/);
      expect(update).not.toMatch(/Installed T3/);
      // The installer itself, as a managed server's self-update calls it: refused before its cache.
      let validated = false;
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          return yield* ensurePinnedRuntimeInstalled({
            baseDir,
            version: "1.2.3",
            fs,
            path,
            platform: process.platform,
            validate: () => Effect.sync(() => (validated = true)),
          } as never);
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String((Cause.squash(exit.cause) as Error).message)).toMatch(/^Blacksand T3 runs only the build its own updater makes/);
      expect(validated).toBe(false);
      expect(NodeFS.existsSync(ran)).toBe(false);
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("never runs upstream's service launcher: `t3 __service-launcher` and any Launcher refuse before a cached runtime starts or an update is recovered", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3b-launcher-"));
    const home = process.env.T3CODE_HOME;
    const exitCode = process.exitCode;
    try {
      // A T3 home a stock service left: two complete cached runtimes, the service's state
      // with an update to recover (active 1.2.3, trial 1.2.4), and the markers recovery clears first.
      const runtimeDir = NodePath.join(baseDir, "runtime");
      const ran = NodePath.join(baseDir, "ran");
      for (const version of ["1.2.3", "1.2.4"]) {
        const versionDir = NodePath.join(runtimeDir, "versions", version);
        NodeFS.mkdirSync(versionDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(versionDir, "t3"), `#!/bin/sh\necho ${version} >> '${ran}'\nexit 17\n`, { mode: 0o755 });
        NodeFS.writeFileSync(NodePath.join(versionDir, ".install-complete"), `${version}\n`);
      }
      const update = { id: "update-1", fromVersion: "1.2.3", targetVersion: "1.2.4", dbPath: NodePath.join(baseDir, "userdata", "state.sqlite"), status: "pending" as const };
      const state = { protocol: 3 as const, activeVersion: "1.2.3", update };
      const statePath = NodePath.join(runtimeDir, "service-state.json");
      NodeFS.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
      NodeFS.writeFileSync(NodePath.join(runtimeDir, ".restart-pending"), "1.2.3\n");
      NodeFS.writeFileSync(NodePath.join(runtimeDir, ".service-stopping"), "");
      const untouched = () => {
        expect(NodeFS.existsSync(ran)).toBe(false);
        expect(NodeFS.readFileSync(statePath, "utf8")).toBe(`${JSON.stringify(state)}\n`);
        expect(NodeFS.existsSync(NodePath.join(runtimeDir, ".restart-pending"))).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(runtimeDir, ".service-stopping"))).toBe(true);
        expect(NodeFS.readdirSync(baseDir).sort()).toEqual(["runtime"]);
      };
      process.env.T3CODE_HOME = baseDir;
      // The hidden command a stock service's unit runs.
      const out = await cli(["__service-launcher"]);
      expect(out).toMatch(/\[service-launcher\] Blacksand T3 runs only the build its own updater makes: update it with `~\/\.blacksand\/t3\/bin\/t3 update`/);
      expect(process.exitCode).toBe(1);
      untouched();
      // Its entry and the class, as anything else would use them, both with the update to recover.
      await expect(runServiceLauncher()).rejects.toThrow(/^Blacksand T3 runs only the build its own updater makes/);
      // The entry refuses before it reads anything: with no T3 home given, before upstream's own check.
      delete process.env.T3CODE_HOME;
      await expect(runServiceLauncher()).rejects.toThrow(/^Blacksand T3 runs only the build its own updater makes/);
      expect(() => new Launcher(baseDir, state)).toThrow(/^Blacksand T3 runs only the build its own updater makes/);
      expect(() => new Launcher(baseDir, { protocol: 3, activeVersion: "1.2.3" })).toThrow(/^Blacksand T3 runs only/);
      untouched();
    } finally {
      if (home === undefined) delete process.env.T3CODE_HOME;
      else process.env.T3CODE_HOME = home;
      process.exitCode = exitCode;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("has `--tailscale-serve` say the host's admin sets up Serve", async () => {
    const help = await cli(["serve", "--help"]);
    expect(help).toMatch(/--tailscale-serve[\s\S]*Not in Blacksand T3, which leaves Tailscale Serve to the host's admin/);
  });

  it("has `t3 pair --tailscale` leave Tailscale Serve to the host's admin", () => {
    const message = new TailscaleServeFailedError({ servePort: 443, cause: null }).message;
    expect(message).toContain("sudo scripts/add-phone-service.sh <agent account> --https-port 443");
    expect(message).not.toMatch(/tailscale serve --https/);
  });
});
