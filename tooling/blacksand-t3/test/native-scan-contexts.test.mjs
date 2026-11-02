// Deterministic refusal probes; actual immutable native bytes are opt-in deep.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scanPackage } from "../lib/gates.mjs";
import { reviewToolClosure } from "../lib/device-tools.mjs";

const entries = JSON.parse(fs.readFileSync(new URL("../lib/native-scan-contexts.json", import.meta.url), "utf8"));
const lexical = Buffer.from("\0_ZNSt6sentry\0%*sEntry %0d:\0sentry_init sentry_capture_event\0https://gcc.gnu.org/bugzilla\0https://android.googlesource.com/toolchain\0mixpanel https://unreviewed.example.org/events\0");

test("native exceptions never come from a directory, manifest, or similar benign strings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-native-scan-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: entries[0].name, version: entries[0].version }));
    fs.writeFileSync(path.join(dir, "node_datachannel.node"), lexical);
    for (const identity of [undefined, ...entries, { ...entries[0], version: "0.33.7" }, { ...entries[0], integrity: "sha512-substituted" }, { ...entries[0], name: "lookalike" }]) {
      const found = scanPackage(dir, identity);
      assert.deepEqual([...found.hosts].sort(), ["android.googlesource.com", "gcc.gnu.org", "unreviewed.example.org"]);
      assert.deepEqual([...found.analytics].sort(), ["mixpanel", "sentry"]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("closure review keeps native, JS telemetry and compiler-host fetch findings", async () => {
  const review = await reviewToolClosure("tool@1.0.0", null, {
    isKnownHost: () => false,
    check: async () => ({ entry: { sha256: "fixture" }, packages: ["tool@1.0.0", `${entries[0].name}@${entries[0].version}`] }),
    fetch: async (name, version, into) => {
      fs.mkdirSync(into, { recursive: true });
      fs.writeFileSync(path.join(into, "node_datachannel.node"), lexical);
      fs.writeFileSync(path.join(into, "client.js"), "import * as Sentry from '@sentry/node'; Sentry.init({dsn:'https://ingest.example.org/1'}); fetch('https://gcc.gnu.org/real'); fetch('https://android.googlesource.com/real');");
      return { dir: into, identity: { name, version, integrity: entries[0].integrity } };
    },
  });
  assert.equal(review.ok, false);
  assert.match(review.reasons.join(), /new analytics names: mixpanel, sentry/);
  for (const host of ["gcc.gnu.org", "android.googlesource.com", "ingest.example.org", "unreviewed.example.org"]) assert.ok(review.reasons.join().includes(host));
});
