// node --test test/: the SSH runner agent accounts start servers through
// (lib/files/ssh-runner-blacksand.sh, rule ssh/runner-installed-blacksand-only), run
// against a fake app bundle and home: it runs the installed app's server with a
// private server.env; each server keeps a record (start time, build, command
// line) that names the runner while it starts the server, so a reconnect stops a
// server, or a runner, whose build was replaced, and never takes a reused pid for
// it. And the runner file one host's connections share is published whole and
// already executable (rule ssh/runner-published-whole), however many connect at
// once.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { makeRules } from "../lib/rules.mjs";
import { decodeTemplate } from "../ci/render-runner.mjs";

// -------------------------------------------------------- running the server --

const SOURCE = fs.readFileSync(new URL("../lib/files/ssh-runner-blacksand.sh", import.meta.url), "utf8");
const isMac = process.platform === "darwin";

test("the runner survives being a TypeScript template literal", () => {
  assert.equal(SOURCE.includes("`"), false, "no backticks");
  assert.equal(/(^|[^\\])\$\{/.test(SOURCE), false, "every ${ escaped");
  assert.equal(/\\\n/.test(SOURCE), false, "no backslash line continuations");
});

/** The runner as upstream's REMOTE_RUNNER_SCRIPT writes it: a set -eu script around this file's text. */
const rendered = () => `#!/bin/sh\nset -eu\nT3_ARCHIVE_VERSION='9.9.9'\n${new Function(`return \`${SOURCE}\`;`)()}`;

/** A home with the runner in it, and a fake app whose "Electron" reports what it was asked. */
function host() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-")));
  const home = path.join(dir, "home");
  const app = path.join(dir, "T3 Code (blacksand).app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "build 1");
  // A server loops until killed, so it shows in ps with its arguments; anything else echoes.
  fs.writeFileSync(
    path.join(app, "Contents", "MacOS", "T3 Code (blacksand)"),
    '#!/bin/sh\nif [ "$2" = serve ] && [ -z "${T3B_FAKE_ONESHOT:-}" ]; then while :; do sleep 1; done; fi\nprintf "%s|%s\\n" "$*" "${T3B_TEST_TOKEN:-}"\n',
    { mode: 0o755 },
  );
  fs.mkdirSync(home, { mode: 0o700 });
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, rendered(), { mode: 0o700 });
  const shared = path.join(dir, "Shared", "blacksand");
  fs.mkdirSync(shared, { recursive: true, mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: home, BLACKSAND_T3_APP: app, BLACKSAND_T3_UPDATE_REQUESTS: path.join(shared, "update-requests") };
  const run = (args, extra = {}) => spawnSync(runner, args, { encoding: "utf8", env: { ...env, ...extra } });
  return { dir, home, app, shared, runner, run, t3b: path.join(home, ".blacksand/t3") };
}

function writeEnv(t3b, { dirMode = 0o700, fileMode = 0o600 } = {}) {
  fs.mkdirSync(t3b, { recursive: true });
  fs.chmodSync(t3b, dirMode);
  fs.writeFileSync(path.join(t3b, "server.env"), "T3B_TEST_TOKEN=from-env\n");
  fs.chmodSync(path.join(t3b, "server.env"), fileMode);
}

test("it runs the installed app's server, loading a private server.env", () => {
  const { run, t3b, app } = host();
  writeEnv(t3b);
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs --version|from-env`);
});

test("a server.env others could read or swap is refused", () => {
  for (const [label, modes] of [["file 644", { fileMode: 0o644 }], ["folder 755", { dirMode: 0o755 }], ["file 640", { fileMode: 0o640 }]]) {
    const { run, t3b } = host();
    writeEnv(t3b, modes);
    const result = run(["--version"]);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /readable only by you/, label);
  }
  const { run, t3b, dir } = host();
  writeEnv(t3b);
  fs.renameSync(path.join(t3b, "server.env"), path.join(dir, "elsewhere.env"));
  fs.symlinkSync(path.join(dir, "elsewhere.env"), path.join(t3b, "server.env"));
  assert.equal(run(["--version"]).status, 1, "symlink");
  // The folder above it too: ~/.blacksand a link to somewhere else.
  const linked = host();
  const elsewhere = path.join(linked.dir, "elsewhere");
  writeEnv(path.join(elsewhere, "t3"));
  fs.symlinkSync(elsewhere, path.join(linked.home, ".blacksand"));
  assert.equal(linked.run(["--version"]).status, 1, "parent symlink");
});

