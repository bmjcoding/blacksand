// node --test test/: whether a vulnerable version ships in the app or is build
// tooling only (lib/inventory.mjs shipsIn), and how the alert issues say so
// (ci/reconcile.mjs). The label must never be wrong in the dangerous direction:
// "build tooling only" only where every path to the version starts at a
// project that isn't packaged, and anything unclear counts as shipping. Small
// lockfiles for each case, then upstream's real one at the pinned nightly
// (test/fixtures/upstream-pnpm-lock-84537c4d.yaml.gz, its bytes unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";

import { packageFindings, reconcileAdvisories } from "../ci/reconcile.mjs";
import { shipsIn } from "../lib/inventory.mjs";
import { problems } from "./alerts-markdown.mjs";

/**
 * A one-document pnpm lockfile: `importers` { folder: { field: { name: version
 * or "link:folder" } } }, `snapshots` { "name@version": ["dep: version"] }.
 */
function lockfile(importers, snapshots) {
  const lines = ["lockfileVersion: '9.0'", "importers:"];
  for (const [where, fields] of Object.entries(importers)) {
    lines.push(`  ${where}:`);
    for (const [field, deps] of Object.entries(fields)) {
      lines.push(`    ${field}:`);
      for (const [name, version] of Object.entries(deps)) lines.push(`      ${name}:`, `        specifier: '*'`, `        version: ${version}`);
    }
  }
  lines.push("packages:", ...Object.keys(snapshots).flatMap((key) => [`  ${key}:`, "    resolution: {integrity: sha512-a}"]), "snapshots:");
  for (const [key, deps] of Object.entries(snapshots)) lines.push(...(deps.length ? [`  ${key}:`, "    dependencies:", ...deps.map((dep) => `      ${dep}`)] : [`  ${key}: {}`]));
  return `${lines.join("\n")}\n`;
}

/** A workspace with the three packaged projects, mobile and the root's tooling. */
const WORKSPACE = lockfile(
  {
    ".": { devDependencies: { lint: "1.0.0" } },
    "apps/desktop": { dependencies: { shared: "link:../../packages/shared" } },
    "apps/server": { dependencies: { runtime: "1.0.0", both: "1.0.0" }, devDependencies: { codegen: "1.0.0" } },
    "apps/web": { devDependencies: { config: "1.0.0" } },
    "apps/mobile": { dependencies: { expo: "1.0.0", both: "1.0.0" } },
    "packages/shared": { dependencies: { "via-link": "1.0.0" }, devDependencies: { tester: "1.0.0" } },
  },
  {
    "lint@1.0.0": ["old: 1.0.0"],
    "runtime@1.0.0": ["deep: 1.0.0"],
    "deep@1.0.0": [],
    "both@1.0.0": ["deep: 1.0.0"],
    "codegen@1.0.0": [],
    "config@1.0.0": ["old: 2.0.0"],
    "expo@1.0.0": ["cli: 1.0.0"],
    "cli@1.0.0": ["old: 1.0.0", "forge: 1.0.0"],
    "forge@1.0.0": [],
    "old@1.0.0": [],
    "old@2.0.0": [],
    "via-link@1.0.0": [],
    "tester@1.0.0": [],
  },
);

test("a version a packaged app depends on ships, with the path that says so; one reachable both ways ships", () => {
  const ships = shipsIn({ lock: WORKSPACE, complete: true });
  assert.deepEqual(ships("runtime@1.0.0"), { how: "dependencies", via: ["apps/server (dependencies)"] });
  assert.deepEqual(ships("deep@1.0.0"), { how: "dependencies", via: ["runtime@1.0.0", "apps/server (dependencies)"] });
  // Mobile reaches `both` too, which doesn't make it tooling.
  assert.equal(ships("both@1.0.0").how, "dependencies");
  // A workspace project a packaged app links is part of it.
  assert.deepEqual(ships("via-link@1.0.0"), { how: "dependencies", via: ["packages/shared (dependencies)", "apps/desktop (dependencies)"] });
});

test("a version only a packaged app's devDependencies reach can't be ruled out: its bundler takes whatever the code imports", () => {
  const ships = shipsIn({ lock: WORKSPACE, complete: true });
  assert.deepEqual(ships("codegen@1.0.0"), { how: "dev-dependencies", via: ["apps/server (devDependencies)"] });
  assert.deepEqual(ships("old@2.0.0"), { how: "dev-dependencies", via: ["config@1.0.0", "apps/web (devDependencies)"] });
  assert.deepEqual(ships("tester@1.0.0"), { how: "dev-dependencies", via: ["packages/shared (devDependencies)", "apps/desktop (dependencies)"] });
});

test("a version only unpackaged projects reach is build tooling only, the exact version: another one may ship", () => {
  const ships = shipsIn({ lock: WORKSPACE, complete: true });
  assert.deepEqual(ships("forge@1.0.0"), { how: "unpackaged", via: ["cli@1.0.0", "expo@1.0.0", "apps/mobile (dependencies)"] });
  // Through the root's devDependencies and mobile's alike; the nearest path is the one shown.
  assert.deepEqual(ships("old@1.0.0"), { how: "unpackaged", via: ["lint@1.0.0", ". (devDependencies)"] });
  assert.equal(ships("old@2.0.0").how, "dev-dependencies");
});

