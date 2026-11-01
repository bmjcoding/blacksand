// node --test test/: the parsers every trust decision rests on: versions and npm
// ranges, release tags and pin.json, the YAML reader and lockfile inventories, ages
// and publish times, CVSS, and the security overrides and their catalog edits. Each
// refuses what it can't read rather than guessing.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { isAlerting, severityOf } from "../lib/advisories.mjs";
import { cvssScore, scoreSeverity } from "../lib/cvss.mjs";
import { ageSetting, lockPackages, publishedTime } from "../lib/gates.mjs";
import { backwardMove, compareRefs, isReleaseTag, validatePin } from "../lib/pin.mjs";
import { applyOverrides, overrideFor, overrideYamlLines, raiseCatalog, readOverrides } from "../lib/overrides.mjs";
import { compareVersions, lineOf, parseRange, satisfies } from "../lib/semver.mjs";
import { RuleDrift } from "../lib/strip-engine.mjs";
import { parseDocuments, parseYaml } from "../lib/yaml.mjs";

test("SemVer precedence: numeric prerelease ids, hyphenated ids, build metadata ignored", () => {
  const sorted = ["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-beta", "1.0.0-alpha.beta", "1.0.0-alpha.1", "1.0.0-alpha", "1.0.0-alpha-2", "1.0.0-alpha-1"].sort(compareVersions);
  // Identifiers compare in ASCII order: "alpha" < "alpha-1", so alpha.1 sorts before alpha-1.
  assert.deepEqual(sorted, ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-alpha-1", "1.0.0-alpha-2", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]);
  assert.ok(compareVersions("1.0.0-alpha-1", "1.0.0-alpha-2") < 0);
  assert.ok(compareVersions("1.2.3+build", "1.2.4") < 0);
  assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0);
  assert.ok(compareVersions("v20.11.1", "20.9.0") > 0);
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("99999999999999999999.0.0", "99999999999999999998.0.0") > 0);
  for (const bad of ["1.2", "01.2.3", "1.2.3-01", "1.2.3-", "latest", ""]) assert.throws(() => compareVersions(bad, "1.0.0"), /isn't a SemVer/, bad);
  assert.equal(lineOf("0.35.4"), "0.35");
  assert.equal(lineOf("8.11.2"), "8");
});

test("npm ranges: carets, tildes, x-ranges, hyphens, unions and prereleases as node-semver decides", () => {
  const cases = [
    ["1.2.3", "^1.0.0", true], ["2.0.0", "^1.0.0", false], ["0.2.9", "^0.2.3", true], ["0.3.0", "^0.2.3", false],
    ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false], ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false],
    ["1.9.0", "1.x", true], ["2.0.0", "1", false], ["1.5.0", "1.2.3 - 2.3", true], ["2.4.0", "1.2.3 - 2.3", false],
    ["4.6.6", "^3.25 || ^4", true], ["3.0.0", ">= 1.0.0 < 2", false], ["1.2.3-beta.3", "^1.2.3-beta.2", true],
    ["1.2.4-alpha", "^1.2.3-beta.2", false], ["2.0.0-rc.1", "*", false], ["1.0.0", "", true], ["1.3.0", ">1.2", true], ["1.2.9", ">1.2", false],
  ];
  for (const [version, range, want] of cases) assert.equal(satisfies(version, range), want, `${version} ${range}`);
  for (const bad of ["latest", "github:x/y", "file:../x", "1.2.3.4", ">=", "^1.2.3 - 2"]) assert.throws(() => parseRange(bad), bad);
});

