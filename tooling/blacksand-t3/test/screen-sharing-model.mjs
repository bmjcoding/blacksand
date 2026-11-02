// A scratch host for scripts/enable-screen-sharing.sh, shared by
// test/screen-sharing-*.test.mjs. The script is sourced with launchctl,
// lsof (per port and process: pid, user, executable, with Serve's real listener
// shapes), Tailscale Serve, sysctl and the directory services stubbed over a
// scratch state folder, and what a tailnet connection to TCP 5900 would reach is
// traced after every launchd or Serve change. Nothing in it touches pf.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";

import { localApi } from "./fake-localapi.mjs";

export const SCRIPT = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "scripts", "enable-screen-sharing.sh");
export const HELPER = path.join(path.dirname(SCRIPT), "host-common.sh");
export const APPLE = "/System/Library/LaunchDaemons/com.apple.screensharing.plist";
export const isMac = process.platform === "darwin";
export const hasApple = isMac && fs.existsSync(APPLE);
export const LIVE = "127.0.0.1:15900";
export const PARKED = "127.0.0.1:15901";
export const ADMIN_GUID = "11111111-2222-3333-4444-555555555555";
export const SERVE_HOST = "t3b-host.tail0000.ts.net";
const TS_IPS = "100.75.232.118\nfd7a:115c:a1e0::1234\n";

export const sourced = (body, env = {}) => spawnSync("bash", ["-c", `set -euo pipefail\nsource ${JSON.stringify(SCRIPT)}\n${body}`], { encoding: "utf8", env: { ...process.env, ...env } });
export const toJson = (file) => JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout);

/** screensharingd's check-in line, as macOS 27.2 logs it. */
export const CHECKIN = (post, capture, loginwindow = 0) =>
  `2026-10-31 09:21:12.162 Df screensharingd[15139:9a5d] SSDaemon_Checkin  port = 9219 agentPort 16643 effectiveUID 501 sessionID 257 agent pid 15140 onconsole 1 vfb 0 loginwindow ${loginwindow} postEventFlag ${post} screenCaptureFlag ${capture}\n`;

