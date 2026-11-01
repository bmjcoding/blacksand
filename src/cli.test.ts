import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.ts";
import { T3_CLI } from "./commands/t3.ts";
import type { Context } from "./core/command.ts";
import { fakeClock } from "./core/clock.ts";
import { parsePlan } from "./core/plan.ts";
import { applyBlockers } from "./core/planner.ts";
import { MAC, sshdConnections, sshdDump } from "./platform/darwin/fixtures.ts";
import { fakeHost, type FakeMachine } from "./platform/fake-host.ts";

/** Runs a command line with fakes (a made-up Mac by default); returns the exit code, what was printed, and the commands run. */
async function cli(...argv: string[]) {
  return cliOn(MAC, ...argv);
}

async function cliOn(machine: FakeMachine, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const context = (json: boolean): Context => ({
    json,
    io: { out: (text) => void out.push(text), err: (text) => void err.push(text) },
    clock: fakeClock(),
    run: (command, args) => (ran.push([command, ...args]), { status: 7, signal: null }),
    host: fakeHost(machine),
    // verify's real check walks this clone's signed history: packages/t3/test/trust-port.deep.test.mjs runs that.
    headCheck: () => ({ head: null, history: { result: "refused", message: "this clone has no commit" }, tree: { refused: "there's no commit to compare the working tree with", differs: [], outside: [] } }),
  });
  const exit = await runCli(argv, context);
  return { exit, out: out.join(""), err: err.join(""), ran };
}

test("--json gives each command's versioned envelope, before or after the command", async () => {
  for (const [argv, schema, exit] of [
    [["status", "--json"], "blacksand.status/1", 0],
    [["--json", "plan"], "blacksand.plan/1", 4],
    [["verify", "--json"], "blacksand.verify/1", 4],
    [["--json", "help"], "blacksand.help/1", 0],
    [["--json", "nonsense"], "blacksand.error/1", 2],
  ] as const) {
    const r = await cli(...argv);
    assert.equal(r.exit, exit, argv.join(" "));
    assert.equal(JSON.parse(r.out).schema, schema, argv.join(" "));
  }
});

test("with no machine config, plan proposes nothing, says why, and refuses", async () => {
  const r = await cli("plan", "--json");
  const plan = parsePlan(JSON.parse(r.out));
  assert.equal(r.exit, 4);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.config_sha256, null);
  assert.equal(plan.warnings[0]?.code, "plan/no-config");
  assert.match(plan.warnings[0]?.text ?? "", /\/Users\/owner\/\.config\/blacksand\/machine\.json/);
});

const CONFIG = '{"schema":"blacksand.machine/1","machine":{"id":"agent-host","role":"host"},"users":{"_blacksand-egress":{"hidden":true}},"sshd":{"enabled":true}}';

test("plan compares the machine with its config: a plan apply could read, exit 1 for drift and 0 once it matches", async () => {
  const withConfig = { ...MAC, files: { ...MAC.files, "/Users/owner/.config/blacksand/machine.json": CONFIG } };
  const r = await cliOn(withConfig, "plan", "--json");
  const plan = parsePlan(JSON.parse(r.out));
  assert.equal(r.exit, 1);
  assert.deepEqual(plan.machine, { id: "agent-host", role: "host", platform: "darwin-arm64" });
  assert.match(plan.config_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.steps.map((s) => [s.id, s.action]), [["user/_blacksand-egress", "create"]]);
  const text = await cliOn(withConfig, "plan");
  assert.match(text.out, /\+ user\/_blacksand-egress \(widens access\): create the standard account _blacksand-egress/);
  assert.match(text.out, /nothing was applied/);

  const matching = { ...MAC, files: { ...MAC.files, "/tmp/m.json": CONFIG.replace(/"users":\{[^}]*\}\},/, "") } };
  const ok = await cliOn(matching, "plan", "--config", "/tmp/m.json", "--json");
  assert.equal(ok.exit, 0, ok.out);
  assert.deepEqual(parsePlan(JSON.parse(ok.out)).steps, []);
});

const SSHD_CHECK = '{"schema":"blacksand.machine/1","machine":{"id":"agent-host","role":"host"},"sshd":{"settings":{"PasswordAuthentication":"no"}}}';

test("checking an sshd setting unprivileged exits 1: the setting is unknown, coverage is unknown, apply would refuse, and the text claims no match", async () => {
  const machine = { ...MAC, files: { ...MAC.files, "/tmp/m.json": SSHD_CHECK } };
  const r = await cliOn(machine, "plan", "--config", "/tmp/m.json", "--json");
  assert.equal(r.exit, 1);
  const plan = parsePlan(JSON.parse(r.out));
  assert.deepEqual(plan.steps.map((s) => [s.id, s.action]), [["sshd/passwordauthentication", "unknown"]]);
  assert.match(plan.steps[0]?.summary ?? "", /reads passwordauthentication no, but only root's reading is sshd's policy/);
  assert.deepEqual(plan.warnings.map((w) => w.code), ["unknown/sshd-conditional"]);
  assert.equal(applyBlockers(plan).length, 2);
  assert.doesNotMatch((await cliOn(machine, "plan", "--config", "/tmp/m.json")).out, /matches/);
});

