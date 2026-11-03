// Copied to apps/web/src/components/ in a stripped upstream checkout.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState, type CSSProperties } from "react";
import "../index.css";
import "../blacksand.css";
import { act, render } from "../../test/render";
import { BlacksandVersionStamp } from "./BlacksandBrand";
import { setBlacksandInterface } from "../blacksandInterface";
import { ComposerSurface } from "./chat/ComposerSurface";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { SidebarInset } from "./ui/sidebar";
import { DiffPanelShell } from "./DiffPanelShell";
import { ChatCanvas } from "./chat/ChatCanvas";
import { useChatCanvas } from "./chat/ChatCanvasContext";
import { createChatCanvasStore } from "./chat/canvasStore";
import type { ChatCanvasPreview } from "./chat/chatCanvasLayout";

vi.mock("../blacksandBuild", () => ({
  BLACKSAND_T3_BUILD: {
    version: "0.1.7-nightly.20261031.3991",
    builtAt: "2026-11-02T12:00:00Z",
    upstreamSha: "a".repeat(40),
    upstream: {
      since: "3990",
      repo: "https://github.com/pingdotgg/t3code",
      items: [
        { sha: "b".repeat(40), title: "Composer improvements (#1234)" },
        ...Array.from({ length: 35 }, (_, i) => ({
          sha: String(i).padStart(40, "0"),
          title: `Additional change ${i + 1}`,
        })),
      ],
    },
    blacksand: { since: null, repo: null, items: [] },
    skipped: [{ name: "fixture", label: "An omitted feature", reason: "drift" }],
  },
}));

// ChatView's actual lane/stack/spacer structure, around the real ComposerSurface.
// Avoid a live thread/backend/editor while exercising production CSS and shell.
function Lane({ height = 100, context = false, hero = false, footer = false, overlayRef }: {
  height?: number;
  context?: boolean;
  hero?: boolean;
  footer?: boolean;
  overlayRef?: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={overlayRef}
      data-chat-composer-overlay="true"
      className={
        hero
          ? "pointer-events-none absolute inset-0 z-20 flex items-center"
          : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
      }
    >
      <div className="chat-composer-lane w-full">
        <div
          data-chat-composer-stack="true"
          className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
        >
          <div className="relative z-10">
            <ComposerSurface.Shell contextRow={context}>
              <ComposerSurface.Host>
                <ComposerSurface.Main>
                  <div style={{ height, display: "flex", flexDirection: "column", padding: 8 }}>
                    <textarea
                      aria-label="Message"
                      style={{ flex: 1, minHeight: 0, minWidth: 0, width: "100%" }}
                      defaultValue="A message that must never be underneath the version indicator."
                    />
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <button data-t3b-send type="button">
                        Send
                      </button>
                      <button type="button">Stop</button>
                    </div>
                  </div>
                </ComposerSurface.Main>
              </ComposerSurface.Host>
              {context ? (
                <ComposerSurface.ContextStrip>
                  <button type="button">Worktree actions</button>
                </ComposerSurface.ContextStrip>
              ) : null}
            </ComposerSurface.Shell>
            {footer ? <div style={{ height: 36 }}>Current checkout · Full access</div> : null}
            <div
              aria-hidden
              className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
            />
          </div>
        </div>
        <BlacksandVersionStamp />
      </div>
    </div>
  );
}
function Shell({
  max = "46rem",
  right = 0,
  ...props
}: {
  max?: string;
  right?: number;
  height?: number;
  context?: boolean;
  hero?: boolean;
  footer?: boolean;
}) {
  return (
    <AppSidebarLayout>
      <SidebarInset>
        <div
          className="flex min-h-0 min-w-0 flex-1"
          style={{ "--chat-content-max-width": max } as CSSProperties}
        >
          <div data-test-chat className="relative min-w-0 flex-1 overflow-hidden">
            <Lane {...props} />
          </div>
          {right ? (
            <aside data-test-panel style={{ width: right, flexShrink: 0 }}>
              <DiffPanelShell mode="sidebar" header="Files">
                Panel content
              </DiffPanelShell>
            </aside>
          ) : null}
        </div>
      </SidebarInset>
    </AppSidebarLayout>
  );
}
const rect = (element: Element) => element.getBoundingClientRect();
function separate(a: DOMRect, b: DOMRect) {
  expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(
    true,
  );
}
function inViewport(r: DOMRect) {
  expect(r.left).toBeGreaterThanOrEqual(0);
  expect(r.top).toBeGreaterThanOrEqual(0);
  expect(r.right).toBeLessThanOrEqual(window.innerWidth);
  expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
}

