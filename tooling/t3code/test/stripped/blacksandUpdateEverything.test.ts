// Copied to apps/web/src/components/sidebar/ in a stripped upstream checkout and run there
// (rules web/self-update-blacksand-host*, contracts/self-update-blacksand-host, web/no-stock-manual-update-command).
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { manualServerUpdateCommand, resolveServerSelfUpdateCapability } from "~/versionSkew";
import { collectServerUpdateTargets, type UpdateEverythingMachine } from "./updateEverything.logic";

function machine(id: string, capabilities: Record<string, unknown>): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.6-nightly.20261030.3917",
        capabilities: { repositoryIdentity: true, ...capabilities },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    } as never,
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
  };
}

// Up to 0.1.6-nightly.20261030.3940 the collector takes whether release archives are out and
// lists the servers that wait for npm; since 3956 it takes neither and nothing waits.
const collect = collectServerUpdateTargets as unknown as (
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
  releaseArchivesPublished: boolean,
) => ReturnType<typeof collectServerUpdateTargets> & { readonly waitForNpm?: ReadonlyArray<unknown> };

describe("blacksand host updates", () => {
  it("updates a host whose Blacksand T3 updater takes requests, without waiting for npm", () => {
    const { targets, skipped, waitForNpm } = collect(
      [machine("build-host", { blacksandHostUpdate: true }), machine("manual", {})],
      "0.1.6-nightly.20261031.4000",
      false,
    );
    expect(targets.map((target) => [target.serverLabel, target.selfUpdate])).toEqual([["build-host", "blacksand-host"]]);
    expect(waitForNpm ?? []).toEqual([]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([["manual", "needs a manual update"]]);
  });
  it("keeps upstream's capability when a server has one", () => {
    expect(resolveServerSelfUpdateCapability(machine("svc", { serverSelfUpdate: "boot-service", blacksandHostUpdate: true }).serverConfig)).toBe(
      "boot-service",
    );
    expect(resolveServerSelfUpdateCapability(machine("build-host", { blacksandHostUpdate: true }).serverConfig)).toBe("blacksand-host");
    expect(resolveServerSelfUpdateCapability(machine("x", {}).serverConfig)).toBeNull();
  });
  it("never offers stock T3 as the manual update", () => {
    for (const installation of [undefined, { kind: "npx" as const }, { kind: "npm-global" as const, prefix: "/usr/local" }]) {
      const command = manualServerUpdateCommand("0.1.6", installation);
      expect(command).toBe("~/.blacksand/t3/bin/t3 update");
      expect(command).not.toMatch(/\bt3@|npx|npm install/);
    }
  });
});
