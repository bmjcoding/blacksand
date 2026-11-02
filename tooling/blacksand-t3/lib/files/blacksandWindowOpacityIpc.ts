import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { applyWindowOpacity, authorizeOpacityWindow, supportsWindowOpacity } from "../../settings/blacksandWindowOpacity.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_BLACKSAND_WINDOW_OPACITY_CHANNEL, SET_BLACKSAND_WINDOW_OPACITY_CHANNEL } from "../channels.ts";

export const getBlacksandWindowOpacity = DesktopIpc.makeIpcMethod({
  channel: GET_BLACKSAND_WINDOW_OPACITY_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.Number),
  handler: Effect.fn("desktop.ipc.getWindowOpacity")(function* (_, event) {
    const windows = yield* ElectronWindow.ElectronWindow;
    const window = Option.getOrNull(yield* windows.main);
    yield* Effect.sync(() => authorizeOpacityWindow(window, event));
    if (!supportsWindowOpacity(yield* HostProcess.Platform)) return null;
    return (yield* (yield* DesktopAppSettings.DesktopAppSettings).get).windowOpacity;
  }),
});
export const setBlacksandWindowOpacity = DesktopIpc.makeIpcMethod({
  channel: SET_BLACKSAND_WINDOW_OPACITY_CHANNEL,
  payload: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 100 })),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.setWindowOpacity")(function* (percent, event) {
    const windows = yield* ElectronWindow.ElectronWindow;
    const window = Option.getOrNull(yield* windows.main);
    const platform = yield* HostProcess.Platform;
    // Keep the narrowed window inside the synchronous boundary; never let a
    // caller select another window, a guest, a subframe or all windows.
    yield* Effect.sync(() => {
      authorizeOpacityWindow(window, event);
      if (!supportsWindowOpacity(platform)) throw new Error("Window opacity is unavailable on this platform");
      applyWindowOpacity(window, percent);
    });
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    yield* settings.setWindowOpacity(percent);
  }),
});