function PreviewFrame() {
  const frame = useChatCanvas()?.layout.frame;
  return frame ? <div data-test-preview style={{ position: "absolute", left: frame.x, top: frame.y,
    width: frame.width, height: frame.height, zIndex: 47 }} /> : null;
}
function PreviewCase({ width, preview, hero = false, height = 140 }: {
  width: number;
  preview: ChatCanvasPreview | null;
  hero?: boolean;
  height?: number;
}) {
  const [store] = useState(createChatCanvasStore);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  return <div style={{ width, height: 700, display: "flex", position: "relative",
    "--chat-content-max-width": "46rem" } as CSSProperties}>
    <ChatCanvas store={store} threadRef={null} preview={preview} composerOverlayElement={hero ? null : overlay}>
      <Lane overlayRef={setOverlay} height={height} context hero={hero} />
      <PreviewFrame />
    </ChatCanvas>
  </div>;
}
const floatingPreview: ChatCanvasPreview = {
  key: "fixture", source: { width: 1280, height: 720 }, width: null, position: null,
};
function previewClear(container: HTMLElement) {
  const stamp = document.querySelector(".t3b-version-stamp")!;
  const bounds = rect(stamp);
  const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  expect(hit === stamp || stamp.contains(hit)).toBe(true);
  separate(bounds, rect(container.querySelector('[data-slot="composer-shell"]')!));
  inViewport(bounds);
  expect(bounds.width).toBeGreaterThanOrEqual(32);
}