test("as root, a Match block giving one connection another value is drift with no step, and coverage stays unknown", async () => {
  const lan = sshdConnections(["owner"], (_, addr) => sshdDump(addr === "192.168.1.2" ? { PasswordAuthentication: "yes" } : {}));
  const machine = { ...MAC, uid: 0, programs: { ...MAC.programs, ...lan }, files: { ...MAC.files, "/tmp/m.json": SSHD_CHECK } };
  const r = await cliOn(machine, "plan", "--config", "/tmp/m.json", "--json");
  assert.equal(r.exit, 1);
  const plan = parsePlan(JSON.parse(r.out));
  assert.deepEqual([plan.steps, plan.warnings.map((w) => w.code)], [[], ["drift/sshd-conditional", "unknown/sshd-conditional"]]);
  assert.match((await cliOn(machine, "plan", "--config", "/tmp/m.json")).out, /^no steps for \/tmp\/m\.json, but 2 warnings to read:/);
});

test("when the accounts can't be listed, sshd coverage says so, it's in the digest, and plan exits 1 even as root", async () => {
  const dscl = "/usr/bin/dscl . -readall /Users RecordName UniqueID PrimaryGroupID UserShell NFSHomeDirectory IsHidden";
  const listed = { ...MAC, uid: 0, files: { ...MAC.files, "/tmp/m.json": SSHD_CHECK } };
  const failing = { ...listed, programs: { ...listed.programs, [dscl]: { status: 1, stderr: "directory service unavailable" } } };
  const r = await cliOn(failing, "plan", "--config", "/tmp/m.json", "--json");
  assert.equal(r.exit, 1);
  const plan = parsePlan(JSON.parse(r.out));
  assert.match(plan.warnings.find((w) => w.code === "unknown/sshd-conditional")?.text ?? "", /the accounts to check couldn't be listed \(dscl exited 1: directory service unavailable\)/);
  assert.notEqual(plan.observed_sha256, parsePlan(JSON.parse((await cliOn(listed, "plan", "--config", "/tmp/m.json", "--json")).out)).observed_sha256);
});

test("a machine config that's missing when named, isn't JSON or has a typo is refused with the reason", async () => {
  for (const [content, why] of [[undefined, /can't be read \(missing\)/], ["{", /isn't JSON/], [CONFIG.replace('"users"', '"user"'), /unknown field user/]] as const) {
    const files = content === undefined ? { ...MAC.files } : { ...MAC.files, "/tmp/m.json": content };
    const r = await cliOn({ ...MAC, files }, "plan", "--config", "/tmp/m.json", "--json");
    assert.equal(r.exit, 4);
    const envelope = JSON.parse(r.out);
    assert.equal(envelope.schema, "blacksand.error/1");
    assert.match(envelope.error.text, why);
  }
  assert.equal((await cli("plan", "--config")).exit, 2);
});

test("status lists what discovery saw: people's accounts and access groups, not the OS's service accounts", async () => {
  const r = await cli("status", "--json");
  const ids = JSON.parse(r.out).resources.map((x: { id: string }) => x.id);
  assert.ok(ids.includes("user/owner") && ids.includes("user/_t3blackout") && ids.includes("group/com.apple.access_ssh") && ids.includes("sshd/service"), ids.join(" "));
  assert.ok(!ids.includes("user/nobody") && !ids.includes("user/root"), ids.join(" "));
  assert.match((await cli("status")).out, /^sshd\/service: enabled=true passwordauthentication=no /m);
});

test("usage errors exit 2 and say what was wrong", async () => {
  for (const argv of [[], ["nonsense"], ["--verbose"], ["status", "extra"], ["--json", "t3", "status"]]) {
    const r = await cli(...argv);
    assert.equal(r.exit, 2, argv.join(" "));
    assert.match(r.err + r.out, /usage|unknown|no command|put options/, argv.join(" "));
  }
});

test("help lists every command, and one command's usage when named", async () => {
  const all = await cli("--help");
  for (const name of ["status", "plan", "verify", "t3"]) assert.match(all.out, new RegExp(`^  ${name} `, "m"));
  assert.match((await cli("help", "verify")).out, /^usage: blacksand verify \[--json\]/);
  assert.match((await cli("plan", "--help")).out, /^usage: blacksand plan/);
});

test("blacksand t3 hands every argument to the t3 CLI, its own --json and --help included, and returns its exit code", async () => {
  const r = await cli("t3", "status", "--json", "--help");
  assert.deepEqual(r.ran, [[process.execPath, T3_CLI, "status", "--json", "--help"]]);
  assert.equal(r.exit, 7);
});

// The launcher runs here with a cheap command; `status` through it, which observes the real machine, is in src/platform/native.deep.test.ts.
test("./blacksand runs the TypeScript entry point with no build step, and decides whether it's root without running anything found on PATH", () => {
  const launcher = fileURLToPath(new URL("../blacksand", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "blacksand-path-"));
  try {
    const marker = join(dir, "ran");
    writeFileSync(join(dir, "id"), `#!/bin/sh\ntouch "${marker}"\necho 0\n`, { mode: 0o755 });
    const nodeDir = process.execPath.replace(/\/node$/, "");
    const result = spawnSync(launcher, ["--json", "help"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${nodeDir}:${process.env.PATH}` } });
    assert.equal(existsSync(marker), false, "a PATH-planted id must never run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schema, "blacksand.help/1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown command answers in JSON when --json comes before or after it", async () => {
  for (const argv of [["--json", "nonsense"], ["nonsense", "--json"]]) {
    const r = await cli(...argv);
    assert.equal(r.exit, 2, argv.join(" "));
    assert.equal(JSON.parse(r.out).schema, "blacksand.error/1", argv.join(" "));
  }
});
