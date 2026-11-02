// node --test test/: root's build tools (install.sh install_build_pnpm) and their
// lock. The build account gets the pinned pnpm and its Vite+ home from a tools
// directory only root can change: made in a stage of its own, modes set outright
// and ACLs cleared, checked, swapped in and checked in place, the set before kept
// until then and put back if anything fails or the install is stopped. Under the
// tools' lock (root:admin 0640 with one read entry for the build account, so agent
// accounts can't open it to hold it), which the installing shell holds on its own
// descriptor and a build holds shared while it uses them: no build sees the tools
// half-replaced, and two installs never work on them at once. Scratch tools, a
// stand-in build account, and stubs for what needs root or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BUILD_TOOLS_ROOT, PNPM_VERSION, aclProblem, buildToolsLock, checkVitePlusHome, holdBuildTools, lockBuildTools, pnpmTarget, runsAsBuilder, toolsLockPolicy, toolsLockProblem } from "../lib/pnpm.mjs";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), "utf8");
const INSTALL_SH = read("install.sh");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-pnpm-")));

/** Runs install.sh's `script` (bash) with its functions sourced; stubs go first in `script`. */
const installSh = (script, { cwd, env = {} } = {}) =>
  spawnSync("bash", ["-c", `source ${JSON.stringify(new URL("../install.sh", import.meta.url).pathname)}\nset +e\n${script}`], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

/** An account that's there to name in an ACL entry, standing in for the build account. */
const STAND_IN_BUILDER = "nobody";

/** The tools' lock policy with this account in root's place (chown is stubbed) and its directory's group, as a scratch lock gets them. */
const scratchLockPolicy = (file) => ({ ...toolsLockPolicy({ builder: STAND_IN_BUILDER }), uid: process.getuid(), gid: fs.statSync(path.dirname(file)).gid });

const PNPM_MODULE = new URL("../lib/pnpm.mjs", import.meta.url).href;

/**
 * A scratch place for root's tools, `tools` under a parent with `space` in its name,
 * and stubs for what needs root or the network. The tools' lock is made and taken
 * for real (install.sh provision_tools_lock, hold_tools_lock), checked against
 * scratchLockPolicy: everything but root's ownership and the admin group.
 */
function buildToolsScratch() {
  const dir = scratch();
  const content = `#!/bin/sh\necho ${PNPM_VERSION}\n`;
  const digest = sha256(content);
  const tools = path.join(dir, "Application Support", "blacksand", "tools");
  fs.mkdirSync(path.join(dir, "Application Support"));
  const lockcheck = path.join(dir, "lockcheck.mjs");
  fs.writeFileSync(
    lockcheck,
    `import fs from "node:fs";\nimport path from "node:path";\nimport { toolsLockPolicy, toolsLockProblem } from ${JSON.stringify(new URL("../lib/pnpm.mjs", import.meta.url).href)};\n` +
      `const [file, fd] = process.argv.slice(2);\n` +
      `const policy = { ...toolsLockPolicy({ builder: ${JSON.stringify(STAND_IN_BUILDER)} }), uid: process.getuid(), gid: fs.statSync(path.dirname(file)).gid };\n` +
      `const problem = toolsLockProblem(file, { policy, fd: fd === undefined ? null : Number(fd), ancestors: () => null });\n` +
      `if (problem) { console.error(problem); process.exit(1); }\n`,
  );
  const stubs = (extra = "") => `
BUILD_TOOLS=${JSON.stringify(tools)}
BUILDER=${STAND_IN_BUILDER}
tools_lock_problem() { node ${JSON.stringify(lockcheck)} "$BUILD_TOOLS.lock" "$@"; }
asroot() { case "$1" in chown) return 0 ;; esac; "$@"; }
as_builder() { "$@"; }
pnpm_fetch() { echo pnpm_fetch >> ${JSON.stringify(path.join(dir, "calls.log"))}; while [ -n "\${T3B_GATE:-}" ] && [ ! -e "$T3B_GATE" ] && [ -d "\${T3B_GATE%/*}" ]; do sleep 0.05; done; if [ -n "\${T3B_LOCK_PROBE:-}" ]; then command node "$T3B_LOCK_PROBE" >> "$T3B_LOCK_PROBE.log"; fi; mkdir -p "$1/pnpm/lib/node_modules/pnpm" && printf '#!/bin/sh\\necho ${PNPM_VERSION}\\n' > "$1/pnpm/lib/node_modules/pnpm/pnpm" && chmod 755 "$1/pnpm/lib/node_modules/pnpm/pnpm" && command node --input-type=module -e "import { seedVitePlusHome } from '${PNPM_MODULE}'; seedVitePlusHome(process.argv[1], process.argv[2]);" "$1/vite-plus" "$1/pnpm/lib/node_modules/pnpm/pnpm"; }
${extra}`;
  return { dir, tools, digest, stubs, calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []) };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `ready()` (polled), failing after `ms`. */
async function until(ready, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(50);
  }
}

