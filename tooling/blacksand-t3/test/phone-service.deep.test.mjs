// node --test test/: scripts/add-phone-service.sh, which installs one agent
// account's always-on server for the phone and maps it into Tailscale Serve.
// The launchd job, ports, policy and Serve steps run sourced, with launchctl,
// lsof and the directory services stubbed; Serve changes go through the real
// helper (scripts/host-common.sh) against a fake LocalAPI.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { localApi } from "./fake-localapi.mjs";
import { evaluatePolicyTests, parsePolicy } from "./policy-model.mjs";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ADD_PHONE = path.join(ROOT, "scripts", "add-phone-service.sh");
const isMac = process.platform === "darwin";

/** A fake app whose app.asar is a packed archive, a regular file, as in a real build. */
function packedApp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-packed-")));
  const app = path.join(dir, "T3 Code (blacksand).app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), Buffer.alloc(4096, 1));
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "T3 Code (blacksand)"));
  return { dir, app };
}

const sourced = (body) => spawnSync("bash", ["-c", `source ${JSON.stringify(ADD_PHONE)}\n${body}`], { encoding: "utf8" });

test("the launchd job runs the root-owned supervisor as the account, at boot, on loopback, with a private umask and no world-readable log", { skip: !isMac && "plutil" }, () => {
  const out = sourced(`NAME=agent-claude PORT=4773 HOME_DIR=/Users/agent-claude
dscl() { echo "UserShell: /bin/zsh"; }
render_plist`);
  assert.equal(out.status, 0, out.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-plist-"));
  const file = path.join(dir, "job.plist");
  fs.writeFileSync(file, out.stdout);
  assert.equal(spawnSync("plutil", ["-lint", "-s", file]).status, 0);
  const job = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout);
  assert.equal(job.Label, "run.blacksand.phone.agent-claude");
  assert.deepEqual(job.ProgramArguments, ["/bin/sh", "/usr/local/libexec/blacksand/phone-server", "4773"]);
  assert.equal(job.UserName, "agent-claude");
  assert.equal(job.EnvironmentVariables.HOME, "/Users/agent-claude");
  assert.equal(job.EnvironmentVariables.SHELL, "/bin/zsh", "the server reads PATH from the account's login shell");
  assert.equal(job.Umask, 0o077);
  assert.equal(job.KeepAlive, true);
  assert.equal(job.StandardOutPath, "/dev/null", "the supervisor writes its own private log; nothing world-readable in /var/log");
  assert.equal(job.EnvironmentVariables.BLACKSAND_T3_APP, undefined, "only /Applications' app");
});

test("the server's port is never where SSH connections pick theirs, never another phone job's, never privileged", () => {
  const out = sourced(`ports_in_use() { echo 4774; }
for p in 80 1023 3773 3900 3972 4774 99999 x 3973 4773; do if why="$(port_problem "$p")"; then echo "$p bad: $why"; else echo "$p ok"; fi; done`);
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n");
  for (const bad of ["80", "1023", "3773", "3900", "3972", "4774", "99999", "x"]) assert.ok(lines.some((line) => line.startsWith(`${bad} bad`)), bad);
  for (const ok of ["3973", "4773"]) assert.ok(lines.includes(`${ok} ok`), ok);
});

