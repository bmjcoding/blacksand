import assert from "node:assert/strict";
import { test } from "node:test";

import { resourcesOf } from "../../core/resource.ts";
import { fakeHost } from "../fake-host.ts";
import { MAC, USERS, sshdConnections, sshdDump } from "./fixtures.ts";
import { observe } from "./observe.ts";

const plan = { jobs: [], sshdUsers: [] };

test("a Mac's users, groups, jobs, sshd, firewall, FileVault and tools, each as a typed resource", () => {
  const m = observe(fakeHost(MAC));
  assert.deepEqual(m.users.state === "present" && m.users.value.map((u) => [u.name, u.uid, u.hidden]), [["nobody", -2, false], ["owner", 501, false], ["_t3blackout", 299, true], ["root", 0, false]]);
  assert.deepEqual(m.groups.state === "present" && m.groups.value.find((g) => g.name === "com.apple.access_ssh"), { name: "com.apple.access_ssh", gid: 399, members: ["owner"] });
  assert.deepEqual(m.jobs.state === "present" && m.jobs.value.map((j) => j.label), ["com.apple.AppleVirtualPlatform.SystemService", "com.apple.example", "com.openssh.sshd", "dev.blacksand.updater", "dev.t3blackout.update"], "every loaded job, not just the ones status shows");
  assert.equal(m.sshd.state === "present" && m.sshd.value.enabled, true);
  assert.deepEqual(m.sshd.state === "present" && m.sshd.value.settings.passwordauthentication, ["no"]);
  assert.deepEqual(m.sshd.state === "present" && m.sshd.value.settings.allowusers, []);
  assert.deepEqual(m.sshd.state === "present" && m.sshd.value.connections, [], "status evaluates no connections");
  assert.deepEqual(m.firewall, { state: "present", value: { enabled: true, stealth: true, blockAll: false } });
  assert.deepEqual(m.diskEncryption, { state: "present", value: { enabled: true } });
  assert.deepEqual(m.tools.git, { state: "present", value: { path: "/opt/homebrew/bin/git", version: "2.56.0" } });
  assert.deepEqual(m.tailscale, { state: "present", value: { path: "/opt/homebrew/bin/tailscale", version: "1.104.4" } });
  assert.equal(m.tools.pnpm.state, "absent");
  assert.ok(resourcesOf(m).some((r) => r.id === "user/_t3blackout"));
});

test("for a plan, sshd is evaluated as every account that can log in, and each the config names, from each probe address", () => {
  const programs = { ...MAC.programs, ...sshdConnections(["agent"], (_, addr) => sshdDump(addr === "192.168.1.2" ? { PasswordAuthentication: "yes" } : {})) };
  const m = observe(fakeHost({ ...MAC, programs }), { jobs: [], sshdUsers: ["agent"] });
  if (m.sshd.state !== "present") throw new Error(JSON.stringify(m.sshd));
  assert.deepEqual([...new Set(m.sshd.value.connections.map((c) => c.user))], ["agent", "owner", "root"], "_t3blackout and nobody have no login shell");
  assert.deepEqual(m.sshd.value.connections.filter((c) => c.settings?.passwordauthentication?.[0] === "yes").map((c) => [c.user, c.addr]), [["agent", "192.168.1.2"]]);
});

test("an sshd without -G (OpenSSH before 9.3), or one that refuses its config, leaves sshd unknown: nothing reads the files instead", () => {
  for (const [stderr, why] of [["sshd: illegal option -- G\nusage: sshd [-46DdeiqTt] …", /no -G \(OpenSSH before 9\.3\)/], ["/etc/ssh/sshd_config line 3: Bad configuration option: Bogus", /Bad configuration option/]] as const) {
    const programs = { ...MAC.programs, "/usr/sbin/sshd -G -f /etc/ssh/sshd_config": { status: 255, stderr } };
    const m = observe(fakeHost({ ...MAC, programs }));
    assert.equal(m.sshd.state, "unknown");
    assert.match(m.sshd.state === "unknown" ? m.sshd.why : "", why);
  }
});