test("what can't be determined counts as shipping", () => {
  const ships = shipsIn({ lock: WORKSPACE, complete: true });
  assert.deepEqual(ships("absent@1.0.0"), { how: "unknown", via: [] });
  // A check that didn't cover everything: a part it couldn't read might hold the version.
  assert.deepEqual(shipsIn({ lock: WORKSPACE, complete: false })("forge@1.0.0"), { how: "unknown", via: ["cli@1.0.0", "expo@1.0.0", "apps/mobile (dependencies)"] });
  // No lockfile, one that can't be read, or one without a packaged project (upstream renamed it): nothing is traced.
  for (const lock of [null, "lockfileVersion: '5.4'\n", WORKSPACE.replace(/apps\/web/g, "apps/webapp")]) {
    assert.deepEqual(shipsIn({ lock, complete: true })("forge@1.0.0"), { how: "unknown", via: [] }, String(lock).slice(0, 40));
  }
});

test("the staged install and the device tools ship, whatever the lockfile says", () => {
  const ships = shipsIn({ lock: WORKSPACE, staged: new Set(["forge@1.0.0"]), tools: new Map([["old@1.0.0", "agent-device@0.21.35"], ["agent-device@0.21.35", "agent-device@0.21.35"]]), complete: true });
  assert.deepEqual(ships("forge@1.0.0"), { how: "staged", via: [] });
  assert.deepEqual(ships("old@1.0.0"), { how: "device-tool", via: ["agent-device@0.21.35"] });
  assert.deepEqual(ships("agent-device@0.21.35"), { how: "device-tool", via: [] });
});

// -------------------------------------------- upstream's real lockfile ----

const REAL = gunzipSync(fs.readFileSync(new URL("./fixtures/upstream-pnpm-lock-84537c4d.yaml.gz", import.meta.url))).toString("utf8");

