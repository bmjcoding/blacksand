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
  const ungated = provider.filter((edit) => edit.alternatives?.every((shape) => shape.replace.includes("return blacksandUngatedInstall(")));
  assert.equal(ungated.length, 4, "each installer has one strict edit");
  for (const edit of ungated) {
    assert.equal(edit.alternatives.length, 2, "with and without the provider environment");
    for (const shape of edit.alternatives) {
      assert.equal(shape.find.replace(new RegExp(edit.find.source, "g"), edit.replace), shape.replace);
      assert.doesNotMatch(shape.replace, /makeProviderMaintenanceCapabilities|env:|updateExecutable/);
    }
  }
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

test("the sidebar logo is upstream's T3 Code with a muted, smaller blacksand centred under it", () => {
  for (const id of ["web/blacksand-wordmark", "web/blacksand-stage-art"]) assert.ok(!byId.has(id), `${id} is gone`);
  const [column, name] = byId.get("web/blacksand-sidebar-name").edits;
  assert.match(column.replace, /^ {4}<span className="inline-flex min-w-0 flex-col items-center">\n {4}<span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">\n$/, "upstream's mark, in a centred column");
  assert.equal(name.find, "        Code\n      </span>\n    </span>\n", "after upstream's muted Code, under its mark");
  assert.match(name.replace, /text-\[10px\] leading-none font-normal tracking-\[0\.1em\]", onBackdrop \? "text-white\/55" : "text-muted-foreground\/70"\)\}>\n {8}blacksand\n {6}<\/span>\n {4}<\/span>\n$/);
  assert.equal(index.get("web/blacksand-sidebar-name"), "wordmark");
  assert.doesNotMatch(file("BlacksandBrand.tsx"), /Wordmark|Redacted|BLACKOUT/);
  assert.doesNotMatch(file("blacksand.css"), /t3b-wordmark|t3b-redacted/);
  assert.doesNotMatch(file("blacksandInterface.ts"), /wordmark|redact/i);
});

test("nightly's stage art is the desert night, called Blacksand artwork, with the mark as it is", () => {
  for (const id of ["web/blacksand-night-sky-file", "web/blacksand-night-sky", "web/blacksand-artwork-label"]) assert.equal(index.get(id), "night-sky", id);
  assert.ok(featureByName("night-sky").requires.includes("styles"), "its fade loads with the styles");
  assert.equal(byId.get("web/blacksand-night-sky-file").file, "apps/web/src/components/BlacksandNightSky.tsx");
  const [, header, button] = byId.get("web/blacksand-night-sky").edits;
  assert.equal(header.replace, '  return variant === "nightly" ? <BlacksandNightSky /> : <DevBlueprintArt />;\n', "dev keeps upstream's blueprint");
  assert.equal(button.replace, '  return variant === "nightly" ? <BlacksandNightSky compact /> : <DevBlueprintArt compact />;\n', "the send button's fill too");
  assert.deepEqual(byId.get("web/blacksand-artwork-label").edits, [{ find: '"Nightly artwork"', replace: '"Blacksand artwork"', count: 4 }], "every place the dropdown names it");
  // the mark is docs/assets/blacksand.svg's shapes, unaltered
  const sky = file("BlacksandNightSky.tsx");
  for (const [, d] of file("blacksand.svg").matchAll(/ d="([^"]+)"/g)) assert.ok(sky.includes(`d="${d}"`), `the mark keeps ${d.slice(0, 24)}…`);
  assert.match(sky, /<circle cx="512\.0" cy="623\.4" r="197\.6" fill="none" stroke="#fff" strokeWidth="34" \/>/);
  assert.doesNotMatch(sky, /<animate|@keyframes|requestAnimationFrame|feGaussianBlur/, "static, and nothing soft enough to fringe");
  assert.doesNotMatch(sky, /--stage-fade|--app-chrome-background|useBlacksandInterface/, "night in every theme; the dropdown is its only switch");
  const css = file("blacksand.css");
  assert.match(css, /\.sidebar-stage-backdrop:has\(> \[data-stage-art="blacksand"\]\) \{\n {2}--t3b-sky-fade: linear-gradient\(\n {4}to bottom,\n {4}black 0%,\n {4}black 63%,/, "it fades into the chrome, from under the far ridge");
  assert.match(css, /mask-image: var\(--t3b-sky-fade\);\n {2}-webkit-mask-image: var\(--t3b-sky-fade\);/);
});

test("the send button is upstream's: no ring, no composer glow, only a marker the version card avoids", () => {
  assert.deepEqual(byId.get("web/blacksand-send-button").edits, [{ find: 'type={showResume ? "button" : "submit"}', replace: 'type={showResume ? "button" : "submit"}\n      data-t3b-send=""' }]);
  assert.equal(index.get("web/blacksand-send-button"), "send-button-marker");
  assert.equal(featureByName("send-button"), undefined);
  assert.match(file("BlacksandBrand.tsx"), /\[data-t3b-send\]/, "what the marker is for");
  const css = file("blacksand.css");
  assert.doesNotMatch(css, /t3b-send|composer-shell|--chat-composer-outline/);
  assert.doesNotMatch(file("blacksandInterface.ts"), /\n {2}(send|sky): \{/);
});

test("the app icon is upstream's T3 with the blacksand backdrop behind it", () => {
  assert.equal(file("blacksand.svg"), fs.readFileSync(new URL("../../../docs/assets/blacksand.svg", import.meta.url), "utf8"), "the sidebar's mark is docs/assets/blacksand.svg");
  for (const id of ["desktop/app-icon-badge", "desktop/app-icon-badge-layer"]) assert.ok(!byId.has(id), `${id} is gone`);
  const assets = rules.filter((rule) => rule.id.startsWith("desktop/app-icon-backdrop-") && rule.kind === "write");
  assert.deepEqual(assets.map((rule) => rule.file).sort(), ["dune", "logo", "sky"].map((part) => `assets/prod/app-icon.icon/Assets/blacksand-${part}.svg`));
  // the static logo as it is, but for its sand line, which is dimmed
  const logo = byId.get("desktop/app-icon-backdrop-logo").content;
  const mark = file("blacksand-mark.svg");
  for (const [, d] of mark.matchAll(/<path d="([^"]{40,})"/g)) assert.ok(logo.includes(d), "the static logo's geometry");
  assert.doesNotMatch(logo, /#8e8e8e/i);
  assert.match(logo, /#555555/);
  // its centre line runs through the gap between upstream's T and 3, not the icon's centre
  assert.match(logo, /<g transform="translate\((\S+) /);
  const [, tx] = logo.match(/<g transform="translate\((\S+) (\S+)\) scale\((\S+)\)"/);
  const scale = Number(logo.match(/scale\((\S+)\)"/)[1]);
  assert.ok(Math.abs(Number(tx) + 512 * scale - (512 + 2.25 * 8.5)) < 0.05, "x 531: the middle of 64.33..68.17 in text.svg at scale 8.5");
  for (const { content } of assets) assert.doesNotMatch(content, /<filter|feGaussianBlur|<animate/, "flat: nothing soft enough to fringe");
  // Upstream's icon.json at v0.1.7-nightly.20261102.4093, abridged.
  const upstream = { fill: { solid: "display-p3:0.00000,0.00000,0.00000,1.00000" }, groups: [{ layers: [{ "image-name": "text.svg", name: "Text" }], translucency: { enabled: true, value: 0.5 } }], "supported-platforms": { squares: "shared" } };
  const icon = JSON.parse(byId.get("desktop/app-icon-backdrop-layers").transform(JSON.stringify(upstream, null, 2)));
  assert.equal(icon.groups.length, 1, "one group, as upstream's nightly icon does it");
  assert.deepEqual(icon.groups[0].layers.map((layer) => layer["image-name"]), ["text.svg", "blacksand-dune.svg", "blacksand-logo.svg", "blacksand-sky.svg"], "front to back: the T3 first");
  assert.deepEqual(icon.groups[0].layers[0], upstream.groups[0].layers[0], "upstream's T3 as it is");
  assert.deepEqual(icon.groups[0].layers.slice(1).map((layer) => layer.glass), [false, false, true], "only the sky is glass: no rim on the logo");
  assert.deepEqual({ ...icon, groups: upstream.groups }, upstream, "the fill and everything else stays upstream's");
  assert.throws(() => byId.get("desktop/app-icon-backdrop-layers").transform("{}"), /no group with text\.svg/);
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
