// Copied to apps/web/src/ in a stripped upstream checkout and run there
// (rules web/blacksand-interface-file, web/blacksand-interface-setting-search).
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const attributes = new Map<string, string>();

function stubDom(storage: Partial<Storage>) {
  vi.stubGlobal("document", { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } });
  vi.stubGlobal("window", { localStorage: storage, addEventListener: () => {} });
}

const load = () => import("./blacksandInterface");

describe("blacksand interface switches", () => {
  beforeEach(() => {
    attributes.clear();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads with every switch on when storage can't be read", async () => {
    stubDom({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const { BLACKSAND_INTERFACE_KEYS } = await load();
    for (const key of BLACKSAND_INTERFACE_KEYS) expect(attributes.get(`data-t3b-${key}`)).toBe("on");
  });
  it("switches in this window even when storage is full", async () => {
    stubDom({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    const { setBlacksandInterface } = await load();
    expect(() => setBlacksandInterface("selection", false)).not.toThrow();
    expect(attributes.get("data-t3b-selection")).toBe("off");
  });
  it("reads stored switches", async () => {
    stubDom({ getItem: (key: string) => (key === "blacksand:interface:stamp" ? "off" : null), setItem: () => {} });
    await load();
    expect(attributes.get("data-t3b-stamp")).toBe("off");
    expect(attributes.get("data-t3b-send")).toBe("on");
  });
  it("registers each switch with Settings search under its title", async () => {
    stubDom({ getItem: () => null });
    const { BLACKSAND_INTERFACE, BLACKSAND_INTERFACE_KEYS, BLACKSAND_INTERFACE_SEARCH_ITEMS } = await load();
    const { searchableSetting } = await import("./components/settings/settingsSearch");
    expect(BLACKSAND_INTERFACE_SEARCH_ITEMS.map((item) => item.id)).toEqual(BLACKSAND_INTERFACE_KEYS.map((key) => `blacksand-${key}`));
    for (const key of BLACKSAND_INTERFACE_KEYS) {
      expect(searchableSetting(`blacksand-${key}`)).toEqual({ id: `blacksand-${key}`, title: BLACKSAND_INTERFACE[key].title });
    }
  });
});