test("the printed phone grant opens one HTTPS port from the phone's tag and nothing else, and its tests catch a wider one", () => {
  for (const [args, port, tags] of [
    [[], "443", { host: "tag:t3b-host", desktop: "tag:t3b-desktop", phone: "tag:t3b-phone" }],
    [["--https-port", "8443", "--host-tag", "tag:lab-host", "--desktop-tag", "tag:lab-desktop", "--phone-tag", "tag:lab-phone"], "8443", { host: "tag:lab-host", desktop: "tag:lab-desktop", phone: "tag:lab-phone" }],
  ]) {
    const out = spawnSync("bash", [ADD_PHONE, "--print-policy", ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    const fragment = parsePolicy(out.stdout);
    assert.deepEqual(fragment.grants, [{ src: [tags.phone], dst: [tags.host], ip: [`tcp:${port}`] }]);
    assert.deepEqual(fragment.tagOwners, { [tags.phone]: ["autogroup:admin"] });
    const base = {
      grants: [{ src: [tags.desktop], dst: [tags.host], ip: ["tcp:22"] }],
      tests: [{ src: tags.desktop, accept: [`${tags.host}:22`], deny: [`${tags.host}:80`, `${tags.host}:443`] }],
    };
    const merged = { grants: [...base.grants, ...fragment.grants], tests: [...(port === "443" ? [] : base.tests), ...fragment.tests] };
    assert.deepEqual(evaluatePolicyTests(merged), []);
    // The tests catch the mistakes that matter: a wider grant, or one from the desktop.
    for (const wrong of [["tcp:22"], [`tcp:${port}`, "udp:5900"], ["tcp:1-65535"], ["*"]]) {
      const widened = { ...merged, grants: [base.grants[0], { ...fragment.grants[0], ip: wrong }] };
      assert.notDeepEqual(evaluatePolicyTests(widened), [], `ip ${wrong} must fail a test`);
    }
    const fromDesktop = { ...merged, grants: [...merged.grants, { src: [tags.desktop], dst: [tags.host], ip: [`tcp:${port}`] }] };
    assert.notDeepEqual(evaluatePolicyTests(fromDesktop), []);
  }
  const bad = spawnSync("bash", [ADD_PHONE, "--print-policy", "--phone-tag", "tag:x\"}"], { encoding: "utf8" });
  assert.equal(bad.status, 1, "a tag that would break the JSON is refused");
});

test("everything but --print-policy needs sudo from an admin account", () => {
  // As on a machine without a legacy install (test/legacy-install.test.mjs covers that refusal).
  const out = spawnSync("bash", ["-c", `source ${JSON.stringify(ADD_PHONE)}\nlegacy_install() { return 1; }\nmain agent-claude`], { encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, isMac ? /run with sudo/ : /macOS only/);
});

// ------------------------------------------------------- the packed app --


test("the installed app counts only as a packed archive whose server the app itself (Electron, as the account) can read", () => {
  const check = (app) =>
    sourced(`APP=${JSON.stringify(app)} ELECTRON="$APP/Contents/MacOS/T3 Code (blacksand)" ASAR="$APP/Contents/Resources/app.asar" SERVER="$ASAR/apps/server/dist/bin.mjs" NAME=agent-a HOME_DIR=/tmp
as_user() { shift; "$@"; }
if why="$(app_problem)"; then echo "PROBLEM $why"; else echo OK; fi`);
  const packed = packedApp();
  assert.match(check(packed.app).stdout, /PROBLEM .*has no server inside .*app\.asar/, "node isn't Electron: it can't see inside; Electron can (opt-in test)");
  const unpacked = packedApp();
  fs.rmSync(path.join(unpacked.app, "Contents", "Resources", "app.asar"));
  fs.mkdirSync(path.join(unpacked.app, "Contents", "Resources", "app.asar", "apps", "server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(unpacked.app, "Contents", "Resources", "app.asar", "apps", "server", "dist", "bin.mjs"), "");
  assert.match(check(unpacked.app).stdout, /PROBLEM .*is missing/, "a directory where the archive should be isn't an installed app");
  assert.match(check(path.join(os.tmpdir(), "no-such.app")).stdout, /PROBLEM .*is missing/);
});

test("setup waits for the server to listen, as the account and on 127.0.0.1 only, polling under errexit and pipefail", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-listen-"));
  const calls = path.join(scratch, "calls");
  const answers = path.join(scratch, "answers");
  // lsof's answer per probe: none (status 1, as when nothing listens), ok, or lan.
  const attempt = (lines) => {
    fs.writeFileSync(answers, lines.join("\n") + "\n");
    const out = sourced(`NAME=agent-a PORT=4773 HOME_DIR=/Users/agent-a
echo 0 >${JSON.stringify(calls)}
lsof() {
  # listener_on runs it in a pipeline, a subshell: the count lives in a file.
  local n; n=$(($(cat ${JSON.stringify(calls)}) + 1)); echo "$n" >${JSON.stringify(calls)}
  case "$(sed -n "\${n}p" ${JSON.stringify(answers)})" in
    none) return 1 ;;
    ok) printf 'p1\nLagent-a\nn127.0.0.1:4773\n' ;;
    lan) printf 'p1\nLagent-a\nn*:4773\n' ;;
  esac
}
sleep() { :; }
verify_listener
echo VERIFIED`);
    return { ...out, calls: Number(fs.readFileSync(calls, "utf8")) };
  };
  const late = attempt(["none", "none", "ok"]);
  assert.equal(late.status, 0, late.stderr);
  assert.match(late.stdout, /VERIFIED/);
  assert.equal(late.calls, 3, "two empty probes, then the listener");
  const wide = attempt(["none", "lan"]);
  assert.equal(wide.status, 1);
  assert.match(wide.stderr, /isn't agent-a's on 127\.0\.0\.1 only \(agent-a \*:4773\)/);
  const never = attempt(Array(100).fill("none"));
  assert.equal(never.status, 1);
  assert.match(never.stderr, /nothing listens on port 4773 after 90 s/);
  assert.equal(never.calls, 90);
});

test("a rerun waits for launchd to let go of the old job, and retries a bootstrap launchd isn't ready for", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-launchd-"));
  const run = (failures, { lingering = 0 } = {}) => {
    fs.writeFileSync(path.join(scratch, "fail"), String(failures));
    fs.writeFileSync(path.join(scratch, "linger"), String(lingering));
    fs.writeFileSync(path.join(scratch, "loaded"), "");
    fs.writeFileSync(path.join(scratch, "calls"), "");
    const S = JSON.stringify(scratch);
    const out = sourced(`S=${S}
launchctl() {
  echo "$*" >>"$S/calls"
  case "$1" in
    print) if [[ -f $S/loaded ]]; then l=$(cat "$S/linger"); if ((l > 0)); then echo $((l - 1)) >"$S/linger"; return 0; fi; [[ -f $S/up ]]; else [[ -f $S/up ]]; fi ;;
    bootout) rm -f "$S/up" ;;
    enable) ;;
    bootstrap) f=$(cat "$S/fail"); if ((f > 0)); then echo $((f - 1)) >"$S/fail"; echo "Bootstrap failed: 5: Input/output error" >&2; return 5; fi; rm -f "$S/loaded"; : >"$S/up" ;;
  esac
}
sleep() { :; }
: >"$S/up"
if out="$(job_unload run.blacksand.phone.agent-a)"; then echo UNLOADED; else echo "UNLOAD-FAILED $out"; fi
rm -f "$S/up"
if out="$(job_load run.blacksand.phone.agent-a /tmp/x.plist)"; then echo LOADED; else echo "LOAD-FAILED $out"; fi`);
    return { ...out, calls: fs.readFileSync(path.join(scratch, "calls"), "utf8") };
  };
  const transient = run(2, { lingering: 3 });
  assert.equal(transient.status, 0, transient.stderr);
  assert.match(transient.stdout, /UNLOADED\nLOADED/);
  assert.equal(transient.calls.match(/^bootstrap /gm).length, 3, "two I/O errors, then it loads");
  assert.ok(transient.calls.indexOf("bootout") < transient.calls.lastIndexOf("print system/run.blacksand.phone.agent-a"), "it polled launchd after the bootout");
  const stuck = run(9);
  assert.match(stuck.stdout, /LOAD-FAILED launchctl bootstrap \/tmp\/x\.plist failed 5 times: Bootstrap failed: 5: Input\/output error; see: sudo launchctl print system\/run\.blacksand\.phone\.agent-a/);
});

test("the phone's HTTPS mapping goes through the atomic helper, and a rerun keeps the HTTPS port the account already has", { skip: !isMac && "osascript" }, async () => {
  const api = await localApi({ TCP: { 8443: { HTTPS: true } }, Web: { "t3b-host.tail0000.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4773" } } } } });
  const run = (body) =>
    new Promise((resolve) => {
      // A safe host (this Mac itself has IPv6 forwarding on), nothing else on the HTTPS ports.
      const child = spawn("bash", ["-c", `source ${JSON.stringify(ADD_PHONE)}\ntailnet_name() { echo t3b-host.tail0000.ts.net; }\nsysctl() { case "$2" in *forwarding) echo 0 ;; *) echo 1 ;; esac; }\nlsof() { return 1; }\n${body}`], { env: { ...process.env, ...api.env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  try {
    const rerun = await run(`PORT=4773 HTTPS_PORT=443 HTTPS_PORT_GIVEN=0 SERVE_URL=""\nconfigure_serve\necho "URL=$SERVE_URL"`);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /URL=https:\/\/t3b-host\.tail0000\.ts\.net:8443/);
    assert.equal(api.posts.length, 0, "already this account's: nothing written");
    const second = await run(`PORT=4774 HTTPS_PORT=443 HTTPS_PORT_GIVEN=0 SERVE_URL=""\nconfigure_serve\necho "URL=$SERVE_URL"`);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /URL=https:\/\/t3b-host\.tail0000\.ts\.net\n/);
    assert.equal(api.config().Web["t3b-host.tail0000.ts.net:443"].Handlers["/"].Proxy, "http://127.0.0.1:4774");
    assert.equal(api.config().Web["t3b-host.tail0000.ts.net:8443"].Handlers["/"].Proxy, "http://127.0.0.1:4773", "the other account's mapping kept");
  } finally {
    await api.close();
  }
});


test("a first install picks 4773 when nothing listens there; a busy port or another account's is skipped", { skip: !isMac && "PlistBuddy" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-ports-"));
  const busy = path.join(dir, "busy");
  // lsof answers "listening" for the ports in $BUSY, else status 1 as when nothing listens.
  const choose = (name, busyPorts = "") => {
    fs.writeFileSync(busy, busyPorts);
    return sourced(`PLIST_DIR=${JSON.stringify(dir)} NAME=${name} PORT=""
lsof() { local port="\${2#-iTCP:}"; if grep -qx "$port" ${JSON.stringify(busy)}; then printf 'p1\\nLsomeone\\nn127.0.0.1:%s\\n' "$port"; else return 1; fi; }
choose_port
echo "PORT=$PORT"`);
  };
  const fresh = choose("agent-a");
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /PORT=4773/, "the documented first-install default");
  const taken = choose("agent-a", "4773\n4774\n");
  assert.match(taken.stdout, /PORT=4775/, "busy ports are skipped");
  // agent-a's job already has 4773: agent-b gets the next.
  const plist = path.join(dir, "run.blacksand.phone.agent-a.plist");
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>/usr/local/libexec/blacksand/phone-server</string><string>4773</string></array></dict></plist>`);
  const second = choose("agent-b");
  assert.match(second.stdout, /PORT=4774/, second.stderr);
  const rerun = choose("agent-a", "4773\n");
  assert.match(rerun.stdout, /PORT=4773/, "a rerun keeps the account's own port, listening or not");
  const all = choose("agent-c", Array.from({ length: 100 }, (_, i) => 4773 + i).join("\n") + "\n");
  assert.equal(all.status, 1);
  assert.match(all.stderr, /no free port from 4773; pass --port/);
});

test("Serve's HTTPS port is never SSH's, the standby lane's, Screen Sharing's or a listening service's, and the printed tests never contradict themselves", () => {
  for (const port of ["22", "2222", "5900", "3283", "0", "70000", "x"]) {
    const out = spawnSync("bash", [ADD_PHONE, "--print-policy", "--https-port", port], { encoding: "utf8" });
    assert.equal(out.status, 1, port);
    assert.match(out.stderr, /--https-port/);
  }
  assert.match(spawnSync("bash", [ADD_PHONE, "agent-a", "--https-port", "22"], { encoding: "utf8" }).stderr, /22 is SSH's: Serve on it would take the desktop's SSH/, "refused before sudo is even asked for");
  for (const port of ["443", "8443", "4773", "10000"]) {
    const out = spawnSync("bash", [ADD_PHONE, "--print-policy", "--https-port", port], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    const fragment = parsePolicy(out.stdout);
    for (const t of fragment.tests) for (const accepted of t.accept ?? []) assert.ok(!(t.deny ?? []).includes(accepted), `${port}: ${accepted} accepted and denied`);
    assert.deepEqual(evaluatePolicyTests({ grants: [{ src: ["tag:t3b-desktop"], dst: ["tag:t3b-host"], ip: ["tcp:22"] }, ...fragment.grants], tests: fragment.tests }), [], port);
  }
  // Something else listening on the port: refused; tailscaled (Serve's own listener) isn't something else.
  const listening = (who) =>
    sourced(`lsof() { printf 'p1\nc${who}\nn*:8443\n'; }
if why="$(https_port_problem 8443 listening)"; then echo "PROBLEM $why"; else echo OK; fi`).stdout;
  assert.match(listening("nginx"), /PROBLEM nginx listens on \*:8443: Serve on 8443 would take it over/);
  assert.match(listening("tailscaled"), /OK/);
  // The default too, when it's not the account's mapping already.
  const taken = sourced(`PORT=4773 HTTPS_PORT=443 HTTPS_PORT_GIVEN=0
serve_port_of() { :; }
lsof() { printf 'p1\nchttpd\nn*:443\n'; }
https_port_for; echo "HTTPS_PORT=$HTTPS_PORT"`);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /HTTPS port 443: httpd listens on \*:443/);
});

test("no Serve mapping while the local network could reach Serve's listeners: refused before anything changes, and again just before the write; --no-serve is the desktop-only way", () => {
  const preflight = (forwarding, noServe) =>
    sourced(`HTTPS_PORT=443 HTTPS_PORT_GIVEN=0
sysctl() { case "$2" in *ip6.forwarding) echo ${forwarding} ;; *forwarding) echo 0 ;; *) echo 1 ;; esac; }
preflight_serve ${noServe}; echo PASSED`);
  const unsafe = preflight(1, 0);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /net\.inet6\.ip6\.forwarding is 1, not 0 .* or pass --no-serve for the desktop only\. Nothing was changed\./);
  assert.match(preflight(1, 1).stdout, /PASSED/, "--no-serve: no network path, nothing to refuse");
  assert.match(preflight(0, 0).stdout, /PASSED/);
  // Unsafe by the time of the write: no Serve mapping, the server stays for the desktop.
  const late = sourced(`PORT=4773 HTTPS_PORT=443 HTTPS_PORT_GIVEN=0
tailscaled_up() { return 0; }
tailnet_name() { echo t3b-host.tail0000.ts.net; }
sysctl() { case "$2" in *ip6.forwarding) echo 1 ;; *forwarding) echo 0 ;; *) echo 1 ;; esac; }
serve_add() { echo SERVE-ADDED; }
configure_serve`);
  assert.equal(late.status, 1);
  assert.match(late.stderr, /Not adding the Serve mapping; the server runs on 127\.0\.0\.1:4773 for the desktop only/);
  assert.doesNotMatch(late.stdout, /SERVE-ADDED/);
});

test("a zero-padded port is refused before anything reads it as a number or writes it", { skip: !isMac && "osascript" }, async () => {
  for (const port of ["022", "002222", "0443", "00022", "05900"]) {
    const out = spawnSync("bash", [ADD_PHONE, "--print-policy", "--https-port", port], { encoding: "utf8" });
    assert.equal(out.status, 1, port);
    assert.match(out.stderr, /isn't a port \(1 to 65535, written without leading zeros\)/, port);
  }
  assert.match(sourced(`if why="$(port_problem 04773)"; then echo "PROBLEM $why"; fi`).stdout, /PROBLEM 04773 isn't a port from 1024 to 65535 \(written without leading zeros\)/);
  // Given, it never reaches tailscaled.
  const api = await localApi({});
  try {
    const run = (body) =>
      new Promise((resolve) => {
        const child = spawn("bash", ["-c", `source ${JSON.stringify(ADD_PHONE)}\ntailnet_name() { echo t3b-host.tail0000.ts.net; }\nsysctl() { case "$2" in *forwarding) echo 0 ;; *) echo 1 ;; esac; }\nlsof() { return 1; }\n${body}`], { env: { ...process.env, ...api.env } });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stderr }));
      });
    const given = await run(`PORT=4773 HTTPS_PORT=022 HTTPS_PORT_GIVEN=1\nconfigure_serve`);
    assert.equal(given.status, 1);
    assert.match(given.stderr, /HTTPS port 022: 022 isn't a port/);
    assert.equal(api.posts.length, 0, "no Serve write");
  } finally {
    await api.close();
  }
});

test("--remove takes the Serve mapping off first, read back; a failure on the way leaves the job and its plist (the only record of its port), and a rerun finishes", { skip: !isMac && "osascript" }, async () => {
  const DNS = "t3b-host.tail0000.ts.net";
  const mapped = { TCP: { 8443: { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4773" } } } } };
  // The parser killed in one mode.
  const faulty = (mode) => `jxa() {
  if [[ $1 == ${mode} ]]; then /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE" & local parser=$!; kill -KILL "$parser" 2>/dev/null || true; wait "$parser"; return; fi
  /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE"
}`;
  for (const fault of ["none", "inventory", "release", "tailscaled absent"]) {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-remove-"));
    fs.mkdirSync(path.join(s, "plists"));
    fs.writeFileSync(path.join(s, "phone-server"), "wrapper");
    fs.writeFileSync(path.join(s, "loaded"), "");
    const plist = path.join(s, "plists", "run.blacksand.phone.agent-a.plist");
    fs.writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>${s}/phone-server</string><string>4773</string></array></dict></plist>`);
    const api = await localApi(mapped, { status: { Self: { DNSName: `${DNS}.`, CapMap: { https: [] } } } });
    const run = (body) =>
      new Promise((resolve) => {
        const child = spawn("/bin/bash", ["-c", `set -euo pipefail
source ${JSON.stringify(ADD_PHONE)}
S=${JSON.stringify(s)}
PLIST_DIR="$S/plists" WRAPPER="$S/phone-server"
NAME=agent-a PORT="" HTTPS_PORT=443 HTTPS_PORT_GIVEN=0
lsof() { return 1; }
job_unload() { rm -f "$S/loaded"; }
launchctl() { echo "$*" >>"$S/launchctl-calls"; }
${fault === "tailscaled absent" ? "tailscaled_up() { return 1; }" : ""}
${body}`], { env: { ...process.env, ...api.env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    try {
      const first = await run(`${fault === "inventory" || fault === "release" ? faulty(fault) : ""}\nremove`);
      if (fault === "none") {
        assert.equal(first.status, 0, first.stdout + first.stderr);
        assert.deepEqual(api.config(), {}, "the mapping removed");
        assert.equal(fs.existsSync(plist), false);
        continue;
      }
      assert.equal(first.status, 1, `${fault}: ${first.stdout}${first.stderr}`);
      assert.ok(fs.existsSync(plist), `${fault}: the plist, the only record of its port, kept`);
      assert.ok(fs.existsSync(path.join(s, "loaded")), `${fault}: the job too: its port isn't freed while a mapping may reach it`);
      assert.deepEqual(api.config(), mapped);
      assert.equal(api.posts.length, 0);
      if (fault === "tailscaled absent") {
        assert.match(first.stderr, /tailscaled isn't running, so whether Tailscale Serve still forwards to agent-a's server \(127\.0\.0\.1:4773\) can't be checked; nothing was removed/);
        continue;
      }
      // The parser back: an ordinary rerun finishes the job.
      const retry = await run("remove");
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.match(retry.stdout, /Removed agent-a's phone job/);
      assert.deepEqual(api.config(), {}, `${fault}: the rerun removed the mapping`);
      assert.equal(fs.existsSync(plist), false);
      assert.equal(fs.existsSync(path.join(s, "loaded")), false);
    } finally {
      await api.close();
    }
  }
});

test("--remove frees the server's port only once nothing in Serve mentions it, read back: Funnel elsewhere doesn't stop it; a foreground session, another spelling or a mapping put back after the write keeps the job, and a rerun finishes", { skip: !isMac && "osascript" }, async () => {
  const DNS = "t3b-host.tail0000.ts.net";
  const mapping = () => ({ TCP: { 8443: { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4773" } } } } });
  const funnel = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } }, AllowFunnel: { [`${DNS}:443`]: true } };
  const cases = {
    // Funnel on another port is no reason to keep this one: removed, theirs kept.
    "unrelated Funnel": { config: { ...mapping(), TCP: { ...mapping().TCP, ...funnel.TCP }, Web: { ...mapping().Web, ...funnel.Web }, AllowFunnel: funnel.AllowFunnel }, removed: true, posts: 1, left: funnel },
    // Gone already (a rerun after the job failed to unload, or --no-serve): nothing to write.
    "nothing there": { config: {}, removed: true, posts: 0, left: {} },
    // Set up with --no-serve on a Mac that isn't signed in: no tailnet name is needed to see there's nothing to remove.
    "nothing there, signed out": { config: {}, signedOut: true, removed: true, posts: 0, left: {} },
    // Handlers this didn't make that may reach 4773: refused before any write.
    "foreground session": { config: { ...mapping(), Foreground: { s1: mapping() } }, removed: false, posts: 0, why: /handlers this didn't make that mention 127\.0\.0\.1:4773 \(foreground session s1: .*\); nothing was removed/, fix: () => mapping() },
    "another spelling": { config: { ...mapping(), TCP: { ...mapping().TCP, 9000: { TCPForward: "localhost:4773" } } }, removed: false, posts: 0, why: /\(TCP 9000 to localhost:4773\); nothing was removed/, fix: () => mapping() },
    // Another client puts it back right after the accepted write: the readback sees it.
    "put back after the write": { config: mapping(), removed: false, posts: 1, why: /still has handlers that mention 127\.0\.0\.1:4773 after the removal \(.*:8443\/ to http:\/\/127\.0\.0\.1:4773\); run this again/ },
  };
  for (const [name, c] of Object.entries(cases)) {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-remove-"));
    fs.mkdirSync(path.join(s, "plists"));
    fs.writeFileSync(path.join(s, "phone-server"), "wrapper");
    fs.writeFileSync(path.join(s, "loaded"), "");
    const plist = path.join(s, "plists", "run.blacksand.phone.agent-a.plist");
    fs.writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>${s}/phone-server</string><string>4773</string></array></dict></plist>`);
    let putBack = name === "put back after the write";
    const api = await localApi(c.config, { status: c.signedOut ? null : { Self: { DNSName: `${DNS}.`, CapMap: { https: [] } } }, afterPost: (config) => (putBack ? mapping() : config) });
    const run = () =>
      new Promise((resolve) => {
        const child = spawn("/bin/bash", ["-c", `set -euo pipefail
source ${JSON.stringify(ADD_PHONE)}
S=${JSON.stringify(s)}
PLIST_DIR="$S/plists" WRAPPER="$S/phone-server"
NAME=agent-a PORT="" HTTPS_PORT=443 HTTPS_PORT_GIVEN=0
lsof() { return 1; }
job_unload() { rm -f "$S/loaded"; }
launchctl() { :; }
remove`], { env: { ...process.env, ...api.env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    try {
      const first = await run();
      const label = `${name}: ${first.stdout}${first.stderr}`;
      assert.equal(api.posts.length, c.posts, label);
      if (c.removed) {
        assert.equal(first.status, 0, label);
        assert.match(first.stdout, /Removed agent-a's phone job/);
        assert.deepEqual(api.config(), c.left, label);
        assert.equal(fs.existsSync(plist), false);
        assert.equal(fs.existsSync(path.join(s, "loaded")), false);
        continue;
      }
      assert.equal(first.status, 1, label);
      assert.match(first.stderr, c.why, label);
      assert.doesNotMatch(first.stdout, /Removed agent-a's phone job/, label);
      assert.ok(fs.existsSync(plist), `${label}: the plist, the only record of its port, kept`);
      assert.ok(fs.existsSync(path.join(s, "loaded")), `${label}: the job kept: its port isn't freed while something may reach it`);
      assert.ok(api.config().TCP?.[8443], label);
      // The other handler gone (the session ended, the other client stopped): a rerun finishes.
      putBack = false;
      if (c.fix) {
        const fixed = c.fix();
        await new Promise((resolve) => {
          // Through the API, as tailscale would: read the ETag, write with If-Match.
          const child = spawn("/bin/bash", ["-c", `source ${JSON.stringify(path.join(ROOT, "scripts", "host-common.sh"))}; serve_get && serve_post "$1"`, "_", JSON.stringify(fixed)], { env: { ...process.env, ...api.env }, stdio: "ignore" });
          child.on("close", resolve);
        });
        assert.deepEqual(api.config(), fixed, `${name}: the other handler ended`);
      }
      const retry = await run();
      assert.equal(retry.status, 0, `${name} rerun: ${retry.stdout}${retry.stderr}`);
      assert.match(retry.stdout, /Removed agent-a's phone job/);
      assert.deepEqual(api.config(), {}, `${name}: the rerun removed the mapping`);
      assert.equal(fs.existsSync(plist), false);
      assert.equal(fs.existsSync(path.join(s, "loaded")), false);
    } finally {
      await api.close();
    }
  }
});

test("a rerun with another --port for an installed job is refused before anything changes, so --remove still finds the old port's mapping", { skip: !isMac && "osascript" }, async () => {
  // main's install steps, then remove.
  const DNS = "t3b-host.tail0000.ts.net";
  for (const changeHttps of [false, true]) {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-port-"));
    fs.mkdirSync(path.join(s, "plists"));
    fs.mkdirSync(path.join(s, "agent-a"));
    fs.writeFileSync(path.join(s, "phone-server"), "wrapper");
    const api = await localApi({}, { status: { Self: { DNSName: `${DNS}.`, CapMap: { https: [] } } } });
    const run = (body) =>
      new Promise((resolve) => {
        const child = spawn("/bin/bash", ["-c", `set -euo pipefail
source ${JSON.stringify(ADD_PHONE)}
S=${JSON.stringify(s)}
NAME=agent-a HOME_DIR="$S/agent-a" PLIST_DIR="$S/plists" WRAPPER="$S/phone-server"
HTTPS_PORT=443 HTTPS_PORT_GIVEN=0 SERVE_URL=""
chown() { :; }; dscl() { echo 'UserShell: /bin/zsh'; }; lsof() { return 1; }
forwarding_problem() { return 1; }; stop_ssh_servers() { :; }; launchctl() { :; }
job_unload() { if [[ -f "$S/loaded" ]]; then echo "RELEASED $(cat "$S/active-port")" >>"$S/releases"; fi; rm -f "$S/loaded"; }
job_load() { /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$2" >"$S/active-port"; : >"$S/loaded"; }
listener_on() { if [[ -f "$S/loaded" && "$1" == "$(cat "$S/active-port")" ]]; then echo "$NAME 127.0.0.1:$1"; fi; }
${body}`], { env: { ...process.env, ...api.env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    const plist = path.join(s, "plists", "run.blacksand.phone.agent-a.plist");
    const portOf = () => spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :ProgramArguments:2", plist], { encoding: "utf8" }).stdout.trim();
    const install = "choose_port\ninstall_job\nverify_listener\nconfigure_serve";
    try {
      const first = await run(`PORT=""\n${install}`);
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const mapped = api.config();
      assert.equal(mapped.Web[`${DNS}:443`].Handlers["/"].Proxy, "http://127.0.0.1:4773");
      const moved = await run(`PORT=4774\n${changeHttps ? "HTTPS_PORT=8443 HTTPS_PORT_GIVEN=1\n" : ""}${install}`);
      const label = `${changeHttps ? "with --https-port 8443" : "--port only"}: ${moved.stdout}${moved.stderr}`;
      assert.equal(moved.status, 1, label);
      assert.match(moved.stderr, /agent-a's phone service runs on port 4773: remove the service first \(sudo .* agent-a --remove\), then add it on the new port\. Nothing was changed\./, label);
      assert.equal(portOf(), "4773", `${label}: the plist, the only record of the port, untouched`);
      assert.ok(fs.existsSync(path.join(s, "loaded")), `${label}: the job still running`);
      assert.equal(fs.existsSync(path.join(s, "releases")), false, `${label}: its port never released`);
      assert.deepEqual(api.config(), mapped, label);
      assert.equal(api.posts.length, 1, `${label}: nothing written`);
      // The same port, given or not, is an ordinary rerun.
      const same = await run(`PORT=4773\n${install}`);
      assert.equal(same.status, 0, same.stdout + same.stderr);
      // Removing it, then installing on the new port, is the way: nothing of the old one left.
      const removed = await run('PORT=""\nremove');
      assert.equal(removed.status, 0, removed.stdout + removed.stderr);
      assert.deepEqual(api.config(), {}, "the old mapping removed with it");
      const fresh = await run(`PORT=4774\n${changeHttps ? "HTTPS_PORT=8443 HTTPS_PORT_GIVEN=1\n" : ""}${install}`);
      assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
      assert.equal(portOf(), "4774");
      assert.equal(api.config().Web[`${DNS}:${changeHttps ? 8443 : 443}`].Handlers["/"].Proxy, "http://127.0.0.1:4774");
      // A plist whose port can't be read is never replaced either.
      fs.writeFileSync(plist, "<plist/>");
      const unreadable = await run(`PORT=""\n${install}`);
      assert.equal(unreadable.status, 1);
      assert.match(unreadable.stderr, /can't read agent-a's server port from .*; nothing was changed/);
      assert.equal(fs.readFileSync(plist, "utf8"), "<plist/>");
    } finally {
      await api.close();
    }
  }
});