test("release tags are canonical and order by version, then nightly date and build, stable last", () => {
  const sorted = ["v0.1.4", "v0.1.4-nightly.20261028.3824", "v0.1.3-nightly.20261025.3692", "v0.1.4-nightly.20261028.3900", "v0.1.10-nightly.20261101.1"].sort(compareRefs);
  assert.deepEqual(sorted, ["v0.1.3-nightly.20261025.3692", "v0.1.4-nightly.20261028.3824", "v0.1.4-nightly.20261028.3900", "v0.1.4", "v0.1.10-nightly.20261101.1"]);
  assert.ok(isReleaseTag("v0.1.6-nightly.20261030.3917", "nightly"));
  assert.ok(isReleaseTag("v1.0.0", "stable"));
  for (const bad of ["v00.1.6-nightly.20261030.3917", "v0.01.6", "v0.1.6-nightly.20261332.1", "v0.1.6-nightly.20261030.03917", "0.1.6", "v0.1.6-beta.20261030.1"]) {
    assert.equal(isReleaseTag(bad), false, bad);
  }
  assert.equal(isReleaseTag("v0.1.6-preview.20261030.1", "nightly"), false);
  assert.throws(() => compareRefs("v00.1.6", "v0.1.6"), /isn't a release tag/);
});

test("pin.json: canonical tags, equal releases keep their commit, and device tool locks are exact and never changed or dropped", () => {
  const pin = (ref, sha) => validatePin({ version: 1, channels: { nightly: { ref, sha, evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } }, deviceTools: [] });
  assert.throws(() => pin("v00.1.6-nightly.20261030.3917", "a".repeat(40)), /isn't a release tag/);
  const before = pin("v0.1.6-nightly.20261030.3917", "a".repeat(40));
  assert.match(backwardMove(before, pin("v0.1.6-nightly.20261030.3917", "b".repeat(40))), /changes .* commit/);
  assert.match(backwardMove(before, pin("v0.1.6-nightly.20261030.3904", "b".repeat(40))), /moves nightly back/);
  assert.equal(backwardMove(before, pin("v0.1.6-nightly.20261030.3940", "b".repeat(40))), null);
  assert.throws(() => validatePin({ ...before, deviceTools: ["agent-device@0.21.31", "agent-device@0.21.31"] }), /twice/);
  assert.throws(() => validatePin({ ...before, deviceTools: ["agent-device@latest"] }), /name@version/);
  // Device tool locks: exact shape, matching digest.
  const lock = '{"lockfileVersion":3}\n';
  const entry = { sha256: createHash("sha256").update(lock).digest("hex"), lock };
  const locked = { version: 1, channels: {}, deviceTools: ["agent-device@0.21.31"], deviceToolLocks: { "agent-device@0.21.31": entry } };
  assert.equal(validatePin(structuredClone(locked)).deviceToolLocks["agent-device@0.21.31"].lock, lock);
  for (const [locks, why] of [
    [{ "agent-device@0.21.31": { ...entry, lock: `${lock} ` } }, /doesn't match its sha256/],
    [{ "agent-device@0.21.31": { ...entry, note: "x" } }, /exactly sha256 and lock/],
    [{ "agent-device": entry }, /isn't name@version/],
    [[], /must be an object/],
  ]) {
    assert.throws(() => validatePin({ ...locked, deviceToolLocks: locks }), why);
  }
  const other = '{"lockfileVersion":3,"x":1}\n';
  const changed = { ...locked, deviceToolLocks: { "agent-device@0.21.31": { sha256: createHash("sha256").update(other).digest("hex"), lock: other } } };
  assert.match(backwardMove(locked, changed), /replaces agent-device@0\.21\.31's reviewed dependency lock/);
  assert.match(backwardMove(locked, { ...locked, deviceToolLocks: {} }), /removes agent-device@0\.21\.31's reviewed dependency lock/);
  assert.equal(backwardMove({ ...locked, deviceToolLocks: {} }, locked), null);
});

test("the YAML reader matches pnpm's lockfile shapes and refuses what it can't read", () => {
  const [doc] = parseYaml(
    [
      "lockfileVersion: '9.0'",
      "packages:   # a comment after the key",
      "  '@a/b@1.0.0':",
      "    resolution: {integrity: sha512-x==, tarball: 'https://r.example/a.tgz'}",
      "    cpu: [arm64, x64]",
      "  c@2.0.0: {resolution: {integrity: sha512-y}}",
      '  "d@3.0.0":',
      "    engines: {node: '>=18'}",
      "snapshots:",
      "  ? 'e@1.0.0(f@2.0.0)'",
      "  : dependencies:",
      "      f: 2.0.0",
      "    optionalDependencies:",
      "      g: 1.0.0",
      "list:",
      "- one",
      "- two: 2",
      "  three: 3",
    ].join("\n"),
  );
  assert.equal(doc.lockfileVersion, "9.0");
  assert.deepEqual(Object.keys(doc.packages), ["@a/b@1.0.0", "c@2.0.0", "d@3.0.0"]);
  assert.deepEqual(doc.packages["@a/b@1.0.0"].cpu, ["arm64", "x64"]);
  assert.equal(doc.packages["c@2.0.0"].resolution.integrity, "sha512-y");
  assert.deepEqual(doc.snapshots["e@1.0.0(f@2.0.0)"], { dependencies: { f: "2.0.0" }, optionalDependencies: { g: "1.0.0" } });
  assert.deepEqual(doc.list, ["one", { two: 2, three: 3 }]);
  for (const [bad, why] of [
    ["a: &x 1", /anchors/],
    ["a: *x", /anchors/],
    ["a: !tag 1", /anchors/],
    ["a: |\n  text", /block scalars/],
    ["a: 1\na: 2", /duplicate key/],
    ["a: one\n  two", /multi-line/],
    ["a: 'unterminated\n  rest'", /multi-line quoted/],
    ["a: {b: 1,\n  c: 2}", /multi-line flow/],
    ["a:\n  b: 1\n c: 2", /indentation|unexpected/],
    ["a: b: c", /mapping value/],
  ]) {
    assert.throws(() => parseYaml(bad), why, bad);
  }
  assert.equal(parseDocuments("---\na: 1\n---\nb: 2\n").length, 2);
});

test("lockPackages reads every document's packages, commented headers and flow entries, skips workspace links, and refuses empty or unsupported inventories", () => {
  const lock = (packages) => ["lockfileVersion: '9.0'", "importers:", "  .: {}", ...packages].join("\n");
  assert.deepEqual([...lockPackages(lock(["packages: # comment", "  fresh@1.0.0: {resolution: {integrity: sha512-test}}"]))], ["fresh@1.0.0"]);
  assert.deepEqual([...lockPackages(lock(["packages:", '  "quoted@2.0.0":', "    resolution: {integrity: sha512-q}", "  local@file:vendor/local.tgz:", "    resolution: {tarball: file:vendor/local.tgz}"]))], ["quoted@2.0.0"]);
  assert.throws(() => lockPackages(lock(["packages: {}"])), /no registry packages/);
  assert.throws(() => lockPackages(""), /empty/);
  assert.throws(() => lockPackages(lock(["packages:", "  evil@https://evil.example/x.tgz:", "    resolution: {tarball: https://evil.example/x.tgz}"])), /resolved from https:\/\/evil\.example\/x\.tgz, not the npm registry/);
  assert.throws(() => lockPackages(lock(["packages:", "  odd@1.0.0: &anchor {}"])), /anchors/);
  assert.throws(() => lockPackages("lockfileVersion: '6.0'\npackages:\n  a@1.0.0: {}\n"), /isn't supported/);
  // Every document's packages (pnpm's own install is a document of its own), workspace links left out.
  const documents = [
    "---",
    "lockfileVersion: '9.0'",
    "packages:",
    "  '@pnpm/exe@12.14.0':",
    "    resolution: {integrity: sha512-x}",
    "---",
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies: {}",
    "packages:",
    "  '@babel/code-frame@7.27.1':",
    "    resolution: {integrity: sha512-y}",
    "  react@19.2.0:",
    "    resolution: {integrity: sha512-z}",
    "  local@link:packages/local:",
    "    resolution: {directory: packages/local}",
    "snapshots:",
    "  react@19.2.0: {}",
  ].join("\n");
  assert.deepEqual([...lockPackages(documents)].sort(), ["@babel/code-frame@7.27.1", "@pnpm/exe@12.14.0", "react@19.2.0"]);
});

test("minimum ages must be finite non-negative days; publish times must be real calendar instants", () => {
  for (const bad of ["three", -1, Infinity, "9".repeat(400)]) assert.throws(() => ageSetting(bad), /non-negative number|not Infinity/, String(bad));
  assert.equal(ageSetting("3"), 3);
  assert.equal(ageSetting(0.5), 0.5);
  for (const bad of ["2026-02-30T12:00:00Z", "2026-02-29T12:00:00Z", "2026-13-01T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:59:60Z"]) {
    assert.equal(publishedTime(bad), null, bad);
  }
  assert.equal(publishedTime("2024-02-29T23:59:59.123Z"), Date.UTC(2024, 1, 29, 23, 59, 59, 123));
});

test("CVSS v3.x and v2 base scores match FIRST's reference values", () => {
  const cases = [
    ["CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "CRITICAL"],
    ["CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10, "CRITICAL"],
    ["CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1, "MODERATE"],
    ["CVSS_V3", "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8, "HIGH"],
    ["CVSS_V3", "CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 1.6, "LOW"],
    ["CVSS_V3", "CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N", 5.9, "MODERATE"],
    ["CVSS_V2", "AV:N/AC:L/Au:N/C:P/I:P/A:P", 7.5, "HIGH"],
    ["CVSS_V2", "AV:N/AC:L/Au:N/C:C/I:C/A:C", 10, "HIGH"],
  ];
  for (const [type, score, expected, severity] of cases) {
    assert.equal(cvssScore({ type, score }), expected, score);
    assert.equal(scoreSeverity(expected, type), severity, score);
  }
  assert.equal(cvssScore({ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H" }), null, "a missing metric");
  assert.equal(cvssScore({ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }), null);
  for (const bad of [NaN, Infinity, -1, 11, "9.8", null]) assert.equal(scoreSeverity(bad), "UNKNOWN", String(bad));
});

test("a CVSS vector with inherited names as metrics or values is unscored, and its advisory alerts as UNKNOWN", () => {
  const base = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
  for (const vector of [base.replace("AV:N", "AV:constructor"), base.replace("C:H", "C:toString"), base.replace("AC:L", "AC:__proto__"), `${base.replace("/A:H", "")}/hasOwnProperty:H`]) {
    assert.equal(cvssScore({ type: "CVSS_V3", score: vector }), null, vector);
    const severity = severityOf({ id: "GHSA-test", severity: [{ type: "CVSS_V3", score: vector }] });
    assert.equal(severity, "UNKNOWN", vector);
    assert.equal(isAlerting(severity), true);
  }
  assert.equal(cvssScore({ type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:valueOf/I:P/A:P" }), null);
});

test("security overrides pin exact versions and replace only the vulnerable span, build metadata included", () => {
  const sample = [{ selector: "sharp@0.35.4", version: "0.35.5", advisories: [] }];
  assert.deepEqual(overrideFor("sharp@0.35.4+build", sample), { name: "sharp", from: "0.35.0", to: "0.35.5" });
  assert.equal(overrideFor("sharp@0.36.0", sample), null);
  const undici = [{ selector: "undici@8.11.2", version: "8.12.2", advisories: ["GHSA-2m5v-pch6-74hx"] }];
  assert.deepEqual(applyOverrides(["undici@8.11.2", "undici@8.3.0", "undici@8.12.2", "undici@7.29.1", "react@19.0.0"], undici), ["undici@8.12.2", "undici@7.29.1", "react@19.0.0"]);
  assert.equal(overrideYamlLines(undici), '  "undici@>=8.0.0 <8.12.2": 8.12.2');
  assert.equal(overrideYamlLines(sample), '  "sharp@>=0.35.0 <0.35.5": 0.35.5');
  const overrides = readOverrides();
  assert.ok(overrides.length > 0);
  for (const o of overrides) assert.ok(!o.version.startsWith("^") && !o.version.includes(" "), `${o.selector} must pin an exact version`);
  // seroval's fix clears both advisories its old target had.
  const seroval = overrides.find((o) => o.selector.startsWith("seroval@"));
  assert.ok(compareVersions(seroval.version, "1.6.11") >= 0, `seroval fix ${seroval.version}`);
  for (const id of ["GHSA-9wx9-5pv9-3349", "GHSA-f86p-h4j2-7qgj"]) assert.ok(seroval.advisories.includes(id), id);
});

const catalog = (lines) => raiseCatalog(lines.join("\n"), [
  { selector: "undici@8.11.2", version: "8.12.2", advisories: [] },
  { selector: "qs@6.16.0", version: "6.16.1", advisories: [] },
  { selector: "sharp@0.35.4", version: "0.35.5", advisories: [] },
]);

test("raiseCatalog reads quoting, comments, ranges, aliases and named catalogs", () => {
  const out = catalog([
    "catalog:",
    "  undici: '8.11.2'",
    '  "qs": ^6.10.0 # upstream note',
    "  react: 19.0.0",
    "  sharp: ~0.35.1",
    "  big: ^9.0.0",
    "catalogs:",
    "  legacy:",
    "    undici: 8.3.0",
    "    fetcher: npm:undici@^8.0.0-beta.1",
    "  modern: {qs: 6.17.0, undici: =8.11.2}",
    "overrides:",
    "  undici: 8.11.2",
  ]).split("\n");
  assert.equal(out[1], "  undici: '8.12.2' # blacksand security override (was 8.11.2)");
  assert.equal(out[2], '  "qs": ^6.16.1 # blacksand security override (was ^6.10.0)');
  assert.equal(out[3], "  react: 19.0.0");
  assert.equal(out[4], "  sharp: ~0.35.5 # blacksand security override (was ~0.35.1)");
  assert.equal(out[8], "    undici: 8.12.2 # blacksand security override (was 8.3.0)");
  assert.equal(out[9], "    fetcher: npm:undici@^8.12.2 # blacksand security override (was npm:undici@^8.0.0-beta.1)");
  assert.equal(out[10], "  modern: {qs: 6.17.0, undici: 8.12.2}");
  assert.equal(out[12], "  undici: 8.11.2", "only catalogs are touched");
  assert.equal(catalog(["catalog:", "  undici: ^8.12.2", "  qs: 7.0.0"]), "catalog:\n  undici: ^8.12.2\n  qs: 7.0.0");
});

test("raiseCatalog refuses ranges it can't judge for an overridden package, and unreadable YAML", () => {
  for (const value of [">=8.0.0 <9", "8.x", "*", "^8.0.0 || ^9.0.0", "latest", "workspace:*"]) {
    assert.throws(() => catalog(["catalog:", `  undici: '${value}'`]), (error) => error instanceof RuleDrift && /can't be checked/.test(error.message), value);
  }
  assert.equal(catalog(["catalog:", "  react: '>=18'"]), "catalog:\n  react: '>=18'", "a package without an override is left alone");
  assert.throws(() => catalog(["catalog:", "  undici: &v 8.11.2"]), RuleDrift);
  assert.throws(() => catalog(["catalog: [undici]"]), /isn't a mapping/);
});
