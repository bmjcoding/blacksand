// Copied to packages/provider-muse/src/server/ in a stripped upstream checkout and run there
// (rules provider/updates-exact-version, provider/muse-version-check-off): Muse's launcher
// can't install a specific version, so a Muse install gets no gated update, with its command
// and why; and since its channel publishes no release dates, its version check asks nothing.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  resolveLatestProviderUpdateAction,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { latestMuseVersion, museMaintenance } from "./maintenance.ts";

/** Fails the test on any request: nothing here may reach Muse's channel. */
const noRequests = HttpClient.make((request) => Effect.die(`asked ${request.url}`));

it.layer(NodeServices.layer)("blacksand: Muse gets no gated update", (it) => {
  it.effect("an official launcher gets no gated update, showing its command and why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3b-muse-" }));
      const launcher = `${dir}/muse`;
      // What museMaintenance checks to recognise the official launcher.
      yield* fs.writeFileString(launcher, "#!/bin/sh\n# muse-code/launcher-1\n: \"${MUSE_SYNC_UPDATE:-0}\"\n");
      yield* fs.chmod(launcher, 0o755);
      const left = yield* resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
        binaryPath: launcher,
        env: { PATH: "/usr/bin:/bin" },
      });
      const command = `MUSE_NO_AUTO_UPDATE=0 MUSE_SYNC_UPDATE=1 MUSE_UPDATE_INTERVAL_SECONDS=0 ${launcher} --version`;
      assert.strictEqual(left.update, null);
      assert.strictEqual(left.manualCommand, command);
      assert.strictEqual(
        left.manualReason,
        `T3 Code (blacksand) doesn't run \`${command}\` by itself: it can't install a specific version, so it can't keep to releases at least 3 days old. Use Update to latest to run it now.`,
      );
      // Its own version comparison stays, for the settings.
      assert.strictEqual(typeof left.compareVersions, "function");
      assert.strictEqual(resolveLatestProviderUpdateAction(left, "1.4.3-R5018.1"), null);
    }).pipe(Effect.scoped),
  );

  it.effect("the version check asks no channel and reports nothing", () =>
    Effect.gen(function* () {
      for (const environment of [{}, { MUSE_CHANNEL: "muse-stable" }, { MUSE_CHANNEL: "muse-canary" }]) {
        for (const options of [undefined, { fresh: true }]) {
          const version = yield* latestMuseVersion(environment, options).pipe(
            Effect.provideService(HttpClient.HttpClient, noRequests),
            Effect.provide(ProviderLatestVersions.layer),
          );
          assert.strictEqual(version, null);
        }
      }
    }),
  );
});
