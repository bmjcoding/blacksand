import assert from "node:assert/strict";
import { test } from "node:test";

import { sshdDump } from "../darwin/fixtures.ts";
import { fakeHost, type FakeMachine } from "../fake-host.ts";
import { observe } from "./observe.ts";

const FILES = "/usr/bin/systemctl list-unit-files --no-legend --no-pager --plain -- blacksand-* t3blackout-*";
const SHOW = "/usr/bin/systemctl show --property=Id,LoadState,ActiveState,UnitFileState --";
const unit = (id: string, load: string, active: string, file: string) => `Id=${id}\nLoadState=${load}\nActiveState=${active}\nUnitFileState=${file}\n`;

const UBUNTU: FakeMachine = {
  platform: "linux-arm64",
  uid: 1000,
  home: "/home/owner",
  programs: {
    "/usr/bin/getent passwd": "root:x:0:0:root:/root:/bin/bash\nowner:x:1000:1000:Owner,,,:/home/owner:/bin/bash\nagent-work:x:1001:1001::/home/agent-work:/bin/bash\n",
    "/usr/bin/getent group": "sudo:x:27:owner\nagent-work:x:1001:\n",
    [FILES]: "blacksand-egress.service disabled enabled\n",
    [`${SHOW} blacksand-egress.service ssh.service ssh.socket sshd.service tailscaled.service`]: [
      unit("blacksand-egress.service", "loaded", "inactive", "disabled"),
      unit("ssh.service", "loaded", "active", "enabled"),
      unit("ssh.socket", "loaded", "inactive", "disabled"),
      unit("ssh.service", "loaded", "active", "alias"),
      unit("tailscaled.service", "not-found", "inactive", ""),
    ].join("\n"),
    "/usr/bin/findmnt -n -o SOURCE --target /": "/dev/mapper/ubuntu--vg-root\n",
    "/usr/bin/lsblk -s -n -o TYPE /dev/mapper/ubuntu--vg-root": "lvm\ncrypt\npart\ndisk\n",
    "/usr/sbin/sshd -G -f /etc/ssh/sshd_config": sshdDump({ UsePAM: "yes", KbdInteractiveAuthentication: "no" }).toLowerCase(),
    "/usr/bin/git --version": "git version 2.53.0\n",
    "/usr/bin/tailscale version": "1.104.4\n",
  },
  files: { "/usr/bin/git": "", "/usr/bin/tailscale": "" },
};

test("a Linux machine's accounts, units, sshd, LUKS and tools, read through getent, systemctl show, sshd -G, findmnt and lsblk", () => {
  const m = observe(fakeHost(UBUNTU));
  assert.deepEqual(m.users.state === "present" && m.users.value.find((u) => u.name === "agent-work"), { name: "agent-work", uid: 1001, gid: 1001, shell: "/bin/bash", home: "/home/agent-work", hidden: null });
  assert.deepEqual(m.groups.state === "present" && m.groups.value, [{ name: "sudo", gid: 27, members: ["owner"] }, { name: "agent-work", gid: 1001, members: [] }]);
  assert.deepEqual(m.jobs.state === "present" && m.jobs.value.map((j) => [j.label, j.running, j.enabled]), [
    ["blacksand-egress.service", false, false],
    ["ssh.service", true, true],
    ["ssh.socket", false, false],
    ["sshd.service", true, null],
  ]);
  assert.equal(m.sshd.state === "present" && m.sshd.value.enabled, true, "ssh.service's unit file is enabled");
  assert.deepEqual(m.sshd.state === "present" && m.sshd.value.settings.kbdinteractiveauthentication, ["no"]);
  assert.deepEqual(m.diskEncryption, { state: "present", value: { enabled: true } });
  assert.deepEqual(m.tools.git, { state: "present", value: { path: "/usr/bin/git", version: "2.53.0" } });
  assert.equal(m.tools.pnpm.state, "absent");
});

