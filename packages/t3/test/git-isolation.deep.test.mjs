// node --test test/: git against public remotes and the upstream mirror goes
// through lib/git.mjs, so this machine's git configuration can't decide how it
// runs: no global or system configuration, nothing GIT_* from the caller, HTTPS
// (a local path, here) as the only transport whatever a repository allows,
// nothing that prompts, and a deadline on every call. A repository's own URL
// rewrites, proxies and helpers are refused before git reaches a remote from it;
// mirror reads that don't need file contents never fetch lazily; and self-update
// fetches main only from origin's GitHub repository over HTTPS. Each planted
// transport is shown to run under plain git first, so its absence afterwards
// means something. Scratch configuration and repositories, programs that record
// being run, and local sockets; no network beyond names that never resolve.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { DEADLINES, checkRepoTransport, gitConfigArgs, gitEnv, gitFailure, ownConfig, publicGit, releaseSnapshot, transportOf } from "../lib/git.mjs";
import { upstreamTagCommit } from "../lib/pin.mjs";
import { githubOrigin } from "../lib/selfupdate.mjs";
import { mirrorGit, mirrorOut } from "../lib/util.mjs";
import { NIGHTLY, fixture, run } from "./trust-fixtures.mjs";

// The real path: includeIf "gitdir:" compares against it (/var vs /private/var on macOS).
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-git-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------- publicGit --


const URL_ = "https://t3b-git.invalid/pingdotgg/t3code.git";
const recorder = path.join(dir, "ssh-ran");
const fakeSsh = path.join(dir, "fake-ssh");
fs.writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" >> '${recorder}'\nexit 1\n`, { mode: 0o755 });
// What a user's ~/.gitconfig might hold: every https://t3b-git.invalid/ URL through SSH.
const globalConfig = path.join(dir, "gitconfig");
fs.writeFileSync(globalConfig, `[url "ssh://git@t3b-git.invalid/"]\n\tinsteadOf = https://t3b-git.invalid/\n[core]\n\tsshCommand = ${fakeSsh}\n`);
const userEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_SSH_COMMAND: fakeSsh, GIT_SSH: fakeSsh, SSH_AUTH_SOCK: path.join(dir, "agent.sock") };

test("the probe works: plain git with that configuration runs ssh for an https URL", () => {
  fs.rmSync(recorder, { force: true });
  spawnSync("git", ["ls-remote", "--", URL_], { env: userEnv, encoding: "utf8", timeout: 30_000 });
  assert.ok(fs.existsSync(recorder), "git followed insteadOf to ssh");
});

test("publicGit ignores the machine's rewrites, ssh command and agent", () => {
  fs.rmSync(recorder, { force: true });
  const result = publicGit(["ls-remote", "--", URL_], { url: URL_, timeout: 30_000, env: userEnv });
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(recorder), "no ssh ran");
  const env = gitEnv(userEnv);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.GIT_SSH, undefined);
  assert.notEqual(env.GIT_SSH_COMMAND, fakeSsh);
});

test("upstreamTagCommit goes through it too, even with a rewrite in the process's own environment", () => {
  fs.rmSync(recorder, { force: true });
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_SSH_COMMAND: fakeSsh });
  try {
    assert.throws(() => upstreamTagCommit(NIGHTLY(3917), URL_), /couldn't list upstream tag/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  assert.ok(!fs.existsSync(recorder));
});

test("a rewrite in a repository's own config (which no environment can drop) fails fast instead of reaching ssh", () => {
  fs.rmSync(recorder, { force: true });
  const repo = path.join(dir, "local-rewrite.git");
  spawnSync("git", ["init", "-q", "--bare", repo]);
  spawnSync("git", ["-C", repo, "config", "url.ssh://git@t3b-git.invalid/.insteadOf", "https://t3b-git.invalid/"]);
  spawnSync("git", ["-C", repo, "config", "core.sshCommand", fakeSsh]);
  const result = publicGit(["-C", repo, "fetch", URL_], { url: URL_, timeout: 30_000, env: userEnv });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport 'ssh' not allowed/);
  assert.ok(!fs.existsSync(recorder));
  // The mirror's own reads (lib/util.mjs mirrorGit) go through publicGit too, with these rules.
  assert.deepEqual(gitConfigArgs("https").slice(0, 4), ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]);
});

