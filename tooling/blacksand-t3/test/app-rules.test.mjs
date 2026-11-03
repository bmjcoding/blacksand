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

test("the version stamp keeps changes and omissions without custom report or preview UI", () => {
  assert.doesNotMatch(rules.map((rule) => rule.id).join("\n"), /drift-report/);
  assert.equal(featureByName("drift-viewer"), undefined);
  assert.doesNotMatch(file("BlacksandBrand.tsx"), /DriftReport|NextBuild|previewBlacksandBuild|getBlacksandDriftReport|iframe|Dialog/);
  assert.match(file("BlacksandBrand.tsx"), /<LeftOut \/>/);
  assert.match(file("BlacksandBrand.tsx"), /title="Upstream"/);
  assert.match(file("BlacksandBrand.tsx"), /title="Blacksand"/);
});

test("the app is called T3 Code (blacksand) everywhere it shows its name, with no stage label", () => {
  const replaces = (id) => byId.get(id).edits.map((edit) => edit.replace).join("\n");
  assert.match(replaces("desktop/identity-app-id"), /if \(version\) return "T3 Code \(blacksand\)";/, "the .app, Dock and Finder name");
  assert.match(replaces("desktop/identity-app-id"), /"run\.blacksand\.t3"/, "the bundle ID stays");
  assert.match(replaces("desktop/identity-runtime-name"), /const APP_BASE_NAME = "T3 Code \(blacksand\)";/);
  assert.match(replaces("desktop/identity-runtime-name"), /displayName: APP_BASE_NAME,/, "menu bar, About, window title, Linux launcher");
  assert.match(replaces("desktop/identity-package-name"), /name: "blacksand-t3",/, "the Electron name and Keychain item stay");
  assert.match(replaces("web/branding-name"), /\?\? "T3 Code \(blacksand\)";/);
  assert.match(replaces("web/branding-title"), /^<title>T3 Code \(blacksand\)<\/title>$/);
  assert.equal(replaces("web/branding-display-name"), "  return input.baseName;\n");
});

test("the sidebar logo is upstream's T3 Code with a muted, smaller blacksand after it", () => {
  for (const id of ["web/blacksand-wordmark", "web/blacksand-stage-art"]) assert.ok(!byId.has(id), `${id} is gone`);
  const [edit] = byId.get("web/blacksand-sidebar-name").edits;
  assert.equal(edit.find, "        Code\n      </span>\n    </span>\n", "after upstream's muted Code, inside its mark");
  assert.match(edit.replace, /^ {8}Code\n {6}<\/span>\n {6}<span className=\{cn\("shrink-0 text-xs font-normal", onBackdrop \? "text-white\/50" : "text-muted-foreground\/70"\)\}>\n {8}blacksand\n {6}<\/span>\n {4}<\/span>\n$/);
  assert.equal(index.get("web/blacksand-sidebar-name"), "wordmark");
  assert.doesNotMatch(file("BlacksandBrand.tsx"), /Wordmark|Redacted|BLACKOUT/);
  assert.doesNotMatch(file("blacksand.css"), /t3b-wordmark|t3b-redacted/);
  assert.doesNotMatch(file("blacksandInterface.ts"), /wordmark|redact/i);
});

test("nightly's stage art is the desert night, behind its own switch, with the mark as it is", () => {
  assert.equal(index.get("web/blacksand-night-sky-file"), "night-sky");
  assert.equal(index.get("web/blacksand-night-sky"), "night-sky");
  assert.ok(featureByName("night-sky").requires.includes("styles"), "its switch and its mask override load with the styles");
  assert.equal(byId.get("web/blacksand-night-sky-file").file, "apps/web/src/components/BlacksandNightSky.tsx");
  const edits = byId.get("web/blacksand-night-sky").edits;
  assert.equal(edits.length, 3, "the import, the header art and the send button's art");
  for (const edit of edits.slice(1)) assert.match(edit.replace, /<BlacksandNightSky (compact )?upstream=\{<NightlySkyArt( compact)? \/>\} \/>/, "upstream's art stays, for the switch's off position");
  assert.ok(edits.every((edit) => !/DevBlueprintArt/.test(edit.replace) || /<DevBlueprintArt( compact)? \/>/.test(edit.replace)), "dev keeps upstream's blueprint");
  // the mark is docs/assets/blacksand.svg's shapes, unaltered
  const sky = file("BlacksandNightSky.tsx");
  const logo = file("blacksand.svg");
  for (const [, d] of logo.matchAll(/ d="([^"]+)"/g)) assert.ok(sky.includes(`d="${d}"`), `the mark keeps ${d.slice(0, 24)}…`);
  assert.match(sky, /<circle cx="512\.0" cy="623\.4" r="197\.6" fill="none" stroke="#fff" strokeWidth="34" \/>/);
  assert.match(sky, /useBlacksandInterface\("sky"\)/);
  assert.doesNotMatch(sky, /<animate|@keyframes|requestAnimationFrame|feGaussianBlur/, "static, and nothing soft enough to fringe");
  assert.match(file("blacksandInterface.ts"), /\n {2}sky: \{\n {4}title: "Desert night sky",/);
  assert.match(file("blacksand.css"), /\.sidebar-stage-backdrop:has\(> \[data-stage-art="blacksand"\]\) \{\n {2}mask-image: none;/);
});

test("the app icon is upstream's with the blacksand badge in front", () => {
  assert.equal(file("blacksand.svg"), fs.readFileSync(new URL("../../../docs/assets/blacksand.svg", import.meta.url), "utf8"), "the badge's logo is docs/assets/blacksand.svg");
  const badge = byId.get("desktop/app-icon-badge");
  assert.equal(badge.file, "assets/prod/app-icon.icon/Assets/blacksand-badge.svg");
  assert.ok(badge.content.includes(file("blacksand.svg").trim()), "the logo as it is, coloured by its group");
  assert.match(badge.content, /<g color="#ffffff" fill="#ffffff"/);
  // Upstream's icon.json at v0.1.7-nightly.20261031.3991, abridged.
  const upstream = { fill: { solid: "display-p3:0.00000,0.00000,0.00000,1.00000" }, groups: [{ layers: [{ "image-name": "text.svg", name: "Text" }] }], "supported-platforms": { squares: "shared" } };
  const icon = JSON.parse(byId.get("desktop/app-icon-badge-layer").transform(JSON.stringify(upstream, null, 2)));
  assert.deepEqual(icon.groups.slice(1), upstream.groups, "upstream's layers stay, behind the badge");
  assert.deepEqual(icon.groups[0].layers.map((layer) => layer["image-name"]), ["blacksand-badge.svg"]);
  assert.equal(icon.groups[0].layers[0].position.scale, 0.42, "42% of the icon's width");
  assert.deepEqual({ ...icon, groups: upstream.groups }, upstream);
  assert.throws(() => byId.get("desktop/app-icon-badge-layer").transform("{}"), /no groups/);
  const writes = rules.filter((rule) => rule.id.startsWith("desktop/app-icon-") && rule.kind === "write" && rule.overwrite).map((rule) => rule.file).sort();
  assert.deepEqual(writes, [
    "assets/nightly/nightly-macos-1024.png",
    "assets/nightly/nightly-universal-1024.png",
    "assets/nightly/nightly-web-apple-touch-180.png",
    "assets/prod/black-macos-1024.png",
    "assets/prod/black-universal-1024.png",
    "assets/prod/t3-black-web-apple-touch-180.png",
  ]);
  assert.ok(rules.filter((rule) => rule.id.startsWith("desktop/app-icon-")).every((rule) => index.get(rule.id) === "app-icon"), "looks only: one feature");
});