test("every program discovery runs on a Mac is a read-only query by absolute path, never the /usr/bin/git shim; Tailscale is told it's a CLI", () => {
  const host = fakeHost(MAC);
  observe(host, plan);
  const allowed = [
    /^\/usr\/bin\/dscl \. -readall \/(?:Users|Groups) /,
    /^\/bin\/launchctl print system$/,
    /^\/usr\/libexec\/ApplicationFirewall\/socketfilterfw --get(?:globalstate|stealthmode|blockall)$/,
    /^\/usr\/bin\/fdesetup status$/,
    /^\/usr\/bin\/xcode-select -p$/,
    /^\/usr\/bin\/plutil -extract CFBundleShortVersionString raw -o - \S+$/,
    /^\/usr\/sbin\/sshd -G (?:-T |-ddd )?-f \/etc\/ssh\/sshd_config(?: -C user=[\w.-]+,host=[\d.]+,addr=[\d.]+)?$/,
    /^\/\S+\/git --version$/,
    /^TAILSCALE_BE_CLI=1 \/\S+\/tailscale version$/,
  ];
  for (const argv of host.ran) {
    const line = argv.join(" ");
    assert.ok(allowed.some((pattern) => pattern.test(line)), `not a listed read-only query: ${line}`);
    assert.ok(!argv.includes("/usr/bin/git"), "the shim can open an install dialog");
  }
});

test("Apple's developer-tools git is used only when there's no Homebrew git, and a candidate that leads to the shim is skipped", () => {
  const files = { ...MAC.files };
  delete files["/opt/homebrew/bin/git"];
  assert.deepEqual(observe(fakeHost({ ...MAC, files })).tools.git, { state: "present", value: { path: "/Library/Developer/CommandLineTools/usr/bin/git", version: "2.54.0" } });
  const shim = fakeHost({ ...MAC, links: { "/opt/homebrew/bin/git": "/usr/bin/git" } });
  assert.equal(observe(shim).tools.git.state === "present" && (observe(shim).tools.git as { value: { path: string } }).value.path, "/Library/Developer/CommandLineTools/usr/bin/git");
  assert.ok(!shim.ran.some((argv) => argv[0] === "/opt/homebrew/bin/git"), "the link to the shim never runs");
});

test("FileVault counts as on or off only when settled: converting, deferred or anything else is unknown", () => {
  for (const [said, want] of [
    ["FileVault is On.\n", { state: "present", value: { enabled: true } }],
    ["FileVault is Off.\n", { state: "present", value: { enabled: false } }],
    ["FileVault is On.\nEncryption in progress: Percent completed = 12\n", "unknown"],
    ["FileVault is Off.\nDecryption in progress: Percent completed = 80\n", "unknown"],
    ["FileVault is Off.\nDeferred enablement appears to be active for user 'owner'.\n", "unknown"],
    ["Encryption in progress: Percent completed = 12\n", "unknown"],
  ] as const) {
    const m = observe(fakeHost({ ...MAC, programs: { ...MAC.programs, "/usr/bin/fdesetup status": said } }));
    if (want === "unknown") assert.equal(m.diskEncryption.state, "unknown", said);
    else assert.deepEqual(m.diskEncryption, want, said);
  }
});

test("what a tool can't tell is unknown with the reason, never absent", () => {
  const programs = { ...MAC.programs, "/bin/launchctl print system": { status: 113, stderr: "Could not print domain\n" } };
  const m = observe(fakeHost({ ...MAC, programs }));
  assert.equal(m.jobs.state, "unknown");
  assert.deepEqual(resourcesOf(m).find((r) => r.id.startsWith("job/")), { id: "job/*", observed: m.jobs });
});

test("dscl output it can't account for leaves users unknown rather than partly listed", () => {
  const programs = { ...MAC.programs, "/usr/bin/dscl . -readall /Users RecordName UniqueID PrimaryGroupID UserShell NFSHomeDirectory IsHidden": `${USERS}RecordName: twice\nRecordName: twice\n` };
  assert.equal(observe(fakeHost({ ...MAC, programs })).users.state, "unknown");
});