test("a unit plan names is asked about by name: one systemd can't find is absent, a load error leaves jobs unknown", () => {
  const ask = `${SHOW} blacksand-egress.service blacksand-vm.service ssh.service ssh.socket sshd.service tailscaled.service`;
  const answer = (vm: string) => [unit("blacksand-egress.service", "loaded", "inactive", "disabled"), vm, unit("ssh.service", "loaded", "active", "enabled"), unit("ssh.socket", "loaded", "inactive", "disabled"), unit("ssh.service", "loaded", "active", "alias"), unit("tailscaled.service", "not-found", "inactive", "")].join("\n");
  const missing = observe(fakeHost({ ...UBUNTU, programs: { ...UBUNTU.programs, [ask]: answer(unit("blacksand-vm.service", "not-found", "inactive", "")) } }), { jobs: ["blacksand-vm.service"], sshdUsers: null });
  assert.ok(missing.jobs.state === "present" && !missing.jobs.value.some((j) => j.label === "blacksand-vm.service"));
  const broken = observe(fakeHost({ ...UBUNTU, programs: { ...UBUNTU.programs, [ask]: answer(unit("blacksand-vm.service", "bad-setting", "inactive", "")) } }), { jobs: ["blacksand-vm.service"], sshdUsers: null });
  assert.match(broken.jobs.state === "unknown" ? broken.jobs.why : "", /can't load blacksand-vm\.service \(bad-setting\)/);
});

test("sshd that's running but whose unit files are all disabled is not enabled; one with no file state to read is unknown", () => {
  const ask = `${SHOW} blacksand-egress.service ssh.service ssh.socket sshd.service tailscaled.service`;
  const answer = (sshFile: string) => [unit("blacksand-egress.service", "loaded", "inactive", "disabled"), unit("ssh.service", "loaded", "active", sshFile), unit("ssh.socket", "loaded", "inactive", "disabled"), unit("sshd.service", "not-found", "inactive", ""), unit("tailscaled.service", "not-found", "inactive", "")].join("\n");
  const enabled = (sshFile: string) => {
    const m = observe(fakeHost({ ...UBUNTU, programs: { ...UBUNTU.programs, [ask]: answer(sshFile) } }));
    return m.sshd.state === "present" ? m.sshd.value.enabled : "unknown";
  };
  assert.equal(enabled("disabled"), false);
  assert.equal(enabled("static"), null);
});

test("nftables: unknown without root; as root a table nft confirms missing is a firewall that's off, and one that exists isn't yet taken as enforcing", () => {
  const host = fakeHost(UBUNTU);
  assert.deepEqual(observe(host).firewall, { state: "unknown", why: "reading nftables needs root (sudo blacksand plan)" });
  assert.ok(!host.ran.some(([file]) => file === "/usr/sbin/nft"));
  const asRoot = (answer: { status: number; stdout?: string; stderr?: string }) => observe(fakeHost({ ...UBUNTU, uid: 0, programs: { ...UBUNTU.programs, "/usr/sbin/nft list table inet blacksand": answer } })).firewall;
  assert.deepEqual(asRoot({ status: 1, stderr: "Error: No such file or directory\nlist table inet blacksand\n" }), { state: "present", value: { enabled: false, stealth: null, blockAll: null } });
  assert.equal(asRoot({ status: 0, stdout: "table inet blacksand {\n}\n" }).state, "unknown");
  assert.equal(asRoot({ status: 1, stderr: "netlink: Error: cache initialization failed: Operation not permitted\n" }).state, "unknown");
});

test("a root filesystem on a plain partition isn't encrypted; one on a network share is unknown", () => {
  const plain = { ...UBUNTU.programs, "/usr/bin/lsblk -s -n -o TYPE /dev/mapper/ubuntu--vg-root": "part\ndisk\n" };
  assert.deepEqual(observe(fakeHost({ ...UBUNTU, programs: plain })).diskEncryption, { state: "present", value: { enabled: false } });
  const share = { ...UBUNTU.programs, "/usr/bin/findmnt -n -o SOURCE --target /": "server:/export\n" };
  assert.equal(observe(fakeHost({ ...UBUNTU, programs: share })).diskEncryption.state, "unknown");
});

test("every program discovery runs on Linux is a listed read-only query by absolute path", () => {
  const host = fakeHost({ ...UBUNTU, uid: 0 });
  observe(host, { jobs: [], sshdUsers: [] });
  const allowed = [/^\/usr\/bin\/getent (?:passwd|group)$/, /^\/usr\/bin\/systemctl (?:list-unit-files|show) /, /^\/usr\/bin\/findmnt -n -o SOURCE --target \/$/, /^\/usr\/bin\/lsblk -s -n -o TYPE \S+$/, /^\/usr\/sbin\/nft list table inet blacksand$/, /^\/usr\/sbin\/sshd -G /, /^\/usr\/bin\/(?:git --version|tailscale version)$/];
  for (const argv of host.ran) assert.ok(allowed.some((p) => p.test(argv.join(" "))), argv.join(" "));
});

test("when getent can't list the accounts, sshd's coverage says so: never \"no accounts to check\"", () => {
  const programs = { ...UBUNTU.programs, "/usr/bin/getent passwd": { status: 2, stderr: "getent: NSS backend unavailable" } };
  const m = observe(fakeHost({ ...UBUNTU, programs }), { jobs: [], sshdUsers: [] });
  if (m.sshd.state !== "present") throw new Error(JSON.stringify(m.sshd));
  assert.deepEqual(m.sshd.value.connections, []);
  assert.ok(m.sshd.value.uncovered.some((why) => /accounts to check couldn't be listed \(getent exited 2/.test(why)), m.sshd.value.uncovered.join("; "));
});
