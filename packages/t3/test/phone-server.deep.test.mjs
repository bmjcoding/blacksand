// node --test test/: the phone's always-on server (scripts/phone-server.sh) and
// how the desktop's SSH runner (lib/files/ssh-runner-blacksand.sh) shares it: the
// supervisor runs a fake installed app's server as you, unprivileged, in a
// scratch home; the rendered runner's __blacksand-stop-stale-server runs against
// the same home. Opt-in, a real packed build:
//   BLACKSAND_T3_TEST_PACKED_APP="/path/to/Blacksand T3.app" node --test test/phone-server.deep.test.mjs
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeTemplate } from "../ci/render-runner.mjs";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SUPERVISOR = path.join(ROOT, "scripts", "phone-server.sh");
const ADD_PHONE = path.join(ROOT, "scripts", "add-phone-service.sh");
const RUNNER = decodeTemplate(fs.readFileSync(path.join(ROOT, "lib", "files", "ssh-runner-blacksand.sh"), "utf8"));
const isMac = process.platform === "darwin";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = "4799";

// A server that publishes its runtime state the way upstream's does (after a
// moment, naming its pid), exits 78 when $HOME/owned exists (another server
// holds the home), never gets ready while $HOME/silent exists, prints a stream
// of lines while $HOME/flood exists, and stops on SIGTERM.
const SERVER = `import * as fs from "node:fs";
if (process.argv[2] === "serve") {
  const home = process.env.T3CODE_HOME;
  if (fs.existsSync(process.env.HOME + "/owned")) process.exit(78);
  fs.mkdirSync(home + "/userdata", { recursive: true });
  if (!fs.existsSync(process.env.HOME + "/silent")) setTimeout(() => fs.writeFileSync(home + "/userdata/server-runtime.json", JSON.stringify({ version: 1, pid: process.pid, port: Number(process.argv[6]), origin: "http://127.0.0.1:" + process.argv[6] }) + "\\n"), 300);
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => { if (fs.existsSync(process.env.HOME + "/flood")) for (let i = 0; i < 50; i++) console.log("x".repeat(99)); }, 20);
}
`;

function host(extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const app = path.join(dir, "Blacksand T3.app");
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  const build = (where) => {
    fs.mkdirSync(path.join(where, "apps", "server", "dist"), { recursive: true });
    fs.writeFileSync(path.join(where, "apps", "server", "dist", "bin.mjs"), SERVER);
  };
  build(asar);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "Blacksand T3"));
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, `#!/bin/sh\nset -eu\n${RUNNER}`, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, BLACKSAND_T3_APP: app, BLACKSAND_T3_UPDATE_REQUESTS: path.join(dir, "Shared", "update-requests"), ...extraEnv };
  const supervisor = spawn("/bin/sh", [SUPERVISOR, PORT], { env, stdio: "ignore" });
  const servers = path.join(home, ".blacksand/t3", "ssh-servers");
  const daemon = () => {
    try {
      const [pid, started, args, state, server, built] = fs.readFileSync(path.join(servers, "daemon"), "utf8").split("\n");
      return { pid, started, args, state, server, built };
    } catch {
      return null;
    }
  };
  const record = (pid) => {
    try {
      return fs.readFileSync(path.join(servers, String(pid)), "utf8").split("\n");
    } catch {
      return null;
    }
  };
  const stopStale = () => spawnSync(runner, ["__blacksand-stop-stale-server"], { encoding: "utf8", env, timeout: 90_000 });
  const newBuild = () => {
    build(`${asar}.next`);
    fs.rmSync(asar, { recursive: true });
    fs.renameSync(`${asar}.next`, asar);
  };
  const buildId = () => spawnSync("stat", ["-f", "%d:%i:%m:%z", asar], { encoding: "utf8" }).stdout.trim();
  const log = () => fs.readFileSync(path.join(home, ".blacksand/t3", "phone", "server.log"), "utf8");
  const cleanup = () => {
    supervisor.kill("SIGKILL");
    const server = daemon()?.server;
    if (server) spawnSync("kill", ["-9", server]);
  };
  return { dir, home, app, supervisor, daemon, record, stopStale, newBuild, buildId, log, cleanup };
}

const alive = (pid) => {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.includes("Z");
};
const argsOf = (pid) => spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim();

