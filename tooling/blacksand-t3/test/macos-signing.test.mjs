// The real staging/signing path, with OS commands and dedicated state replaced
// by scratch fixtures. No host keychain, credentials or signing command is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function staging(name, configured = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-signing-test-"));
  const state = path.join(dir, "state"); fs.mkdirSync(state);
  if (configured) {
    fs.writeFileSync(path.join(state, "signing.keychain-db"), "fixture keychain");
    fs.writeFileSync(path.join(state, "signing.keychain-pass"), "fixture password", { mode: 0o600 });
  }
  const calls = [];
  const command = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: cmd === "security" && args[0] === "find-identity" ? `1) ${"A".repeat(40)} "${name}"\n` : "", stderr: "" };
  };
  globalThis.__blacksandSigningFixture = { spawnSync: command, run: command, capture: () => '"/fixture/login.keychain-db"', log: () => {} };
  const util = dataModule(`export * from ${JSON.stringify(new URL("../lib/util.mjs", import.meta.url).href)}; export const STATE=${JSON.stringify(state)}; export const {run,capture,log}=globalThis.__blacksandSigningFixture;`);
  const url = new URL("../lib/platform/macos.mjs", import.meta.url);
  let source = fs.readFileSync(url, "utf8").replace('import * as childProcess from "node:child_process";', 'const childProcess = globalThis.__blacksandSigningFixture;');
  source = source.replace(/from "(\.\.?\/[^"\n]+)"/g, (_, relative) => `from ${JSON.stringify(relative === "../util.mjs" ? util : new URL(relative, url).href)}`);
  const before = process.env.BLACKSAND_T3_APPS;
  process.env.BLACKSAND_T3_APPS = path.join(dir, "apps");
  try {
    const { default: platform } = await import(dataModule(source));
    let error;
    try { platform.stage(path.join(dir, "fixture.app")); } catch (caught) { error = caught; }
    return { calls, error };
  } finally {
    if (before === undefined) delete process.env.BLACKSAND_T3_APPS; else process.env.BLACKSAND_T3_APPS = before;
    delete globalThis.__blacksandSigningFixture;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("the configured dedicated legacy local identity signs by its hash without replacing it", async () => {
  for (const name of ["T3 Blackout Local Signing", "Blacksand T3 Local Signing"]) {
    const result = await staging(name);
    assert.equal(result.error, undefined);
    const signatures = result.calls.filter(([cmd]) => cmd === "codesign");
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0][1][signatures[0][1].indexOf("--sign") + 1], "A".repeat(40));
    assert.ok(result.calls.every(([cmd]) => cmd !== "op"));
  }
});
test("missing or unrelated configured identities refuse staging without ad-hoc signing", async () => {
  for (const [name, configured] of [["Other Identity", true], ["T3 Blackout Local Signing", false]]) {
    const result = await staging(name, configured);
    assert.match(result.error?.message ?? "", /no configured signing identity/);
    assert.ok(result.calls.every(([cmd]) => cmd !== "codesign" && cmd !== "op"));
  }
});
