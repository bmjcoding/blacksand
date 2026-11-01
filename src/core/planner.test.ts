import assert from "node:assert/strict";
import { test } from "node:test";

import { MAC, sshdConnections, sshdDump } from "../platform/darwin/fixtures.ts";
import { fakeHost, type FakeMachine } from "../platform/fake-host.ts";
import { observe } from "../platform/index.ts";
import { parseMachineConfig, type MachineConfig } from "./machine.ts";
import { applyBlockers, canonicalJson, observedDigest, planSteps, wantedOf } from "./planner.ts";
import { present, unknown, type Machine } from "./resource.ts";

const config = (extra: object): MachineConfig => parseMachineConfig({ schema: "blacksand.machine/1", machine: { id: "agent-host", role: "host" }, ...extra });
/** The made-up Mac as plan observes it for `c`. */
const machine = (c: MachineConfig = config({}), fake: FakeMachine = MAC) => observe(fakeHost(fake), wantedOf(c));
const plan = (c: MachineConfig, fake?: FakeMachine) => planSteps(c, machine(c, fake));
/** The same Mac observed as root: sshd's reading is its policy there (sshd -G as another account may skip an Include). */
const ROOT: FakeMachine = { ...MAC, uid: 0 };
const codes = (planned: { warnings: Array<{ code: string }> }) => planned.warnings.map((w) => w.code);

test("a machine that already matches its config plans no steps and no warnings", () => {
  const planned = plan(
    config({
      users: { owner: { shell: "/bin/zsh", hidden: false } },
      groups: { "com.apple.access_ssh": { members: ["owner"] } },
      jobs: { "com.openssh.sshd": { running: false } },
      sshd: { enabled: true },
      firewall: { enabled: true, stealth: true },
      disk_encryption: true,
      tailscale: true,
      tools: { git: ">=2.55.0", node: "24.x" },
    }),
  );
  assert.deepEqual(planned.steps, []);
  assert.deepEqual(planned.warnings, []);
});

test("what's missing is created, what differs is updated, and each says whether it widens access", () => {
  const { steps } = plan(
    config({
      users: { "_blacksand-egress": { shell: "/usr/bin/false", hidden: true }, _t3blackout: { shell: "/bin/zsh" } },
      groups: { "com.apple.access_ssh": { members: ["owner", "_t3blackout"] } },
      jobs: { "dev.blacksand.vm": {}, "dev.blacksand.updater": { running: false }, "com.apple.example": {} },
      sshd: { settings: { PasswordAuthentication: "no", PermitRootLogin: "no", X11Forwarding: "yes", MaxAuthTries: "3", DenyUsers: ["root", "agent"] } },
      firewall: { stealth: false },
    }),
    ROOT,
  );
  assert.deepEqual(
    steps.map((s) => [s.id, s.action, s.widens_access]),
    [
      ["firewall/system", "update", true],
      ["group/com.apple.access_ssh", "update", true],
      ["job/dev.blacksand.updater", "update", false],
      ["job/dev.blacksand.vm", "create", false],
      ["sshd/denyusers", "update", true],
      ["sshd/maxauthtries", "update", false],
      ["sshd/permitrootlogin", "update", false],
      ["sshd/x11forwarding", "update", true],
      ["user/_blacksand-egress", "create", true],
      ["user/_t3blackout", "update", true],
    ],
  );
  assert.deepEqual(steps.find((s) => s.id === "group/com.apple.access_ssh")?.after, { name: "com.apple.access_ssh", members: ["_t3blackout", "owner"] });
});

test("what can't be seen without root is a step with action unknown, never a guess", () => {
  const m: Machine = { ...machine(), users: unknown("dscl exited 1"), sshd: unknown("sshd -G: /etc/ssh/sshd_config.d/x.conf: Permission denied") };
  const { steps } = planSteps(config({ users: { "_blacksand-egress": {} }, sshd: { settings: { PasswordAuthentication: "no" } } }), m);
  assert.deepEqual(steps.map((s) => [s.id, s.action, s.widens_access]), [["sshd/passwordauthentication", "unknown", true], ["user/_blacksand-egress", "unknown", true]]);
  assert.match(steps[0]?.summary ?? "", /Permission denied/);
});

test("disk encryption, Tailscale and tool versions are checked, not set: a difference is a warning, not a step", () => {
  const m: Machine = { ...machine(), diskEncryption: present({ enabled: false }), tailscale: { state: "absent" } };
  const planned = planSteps(config({ disk_encryption: true, tailscale: true, tools: { git: ">=2.57.0", pnpm: "12.14.0" } }), m);
  assert.deepEqual(planned.steps, []);
  assert.deepEqual(planned.steps, []);
  assert.deepEqual(planned.warnings.map((w) => w.code), ["drift/disk-encryption", "drift/tailscale", "drift/git", "drift/pnpm"]);
  assert.match(planned.warnings[2]?.text ?? "", /is 2\.56\.0 at \/opt\/homebrew\/bin\/git; wanted >=2\.57\.0/);
});

