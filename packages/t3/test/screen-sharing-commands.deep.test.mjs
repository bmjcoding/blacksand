// node --test test/: scripts/enable-screen-sharing.sh, how checks run and the
// commands that run them. Every check (each minute's, and setup's, --on's,
// --off's, --uninstall's) runs under one root lock, in a process group of its
// own, killed at its deadline; one killed or unable to run turns Screen Sharing
// off, and a signal or a kill puts the switch back off first. Setup, --off and
// --uninstall say what's true, and an uninstall that stops can be rerun. The
// scratch host is test/screen-sharing-model.mjs.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHECKIN, LIVE, PARKED, SCRIPT, SERVE_HOST, WRAP_LAUNCHCTL, fresh, holdLock, host, installBody, isMac, lockHeld, withRealServe } from "./screen-sharing-model.mjs";

const mac = { skip: !isMac && "macOS tools (plutil, osascript, perl)" };
const STATUS = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- the lock --

test("one check at a time: a held lock skips a periodic check, never a pass, and is never touched; a killed holder's lock is free at once; checks started together never overlap", mac, async () => {
  const busy = host();
  const holder = await holdLock(path.join(busy.s, "lock"));
  try {
    assert.match(busy.run("run_check periodic || echo STATUS=$?").stdout, /STATUS=2/);
    assert.equal(busy.has("own_loaded"), false, "skipped");
    assert.equal(busy.read("trace"), "", "nothing changed");
    assert.ok(lockHeld(path.join(busy.s, "lock")), "the holder's lock is untouched");
  } finally {
    await holder.release();
  }
  assert.ok(busy.run().ok, "the holder killed: the kernel released its lock, no age to wait out");
  assert.equal(lockHeld(path.join(busy.s, "lock")), false);
  assert.equal((fs.statSync(path.join(busy.s, "lock")).mode & 0o777).toString(8), "600", "only root (its owner) can open it");
  const many = host();
  const runs = Array.from({ length: 6 }, () => many.start(`check_body() { echo IN >>"$S/marks"; command sleep 0.15; echo OUT >>"$S/marks"; }\nrun_check periodic || true`));
  await Promise.all(runs.map((r) => r.done));
  assert.match(many.read("marks"), /^(IN\nOUT\n)+$/, many.read("marks"));
});

test("a check that waits (setup, --on, --off) waits its turn; one held up throughout fails with the reason; a lock that can't be taken turns Screen Sharing off", mac, async () => {
  const busy = host({ own_loaded: "" });
  const holder = await holdLock(path.join(busy.s, "lock"));
  try {
    const held = busy.run('if run_check wait; then echo VALID; else echo NOT-VALID; cat "$FAILING"; fi');
    assert.match(held.stdout, /NOT-VALID\nanother check held the lock for over 100 s/);
  } finally {
    await holder.release();
  }
  // Released after a few polls: the check then really runs, and fails an unsafe host.
  const released = host({ own_loaded: "", members: "admin family" });
  const second = await holdLock(path.join(released.s, "lock"));
  try {
    const out = released.run(`polls=0
sleep() { polls=$((polls + 1)); if ((polls == 3)); then kill -9 ${second.pid}; fi; command sleep 0.05; }
if run_check wait; then echo VALID; else echo NOT-VALID; fi`);
    assert.match(out.stdout, /NOT-VALID/);
    assert.match(out.stdout, /family may sign in/);
    assert.equal(released.has("own_loaded"), false);
  } finally {
    await second.release();
  }
  const broken = host({ own_loaded: "" });
  const out = broken.run('LOCK="$S/no-such-dir/lock"\nif run_check periodic; then echo RESULT ok; else echo RESULT failed; fi');
  assert.match(out.stdout, /RESULT failed/);
  assert.match(out.stdout, /LOG Screen Sharing is off: the checks' lock couldn't be taken/);
  assert.equal(broken.has("own_loaded"), false);
  assert.equal(broken.read("mapping"), `tcp ${PARKED}\n`);
});

// -------------------------------------------------------------- deadlines --