test("every call has a deadline: a server that never answers is abandoned", async () => {
  // The kernel completes the connection; nothing ever answers git's TLS hello.
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${server.address().port}/t3code.git`;
  try {
    const started = Date.now();
    const result = publicGit(["ls-remote", "--", url], { url, timeout: 1500 });
    assert.ok(Date.now() - started < 10_000);
    assert.notEqual(result.status, 0);
    assert.equal(gitFailure(result, 1500), "timed out after 2s");
  } finally {
    server.close();
  }
  assert.throws(() => publicGit(["ls-remote", "--", url], { url, timeout: Infinity }), /needs a deadline/);
  assert.ok(Object.values(DEADLINES).every((ms) => Number.isFinite(ms) && ms > 0));
});

test("only https (or a local path, for tests) is a transport", () => {
  assert.equal(transportOf("https://github.com/pingdotgg/t3code.git"), "https");
  assert.equal(transportOf("/tmp/upstream"), "file");
  for (const url of ["ssh://git@github.com/pingdotgg/t3code.git", "git@github.com:pingdotgg/t3code.git", "http://github.com/pingdotgg/t3code.git", "git://github.com/x", "ext::sh -c x", "relative/path"]) {
    assert.throws(() => transportOf(url), /only https/);
    assert.throws(() => publicGit(["ls-remote", url], { url }), /only https/);
  }
});

test("a release snapshot checks each tag names its commit, and reads files at it", () => {
  const f = fixture();
  const snapshot = releaseSnapshot([{ ref: NIGHTLY(3917), sha: f.shas[1] }, { ref: NIGHTLY(3904), sha: f.shas[0] }], { url: f.upstream });
  try {
    assert.match(snapshot.show(f.shas[1], "pnpm-lock.yaml"), /lockfileVersion/);
    assert.equal(snapshot.show(f.shas[0], "no-such-file"), null);
    assert.throws(() => snapshot.show(f.shas[2], "pnpm-lock.yaml"), /isn't in this snapshot/);
  } finally {
    snapshot.close();
  }
  assert.throws(() => releaseSnapshot([{ ref: NIGHTLY(3917), sha: f.shas[0] }], { url: f.upstream }), (error) => /isn't/.test(error.message) && !error.transient);
  assert.throws(() => releaseSnapshot([{ ref: NIGHTLY(3904), sha: f.shas[0] }, { ref: NIGHTLY(3917), sha: f.shas[0] }], { url: f.upstream }), (error) => !error.transient);
  assert.throws(() => releaseSnapshot([{ ref: NIGHTLY(4999), sha: f.shas[0] }], { url: f.upstream }), (error) => error.transient === true);
});

// ------------------------------------------- a repository's own configuration --

const marker = path.join(dir, "transport-ran");
const transport = path.join(dir, "transport");
fs.writeFileSync(transport, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
const ran = () => fs.existsSync(marker);
const UPSTREAM = "https://github.com/pingdotgg/t3code.git";

/** A repository with one commit; returns [repo, sha]. */
function repoWithCommit(name) {
  const repo = path.join(dir, name);
  run(dir, ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "file"), "x\n");
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-q", "--no-gpg-sign", "-m", "fixture"]);
  return [repo, run(repo, ["rev-parse", "HEAD"])];
}

/** What a compromised build account can do to its mirror: an `ext::` promisor that runs `transport`, and the commit's object gone. */
function poisonedMirror(name) {
  const [repo, sha] = repoWithCommit(name);
  run(repo, ["config", "protocol.ext.allow", "always"]);
  run(repo, ["config", "extensions.partialClone", "origin"]);
  run(repo, ["config", "remote.origin.url", `ext::${transport}`]);
  run(repo, ["config", "remote.origin.promisor", "true"]);
  fs.rmSync(path.join(repo, ".git/objects", sha.slice(0, 2), sha.slice(2)));
  return [repo, sha];
}

test("reading a poisoned mirror runs no transport, lazily or through a rewrite", () => {
  fs.rmSync(marker, { force: true });
  const [mirror, sha] = poisonedMirror("poisoned-mirror");
  // The probe works: a mirror read with only the -c options and no global config runs the transport.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  spawnSync("git", [...gitConfigArgs("https"), "-c", `safe.directory=${mirror}`, "-C", mirror, "log", "-1", "--format=%ct", sha], { env, encoding: "utf8", timeout: 10_000 });
  assert.ok(ran(), "a lazy fetch ran the mirror's ext:: transport");
  fs.rmSync(marker);
  // The installing account's metadata reads (poll --offline's revParse, commitTime).
  const read = mirrorGit(["log", "-1", "--format=%ct", sha], { dir: mirror });
  assert.notEqual(read.status, 0, "the object is missing and isn't fetched");
  assert.throws(() => mirrorOut(["rev-parse", `${sha}^{commit}`], { dir: mirror }), /failed/);
  assert.ok(!ran(), "no lazy fetch ran the mirror's transport");
  // Reading file contents fetches, so it checks where the mirror sends that first.
  assert.throws(() => mirrorGit(["show", `${sha}:file`], { dir: mirror, fetch: true }), /refusing to reach https:\/\/github\.com\/pingdotgg\/t3code\.git from .*sets protocol\.ext\.allow.*sends origin to ext::/);
  assert.ok(!ran());
  // Even without that check, a repository's protocol.ext.allow=always is overridden.
  const rewritten = path.join(dir, "rewrite-to-ext");
  run(dir, ["init", "-q", rewritten]);
  run(rewritten, ["config", "protocol.ext.allow", "always"]);
  run(rewritten, ["config", `url.ext::${transport}.insteadOf`, "https://review.invalid/"]);
  const listed = publicGit(["-C", rewritten, "ls-remote", "https://review.invalid/"], { url: "https://review.invalid/", timeout: 10_000 });
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /transport 'ext' not allowed/);
  assert.ok(!ran(), "GIT_ALLOW_PROTOCOL beat the repository's protocol.ext.allow");
  assert.equal(gitEnv({ GIT_ALLOW_PROTOCOL: "ext:https" }).GIT_ALLOW_PROTOCOL, "https");
});

test("the caller's global includeIf, proxy and GIT_CONFIG_COUNT don't reach mirror reads", () => {
  const [mirror] = repoWithCommit("plain-mirror");
  run(mirror, ["remote", "add", "origin", UPSTREAM]);
  const included = path.join(dir, "included-gitconfig");
  const globalFile = path.join(dir, "global-gitconfig");
  fs.writeFileSync(included, `[http]\n\tproxy = http://127.0.0.1:9\n[url "https://include.invalid/"]\n\tinsteadOf = https://github.com/\n`);
  fs.writeFileSync(globalFile, `[includeIf "gitdir:${mirror}/.git"]\n\tpath = ${included}\n`);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalFile };
  // The probe works: plain git with that environment is redirected.
  assert.match(spawnSync("git", ["-C", mirror, "ls-remote", "--get-url", "origin"], { env, encoding: "utf8" }).stdout, /include\.invalid/);
  assert.equal(mirrorOut(["ls-remote", "--get-url", "origin"], { dir: mirror, env }), UPSTREAM);
  assert.equal(mirrorGit(["config", "--get", "http.proxy"], { dir: mirror, env }).status, 1, "no proxy from the included file");
  const countEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://count.invalid/.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/" };
  assert.match(spawnSync("git", ["-C", mirror, "ls-remote", "--get-url", "origin"], { env: countEnv, encoding: "utf8" }).stdout, /count\.invalid/);
  assert.equal(mirrorOut(["ls-remote", "--get-url", "origin"], { dir: mirror, env: countEnv }), UPSTREAM);
  // And the owner's fetch from it passes the repository check.
  assert.doesNotThrow(() => checkRepoTransport(mirror, { url: UPSTREAM, remote: "origin" }));
});

