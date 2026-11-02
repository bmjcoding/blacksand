// node --test test/: the GitHub API token lib/advisories.mjs sends (lib/github-token.mjs).
// It goes to api.github.com alone; it reaches the Blacksand processes that need it
// (the lock-holding rerun, the build account) as a one-shot 0600 file, never in an
// environment, and nothing they start inherits it; a file others could read, or
// another account's, isn't used, and says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { scanAdvisories } from "../lib/advisories.mjs";
import { HANDOFF_WRITER_SCRIPT, TOKEN_ENV, TOKEN_FILE_ENV, forgetGithubToken, githubToken, githubTokenHandoff, githubTokenProblem, writeHandoffFile } from "../lib/github-token.mjs";
import { runHoldingLock, tryLock } from "../lib/lock.mjs";

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/advisories/${name}`, import.meta.url), "utf8"));
const REPO_ADVISORIES = fixture("github-repo-advisories-callstack-agent-device.json");
const OSV_EMPTY = fixture("osv-agent-device-0.21.31.json");
const DATABASE_EMPTY = fixture("github-database-agent-device-0.21.31.json");
const NPM = fixture("npm-agent-device.json");
const TOKEN_MODULE = new URL("../lib/github-token.mjs", import.meta.url).href;
const REPO_URL = "https://api.github.com/repos/callstack/agent-device/security-advisories?state=published&per_page=100";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "t3b-token-"));
const meta = async (name) => (name === "agent-device" ? NPM.body : null);
/** Routes fetch through `route(url, init)` (a Response, or undefined for a 404); records every call. */
function mockFetch(route) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers ?? {}) }, init });
    return (await route(String(url), init)) ?? new Response("not found", { status: 404 });
  };
  return calls;
}
const recorded = (url, init) => {
  if (url === "https://api.osv.dev/v1/querybatch") return json({ results: JSON.parse(init.body).queries.map(() => OSV_EMPTY.body) });
  if (url.startsWith("https://api.github.com/advisories?")) return json(DATABASE_EMPTY.body);
  if (url === REPO_URL) return json(REPO_ADVISORIES.body);
};
/** Forgets any token this process took, as at the start of a test. */
const reset = () => {
  delete process.env[TOKEN_FILE_ENV];
  process.env[TOKEN_ENV] = "";
  githubToken();
  forgetGithubToken();
};

test("the token goes to api.github.com alone, a redirect is followed only inside it, and no child process inherits it", async () => {
  process.env.BLACKSAND_T3_GITHUB_TOKEN = "test-token-not-a-secret";
  try {
    const moved = "https://api.github.com/repositories/1146193768/security-advisories?state=published&per_page=100";
    const calls = mockFetch((url, init) => (url === REPO_URL ? new Response("", { status: 301, headers: { location: moved } }) : url === moved ? json(REPO_ADVISORIES.body) : recorded(url, init)));
    const scan = await scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"], meta });
    assert.equal(scan.advisories.length, 2, "followed the rename");
    assert.equal(process.env.BLACKSAND_T3_GITHUB_TOKEN, undefined, "taken out of the environment");
    assert.equal(scan.sources[1].authenticated, true);
    for (const call of calls) {
      const github = new URL(call.url).origin === "https://api.github.com";
      assert.equal(call.headers.authorization, github ? "Bearer test-token-not-a-secret" : undefined, call.url);
      if (github) assert.equal(call.init.redirect, "manual");
    }
    mockFetch((url, init) => (url === REPO_URL ? new Response("", { status: 302, headers: { location: "https://collector.evil.test/x" } }) : recorded(url, init)));
    await assert.rejects(scanAdvisories(["agent-device@0.21.31"], { watch: ["agent-device"], meta }), /GitHub sent https:\/\/collector\.evil\.test, which isn't its API/);
  } finally {
    reset();
  }
});

/** A Blacksand child: takes the token as the CLI does at startup, and reports what it and its own child see. */
function childScript(dir) {
  const file = path.join(dir, "child.mjs");
  fs.writeFileSync(
    file,
    [
      `import { spawnSync } from "node:child_process";`,
      `import * as fs from "node:fs";`,
      `const handed = process.env.${TOKEN_FILE_ENV};`,
      `const { githubToken, githubTokenProblem } = await import(${JSON.stringify(TOKEN_MODULE)});`,
      `const grandchild = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('BLACKSAND_T3_GITHUB'))))"], { encoding: "utf8" });`,
      `console.log(JSON.stringify({ token: githubToken(), problem: githubTokenProblem(), envAfter: Object.keys(process.env).filter((k) => k.startsWith("BLACKSAND_T3_GITHUB")), fileLeft: handed ? fs.existsSync(handed) : null, grandchild: JSON.parse(grandchild.stdout) }));`,
    ].join("\n"),
  );
  return file;
}