test("ACL entries on server.env are removed before it's read", { skip: !isMac && "macOS ACLs" }, () => {
  const { run, t3b } = host();
  writeEnv(t3b);
  const file = path.join(t3b, "server.env");
  assert.equal(spawnSync("chmod", ["+a", "everyone allow read", file]).status, 0);
  assert.match(spawnSync("ls", ["-le", file], { encoding: "utf8" }).stdout, /everyone allow read/);
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(spawnSync("ls", ["-le", file], { encoding: "utf8" }).stdout, /allow/);
});

test("the server copies the pricing table the app's installer published, and only that", () => {
  const { run, shared, t3b } = host();
  const published = path.join(shared, "usage-model-rates.json");
  const copied = path.join(t3b, "userdata", "usage-model-rates.json");
  fs.writeFileSync(published, "{\"v\":1}");
  assert.equal(run(["serve"], { T3B_FAKE_ONESHOT: "1" }).status, 0);
  assert.equal(fs.readFileSync(copied, "utf8"), "{\"v\":1}");
  assert.equal(fs.statSync(copied).mode & 0o077, 0, "owner only");
  // A shared folder others can write isn't trusted.
  fs.chmodSync(shared, 0o775);
  fs.writeFileSync(published, "{\"v\":2}");
  assert.equal(run(["serve"], { T3B_FAKE_ONESHOT: "1" }).status, 0);
  assert.equal(fs.readFileSync(copied, "utf8"), "{\"v\":1}");
  fs.chmodSync(shared, 0o755);
  assert.equal(run(["serve"], { T3B_FAKE_ONESHOT: "1" }).status, 0);
  assert.equal(fs.readFileSync(copied, "utf8"), "{\"v\":2}");
});

// ------------------------------------------ server records and stale servers --

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVER_SCRIPT = `
if (process.argv[2] === "serve") {
  if (process.env.T3B_FAKE_FAIL) process.exit(3);
  if (process.env.T3B_FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  console.log(process.argv.slice(1).join(" "));
}
`;

/** A home with the runner, and an app whose app.asar is a folder holding the fake server. */
function recordsHost() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-")));
  const home = path.join(dir, "home");
  const app = path.join(dir, "T3 Code (blacksand).app");
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  const build = (where) => {
    fs.mkdirSync(path.join(where, "apps", "server", "dist"), { recursive: true });
    fs.writeFileSync(path.join(where, "apps", "server", "dist", "bin.mjs"), SERVER_SCRIPT);
  };
  build(asar);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "T3 Code (blacksand)"));
  fs.mkdirSync(home, { mode: 0o700 });
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, rendered(), { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, BLACKSAND_T3_APP: app, BLACKSAND_T3_UPDATE_REQUESTS: path.join(dir, "Shared", "blacksand", "update-requests") };
  const run = (args) => spawnSync(runner, args, { encoding: "utf8", env });
  const servers = [];
  const start = (extra = {}) => {
    const child = spawn(runner, ["serve", "--host", "127.0.0.1", "--port", "1", "--base-dir", path.join(home, ".blacksand/t3")], { env: { ...env, ...extra }, stdio: "ignore" });
    servers.push(child);
    return child;
  };
  // A new build replaces the whole app.asar, as an install replaces the bundle.
  const newBuild = () => {
    const next = `${asar}.next`;
    build(next);
    fs.rmSync(asar, { recursive: true });
    fs.renameSync(next, asar);
  };
  const records = path.join(home, ".blacksand/t3", "ssh-servers");
  const cleanup = () => servers.forEach((child) => child.kill("SIGKILL"));
  return { dir, home, app, runner, run, start, newBuild, records, cleanup };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ps = (field, pid) => spawnSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout;
const startedOf = (pid) => ps("lstart", pid).trim().split(/\s+/).join(" ");

async function waitFor(condition, tries = 100) {
  for (let i = 0; i < tries && !condition(); i++) await sleep(50);
  return condition();
}

test("each server keeps its own record: its start time, build and command line", async () => {
  const h = recordsHost();
  try {
    const server = h.start();
    const record = path.join(h.records, String(server.pid));
    assert.ok(await waitFor(() => fs.existsSync(record)), "recorded");
    const [started, build, args] = fs.readFileSync(record, "utf8").split("\n");
    assert.equal(started, startedOf(server.pid));
    assert.match(build, /^\d+:\d+:\d+:\d+$/);
    assert.ok(await waitFor(() => ps("args", server.pid).includes(" serve ")), "running as the server");
    assert.equal(args, ps("args", server.pid).trim());
    assert.ok(args.startsWith(`${h.app}/Contents/MacOS/T3 Code (blacksand) ${h.app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs serve `));
    assert.equal(fs.statSync(h.records).mode & 0o077, 0, "records are private");
  } finally {
    h.cleanup();
  }
});