test("a check that runs past its deadline is killed whole and Screen Sharing turned off, forward parked first; a periodic check meanwhile only skips", mac, async () => {
  const h = host({ own_loaded: "" });
  const started = Date.now();
  const manual = h.start(`policy_problem() { : >"$S/inside"; command sleep 20; return 1; }\nCHECK_DEADLINE=2\nrun_check wait || echo STATUS=$?`);
  await h.until(() => h.has("inside"));
  assert.match(h.run("run_check periodic || echo STATUS=$?").stdout, /STATUS=2/, "busy, not a pass");
  const out = await manual.done;
  assert.ok(Date.now() - started < 12_000, `bounded: ${Date.now() - started} ms`);
  assert.match(out.stdout, /STATUS=1/);
  assert.match(out.stdout, /LOG Screen Sharing is off: a check ran past 2s and was stopped/);
  assert.equal(h.has("own_loaded"), false);
  assert.equal(h.read("mapping"), `tcp ${PARKED}\n`);
  assert.equal(lockHeld(path.join(h.s, "lock")), false);
  assert.ok(h.run().ok, "and the next check runs");
});

test("turning Screen Sharing off after a killed check is bounded too: a hung bootout is stopped, and said; only the check's own process groups are signalled", mac, async () => {
  const h = host({ own_loaded: "" });
  const started = Date.now();
  const out = await h.start(`${WRAP_LAUNCHCTL}
launchctl() { if [[ $1 == bootout && $2 == system/com.apple.screensharing ]]; then : >"$S/bootout-hung"; command sleep 30; fi; model_launchctl "$@"; }
command sleep 30 & echo $! >"$S/sibling"
check_body() { command sleep 30; }
CHECK_DEADLINE=1 STOP_DEADLINE=2
run_check periodic || echo STATUS=$?
kill -0 "$(cat "$S/sibling")" && echo SIBLING-ALIVE
kill "$(cat "$S/sibling")"`).done;
  assert.ok(Date.now() - started < 12_000, `bounded: ${Date.now() - started} ms`);
  assert.ok(h.has("bootout-hung"));
  assert.match(out.stdout, /STATUS=1/);
  assert.match(out.stdout, /LOG Screen Sharing could NOT be turned off: a check ran past 1s and was stopped; turning it off didn't finish within 2s/);
  assert.equal(h.read("mapping"), `tcp ${PARKED}\n`, "its forward parked before the hang");
  assert.equal(h.has("apple_on"), false);
  assert.match(out.stdout, /SIBLING-ALIVE/, "a process in the caller's own group (an admin's terminal, say) wasn't killed");
});

// ---------------------------------------------------------------- signals --

/** launchctl that stops at "enable" (the moment the switch is on) until $S/release exists. */
const ENABLE_BARRIER = `${WRAP_LAUNCHCTL}
launchctl() {
  if [[ $1 == enable && $2 == system/com.apple.screensharing ]]; then
    model_launchctl "$@"
    : >"$S/enabled-barrier"
    while [[ ! -f $S/release ]]; do command sleep 0.02; done
    return 0
  fi
  model_launchctl "$@"
}`;

test("TERM, INT or HUP to --on or a periodic check while the switch is on to load: the worker stopped, the switch back off, the signal's status", mac, async () => {
  for (const [mode, body] of [["--on", ': >"$WANTED"\nrun_check wait'], ["periodic", "run_check periodic"]]) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      const h = host();
      const run = h.start(`${ENABLE_BARRIER}\n${body}`);
      await h.until(() => h.has("enabled-barrier"));
      assert.ok(h.has("apple_on"), "the switch is on at that moment");
      process.kill(-run.child.pid, signal);
      const out = await run.done;
      assert.equal(out.status, STATUS[signal], `${mode} ${signal}: ${out.stdout}${out.stderr}`);
      assert.equal(h.has("apple_on"), false, `${mode} ${signal}: switched off again`);
      h.put("release");
      await settle(200);
      assert.equal(h.has("own_loaded") || h.has("apple_on"), false, `${mode} ${signal}: the worker is gone, it loads nothing afterwards`);
    }
  }
});

