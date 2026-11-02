// Copied to apps/web/src/components/ in a stripped upstream checkout.
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../index.css";
import "../blacksand.css";
import { act, render, stubGlobal } from "../../test/render";
import { applyWindowTint, loadWindowTint } from "../blacksandWindowMaterial";
import { SidebarInset } from "./ui/sidebar";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { PreviewPanelShell } from "./preview/PreviewPanelShell";
import { DiffPanelShell } from "./DiffPanelShell";
import { AppRouteModal } from "./AppRouteModal";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { BlacksandWindowOpacitySettings } from "./settings/BlacksandWindowOpacitySettings";

function Shell() {
  return <AppSidebarLayout>
    <SidebarInset>
      <span data-tint-text>Chat text</span>
      <button className="bg-background" data-tint-control>Control</button>
      <PreviewPanelShell mode="sidebar"><DiffPanelShell mode="sidebar" header="Files">File list</DiffPanelShell></PreviewPanelShell>
    </SidebarInset>
  </AppSidebarLayout>;
}

const surface = (element: Element) => {
  const s = getComputedStyle(element);
  return { background: s.backgroundColor, color: s.color, opacity: s.opacity, filter: s.filter, backdrop: s.backdropFilter };
};
const alpha = (element: Element) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = getComputedStyle(element).backgroundColor;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
};
function assertForeground(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    expect(getComputedStyle(node).opacity).toBe("1");
    expect(getComputedStyle(node).filter).toBe("none");
  }
}

describe("native window material surface scope", () => {
  for (const dark of [false, true]) {
    for (const legacy of [false, true]) {
    it(`changes main base alpha, never foreground or real portal surfaces (${dark ? "dark" : "light"}, ${legacy ? "legacy sidebar opt-in" : "default sidebar"})`, async () => {
      await page.viewport(1280, 900);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.setProperty("--glass-opacity", "80%");
      applyWindowTint(100);
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, legacySidebarEnabled: legacy });
      try {
        await using screen = await render(<><Shell />
          <AppRouteModal label="Settings"><BlacksandWindowOpacitySettings /></AppRouteModal>
          <Dialog defaultOpen><DialogPopup><DialogTitle>Confirm</DialogTitle></DialogPopup></Dialog>
          <Menu defaultOpen><MenuTrigger>Actions</MenuTrigger><MenuPopup><MenuItem>Action</MenuItem></MenuPopup></Menu>
          <Popover defaultOpen><PopoverTrigger>Info</PopoverTrigger><PopoverPopup>Details</PopoverPopup></Popover>
        </>, { router: "/settings/appearance" });
        expect(document.documentElement.classList.contains("dark")).toBe(dark);
        const overlays = [...document.querySelectorAll('[data-slot="dialog-popup"], [data-slot="dialog-backdrop"], [data-slot="menu-popup"], [data-slot="popover-popup"]')];
        expect(overlays.length).toBeGreaterThanOrEqual(6);
        await vi.waitFor(() => overlays.forEach(node => expect(getComputedStyle(node).opacity).toBe("1")));
        const before = overlays.map(surface);
        const text = screen.container.querySelector("[data-tint-text]")!;
        const control = screen.container.querySelector("[data-tint-control]")!;
        const textBefore = surface(text), controlBefore = surface(control);
        const bases = [...screen.container.querySelectorAll(".t3b-window-clear")];
        expect(bases.length).toBeGreaterThanOrEqual(5);
        expect(alpha(screen.container.querySelector('[data-slot="sidebar-inset"]')!)).toBe(1);
        for (const percent of [73, 50]) {
          applyWindowTint(percent);
          expect(alpha(screen.container.querySelector("[data-t3b-window-shell]")!)).toBeCloseTo(percent / 100, 2);
          for (const base of bases) expect(alpha(base)).toBe(0);
          for (const node of [document.documentElement, document.body]) expect(alpha(node), `${node.tagName} style=${node.getAttribute("style")} bg=${getComputedStyle(node).backgroundColor}`).toBe(0);
          expect(overlays.map(surface)).toEqual(before);
          expect(surface(text)).toEqual(textBefore);
          expect(surface(control)).toEqual(controlBefore);
          assertForeground(text); assertForeground(control);
          for (const overlay of overlays) assertForeground(overlay);
          expect(document.documentElement.style.getPropertyValue("--glass-opacity")).toBe("80%");
        }
        // Upstream Glass continues changing its own surfaces independently.
        document.documentElement.style.setProperty("--glass-opacity", "60%");
        expect(surface(document.querySelector('[data-slot="menu-popup"]')!)).not.toEqual(before[overlays.findIndex(x => x.matches('[data-slot="menu-popup"]'))]);
        expect(alpha(screen.container.querySelector("[data-t3b-window-shell]")!)).toBeCloseTo(.5, 2);
        applyWindowTint(100);
        expect(alpha(screen.container.querySelector('[data-slot="sidebar-inset"]')!)).toBe(1);
      } finally {
        applyWindowTint(100);
        document.documentElement.classList.remove("dark");
        document.documentElement.style.removeProperty("--glass-opacity");
        __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
      }
    });
  }
  }
  it("restores on reload, updates live, resets and recovers a rejected save", async () => {
    let saved = 73;
    let reject = false;
    using _bridge = stubGlobal("desktopBridge", {
      getBlacksandWindowOpacity: async () => saved,
      setBlacksandWindowOpacity: vi.fn(async (value: number) => { if (reject) throw new Error("disk"); saved = value; }),
    });
    try {
      expect(await loadWindowTint()).toBe(73);
      expect(document.documentElement.style.getPropertyValue("--t3b-window-tint")).toBe("73%");
      await using screen = await render(<BlacksandWindowOpacitySettings />);
      const slider = screen.getByRole("slider", { name: "Window background tint" });
      await expect.element(slider).toHaveValue("73");
      await userEvent.click(slider);
      const input = screen.container.querySelector("input")!;
      const inputValue = (value: string) => act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await inputValue("64");
      await vi.waitFor(() => expect(saved).toBe(64));
      expect(document.documentElement.style.getPropertyValue("--t3b-window-tint")).toBe("64%");
      applyWindowTint(null);
      expect(await loadWindowTint()).toBe(64);
      await userEvent.click(screen.getByRole("button", { name: "Reset window background tint to default" }));
      await vi.waitFor(() => expect(saved).toBe(100));
      expect(document.documentElement.hasAttribute("data-t3b-window-material")).toBe(false);
      reject = true;
      await inputValue("61");
      await expect.element(slider).toHaveValue("100");
      expect(document.documentElement.hasAttribute("data-t3b-window-material")).toBe(false);
      await expect.element(screen.getByText("Window background tint could not be saved.")).toBeVisible();
    } finally { applyWindowTint(100); }
  });
  it("keeps unsupported and malformed capability responses opaque", async () => {
    for (const value of [null, undefined, 49, 101, 73.5, "73", NaN]) {
      using _bridge = stubGlobal("desktopBridge", { getBlacksandWindowOpacity: async () => value });
      applyWindowTint(73);
      await loadWindowTint();
      expect(document.documentElement.hasAttribute("data-t3b-window-material")).toBe(false);
    }
    using _bridge = stubGlobal("desktopBridge", { getBlacksandWindowOpacity: async () => null });
    await using screen = await render(<BlacksandWindowOpacitySettings />);
    expect(screen.container.querySelector("input")).toBeNull();
  });
});