test("a failed second start doesn't erase the running server's record; the stale one still stops", async () => {
  const h = recordsHost();
  try {
    const first = h.start();
    assert.ok(await waitFor(() => fs.existsSync(path.join(h.records, String(first.pid)))));
    const failed = h.start({ T3B_FAKE_FAIL: "1" });
    await new Promise((resolve) => failed.once("exit", resolve));
    assert.ok(fs.existsSync(path.join(h.records, String(first.pid))), "the first server's record is intact");
    // Same build: nothing stops, and the dead start's record is cleared.
    assert.equal(h.run(["__blacksand-stop-stale-server"]).status, 0);
    assert.equal(alive(first.pid), true);
    assert.equal(fs.existsSync(path.join(h.records, String(failed.pid))), false);
    h.newBuild();
    const stop = h.run(["__blacksand-stop-stale-server"]);
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(await waitFor(() => first.exitCode !== null || first.signalCode !== null), "stale: stopped");
    assert.deepEqual(fs.readdirSync(h.records), []);
  } finally {
    h.cleanup();
  }
});

test("a stale server that ignores SIGTERM is killed, and its record goes only then", async () => {
  const h = recordsHost();
  try {
    const server = h.start({ T3B_FAKE_IGNORE_TERM: "1" });
    const record = path.join(h.records, String(server.pid));
    assert.ok(await waitFor(() => fs.existsSync(record)));
    assert.ok(await waitFor(() => ps("args", server.pid).includes(" serve ")));
    await sleep(200); // its SIGTERM handler is in place
    h.newBuild();
    const stop = h.run(["__blacksand-stop-stale-server"]);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(server.signalCode ?? (await new Promise((resolve) => server.once("exit", (code, signal) => resolve(signal)))), "SIGKILL");
    assert.equal(fs.existsSync(record), false);
  } finally {
    h.cleanup();
  }
});

test("a stale server that can't be stopped keeps its record and fails the connection", () => {
  // pid 1 (launchd or init) is a live process this account can't signal: a
  // stand-in for a server that won't exit. Its record matches it exactly.
  const h = recordsHost();
  fs.mkdirSync(h.records, { recursive: true, mode: 0o700 });
  const record = path.join(h.records, "1");
  fs.writeFileSync(record, `${startedOf(1)}\nold-build\n${ps("args", 1).trim()}\n`);
  const stop = h.run(["__blacksand-stop-stale-server"]);
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /server 1 still runs a build this host has replaced and did not stop/);
  assert.equal(fs.existsSync(record), true, "kept until it's gone");
});

test("a reused pid is never taken for the recorded server", async () => {
  const h = recordsHost();
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await waitFor(() => ps("args", other.pid).includes("sleep"));
    fs.mkdirSync(h.records, { recursive: true, mode: 0o700 });
    const record = path.join(h.records, String(other.pid));
    // Same pid and command line, another start time: an earlier process with that pid.
    fs.writeFileSync(record, `Thu Jan  1 00:00:00 1970\nold-build\n${ps("args", other.pid).trim()}\n`);
    assert.equal(h.run(["__blacksand-stop-stale-server"]).status, 0);
    // Same pid and start time, another command line (another server's base folder).
    fs.writeFileSync(record, `${startedOf(other.pid)}\nold-build\n${ps("args", other.pid).trim()} --base-dir /elsewhere\n`);
    assert.equal(h.run(["__blacksand-stop-stale-server"]).status, 0);
    await sleep(100);
    assert.equal(alive(other.pid), true, "left alone");
    assert.equal(fs.existsSync(record), false, "the record no longer names a server");
  } finally {
    other.kill("SIGKILL");
  }
});

test("the launch rule lets a failed stop end the connection instead of reusing the server", () => {
  const rule = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((r) => r.id === "ssh/runner-installed-blacksand-only");
  const edit = rule.edits.find((e) => typeof e.replace === "string" && e.replace.includes("__blacksand-stop-stale-server"));
  assert.equal(edit.replace, '  "$RUNNER_FILE" __blacksand-stop-stale-server\n  "$RUNNER_FILE" --version >/dev/null\n');
});