test("a repository's own HTTPS rewrite is refused before git connects anywhere", async () => {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const [repo] = repoWithCommit("local-rewrite");
    run(repo, ["config", `url.https://127.0.0.1:${port}/rewritten/.insteadOf`, "https://github.com/"]);
    // git runs synchronously: the server sees a connection once the event loop turns.
    const settled = () => new Promise((resolve) => setTimeout(resolve, 100));
    // The probe works: without the check git goes where the rewrite says (HTTPS is allowed).
    const unchecked = publicGit(["-C", repo, "ls-remote", "--", UPSTREAM], { url: UPSTREAM, timeout: 3_000 });
    assert.notEqual(unchecked.status, 0);
    await settled();
    assert.equal(connections.length, 1, "git connected to the rewritten host");
    // Through the repository check (selfupdate's fetch, the mirror's fetches): refused, no connection.
    assert.throws(
      () => publicGit(["fetch", "--quiet", UPSTREAM, "main"], { url: UPSTREAM, repo, timeout: 3_000 }),
      new RegExp(`refusing to reach .* sets url\\.https://127\\.0\\.0\\.1:${port}/rewritten/\\.insteadof; sends https://github\\.com/pingdotgg/t3code\\.git to https://127\\.0\\.0\\.1:${port}/rewritten/pingdotgg/t3code\\.git`),
    );
    await settled();
    assert.equal(connections.length, 1, "no further connection");
  } finally {
    server.close();
  }
});

