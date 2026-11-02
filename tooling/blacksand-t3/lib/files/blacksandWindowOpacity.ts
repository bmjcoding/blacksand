// The existing windowOpacity preference now controls only the main shell tint.
// Electron 44 macOS vibrancy supplies native behind-window blur; never fade the window.
export const DEFAULT_WINDOW_OPACITY = 100;
export const MIN_WINDOW_OPACITY = 50;
export function validWindowOpacity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_WINDOW_OPACITY && value <= 100;
}
export const storedWindowOpacity = (value: unknown): number => validWindowOpacity(value) ? value : DEFAULT_WINDOW_OPACITY;
export const supportsWindowOpacity = (platform: string): boolean => platform === "darwin";
interface OpacityWindow {
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number; readonly mainFrame: unknown };
}
/** Upstream's current main window, plus strict main-frame authorization. */
export function authorizeOpacityWindow(window: OpacityWindow | null, event: unknown): asserts window is OpacityWindow {
  const caller = event as { sender?: { id?: unknown }; senderFrame?: unknown } | undefined;
  if (!window || window.isDestroyed() || caller?.sender?.id !== window.webContents.id ||
      !caller?.senderFrame || caller.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Window background requires the app's main frame");
  }
}
/** Main window only. Vibrancy makes the compositor translucent without transparent:true. */
export function windowMaterialOptions(platform: string) {
  return supportsWindowOpacity(platform)
    ? { vibrancy: "under-window" as const, visualEffectState: "active" as const, backgroundColor: "#00000000" }
    : {};
}