// ----------------------------------------- a reconnect while a server starts --

const MV = spawnSync("/bin/sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
const LONG_SERVER = `if (process.argv[2] === "serve") setInterval(() => {}, 1000);`;

function startingHost() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const app = path.join(dir, "T3 Code (blacksand).app");
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  const build = (where) => {
    fs.mkdirSync(path.join(where, "apps", "server", "dist"), { recursive: true });
    fs.writeFileSync(path.join(where, "apps", "server", "dist", "bin.mjs"), LONG_SERVER);
  };
  build(asar);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "T3 Code (blacksand)"));
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, `#!/bin/sh\nset -eu\n${decodeTemplate(SOURCE)}`, { mode: 0o700 });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "mv"), `#!/bin/sh\n${JSON.stringify(MV)} "$@" || exit\ncase "$*" in\n  *ssh-servers*) : >"$HOME/published"; while [ ! -f "$HOME/continue" ]; do sleep 0.05; done ;;\nesac\n`, { mode: 0o700 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, BLACKSAND_T3_APP: app, BLACKSAND_T3_UPDATE_REQUESTS: path.join(dir, "Shared", "update-requests") };
  const child = spawn(runner, ["serve", "--host", "127.0.0.1", "--port", "1", "--base-dir", path.join(home, ".blacksand/t3")], { env, stdio: "ignore" });
  const record = path.join(home, ".blacksand/t3", "ssh-servers", String(child.pid));
  const stopStale = () => spawnSync(runner, ["__blacksand-stop-stale-server"], { encoding: "utf8", env, timeout: 30_000 });
  const resume = () => fs.writeFileSync(path.join(home, "continue"), "");
  const newBuild = () => {
    build(`${asar}.next`);
    fs.rmSync(asar, { recursive: true });
    fs.renameSync(`${asar}.next`, asar);
  };
  return { home, runner, child, record, stopStale, resume, newBuild, cleanup: () => (resume(), child.kill("SIGKILL")) };
}

const argsOf = (pid) => spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim();
const gone = (child) => child.exitCode !== null || child.signalCode !== null;

async function until(condition, what, ms = 20_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(25)) if (condition()) return;
  assert.fail(`timed out waiting for ${what}`);
}

test("a reconnect while a server starts keeps its record, and the server is stopped once its build is replaced", async () => {
  const h = startingHost();
  try {
    await until(() => fs.existsSync(path.join(h.home, "published")), "the record");
    const [, , server, starting] = fs.readFileSync(h.record, "utf8").split("\n");
    assert.equal(starting, argsOf(h.child.pid), "the record names the runner while it starts the server");
    const during = h.stopStale();
    assert.equal(during.status, 0, during.stderr);
    assert.equal(fs.existsSync(h.record), true, "kept: it's this server's");
    assert.equal(gone(h.child), false, "same build: left to start");
    h.resume();
    await until(() => argsOf(h.child.pid) === server, "the exec into the server");
    h.newBuild();
    const after = h.stopStale();
    assert.equal(after.status, 0, after.stderr);
    await until(() => gone(h.child), "the stale server to stop");
    assert.equal(fs.existsSync(h.record), false);
  } finally {
    h.cleanup();
  }
});

test("a runner still starting a build that's been replaced is stopped like its server", async () => {
  const h = startingHost();
  try {
    await until(() => fs.existsSync(path.join(h.home, "published")), "the record");
    h.newBuild();
    const stop = h.stopStale();
    assert.equal(stop.status, 0, stop.stderr);
    await until(() => gone(h.child), "the runner to stop");
    assert.equal(fs.existsSync(h.record), false);
  } finally {
    h.cleanup();
  }
});

test("the runner, rendered, is POSIX sh: sh, bash --posix, dash and ShellCheck as CI runs them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-lint-"));
  const file = path.join(dir, "runner.sh");
  fs.writeFileSync(file, `#!/bin/sh\n${decodeTemplate(SOURCE)}`);
  const checks = [
    ["sh", ["-n", file]],
    ["bash", ["--posix", "-n", file]],
    ["dash", ["-n", file]],
    ["shellcheck", ["-s", "sh", "-S", "warning", "-e", "SC1090,SC3067", file]],
  ];
  for (const [tool, args] of checks) {
    const result = spawnSync(tool, args, { encoding: "utf8" });
    if (result.error?.code === "ENOENT" && tool !== "sh") continue; // CI runs every one of them
    assert.equal(result.status, 0, `${tool}: ${result.stdout}${result.stderr}`);
  }
});