test("a mirror's origin must be upstream, its only remote, with no proxy or helper of its own", () => {
  const check = (setup) => {
    const [repo] = repoWithCommit(`origin-${Math.random().toString(36).slice(2)}`);
    run(repo, ["remote", "add", "origin", UPSTREAM]);
    setup(repo);
    return () => checkRepoTransport(repo, { url: UPSTREAM, remote: "origin" });
  };
  assert.throws(check((repo) => run(repo, ["remote", "set-url", "origin", "https://elsewhere.invalid/t3code.git"])), /sends origin to https:\/\/elsewhere\.invalid\/t3code\.git/);
  assert.throws(check((repo) => run(repo, ["config", "--add", "remote.origin.url", "https://elsewhere.invalid/t3code.git"])), /doesn't give origin exactly one URL/);
  assert.throws(check((repo) => run(repo, ["remote", "add", "evil", "https://elsewhere.invalid/x.git"])), /sets remote\.evil\.url/);
  assert.throws(check((repo) => run(repo, ["config", "http.proxy", "http://127.0.0.1:9"])), /sets http\.proxy/);
  assert.throws(check((repo) => run(repo, ["config", "remote.origin.vcs", "evil"])), /sets remote\.origin\.vcs/);
  assert.throws(check((repo) => run(repo, ["config", "credential.helper", "!evil"])), /sets credential\.helper/);
  // Included files count as the repository's own.
  const included = path.join(dir, "repo-include");
  fs.writeFileSync(included, `[http "https://github.com/"]\n\tsslVerify = false\n`);
  assert.throws(check((repo) => run(repo, ["config", "include.path", included])), /sets http\.https:\/\/github\.com\/\.sslverify/);
  // A plain clone passes.
  assert.doesNotThrow(check(() => {}));
});

// ----------------------------------------------------- self-update's fetch --

const GITHUB = "https://github.com/bmjcoding/t3blackout.git";

/** A program that leaves `marker` behind when git runs it as a transport or an SSH command. */
function plantedTransport(dir, name) {
  const marker = path.join(dir, `${name}-ran`);
  const program = path.join(dir, name);
  fs.writeFileSync(program, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`, { mode: 0o755 });
  return { program, ran: () => fs.existsSync(marker), reset: () => fs.rmSync(marker, { force: true }) };
}

/** Plain git: whatever configuration and environment there is. */
const plainGit = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env, timeout: 30_000 });

/** A local port nothing listens on: as an HTTPS proxy, any fetch fails at once, with no network. */
async function closedPort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Runs `body` with `vars` set in process.env (undefined unsets), then puts everything back. */
async function withEnv(vars, body) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const set = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  set(vars);
  try {
    return await body();
  } finally {
    set(saved);
  }
}

/** process.env for a fetch that must stay offline: an HTTPS proxy that refuses, and no GitHub CLI login. */
async function offline(dir) {
  const ghConfig = path.join(dir, "gh-config");
  fs.mkdirSync(ghConfig, { recursive: true });
  const proxy = `http://127.0.0.1:${await closedPort()}`;
  return { https_proxy: proxy, HTTPS_PROXY: proxy, no_proxy: undefined, NO_PROXY: undefined, GH_CONFIG_DIR: ghConfig, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined };
}

test("githubOrigin: the clone's own origin in any GitHub URL form; anything else, or two URLs, is none", () => {
  const f = fixture();
  for (const [url, want] of [
    [GITHUB, GITHUB],
    ["https://github.com/bmjcoding/t3blackout", GITHUB],
    ["https://github.com/bmjcoding/t3blackout/", GITHUB],
    ["git@github.com:bmjcoding/t3blackout.git", GITHUB],
    ["ssh://git@github.com/bmjcoding/t3blackout.git", GITHUB],
    ["git@github-alias:bmjcoding/t3blackout.git", null],
    ["https://example.org/github.com/bmjcoding/t3blackout.git", null],
    ["https://github.com.example.org/bmjcoding/t3blackout.git", null],
    ["https://github.com/bmjcoding/t3blackout.git/extra", null],
    [f.origin, null],
  ]) {
    run(f.clone, ["remote", "set-url", "origin", url]);
    assert.equal(githubOrigin(f.clone), want, url);
  }
  run(f.clone, ["remote", "set-url", "origin", GITHUB]);
  run(f.clone, ["config", "--add", "remote.origin.url", "https://github.com/someone/else.git"]);
  assert.equal(githubOrigin(f.clone), null);
  assert.deepEqual(ownConfig(f.clone, "remote.origin.url"), [GITHUB, "https://github.com/someone/else.git"]);
  assert.deepEqual(ownConfig(f.clone, "remote.nothing.url"), []);
});

test("rewrites in global, environment or the clone's own configuration don't change the origin self-update reads", async () => {
  const f = fixture();
  run(f.clone, ["remote", "set-url", "origin", GITHUB]);
  const global = path.join(f.dir, "gitconfig");
  fs.writeFileSync(global, `[url "ext::sh -c true"]\n  insteadOf = ${GITHUB}\n`);
  await withEnv({ GIT_CONFIG_GLOBAL: global }, () => {
    assert.match(plainGit(f.clone, ["remote", "get-url", "origin"]).stdout, /^ext::/);
    assert.equal(githubOrigin(f.clone), GITHUB);
  });
  await withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.git@github-alias:.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/" }, () => {
    assert.match(plainGit(f.clone, ["remote", "get-url", "origin"]).stdout, /^git@github-alias:/);
    assert.equal(githubOrigin(f.clone), GITHUB);
  });
  run(f.clone, ["config", "url.ext::sh -c true.insteadOf", GITHUB]);
  assert.match(plainGit(f.clone, ["remote", "get-url", "origin"]).stdout, /^ext::/);
  assert.equal(githubOrigin(f.clone), GITHUB);
});

