// Native whole-window opacity. No CSS surface or renderer-selected window ids.
export const DEFAULT_WINDOW_OPACITY = 100;
export const MIN_WINDOW_OPACITY = 50;
export function validWindowOpacity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_WINDOW_OPACITY && value <= 100;
}
export const storedWindowOpacity = (value: unknown): number => validWindowOpacity(value) ? value : DEFAULT_WINDOW_OPACITY;
export const supportsWindowOpacity = (platform: string): boolean => platform === "darwin" || platform === "win32";
interface OpacityWindow {
  isDestroyed(): boolean;
  setOpacity(value: number): void;
  readonly webContents: { readonly id: number; readonly mainFrame: unknown };
}
/** Upstream's current main window, plus strict main-frame authorization. */
export function authorizeOpacityWindow(window: OpacityWindow | null, event: unknown): asserts window is OpacityWindow {
  const caller = event as { sender?: { id?: unknown }; senderFrame?: unknown } | undefined;
  if (!window || window.isDestroyed() || caller?.sender?.id !== window.webContents.id ||
      !caller?.senderFrame || caller.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Window opacity requires the app's main frame");
  }
}
export function applyWindowOpacity(window: Pick<OpacityWindow, "setOpacity">, percent: unknown): void {
  if (!validWindowOpacity(percent)) throw new Error("Window opacity must be an integer from 50 to 100");
  window.setOpacity(percent / 100);
}
