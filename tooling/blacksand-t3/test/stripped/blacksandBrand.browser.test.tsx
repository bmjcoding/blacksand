// Copied to apps/web/src/components/ in a stripped upstream checkout.
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../blacksand.css";
import { render } from "../../test/render";
import { BlacksandVersionStamp } from "./BlacksandBrand";
afterEach(() => { delete (window as { desktopBridge?: unknown }).desktopBridge; });
describe("blacksand version stamp", () => {
  it("shows lightweight changes without custom report, iframe or preview controls", async () => {
    await using screen = await render(<BlacksandVersionStamp />);
    await userEvent.hover(screen.container.querySelector(".t3b-version-stamp")!);
    await expect.element(page.getByRole("heading", { name: /^Upstream/ })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: /^Blacksand/ })).toBeVisible();
    expect(screen.container.querySelector("iframe")).toBeNull();
    expect(screen.container.querySelector("button")).toBeNull();
  });
});