async function until(condition, what, ms = 30_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (condition()) return;
  assert.fail(`timed out waiting for ${what}`);
}
const running = (h) => h.daemon()?.state === "running" && alive(h.daemon().server);

test("the supervisor runs the server on loopback only, with the record the SSH runner reads, and a log only the account can read", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const h = host();
  try {
    await until(() => running(h), "the server to be ready");
    const d = h.daemon();
    assert.equal(d.pid, String(h.supervisor.pid));
    assert.equal(d.args, argsOf(h.supervisor.pid), "the supervisor names itself as ps shows it");
    assert.equal(d.built, h.buildId());
    const [, built, args, starting] = h.record(d.server);
    assert.equal(built, h.buildId(), "the record names the build, as the SSH runner's do");
    assert.equal(args, argsOf(d.server));
    assert.match(args, new RegExp(`/bin\\.mjs serve --host 127\\.0\\.0\\.1 --port ${PORT} --base-dir ${h.home}/\\.blacksand\/t3$`));
    assert.equal(starting, "", "no runner phase: the record names the server from the start");
    assert.equal(fs.statSync(path.join(h.home, ".blacksand/t3", "phone", "server.log")).mode & 0o777, 0o600, "the log (pairing links) is the account's alone");
    // Same build: a connection has nothing to wait for and leaves it running.
    const started = Date.now();
    const stop = h.stopStale();
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(Date.now() - started < 5_000, "no wait while the server runs the installed build");
    assert.ok(alive(d.server));
  } finally {
    h.cleanup();
  }
});

test("a desktop connection after an update stops the old server and waits for the supervisor's new one: never two servers on one home", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const h = host();
  try {
    await until(() => running(h), "the server to be ready");
    const old = h.daemon().server;
    h.newBuild();
    const stop = h.stopStale();
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(alive(old), false, "the stale server stopped");
    const d = h.daemon();
    assert.equal(d.state, "running", "the connection returned only once the new server was ready");
    assert.notEqual(d.server, old);
    assert.equal(d.built, h.buildId(), "on the installed build");
    assert.ok(alive(d.server));
    assert.equal(h.record(old), null, "the old record is gone");
    const runtime = JSON.parse(fs.readFileSync(path.join(h.home, ".blacksand/t3", "userdata", "server-runtime.json"), "utf8"));
    assert.equal(String(runtime.pid), d.server, "the runtime file the launch script adopts names the new server");
    assert.equal(runtime.origin, `http://127.0.0.1:${PORT}`, "loopback, which the launch script requires to adopt it");
  } finally {
    h.cleanup();
  }
});

test("with no desktop connection at all, the supervisor moves to a new build by itself", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const h = host();
  try {
    await until(() => running(h), "the server to be ready");
    const old = h.daemon().server;
    h.newBuild();
    await until(() => running(h) && h.daemon().server !== old && h.daemon().built === h.buildId(), "the restart on the new build");
    assert.equal(alive(old), false);
    assert.match(h.log(), /a new build is installed; restarting the server on it/);
  } finally {
    h.cleanup();
  }
});

test("a server that crashes is started again; one locked out of its home waits, and connections don't wait for it", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const h = host();
  try {
    await until(() => running(h), "the server to be ready");
    const first = h.daemon().server;
    fs.writeFileSync(path.join(h.home, "owned"), "");
    spawnSync("kill", ["-9", first]);
    await until(() => h.daemon()?.state === "blocked", "the locked-out state", 20_000);
    // The log goes through the supervisor's pipe: a moment behind the state file.
    await until(() => /another server holds/.test(h.log()), "the log line", 10_000);
    const started = Date.now();
    const stop = h.stopStale();
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(Date.now() - started < 5_000, "blocked: the connection uses its own server at once");
  } finally {
    h.cleanup();
  }
});

test("launchd's SIGTERM stops the server and removes the supervisor's files", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const h = host();
  try {
    await until(() => running(h), "the server to be ready");
    const server = h.daemon().server;
    h.supervisor.kill("SIGTERM");
    await until(() => h.supervisor.exitCode !== null, "the supervisor to exit", 25_000);
    assert.equal(h.supervisor.exitCode, 0);
    assert.equal(alive(server), false);
    assert.equal(h.daemon(), null);
    assert.equal(h.record(server), null);
  } finally {
    h.cleanup();
  }
});