test("the token reaches a Blacksand child as a one-shot 0600 file, never its environment; what that child starts sees nothing", async () => {
  const dir = scratch();
  try {
    process.env[TOKEN_ENV] = "ghs_handoffTestTokenNotASecret";
    assert.equal(githubToken(), "ghs_handoffTestTokenNotASecret");
    assert.equal(process.env[TOKEN_ENV], undefined, "out of this process's environment");
    const handoff = githubTokenHandoff();
    const file = handoff.env[TOKEN_FILE_ENV];
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    // As bin/t3's rerunHoldingLock does: the lock on fd 3, the token as a file.
    const release = await tryLock(path.join(dir, "update.lock"));
    const child = spawnSync(process.execPath, [childScript(dir)], { env: { ...process.env, ...handoff.env }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const seen = JSON.parse(child.stdout);
    assert.deepEqual(seen, { token: "ghs_handoffTestTokenNotASecret", problem: null, envAfter: [], fileLeft: false, grandchild: [] });
    handoff.remove();
    assert.equal(fs.existsSync(path.dirname(file)), false);
    // The rerun itself goes through runHoldingLock with that environment.
    const again = githubTokenHandoff();
    const code = await runHoldingLock(release, process.execPath, ["-e", `process.exit(require("node:fs").readFileSync(process.env.${TOKEN_FILE_ENV}, "utf8").trim() === "ghs_handoffTestTokenNotASecret" && !process.env.${TOKEN_ENV} ? 0 : 7)`], { env: { ...process.env, ...again.env } });
    again.remove();
    assert.equal(code, 0);
  } finally {
    process.env[TOKEN_ENV] = "";
    githubToken();
    forgetGithubToken();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a token file others can read, or another account's, isn't used, and says why; a bad one never stops the CLI", () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, "ghs_handoffTestTokenNotASecret\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    process.env[TOKEN_FILE_ENV] = file;
    assert.equal(githubToken(), null);
    assert.match(githubTokenProblem(), /can be read or written by others \(chmod 600 it\)/);
    assert.equal(fs.existsSync(file), false, "a handoff is used up either way");
    fs.writeFileSync(file, "not a token\n", { mode: 0o600 });
    process.env[TOKEN_FILE_ENV] = file;
    assert.equal(githubToken(), null);
    assert.match(githubTokenProblem(), /doesn't hold a GitHub token/);
    fs.symlinkSync("/etc/hosts", path.join(dir, "link"));
    process.env[TOKEN_FILE_ENV] = path.join(dir, "link");
    assert.equal(githubToken(), null);
    assert.match(githubTokenProblem(), /isn't a regular file/);
    process.env[TOKEN_ENV] = "a b";
    assert.equal(githubToken(), null);
    assert.match(githubTokenProblem(), /doesn't hold a GitHub token/);
  } finally {
    delete process.env[TOKEN_FILE_ENV];
    process.env[TOKEN_ENV] = "";
    githubToken();
    forgetGithubToken();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the build account's runs and the CI build get the token too", () => {
  const builder = fs.readFileSync(new URL("../lib/builder.mjs", import.meta.url), "utf8");
  // runAsBuilder writes a handoff file of the build account's own and names it, not the token, in its environment.
  assert.match(builder, /const token = tokenForBuilder\(\);[\s\S]*\.\.\.\(token\?\.env \?\? \{\}\)/);
  // The account makes its handoff with the same writer as any: exclusive, no link followed.
  assert.match(builder, /asBuilder\(\[builderNode\(\), "-e", HANDOFF_WRITER_SCRIPT, parent\], \{ input: `\$\{token\}\\n` \}\)/);
  assert.doesNotMatch(builder, /cat > /);
  const workflow = fs.readFileSync(new URL("../../../.github/workflows/build.yml", import.meta.url), "utf8");
  const step = /- name: Build the pinned release\n {8}env:\n((?: {10}\S[^\n]*\n)+) {8}run:/.exec(workflow);
  assert.ok(step, "build.yml's build step and its env");
  assert.match(step[1], /^ {10}BLACKSAND_T3_GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m, "a read-only job token");
  const bin = fs.readFileSync(fileURLToPath(new URL("../bin/t3", import.meta.url)), "utf8");
  assert.match(bin, /token = githubTokenHandoff\(\);[\s\S]*runHoldingLock\(release, process\.execPath, \[LAUNCHER, \.\.\.process\.argv\.slice\(2\)\], \{ env: \{ \.\.\.process\.env, \.\.\.\(token\?\.env \?\? \{\}\) \} \}\)/);
});

test("the writer creates its file exclusively and follows no link planted in its place", () => {
  const parent = scratch();
  const target = path.join(parent, "elsewhere");
  try {
    let made = null;
    const planted = {
      fs, path,
      fs: {
        ...fs,
        mkdtempSync: (prefix) => {
          made = fs.mkdtempSync(prefix);
          fs.symlinkSync(target, path.join(made, "token"));
          return made;
        },
      },
    };
    assert.throws(() => writeHandoffFile(planted, parent, "ghs_handoffMarker\n"), (error) => error.code === "EEXIST");
    assert.equal(fs.existsSync(target), false, "nothing written through the link");
    assert.equal(fs.existsSync(made), false, "its folder is cleaned up");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the build account's writer script makes the same private handoff", () => {
  const parent = scratch();
  try {
    const script = spawnSync(process.execPath, ["-e", HANDOFF_WRITER_SCRIPT, parent], { input: "ghs_handoffMarker\n", encoding: "utf8" });
    assert.equal(script.status, 0, script.stderr);
    const file = script.stdout;
    assert.ok(path.basename(path.dirname(file)).startsWith("t3b-github-token-") && path.dirname(path.dirname(file)) === parent, file);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8"), "ghs_handoffMarker\n");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
