// Copied to apps/desktop/src/ipc/methods/ in a stripped upstream checkout.
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { windowMaterialOptions } from "../../settings/blacksandWindowOpacity.ts";
import { getBlacksandWindowOpacity, setBlacksandWindowOpacity } from "./blacksandWindowOpacity.ts";
vi.mock("electron", () => ({}));

const mainFrame = {};
const native = { webContents: { id: 7, mainFrame }, isDestroyed: () => false, setOpacity: vi.fn() };
const event = { sender: { id: 7 }, senderFrame: mainFrame };
const run = <A, E, R>(effect: Effect.Effect<A, E, R>, platform: NodeJS.Platform = "darwin", main: Electron.BrowserWindow | null = native as unknown as Electron.BrowserWindow) => Effect.runPromise(effect.pipe(
  Effect.provide(DesktopAppSettings.layerTest()),
  Effect.provideService(ElectronWindow.ElectronWindow, { main: Effect.succeed(Option.fromNullishOr(main)) } as ElectronWindow.ElectronWindow["Service"]),
  Effect.provideService(HostProcess.Platform, platform),
) as Effect.Effect<A, E>);

describe("native window background tint IPC", () => {
  it("defaults to 100, persists tint and resets without fading foreground", async () => {
    native.setOpacity.mockClear();
    await run(Effect.gen(function* () {
      expect(yield* getBlacksandWindowOpacity.handler(undefined, event)).toBe(100);
      yield* setBlacksandWindowOpacity.handler(73, event);
      expect(yield* getBlacksandWindowOpacity.handler(undefined, event)).toBe(73);
      yield* setBlacksandWindowOpacity.handler(100, event);
      expect(yield* getBlacksandWindowOpacity.handler(undefined, event)).toBe(100);
    }));
    expect(native.setOpacity).not.toHaveBeenCalled();
  });
  it("rejects malformed, nonfinite and out-of-range payloads before any native call", async () => {
    native.setOpacity.mockClear();
    for (const input of [undefined, NaN, Infinity, -Infinity, 49, 101, 75.5, "75", null, {}, [], { percent: 75, windowId: 7 }]) {
      await expect(run(setBlacksandWindowOpacity.handler(input, event))).rejects.toBeDefined();
    }
    expect(native.setOpacity).not.toHaveBeenCalled();
    await run(Effect.gen(function* () {
      expect(yield* getBlacksandWindowOpacity.handler(undefined, event)).toBe(100);
    }));
  });
  it("rejects foreign contents, subframes and missing frame identity", async () => {
    native.setOpacity.mockClear();
    for (const caller of [{ sender: { id: 8 }, senderFrame: mainFrame }, { sender: { id: 7 }, senderFrame: {} }, { sender: { id: 7 } }, undefined]) {
      await expect(run(setBlacksandWindowOpacity.handler(80, caller))).rejects.toBeDefined();
      await expect(run(getBlacksandWindowOpacity.handler(undefined, caller))).rejects.toBeDefined();
    }
    expect(native.setOpacity).not.toHaveBeenCalled();
  });
  it("reports unsupported platforms without a native call", async () => {
    native.setOpacity.mockClear();
    for (const platform of ["linux", "win32"] as const) {
      expect(windowMaterialOptions(platform)).toEqual({});
      expect(await run(getBlacksandWindowOpacity.handler(undefined, event), platform)).toBeNull();
      await expect(run(setBlacksandWindowOpacity.handler(80, event), platform)).rejects.toBeDefined();
    }
    expect(native.setOpacity).not.toHaveBeenCalled();
  });
  it("refuses an absent or destroyed main window", async () => {
    await expect(run(getBlacksandWindowOpacity.handler(undefined, event), "darwin", null)).rejects.toBeDefined();
    await expect(run(setBlacksandWindowOpacity.handler(73, event), "darwin", null)).rejects.toBeDefined();
    using destroyed = vi.spyOn(native, "isDestroyed").mockReturnValue(true);
    await expect(run(getBlacksandWindowOpacity.handler(undefined, event))).rejects.toBeDefined();
    await expect(run(setBlacksandWindowOpacity.handler(73, event))).rejects.toBeDefined();
  });
});
