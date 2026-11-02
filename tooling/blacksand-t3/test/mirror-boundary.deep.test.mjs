// Real upstream/util/git adapters behind an explicit account boundary. The
// boundary rejects owner git -C <private mirror>, then runs real Git in a local
// fixture only for the targeted builder command. No sudo, live mirror or network.
// Deep: scratch Git history, production worker snapshots and concurrent readers.
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";
import { after, test } from "node:test";

const home = process.platform === "darwin" ? "/private/var/blacksand-build" : "/var/lib/blacksand-build";
const privateMirror = path.join(home, "upstream");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-metadata-"));
const mirror = path.join(dir, "private-mirror");
const realSpawnSync = cp.spawnSync;
const realSpawn = cp.spawn;
const realExists = fs.existsSync;
const calls = [];
let failure = null;
let output = null;
let mutations = 0;
let workerFetches = 0;
const git = (args) => {
  const result = realSpawnSync("git", ["-C", mirror, ...args], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
fs.mkdirSync(mirror, { mode: 0o700 });
git(["init", "-q"]);
git(["config", "user.name", "Fixture"]);
git(["config", "user.email", "fixture@example.invalid"]);
git(["config", "commit.gpgsign", "false"]);
fs.writeFileSync(path.join(mirror, "file"), "before\n");
git(["add", "."]); git(["commit", "-qm", "Before release"]);
const before = git(["rev-parse", "HEAD"]);
const oldTag = "v0.1.6-nightly.20261030.3904";
const tag = "v0.1.6-nightly.20261030.3917";
git(["tag", oldTag]);
fs.writeFileSync(path.join(mirror, "file"), "after\n");
git(["add", "."]); git(["commit", "-qm", "After release (#42)", "-m", "Useful detail\n\nSigned-off-by: Fixture"]);
const sha = git(["rev-parse", "HEAD"]);
git(["tag", tag]);
// Deliberately hostile local transport: metadata must never use it, even when
// a commit is missing. The existing isolation suite tests fetch's config gate.
const transportMarker = path.join(dir, "transport-ran");
const transport = path.join(dir, "transport");
fs.writeFileSync(transport, `#!/bin/sh\ntouch '${transportMarker}'\nexit 1\n`, { mode: 0o755 });
git(["config", "remote.origin.url", `ext::${transport}`]);
git(["config", "remote.origin.promisor", "true"]);
git(["config", "protocol.ext.allow", "always"]);

// Model an installed account on every host, including CI where none exists.
fs.existsSync = (file) => String(file) === path.join(home, ".blacksand-builder") || (String(file).startsWith(home + "/") ? false : realExists(file));
cp.spawnSync = (command, args, opts) => {
  if (command === "git" && args.includes(privateMirror)) throw new Error("OWNER CANNOT READ PRIVATE MIRROR");
  if (command !== "sudo" && command !== "/usr/bin/sudo") return realSpawnSync(command, args, opts);
  assert.equal(opts.cwd, "/");
  assert.deepEqual(args.slice(0, 5), ["-n", "-u", "_blacksand-build", "-H", args[4]]);
  if (args[4] === "/bin/sh") {
    // Only runAsBuilder's actual snapshot handoff may mutate; a metadata read
    // must never get here. Archive bytes are produced by production code.
    mutations++;
    assert.ok(Buffer.isBuffer(opts.input));
    return { status: 0, stdout: "", stderr: "" };
  }
  if (args[4] === "true") return { status: 0, stdout: "", stderr: "" };
  assert.deepEqual(args.slice(4, 6), ["/usr/bin/env", "-i"]);
  assert.equal(command, "/usr/bin/sudo", "builder-writable PATH entries cannot select an owner executable");
  const end = args.indexOf("git", 6);
  assert.ok(end > 6, "only the git executable crosses the metadata boundary");
  const env = Object.fromEntries(args.slice(6, end).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  const argv = args.slice(end + 1);
  calls.push({ env, argv, opts });
  assert.deepEqual(Object.keys(opts.env), ["PATH"], "sudo receives no owner credentials or configuration");
  assert.equal(opts.env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, home);
  assert.equal(env.LANG, "C");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "HTTPS_PROXY", "GIT_CONFIG_COUNT"]) assert.equal(env[key], undefined, key);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.match(env.GIT_ASKPASS, /false$/);
  assert.equal(env.GIT_ALLOW_PROTOCOL, argv.includes("--version") ? "file" : "https");
  if (!argv.includes("--version")) {
    assert.ok(argv.includes("--no-lazy-fetch"));
    assert.ok(argv.includes(`safe.directory=${privateMirror}`));
    assert.ok(argv.includes("core.hooksPath=/dev/null"));
    assert.ok(argv.includes("credential.helper="));
  }
  if (failure) return failure;
  if (output !== null) return { status: 0, stdout: output, stderr: "" };
  return realSpawnSync("git", argv.map((arg) => arg === privateMirror ? mirror : arg), { ...opts, env: { ...env, HOME: dir } });
};
cp.spawn = (command, args, opts) => {
  if (command !== "sudo") return realSpawn(command, args, opts);
  assert.equal(opts.cwd, "/");
  assert.deepEqual(args.slice(-2), ["fetch", "--json"]);
  workerFetches++;
  return realSpawn(process.execPath, ["-e", "process.exit(0)"], { cwd: "/", stdio: ["ignore", "pipe", "pipe"] });
};
syncBuiltinESMExports();
const upstream = await import("../lib/upstream.mjs");
const util = await import("../lib/util.mjs");
const { runAsBuilder } = await import("../lib/builder.mjs");
assert.equal(util.USE_BUILDER, true);
const source = fs.readFileSync(new URL("../bin/t3", import.meta.url), "utf8");
const section = (start, end) => {
  const at = source.indexOf(start);
  assert.ok(at !== -1 && source.indexOf(end, at) !== -1);
  return source.slice(at, source.indexOf(end, at));
};
const quiet = () => {};
const pin = { ref: tag, sha };
function cli(extra = {}) {
  return vm.createContext({
    ...upstream, ...util, runAsBuilder,
    console: { log: quiet }, log: quiet, progress: quiet, emit: quiet,
    requireBuilder: quiet, CURRENT: "current", readJson: () => ({}), readPending: () => null,
    pinnedFor: () => pin, appChannel: () => "nightly", blacksandCommit: () => "b".repeat(40),
    expectedBuild: () => null, isExpectedBuild: () => true,
    acquireLock: async () => quiet, process: { exitCode: 0 },
    ...extra,
  });
}
const fetchBody = section("async function fetchUpstream()", "/**\n * What a build brings");
const targetBody = section("function target(opts, current)", "/** Downloads the pricing");
const updateBody = section("async function update(opts)", "/** Takes the update lock");
const choose = async (context, current = {}) => vm.runInContext(`${targetBody}\ntarget({}, ${JSON.stringify(current)})`, context);

after(() => {
  cp.spawnSync = realSpawnSync; cp.spawn = realSpawn; fs.existsSync = realExists;
  syncBuiltinESMExports();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the builder's Git version is checked even when the owner's identical PATH was already checked", () => {
  // publicGit's ordinary runner and the builder runner must not share a floor
  // result just because the same tool directories appear in their PATH.
  const beforeVersions = calls.filter(({ argv }) => argv.includes("--version")).length;
  return import("../lib/git.mjs").then(({ publicGit, UPSTREAM_URL }) => {
    assert.equal(publicGit(["--version"], { url: UPSTREAM_URL, env: { PATH: util.builderPath() }, timeout: 10_000 }).status, 0);
    assert.equal(upstream.hasMirror(), true);
    assert.equal(calls.filter(({ argv }) => argv.includes("--version")).length, beforeVersions + 1);
  });
});

test("fresh pinned update reads the builder-private mirror after a successful production builder fetch", async () => {
  process.env.BLACKSAND_T3_GITHUB_TOKEN = ""; // no real token-file lookup in runAsBuilder
  let verified = 0;
  let built = null;
  const context = cli({
    chooseTarget: async () => ({ ...await choose(context), held: [] }),
    platform: { isRunning: () => false, notify: quiet }, installConfig: { role: "ui" },
    verifyHead: async () => { verified++; return { result: "verified", message: "fixture signed pin" }; },
    buildChanges: () => ({ tag: upstream.previousTag(sha), items: upstream.upstreamCommits(before, sha) }),
    buildUpstream: async (...args) => { built = args; throw new Error("fixture build stop"); },
    fs: { rmSync: quiet },
  });
  await vm.runInContext(`${fetchBody}\n${updateBody}\nupdate({ force: true, 'stage-only': true })`, context);
  assert.equal(context.process.exitCode, 1, "the deliberate stop reaches update's failure handler");
  assert.equal(workerFetches, 1);
  assert.equal(mutations, 1, "only the explicit worker fetch syncs its snapshot");
  assert.equal(verified, 1, "metadata doesn't bypass the pin verifier");
  assert.equal(built[0], sha);
  assert.equal(built[1], tag.slice(1));
  assert.equal(built[2].tag, oldTag);
  assert.equal(built[2].items[0].title, "After release (#42)");
});

test("tag, version, soak time, previous release and change details use the production metadata adapter", () => {
  const beforeMutations = mutations;
  assert.equal(upstream.hasMirror(), true);
  assert.equal(upstream.revParse(pin.sha), sha);
  assert.equal(upstream.commitTime(sha), 1577836800);
  assert.deepEqual(upstream.mirrorTags().sort(), [oldTag, tag].sort());
  assert.equal(upstream.resolveRef("nightly"), tag);
  assert.throws(() => upstream.resolveRef("nightly", { soakHours: 1e9 }), /no nightly release/);
  assert.equal(upstream.versionOf("main", sha), tag.slice(1));
  assert.equal(upstream.previousTag(sha), oldTag);
  assert.deepEqual(upstream.releaseNotes(before, sha, "v"), [{ version: "v", note: "- After release (#42)" }]);
  assert.deepEqual(upstream.upstreamCommits(before, sha), [{ sha, title: "After release (#42)" }]);
  assert.deepEqual(upstream.commitDetails(before, sha), [{ sha, title: "After release (#42)", pr: 42, body: "Useful detail", files: ["file"], fileCount: 1 }]);
  assert.equal(mutations, beforeMutations, "reads neither sync nor delete worker code");
});

test("offline poll and check target selection cross the boundary; offline reads launch no worker", async () => {
  const { pollOffer } = await import("../lib/expect.mjs");
  const events = [];
  const startFetches = workerFetches;
  const context = cli({
    pollOffer, emit: (event) => events.push(event),
    chooseTarget: async () => ({ ...await choose(context), held: [], verdict: null }),
  });
  vm.runInContext(section("/** Release notes, led", "/**\n * Reports the release"), context);
  await vm.runInContext(`${section("async function cmdPoll(opts)", "\nconst waitFor =")}\ncmdPoll({ offline: true, json: true })`, context);
  assert.equal(events[0].update.sha, sha);
  assert.equal(events[0].update.version, tag.slice(1));
  assert.equal(workerFetches, startFetches);
  const checked = [];
  context.runCheck = async (ref) => { checked.push(ref); return { ok: true, skipped: [] }; };
  await vm.runInContext(`${fetchBody}\n${targetBody}\n${section("async function cmdCheck(opts)", "/** A file at an upstream commit")}\ncmdCheck({})`, context);
  assert.deepEqual(checked, [sha]);
  assert.equal(context.process.exitCode, 0);
});

test("metadata reads pass no owner secrets/options, cannot fetch blobs or mutate, and keep bounds/status", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GH_TOKEN: "fixture", AWS_SECRET_ACCESS_KEY: "fixture", SSH_AUTH_SOCK: "/fixture", NODE_OPTIONS: "--fixture", HTTPS_PROXY: "http://fixture" });
    assert.equal(util.mirrorOut(["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`], {
      timeout: 1234, maxBuffer: 2345, env: { GITHUB_TOKEN: "fixture" }, config: ["credential.helper=evil"],
      shell: true, uid: 0, execGit: () => assert.fail("caller cannot replace the builder transport"),
    }), sha);
    const last = calls.at(-1);
    assert.equal(last.opts.timeout, 1234);
    assert.equal(last.opts.maxBuffer, 2345);
    assert.equal(last.opts.shell, undefined);
    assert.equal(last.opts.uid, undefined);
    for (const args of [["fetch", "origin"], ["show", `${sha}:file`], ["log", "--output=/tmp/forbidden", sha], ["config", "core.sshCommand", "evil"], ["checkout", sha], ["rev-parse", "--verify", "--end-of-options", "--output=evil^{commit}"]]) assert.throws(() => util.mirrorGit(args), /only mirror metadata/);
    assert.throws(() => util.mirrorGit(["show", `${sha}:file`], { fetch: true }), /needs the build account/);
    assert.throws(() => util.mirrorGit(["show", `${sha}:file`], { fetch: true, dir: mirror }), /needs the build account/, "a caller-chosen directory cannot bypass build isolation");
    assert.throws(() => util.mirrorGit(["log", "-1", "--format=%ct", sha], { dir: path.join(home, "work") }), /only mirror metadata/);
    failure = { status: 37, signal: null, stdout: "", stderr: "fatal: permission denied" };
    assert.equal(util.mirrorGit(["log", "-1", "--format=%ct", sha]).status, 37);
    for (const read of [() => upstream.hasMirror(), () => upstream.revParse(sha), () => upstream.versionOf("main", sha), () => upstream.previousTag(sha), () => upstream.commitTime(sha), () => upstream.mirrorTags(), () => upstream.releaseNotes(before, sha, "v"), () => upstream.upstreamCommits(before, sha), () => upstream.commitDetails(before, sha)]) assert.throws(read, /permission denied/);
    failure = { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: { code: "ETIMEDOUT" } };
    assert.throws(() => util.mirrorOut(["log", "-1", "--format=%ct", sha], { timeout: 1000 }), /timed out after 1s/);
    failure = { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: { code: "ENOBUFS", message: "spawnSync sudo ENOBUFS" } };
    assert.throws(() => upstream.revParse(sha), /ENOBUFS/);
    failure = { status: 0, signal: null, stdout: "- Partial release notes\n", stderr: "", error: { code: "ENOBUFS", message: "spawnSync sudo ENOBUFS" } };
    assert.throws(() => upstream.releaseNotes(before, sha, "v"), /ENOBUFS/);
    failure = { status: 0, signal: "SIGTERM", stdout: sha, stderr: "" };
    assert.throws(() => upstream.revParse(sha), /failed/);
  } finally {
    failure = null;
    process.env = saved;
  }
  assert.equal(fs.existsSync(transportMarker), false);
});

