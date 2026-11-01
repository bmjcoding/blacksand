// node --test test/: scripts/enable-screen-sharing.sh, what each check decides.
// Screen Sharing runs under Apple's label from a plist of this script's whose only
// socket is localhost:15900 (127.0.0.1 and ::1), kept out of launchd's
// LaunchDaemons folders; Apple's every-interface job and its switch stay off;
// Tailscale Serve's TCP 5900 forward points at 15900 only while root's launchd (or
// Apple's screensharingd) is verified to hold it on both families, and at the
// parking job's 15901 otherwise, while the hold job keeps 15900. The scratch host
// is test/screen-sharing-model.mjs; the real lsof, plutil, a real process
// with screensharingd's name, and the real Serve helper against a fake LocalAPI
// check what the model can't.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluatePolicyTests, parsePolicy } from "./policy-model.mjs";
import { ADMIN_GUID, APPLE, HELPER, LIVE, PARKED, SCRIPT, SERVE_HOST, WRAP_LAUNCHCTL, hasApple, host, isMac, sourced, toJson, withRealServe } from "./screen-sharing-model.mjs";

const mac = { skip: !isMac && "macOS tools (plutil, osascript)" };

test("nothing in it touches pf, sshd or a firewall; it's ShellCheck-clean and changes nothing without sudo", () => {
  const source = fs.readFileSync(SCRIPT, "utf8").replace(/^\s*#.*$/gm, "");
  for (const tool of [/\bpfctl\b/, /pf\.conf/, /pf\.anchors/, /sshd/, /socketfilterfw/]) assert.doesNotMatch(source, tool, String(tool));
  const lint = spawnSync("shellcheck", ["-S", "warning", "-x", SCRIPT], { encoding: "utf8", cwd: path.dirname(path.dirname(SCRIPT)) });
  if (lint.error?.code !== "ENOENT") assert.equal(lint.status, 0, lint.stdout);
  for (const args of [[], ["--off"], ["--on"], ["--uninstall"], ["check"], ["--status"]]) {
    // As on a machine without a legacy install (test/legacy-install.test.mjs covers that refusal).
    const out = sourced(`legacy_install() { return 1; }\nmain ${args.join(" ")}`);
    assert.equal(out.status, 1);
    assert.match(out.stderr, isMac ? /run with sudo/ : /macOS only/);
  }
});

// ------------------------------------------------------------- the plists --

test("its plist is Apple's, under Apple's label, with one dual-stack loopback socket and nothing advertised", { skip: !hasApple && "macOS's Screen Sharing plist" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-ss-plist-"));
  const out = path.join(dir, "own.plist");
  const made = sourced(`render_own_plist ${JSON.stringify(out)} && echo MADE`);
  assert.match(made.stdout, /MADE/, made.stderr);
  const own = toJson(out);
  const apple = toJson(APPLE);
  assert.equal(own.Label, "com.apple.screensharing", "macOS runs screensharingd under no other label");
  assert.deepEqual(own.Sockets, { Listener: { SockNodeName: "localhost", SockServiceName: "15900" } }, "no family: launchd makes both, and screensharingd crashes on one");
  assert.equal(JSON.stringify(own).includes("Bonjour"), false, "no rfb advertisement on the local network");
  assert.equal(own.Disabled, undefined);
  for (const key of Object.keys(apple)) if (!["Sockets", "Disabled"].includes(key)) assert.deepEqual(own[key], apple[key], key);
  assert.equal(sourced(`OWN_PLIST=${JSON.stringify(out)}\nscreensharingd_path`).stdout.trim(), apple.ProgramArguments[0], "the file whose process may hold its port");
  assert.equal(sourced('echo "$OWN_PLIST"').stdout.trim(), "/Library/Application Support/blacksand/com.apple.screensharing.plist", "outside LaunchDaemons");
});

test("a changed Apple plist still gives a loopback-only socket; one that can't be confirmed is refused", mac, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-ss-plist-"));
  const apple = path.join(dir, "apple.plist");
  fs.writeFileSync(apple, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.apple.screensharing</string>
<key>Disabled</key><true/>
<key>ProgramArguments</key><array><string>/System/x/screensharingd</string></array>
<key>Sockets</key><dict>
  <key>Listener</key><dict><key>SockServiceName</key><string>vnc-server</string><key>Bonjour</key><string>rfb</string></dict>
  <key>Extra</key><dict><key>SockServiceName</key><string>5901</string></dict>
</dict></dict></plist>`);
  const out = path.join(dir, "own.plist");
  assert.match(sourced(`APPLE_PLIST=${JSON.stringify(apple)}\nrender_own_plist ${JSON.stringify(out)} && echo MADE`).stdout, /MADE/);
  assert.deepEqual(toJson(out).Sockets, { Listener: { SockNodeName: "localhost", SockServiceName: "15900" } }, "every other socket gone");
  fs.writeFileSync(apple, "not a plist");
  assert.doesNotMatch(sourced(`APPLE_PLIST=${JSON.stringify(apple)}\nrender_own_plist ${JSON.stringify(out)} && echo MADE`).stdout, /MADE/);
});

test("the hold and parking jobs only hold a port, from boot; the check runs the root-owned copy at boot and every minute", mac, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-ss-jobs-"));
  for (const [label, port] of [["dev.blacksand.screensharing-hold", "15900"], ["dev.blacksand.screensharing-park", "15901"]]) {
    const file = path.join(dir, `${label}.plist`);
    fs.writeFileSync(file, sourced(`render_hold_plist ${label} ${port}`).stdout);
    assert.equal(spawnSync("plutil", ["-lint", "-s", file]).status, 0);
    assert.deepEqual(toJson(file), { Label: label, Program: "/usr/bin/true", UserName: "nobody", inetdCompatibility: { Wait: false }, Sockets: { Listener: { SockNodeName: "localhost", SockServiceName: port } } });
  }
  assert.equal(sourced('echo "$HOLD_PLIST $PARK_PLIST"').stdout.trim(), "/Library/LaunchDaemons/dev.blacksand.screensharing-hold.plist /Library/LaunchDaemons/dev.blacksand.screensharing-park.plist");
  const file = path.join(dir, "check.plist");
  fs.writeFileSync(file, sourced("render_check_plist").stdout);
  const job = toJson(file);
  assert.equal(job.Label, "dev.blacksand.screen-sharing-check");
  assert.deepEqual(job.ProgramArguments, ["/bin/bash", "/usr/local/libexec/blacksand/screen-sharing-check", "check"]);
  assert.equal(job.RunAtLoad, true);
  assert.equal(job.StartInterval, 60);
});

// ------------------------------------------------------------- the policy --

test("the printed grant gives the desktop TCP 5900 on the host and nothing else; either policy fragment works alone and both merge", () => {
  const ADD_PHONE = path.join(path.dirname(SCRIPT), "add-phone-service.sh");
  for (const [args, tags] of [
    [[], { host: "tag:t3b-host", desktop: "tag:t3b-desktop", phone: "tag:t3b-phone" }],
    [["--host-tag", "tag:lab-host", "--desktop-tag", "tag:lab-desktop", "--phone-tag", "tag:lab-phone"], { host: "tag:lab-host", desktop: "tag:lab-desktop", phone: "tag:lab-phone" }],
  ]) {
    const [screen, phone] = [SCRIPT, ADD_PHONE].map((script) => {
      const out = spawnSync("bash", [script, "--print-policy", ...args], { encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      return parsePolicy(out.stdout);
    });
    assert.deepEqual(screen.grants, [{ src: [tags.desktop], dst: [tags.host], ip: ["tcp:5900"] }]);
    const base = [{ src: [tags.desktop], dst: [tags.host], ip: ["tcp:22"] }];
    assert.deepEqual(evaluatePolicyTests({ grants: [...base, ...screen.grants], tests: screen.tests }), []);
    for (const wrong of [["tcp:5900", "udp:5900-5902"], ["tcp:5900-5901"], ["tcp:5900", "tcp:3283"]]) {
      assert.notDeepEqual(evaluatePolicyTests({ grants: [...base, { ...screen.grants[0], ip: wrong }], tests: screen.tests }), [], `${wrong} must fail a test`);
    }
    for (const extra of [{ src: [tags.host], dst: [tags.desktop], ip: ["tcp:5900"] }, { src: [tags.phone], dst: [tags.host], ip: ["tcp:5900"] }]) {
      assert.notDeepEqual(evaluatePolicyTests({ grants: [...base, ...screen.grants, extra], tests: screen.tests }), []);
    }
    // Every tag a fragment names beyond the base policy's is declared in it, and the same way in both.
    for (const fragment of [screen, phone]) {
      const named = new Set();
      for (const grant of fragment.grants) for (const tag of [...grant.src, ...grant.dst]) named.add(tag);
      for (const t of fragment.tests) {
        named.add(t.src);
        for (const destination of [...(t.accept ?? []), ...(t.deny ?? [])]) named.add(destination.slice(0, destination.lastIndexOf(":")));
      }
      for (const tag of named) if (tag !== tags.host && tag !== tags.desktop) assert.ok(fragment.tagOwners?.[tag], `${tag} is declared`);
    }
    for (const tag of Object.keys(screen.tagOwners)) if (phone.tagOwners[tag]) assert.deepEqual(screen.tagOwners[tag], phone.tagOwners[tag], tag);
  }
  assert.equal(spawnSync("bash", [SCRIPT, "--print-policy", "--phone-tag", 'tag:x"}'], { encoding: "utf8" }).status, 1, "a tag that would break the JSON");
});

// ------------------------------------------------------- on, off, the rules --

test("wanted and allowed: Apple's job and its switch off, this one on, loopback only, the forward pointed at it last", mac, () => {
  const h = host({ apple_loaded: "", apple_on: "", ts_listen: "" });
  const out = h.run();
  assert.ok(out.ok, out.stdout + out.stderr);
  assert.equal(h.has("apple_loaded"), false, "Apple's every-interface job unloaded");
  assert.equal(h.has("apple_on"), false, "and switched off for the next restart");
  assert.ok(h.has("own_loaded"));
  assert.equal(h.has("hold_loaded"), false, "the hold job let go of the port for it");
  assert.equal(h.read("mapping"), `tcp ${LIVE}\n`);
  const trace = h.read("trace").trim().split("\n");
  assert.ok(trace.slice(0, -1).every((line) => line === "15901 park"), `parked until it was verified:\n${trace.join("\n")}`);
  assert.equal(trace.at(-1), "15900 screensharing");
  assert.equal(h.read("serve_calls"), `set 5900 ${PARKED} ${LIVE}\n`);
  assert.ok(!fs.readdirSync(path.join(h.s, "LaunchDaemons")).some((name) => name.startsWith("com.apple.screensharing")), "its plist isn't where launchd loads by itself");
  assert.equal(h.read("pf"), "");
  assert.ok(h.run().ok, "a second check changes nothing");
  assert.equal(h.read("bootstrapped").split("\n").filter(Boolean).length, 1, "no reload while it's on");
  h.neverForeign();
  // System Settings switching Screen Sharing on puts Apple's job in place of this one (one label, one
  // job): until the next check, Apple's version listens everywhere. That check puts it all back.
  h.drop("own_loaded");
  h.put("apple_loaded");
  h.put("apple_on");
  assert.ok(h.run().ok);
  assert.equal(h.has("apple_loaded") || h.has("apple_on"), false);
  assert.ok(h.has("own_loaded"));
  assert.equal(h.read("mapping"), `tcp ${LIVE}\n`);
});

test("a sign-in rule broken, or one that can't be read: Screen Sharing off (sessions end), the forward parked first, the reason logged once; fixed, back on", mac, () => {
  for (const [setup, why] of [
    [{ members: "admin family" }, /family may sign in to Screen Sharing; only admin may/],
    [{ member_guids: `${ADMIN_GUID} 99999999-0000-0000-0000-000000000000` }, /another account/],
    [{ nested: "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050" }, /includes a group/],
    [{ members: null, member_guids: null }, /allows every account/],
    [{ user: null }, /no account recorded/],
    [{ vnc: "x" }, /a VNC password is set/],
    [{ rm: "enabled" }, /Remote Management is on/],
    [{ demoted: "" }, /admin is no longer an admin/],
    [{ agents: "admin" }, /admin is in blacksand-agents/],
    [{ dscl_fail: "" }, /Screen Sharing allows every account|can't be read/],
    [{ dseditgroup_fail: "" }, /admin is no longer an admin/],
    [{ pgrep_fail: "" }, /Remote Management is on/],
  ]) {
    const label = JSON.stringify(setup);
    const h = host({ own_loaded: "", ...setup });
    const out = h.run();
    assert.ok(out.failed, label);
    assert.match(out.stdout, new RegExp(`LOG Screen Sharing is off: .*${why.source}`), label);
    assert.equal(h.has("own_loaded"), false, label);
    assert.ok(h.has("hold_loaded"), `${label}: its port held by the hold job`);
    assert.equal(h.read("mapping"), `tcp ${PARKED}\n`, label);
    assert.equal(h.read("trace").trim().split("\n")[0], "15901 park", `${label}: the forward moved before anything else changed`);
    h.neverForeign();
    assert.doesNotMatch(h.run().stdout, /LOG/, `${label}: not logged again every minute`);
  }
  const h = host({ own_loaded: "", vnc: "x" });
  assert.ok(h.run().failed);
  h.drop("vnc");
  const back = h.run();
  assert.ok(back.ok);
  assert.match(back.stdout, /checks pass again; Screen Sharing is on/);
  // Only the agent-group check failing counts as an agent account.
  const agent = host().run(`dseditgroup() { if [[ $5 == admin ]]; then return 0; fi; return 1; }\nif why="$(access_problem)"; then echo "PROBLEM $why"; fi`);
  assert.match(agent.stdout, /PROBLEM admin is in blacksand-agents \(or that can't be checked\)/);
});

test("not wanted (--off): it stays unloaded check after check, never bootstrapped", mac, () => {
  const h = host({ own_loaded: "", wanted: null });
  assert.ok(h.run().ok);
  assert.equal(h.has("own_loaded"), false);
  assert.ok(h.has("hold_loaded"));
  h.drop("bootstrapped");
  assert.ok(h.run().ok);
  assert.equal(h.read("bootstrapped"), "");
  assert.equal(h.read("mapping"), `tcp ${PARKED}\n`);
});

test("TCP 5900 may be open only by root's tailscaled on this Mac's tailnet addresses (Serve's own listeners)", mac, () => {
  const ok = host({ own_loaded: "", ts_listen: "" });
  assert.ok(ok.run().ok, "Serve listening is expected");
  for (const [setup, why] of [
    [{ wide: "" }, /TCP 5900 is open on \*:5900 by nc \(pid 9, uid 501\)/],
    [{ ts_elsewhere: "" }, /open by tailscaled on 192\.168\.1\.20:5900, not one of this Mac's tailnet addresses/],
    [{ ts_listen: "", ts_down: "" }, /this Mac's tailnet addresses can't be read to check it/],
    [{ fake_tailscaled: "" }, /TCP 5900 is open on 100\.75\.232\.118:5900 by tailscaled \(pid 88, uid 501\)/],
  ]) {
    const h = host({ own_loaded: "", ...setup });
    const out = h.run();
    assert.ok(out.failed, JSON.stringify(setup));
    assert.match(out.stdout, why);
    assert.equal(h.has("own_loaded"), false);
  }
});

test("forwarding on, the weak host model, or an unreadable setting keeps it off, Serve listening or not; strict is accepted", mac, () => {
  for (const [file, value, why] of [
    ["sysctl.net.inet.ip.forwarding", "1", /net\.inet\.ip\.forwarding is 1, not 0 \(forwarding on\)/],
    ["sysctl.net.inet6.ip6.forwarding", "unreadable", /net\.inet6\.ip6\.forwarding is unreadable, not 0/],
    ["sysctl.net.inet6.ip6.check_interface", "0", /check_interface is 0 \(weak host model\)/],
    ["sysctl.net.inet.ip.check_interface", "7", /check_interface is 7, not 1 or 2/],
  ]) {
    for (const listening of [{ ts_listen: "" }, {}]) {
      const h = host({ own_loaded: "", [file]: value, ...listening });
      const out = h.run();
      assert.ok(out.failed, `${file}=${value}`);
      assert.match(out.stdout, why);
      assert.equal(h.has("own_loaded"), false);
    }
  }
  const off = host({ "sysctl.net.inet6.ip6.forwarding": "1" });
  assert.ok(off.run().failed);
  assert.equal(off.read("bootstrapped"), "", "never loaded");
  assert.equal(off.read("serve_calls"), "", "and the forward never pointed at it");
  const strict = host({ ts_listen: "", "sysctl.net.inet.ip.check_interface": "2", "sysctl.net.inet6.ip6.check_interface": "2" });
  assert.ok(strict.run().ok);
});

// ------------------------------------------------------------ port custody --

test("Screen Sharing's port must be root's launchd's or Apple's screensharingd's, on both 127.0.0.1 and ::1, and nothing else", { skip: !hasApple && "macOS's Screen Sharing plist" }, () => {
  for (const [setup, why] of [
    [{ backend_wrong: "" }, /TCP 15900 is open on \*:15900 \(launchd, pid 1\); only 127\.0\.0\.1 and ::1 may be/],
    [{ backend_v4only: "" }, /TCP 15900 isn't held on \[::1\]:15900/],
    [{ squat4: "", squat6: "" }, /TCP 15900 is held on 127\.0\.0\.1:15900 by screensharingd \(pid 4242, uid 501\), not root's launchd or \/System\/Library\/CoreServices\/RemoteManagement\/screensharingd\.bundle/],
    [{ squat6: "" }, /held on \[::1\]:15900 by screensharingd \(pid 4242, uid 501\)/],
    [{ session_fake_exe: "" }, /held on 127\.0\.0\.1:15900 by screensharingd \(pid 500, uid 0, running \/tmp\/elsewhere\/screensharingd\)/],
  ]) {
    const h = host({ own_loaded: "", ...setup });
    const out = h.run();
    assert.ok(out.failed, JSON.stringify(setup));
    assert.match(out.stdout, why, JSON.stringify(setup));
    assert.equal(h.read("mapping"), `tcp ${PARKED}\n`, "the forward parked: the tailnet never reaches it");
    h.neverForeign();
  }
  const session = host({ own_loaded: "", session: "" });
  assert.ok(session.run().ok, "Apple's screensharingd on the same sockets during a session");
  // lsof failing is never "nobody listens": the hold job never lets go.
  const blind = host({ lsof_fail: "" });
  assert.ok(blind.run().failed);
  assert.match(blind.run().stdout + blind.read("failing"), /lsof couldn't list who listens on TCP 1590[01]/);
  assert.ok(blind.has("hold_loaded"));
  assert.equal(blind.has("own_loaded"), false);
});

test("a real process named screensharingd, the user's own, is refused by its user, alone or beside launchd's socket", { skip: (!isMac || spawnSync("cc", ["--version"]).status !== 0) && "cc on macOS" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-ss-squat-"));
  fs.writeFileSync(path.join(dir, "listener.c"), `#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <poll.h>
static int listen4(int port) { int fd = socket(AF_INET, SOCK_STREAM, 0); struct sockaddr_in a = {0}; a.sin_len = sizeof(a); a.sin_family = AF_INET; a.sin_port = htons(port); inet_pton(AF_INET, "127.0.0.1", &a.sin_addr); if (fd < 0 || bind(fd, (void *)&a, sizeof(a)) || listen(fd, 8)) exit(2); return fd; }
static int listen6(int port) { int fd = socket(AF_INET6, SOCK_STREAM, 0), one = 1; struct sockaddr_in6 a = {0}; a.sin6_len = sizeof(a); a.sin6_family = AF_INET6; a.sin6_port = htons(port); a.sin6_addr = in6addr_loopback; setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &one, sizeof(one)); if (fd < 0 || bind(fd, (void *)&a, sizeof(a)) || listen(fd, 8)) exit(2); return fd; }
int main(int argc, char **argv) {
  int port = atoi(argv[1]), family = argc > 2 ? atoi(argv[2]) : 0;
  struct pollfd f[2] = {{family == 6 ? -1 : listen4(port), POLLIN, 0}, {family == 4 ? -1 : listen6(port), POLLIN, 0}};
  setbuf(stdout, NULL); printf("ready\\n");
  while (poll(f, 2, 10000) >= 0) for (int i = 0; i < 2; i++) if (f[i].revents & POLLIN) { int c = accept(f[i].fd, NULL, NULL); if (c >= 0) { write(c, "RFB 003.889\\n", 12); close(c); } }
}
`);
  const exe = path.join(dir, "screensharingd");
  assert.equal(spawnSync("cc", ["-o", exe, path.join(dir, "listener.c")]).status, 0);
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const listen = async (family) => {
    const child = spawn(exe, [String(port), ...(family ? [String(family)] : [])], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolve, reject) => (child.stdout.once("data", resolve), child.once("exit", () => reject(new Error("listener exited")))));
    return child;
  };
  const stop = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : (child.once("exit", resolve), child.kill("SIGKILL"))));
  const h = host({ own_loaded: "" });
  for (const [family, fake] of [[0, ""], [4, `lsof() { if [[ "$*" == *-iTCP:* ]]; then command lsof "$@" || true; printf 'p1\\nclaunchd\\nu0\\nn[::1]:${port}\\n'; else command lsof "$@"; fi; }`]]) {
    const child = await listen(family);
    try {
      // The real lsof sees screensharingd, this test's user; a greeting answers too.
      const out = h.run(`${fake || "unset -f lsof"}\nBACKEND_PORT=${port}\nif why="$(port_problem "$BACKEND_PORT" screensharing)"; then echo "REFUSED $why"; else echo ACCEPTED; fi`);
      assert.match(out.stdout, new RegExp(`REFUSED TCP ${port} is held on (127\\.0\\.0\\.1|\\[::1\\]):${port} by screensharingd \\(pid ${child.pid}, uid ${process.getuid()}\\)`), out.stdout + out.stderr);
    } finally {
      await stop(child);
    }
  }
});

test("off, then someone takes Screen Sharing's port: the forward stays parked, and the check names them", mac, () => {
  for (const how of ["not wanted", "a rule broken"]) {
    const h = host({ own_loaded: "", ts_listen: "", ...(how === "not wanted" ? { wanted: null } : { vnc: "x" }) });
    h.run();
    assert.equal(h.has("own_loaded"), false, how);
    assert.ok(h.has("hold_loaded"), how);
    assert.equal(h.run("reaches").stdout.trim(), "15901 park", how);
    // Even if they had got it: the check refuses it and keeps the forward parked.
    h.drop("hold_loaded");
    h.put("squat4");
    h.put("squat6");
    assert.match(h.run().stdout, /dev\.blacksand\.screensharing-hold is loaded, but TCP 15900 is held on 127\.0\.0\.1:15900 by screensharingd \(pid 4242, uid 501\)/, how);
    assert.equal(h.run("reaches").stdout.trim(), "15901 park", how);
  }
});

test("turning on while someone waits for the port: they get it in the gap, the forward is never theirs, and Screen Sharing never loads onto it", mac, () => {
  const h = host({ squat_on_release: "", ts_listen: "" });
  const out = h.run();
  assert.ok(out.failed, out.stdout + out.stderr);
  assert.match(out.stdout, /LOG Screen Sharing could NOT be turned off: the hold job is unloaded, but TCP 15900 is still open: screensharingd 127\.0\.0\.1:15900/);
  assert.equal(h.read("bootstrapped"), "");
  assert.equal(h.read("mapping"), `tcp ${PARKED}`);
  assert.equal(h.read("serve_calls"), "", "never pointed at 15900");
  h.neverForeign();
  // One family verified isn't verified: never pointed at it either.
  const half = host({ backend_v4only: "", ts_listen: "" });
  assert.ok(half.run().failed);
  assert.equal(half.read("serve_calls"), "");
});

test("a setup without Serve (--no-serve) never reads or writes it, tailscaled running or not", mac, () => {
  for (const setup of [{}, { ts_absent: "" }, { lapi_down: "" }]) {
    const h = host({ serve: null, ...setup });
    assert.ok(h.run().ok, JSON.stringify(setup));
    assert.ok(h.has("own_loaded"));
    assert.equal(h.read("serve_calls"), "");
    h.put("vnc", "x");
    assert.ok(h.run().failed);
    assert.equal(h.has("own_loaded"), false, "off without asking Serve");
  }
});

test("a forward that can't be read back as parked (tailscaled not answering, or not running) changes no port's holder: on stays on, off stays off", mac, () => {
  for (const fault of ["lapi_down", "ts_absent"]) {
    const on = host({ own_loaded: "", ts_listen: "", vnc: "x", [fault]: "" });
    const out = on.run();
    assert.ok(out.failed, fault);
    assert.match(out.stdout, /LOG Screen Sharing could NOT be turned off: a VNC password is set .*(can't be read|tailscaled isn't running, so the forward it keeps).*so Screen Sharing stays loaded, holding its port, until the forward can be moved/, fault);
    assert.ok(on.has("own_loaded"), `${fault}: its port never released while the forward may reach it`);
    assert.equal(on.has("apple_on"), false, `${fault}: and the switch off`);
    on.drop(fault);
    assert.ok(on.run().failed, "still a broken rule");
    assert.equal(on.has("own_loaded"), false, `${fault}: off once the forward could be parked`);
    const off = host({ [fault]: "" });
    assert.match(off.run().stdout, /Screen Sharing stays off until it can be/, fault);
    assert.equal(off.has("own_loaded"), false);
    assert.ok(off.has("hold_loaded"), `${fault}: the hold job never moved aside`);
  }
});

test("another Serve handler mentioning either port is never moved past; a parking port someone else holds gets the forward removed, not parked on them", mac, () => {
  const other = host({ reach_other: "foreground session abc: TCP 7000 to 127.0.0.1:15900" });
  const out = other.run();
  assert.ok(out.failed);
  assert.match(out.stdout, /Tailscale Serve isn't parked: TCP 5900 is tcp 127\.0\.0\.1:15901, and these mention TCP 15900 or 15901: foreground session abc: TCP 7000 to 127\.0\.0\.1:15900; left as it is/);
  assert.equal(other.has("own_loaded"), false);
  assert.ok(other.has("hold_loaded"), "the port never changed hands");
  const park = host({ own_loaded: "", ts_listen: "", squat_park: "" });
  const parked = park.run();
  assert.ok(parked.failed);
  assert.match(parked.stdout, /dev\.blacksand\.screensharing-park is loaded, but TCP 15901 is held on 127\.0\.0\.1:15901 by nc \(pid 4243, uid 501\)/);
  assert.equal(park.read("mapping"), "free\n");
  assert.equal(park.has("own_loaded"), false);
  park.neverForeign();
});

// --------------------------------------------------------------- launchd --

const LOAD_CALLS = /^(enable|disable) system\/com\.apple\.screensharing$|^bootstrap system .*\/com\.apple\.screensharing\.plist$/;

test("its plist loads switched on just for the bootstrap: enable, bootstrap, disable, nothing in between; a bootstrap launchd isn't ready for is retried", mac, () => {
  const h = host();
  assert.ok(h.run().ok);
  const all = h.read("calls").split("\n");
  const at = all.indexOf("enable system/com.apple.screensharing");
  assert.deepEqual(all.slice(at, at + 3), ["enable system/com.apple.screensharing", `bootstrap system ${path.join(h.s, "support", "com.apple.screensharing.plist")}`, "disable system/com.apple.screensharing"]);
  assert.equal(all.filter((line) => LOAD_CALLS.test(line)).length, 3);
  assert.equal(h.has("apple_on"), false, "loaded, switched off: boot and System Settings go by the switch");
  const slow = host({ bootstrap_fail: "2" });
  assert.ok(slow.run().ok);
  assert.equal(slow.read("calls").match(/^bootstrap .*com\.apple\.screensharing\.plist$/gm).length, 3);
  const never = host({ bootstrap_fail: "9" });
  assert.match(never.run().stdout, /launchctl bootstrap .* failed 5 times: Bootstrap failed: 5: Input\/output error/);
  assert.equal(never.has("apple_on"), false);
  assert.equal(never.read("calls").split("\n").filter((line) => LOAD_CALLS.test(line)).length, 15, "5 tries of enable, bootstrap, disable");
});

test("a switch that won't go off after the bootstrap unloads the job again; launchctl failures are said, never taken for success", mac, () => {
  const h = host({ disable_fail: "" });
  const out = h.run();
  assert.ok(out.failed);
  assert.equal(h.has("own_loaded"), false, "a switch left on would start Apple's version at the next restart");
  assert.match(out.stdout, /Screen Sharing was loaded, but its switch won't go off .*; so it's unloaded again/);
  h.drop("disable_fail");
  assert.ok(h.run().ok, "fixed: back on");
  const once = host({ disable_fail_once: "", bootout_fail: "com.apple.screensharing" });
  assert.ok(once.run().ok, "a disable that works on its retry");
  assert.equal(once.has("apple_on"), false);
  const both = host({ disable_fail: "", bootout_fail: "com.apple.screensharing" });
  assert.match(both.run().stdout, /its switch won't go off .*; and unloading it failed too: launchd still has com\.apple\.screensharing 10 s after bootout/);
  const apple = host({ apple_loaded: "", bootout_fail: "com.apple.screensharing" });
  assert.match(apple.run().stdout, /Apple's Screen Sharing is still loaded, from \/System\/Library\/LaunchDaemons\/com\.apple\.screensharing\.plist: launchd still has/);
  assert.equal(apple.has("own_loaded"), false);
  const own = host({ own_loaded: "", bootout_fail: "com.apple.screensharing", vnc: "x" });
  assert.match(own.run().stdout, /LOG Screen Sharing could NOT be turned off: a VNC password is set \(.*\); launchd still has com\.apple\.screensharing 10 s after bootout/);
  assert.equal(own.read("mapping"), `tcp ${PARKED}\n`, "the forward parked before the unload was tried");
});

test("the loaded job is told apart by its plist, not its label: Apple's path, or one launchctl doesn't name, is unloaded", mac, () => {
  const ours = host({ own_loaded: "" });
  assert.equal(ours.run("ours_loaded && echo OURS").stdout.trim(), "OURS");
  assert.equal(ours.run(`launchctl() { printf '\\tpath = /private%s\\n' "$OWN_PLIST"; }\nours_loaded && echo OURS`).stdout.trim(), "OURS", "launchd may show it under /private");
  assert.equal(ours.run(`launchctl() { printf '\\tpath = %s.old\\n' "$OWN_PLIST"; }\nours_loaded || echo NOT`).stdout.trim(), "NOT");
  assert.equal(ours.run(`launchctl() { printf '\\t\\tpath = %s\\n' "$OWN_PLIST"; }\nours_loaded || echo NOT`).stdout.trim(), "NOT", "a socket's nested path line isn't the job's");
  const unnamed = host({ own_loaded: "", path_unreadable: "" });
  assert.equal(unnamed.run("apples_loaded && echo APPLES").stdout.trim(), "APPLES");
  assert.ok(unnamed.run().failed);
  assert.equal(unnamed.has("own_loaded"), false, "fails closed");
});

test("a macOS update changing Apple's plist: this job's is made again and the job reloaded", { skip: !hasApple && "macOS's Screen Sharing plist" }, () => {
  const h = host();
  assert.ok(h.run().ok);
  spawnSync("plutil", ["-replace", "EnableTransactions", "-bool", "NO", path.join(h.s, "apple.plist")]);
  const out = h.run();
  assert.ok(out.ok, out.stdout + out.stderr);
  assert.match(out.stderr, /Screen Sharing's plist changed with Apple's; reloading it/);
  assert.equal(toJson(path.join(h.s, "support", "com.apple.screensharing.plist")).EnableTransactions, false);
  assert.match(h.read("calls"), /bootout system\/com\.apple\.screensharing[\s\S]*bootstrap system/);
  h.neverForeign();
});

// ---------------------------------------------- the real Serve helper --

test("with the real Serve parser: only this setup's own live forward is parked, by readback, before 15900 changes hands; anything else that mentions either port stops every change", mac, async () => {
  // Its own forward, Funnel elsewhere left alone: parked, read back, then the swap (the squatter gets nothing).
  const funnel = { TCP: { 5900: { TCPForward: LIVE }, 443: { HTTPS: true } }, Web: { [`${SERVE_HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4773" } } } }, AllowFunnel: { [`${SERVE_HOST}:443`]: true } };
  const own = host({ squat_on_release: "" });
  const { out, api } = await withRealServe(own, funnel, "run_check periodic || echo STATUS=$?");
  assert.match(out.stdout, /STATUS=1/, "the squatter refused");
  assert.equal(api.config().TCP[5900].TCPForward, PARKED);
  assert.deepEqual(api.config().AllowFunnel, funnel.AllowFunnel);
  assert.doesNotMatch(own.read("trace"), /FOREIGN/, own.read("trace"));
  for (const [label, config] of [
    ["another spelling", { TCP: { 5900: { TCPForward: "localhost:15900" } } }],
    ["a leading zero", { TCP: { 5900: { TCPForward: "[::1]:015900" } } }],
    ["foreground session", { TCP: { 5900: { TCPForward: PARKED } }, Foreground: { s1: { TCP: { 7000: { TCPForward: "127.0.0.1:15900" } } } } }],
    ["service", { TCP: { 5900: { TCPForward: PARKED } }, Services: { "svc:x": { TCP: { 80: { TCPForward: "localhost:15901" } } } } }],
    ["web proxy, the port behind a query", { TCP: { 5900: { TCPForward: PARKED }, 443: { HTTPS: true } }, Web: { [`${SERVE_HOST}:443`]: { Handlers: { "/": { Proxy: "http://[::1]:15900?x=:80" } } } } }],
    ["TLS-terminating 5900", { TCP: { 5900: { TCPForward: LIVE, TerminateTLS: SERVE_HOST } } }],
  ]) {
    const h = host({ squat_on_release: "" });
    const { out: refused, api: untouched } = await withRealServe(h, config, "run_check periodic || echo STATUS=$?");
    assert.match(refused.stdout, /STATUS=1/, label);
    assert.match(refused.stdout, /Tailscale Serve isn't parked: .*left as it is \(tailscale serve status\), so no port changes hands/, `${label}\n${refused.stdout}`);
    assert.ok(h.has("hold_loaded"), `${label}: the hold job kept`);
    assert.doesNotMatch(h.read("calls"), /bootout system\/dev\.blacksand\.screensharing-hold/, label);
    assert.equal(untouched.posts.length, 0, `${label}: nothing written`);
  }
});

test("with the real Serve parser: tailscaled absent is unknown, not parked, even if it comes back mid-way; a parser that's killed or answers short is never 'nothing there'", mac, async () => {
  const h = host({ ts_absent: "", squat_on_release: "" });
  const { out, api } = await withRealServe(h, { TCP: { 5900: { TCPForward: LIVE } } }, `tailscaled_up() { [[ ! -f $S/ts_absent ]]; }
${WRAP_LAUNCHCTL}
launchctl() {
  local rc=0
  model_launchctl "$@" || rc=$?
  if [[ $1 == bootout && $2 == system/dev.blacksand.screensharing-hold ]]; then rm -f "$S/ts_absent"; trace; fi
  return "$rc"
}
run_check periodic || echo STATUS=$?`);
  assert.match(out.stdout, /STATUS=1/);
  assert.match(out.stdout, /tailscaled isn't running, so the forward it keeps \(and restores when it starts\) can't be checked/);
  assert.doesNotMatch(h.read("calls"), /bootout system\/dev\.blacksand\.screensharing-hold/, "the hold job never let go");
  assert.equal(api.posts.length, 0);
  for (const fault of [
    `jxa() { if [[ $1 == inventory ]]; then /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE" & local parser=$!; kill -KILL "$parser" 2>/dev/null || true; wait "$parser"; return; fi; /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE"; }`,
    `jxa() { if [[ $1 == inventory ]]; then printf 'none\\n'; return 0; fi; /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE"; }`,
  ]) {
    const on = host({ squat_on_release: "" });
    const { out: check, api: kept } = await withRealServe(on, { TCP: { 5900: { TCPForward: PARKED } } }, `${fault}\nif serve_read; then echo "READ $SV_MAIN"; else echo "REFUSED $SV_WHY"; fi\nrun_check periodic || echo STATUS=$?`);
    assert.match(check.stdout, /REFUSED .*the parser failed/);
    assert.match(check.stdout, /STATUS=1/);
    assert.ok(on.has("hold_loaded"), "the hold job never let go");
    assert.equal(kept.posts.length, 0);
  }
});

test("a tailscaled that accepts and never answers can't keep a check waiting; Screen Sharing keeps its port until the forward can be parked", mac, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-ss-hung-"));
  const socket = path.join(dir, "tailscaled.socket");
  const daemon = spawn(process.execPath, ["-e", `require("net").createServer(() => {}).listen(${JSON.stringify(socket)})`], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
  try {
    const real = `unset -f tailnet_ips tailscaled_up serve_inventory serve_tcp_set\nsource ${JSON.stringify(HELPER)}\nTS_SOCKET=${JSON.stringify(socket)} TS_TIMEOUT=1\nif run_check periodic; then echo RESULT ok; else echo RESULT failed; fi`;
    const h = host({ own_loaded: "", ts_listen: "" });
    const started = Date.now();
    const out = h.run(real);
    assert.ok(Date.now() - started < 15_000, "bounded by the deadlines");
    assert.match(out.stdout, /LOG Screen Sharing could NOT be turned off: TCP 5900 is open by tailscaled .* \(tailscaled didn't answer within 1s\); Tailscale Serve's configuration can't be read .*until the forward can be moved/);
    assert.ok(h.has("own_loaded"));
    assert.equal(h.has("apple_on"), false);
    // What this Mac alone can tell is decided first: a broken local rule never waits on tailscaled for 5900.
    const local = host({ own_loaded: "", ts_listen: "", vnc: "x" });
    const closed = local.run(real);
    assert.match(closed.stdout, /could NOT be turned off: a VNC password is set .*until the forward can be moved/);
    assert.doesNotMatch(closed.stdout, /tailnet addresses can't be read/);
  } finally {
    daemon.kill("SIGKILL");
  }
});