test("a dead supervisor's state file never holds a desktop connection up", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-dead-")));
  const home = path.join(dir, "home");
  const servers = path.join(home, ".blacksand/t3", "ssh-servers");
  fs.mkdirSync(servers, { recursive: true });
  // A pid that was never a supervisor (ours, with another start time), state "starting".
  fs.writeFileSync(path.join(servers, "daemon"), `${process.pid}\nMon Jan  1 00:00:00 2001\n/bin/sh /usr/local/libexec/blacksand/phone-server 4773\nstarting\n\n\n`);
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, `#!/bin/sh\nset -eu\n${RUNNER}`, { mode: 0o700 });
  const app = path.join(dir, "Blacksand T3.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources", "app.asar"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "Blacksand T3"));
  const started = Date.now();
  const stop = spawnSync(runner, ["__blacksand-stop-stale-server"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, BLACKSAND_T3_APP: app }, timeout: 90_000 });
  assert.equal(stop.status, 0, stop.stderr);
  assert.ok(Date.now() - started < 5_000);
});

test("the supervisor refuses a bad or zero-padded port, and is POSIX sh: sh, bash --posix, dash and ShellCheck", () => {
  const bad = spawnSync("/bin/sh", [SUPERVISOR, "80"], { encoding: "utf8" });
  assert.equal(bad.status, 64);
  assert.equal(spawnSync("/bin/sh", [SUPERVISOR, "x"], { encoding: "utf8" }).status, 64);
  assert.equal(spawnSync("/bin/sh", [SUPERVISOR, "04773"], { encoding: "utf8" }).status, 64, "never read as a number other than it says");
  for (const [tool, args] of [["sh", ["-n", SUPERVISOR]], ["bash", ["--posix", "-n", SUPERVISOR]], ["dash", ["-n", SUPERVISOR]], ["shellcheck", ["-s", "sh", "-S", "warning", SUPERVISOR]], ["shellcheck", ["-S", "warning", ADD_PHONE]]]) {
    const result = spawnSync(tool, args, { encoding: "utf8" });
    if (result.error?.code === "ENOENT" && tool !== "sh") continue;
    assert.equal(result.status, 0, `${tool}: ${result.stdout}${result.stderr}`);
  }
});

test("a supervisor still starting past the deadline fails the desktop connection, to be retried, instead of letting it start a rival server", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const h = host({ BLACKSAND_T3_DAEMON_WAIT: "2" });
  try {
    await until(() => running(h), "the server to be ready");
    fs.writeFileSync(path.join(h.home, "silent"), "");
    const old = h.daemon().server;
    spawnSync("kill", ["-9", old]);
    await until(() => h.daemon()?.state === "starting" && h.daemon().server !== old, "a restart that doesn't get ready");
    const started = Date.now();
    const stop = h.stopStale();
    assert.equal(stop.status, 75, "EX_TEMPFAIL: the launch script (set -e) fails the connection");
    assert.match(stop.stderr, /still starting; connect again in a minute\. Its log: .*\/\.blacksand\/t3\/phone\/server\.log/);
    assert.ok(Date.now() - started < 6_000, "by the clock: BLACKSAND_T3_DAEMON_WAIT (2 s here), not counted sleeps");
  } finally {
    h.cleanup();
  }
});

test("the log rotates while the same server keeps running, and both files stay the account's alone", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const max = 100_000;
  const h = host({ BLACKSAND_T3_PHONE_LOG_MAX: String(max) });
  const logFile = path.join(h.home, ".blacksand/t3", "phone", "server.log");
  try {
    await until(() => running(h), "the server to be ready");
    const server = h.daemon().server;
    fs.writeFileSync(path.join(h.home, "flood"), "");
    await until(() => fs.existsSync(`${logFile}.1`) && fs.statSync(`${logFile}.1`).size >= max, "a rotation", 60_000);
    await sleep(1500);
    fs.rmSync(path.join(h.home, "flood"));
    await sleep(500);
    assert.equal(h.daemon().server, server, "no restart: the running server's output moved to the new file");
    assert.ok(alive(server));
    assert.ok(fs.statSync(logFile).size <= max + 200, `server.log is ${fs.statSync(logFile).size} bytes`);
    assert.ok(fs.statSync(`${logFile}.1`).size <= max + 200);
    for (const file of [logFile, `${logFile}.1`]) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
    assert.equal(fs.existsSync(path.join(h.home, ".blacksand/t3", "phone", ".log.pipe")), false, "the pipe's name is gone once both ends are open");
  } finally {
    h.cleanup();
  }
});

