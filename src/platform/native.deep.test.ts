// Discovery against the real machine, read-only: what this Mac's own tools
// say, with every program it ran checked against the read-only list; the
// launcher's status through this Node; and sshd's own reading of configs this
// test writes into its temporary folder (`sshd -G`, keyless and unprivileged),
// Match blocks evaluated per connection. Deep tier: it runs real programs.
// Skips where they aren't.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseMachineConfig } from "../core/machine.ts";
import { planSteps } from "../core/planner.ts";
import { present, type Machine } from "../core/resource.ts";
import { systemHost, type Host } from "./host.ts";
import { observe } from "./index.ts";
import { SSHD, SSHD_CONFIG, sshdOf } from "./shared.ts";
import { plan } from "../commands/plan.ts";
import { fakeClock } from "../core/clock.ts";
import { MAC } from "./darwin/fixtures.ts";
import { fakeHost } from "./fake-host.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-native-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const host = systemHost();
const hasG = fs.existsSync(SSHD) && host.exec(SSHD, ["-G", "-f", "/dev/null"]).status === 0;

/** sshd's reading of `text`, written to a config file in the test's folder, evaluated for `users` from each probe address. */
function sshdOn(text: string, users: string[] = []) {
  const file = path.join(dir, `sshd_config-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, text);
  return sshdOf(host, true, present(users), file);
}

const fixtureUsers = "/usr/bin/dscl . -readall /Users RecordName UniqueID PrimaryGroupID UserShell NFSHomeDirectory IsHidden";

/**
 * `blacksand plan` checking PasswordAuthentication no, on the made-up Mac
 * (root, sh; nobody, no login shell) but with the real sshd reading `text`
 * (and `failAccounts`: the account query failing): what it exits and prints.
 */
async function planOn(text: string, { failAccounts = false } = {}) {
  const file = path.join(dir, `sshd_config-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, text);
  const config = JSON.stringify({ schema: "blacksand.machine/1", machine: { id: "m", role: "host" }, sshd: { settings: { PasswordAuthentication: "no" } } });
  const accounts = "RecordName: root\nUniqueID: 0\nPrimaryGroupID: 0\nUserShell: /bin/sh\nNFSHomeDirectory: /var/root\n-\nRecordName: nobody\nUniqueID: -2\nPrimaryGroupID: -2\nUserShell: /usr/bin/false\nNFSHomeDirectory: /var/empty\n";
  const fake = fakeHost({ ...MAC, files: { ...MAC.files, "/tmp/m.json": config }, programs: { ...MAC.programs, [fixtureUsers]: failAccounts ? { status: 1, stderr: "directory service unavailable" } : accounts } });
  const mixed: Host = { ...fake, exec: (f, args, env) => (f === SSHD ? host.exec(f, args.map((a) => (a === SSHD_CONFIG ? file : a)), env) : fake.exec(f, args, env)) };
  let out = "";
  const exit = await plan.run(["--config", "/tmp/m.json"], { json: true, clock: fakeClock(), io: { out: (t) => void (out += t), err: () => {} }, run: () => ({ status: 0, signal: null }), host: mixed });
  return { exit, ...(JSON.parse(out) as { steps: Array<{ action: string }>; warnings: Array<{ code: string }>; observed_sha256: string }) };
}

test("on this Mac: every resource is present, absent or unknown with a reason, through listed read-only programs only", { skip: process.platform !== "darwin" && "macOS only" }, () => {
  const ran: string[] = [];
  const recording: Host = { ...host, exec: (file, args, env) => (ran.push([...Object.keys(env ?? {}).map((k) => `${k}=…`), file, ...args].join(" ")), host.exec(file, args, env)) };
  const started = performance.now();
  const m = observe(recording, { jobs: [], sshdUsers: [] });
  const ms = performance.now() - started;
  assert.equal(m.users.state, "present");
  assert.ok(m.users.state === "present" && m.users.value.some((u) => u.uid === process.getuid?.()), "this account is listed");
  assert.equal(m.groups.state, "present");
  assert.equal(m.jobs.state, "present");
  assert.ok(m.jobs.state === "present" && m.jobs.value.length > 50, "every loaded job, not a filtered few");
  assert.equal(m.sshd.state, "present", JSON.stringify(m.sshd));
  assert.ok(m.sshd.state === "present" && m.sshd.value.connections.length > 0 && m.sshd.value.connections.every((c) => c.settings !== null), "each account that can log in, evaluated");
  assert.notEqual(m.firewall.state, "absent");
  assert.notEqual(m.diskEncryption.state, "absent");
  assert.deepEqual(m.tools.node, { state: "present", value: { path: process.execPath, version: process.version.slice(1) } });
  const allowed = [
    /^\/usr\/bin\/dscl \. -readall /,
    /^\/bin\/launchctl print system$/,
    /^\/usr\/libexec\/ApplicationFirewall\/socketfilterfw --get\w+$/,
    /^\/usr\/bin\/fdesetup status$/,
    /^\/usr\/bin\/xcode-select -p$/,
    /^\/usr\/bin\/plutil -extract CFBundleShortVersionString raw -o - /,
    /^\/usr\/sbin\/sshd -G (?:-T |-ddd )?-f \/etc\/ssh\/sshd_config(?: -C user=[\w.-]+,host=[\d.]+,addr=[\d.]+)?$/,
    /^\/\S+\/git --version$/,
    /^TAILSCALE_BE_CLI=… \/\S+\/tailscale version$/,
  ];
  for (const line of ran) assert.ok(allowed.some((p) => p.test(line)), line);
  assert.ok(!ran.some((line) => line.startsWith("/usr/bin/git ")), "never the shim");
  assert.ok(ms < 5000, `discovery took ${Math.round(ms)} ms`);
});

