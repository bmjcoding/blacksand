// Injected by blacksand. The Blacksand touches on top of whatever theme is
// selected, each a per-client switch in Settings -> Appearance -> Interface,
// on by default. Each is applied as data-t3b-<key>="on"|"off" on <html> for
// blacksand.css, and read by BlacksandBrand.tsx. main.tsx imports this, so the
// attributes are set before the first paint; the storage event keeps other
// windows in step. Storage is best-effort: when it's blocked or full, the
// switches still work for this window and start on.

import { useSyncExternalStore } from "react";

export const BLACKSAND_INTERFACE = {
  wordmark: {
    title: "T3 BLACKOUT logo",
    description: "The sidebar logo. Off shows upstream's.",
    searchTerms: "wordmark brand sidebar logo name",
  },
  art: {
    title: "Redaction art",
    description: "Redaction bars instead of the nightly starfield at the top of the sidebar.",
    searchTerms: "redacted bars starfield nightly sidebar background stage",
  },
  send: {
    title: "Send button ring",
    description: "A ringed send button in the theme's accent, and a glow around the chat box while you type.",
    searchTerms: "send button ring composer chat box glow accent",
  },
  glow: {
    title: "Button glow",
    description: "A ring and glow when you hover the sidebar footer, update and attach buttons.",
    searchTerms: "hover glow ring buttons sidebar footer update attach accent",
  },
  stamp: {
    title: "Version stamp",
    description: "The build version in the window's bottom-right corner, with what changed and a preview of a waiting update.",
    searchTerms: "version build stamp corner changes report preview update",
  },
  selection: {
    title: "Accent text selection",
    description: "Selected text highlights in the theme's accent instead of the system color.",
    searchTerms: "highlight selected text selection color accent",
  },
} as const;

export type BlacksandInterfaceKey = keyof typeof BLACKSAND_INTERFACE;
export const BLACKSAND_INTERFACE_KEYS = Object.keys(BLACKSAND_INTERFACE) as BlacksandInterfaceKey[];

/** The switch's Settings search id (settingsSearch.ts lists them; its row carries it). */
export const blacksandInterfaceSearchId = (key: BlacksandInterfaceKey) => `blacksand-${key}` as const;

/** Settings search entries for the switches, spread into upstream's registry. */
export const BLACKSAND_INTERFACE_SEARCH_ITEMS = BLACKSAND_INTERFACE_KEYS.map((key) => ({
  id: blacksandInterfaceSearchId(key),
  title: BLACKSAND_INTERFACE[key].title,
  to: "/settings/appearance" as const,
  searchTerms: [`t3 blacksand interface ${BLACKSAND_INTERFACE[key].searchTerms}`],
}));

const storageKey = (key: BlacksandInterfaceKey) => `blacksand:interface:${key}`;
const listeners = new Set<() => void>();

let current = Object.fromEntries(BLACKSAND_INTERFACE_KEYS.map((key) => [key, true])) as Record<
  BlacksandInterfaceKey,
  boolean
>;

/** The stored switch, or `fallback` when storage can't be read. */
function readStored(key: BlacksandInterfaceKey, fallback: boolean): boolean {
  try {
    return window.localStorage.getItem(storageKey(key)) !== "off";
  } catch {
    return fallback;
  }
}

const readAll = () =>
  Object.fromEntries(BLACKSAND_INTERFACE_KEYS.map((key) => [key, readStored(key, current[key])])) as typeof current;

function applyAll(next: Record<BlacksandInterfaceKey, boolean>) {
  current = next;
  for (const key of BLACKSAND_INTERFACE_KEYS) {
    document.documentElement.setAttribute(`data-t3b-${key}`, next[key] ? "on" : "off");
  }
  for (const listener of listeners) listener();
}

if (typeof document !== "undefined") {
  applyAll(readAll());
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith("blacksand:interface:")) applyAll(readAll());
  });
}

/** Switches `key` in this window at once; other windows follow when storage takes it. */
export function setBlacksandInterface(key: BlacksandInterfaceKey, on: boolean) {
  applyAll({ ...current, [key]: on });
  try {
    window.localStorage.setItem(storageKey(key), on ? "on" : "off");
  } catch {
    // Blocked or full: the change holds in this window until it reloads.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlacksandInterface(key: BlacksandInterfaceKey): boolean {
  return useSyncExternalStore(subscribe, () => current[key], () => true);
}
