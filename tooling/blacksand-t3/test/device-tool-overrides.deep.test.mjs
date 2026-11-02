// node --test: self-update's side of device tool security overrides (see
// device-tool-overrides.test.mjs), over signed fixture histories: an evaluator
// pin may approve an override's fix only with the override this clone trusts,
// and a young fix needs its fast lane.

import { test } from "node:test";
import assert from "node:assert/strict";

import { NIGHTLY, ago, fixture, mockFetch as mockRoutes, npm, pin as pinText } from "./trust-fixtures.mjs";

/**
 * npm for the fixture's trust-su-tool, once (npm metadata is cached per name):
 * 1.0.0 old, 1.1.5 ten days old, 1.1.7 a day old; the usual publisher and
 * repository, no provenance before or now (lib/fastlane.mjs publisherContinuity).
 */
const TOOL_ROUTES = await (async () => {
  const routes = npm("trust-su-tool", {
    "1.0.0": { files: { "index.js": "1" }, publishedAt: ago(40) },
    "1.1.5": { files: { "index.js": "2" }, publishedAt: ago(10) },
    "1.1.7": { files: { "index.js": "3" }, publishedAt: ago(1) },
  });
  const packument = JSON.parse(await routes["https://registry.npmjs.org/trust-su-tool"]().text());
  for (const info of Object.values(packument.versions)) Object.assign(info, { _npmUser: { name: "maintainer" }, repository: "https://github.com/o/trust-su-tool" });
  routes["https://registry.npmjs.org/trust-su-tool"] = () => new Response(JSON.stringify(packument), { status: 200 });
  return routes;
})();
const toolOverride = (version) => JSON.stringify({ overrides: [], deviceTools: [{ selector: "trust-su-tool@1.1.0", version, advisories: ["GHSA-r2r2-r2r2-r2r2"] }] });

test("self-update: an evaluator pin may approve the override's fix of what its release pins, and only with the override this clone trusts", async () => {
  const overrides = toolOverride("1.1.5");
  const routes = TOOL_ROUTES;
  // Trusted: the owner's override, then the evaluator's pin of 3940 (which pins trust-su-tool@1.1.0) approving 1.1.5.
  let f = fixture();
  f.commit(f.owner, { "lib/overrides.json": overrides }, "Device tool override");
  const tip = f.commit(f.bot, { "pin.json": pinText(NIGHTLY(3940), f.shas[2], ["trust-su-tool@1.0.0", "trust-su-tool@1.1.5"]) }, "Pin nightly");
  mockRoutes(routes);
  assert.equal(await f.update({ advisories: async () => [] }), "updated", f.logs.join("\n"));
  assert.equal(f.head(), tip);
  // Without the override (or with one the evaluator would need to write) the approval is out of scope.
  f = fixture();
  const before = f.head();
  f.commit(f.bot, { "pin.json": pinText(NIGHTLY(3940), f.shas[2], ["trust-su-tool@1.0.0", "trust-su-tool@1.1.5"]) }, "Pin nightly");
  mockRoutes(routes);
  assert.equal(await f.update({ advisories: async () => [] }), "refused");
  assert.equal(f.head(), before);
  assert.ok(f.logs.some((line) => /approves trust-su-tool@1\.1\.5, which v0\.1\.6-nightly\.20261030\.3940 doesn't pin/.test(line)), f.logs.join("\n"));
});

test("self-update: a young override fix is held unless its fast lane, worked out on the Mac, takes it", async () => {
  // Published by the tool's repository alone: it counts only because the owner's override names it.
  const advisory = async (packages) => (packages.includes("trust-su-tool@1.0.0") ? [{ id: "GHSA-r2r2-r2r2-r2r2", aliases: [], severity: "HIGH", packages: [{ pkg: "trust-su-tool@1.0.0", fixed: ["1.1.7"] }], sources: ["github-repository"] }] : []);
  const unvouched = JSON.stringify({ overrides: [], deviceTools: [{ selector: "trust-su-tool@1.1.0", version: "1.1.7", advisories: ["GHSA-other-othe-othe"] }] });
  for (const [advisories, overrides, want] of [[async () => [], toolOverride("1.1.7"), "refused"], [advisory, unvouched, "refused"], [advisory, toolOverride("1.1.7"), "updated"]]) {
    const f = fixture();
    f.commit(f.owner, { "lib/overrides.json": overrides }, "Device tool override");
    f.commit(f.bot, { "pin.json": pinText(NIGHTLY(3940), f.shas[2], ["trust-su-tool@1.0.0", "trust-su-tool@1.1.7"]) }, "Pin nightly");
    mockRoutes(TOOL_ROUTES);
    assert.equal(await f.update({ advisories }), want, f.logs.join("\n"));
    if (want === "refused") assert.ok(f.logs.some((line) => /trust-su-tool@1\.1\.7.*under 3 days ago; no security fast lane/.test(line)), f.logs.join("\n"));
  }
});
