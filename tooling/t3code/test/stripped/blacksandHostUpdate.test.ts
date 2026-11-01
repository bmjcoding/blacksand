// Copied to apps/server/src/cloud/ in a stripped upstream checkout and run there
// (rules server/blacksand-host-update-file, server/self-update-requests-host-build).
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { hasBlacksandUpdateAgent, requestBlacksandHostUpdate } from "./blacksandHostUpdate.ts";

const scratch = () => NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3b-host-update-"));

describe("blacksand host update requests", () => {
  it("drops a fresh, private marker per request, named by account and a random id", () => {
    const requests = scratch();
    expect(requestBlacksandHostUpdate(requests)).toBe(true);
    expect(requestBlacksandHostUpdate(requests)).toBe(true);
    const names = NodeFs.readdirSync(requests);
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toMatch(new RegExp(`^${process.getuid?.() ?? 0}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
      expect(NodeFs.lstatSync(NodePath.join(requests, name)).mode & 0o777).toBe(0o600);
    }
  });
  it("leaves a planted symlink's target alone", () => {
    const requests = scratch();
    const victim = NodePath.join(scratch(), "victim");
    NodeFs.writeFileSync(victim, "keep");
    NodeFs.symlinkSync(victim, NodePath.join(requests, "planted"));
    expect(requestBlacksandHostUpdate(requests)).toBe(true);
    expect(NodeFs.readFileSync(victim, "utf8")).toBe("keep");
  });
  it("reports no agent, and makes no request, without a request folder", () => {
    const missing = NodePath.join(scratch(), "missing");
    expect(hasBlacksandUpdateAgent(missing)).toBe(false);
    expect(requestBlacksandHostUpdate(missing)).toBe(false);
    const file = NodePath.join(scratch(), "file");
    NodeFs.writeFileSync(file, "");
    expect(hasBlacksandUpdateAgent(file)).toBe(false);
    expect(hasBlacksandUpdateAgent(scratch())).toBe(true);
  });
});