/** What's beside the tools but them and their lock: stages and backups an install left. */
const besideTools = (t) => fs.readdirSync(path.dirname(t.tools)).filter((name) => name !== path.basename(t.tools) && name !== `${path.basename(t.tools)}.lock`);

/** Stubs for an install that must rebuild: the tools fail their first check (under the lock), then `final` decides the check in place. */
const rebuildStubs = (t, extra = "", final = "return 0") => {
  const count = path.join(t.dir, `count-${Math.random().toString(36).slice(2)}`);
  return t.stubs(`build_tools_problem() { if [ "$1" = ${JSON.stringify(t.tools)} ]; then n=$(( $(cat ${JSON.stringify(count)} 2>/dev/null || echo 0) + 1 )); echo "$n" > ${JSON.stringify(count)}; [ "$n" -le 1 ] && { echo stale; return 1; }; ${final}; fi; return 0; }\n${extra}`);
};

/** Stubs for an install whose tools pass when they're there. */
const passStubs = (t, extra = "") => t.stubs(`build_tools_problem() { [ -e "$1/pnpm" ] || { echo missing; return 1; }; }\n${extra}`);

/** Pids of `pid`'s descendants, with their commands. */
function descendants(pid) {
  const rows = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout.trim().split("\n").map((line) => line.trim().split(/\s+/));
  const found = [];
  const walk = (parent) => {
    for (const [child, ppid, comm] of rows) if (Number(ppid) === parent) found.push({ pid: Number(child), comm }), walk(Number(child));
  };
  walk(pid);
  return found;
}

/** installSh's `script` in the background: its output so far, and its end. A lock it waits for long fails it in 20 s. */
function installShAsync(script, env = {}) {
  const child = spawn("bash", ["-c", `source ${JSON.stringify(new URL("../install.sh", import.meta.url).pathname)}\nset +e\n${script}`], { env: { ...process.env, BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS: "20", ...env } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const done = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, out })));
  // For a test's cleanup: lets it end for up to 10 s, then kills it.
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = await Promise.race([done.then(() => true), sleep(10_000).then(() => false)]);
    if (!ended) child.kill("SIGKILL");
    await done;
  };
  return { child, out: () => out, done, stop };
}

// --------------------------------------------------------- installing them --