// The checks' lock is a kernel flock on $LOCK.
const FLOCK_HOLD = `use Fcntl ":flock"; umask 077; open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX) or exit 1; print "held\\n"; $| = 1; sleep 60;`;
/** Whether another process holds the lock file (a non-blocking try fails). */
export const lockHeld = (file) => spawnSync("/usr/bin/perl", ["-MFcntl=:flock", "-e", 'umask 077; open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1; exit 0', file]).status === 1;
/** A process holding the lock (as a running check would), until released or killed. */
export async function holdLock(file) {
  const child = spawn("/usr/bin/perl", ["-e", FLOCK_HOLD, file], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return { pid: child.pid, release: () => new Promise((resolve) => (child.exitCode !== null ? resolve() : (child.once("exit", resolve), child.kill("SIGKILL")))) };
}

/** launchctl wrapped: the model's launchctl as model_launchctl, for a test's own launchctl around it. */
export const WRAP_LAUNCHCTL = `eval "$(declare -f launchctl | sed '1s/launchctl/model_launchctl/')"`;

/**
 * The scratch host. launchd's one com.apple.screensharing job: loaded from
 * Apple's plist (apple_loaded) or this script's (own_loaded), `launchctl print`
 * naming the plist; its switch on (apple_on) or off, and a bootstrap of a
 * switched-off label refused, as launchd refuses it. The hold job (hold_loaded,
 * on by default unless own_loaded) and the parking job (park_loaded). lsof lists
 * each listener's pid, user and command, and a process's executable (txt):
 * root's launchd (pid 1) for a loaded job's sockets, screensharingd (pid 500,
 * root, Apple's file) during a session, a squatter (pid 4242, uid 501, named
 * screensharingd) on what it got first. Tailscale Serve's TCP 5900 handler is
 * the `mapping` file ("tcp <target>", "free" or "other …"; parked by default,
 * live with own_loaded) and `reach_other` (other handlers mentioning 15900 or
 * 15901) beside it. After every launchd or Serve change, `trace` gets what a
 * tailnet connection to 5900 would reach: "15900 screensharing", "15901 park",
 * … or FOREIGN. State files in `s`:
 *   apple_loaded, own_loaded, apple_on, hold_loaded, park_loaded, check_loaded
 *   disable_fail, disable_fail_once, bootout_fail (a label), bootstrap_fail (I/O errors first)
 *   session, session_fake_exe (a root process named screensharingd running another file)
 *   squat4, squat6 (the squatter's), squat_on_release (it takes 15900 the moment the hold job lets go)
 *   squat_park (a squatter on 127.0.0.1:15901), stuck (screensharingd keeps 15900 after an unload)
 *   backend_wrong (*:15900), backend_v4only, path_unreadable, lsof_fail
 *   mapping, reach_other, lapi_down, ts_absent, serve (Serve's record: empty before its first forward, then "forward")
 *   ts_listen (root's tailscaled on TS_IPS:5900), ts_elsewhere (on a LAN address),
 *   fake_tailscaled (uid 501, named tailscaled), wide (nc on *:5900), ts_down (tailnet_ips fails)
 *   sysctl.<name> (its value; "unreadable": the read fails)
 *   members, member_guids, nested, agents, demoted (admin no more), vnc, rm, user, wanted, apple.plist
 *   dscl_fail, dseditgroup_fail, pgrep_fail
 * `calls` logs launchctl, `serve_calls` Serve writes, `bootstrapped` this script's
 * plist's bootstraps, `pf` any pfctl call; the job's plist goes to `support/`.
 */
export function host(setup = {}) {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-ss-"));
  const own = setup.own_loaded !== undefined && setup.own_loaded !== null;
  const defaults = {
    members: "admin",
    member_guids: ADMIN_GUID,
    user: `admin 501 ${ADMIN_GUID}\n`,
    wanted: "",
    serve: "forward\n",
    park_loaded: "",
    hold_loaded: own ? null : "",
    mapping: `tcp ${own ? LIVE : PARKED}`,
  };
  for (const [name, content] of Object.entries({ ...defaults, ...setup })) if (content !== null) fs.writeFileSync(path.join(s, name), content);
  if (!fs.existsSync(path.join(s, "apple.plist"))) fs.copyFileSync(hasApple ? APPLE : SCRIPT, path.join(s, "apple.plist"));
  fs.mkdirSync(path.join(s, "LaunchDaemons"));
  for (const job of ["hold", "park"]) fs.writeFileSync(path.join(s, "LaunchDaemons", `run.blacksand.screensharing-${job}.plist`), "plist");
  // macOS's log tool, over the sslog file: screensharingd's check-in lines (granted by default).
  fs.writeFileSync(path.join(s, "logtool"), '#!/bin/sh\ncat "$(dirname "$0")/sslog" 2>/dev/null\n', { mode: 0o755 });
  if (!fs.existsSync(path.join(s, "sslog"))) fs.writeFileSync(path.join(s, "sslog"), CHECKIN(1, 1));
  if (own) {
    // A loaded job's plist exists: the one it was loaded from.
    fs.mkdirSync(path.join(s, "support"));
    spawnSync("bash", ["-c", `source ${JSON.stringify(SCRIPT)}\nAPPLE_PLIST=${JSON.stringify(path.join(s, "apple.plist"))}\nrender_own_plist ${JSON.stringify(path.join(s, "support", "com.apple.screensharing.plist"))}`]);
  }
  const prelude = `
S=${JSON.stringify(s)}
WANTED="$S/wanted" USER_FILE="$S/user" SERVE="$S/serve" FAILING="$S/failing" LOCK="$S/lock" VNC_PASSWORD_FILE="$S/vnc" RM_LAUNCHD="$S/rm"
APPLE_PLIST="$S/apple.plist" OWN_DIR="$S/support" OWN_PLIST="$S/support/com.apple.screensharing.plist"
HOLD_PLIST="$S/LaunchDaemons/run.blacksand.screensharing-hold.plist" PARK_PLIST="$S/LaunchDaemons/run.blacksand.screensharing-park.plist"
CHECK_PLIST="$S/LaunchDaemons/run.blacksand.screen-sharing-check.plist" CHECK="$S/libexec/screen-sharing-check" HELPER_DIR="$S/libexec"
LOG_TOOL="$S/logtool"
pfctl() { echo "pfctl $*" >>"$S/pf"; }
chown() { :; }
install() { mkdir -p "\${!#}"; }
# tailscaled's answer for this Mac's tailnet addresses (the real one, through a
# LocalAPI socket, is tested with a hung daemon).
tailnet_ips() { [[ -f $S/ts_down ]] && return 1; printf '${TS_IPS.replace(/\n/g, "\\n")}'; }
sysctl() {
  local file="$S/sysctl.$2"
  if [[ -f $file ]]; then
    [[ "$(cat "$file")" == unreadable ]] && return 1
    cat "$file"
    return 0
  fi
  case "$2" in
    *forwarding) echo 0 ;;
    *check_interface) echo 1 ;;
  esac
}
# What a tailnet connection to TCP 5900 reaches now: Serve's forward, then who has that port on 127.0.0.1.
holder() {
  case "$1" in
    15900)
      if [[ -f $S/squat4 ]]; then echo FOREIGN
      elif [[ -f $S/own_loaded && ! -f $S/backend_wrong ]]; then echo screensharing
      elif [[ -f $S/hold_loaded ]]; then echo hold
      elif [[ -f $S/stuck ]]; then echo stuck-screensharingd
      else echo nothing; fi ;;
    15901)
      if [[ -f $S/squat_park ]]; then echo FOREIGN
      elif [[ -f $S/park_loaded ]]; then echo park
      else echo nothing; fi ;;
  esac
}
reaches() {
  if [[ -f $S/ts_absent ]]; then echo "no tailscaled"; return 0; fi
  # Any spelling of 15900 (localhost:15900, [::1]:15900, …) reaches whoever has it.
  case "$(cat "$S/mapping" 2>/dev/null)" in
    "tcp "*":15900") echo "15900 $(holder 15900)" ;;
    "tcp "*":15901") echo "15901 $(holder 15901)" ;;
    *) echo unmapped ;;
  esac
}
trace() { reaches >>"$S/trace"; }
launchctl() {
  echo "$*" >>"$S/calls"
  local label="\${2#system/}"
  case "$1" in
    print)
      case "$label" in
        com.apple.screensharing)
          [[ -f $S/apple_loaded || -f $S/own_loaded ]] || return 113
          printf 'system/com.apple.screensharing = {\\n\\tactive count = 0\\n'
          if [[ ! -f $S/path_unreadable ]]; then
            if [[ -f $S/apple_loaded ]]; then printf '\\tpath = /System/Library/LaunchDaemons/com.apple.screensharing.plist\\n'; else printf '\\tpath = %s\\n' "$OWN_PLIST"; fi
          fi
          printf '\\tstate = not running\\n\\tsockets = {\\n\\t\\tpath = (not a plist)\\n\\t}\\n}\\n' ;;
        run.blacksand.screensharing-hold) [[ -f $S/hold_loaded ]] ;;
        run.blacksand.screensharing-park) [[ -f $S/park_loaded ]] ;;
        run.blacksand.screen-sharing-check) [[ -f $S/check_loaded ]] ;;
        *) return 113 ;;
      esac ;;
    print-disabled) if [[ ! -f $S/apple_on ]]; then echo '	"com.apple.screensharing" => disabled'; fi ;;
    disable)
      if [[ $label == com.apple.screensharing ]]; then
        [[ -f $S/disable_fail ]] && return 5
        if [[ -f $S/disable_fail_once ]]; then rm -f "$S/disable_fail_once"; return 5; fi
        rm -f "$S/apple_on"
      fi
      trace ;;
    enable) [[ $label == com.apple.screensharing ]] && : >"$S/apple_on"; trace ;;
    bootout)
      if [[ "$(cat "$S/bootout_fail" 2>/dev/null)" == "$label" ]]; then echo "Boot-out failed: 5: Input/output error" >&2; return 5; fi
      case "$label" in
        com.apple.screensharing) rm -f "$S/apple_loaded" "$S/own_loaded" ;;
        run.blacksand.screensharing-hold)
          rm -f "$S/hold_loaded"
          # Someone waiting for the port takes it the moment it's free.
          if [[ -f $S/squat_on_release ]]; then rm -f "$S/squat_on_release"; : >"$S/squat4"; : >"$S/squat6"; fi ;;
        run.blacksand.screensharing-park) rm -f "$S/park_loaded" ;;
        run.blacksand.screen-sharing-check) rm -f "$S/check_loaded" ;;
      esac
      trace ;;
    bootstrap)
      # launchd: a plist that isn't there can't be bootstrapped.
      [[ -f $3 ]] || { echo "Bootstrap failed: 2: No such file or directory" >&2; return 2; }
      case "$3" in
        "$OWN_PLIST")
          local f; f=$(cat "$S/bootstrap_fail" 2>/dev/null || echo 0)
          if ((f > 0)); then echo $((f - 1)) >"$S/bootstrap_fail"; echo "Bootstrap failed: 5: Input/output error" >&2; return 5; fi
          echo "$3" >>"$S/bootstrapped"
          # launchd: a switched-off label can't be bootstrapped, and the label is one job.
          [[ -f $S/apple_on ]] || { echo "Bootstrap failed: 119: Service is disabled" >&2; return 119; }
          [[ -f $S/apple_loaded || -f $S/own_loaded ]] && { echo "Bootstrap failed: 5: Input/output error" >&2; return 5; }
          : >"$S/own_loaded" ;;
        "$HOLD_PLIST") : >"$S/hold_loaded" ;;
        "$PARK_PLIST") : >"$S/park_loaded" ;;
        # The check's RunAtLoad run.
        "$CHECK_PLIST") : >"$S/check_loaded"; run_check periodic >/dev/null 2>&1 || true ;;
      esac
      trace ;;
  esac
}
lsof() {
  local out="" v4=1 v6=1
  # lsof_fail: lsof's own failure (status 1 with an error, as macOS's lsof fails).
  if [[ -f $S/lsof_fail && "$*" == *-iTCP:* ]]; then echo "lsof: something went wrong" >&2; return 1; fi
  case "$*" in
    "-p "*)
      case "$2" in
        1) out=$'p1\\nftxt\\nn/sbin/launchd\\n' ;;
        500) if [[ -f $S/session_fake_exe ]]; then out=$'p500\\nftxt\\nn/tmp/elsewhere/screensharingd\\n'; else out=$'p500\\nftxt\\nn'"$(screensharingd_path)"$'\\n'; fi ;;
        4242) out=$'p4242\\nftxt\\nn/Users/agent/screensharingd\\n' ;;
      esac ;;
    *-iTCP:15900*)
      if [[ -f $S/squat4 || -f $S/squat6 ]]; then
        out+=$'p4242\\ncscreensharingd\\nu501\\n'
        if [[ -f $S/squat4 ]]; then out+=$'n127.0.0.1:15900\\n'; v4=0; fi
        if [[ -f $S/squat6 ]]; then out+=$'n[::1]:15900\\n'; v6=0; fi
      fi
      if [[ -f $S/own_loaded && -f $S/backend_v4only ]]; then v6=0; fi
      if [[ -f $S/own_loaded && -f $S/backend_wrong ]]; then out+=$'p1\\nclaunchd\\nu0\\nn*:15900\\n'
      elif [[ -f $S/own_loaded || -f $S/hold_loaded ]] && ((v4 || v6)); then
        out+=$'p1\\nclaunchd\\nu0\\n'
        if ((v4)); then out+=$'n127.0.0.1:15900\\n'; fi
        if ((v6)); then out+=$'n[::1]:15900\\n'; fi
        if [[ -f $S/own_loaded && ( -f $S/session || -f $S/session_fake_exe ) ]]; then
          out+=$'p500\\ncscreensharingd\\nu0\\n'
          if ((v4)); then out+=$'n127.0.0.1:15900\\n'; fi
          if ((v6)); then out+=$'n[::1]:15900\\n'; fi
        fi
      fi
      if [[ -f $S/stuck && ! -f $S/own_loaded ]]; then out+=$'p500\\ncscreensharingd\\nu0\\nn127.0.0.1:15900\\nn[::1]:15900\\n'; fi ;;
    *-iTCP:15901*)
      if [[ -f $S/squat_park ]]; then out+=$'p4243\\ncnc\\nu501\\nn127.0.0.1:15901\\n'; fi
      if [[ -f $S/park_loaded ]]; then
        out+=$'p1\\nclaunchd\\nu0\\n'
        if [[ ! -f $S/squat_park ]]; then out+=$'n127.0.0.1:15901\\n'; fi
        out+=$'n[::1]:15901\\n'
      fi ;;
    *-iTCP:5900*)
      if [[ -f $S/apple_loaded ]]; then out+=$'p1\\nclaunchd\\nu0\\nn*:5900\\n'; fi
      if [[ -f $S/ts_listen ]]; then out+=$'p77\\nctailscaled\\nu0\\nn100.75.232.118:5900\\nn[fd7a:115c:a1e0::1234]:5900\\n'; fi
      if [[ -f $S/ts_elsewhere ]]; then out+=$'p77\\nctailscaled\\nu0\\nn192.168.1.20:5900\\n'; fi
      if [[ -f $S/fake_tailscaled ]]; then out+=$'p88\\nctailscaled\\nu501\\nn100.75.232.118:5900\\n'; fi
      if [[ -f $S/wide ]]; then out+=$'p9\\ncnc\\nu501\\nn*:5900\\n'; fi ;;
  esac
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}
# Tailscale Serve over the mapping file (the real LocalAPI calls: test/tailscale-serve.deep.test.mjs):
# its inventory (TCP 5900's handler; other handlers mentioning 15900 or 15901) and the exact setter.
tailscaled_up() { [[ ! -f $S/ts_absent ]]; }
serve_inventory() {
  local main
  [[ ! -f $S/lapi_down ]] || { echo "tailscaled didn't give its Serve configuration (stub)"; return 1; }
  main="$(cat "$S/mapping" 2>/dev/null || echo free)"
  [[ $main != free ]] || main=none
  printf '%s\\n%s\\n' "$main" "$(cat "$S/reach_other" 2>/dev/null || true)"
}
serve_tcp_set() {
  local port="$1" from="$2" to="$3" current
  echo "set $port $from $to" >>"$S/serve_calls"
  [[ ! -f $S/lapi_down ]] || { echo "tailscaled refused the Serve change (stub)"; return 1; }
  current="$(cat "$S/mapping" 2>/dev/null || echo free)"
  [[ $current != free ]] || current=none
  [[ $current == "$(handler_of "$from")" && ! -s $S/reach_other ]] || { echo "Tailscale Serve's TCP $port is $current, not $(handler_of "$from") alone; left as it is"; return 1; }
  if [[ $to == none ]]; then echo free >"$S/mapping"; else echo "tcp $to" >"$S/mapping"; fi
  trace
}
# dscl as macOS answers: an attribute the group lacks is status 0 and nothing; dscl_fail: an error (56).
dscl() {
  case "$*" in
    *"/Groups/$ACCESS_GROUP "*) [[ ! -f $S/dscl_fail ]] || return 56 ;;
  esac
  case "$*" in
    *"/Groups/$ACCESS_GROUP GroupMembership") if [[ -f $S/members ]]; then echo "GroupMembership: $(cat "$S/members")"; fi ;;
    *"/Groups/$ACCESS_GROUP GroupMembers") if [[ -f $S/member_guids ]]; then echo "GroupMembers: $(cat "$S/member_guids")"; fi ;;
    *"/Groups/$ACCESS_GROUP NestedGroups") if [[ -f $S/nested ]]; then echo "NestedGroups: $(cat "$S/nested")"; fi ;;
    ". -read /Groups/$ACCESS_GROUP") [[ -f $S/members || -f $S/member_guids ]] ;;
    ". -read /Users/admin GeneratedUID") echo "GeneratedUID: ${ADMIN_GUID}" ;;
    *) return 1 ;;
  esac
}
id() { if [[ "$*" == "-u admin" ]]; then echo 501; else command id "$@"; fi; }
# dseditgroup checkmember as macOS answers: 0 a member, 67 not; dseditgroup_fail: an error (1).
dseditgroup() {
  [[ ! -f $S/dseditgroup_fail ]] || return 1
  if [[ $5 == admin ]]; then [[ ! -f $S/demoted ]] || return 67; return 0; fi
  [[ " $(cat "$S/agents" 2>/dev/null) " == *" $4 "* ]] || return 67
}
# pgrep as macOS answers: 1 for none; pgrep_fail: an error (2).
pgrep() { [[ ! -f $S/pgrep_fail ]] || return 2; [[ -f $S/rm ]]; }
sleep() { :; }
log() { echo "LOG $*"; }
`;
  const run = (body = "if run_check periodic; then echo RESULT ok; else echo RESULT failed; fi") => {
    const out = sourced(`${prelude}\n${body}`);
    return { ...out, ok: /RESULT ok/.test(out.stdout), failed: /RESULT failed/.test(out.stdout) };
  };
  /** The same, in a process group of its own (as launchd runs a job), asynchronously. */
  const start = (body, env = {}) => {
    const child = spawn("bash", ["-c", `set -euo pipefail\nsource ${JSON.stringify(SCRIPT)}\n${prelude}\n${body}`], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const done = new Promise((resolve) => child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr })));
    return { child, done };
  };
  const has = (name) => fs.existsSync(path.join(s, name));
  const read = (name) => (has(name) ? fs.readFileSync(path.join(s, name), "utf8") : "");
  const put = (name, content = "") => fs.writeFileSync(path.join(s, name), content);
  const drop = (name) => fs.rmSync(path.join(s, name), { force: true, recursive: true });
  const until = async (test, ms = 10_000) => {
    const started = Date.now();
    while (!test()) {
      if (Date.now() - started > ms) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** Never, at any change: a tailnet connection reaching anyone but root's jobs. */
  const neverForeign = () => assert.doesNotMatch(read("trace"), /FOREIGN|nothing/, `the trace:\n${read("trace")}`);
  return { s, prelude, run, start, has, read, put, drop, until, neverForeign };
}

/** A host before setup: nothing installed, nothing loaded. */
export const fresh = (setup = {}) => host({ wanted: null, serve: null, hold_loaded: null, park_loaded: null, mapping: null, ...setup });

/** install_all on the scratch host (as admin, with Serve unless `extra` says NO_SERVE=1); the check's first run is the bootstrap stub's. */
export const installBody = (extra = "") => `SUDO_USER=admin NO_SERVE=0
dseditgroup() { if [[ $5 == admin ]]; then return 0; fi; [[ " $(cat "$S/agents" 2>/dev/null) " == *" $4 "* ]] || return 67; }
reconcile_access() { :; }
vnc_password_off() { :; }
${extra}
install_all`;

/**
 * The real Serve helper (real curl, real JXA) against a fake tailscaled LocalAPI
 * holding `config`; the model's `mapping` file follows the daemon's TCP 5900
 * handler, so the trace says what a tailnet connection would reach.
 */
export async function withRealServe(h, config, body, options = {}) {
  const sync = (c) => {
    const own = c.TCP?.[5900];
    h.put("mapping", own === undefined ? "free" : Object.keys(own).length === 1 && typeof own.TCPForward === "string" ? `tcp ${own.TCPForward}` : `other ${JSON.stringify(own)}`);
    return c;
  };
  sync(config);
  const api = await localApi(config, { afterPost: sync, ...options });
  try {
    const out = await h.start(`unset -f tailscaled_up serve_inventory serve_tcp_set\nsource ${JSON.stringify(HELPER)}\n${body}`, api.env).done;
    return { out, api };
  } finally {
    await api.close();
  }
}