// ----------------------------------------------------- publishing the runner --

const rule = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((r) => r.id === "ssh/runner-published-whole");
const [launch, pairing] = rule.edits;

/** Runs `script` in /bin/sh; resolves with its exit code. */
const sh = (script, env) =>
  new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", script], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("close", resolve);
  });

/**
 * `writers` processes each publish the runner `rounds` times with `publish`
 * (a script fragment, as tunnel.ts writes it: RUNNER_NEXT already holds the new
 * runner for the launch script's lines, or the runner comes in on a heredoc for
 * the pairing script's), while `readers` processes start the runner over and
 * over until the writers are done. Returns how many starts didn't print "ok".
 */
async function race(publish, { writers = 4, rounds = 150, readers = 4 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-")));
  const state = path.join(dir, "ssh-launch", "key");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const runner = path.join(state, "run-t3.sh");
  fs.writeFileSync(runner, "#!/bin/sh\necho ok\n", { mode: 0o700 });
  const done = path.join(dir, "done");
  const failures = path.join(dir, "failures");
  // What tunnel.ts writes before these lines, with its runner a script that prints ok.
  const body = publish.includes("@@T3_RUNNER_SCRIPT@@")
    ? publish.replace("@@T3_RUNNER_SCRIPT@@", "#!/bin/sh\n# a runner of some length, as the real one is\n" + "# padding\n".repeat(200) + "echo ok")
    : `cat >"$RUNNER_NEXT" <<'SH'\n#!/bin/sh\n${"# padding\n".repeat(200)}echo ok\nSH\n${publish}`;
  const one = `set -eu\numask 077\nSTATE_DIR=${JSON.stringify(state)}\nRUNNER_FILE="$STATE_DIR/run-t3.sh"\nRUNNER_NEXT="$STATE_DIR/run-t3.next.$$"\n${body}`;
  const writer = `i=0; while [ $i -lt ${rounds} ]; do /bin/sh -c "$ONE" || true; i=$((i + 1)); done`;
  const reader = `while [ ! -e "$DONE" ]; do out=$("$RUNNER" 2>/dev/null) || out=failed; [ "$out" = ok ] || echo x >> "$FAILURES"; done`;
  const env = { ONE: one, DONE: done, FAILURES: failures, RUNNER: runner };
  const reading = Array.from({ length: readers }, () => sh(reader, env));
  await Promise.all(Array.from({ length: writers }, () => sh(writer, env)));
  fs.writeFileSync(done, "");
  await Promise.all(reading);
  const count = fs.existsSync(failures) ? fs.readFileSync(failures, "utf8").split("\n").filter(Boolean).length : 0;
  const left = fs.readdirSync(state).filter((name) => name !== "run-t3.sh");
  fs.rmSync(dir, { recursive: true, force: true });
  return { count, left };
}

test("the rule's lines replace exactly upstream's: the launch script's rename-then-chmod, the pairing script's in-place rewrite", () => {
  assert.equal(launch.find, 'mv "$RUNNER_NEXT" "$RUNNER_FILE"\nchmod 700 "$RUNNER_FILE"\n');
  assert.equal(launch.replace, 'chmod 700 "$RUNNER_NEXT"\nmv "$RUNNER_NEXT" "$RUNNER_FILE"\n');
  assert.match(pairing.find, /^cat >"\$RUNNER_FILE" <<'SH'\n@@T3_RUNNER_SCRIPT@@\nSH\nchmod 700 "\$RUNNER_FILE"\n$/);
  assert.match(pairing.replace, /chmod 700 "\$RUNNER_NEXT"\nmv "\$RUNNER_NEXT" "\$RUNNER_FILE"\n$/);
  assert.doesNotMatch(pairing.replace, /\$\{/, "nothing a TypeScript template literal would expand");
});

test("with the rule, concurrent launches never start a runner that isn't whole and executable", async () => {
  for (const [label, publish] of [["launch", launch.replace], ["pairing", pairing.replace]]) {
    const { count, left } = await race(publish);
    assert.equal(count, 0, `${label}: starts that failed`);
    assert.deepEqual(left, [], `${label}: no temporary left behind`);
  }
});

test("upstream's lines lose that race (positive control: the harness catches it)", async () => {
  for (const [label, publish] of [["launch", launch.find], ["pairing", pairing.find]]) {
    const { count } = await race(publish, { rounds: 400 });
    assert.ok(count > 0, `${label}: upstream's publishing never lost a start in 1600 publishes`);
  }
});