test("a rewrite in the clone's own configuration that hides github.com stops self-update before anything runs", async () => {
  const f = fixture();
  const before = f.head();
  const planted = plantedTransport(f.dir, "local-transport");
  run(f.clone, ["remote", "set-url", "origin", GITHUB]);
  run(f.clone, ["config", "protocol.ext.allow", "always"]);
  run(f.clone, ["config", `url.ext::${planted.program}.insteadOf`, GITHUB]);
  // Plain git (`git fetch origin main`) runs the planted transport.
  assert.notEqual(plainGit(f.clone, ["fetch", "--quiet", "origin", "main"]).status, 0);
  assert.equal(planted.ran(), true, "positive control: plain git runs the planted transport");
  planted.reset();
  assert.equal(await f.update({ remote: null }), "skipped");
  assert.equal(planted.ran(), false);
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /self-update skipped: couldn't fetch \(refusing to reach https:\/\/github\.com\/bmjcoding\/t3blackout\.git from .*sets url\.ext::.*\.insteadof/);
});

test("a global rewrite that hides github.com (ext:: or an SSH host alias) can't steer self-update's fetch, which goes to GitHub over HTTPS", async () => {
  for (const kind of ["ext", "ssh-alias"]) {
    const f = fixture();
    const before = f.head();
    const planted = plantedTransport(f.dir, `${kind}-transport`);
    run(f.clone, ["remote", "set-url", "origin", GITHUB]);
    const global = path.join(f.dir, "gitconfig");
    fs.writeFileSync(
      global,
      kind === "ext"
        ? `[protocol "ext"]\n  allow = always\n[url "ext::${planted.program}"]\n  insteadOf = ${GITHUB}\n`
        : `[url "git@github-alias:"]\n  insteadOf = https://github.com/\n[core]\n  sshCommand = ${planted.program}\n`,
    );
    await withEnv({ GIT_CONFIG_GLOBAL: global, ...(await offline(f.dir)) }, async () => {
      assert.notEqual(plainGit(f.clone, ["fetch", "--quiet", "origin", "main"]).status, 0);
      assert.equal(planted.ran(), true, `positive control (${kind}): plain git runs the planted transport`);
      planted.reset();
      assert.equal(await f.update({ remote: null }), "skipped");
    });
    assert.equal(planted.ran(), false, kind);
    assert.equal(f.head(), before);
    // The fetch publicGit made: GitHub over HTTPS, refused by the proxy on 127.0.0.1
    // (so never github.com itself). libcurl words that two ways: "to 127.0.0.1 port N"
    // (8.7.1, Apple's git) or "to github.com:443 over proxy 127.0.0.1" (8.23.0, Homebrew's).
    assert.match(
      f.logs.at(-1),
      /self-update skipped: couldn't fetch \(fatal: unable to access 'https:\/\/github\.com\/bmjcoding\/t3blackout\.git\/': Failed to connect to (127\.0\.0\.1 port \d+|github\.com(:| port )443 over proxy 127\.0\.0\.1) /,
      kind,
    );
  }
});