test("a Match block that gives some connection another value than the config wants is drift, never a match", () => {
  const c = config({ users: { owner: {} }, sshd: { settings: { PasswordAuthentication: "no" } } });
  const lan = { ...MAC, programs: { ...MAC.programs, ...sshdConnections(["owner"], (_, addr) => sshdDump(addr === "192.168.1.2" ? { PasswordAuthentication: "yes" } : {})) } };
  const planned = plan(c, { ...lan, uid: 0 });
  assert.deepEqual(planned.steps, [], "the global value matches");
  assert.deepEqual(planned.warnings[0], { code: "drift/sshd-conditional", text: "a Match block gives owner passwordauthentication yes from 192.168.1.2, not what the machine config wants" });
  assert.deepEqual(codes(planned), ["drift/sshd-conditional", "unknown/sshd-conditional"], "a sample's agreement elsewhere proves nothing");
});

test("when the global value is what differs, the step says so once: connections that just inherit it aren't Match warnings", () => {
  const planned = plan(config({ users: { owner: {} }, sshd: { settings: { PasswordAuthentication: "yes" } } }), ROOT);
  assert.deepEqual(planned.steps.map((s) => [s.id, s.action]), [["sshd/passwordauthentication", "update"]]);
  assert.deepEqual(codes(planned), ["unknown/sshd-conditional"]);
});

test("an sshd setting is never a match: unprivileged it's an unknown step; as root coverage is still unknown; either way apply refuses", () => {
  const c = config({ sshd: { settings: { PasswordAuthentication: "no" } } });
  const unprivileged = plan(c);
  assert.deepEqual(unprivileged.steps.map((s) => [s.id, s.action, s.widens_access]), [["sshd/passwordauthentication", "unknown", true]]);
  assert.deepEqual(codes(unprivileged), ["unknown/sshd-conditional"]);
  const root = plan(c, ROOT);
  assert.deepEqual(root.steps, []);
  assert.match(root.warnings[0]?.text ?? "", /the connections checked are samples/);
  assert.equal(applyBlockers(root).length, 1);
  assert.deepEqual(applyBlockers({ steps: [], warnings: [{ code: "drift/git", text: "" }] }), [], "drift alone isn't a blocker: apply fixes or reports it");
});

test("a connection sshd can't evaluate, or an account that doesn't exist yet, is unknown, never assumed to match", () => {
  const programs = Object.fromEntries(Object.entries(MAC.programs ?? {}).filter(([command]) => !command.includes("user=root,")));
  const planned = plan(config({ users: { agent: {} }, sshd: { settings: { PasswordAuthentication: "no" } } }), { ...MAC, programs: { ...programs, ...sshdConnections(["agent"]) } });
  assert.deepEqual([...new Set(planned.warnings.map((w) => w.code))], ["unknown/sshd-conditional"]);
  assert.ok(planned.warnings.some((w) => /couldn't evaluate root from 127\.0\.0\.1/.test(w.text)));
  assert.ok(planned.warnings.some((w) => /agent doesn't exist yet/.test(w.text)));
});

test("a requested field the platform can't show is unknown, never skipped", () => {
  const m = machine(config({ users: { owner: {} } }));
  if (m.users.state !== "present") throw new Error("fixture");
  for (const u of m.users.value) u.hidden = null;
  const planned = planSteps(config({ users: { owner: { hidden: true } }, firewall: { stealth: true } }), { ...m, firewall: present({ enabled: true, stealth: null, blockAll: null }) });
  assert.deepEqual(planned.warnings.map((w) => w.code), ["unknown/user-hidden", "unknown/firewall-stealth"]);
  assert.deepEqual(planned.steps, []);
});

test("the observed digest covers what the plan depends on: it changes with them, and only with them", () => {
  const c = config({ users: { "_blacksand-egress": {} }, sshd: { settings: { PasswordAuthentication: "no" } } });
  const digest = (m: Machine) => observedDigest("darwin-arm64", planSteps(c, m).observed);
  const base = digest(machine(c));
  assert.equal(digest(machine(c)), base, "the same machine twice");
  const lan = { ...MAC, programs: { ...MAC.programs, ...sshdConnections(["owner"], (_, addr) => sshdDump(addr === "192.168.1.2" ? { PasswordAuthentication: "yes" } : {})) } };
  assert.notEqual(digest(machine(c, lan)), base, "what a Match block gives one connection");
  const other = machine(c);
  if (other.users.state !== "present") throw new Error("fixture");
  other.users.value.push({ name: "_blacksand-egress", uid: 450, gid: 20, shell: "/usr/bin/false", home: "/var/empty", hidden: true });
  assert.notEqual(digest(other), base, "the wanted account appearing");
  const unrelated = machine(c);
  if (unrelated.groups.state !== "present") throw new Error("fixture");
  unrelated.groups.value.push({ name: "staff", gid: 20, members: [] });
  assert.equal(digest({ ...unrelated, firewall: present({ enabled: false, stealth: false, blockAll: false }) }), base, "things the plan doesn't touch");
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});
