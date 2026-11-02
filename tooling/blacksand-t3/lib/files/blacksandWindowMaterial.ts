// Only the authorized main renderer enables the scoped shell CSS. Keep theme and
// upstream Glass tokens intact: portals use those tokens independently.
export function applyWindowTint(percent: number | null): void {
  const html = document.documentElement;
  if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 50 || percent >= 100) {
    delete html.dataset.t3bWindowMaterial;
    html.style.removeProperty("--t3b-window-tint");
    return;
  }
  html.style.setProperty("--t3b-window-tint", `${percent}%`);
  html.dataset.t3bWindowMaterial = "on";
}

export async function loadWindowTint(): Promise<number | null> {
  try {
    const saved = await window.desktopBridge?.getBlacksandWindowOpacity?.();
    const percent = typeof saved === "number" && Number.isInteger(saved) && saved >= 50 && saved <= 100 ? saved : null;
    applyWindowTint(percent);
    return percent;
  } catch {
    applyWindowTint(null);
    return null;
  }
}