test("an origin that isn't a GitHub repository isn't fetched at all; a local one only when named", async () => {
  const f = fixture();
  const before = f.head();
  // The fixture's origin is a local path: without `remote`, self-update doesn't fetch it.
  assert.equal(await f.update({ remote: null }), "skipped");
  assert.match(f.logs.at(-1), /couldn't fetch \(origin isn't a github\.com repository URL/);
  assert.equal(fs.existsSync(path.join(f.clone, ".git", "FETCH_HEAD")), false);
  // An SSH host alias as origin itself is no GitHub URL either.
  run(f.clone, ["remote", "set-url", "origin", "git@github-alias:bmjcoding/t3blackout.git"]);
  assert.equal(await f.update({ remote: null }), "skipped");
  assert.match(f.logs.at(-1), /origin isn't a github\.com repository URL/);
  // Named explicitly, the local fixture goes through publicGit too (file transport, the clone's configuration checked).
  run(f.clone, ["config", "url.ext::sh -c true.insteadOf", f.origin]);
  assert.equal(await f.update(), "skipped");
  assert.match(f.logs.at(-1), /refusing to reach .*origin from .*sets url\.ext::sh -c true\.insteadof/);
  run(f.clone, ["config", "--unset", "url.ext::sh -c true.insteadOf"]);
  assert.equal(await f.update(), "skipped", "nothing new on origin's main");
  assert.equal(f.head(), before);
});