function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const change = (input: HTMLInputElement, value: number) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const tint = () => document.documentElement.style.getPropertyValue("--t3b-window-tint");

describe("queued tint saves", () => {
  it("keeps the final successful value visible after an earlier queued save fails", async () => {
    let saved = 100;
    const first = deferred();
    const requested: number[] = [];
    using bridge = stubGlobal("desktopBridge", {
      getBlacksandWindowOpacity: async () => saved,
      setBlacksandWindowOpacity: async (value: number) => {
        requested.push(value);
        if (requested.length === 1) await first.promise;
        saved = value;
      },
    });
    try {
      await using screen = await render(<BlacksandWindowOpacitySettings />);
      const slider = screen.getByRole("slider", { name: "Window background tint" });
      await expect.element(slider).toHaveValue("100");
      const input = screen.container.querySelector("input")!;
      await change(input, 60);
      await vi.waitFor(() => expect(requested).toEqual([60]));
      await change(input, 80);
      first.reject(new Error("simulated transient write failure"));
      await vi.waitFor(() => expect(saved).toBe(80));
      expect(requested).toEqual([60, 80]);
      expect(tint()).toBe("80%");
      // The successful second write must also reconcile the visible control.
      expect(input.value).toBe("80");
    } finally { applyWindowTint(100); }
  });

  it("preserves slider event order across Settings close and reopen", async () => {
    let saved = 100;
    const first = deferred();
    const requested: number[] = [];
    let persist = Promise.resolve();
    using bridge = stubGlobal("desktopBridge", {
      getBlacksandWindowOpacity: async () => saved,
      setBlacksandWindowOpacity: (value: number) => {
        requested.push(value);
        const ordinal = requested.length;
        // Model main-process SynchronizedRef persistence: FIFO received requests.
        const result = persist.then(async () => {
          if (ordinal === 1) await first.promise;
          saved = value;
        });
        persist = result;
        return result;
      },
    });
    try {
      await using old = await render(<BlacksandWindowOpacitySettings />);
      await expect.element(old.getByRole("slider")).toHaveValue("100");
      const oldInput = old.container.querySelector("input")!;
      await change(oldInput, 60);
      await vi.waitFor(() => expect(requested).toEqual([60]));
      await change(oldInput, 70);
      await old.unmount();
      await using reopened = await render(<BlacksandWindowOpacitySettings />);
      await expect.element(reopened.getByRole("slider")).toHaveValue("100");
      await change(reopened.container.querySelector("input")!, 90);
      // New component must not overtake an already queued write.
      first.resolve();
      await vi.waitFor(() => expect(requested).toHaveLength(3));
      await persist;
      await vi.waitFor(() => expect(tint()).toBe(`${saved}%`));
      expect(saved).toBe(90);
      expect(reopened.container.querySelector("input")!.value).toBe("90");
      expect(tint()).toBe("90%");
    } finally { first.resolve(); await persist; applyWindowTint(100); }
  });
});