test("./blacksand status runs on this Node and reports what discovery saw", () => {
  const launcher = fileURLToPath(new URL("../../blacksand", import.meta.url));
  const result = spawnSync(launcher, ["status", "--json"], { encoding: "utf8", env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.node, process.version);
  assert.ok(status.resources.some((r: { id: string }) => r.id === "tool/node"));
});

test("sshd -G reads a config without a host key or root, and keeps each pattern sshd keeps: a quoted one is one, never joined or split", { skip: !hasG && "no sshd with -G here" }, () => {
  const one = sshdOn('DenyUsers "root agent"\n');
  const two = sshdOn("DenyUsers root agent\n");
  assert.deepEqual(one.state === "present" && one.value.settings.denyusers, ["root agent"]);
  assert.deepEqual(two.state === "present" && two.value.settings.denyusers, ["root", "agent"]);
  const first = sshdOn("PasswordAuthentication yes\nPasswordAuthentication no\n");
  assert.deepEqual(first.state === "present" && first.value.settings.passwordauthentication, ["yes"], "sshd's own first-value rule");
});

test("a config sshd refuses, or one including a file only root can read, is unknown: nothing guesses", { skip: !hasG && "no sshd with -G here" }, () => {
  assert.equal(sshdOn("Bogus yes\n").state, "unknown");
  assert.equal(sshdOn('AuthenticationMethods "publickey password"\n').state, "unknown");
  const secret = path.join(dir, "secret.conf");
  fs.writeFileSync(secret, "PasswordAuthentication yes\n", { mode: 0o000 });
  const hidden = sshdOn(`Include ${secret}\nPasswordAuthentication no\n`);
  if (process.getuid?.() !== 0) assert.equal(hidden.state, "unknown", JSON.stringify(hidden));
});

test("a Match block giving one account another value shows in its connection, and makes plan drift though the global value matches", { skip: !hasG && "no sshd with -G here" }, () => {
  const seen = sshdOn("PasswordAuthentication no\nMatch User agent\n  PasswordAuthentication yes\nMatch Address 192.168.0.0/16\n  X11Forwarding yes\n", ["agent", "owner"]);
  if (seen.state !== "present") throw new Error(JSON.stringify(seen));
  assert.deepEqual(seen.value.settings.passwordauthentication, ["no"]);
  const yes = seen.value.connections.filter((c) => c.settings?.passwordauthentication?.[0] === "yes").map((c) => c.user);
  assert.deepEqual([...new Set(yes)], ["agent"]);
  assert.deepEqual(seen.value.connections.filter((c) => c.settings?.x11forwarding?.[0] === "yes").map((c) => `${c.user}@${c.addr}`), ["agent@192.168.1.2", "owner@192.168.1.2"]);
  const config = parseMachineConfig({ schema: "blacksand.machine/1", machine: { id: "m", role: "host" }, sshd: { settings: { PasswordAuthentication: "no", X11Forwarding: "no" } } });
  const users = present([
    { name: "agent", uid: 1001, gid: 20, shell: "/bin/zsh", home: "/x", hidden: false },
    { name: "owner", uid: 501, gid: 20, shell: "/bin/zsh", home: "/y", hidden: false },
  ]);
  const machine = { ...observe(host), users, sshd: seen } as Machine;
  const planned = planSteps(config, machine);
  assert.deepEqual(planned.steps.map((s) => s.action), host.uid === 0 ? [] : ["unknown", "unknown"], "unprivileged, sshd's reading isn't its policy");
  assert.deepEqual(planned.warnings.map((w) => w.code), ["drift/sshd-conditional", "drift/sshd-conditional", "drift/sshd-conditional", "unknown/sshd-conditional"]);
});

// What the samples can't see: each of these gives PasswordAuthentication yes to some connection no sample makes.
for (const condition of ["User agent", "Host peer.example", "LocalAddress 127.0.0.1", "User nobody", "Address 192.168.1.3", "Address ::1"]) {
  test(`a Match ${condition} block no sample reaches leaves plan unknown, exit 1, never a match`, { skip: !hasG && "no sshd with -G here" }, async () => {
    const r = await planOn(`UseDNS yes\nPasswordAuthentication no\nMatch ${condition}\n  PasswordAuthentication yes\n`);
    assert.equal(r.exit, 1);
    assert.ok(r.warnings.some((w) => w.code === "unknown/sshd-conditional"), JSON.stringify(r.warnings));
    assert.ok(!r.warnings.some((w) => w.code === "drift/sshd-conditional"), "no sample reached it");
  });
}

test("an Include folder only root can read, which sshd -G skips without a word, leaves plan unknown, exit 1", { skip: (!hasG || process.getuid?.() === 0) && "needs an unprivileged sshd with -G" }, async () => {
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "first.conf"), "PasswordAuthentication yes\n");
  fs.chmodSync(locked, 0);
  try {
    const r = await planOn(`Include ${locked}/*.conf\nPasswordAuthentication no\n`);
    assert.equal(r.exit, 1);
    assert.deepEqual(r.steps.map((s) => s.action), ["unknown"]);
    assert.match(JSON.stringify(r.warnings), /skips an Include folder it can't read/);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("the digest tells a config with an unsampled dangerous Match block from one without, through the Match blocks sshd reports reading", { skip: !hasG && "no sshd with -G here" }, async () => {
  const safe = await planOn("UseDNS yes\nPasswordAuthentication no\n");
  const risky = await planOn("UseDNS yes\nPasswordAuthentication no\nMatch Host peer.example\n  PasswordAuthentication yes\n");
  assert.notEqual(risky.observed_sha256, safe.observed_sha256);
  assert.equal((await planOn("PasswordAuthentication no\n", { failAccounts: true })).exit, 1, "accounts that can't be listed aren't 'no accounts'");
});