test("a signal at the moment a worker starts, before it's named or before it's waited for, stops that worker too: it can't load Screen Sharing afterwards", mac, async () => {
  // The supervisor stops (a DEBUG trap) at the first bounded() statement matching the glob, for check_body's worker.
  const barrierAt = (glob) => String.raw`set -T
trap 'if [[ $BASH_COMMAND == ${glob} && "${"$"}{1:-}" == check_body && "$BASH_SUBSHELL" == 0 && ! -f $S/at-point ]]; then : >"$S/at-point"; while [[ ! -f $S/parent-go ]]; do command sleep 0.01; done; fi' DEBUG`;
  // The worker waits too, inside its check, until let go.
  const workerWaits = `policy_problem() { : >"$S/worker-ready"; while [[ ! -f $S/worker-go ]]; do command sleep 0.01; done; return 1; }`;
  for (const [caller, point, glob] of [["periodic", "naming it", "WORKER=\\$!"], ["periodic", "waiting for it", "wait*WORKER*"], ["--on", "naming it", "WORKER=\\$!"], ["setup", "waiting for it", "wait*WORKER*"]]) {
    const h = caller === "setup" ? fresh() : host();
    const body = { periodic: "run_check periodic", "--on": ': >"$WANTED"\nrun_check wait', setup: installBody("rfb_answers() { return 0; }") }[caller];
    const run = h.start(`CHECK_DEADLINE=6 STOP_DEADLINE=2\n${workerWaits}\n${barrierAt(glob)}\n${body}`);
    const label = `${caller}, TERM before ${point}`;
    try {
      await h.until(() => h.has("at-point"), 20_000);
      process.kill(run.child.pid, "SIGTERM");
      await settle(300);
      h.put("parent-go");
      const out = await run.done;
      assert.equal(out.status, 143, `${label}\n${out.stdout}${out.stderr}`);
      // Were the worker alive, letting it go on now would load Screen Sharing and switch it on.
      h.put("worker-go");
      await settle(1000);
      assert.equal(h.has("apple_on"), false, `${label}: the switch stays off`);
      const calls = h.read("calls").split("\n");
      assert.ok(calls.lastIndexOf("enable system/com.apple.screensharing") < calls.lastIndexOf("disable system/com.apple.screensharing") || !calls.includes("enable system/com.apple.screensharing"), `${label}: no enable after the last disable`);
      assert.equal(spawnSync("pgrep", ["-f", h.s]).status, 1, `${label}: none of its processes left`);
    } finally {
      h.put("parent-go");
      h.put("worker-go");
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      spawnSync("pkill", ["-9", "-f", h.s]);
    }
  }
});

test("a check killed outright (SIGKILL) while loading can't clean up, but its worker isn't killed with it: the worker finishes the load, and the switch ends off", mac, async () => {
  const h = host();
  const run = h.start(`${ENABLE_BARRIER}\nCHECK_DEADLINE=5\nrun_check periodic`);
  try {
    await h.until(() => h.has("enabled-barrier"));
    process.kill(-run.child.pid, "SIGKILL");
    await settle(200);
    assert.ok(h.has("apple_on"), "SIGKILL can't be trapped: the switch is on");
    // The worker, in a group of its own, carries on: bootstrap, then disable.
    h.put("release");
    await h.until(() => !h.has("apple_on"), 4000);
    assert.ok(h.has("own_loaded"));
    await run.done;
  } finally {
    spawnSync("pkill", ["-9", "-f", h.s]);
  }
});

// ----------------------------------------------------------------- setup --