test("upstream's lockfile at the pinned nightly: uuid and node-forge are build tooling only, zod 3 can't be ruled out, zod 4 and effect ship", () => {
  // Its bytes are upstream's: the blob `git rev-parse 84537c4dd976a89b6ec094f43ae3ef7bee12cb1a:pnpm-lock.yaml` names.
  assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(REAL)}\0`).update(REAL).digest("hex"), "ccc69351000ec08a68a7ff6924243288434e88ac");
  const ships = shipsIn({ lock: REAL, complete: true });
  // Expo's iOS tooling, for the mobile app (#2, #7).
  assert.deepEqual(ships("uuid@7.0.3"), { how: "unpackaged", via: ["xcode@3.0.1", "@expo/config-plugins@58.0.9", "@clerk/expo@4.14.0", "apps/mobile (dependencies)"] });
  assert.deepEqual(ships("node-forge@1.4.0"), { how: "unpackaged", via: ["@expo/cli@58.1.11", "expo@58.0.14", "apps/mobile (dependencies)"] });
  // #3: mobile's Expo reaches it, and so does the web app's @vercel/config, a devDependency: the web app is
  // bundled, and nothing in the lockfile says its code doesn't import that, so it isn't called tooling.
  assert.deepEqual(ships("zod@3.25.76"), { how: "dev-dependencies", via: ["@vercel/config@0.3.0", "apps/web (devDependencies)"] });
  assert.deepEqual(ships("zod@4.6.5"), { how: "dependencies", via: ["apps/server (dependencies)"] });
  assert.deepEqual(ships("effect@4.0.5"), { how: "dependencies", via: ["apps/desktop (dependencies)"] });
  // zod 4.6.6 is what the staged install resolved: not in this lockfile, so only the stage record says it ships.
  assert.equal(ships("zod@4.6.6").how, "unknown");
  assert.equal(shipsIn({ lock: REAL, staged: new Set(["zod@4.6.6"]), complete: true })("zod@4.6.6").how, "staged");
});

// ------------------------------------------------------------ the issues ----

const at = (pkg, how, via = []) => ({ pkg, fixed: ["9.9.9"], ...(how ? { ships: { how, via } } : {}) });
const advisory = (id, severity, packages) => ({ id, aliases: [], summary: `${id} summary`, severity, packages, sources: ["osv"], origins: [{ id, source: "osv", summary: `${id} summary` }] });

test("the issues label each version, list what ships first, and stay inert", async () => {
  const hostile = "@owner [x](https://evil.example) pwn@evil";
  const report = {
    channel: "nightly",
    release: "v0.1.7-nightly.20261102.4093",
    sha: "8".repeat(40),
    sources: [],
    gaps: [],
    open: [
      advisory("GHSA-2222-3333-4444", "CRITICAL", [at("zod@3.25.76", "unpackaged", ["@expo/cli@58.1.11", "apps/mobile (dependencies)"])]),
      advisory("GHSA-5555-6666-7777", "HIGH", [at("zod@3.25.76", "unpackaged"), at("zod@4.6.6", "staged")]),
      advisory("GHSA-8888-9999-cccc", "HIGH", [at("zod@3.25.76", "dev-dependencies", ["@vercel/config@0.3.0", "apps/web (devDependencies)"])]),
      advisory("GHSA-cfgh-jmpq-rvwx", "HIGH", [at("uuid@7.0.3", "unpackaged", [hostile, "a", "b", "c", "d", "e", "apps/mobile (dependencies)"])]),
      advisory("GHSA-cfgh-jmpq-rvwc", "LOW", [at("calm@1.0.0", "bogus"), at("calm@1.0.1")]),
    ],
  };
  // What ships comes first, then by rating: the critical tooling-only advisory goes last.
  const zod = packageFindings(report).get("zod");
  assert.deepEqual(zod.entries.map((e) => e.a.id), ["GHSA-5555-6666-7777", "GHSA-8888-9999-cccc", "GHSA-2222-3333-4444"]);
  assert.deepEqual(zod.entries[0].own.map((p) => p.pkg), ["zod@4.6.6", "zod@3.25.76"]);

  const issues = [];
  const gh = {
    ensureLabel: async () => {},
    openIssues: async () => issues.filter((i) => i.state === "open"),
    comments: async () => [],
    comment: async () => {},
    createIssue: async (fields) => issues.push({ number: issues.length + 1, state: "open", user: { login: "github-actions[bot]", type: "Bot" }, ...fields }),
    updateIssue: async () => {},
  };
  await reconcileAdvisories(report, gh, { log: () => {} });
  const body = (title) => issues.find((i) => i.title === title).body;
  for (const issue of issues) assert.deepEqual(problems(issue.body, { canary: "pwn@evil" }), [], issue.body);

  const zodText = body("[security] zod (nightly)");
  assert.match(zodText, /^Where it ships: \*\*Ships in the app\*\* \(each version below says why/m);
  assert.ok(zodText.includes("  - `zod@4.6.6` → fixed in `9.9.9`. **Ships in the app**: it's in the staged app's node_modules (app.asar)."));
  assert.ok(zodText.includes("  - `zod@3.25.76` → fixed in `9.9.9`. **Ships (couldn't rule it out)**: a packaged app reaches it only through a devDependency, and a bundler takes whatever the code imports, via `@vercel/config@0.3.0` ← `apps/web (devDependencies)`."));
  assert.ok(zodText.includes("  - `zod@3.25.76` → fixed in `9.9.9`. **Build tooling only**: only projects that aren't packaged reach it, via `@expo/cli@58.1.11` ← `apps/mobile (dependencies)`."));
  assert.ok(zodText.indexOf("GHSA-5555-6666-7777") < zodText.indexOf("GHSA-8888-9999-cccc") && zodText.indexOf("GHSA-8888-9999-cccc") < zodText.indexOf("GHSA-2222-3333-4444"));
  assert.ok(zodText.includes("**Build tooling only**: reached only from projects that aren't packaged"), "the labels are defined in the issue");

  // A long path is shortened in the middle, and what it holds stays in code.
  const uuidText = body("[security] uuid (nightly)");
  assert.match(uuidText, /^Where it ships: \*\*Build tooling only\*\*/m);
  assert.ok(uuidText.includes("via `@owner [x](https://evil.example) pwn@evil` ← `a` ← `b` ← `c` ← … ← `apps/mobile (dependencies)`."));

  // Whatever the report doesn't say, or says in a way that can't be read, counts as shipping.
  const list = body("[security] Moderate and low advisories (nightly)");
  assert.equal(list.match(/\*\*Ships \(couldn't rule it out\)\*\*: the check couldn't trace it to the app or away from it\./g).length, 2);
});

// Review regressions: a packaged app's walk that can't follow a workspace link
// can't rule anything out, and a link with targets in several lockfile
// documents is followed to every one of them.
test("a link the lockfile has no project for, or one with targets in several documents, never yields build tooling only", () => {
  const doc = (folder, dep) => `lockfileVersion: '9.0'
importers:
  apps/desktop:
    dependencies:
      shared:
        version: link:../../packages/${folder}
  apps/server: {}
  apps/web: {}
  packages/${folder}:
    dependencies:
      ${dep}:
        version: 1.0.0
packages:
  ${dep}@1.0.0: {}
snapshots:
  ${dep}@1.0.0: {}
`;
  const untraceable = doc("shared", "vuln").replace("  packages/shared:", "  .:").replace("  .:\n    dependencies:", "  .:\n    devDependencies:");
  assert.equal(shipsIn({ lock: untraceable, complete: true })("vuln@1.0.0").how, "unknown");
  const twoDocuments = `${doc("one", "safe")}---\n${doc("two", "vuln")}`;
  const second = shipsIn({ lock: twoDocuments, complete: true })("vuln@1.0.0");
  assert.equal(second.how, "dependencies");
  assert.deepEqual(second.via, ["packages/two (dependencies)", "apps/desktop (dependencies)"]);
});
