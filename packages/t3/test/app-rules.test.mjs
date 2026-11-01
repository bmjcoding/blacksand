// node --test test/*.test.mjs: the app-facing rules stay where they belong (lib/rules.mjs, lib/features.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { featureByName, featureIndex } from "../lib/features.mjs";
import { makeRules } from "../lib/rules.mjs";

const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/t3b/bin/t3", path: "/usr/bin" }, build: null });
const index = featureIndex(rules);
const byId = new Map(rules.map((rule) => [rule.id, rule]));
const file = (name) => fs.readFileSync(new URL(`../lib/files/${name}`, import.meta.url), "utf8");

test("privacy and supply-chain rules are strict", () => {
  for (const id of [
    "shared/csp-policy-file",
    "shared/csp-policy-export",
    "server/static-assets-csp",
    "desktop/protocol-csp",
    "web/csp-plugin-file",
    "web/no-npm-release-poll",
    "web/no-stock-manual-update-command",
    "provider/release-age-file",
    "provider/release-age-export",
    "provider/updates-minimum-age",
    "provider/updates-manual-reason",
    "server/provider-update-manual-reason",
    "acp-registry/installs-minimum-age",
    "acp-registry/no-prebuilt-binaries",
    "acp-registry/no-prebuilt-binaries-message",
  ]) {
    assert.ok(byId.has(id), `${id} exists`);
    assert.equal(index.get(id), undefined, `${id} must not be a feature rule`);
  }
});

test("the host update request is one feature, all or nothing", () => {
  const hosts = rules.filter((rule) => index.get(rule.id) === "host-update-requests").map((rule) => rule.id).sort();
  assert.deepEqual(hosts, [
    "client/self-update-blacksand-host-queued",
    "contracts/self-update-blacksand-host",
    "server/blacksand-host-update-file",
    "server/self-update-host-capability",
    "server/self-update-requests-host-build",
    "web/self-update-blacksand-host",
    "web/self-update-blacksand-host-no-npm-wait",
    "web/self-update-blacksand-host-requested-capsule",
    "web/self-update-blacksand-host-requested-results",
    "web/self-update-blacksand-host-requested-run",
    "web/self-update-blacksand-host-requested-settle",
    "web/self-update-blacksand-host-wording",
  ]);
  assert.equal(index.get("web/preview-pdf-viewer"), "pdf-preview");
  assert.equal(index.get("web/update-track-pinned"), "update-track-note");
  assert.equal(index.get("web/blacksand-interface-setting-search"), "interface-settings");
  assert.ok(featureByName("interface-settings").requires.includes("styles"), "the search items live in the styles' interface file");
});

test("one CSP: the page, the server's static files and the desktop protocol share it", () => {
  assert.match(file("blacksand-csp.ts"), /import \{ blacksandContentSecurityPolicy \} from "@t3tools\/shared\/blacksandCsp";/);
  const policy = file("blacksandCsp.ts");
  assert.doesNotMatch(policy, /"(?:https?|wss?):"/, "no scheme-wide sources");
  assert.match(policy, /"object-src 'none'"/);
  const header = (id) => byId.get(id).edits.map((edit) => edit.replace).join("\n");
  assert.match(header("server/static-assets-csp"), /"Content-Security-Policy": BLACKSAND_T3_ASSET_CSP/);
  assert.equal(byId.get("server/static-assets-csp").edits.length, 5, "import, granted files (renamed and wrapped), streamed headers and the read-whole-file fallback");
  assert.match(header("server/static-assets-csp"), /blacksandGrantedFileCsp\(/);
  assert.match(header("desktop/protocol-csp"), /const contentSecurityPolicy = BLACKSAND_T3_ASSET_CSP;/);
});

test("host update markers are unguessable and created exclusively", () => {
  const host = file("blacksandHostUpdate.ts");
  assert.match(host, /NodeCrypto\.randomUUID\(\)/);
  assert.match(host, /flag: "wx"/);
  assert.doesNotMatch(host, /Date\.now\(\)/);
  const server = byId.get("server/self-update-requests-host-build").edits.map((edit) => edit.replace).join("\n");
  assert.match(server, /method: "blacksand-host" as const/, "a written marker is an accepted request, not a failure");
});

test("provider and ACP Registry installs keep to the release age", () => {
  const age = file("blacksandReleaseAge.ts");
  assert.match(age, /export const MIN_RELEASE_AGE_DAYS = 3;/);
  // An edit fitting several upstream shapes carries each shape's replacement (lib/rules.mjs shapes).
  const provider = byId.get("provider/updates-minimum-age").edits.flatMap((edit) => edit.alternatives?.map((shape) => shape.replace) ?? [edit.replace]).join("\n");
  assert.match(provider, /--before=\$\{releaseAgeCutoff\(\)\}/);
  assert.match(provider, /--config\.minimum-release-age-strict=true/);
  assert.match(provider, /newestSettledVersion\(document\.value\)/);
  const acp = byId.get("acp-registry/installs-minimum-age").edits.map((edit) => edit.replace).join("\n");
  assert.match(acp, /--before=\$\{releaseAgeCutoff\(\)\}/);
  assert.match(acp, /"--exclude-newer", releaseAgeCutoff\(\)/);
});

test("installers that can't keep to the release age are manual, and ACP agents never run prebuilt binaries", () => {
  const provider = byId.get("provider/updates-minimum-age").edits;
  const ungated = provider.find((edit) => edit.find instanceof RegExp && edit.count === 4);
  assert.ok(ungated, "the four installer branches are replaced, all or nothing");
  const replaced = 'return makeProviderMaintenanceCapabilities({\n      provider: definition.provider,\n      packageName,\n      updateExecutable: "bun",\n      updateArgs: ["i", "-g", `${packageName}@latest`],\n      updateLockKey: "bun-global",\n    });\n';
  assert.equal(`    ${replaced}`.replace(new RegExp(ungated.find.source, "g"), ungated.replace), '    return blacksandUngatedInstall(manual, "bun");\n');
  const text = provider.map((edit) => (typeof edit.replace === "string" ? edit.replace : "")).join("\n");
  assert.match(text, /Update this provider with npm or pnpm, or its own updater\./);
  assert.match(text, /!\/\^\(\?:npm-global:\|pnpm-global\$\)\/\.test\(/, "only npm and pnpm take a targeted install");
  assert.doesNotMatch(text, /bun-global|yarn-global|vite-plus-global/);
  const acp = byId.get("acp-registry/no-prebuilt-binaries").edits.map((edit) => edit.replace).join("\n");
  assert.match(acp, /input\.preference === "auto" \? \["npx", "uvx"\] : \[input\.preference\]/);
  assert.match(acp, /const BLACKSAND_PREBUILT_BINARIES: boolean = false;/);
  assert.match(acp, /if \(!BLACKSAND_PREBUILT_BINARIES\) \{\n\s+return yield\* new AcpRegistryError/);
});

test("the preview start waits for its window", () => {
  assert.match(file("blacksandDriftReport.ts"), /event\.type === "preview-open"/);
  assert.match(fs.readFileSync(new URL("../lib/preview.mjs", import.meta.url), "utf8"), /emit\(\{ type: "preview-open", version \}\)/);
});