test("a packed app.asar (a regular file) counts as installed: the supervisor starts its server instead of waiting forever", { skip: !isMac && "launchd host (macOS)" }, async () => {
  const { dir, app } = packedApp();
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const supervisor = spawn("/bin/sh", [SUPERVISOR, PORT], { env: { PATH: process.env.PATH, HOME: home, BLACKSAND_T3_APP: app }, stdio: "ignore" });
  const log = path.join(home, ".blacksand/t3", "phone", "server.log");
  try {
    // Plain node can't read inside an archive, so this server exits at once: what
    // matters is that it was started (Electron reads it; the opt-in test below runs one).
    await until(() => fs.existsSync(log) && /the server exited \(status \d+\)/.test(fs.readFileSync(log, "utf8")), "a start attempt", 20_000);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /waiting for/);
  } finally {
    supervisor.kill("SIGKILL");
  }
});

/** A fake app whose app.asar is a packed archive, a regular file, as in a real build. */
function packedApp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-packed-")));
  const app = path.join(dir, "Blacksand T3.app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), Buffer.alloc(4096, 1));
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "Blacksand T3"));
  return { dir, app };
}

// Opt-in (see the top): a real packed build, e.g. one from `blacksand t3 check --build`.
const PACKED = process.env.BLACKSAND_T3_TEST_PACKED_APP;
const sourced = (body) => spawnSync("bash", ["-c", `source ${JSON.stringify(ADD_PHONE)}\n${body}`], { encoding: "utf8" });
test("with a real packed build: the installer's check, the supervisor, the runner sharing its server, an update, and shutdown", { skip: !(isMac && PACKED) && "set BLACKSAND_T3_TEST_PACKED_APP to a built Blacksand T3.app" }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-phone-real-")));
  const app = path.join(dir, "Blacksand T3.app");
  assert.equal(spawnSync("cp", ["-cR", PACKED, app]).status, 0, "an APFS clone of the build");
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  assert.ok(fs.statSync(asar).isFile(), "a packed archive");
  const check = sourced(`APP=${JSON.stringify(app)} ELECTRON="$APP/Contents/MacOS/Blacksand T3" ASAR="$APP/Contents/Resources/app.asar" SERVER="$ASAR/apps/server/dist/bin.mjs" NAME=agent-a HOME_DIR=/tmp
as_user() { shift; "$@"; }
if why="$(app_problem)"; then echo "PROBLEM $why"; else echo OK; fi`);
  assert.equal(check.stdout.trim(), "OK", check.stdout + check.stderr);
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, SHELL: "/bin/zsh", BLACKSAND_T3_APP: app };
  const supervisor = spawn("/bin/sh", [SUPERVISOR, "4798"], { env, stdio: "ignore" });
  const servers = path.join(home, ".blacksand/t3", "ssh-servers");
  const state = () => {
    try {
      return fs.readFileSync(path.join(servers, "daemon"), "utf8").split("\n");
    } catch {
      return [];
    }
  };
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, `#!/bin/sh\nset -eu\n${RUNNER}`, { mode: 0o700 });
  try {
    await until(() => state()[3] === "running", "the real server to be ready", 120_000);
    const server = state()[4];
    assert.ok(fs.existsSync(path.join(servers, server)), "its record (the command line matched)");
    const listening = spawnSync("lsof", ["-nP", "-a", "-p", server, "-iTCP", "-sTCP:LISTEN", "-F", "n"], { encoding: "utf8" }).stdout;
    assert.deepEqual(listening.split("\n").filter((l) => l.startsWith("n")), ["n127.0.0.1:4798"]);
    const stop = spawnSync(runner, ["__blacksand-stop-stale-server"], { encoding: "utf8", env, timeout: 120_000 });
    assert.equal(stop.status, 0, stop.stderr);
    spawnSync("sh", ["-c", `cp -p "${asar}" "${asar}.new" && mv -f "${asar}.new" "${asar}"`]);
    await until(() => state()[3] === "running" && state()[4] !== server, "the restart on the new build", 120_000);
    supervisor.kill("SIGTERM");
    await until(() => supervisor.exitCode !== null, "the supervisor to stop", 30_000);
    assert.equal(state().length, 0, "its state file is gone");
  } finally {
    supervisor.kill("SIGKILL");
  }
});