test("missing/invalid metadata never becomes a pin, zero timestamp or a successful offline offer", async () => {
  assert.throws(() => upstream.revParse("a".repeat(40)), /failed/);
  assert.equal(fs.existsSync(transportMarker), false, "a missing object never lazily fetches");
  output = "";
  try {
    assert.throws(() => upstream.revParse(sha), /didn't resolve/);
    assert.throws(() => upstream.commitTime(sha), /didn't give a commit time/);
    assert.throws(() => upstream.hasMirror(), /isn't a work tree/);
  } finally { output = null; }
  failure = { status: 1, stdout: "", stderr: "sudo: permission denied" };
  try {
    const context = cli({
      fetchUpstream: async () => {},
      verifyHead: () => assert.fail("unavailable metadata cannot become a verified pin"),
      buildUpstream: () => assert.fail("unavailable metadata cannot build"),
    });
    context.chooseTarget = async () => ({ ...await choose(context), held: [] });
    await assert.rejects(vm.runInContext(`${updateBody}\nupdate({})`, context), /permission denied/);
    context.emit = () => assert.fail("an unavailable mirror cannot report an offline offer");
    await assert.rejects(vm.runInContext(`${section("async function cmdPoll(opts)", "\nconst waitFor =")}\ncmdPoll({ offline: true, json: true })`, context), /permission denied/);
  } finally { failure = null; }
});

test("concurrent production reads need no code snapshot, shared mutable cache or synchronization", async () => {
  // Independent Node processes share this mirror, each starting without a
  // worker snapshot or a warm version cache. Reuse the same account interceptor.
  const beforeMutations = mutations;
  const beforeFetches = workerFetches;
  const probe = `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import cp from 'node:child_process';
    import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const home=${JSON.stringify(home)}, privateMirror=${JSON.stringify(privateMirror)}, mirror=${JSON.stringify(mirror)}, dir=${JSON.stringify(dir)};
    const realExists=fs.existsSync, realSpawnSync=cp.spawnSync, calls=[]; let failure=null, output=null, mutations=0;
    fs.existsSync=${fs.existsSync.toString()}; cp.spawnSync=${cp.spawnSync.toString()}; syncBuiltinESMExports();
    const upstream=await import(${JSON.stringify(new URL("../lib/upstream.mjs", import.meta.url).href)});
    assert.equal(upstream.hasMirror(),true);
    console.log(JSON.stringify([upstream.revParse(${JSON.stringify(sha)}), upstream.mirrorTags().length]));
    assert.equal(mutations,0);
  `;
  const result = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = realSpawn(process.execPath, ["--input-type=module", "-e", probe], { cwd: "/", timeout: 15_000, env: { PATH: process.env.PATH, HOME: dir } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  })));
  assert.deepEqual(result, Array.from({ length: 4 }, () => [sha, 2]));
  assert.equal(mutations, beforeMutations);
  assert.equal(workerFetches, beforeFetches);
});


test("a zero-status version execution error is refused and retried, never cached as a successful floor", async () => {
  const { publicGit } = await import("../lib/git.mjs");
  let checks = 0;
  const execGit = (_command, args) => {
    if (args.length === 1 && args[0] === "--version") {
      checks++;
      return checks === 1
        ? { status: 0, stdout: "git version 2.55.0\n", stderr: "", error: { code: "ENOBUFS", message: "spawnSync sudo ENOBUFS" } }
        : { status: 0, stdout: "git version 2.55.0\n", stderr: "" };
    }
    return { status: 0, stdout: "metadata\n", stderr: "" };
  };
  const options = { url: "https://example.invalid/repository", execGit };
  assert.match(publicGit(["--version"], options).stderr, /ENOBUFS/);
  assert.equal(publicGit(["--version"], options).status, 0);
  assert.equal(checks, 2, "the failed floor check was retried");
});