test("setup refuses before changing anything: an unsafe host, Serve's TCP 5900 someone else's, Serve already mentioning 15900 or 15901, or --no-serve on a Serve setup", mac, () => {
  for (const [setup, extra, why] of [
    [{ "sysctl.net.inet6.ip6.forwarding": "1" }, "", /net\.inet6\.ip6\.forwarding is 1, not 0 .* Nothing was changed\./],
    [{ mapping: "tcp 127.0.0.1:9" }, "", /Tailscale Serve's TCP 5900 is in use \(tcp 127\.0\.0\.1:9\).* Nothing was changed\./],
    [{ mapping: "tcp localhost:15900" }, "", /Tailscale Serve's TCP 5900 is in use \(tcp localhost:15900\)/],
    [{ mapping: "free", reach_other: "foreground session abc: TCP 7000 to 127.0.0.1:15900" }, "", /already mentions TCP 15900 or 15901 \(foreground session abc: TCP 7000 to 127\.0\.0\.1:15900\).* Nothing was changed\./],
    [{ serve: "" }, "NO_SERVE=1", /this is set up with Tailscale Serve; to switch to --no-serve, run --uninstall first\. Nothing was changed\./],
  ]) {
    const h = fresh(setup);
    const out = h.run(installBody(extra));
    assert.equal(out.status, 1, JSON.stringify(setup));
    assert.match(out.stderr, why);
    assert.equal(h.read("calls"), "", "no launchctl call at all");
    assert.equal(h.has("wanted") || h.has("support"), false);
  }
});

test("setup says Done only once its check turned Screen Sharing on, it answered RFB, and capture isn't denied; over Tailscale live or pending, or loopback only", mac, () => {
  const live = fresh();
  const done = live.run(installBody("rfb_answers() { return 0; }"));
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /Screen capture and control: granted \(postEventFlag 1, screenCaptureFlag 1\)/);
  assert.match(done.stdout, /Done\. Screen Sharing is on for admin, on this Mac's loopback and over Tailscale\./);
  assert.match(done.stdout, /2\. On the desktop Mac: /);
  assert.ok(live.has("own_loaded") && live.has("park_loaded") && live.has("check_loaded") && live.has("serve"));
  assert.equal(live.read("mapping"), `tcp ${LIVE}\n`);
  live.neverForeign();
  const pending = fresh({ ts_absent: "" });
  const later = pending.run(installBody("rfb_answers() { return 0; }"));
  assert.equal(later.status, 0, later.stdout + later.stderr);
  assert.match(later.stderr, /tailscaled isn't running here; once it is, the check forwards the tailnet's TCP 5900/);
  assert.match(later.stdout, /Done, for loopback: .* Over Tailscale\nit's pending/);
  assert.match(later.stdout, /2\. Once the forward is there, on the desktop Mac: /);
  assert.equal(pending.read("serve"), "", "no forward written yet, so tailscaled being away hides nothing of this setup's");
  pending.drop("ts_absent");
  assert.ok(pending.run().ok, "tailscaled up: the check adds the forward");
  assert.equal(pending.read("serve"), "forward\n", "recorded before it was written");
  assert.equal(pending.read("mapping"), `tcp ${LIVE}\n`);
  assert.equal(pending.run(installBody("rfb_answers() { return 0; }")).status, 0);
  assert.equal(pending.read("serve"), "forward\n", "a rerun keeps the record");
  const loopback = fresh();
  const local = loopback.run(installBody("NO_SERVE=1\nrfb_answers() { return 0; }"));
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /Done\. Screen Sharing is on for admin, on this Mac's loopback only \(--no-serve\)\./);
  assert.equal(loopback.has("serve"), false);
  assert.equal(loopback.read("serve_calls"), "");
  // Capture: denied fails with the remedy; nothing to go by only warns.
  for (const [post, capture] of [[0, 0], [1, 0], [0, 1]]) {
    const h = fresh({ sslog: CHECKIN(post, capture) });
    const out = h.run(installBody("rfb_answers() { return 0; }"));
    assert.equal(out.status, 1, `${post}/${capture}`);
    assert.match(out.stderr, /macOS hasn't granted Screen Sharing screen capture and control on this Mac: .*System Settings → General → Sharing, turn Screen Sharing on, wait until it shows as on, turn it off again, then rerun this script/);
    assert.match(out.stderr, new RegExp(`\\[screensharingd: \\(postEventFlag ${post}, screenCaptureFlag ${capture}\\)\\]`));
    assert.match(out.stderr, /setup failed, so Screen Sharing is off again/);
    assert.equal(h.has("own_loaded"), false);
  }
  for (const sslog of [CHECKIN(0, 0, 1), ""]) {
    const out = fresh({ sslog }).run(installBody("rfb_answers() { return 0; }"));
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stderr, /couldn't confirm that macOS lets Screen Sharing capture the screen and take input \(unknown .*\); check a session from the desktop Mac shows the screen, not black/);
  }
});

test("setup's self-test needs screensharingd's RFB greeting on loopback, not just an open port", { skip: !isMac && "macOS nc (-G is its connect timeout)" }, async () => {
  for (const [greeting, want] of [["RFB 003.889\n", "yes"], ["HTTP/1.1 400\r\n", "no"], ["", "no"]]) {
    const server = await new Promise((resolve) => {
      const s = net.createServer((socket) => {
        if (greeting) socket.write(greeting);
        setTimeout(() => socket.destroy(), 200);
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const out = await new Promise((resolve) => {
      const child = spawn("bash", ["-c", `source ${JSON.stringify(SCRIPT)}\nBACKEND_PORT=${server.address().port}\nif rfb_answers; then echo yes; else echo no; fi`]);
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve(stdout.trim()));
    });
    server.close();
    assert.equal(out, want, JSON.stringify(greeting));
  }
});

test("a setup that fails once Screen Sharing may run turns it off again, even after an exit bash reports as status 0, and says 'off again' only when that's verified", mac, async () => {
  const h = fresh();
  const out = h.run(installBody('rfb_answers() { echo "$UNSET_ON_PURPOSE"; }'));
  assert.equal(out.status, 1, "an unset variable mid-setup isn't a success");
  assert.match(out.stderr, /unbound variable[\s\S]*setup failed, so Screen Sharing is off again/);
  assert.equal(h.has("own_loaded") || h.has("wanted"), false);
  assert.ok(h.has("hold_loaded"));
  assert.equal(h.read("mapping"), `tcp ${PARKED}\n`, "its forward parked");
  h.neverForeign();
  // A rerun whose self-test fails, and at Screen Sharing's release someone else on 15900 (or its session surviving).
  for (const [fault, why] of [["squat4", /TCP 15900 is held on 127\.0\.0\.1:15900 by screensharingd \(pid 4242, uid 501\)/], ["stuck", /TCP 15900 is held on 127\.0\.0\.1:15900 by screensharingd \(pid 500, uid 0/]]) {
    const r = host({ own_loaded: "" });
    const failed = r.run(installBody(`${WRAP_LAUNCHCTL}
launchctl() {
  local rc=0
  model_launchctl "$@" || rc=$?
  if [[ $1 == bootout && $2 == system/com.apple.screensharing && -f $S/selftest-failed ]]; then : >"$S/${fault}"; fi
  return "$rc"
}
rfb_answers() { : >"$S/selftest-failed"; return 1; }`));
    assert.equal(failed.status, 1, fault);
    assert.doesNotMatch(failed.stderr, /off again/, fault);
    assert.match(failed.stderr, /setup failed, and Screen Sharing could NOT be turned off: /, fault);
    assert.match(failed.stderr, why, fault);
    assert.equal(r.read("mapping"), `tcp ${PARKED}\n`, `${fault}: the forward still parked first`);
  }
  // A check that can't run at all (another holds the lock throughout): no Done, Screen Sharing never on.
  const blocked = fresh();
  const holder = await holdLock(path.join(blocked.s, "lock"));
  try {
    const out2 = blocked.run(installBody("install_check() { :; }\nrfb_answers() { return 0; }"));
    assert.equal(out2.status, 1, out2.stdout + out2.stderr);
    assert.match(out2.stderr, /the check failed: another check held the lock for over 100 s/);
    assert.doesNotMatch(out2.stdout, /Done/);
    assert.equal(blocked.has("own_loaded"), false);
  } finally {
    await holder.release();
  }
});

// ---------------------------------------------------------------- --off, --on --

test("--off says off only when it's verified: its job unloaded, its switch off, 15900 the hold job's; otherwise it names what remains", mac, () => {
  const h = host({ own_loaded: "", ts_listen: "" });
  const off = h.run("turn_off && echo OFF");
  assert.match(off.stdout, /Screen Sharing is off \(rerun this script, or --on, to turn it on\)\S*\nOFF/, off.stderr);
  assert.equal(h.read("mapping"), `tcp ${PARKED}\n`, "the forward stays, parked: TCP 5900 stays tailscaled's");
  assert.equal(h.has("apple_on") || h.has("own_loaded") || h.has("wanted"), false);
  assert.ok(h.run().ok, "and the next check keeps it so");
  for (const [setup, why] of [
    [{ stuck: "" }, /TCP 15900 is held on 127\.0\.0\.1:15900 by screensharingd \(pid 500, uid 0, running an unknown file\)/],
    [{ lsof_fail: "" }, /lsof couldn't list who listens on TCP 15900/],
    [{ apple_on: "", disable_fail: "" }, /its switch is on; .*the last check: .*its switch won't go off/],
    [{ ts_absent: "" }, /com\.apple\.screensharing is still loaded, .*the last check: .*tailscaled isn't running/],
  ]) {
    const r = host({ own_loaded: "", ...setup });
    const out = r.run("turn_off");
    assert.equal(out.status, 1, JSON.stringify(setup));
    assert.match(out.stderr, /Screen Sharing isn't verifiably off: /);
    assert.match(out.stderr, why, JSON.stringify(setup));
    assert.doesNotMatch(out.stdout, /Screen Sharing is off/);
  }
});

test("--on turns Screen Sharing back on through a check", mac, () => {
  const h = host({ wanted: null });
  assert.ok(h.run().ok);
  assert.equal(h.has("own_loaded"), false);
  assert.ok(h.run(': >"$WANTED"\nrun_check wait && echo RESULT ok').ok);
  assert.ok(h.has("own_loaded"));
});

// -------------------------------------------------------------- --uninstall --

test("--uninstall removes the forward first, read back, while every holder keeps its port; then the jobs and the files, leaving nothing", mac, async () => {
  const h = host({ own_loaded: "", check_loaded: "", ts_listen: "" });
  fs.writeFileSync(path.join(h.s, "LaunchDaemons", "dev.blacksand.screen-sharing-check.plist"), "plist");
  const out = h.run("uninstall_all");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Done\. Screen Sharing's switch stays off/);
  const trace = h.read("trace").trim().split("\n");
  assert.equal(trace[0], "unmapped", `the forward went first:\n${trace.join("\n")}`);
  for (const name of ["own_loaded", "hold_loaded", "park_loaded", "check_loaded", "apple_on", "wanted", "serve", "user", "failing", "lock", "support"]) assert.equal(h.has(name), false, name);
  assert.deepEqual(fs.readdirSync(path.join(h.s, "LaunchDaemons")), []);
  // With the real Serve helper: one write, its forward straight off, Funnel elsewhere kept.
  const funnel = { TCP: { 443: { HTTPS: true } }, Web: { [`${SERVE_HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4773" } } } }, AllowFunnel: { [`${SERVE_HOST}:443`]: true } };
  for (const forward of [LIVE, PARKED]) {
    const r = host(forward === LIVE ? { own_loaded: "" } : {});
    const { out: real, api } = await withRealServe(r, { ...funnel, TCP: { ...funnel.TCP, 5900: { TCPForward: forward } } }, "uninstall_all");
    assert.equal(real.status, 0, real.stdout + real.stderr);
    assert.deepEqual(api.config(), funnel);
    assert.equal(api.posts.length, 1);
    r.neverForeign();
  }
});

test("an uninstall that stops (tailscaled away, Serve mentioning either port, a job that won't unload) keeps every holder its port when it must, says why, and a rerun finishes", mac, async () => {
  // tailscaled not running: nothing changes hands, the check keeps running, and Screen Sharing is no longer wanted.
  const away = host({ own_loaded: "", check_loaded: "", ts_absent: "" });
  const stopped = away.run("uninstall_all");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /uninstall stopped: tailscaled isn't running, so Tailscale Serve's forward can't be removed: start it; nothing else was removed/);
  assert.ok(away.has("own_loaded") && away.has("park_loaded") && away.has("check_loaded") && away.has("serve"));
  assert.equal(away.has("wanted"), false);
  away.drop("ts_absent");
  const again = away.run("uninstall_all");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  away.neverForeign();
  // Serve mentioning either port elsewhere (or as TCP 5900's own handler, in another spelling): nothing written, both holders kept.
  for (const [label, config] of [
    ["foreground TCP 5900 to the parking port", { TCP: { 5900: { TCPForward: PARKED } }, Foreground: { s1: { TCP: { 5900: { TCPForward: PARKED } } } } }],
    ["TCP 8443 to the parking port", { TCP: { 5900: { TCPForward: PARKED }, 8443: { TCPForward: PARKED } } }],
    ["a web proxy to localhost:15901", { TCP: { 5900: { TCPForward: PARKED }, 443: { HTTPS: true } }, Web: { [`${SERVE_HOST}:443`]: { Handlers: { "/": { Proxy: "http://localhost:15901" } } } } }],
    ["TCP 5900 to localhost:15901", { TCP: { 5900: { TCPForward: "localhost:15901" } } }],
  ]) {
    const h = host();
    const { out, api } = await withRealServe(h, config, "uninstall_all");
    assert.equal(out.status, 1, `${label}\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /uninstall stopped: Tailscale Serve( still mentions TCP 15900 or 15901|'s TCP 5900 is tcp localhost:15901)/, label);
    assert.ok(h.has("park_loaded") && h.has("hold_loaded"), `${label}: both holders kept`);
    assert.ok(h.has("LaunchDaemons/dev.blacksand.screensharing-park.plist") && h.has("LaunchDaemons/dev.blacksand.screensharing-hold.plist"), label);
    assert.equal(api.posts.length, 0, label);
    // The owner removes it; the rerun finishes.
    const { out: rerun } = await withRealServe(h, {}, "uninstall_all");
    assert.equal(rerun.status, 0, `${label} rerun: ${rerun.stdout}${rerun.stderr}`);
  }
  // A job that won't unload: stopped there, with the forward already gone; the files that set it up stay.
  for (const job of ["dev.blacksand.screen-sharing-check", "dev.blacksand.screensharing-hold"]) {
    const h = host({ check_loaded: "", bootout_fail: job });
    fs.writeFileSync(path.join(h.s, "LaunchDaemons", "dev.blacksand.screen-sharing-check.plist"), "plist");
    const out = h.run("uninstall_all");
    assert.equal(out.status, 1, job);
    assert.match(out.stderr, new RegExp(`uninstall stopped: launchd still has ${job.replace(/\./g, "\\.")} 10 s after bootout.*; rerun --uninstall`));
    assert.equal(h.read("mapping"), "free\n", `${job}: the forward went first`);
    assert.ok(h.has("LaunchDaemons/dev.blacksand.screensharing-hold.plist") && h.has("user"), `${job}: the files stay`);
    h.drop("bootout_fail");
    const rerun = h.run("uninstall_all");
    assert.equal(rerun.status, 0, `${job} rerun: ${rerun.stdout}${rerun.stderr}`);
    assert.deepEqual(fs.readdirSync(path.join(h.s, "LaunchDaemons")), []);
  }
  // Whatever an earlier uninstall left (here: the holders and their plists gone already, the rest not): a rerun finishes.
  const partial = host({ serve: null, hold_loaded: null, park_loaded: null, mapping: null });
  for (const job of ["hold", "park"]) partial.drop(`LaunchDaemons/dev.blacksand.screensharing-${job}.plist`);
  fs.mkdirSync(path.join(partial.s, "support"));
  partial.put("support/com.apple.screensharing.plist", "plist");
  const done = partial.run("uninstall_all");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(partial.has("user") || partial.has("support"), false);
});

// ---------------------------------------------------------------- --status --

test("--status: which plist the job came from, who holds each port, where the forward points, the switch, capture, and any problem", mac, () => {
  const mine = host({ own_loaded: "" }).run("status").stdout;
  assert.match(mine, /Screen Sharing: +on \(from .*support\/com\.apple\.screensharing\.plist\)/);
  assert.match(mine, /TCP 15900: +launchd 127\.0\.0\.1:15900 launchd \[::1\]:15900\n/);
  assert.match(mine, /hold job: +not loaded/);
  assert.match(mine, /parking job: +loaded, TCP 15901: launchd 127\.0\.0\.1:15901 launchd \[::1\]:15901/);
  assert.match(mine, /Serve forward: +TCP 5900 → 127\.0\.0\.1:15900 \(Screen Sharing's port\)\n/);
  assert.match(mine, /its switch: +off \(as it should be, loaded or not\)/);
  assert.match(mine, /screen capture: +granted \(postEventFlag 1, screenCaptureFlag 1\)/);
  assert.doesNotMatch(mine, /problem/);
  const theirs = host({ apple_loaded: "", apple_on: "" }).run("status").stdout;
  assert.match(theirs, /Screen Sharing: +APPLE'S EVERY-INTERFACE VERSION, from \/System\/Library\/LaunchDaemons\/com\.apple\.screensharing\.plist/);
  assert.match(theirs, /its switch: +ON: a restart would start Apple's every-interface version/);
  const off = host().run("status").stdout;
  assert.match(off, /Screen Sharing: +off \(its job isn't loaded\)\n/);
  assert.match(off, /Serve forward: +TCP 5900 → 127\.0\.0\.1:15901 \(parked; new Serve connections don't reach Screen Sharing\)\n/);
  assert.match(host({ serve: null }).run("status").stdout, /Serve forward: +not used \(--no-serve\)/);
  assert.match(host({ ts_absent: "" }).run("status").stdout, /Serve forward: +unknown: tailscaled isn't running/);
  assert.match(host({ reach_other: "foreground session s: TCP 7000 to 127.0.0.1:15900" }).run("status").stdout, /Serve forward: +TCP 5900 → 127\.0\.0\.1:15901 \(parked; .*\); also mentioning TCP 15900 or 15901: foreground session s: TCP 7000 to 127\.0\.0\.1:15900/);
  // A greeting from someone else's port: reported as a greeting, asked once; the port's holder a problem.
  const squatted = host({ hold_loaded: null, squat4: "", squat6: "" });
  const counted = squatted.run(`rfb_answers() { local n; n=$(cat "$S/rfb-count" 2>/dev/null || echo 0); echo $((n + 1)) >"$S/rfb-count"; ((n == 0)); }\nstatus`);
  assert.equal(squatted.read("rfb-count"), "1\n");
  assert.match(counted.stdout, /answers on loopback: +yes \(RFB; who holds the port: below\)/);
  assert.match(counted.stdout, /problem: +TCP 15900 is held on 127\.0\.0\.1:15900 by screensharingd \(pid 4242, uid 501\)/);
  // A failed --off: what's loaded, the forward as it is, the last failed check.
  const failed = host({ own_loaded: "", bootout_fail: "com.apple.screensharing" });
  failed.run("turn_off");
  const after = failed.run("status").stdout;
  assert.match(after, /Screen Sharing: +on \(from /);
  assert.match(after, /last failed check: +.*launchd still has com\.apple\.screensharing/);
  // Capture from screensharingd's newest check-in, asked of the log tool for its lines only.
  assert.match(host({ own_loaded: "", sslog: CHECKIN(1, 1) + CHECKIN(0, 0) }).run("status").stdout, /screen capture: +denied \(postEventFlag 0, screenCaptureFlag 0\)/);
  assert.match(host({ own_loaded: "", sslog: "" }).run("status").stdout, /screen capture: +unknown \(no screensharingd check-in logged in the last 30m\)/);
  const logged = host();
  fs.writeFileSync(path.join(logged.s, "logtool"), '#!/bin/sh\nprintf "%s|" "$@" >"$(dirname "$0")/logargs"\n', { mode: 0o755 });
  logged.run("capture_state 2m");
  assert.equal(logged.read("logargs"), 'show|--style|compact|--last|2m|--predicate|process == "screensharingd" AND eventMessage CONTAINS "screenCaptureFlag"|');
});