afterEach(async () => {
  await act(() => setBlacksandInterface("stamp", true));
});
describe("responsive version stamp", () => {
  it("matches the real composer surface in light, dark, custom themes and Glass settings", async () => {
    await page.viewport(640, 700);
    await using screen = await render(<div style={{ position: "relative", height: 500 }}><Lane /></div>);
    const html = document.documentElement;
    const savedClass = html.className;
    const savedStyle = html.getAttribute("style");
    const savedTheme = html.getAttribute("data-theme-id");
    try {
      for (const dark of [false, true]) {
        html.classList.toggle("dark", dark);
        for (const custom of [false, true]) {
          if (custom) html.setAttribute("data-theme-id", "fixture");
          else html.removeAttribute("data-theme-id");
          html.style.setProperty("--app-theme-surface-raised", dark ? "#34383f" : "#e4e7ee");
          for (const opacity of ["50%", "80%", "100%"]) {
            html.style.setProperty("--glass-opacity", opacity);
            const composer = getComputedStyle(screen.container.querySelector('[data-slot="composer-shell"]')!, "::before");
            const stamp = getComputedStyle(document.querySelector(".t3b-version-stamp")!);
            expect(stamp.backgroundColor).toBe(composer.backgroundColor);
            expect(stamp.backdropFilter).toBe(composer.backdropFilter);
            expect(stamp.opacity).toBe("1");
          }
        }
      }
    } finally {
      html.className = savedClass;
      if (savedStyle === null) html.removeAttribute("style"); else html.setAttribute("style", savedStyle);
      if (savedTheme === null) html.removeAttribute("data-theme-id"); else html.setAttribute("data-theme-id", savedTheme);
    }
  });
  const cases = [
    { width: 600, tall: 600 },
    { width: 1100, tall: 700, right: 300, height: 260, context: true },
    { width: 2200, tall: 900, full: true },
    { width: 2200, tall: 900, right: 700, height: 220 },
    { width: 2200, tall: 900, max: "72rem", context: true, full: true },
    { width: 1600, tall: 800, max: "100%" },
    // Effective CSS viewport of a 1280x900 window at 200% browser zoom.
    { width: 640, tall: 450, max: "100%", height: 180, context: true },
    { width: 360, tall: 400, max: "100%", hero: true, full: true },
    { width: 1218, tall: 636, hero: true, footer: true, full: true },
    { width: 1000, tall: 700, hero: true, footer: true, height: 260, context: true, full: true },
  ];
  for (const { width, tall, full = false, ...props } of cases) {
    it(`reserves bounds at ${width}x${tall}, ${JSON.stringify(props)}`, async () => {
      await page.viewport(width, tall);
      await using screen = await render(<Shell {...props} />);
      const stamp = document.querySelector<HTMLButtonElement>(".t3b-version-stamp")!;
      const bounds = rect(stamp);
      inViewport(bounds);
      if (full) expect(bounds.width).toBeGreaterThan(32); else expect(bounds.width).toBe(32);
      expect(bounds.height).toBe(32);
      for (const node of screen.container.querySelectorAll(
        '[data-slot="composer-shell"], textarea, [data-t3b-send]',
      )) {
        separate(bounds, rect(node));
      }
      expect(Math.abs(window.innerWidth - bounds.right - 16)).toBeLessThan(1);
      expect(Math.abs(window.innerHeight - bounds.bottom - 16)).toBeLessThan(1);
      const version = stamp.querySelector<HTMLElement>(".t3b-version-label")!;
      expect(getComputedStyle(version).visibility).toBe(full ? "visible" : "hidden");
      expect(stamp.getAttribute("aria-label")).toContain("0.1.7-nightly.20261031.3991");
      expect(stamp.getAttribute("aria-label")).toContain("features omitted");
      expect(stamp.querySelector("svg")?.classList.contains("lucide-circle-alert")).toBe(true);
      expect(getComputedStyle(stamp.parentElement!).position).toBe("fixed");
    });
  }
  for (const width of [1000, 1280, 1500, 2200]) {
    it(`keeps the window-corner trigger reachable above the floating canvas preview at ${width}px`, async () => {
      await page.viewport(width, 700);
      await using screen = await render(<PreviewCase width={width} preview={floatingPreview} />);
      await vi.waitFor(() => {
        expect(rect(screen.container.querySelector("[data-test-preview]")!).width).toBeGreaterThan(0);
        previewClear(screen.container);
      });
    });
  }
  it("tracks preview dragging, resizing, centered-draft height and removal", async () => {
    await page.viewport(1280, 700);
    await using screen = await render(<PreviewCase width={1280} preview={floatingPreview} />);
    for (const props of [
      { preview: { ...floatingPreview, position: { x: 800, y: 200 }, lastInteraction: "drag" as const } },
      { preview: { ...floatingPreview, position: { x: 800, y: 500 }, lastInteraction: "drag" as const } },
      { preview: { ...floatingPreview, position: { x: 750, y: 430 }, width: 500, lastInteraction: "resize" as const } },
      { preview: { ...floatingPreview, position: { x: 948, y: 260 } }, hero: true },
      { preview: { ...floatingPreview, position: { x: 948, y: 260 } }, hero: true, height: 260 },
    ]) {
      await screen.rerender(<PreviewCase width={1280} {...props} />);
      await vi.waitFor(() => previewClear(screen.container));
    }
    await screen.rerender(<PreviewCase width={1280} preview={null} />);
    await vi.waitFor(() => {
      const stamp = document.querySelector(".t3b-version-stamp")!;
      expect(rect(stamp).bottom).toBe(window.innerHeight - 16);
    });
  });
  it("responds to panel/max-width/height changes and releases the reservation when disabled", async () => {
    await page.viewport(2200, 900);
    await using screen = await render(<Shell />);
    const width = () => rect(document.querySelector(".t3b-version-stamp")!).width;
    expect(width()).toBeGreaterThan(32);
    await screen.rerender(<Shell right={700} height={270} context />);
    await vi.waitFor(() => expect(width()).toBe(32));
    await screen.rerender(<Shell max="100%" />);
    await vi.waitFor(() => expect(width()).toBe(32));
    const lane = screen.container.querySelector<HTMLElement>(".chat-composer-lane")!;
    await vi.waitFor(() => expect(lane.hasAttribute("data-t3b-version-corner-reserve")).toBe(true));
    const composer = screen.container.querySelector('[data-slot="composer-shell"]')!;
    const before = rect(composer).width;
    await act(() => setBlacksandInterface("stamp", false));
    expect(document.querySelector(".t3b-version-rail")).toBeNull();
    expect(lane.hasAttribute("data-t3b-version-corner-reserve")).toBe(false);
    expect(rect(composer).width).toBeGreaterThan(before);
    expect(getComputedStyle(screen.container.querySelector(".chat-composer-lane")!).display).toBe(
      "block",
    );
  });
  it("restores the full version after narrowing and widening the same window", async () => {
    await page.viewport(2200, 700);
    await using screen = await render(<Shell />);
    const bounds = () => rect(document.querySelector(".t3b-version-stamp")!);
    expect(bounds().width).toBeGreaterThan(32);
    await page.viewport(1100, 700);
    await vi.waitFor(() => expect(bounds().width).toBe(32));
    expect(bounds().right).toBe(1084);
    await page.viewport(2200, 700);
    await vi.waitFor(() => expect(bounds().width).toBeGreaterThan(32));
    expect(bounds().right).toBe(2184);
    expect(bounds().bottom).toBe(684);
  });
  it("keeps the corner fixed when the same draft moves between the center and bottom", async () => {
    await page.viewport(1100, 700);
    await using screen = await render(<Shell />);
    const bounds = () => rect(document.querySelector(".t3b-version-stamp")!);
    expect(bounds().width).toBe(32);
    await screen.rerender(<Shell hero />);
    await vi.waitFor(() => expect(bounds().width).toBeGreaterThan(32));
    expect(bounds().right).toBe(1084);
    expect(bounds().bottom).toBe(684);
    await screen.rerender(<Shell />);
    await vi.waitFor(() => expect(bounds().width).toBe(32));
    expect(bounds().right).toBe(1084);
    expect(bounds().bottom).toBe(684);
  });
  for (const width of [360, 1100, 2200]) {
    it(`opens readable, reachable changes on hover at ${width}px`, async () => {
      await page.viewport(width, 600);
      await using screen = await render(<Shell context />);
      await userEvent.hover(document.querySelector(".t3b-version-stamp")!);
      await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
      await expect.element(page.getByRole("heading", { name: /^Blacksand/ })).toBeVisible();
      const card = document.querySelector(".t3b-version-card")!;
      await vi.waitFor(() => expect(getComputedStyle(card.closest(".t3b-version-notes")!).opacity).toBe("1"));
      const positioner = card.closest('[data-slot="popover-positioner"]')!;
      await vi.waitFor(() => {
        expect(positioner.getAttribute("data-side")).toBe("top");
        const stamp = document.querySelector(".t3b-version-stamp")!;
        expect(rect(positioner).bottom).toBeLessThanOrEqual(rect(stamp).top - 4);
        for (const button of screen.container.querySelectorAll("button")) {
          separate(rect(positioner), rect(button));
        }
      });
      inViewport(rect(card));
      expect(rect(card).height).toBeLessThanOrEqual(window.innerHeight * 0.6 + 1);
      expect(card.scrollHeight).toBeGreaterThan(card.clientHeight);
      await userEvent.hover(card);
      await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
      expect(card.textContent).toContain("An omitted feature");
      expect(card.querySelector("header b")?.textContent).toBe("0.1.7-nightly.20261031.3991");
      const link = page.getByRole("link", { name: "#1234" });
      await expect
        .element(link)
        .toHaveAttribute("href", "https://github.com/pingdotgg/t3code/pull/1234");
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("heading", { name: /^Upstream/ }))
        .not.toBeInTheDocument();
      expect(screen.container.querySelector("iframe")).toBeNull();
    });
  }
  for (const width of [500, 2200]) {
    it(`opens on keyboard focus and reaches links at ${width}px`, async () => {
      await page.viewport(width, 600);
      await using screen = await render(
        <div style={{ position: "relative", height: 500 }}>
          <Lane />
        </div>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Stop", exact: true }));
      await userEvent.keyboard("{Tab}");
      const stamp = document.querySelector(".t3b-version-stamp")!;
      expect(document.activeElement).toBe(stamp);
      await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
      expect(stamp.getAttribute("aria-expanded")).toBe("true");
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement?.textContent).toBe("#1234");
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(stamp);
      await expect.element(page.getByRole("heading", { name: /^Upstream/ })).not.toBeInTheDocument();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("heading", { name: /^Upstream/ })).not.toBeInTheDocument();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).not.toBe(stamp);
    });
  }
  it("toggles with a touch-style click and dismisses with an outside press", async () => {
    await page.viewport(500, 600);
    await using screen = await render(
      <div style={{ position: "relative", height: 500 }}>
        <button type="button">Outside</button>
        <Lane />
      </div>,
    );
    const stamp = document.querySelector(".t3b-version-stamp")!;
    // Avoid hover opening first: pointerdown/up/click is the touch activation path.
    const tap = () =>
      act(() => {
        stamp.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
        );
        stamp.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
        stamp.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
    await tap();
    await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
    await tap();
    await expect.element(page.getByRole("heading", { name: /^Upstream/ })).not.toBeInTheDocument();
    await tap();
    await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await expect.element(page.getByRole("heading", { name: /^Upstream/ })).not.toBeInTheDocument();
  });
});
