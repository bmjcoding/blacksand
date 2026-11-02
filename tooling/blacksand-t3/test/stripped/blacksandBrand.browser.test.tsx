// Copied to apps/web/src/components/ in a stripped upstream checkout and run there
// (rules web/blacksand-brand-file, web/blacksand-css, web/blacksand-interface-file).
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../blacksand.css";
import { render } from "../../test/render";
import { BlacksandVersionStamp } from "./BlacksandBrand";

const REPORT = "<!doctype html><h1>Report</h1><p><a href='#end'>Down</a></p><p id='end'>End</p>";

function fakeBridge() {
  (window as { desktopBridge?: unknown }).desktopBridge = {
    onUpdateState: () => () => {},
    getUpdateState: async () => null,
    getBlacksandDriftReport: async () => REPORT,
  };
}

afterEach(() => {
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

const inDialog = () => Boolean(document.activeElement?.closest('[role="dialog"]'));

describe("blacksand brand", () => {
  it("opens the report as a modal dialog that holds focus and gives it back", async () => {
    fakeBridge();
    await using screen = await render(
      <>
        <button type="button">Before</button>
        <BlacksandVersionStamp />
      </>,
    );
    await userEvent.hover(screen.container.querySelector(".t3b-version-stamp")!);
    const open = page.getByRole("button", { name: "See what changed" });
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByRole("dialog", { name: "What changed" })).toBeVisible();
    await expect.poll(inDialog).toBe(true);
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      expect(inDialog() || document.activeElement?.tagName === "IFRAME").toBe(true);
      expect(document.activeElement?.textContent).not.toBe("Before");
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement?.textContent).toBe("See what changed");
  });
});