test("install_build_pnpm stages the pinned tools beside the old, sets modes and clears ACLs whatever the umask, checks before it swaps, and keeps the old ones on failure", () => {
  const t = buildToolsScratch();
  try {
    // An inherited grant on the parent, as an ACL would hand down; a umask that would make everything 0700.
    if (process.platform === "darwin") spawnSync("/bin/chmod", ["+a", `user:${os.userInfo().username} allow add_file,add_subdirectory,write,delete_child,file_inherit,directory_inherit`, path.join(t.dir, "Application Support")]);
    const checked = path.join(t.dir, "checked.log");
    const pass = (extra = "") => t.stubs(`build_tools_problem() { echo "$1" >> ${JSON.stringify(checked)}; [ -e "$1/pnpm" ] || { echo missing; return 1; }; ${extra} return 0; }`);
    const first = installSh(`umask 077\n${pass()}\ninstall_build_pnpm asroot && echo DONE`);
    assert.match(first.stdout, /DONE/, first.stderr);
    const checks = fs.readFileSync(checked, "utf8").trim().split("\n");
    assert.deepEqual(checks.filter((at) => at === t.tools).length, 2, "checked under the lock, and in place");
    assert.match(checks[1], new RegExp(`^${escapeRegExp(t.tools)}\\.new\\.[A-Za-z0-9]{6}$`), "staged in a directory of its own");
    const lock = buildToolsLock(t.tools);
    assert.equal(toolsLockProblem(lock, { policy: scratchLockPolicy(lock), ancestors: () => null }), null, "the lock beside them, as the policy says, whatever the umask");
    // Every directory 755 and file 644 or 755, whatever the umask; no ACL entries at all.
    for (const entry of fs.readdirSync(t.tools, { recursive: true }).map(String)) {
      const full = path.join(t.tools, entry);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      assert.equal(stat.mode & 0o777, stat.isDirectory() || stat.mode & 0o100 ? 0o755 : 0o644, entry);
      if (process.platform === "darwin") assert.equal(aclProblem(full), null, entry);
    }
    assert.equal(fs.statSync(path.join(t.dir, "Application Support", "blacksand")).mode & 0o777, 0o755, "the parent it made too");
    const opts = { target: pnpmTarget(), digests: { [pnpmTarget()]: t.digest }, rootOwned: false };
    checkVitePlusHome(path.join(t.tools, "vite-plus"), opts);
    assert.deepEqual(besideTools(t), [], "nothing left beside it");
    // Kept as it is while it passes: no reinstall.
    fs.rmSync(checked);
    const again = installSh(`${pass()}\ninstall_build_pnpm asroot && echo DONE`);
    assert.match(again.stdout, /DONE/, again.stderr);
    assert.equal(t.calls().length, 1, "installed once");
    assert.deepEqual(t.calls(), ["pnpm_fetch"]);
    // A failed rebuild (the copy fails, or the swap) leaves the working tools in place; install.sh runs under set -e, as here.
    const native = path.join(t.tools, "vite-plus", "package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin", "pnpm.native");
    const before = fs.readFileSync(native, "utf8");
    for (const failing of ["cp) return 73", 'mv) case "$2" in *.new.*) return 1 ;; esac']) {
      const failed = installSh(`${rebuildStubs(t, `asroot() { case "$1" in chown) return 0 ;; ${failing} ;; esac; "$@"; }`)}\nset -e\ninstall_build_pnpm asroot; echo "status $?"`);
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      assert.doesNotMatch(failed.stdout, /status/);
      assert.equal(fs.readFileSync(native, "utf8"), before, `${failing}: the working tools are still there`);
    }
  } finally {
    if (process.platform === "darwin") spawnSync("/bin/chmod", ["-R", "-N", t.dir]);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("install.sh's build_tools_problem runs lib/pnpm.mjs's check, then checks what the build account can open and change", () => {
  const t = buildToolsScratch();
  try {
    // lib/pnpm.mjs's own check, as install.sh runs it: tools that aren't root's are refused here, at install.
    const lib = installSh(`${t.stubs()}\nPNPM_CHECK=${JSON.stringify(new URL("../lib/pnpm-cli.mjs", import.meta.url).pathname)}\nmkdir -p "$BUILD_TOOLS/pnpm/lib/node_modules/pnpm"\nbuild_tools_problem "$BUILD_TOOLS"; echo "status $?"`);
    assert.match(lib.stdout + lib.stderr, /must be root's and only root's to change|isn't root's/);
    assert.match(lib.stdout, /status 1/);
    // With that check passed (stubbed: these scratch files can't be root's), what the account can do decides.
    const tree = installSh(`${t.stubs("node() { return 0; }")}\nPNPM_CHECK=unused\npnpm_fetch "$BUILD_TOOLS"\nmkdir -p "$BUILD_TOOLS/vite-plus/locked"\nchmod 000 "$BUILD_TOOLS/vite-plus/locked"\nbuild_tools_problem "$BUILD_TOOLS"; echo "status $?"\nchmod 755 "$BUILD_TOOLS/vite-plus/locked"\nbuild_tools_problem "$BUILD_TOOLS"; echo "status $?"`);
    assert.match(tree.stdout, new RegExp(`${STAND_IN_BUILDER} can't open: .*vite-plus/locked\nstatus 1`), tree.stdout + tree.stderr);
    assert.match(tree.stdout, new RegExp(`${STAND_IN_BUILDER} can change: [\\s\\S]*status 1`), "these files are this account's to change");
    // The account runs as the build account's own setup does, before its ready marker.
    const setup = INSTALL_SH.slice(0, INSTALL_SH.indexOf('  as_builder touch "$BUILDER_HOME/.blacksand-builder"'));
    assert.ok(setup.lastIndexOf("\n  install_build_pnpm sudo\n") > setup.lastIndexOf("setup_builder"), "install_build_pnpm runs in the build account's setup, before its marker");
    assert.doesNotMatch(INSTALL_SH, /install_pnpm "\$BUILDER_HOME\/\.local"/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("the tools before stay until the new ones pass in place, and come back if the install fails or is stopped", async () => {
  const t = buildToolsScratch();
  try {
    const put = installSh(`${t.stubs(`build_tools_problem() { [ -e "$1/pnpm" ] || { echo missing; return 1; }; }`)}\ninstall_build_pnpm asroot && echo DONE`);
    assert.match(put.stdout, /DONE/, put.stderr);
    const native = path.join(t.tools, "vite-plus", "package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin", "pnpm.native");
    fs.chmodSync(native, 0o755);
    const before = fs.readFileSync(native, "utf8");
    // The new ones fail their check in place: they go, the ones before come back.
    const failed = installSh(`${rebuildStubs(t, "", 'echo "broken in place"; return 1')}\nset -e\ninstall_build_pnpm asroot; echo "status $?"`);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, new RegExp(`the build tools put in .* aren't fit for ${STAND_IN_BUILDER} \\(broken in place\\); the ones before, if any, are back`));
    assert.equal(fs.readFileSync(native, "utf8"), before);
    assert.deepEqual(besideTools(t), []);
    // Stopped between the swap's two renames: a signal puts them back at once.
    const stop = (signal) => rebuildStubs(t, `asroot() { case "$1" in chown) return 0 ;; mv) case "$2" in *.new.*) kill -${signal} $$ ;; esac ;; esac; "$@"; }`);
    const termed = installSh(`${stop("TERM")}\nset -e\ninstall_build_pnpm asroot; echo "status $?"`);
    assert.equal(termed.status, 130, termed.stdout + termed.stderr);
    assert.equal(fs.readFileSync(native, "utf8"), before, "back at once");
    assert.equal(t.calls().length, 3, "one install, then the failed and the stopped ones'");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ their lock --

test("two installs never work on the tools at once: the second waits for the first, then keeps what it put in place", async () => {
  const t = buildToolsScratch();
  const gate = path.join(t.dir, "go");
  const runs = [];
  try {
    const stubs = t.stubs(`build_tools_problem() { [ -e "$1/pnpm/lib/node_modules/pnpm/pnpm" ] || { echo missing; return 1; }; }`);
    // The first install's download waits at a gate, so the second starts while the first is part-way.
    const first = installShAsync(`${stubs}\ninstall_build_pnpm asroot && echo FIRST-DONE`, { T3B_GATE: gate });
    runs.push(first);
    await until(() => t.calls().length === 1, "the first install staging");
    const second = installShAsync(`${stubs}\ninstall_build_pnpm asroot && echo SECOND-DONE`, { T3B_GATE: gate });
    runs.push(second);
    await until(() => /waiting: a build is using the build tools, or another \.\/install\.sh is replacing them/.test(second.out()), "the second install waiting", 20_000);
    await sleep(300);
    assert.equal(t.calls().length, 1, "the second hasn't started a stage of its own");
    assert.equal(besideTools(t).filter((name) => name.includes(".new.")).length, 1, "one stage only: the first install's");
    fs.writeFileSync(gate, "");
    const [a, b] = await Promise.all([first.done, second.done]);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    assert.match(a.out, /FIRST-DONE/);
    assert.match(b.out, /SECOND-DONE/);
    assert.equal(t.calls().length, 1, "the second kept the tools the first put in place");
    checkVitePlusHome(path.join(t.tools, "vite-plus"), { target: pnpmTarget(), digests: { [pnpmTarget()]: t.digest }, rootOwned: false });
    assert.deepEqual(besideTools(t), [], "no stage or backup left");
  } finally {
    fs.writeFileSync(gate, "");
    await Promise.all(runs.map((run) => run.stop()));
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("an install waits for a build using the tools before it replaces them, and a build waits for an install", async () => {
  const t = buildToolsScratch();
  try {
    const put = installSh(`${t.stubs(`build_tools_problem() { [ -e "$1/pnpm" ] || { echo missing; return 1; }; }`)}\ninstall_build_pnpm asroot && echo DONE`);
    assert.match(put.stdout, /DONE/, put.stderr);
    const lock = buildToolsLock(t.tools);
    const native = path.join(t.tools, "vite-plus", "package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin", "pnpm.native");
    const before = fs.readFileSync(native, "utf8");
    // A build as the build account holds the lock shared (lib/build.mjs holdBuildTools) while it runs pnpm and Vite+.
    const build = await lockBuildTools({ file: lock, shared: true, rootOwned: false });
    // What the install's download sees: whether the lock is still held (by it) while it works.
    const probe = path.join(t.dir, "probe.mjs");
    fs.writeFileSync(probe, `import { lockBuildTools } from ${JSON.stringify(new URL("../lib/pnpm.mjs", import.meta.url).href)};\ntry {\n  await (await lockBuildTools({ file: ${JSON.stringify(lock)}, shared: true, rootOwned: false, waitMs: 300 }))();\n  console.log("free");\n} catch {\n  console.log("held");\n}\n`);
    const install = installShAsync(`${rebuildStubs(t)}\ninstall_build_pnpm asroot && echo DONE`, { T3B_LOCK_PROBE: probe });
    t.runs = [install];
    await until(() => /waiting: a build is using the build tools/.test(install.out()), "the install waiting for the build", 20_000);
    await sleep(300);
    assert.equal(t.calls().length, 1, "nothing staged meanwhile");
    assert.equal(fs.readFileSync(native, "utf8"), before, "the build's tools untouched");
    assert.deepEqual(besideTools(t), []);
    await build();
    const done = await install.done;
    assert.equal(done.code, 0, done.out);
    assert.equal(t.calls().length, 2, "replaced once the build let go");
    assert.equal(fs.readFileSync(`${probe}.log`, "utf8"), "held\n", "and the install, having waited, held the lock while it worked");
    // An install holding it (exclusive): a build waits, and gives up saying what holds it.
    const gate = path.join(t.dir, "let-go");
    const holder = installShAsync(`${passStubs(t)}\nhold_tools_lock\necho HELD\nwhile [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.05; done\nrelease_tools_lock\necho RELEASED\nsleep 30`);
    t.runs.push(holder);
    await until(() => /HELD/.test(holder.out()), "the install's shell holding it");
    const waits = [];
    await assert.rejects(lockBuildTools({ file: lock, shared: true, rootOwned: false, waitMs: 500, report: (line) => waits.push(line) }), new RegExp(`^Error: couldn't take the build tools' lock ${escapeRegExp(lock)}: gave up after 0\\.5 s: \\./install\\.sh is replacing the build tools \\(\`lsof ${escapeRegExp(lock)}\` shows what holds it\\)$`));
    assert.deepEqual(waits, [`waiting: ./install.sh is replacing the build tools (${lock})`]);
    // Its shell lets go when it closes fd 8, while it goes on running.
    fs.writeFileSync(gate, "");
    await until(() => /RELEASED/.test(holder.out()), "the shell letting go");
    await (await lockBuildTools({ file: lock, shared: false, rootOwned: false, waitMs: 1000 }))();
    holder.child.kill("SIGKILL");
  } finally {
    await Promise.all((t.runs ?? []).map((run) => run.stop()));
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a build as the build account holds the tools' lock shared from before it first uses them to after the last", async () => {
  const build = read("lib/build.mjs");
  const body = build.slice(build.indexOf("export async function buildArtifact("), build.indexOf("export function resolveLockfile("));
  const at = (text) => body.indexOf(text);
  const hold = at("releaseTools = await holdBuildTools({ report: log });");
  assert.ok(hold > 0 && hold < at("checkVitePlusHome(VITE_PLUS_HOME);") && hold < at("await installDependencies("), "before the first use");
  assert.ok(at("    await releaseTools();\n    stages.cleanup();") > at("pruneStore();"), "let go in finally, after the store prune");
  // As you (CI, --unisolated-build), your own tools: nothing to hold.
  if (!runsAsBuilder()) {
    const { holdBuildTools } = await import("../lib/pnpm.mjs");
    await (await holdBuildTools())();
  }
  // As the build account: root's lock, refused unless root's and only root's to change, and named when missing.
  const dir = scratch();
  try {
    const file = path.join(dir, "tools.lock");
    await assert.rejects(lockBuildTools({ file, shared: true, rootOwned: false }), /it isn't there; rerun \.\/install\.sh/);
    fs.writeFileSync(file, "");
    await assert.rejects(lockBuildTools({ file, shared: true, rootOwned: true }), new RegExp(`tools\\.lock is owner uid ${process.getuid()}, .*, not uid 0, gid ${toolsLockPolicy().gid}, mode ${toolsLockPolicy().mode.toString(8)}; rerun \\./install\\.sh`));
    fs.symlinkSync(file, path.join(dir, "link.lock"));
    await assert.rejects(lockBuildTools({ file: path.join(dir, "link.lock"), shared: true, rootOwned: false }), /couldn't take the build tools' lock/);
    const [a, b] = [await lockBuildTools({ file, shared: true, rootOwned: false, waitMs: 1000 }), await lockBuildTools({ file, shared: true, rootOwned: false, waitMs: 1000 })];
    await a();
    await b();
    // holdBuildTools, as the build account runs it (its policy check stood in for): held shared until released, so an install waits.
    const held = await holdBuildTools({ builder: true, file, lockProblem: () => null });
    await assert.rejects(lockBuildTools({ file, shared: false, rootOwned: false, waitMs: 300 }), /gave up after 0\.3 s: a build is using the build tools/);
    await held();
    await (await lockBuildTools({ file, shared: false, rootOwned: false, waitMs: 1000 }))();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(buildToolsLock(), `${BUILD_TOOLS_ROOT}.lock`);
  assert.match(INSTALL_SH, /local lock="\$BUILD_TOOLS\.lock"/, "install.sh holds the same lock");
  assert.match(INSTALL_SH, /exec 8<"\$lock"/, "on its own descriptor");
  assert.doesNotMatch(INSTALL_SH, /hold-tools-lock/, "no helper holds it");
});

const ACL_SKIP = process.platform !== "darwin" && "macOS ACLs";

const aclLines = (file) => spawnSync("/bin/ls", ["-lde", "--", file], { encoding: "utf8" }).stdout.split("\n").slice(1).filter((line) => line.trim());

test("the tools' lock only root, admins and the build account can open: root:admin 0640 and one ACL entry, checked exactly", () => {
  assert.deepEqual(toolsLockPolicy({ platform: "darwin", builder: "_blacksand-build" }), { uid: 0, gid: 80, mode: 0o640, acl: ["user:_blacksand-build allow read"] });
  assert.deepEqual(toolsLockPolicy({ platform: "linux" }), { uid: 0, gid: 0, mode: 0o644, acl: [] }, "no agent accounts there, as for the build account's home");
  assert.equal(toolsLockPolicy({ platform: "darwin" }).mode & 0o007, 0, "nothing for other accounts");
  assert.equal(toolsLockPolicy({ platform: "darwin" }).mode & 0o222 & ~0o200, 0, "nobody but root may write it");
  // What the check refuses, by stand-in stats (path → uid, gid, mode, kind) and ACL listings.
  const lock = "/x/tools.lock";
  const stat = (over = {}) => () => ({ uid: 0, gid: 80, mode: 0o100640, dev: 1, ino: 2, isSymbolicLink: () => over.link === true, isFile: () => over.file !== false, ...over });
  const listing = (...entries) => () => ({ status: 0, stdout: [`-rw-r-----+ 1 root  admin  0 Oct 31 10:00 ${lock}`, ...entries.map((entry, i) => ` ${i}: ${entry}`)].join("\n") });
  const check = (over, run = listing("user:_blacksand-build allow read")) => toolsLockProblem(lock, { platform: "darwin", builder: "_blacksand-build", lstat: stat(over), run, ancestors: () => null });
  assert.equal(check({}), null);
  assert.match(check({ link: true }), /is a symlink/);
  assert.match(check({ file: false }), /isn't a regular file/);
  assert.match(check({ mode: 0o100644 }), /mode 644, not uid 0, gid 80, mode 640/, "the 0644 one any account could open");
  assert.match(check({ gid: 20 }), /group gid 20/, "staff: every standard account, agents included");
  assert.match(check({ uid: 501 }), /owner uid 501/);
  assert.match(check({}, listing()), /access control list is empty, not user:_blacksand-build allow read/);
  assert.match(check({}, listing("user:_blacksand-build allow read", "group:everyone allow read")), /group:everyone allow read/);
  assert.match(check({}, listing("user:_blacksand-build inherited allow read")), /inherited/);
  assert.match(check({}, listing("user:agent1 allow read")), /user:agent1 allow read, not user:_blacksand-build allow read/);
  assert.match(check({}, () => ({ status: 1, stdout: "" })), /can't be read/);
  assert.match(toolsLockProblem(lock, { platform: "darwin", builder: "_blacksand-build", lstat: stat(), run: listing("user:_blacksand-build allow read"), ancestors: () => "/x isn't root's (owner uid 501)" }), /the directories above .*: \/x isn't root's/);
  assert.match(toolsLockProblem(lock, { platform: "darwin", lstat: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, ancestors: () => null }), /isn't there/);
});

test("an account outside the lock's group and ACL can't open it, the one its entry names can, and two readers keep the writer out", { skip: ACL_SKIP }, async () => {
  const t = buildToolsScratch();
  try {
    // An agent's view: no owner, group or ACL entry of its own, and no bits for others (here, this account on a 0000 file).
    const file = path.join(t.dir, "probe.lock");
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o000);
    assert.throws(() => fs.openSync(file, "r"), /EACCES/);
    // The build account's view: its one ACL entry lets it read, whatever the mode bits.
    assert.equal(spawnSync("/bin/chmod", ["+a", `user:${os.userInfo().username} allow read`, file]).status, 0);
    fs.closeSync(fs.openSync(file, "r"));
    assert.throws(() => fs.openSync(file, "r+"), /EACCES/, "read only: it can't write it");
    // The lock install.sh makes: nothing for others, exactly the build account's entry.
    fs.mkdirSync(path.dirname(buildToolsLock(t.tools)), { recursive: true });
    const made = installSh(`${passStubs(t)}\nprovision_tools_lock asroot && echo MADE`);
    assert.match(made.stdout, /MADE/, made.stderr);
    const lock = buildToolsLock(t.tools);
    assert.equal(fs.statSync(lock).mode & 0o7777, 0o640);
    assert.deepEqual(aclLines(lock), [` 0: user:${STAND_IN_BUILDER} allow read`]);
    // Two readers (builds) at once; the writer (an install's shell) waits for both, then holds it alone.
    const [a, b] = [await lockBuildTools({ file: lock, shared: true, rootOwned: false, waitMs: 1000 }), await lockBuildTools({ file: lock, shared: true, rootOwned: false, waitMs: 1000 })];
    const writer = installSh(`${passStubs(t)}\nhold_tools_lock && echo HELD`, { env: { BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS: "1" } });
    assert.doesNotMatch(writer.stdout, /HELD/);
    assert.match(writer.stderr, /gave up after 1 s waiting for the build tools' lock .*: a build is using the build tools, or another \.\/install\.sh is replacing them \(`lsof .*` shows what holds it\)/);
    await a();
    assert.doesNotMatch(installSh(`${passStubs(t)}\nhold_tools_lock && echo HELD`, { env: { BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS: "1" } }).stdout, /HELD/, "one reader left is enough");
    await b();
    const alone = installShAsync(`${passStubs(t)}\nhold_tools_lock && echo HELD\nsleep 30`);
    t.runs = [alone];
    await until(() => /HELD/.test(alone.out()), "the writer");
    await assert.rejects(lockBuildTools({ file: lock, shared: true, rootOwned: false, waitMs: 300 }), /gave up/);
    alone.child.kill("SIGKILL");
  } finally {
    await Promise.all((t.runs ?? []).map((run) => run.stop()));
    spawnSync("/bin/chmod", ["-R", "-N", t.dir]);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("install.sh makes the lock without following anything there, and fixes one in place, never replacing it", { skip: ACL_SKIP }, () => {
  const t = buildToolsScratch();
  try {
    const lock = buildToolsLock(t.tools);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // A symlink planted at its path: refused before any step, its target untouched.
    const victim = path.join(t.dir, "victim");
    fs.writeFileSync(victim, "PRIVATE", { mode: 0o600 });
    fs.symlinkSync(victim, lock);
    const planted = installSh(`${passStubs(t)}\nset -e\ninstall_build_pnpm asroot; echo "status $?"`);
    assert.equal(planted.status, 1);
    assert.match(planted.stderr, /tools\.lock isn't a regular file \(a symlink\?\); remove it/);
    assert.equal(fs.statSync(victim).mode & 0o7777, 0o600);
    assert.deepEqual(aclLines(victim), []);
    assert.ok(fs.lstatSync(lock).isSymbolicLink(), "left as it was");
    assert.equal(t.calls().length, 0);
    fs.rmSync(lock);
    fs.mkdirSync(lock);
    assert.match(installSh(`${passStubs(t)}\nset -e\ninstall_build_pnpm asroot`).stderr, /isn't a regular file/, "nor a directory");
    fs.rmSync(lock, { recursive: true });
    // One from before (0644, any account could open it), with an extra grant: fixed on the same file.
    fs.writeFileSync(lock, "");
    fs.chmodSync(lock, 0o644);
    spawnSync("/bin/chmod", ["+a", "group:everyone allow read", lock]);
    const inode = fs.statSync(lock).ino;
    const fixed = installSh(`${passStubs(t)}\nprovision_tools_lock asroot && echo FIXED`);
    assert.match(fixed.stdout, /FIXED/, fixed.stderr);
    assert.equal(fs.statSync(lock).ino, inode, "the same file: a build's lock on it still counts");
    assert.equal(fs.statSync(lock).mode & 0o7777, 0o640);
    assert.deepEqual(aclLines(lock), [` 0: user:${STAND_IN_BUILDER} allow read`]);
    // The directories above it not root's alone (status 2): nothing there is touched.
    fs.rmSync(lock);
    const above = installSh(`${passStubs(t, `tools_lock_problem() { echo "the directories above it: not root's"; return 2; }`)}\nset -e\nprovision_tools_lock asroot; echo "status $?"`);
    assert.equal(above.status, 1);
    assert.match(above.stderr, /can't be made in its place: the directories above it: not root's/);
    assert.equal(fs.existsSync(lock), false);
    // install.sh never touches, chowns or chmods the lock's path before it knows it's a regular file there.
    const provision = INSTALL_SH.slice(INSTALL_SH.indexOf("provision_tools_lock() {"), INSTALL_SH.indexOf("\n}\n", INSTALL_SH.indexOf("provision_tools_lock() {")));
    assert.ok(provision.indexOf('if [[ -L "$lock" ]]') < provision.indexOf('"$root"'), "the symlink check comes first");
    assert.match(provision, /"\$root" ln "\$tmp" "\$lock"/, "a new one is linked into place");
    assert.doesNotMatch(INSTALL_SH, /touch "\$BUILD_TOOLS\.lock"/);
  } finally {
    spawnSync("/bin/chmod", ["-R", "-N", t.dir]);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("the installing shell holds the lock itself: with every process it started killed mid-install, a build still can't take it until the install is done", async () => {
  const t = buildToolsScratch();
  const gate = path.join(t.dir, "go");
  const runs = [];
  try {
    const put = installSh(`${passStubs(t)}\ninstall_build_pnpm asroot && echo DONE`);
    assert.match(put.stdout, /DONE/, put.stderr);
    const lock = buildToolsLock(t.tools);
    const install = installShAsync(`${rebuildStubs(t)}\ninstall_build_pnpm asroot && echo DONE`, { T3B_GATE: gate });
    runs.push(install);
    await until(() => t.calls().length === 2, "the install staging, under the lock");
    // The helper that took the lock has exited: nothing but the shell (and its gate's sleeps) holds it.
    const helpers = descendants(install.child.pid).filter(({ comm }) => /perl|node|flock/.test(comm));
    assert.deepEqual(helpers, [], "no helper left to hold it, or to die");
    // Kill whatever it started, the lock's helper included: the lock stays.
    for (let pass = 0; pass < 5; pass++) {
      for (const { pid } of descendants(install.child.pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await sleep(50);
    }
    await assert.rejects(lockBuildTools({ file: lock, shared: true, rootOwned: false, waitMs: 500 }), /gave up after 0\.5 s: \.\/install\.sh is replacing the build tools/);
    fs.writeFileSync(gate, "");
    const done = await install.done;
    assert.equal(done.code, 0, done.out);
    await (await lockBuildTools({ file: lock, shared: true, rootOwned: false, waitMs: 1000 }))();
    assert.equal(t.calls().length, 2);
    checkVitePlusHome(path.join(t.tools, "vite-plus"), { target: pnpmTarget(), digests: { [pnpmTarget()]: t.digest }, rootOwned: false });
    // The lock's helper: macOS's own perl, checked; busy (75) apart from an error, which stops the install.
    assert.match(INSTALL_SH, /^TOOLS_PERL=\/usr\/bin\/perl$/m);
    assert.match(INSTALL_SH, /\[\[ -x "\$TOOLS_PERL" \]\] \|\| return 3/);
    // Elsewhere it's flock(1) at a fixed path, so a stub stands in for its absence.
    const noHelper = process.platform === "darwin" ? `TOOLS_PERL=${JSON.stringify(path.join(t.dir, "no-perl"))}` : "tools_flock() { return 3; }";
    const failing = installSh(`${passStubs(t)}\n${noHelper}\nset -e\nhold_tools_lock; echo "status $?"`);
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /couldn't take the build tools' lock .*: neither .*perl \(macOS\) nor util-linux flock is there to take it with/);
    if (process.platform === "darwin") assert.match(failing.stderr, /neither .*no-perl \(macOS\)/);
  } finally {
    fs.writeFileSync(gate, "");
    await Promise.all(runs.map((run) => run.stop()));
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

