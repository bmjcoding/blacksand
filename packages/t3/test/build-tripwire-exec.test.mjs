// node --test test/: the network tripwire (lib/files/tripwire.cjs) on network clients
// run as programs. A client is known by the program that really runs (not the argv[0]
// it's shown as, nor a link's name), looked up where the child would look (env PATH=,
// -C, -P; a shell's PATH=; execve's cwd), through wrappers, shells and env -S; a form
// the tripwire can't read is refused as unreadable. Upstream's own launch lines still
// run. Each case is tried for real against local receivers (test/tripwire-fixtures.mjs):
// it must be logged and reach nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { CURL, receivers, scratch, tripped } from "./tripwire-fixtures.mjs";

const ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((file) => fs.existsSync(file));
const cp = 'require("node:child_process")';
const quiet = ["-q", "-s", "--max-time", "3"];

/**
 * Code that spawns `file args` in a process group of its own (a line may `kill 0`)
 * with a pipe on fd 3 (Claude's watcher reads it), and exits when it does.
 */
const spawned = (file, args) =>
  `const c = ${cp}.spawn(${JSON.stringify(file)}, ${JSON.stringify(args)}, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
   c.on("error", () => process.exit(0));
   c.on("exit", () => process.exit(0));
   setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} process.exit(0); }, 8000);`;

/** Runs every case ({ name: code }) at once; each must be logged once as an exec matching `pattern`, and nothing may reach the receivers. */
async function assertBlocked(net, cases, pattern = /^curl /, options = {}) {
  const results = await Promise.all(Object.values(cases).map((code) => tripped(code, options)));
  Object.keys(cases).forEach((name, i) => {
    const attempts = results[i];
    assert.equal(attempts.length, 1, `${name}: ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0].kind, "exec", name);
    assert.match(attempts[0].host, pattern, `${name}: ${attempts[0].host}`);
  });
  assert.deepEqual(net.seen.http, []);
}

/** A scratch dir with bin/helper, a link to curl. */
function helperDir() {
  const dir = scratch("bin");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.symlinkSync(CURL, path.join(dir, "bin", "helper"));
  return dir;
}

test("curl behind env, exec or a shell wrapper, or given only a config file, is blocked; asking its version isn't an attempt", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const config = path.join(scratch("curl"), "curl.conf");
  fs.writeFileSync(config, `url = "${net.url("config")}"\nmax-time = 3\nsilent\n`);
  try {
    await assertBlocked(net, {
      env: `${cp}.spawnSync("/usr/bin/env", ["curl", "--max-time", "3", "-s", ${JSON.stringify(net.url("env"))}]);`,
      envIgnore: `${cp}.spawnSync("/usr/bin/env", ["-i", "A=1", "curl", "-s", ${JSON.stringify(net.url("env-i"))}]);`,
      exec: `try { ${cp}.execSync(${JSON.stringify(`exec /usr/bin/curl --max-time 3 -s ${net.url("exec")}`)}); } catch {}`,
      config: `${cp}.spawnSync("curl", ["-q", ${JSON.stringify(`-K${config}`)}]);`,
      wrapped: `${cp}.spawnSync("/bin/sh", ["-lc", ${JSON.stringify(`X=1 nohup timeout 5 curl -s ${net.url("wrapped")}`)}]);`,
      substituted: `${cp}.spawnSync("/bin/sh", ["-c", ${JSON.stringify(`echo $(curl -s ${net.url("subst")})`)}]);`,
    });
    assert.deepEqual(await tripped(`${cp}.spawnSync("curl", ["--version"]); ${cp}.spawnSync("/bin/sh", ["-c", "command -v curl >/dev/null"]);`), []);
  } finally {
    await net.close();
  }
});

test("curl is known by the program that runs: argv0, a sync shell command line, env -S, a link, process.execve", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const bin = path.join(helperDir(), "bin");
  const url = (name) => JSON.stringify(net.url(name));
  const args = `${JSON.stringify(quiet).slice(1, -1)}`;
  try {
    await assertBlocked(net, {
      argv0: `${cp}.spawn(${JSON.stringify(CURL)}, [${args}, ${url("argv0")}], { argv0: "helper" });`,
      argv0Sync: `${cp}.spawnSync(${JSON.stringify(CURL)}, [${args}, ${url("argv0-sync")}], { argv0: "helper" });`,
      syncShell: `${cp}.spawnSync(${JSON.stringify(`${CURL} -q -s --max-time 3 ${net.url("sync-shell")}`)}, { shell: true });`,
      execFileShell: `try { ${cp}.execFileSync("curl", [${args}, ${url("exec-file-shell")}], { shell: "/bin/bash" }); } catch {}`,
      envSplit: `${cp}.spawn("/usr/bin/env", ["-S", ${JSON.stringify(`curl -q -s --max-time 3 ${net.url("env-split")}`)}]);`,
      envSplitAttached: `${cp}.spawnSync("/usr/bin/env", ["-iS'curl' -q", "-s", ${url("env-split-attached")}]);`,
      envSplitInShell: `${cp}.spawnSync("/bin/sh", ["-c", ${JSON.stringify(`env -S "curl -q -s" ${net.url("env-split-shell")}`)}]);`,
      link: `${cp}.spawnSync(${JSON.stringify(path.join(bin, "helper"))}, [${args}, ${url("link")}]);`,
      linkOnPath: `${cp}.spawnSync("helper", [${args}, ${url("link-path")}], { env: { PATH: ${JSON.stringify(`${bin}:/usr/bin:/bin`)} } });`,
      execve: `try { process.execve(${JSON.stringify(CURL)}, ["innocent", ${args}, ${url("execve")}]); } catch {}`,
    });
  } finally {
    await net.close();
  }
});

test("env PATH=, -i PATH=, -C, --chdir, -P and a shell's PATH= are followed: a curl link found there is blocked", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const dir = helperDir();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dir, "a=b"));
  fs.symlinkSync(CURL, path.join(dir, "a=b", "helper"));
  const cases = {
    envPath: ["/usr/bin/env", [`PATH=${bin}:/usr/bin:/bin`, "helper", ...quiet, net.url("env-path")]],
    envIgnorePath: ["/usr/bin/env", ["-i", `PATH=${bin}`, "helper", ...quiet, net.url("env-i-path")]],
    envCwd: ["/usr/bin/env", ["-C", bin, "./helper", ...quiet, net.url("env-cwd")]],
    envChdir: ["/usr/bin/env", [`--chdir=${dir}`, "bin/helper", ...quiet, net.url("env-chdir")]],
    envCwdRelativePath: ["/usr/bin/env", ["-C", dir, "PATH=bin", "helper", ...quiet, net.url("env-cwd-path")]],
    envSearch: ["/usr/bin/env", ["-P", bin, "helper", ...quiet, net.url("env-search")]],
    envSplitCwd: ["/usr/bin/env", ["-S", `-C ${bin} ./helper -q -s ${net.url("env-split-cwd")}`]],
    // env takes any word with an "=" as an assignment, not only NAME=value.
    envOddAssignment: ["/usr/bin/env", ["a-b=c", CURL, ...quiet, net.url("env-odd")]],
    shellPath: ["/bin/sh", ["-c", `PATH=${bin}:/usr/bin:/bin helper -q -s --max-time 3 ${net.url("shell-path")}`]],
    shellTimePath: ["/bin/sh", ["-c", `time PATH=${bin}:/usr/bin:/bin helper -q -s ${net.url("shell-time-path")}`]],
    // A program whose path has an "=" isn't an assignment.
    equalsInPath: [path.join(dir, "a=b", "helper"), [...quiet, net.url("equals-in-path")]],
  };
  try {
    await assertBlocked(net, Object.fromEntries(Object.entries(cases).map(([name, [file, args]]) => [name, spawned(file, args)])), /^curl /, { cwd: dir, PATH: "/usr/bin:/bin" });
    if (typeof process.execve === "function") {
      // process.execve looks a bare name up in the cwd, not on PATH.
      await assertBlocked(net, { execveCwd: `try { process.execve("helper", ["helper", "-q", "-s", ${JSON.stringify(net.url("execve-cwd"))}]); } catch {}` }, /^curl /, { cwd: bin, PATH: "/usr/bin:/bin" });
    }
  } finally {
    await net.close();
  }
});

test("a command line that changes how its commands are found, or whose command word isn't plain, is refused as unreadable", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const dir = helperDir();
  const bin = path.join(dir, "bin");
  const url = (name) => net.url(name);
  const cases = {
    cdThen: ["/bin/sh", ["-c", `cd ${bin} && ./helper -q -s ${url("cd")}`]],
    commandCd: ["/bin/sh", ["-c", `command cd ${bin}; ./helper -q -s ${url("command-cd")}`]],
    exportPath: ["/bin/sh", ["-c", `export PATH=${bin}:/usr/bin:/bin; helper -q -s ${url("export")}`]],
    standalonePath: ["/bin/sh", ["-c", `PATH=${bin}:/usr/bin:/bin; helper -q -s ${url("standalone")}`]],
    expandedPath: ["/bin/sh", ["-c", `PATH=${bin}:$PATH helper -q -s ${url("expanded")}`]],
    ...(fs.existsSync("/bin/bash") && { appendedPath: ["/bin/bash", ["-c", `PATH+=:${bin}; helper -q -s ${url("appended")}`]] }),
    expandedEnvCwd: ["/bin/sh", ["-c", `env -C "$HOME/bin" ./helper -q -s ${url("env-home")}`]],
    sourced: ["/bin/sh", ["-c", `. /dev/null; helper -q -s ${url("sourced")}`]],
    aliased: ["/bin/sh", ["-c", `alias h=${CURL}\nh -q -s ${url("alias")}`]],
    variableCommand: ["/bin/sh", ["-c", `c=${CURL}; $c -q -s ${url("variable")}`]],
    quotedInside: ["/bin/sh", ["-c", `cu"r"l -q -s ${url("quoted")}`]],
    escaped: ["/bin/sh", ["-c", `cu\\rl -q -s ${url("escaped")}`]],
    tilde: ["/bin/sh", ["-c", `~/bin/helper -q -s ${url("tilde")}`]],
    glob: ["/bin/sh", ["-c", `${CURL.slice(0, -1)}? -q -s ${url("glob")}`]],
    setPositional: ["/bin/sh", ["-c", `set -- ${CURL} -q -s ${url("set")}; "$@"`]],
    functionArgs: ["/bin/sh", ["-c", `f() { "$@"; }; f ${CURL} -q -s ${url("function")}`]],
    sudoChroot: ["/usr/bin/sudo", ["-n", "-R", "/", CURL, url("sudo-chroot")]],
    ...(ZSH && {
      zshPathArray: [ZSH, ["-c", `path=(${bin} $path); helper -q -s ${url("zsh-path")}`]],
      zshEquals: [ZSH, ["-fc", `=curl -q -s ${url("zsh-equals")}`]],
    }),
  };
  // Wrapper forms the tripwire can't read, through spawnSync.
  const wrappers = {
    envUnknownOption: ["/usr/bin/env", ["--frobnicate", "curl", url("unknown-option")]],
    envSplitDollar: ["/usr/bin/env", ["-S", `curl -q $URL ${url("dollar")}`]],
    envSplitUnbalanced: ["/usr/bin/env", ["-S", `'curl ${url("unbalanced")}`]],
    envSplitEmpty: ["/usr/bin/env", ["-S"]],
    niceUnknownOption: ["nice", ["-x", "curl", url("nice")]],
  };
  try {
    await assertBlocked(net, Object.fromEntries(Object.entries(cases).map(([name, [file, args]]) => [name, spawned(file, args)])), /\(unreadable\)/, { cwd: dir, home: dir, PATH: "/usr/bin:/bin" });
    await assertBlocked(net, Object.fromEntries(Object.entries(wrappers).map(([name, [file, args]]) => [name, `${cp}.spawnSync(${JSON.stringify(file)}, ${JSON.stringify(args)});`])), /\(unreadable\)/);
  } finally {
    await net.close();
  }
});

test('"$@", shift, eval, trap, reserved words and redirections don\'t hide a network client', { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const url = (name) => net.url(name);
  const cases = {
    positional: ["/bin/sh", ["-c", 'exec "$@"', "sh", CURL, "-q", "-s", url("positional")]],
    numbered: ["/bin/sh", ["-c", '"$1" -q -s "$2"', "sh", CURL, url("numbered")]],
    shifted: ["/bin/sh", ["-c", 'shift 2; exec "$@"', "sh", "/usr/bin/true", "x", CURL, "-q", "-s", url("shifted")]],
    ifCondition: ["/bin/sh", ["-c", `if curl -q -s ${url("if")}; then :; fi`]],
    negated: ["/bin/sh", ["-c", `! curl -q -s ${url("negated")}`]],
    loopBody: ["/bin/sh", ["-c", `for host in a; do curl -q -s ${url("loop")}; done`]],
    redirectedFirst: ["/bin/sh", ["-c", `> /dev/null curl -q -s ${url("redirected")}`]],
    evaluated: ["/bin/sh", ["-c", `eval curl -q -s ${url("eval")}`]],
    trapped: ["/bin/sh", ["-c", `trap 'curl -q -s ${url("trap")}' EXIT`]],
    braceGroup: ["/bin/sh", ["-c", `{ curl -q -s ${url("brace")}; } 2>/dev/null`]],
  };
  try {
    await assertBlocked(net, Object.fromEntries(Object.entries(cases).map(([name, [file, args]]) => [name, spawned(file, args)])), /^curl /, { PATH: "/usr/bin:/bin" });
  } finally {
    await net.close();
  }
});

test("upstream's launch lines and plain wrapper uses still run, unlogged", async () => {
  const dir = scratch("ok");
  const mark = (name) => path.join(dir, name);
  // As upstream (pinned) launches agents (packages/shared/src/AgentScope.ts), Claude
  // (ClaudeAdapterV2.ts), ACP agents on Linux (AcpSessionRuntime.ts) and reads the
  // login shell's env (packages/shared/src/shell.ts).
  const raise = "{ echo 800 >/proc/self/oom_score_adj; } 2>/dev/null";
  const cases = {
    agentScope: ["/bin/sh", ["-c", [raise, 'exec "$@"'].join("\n"), "t3-agent", "/usr/bin/touch", mark("agent")]],
    scopedAgent: ["/bin/sh", ["-c", [raise, ': "${XDG_RUNTIME_DIR:=$1}"', "export XDG_RUNTIME_DIR", "shift", 'exec "$@"'].join("\n"), "t3-agent", dir, "/usr/bin/touch", mark("scoped")]],
    claudeWatch: ["/bin/sh", ["-c", ["{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &", 'exec "$@" 3<&-'].join("\n"), "t3-claude", "/usr/bin/touch", mark("claude")]],
    acpCgroup: [
      "/bin/sh",
      [
        "-c",
        [
          "lease_path=$1; expected=$2; shift 2",
          raise,
          'printf "%s\\n" "$$" > "$lease_path/cgroup.procs" || exit 125',
          "actual=",
          "while IFS= read -r line; do",
          '  case "$line" in 0::*) [ -z "$actual" ] || exit 126; actual=${line#0::};; esac',
          "done < /proc/self/cgroup || exit 125",
          '[ "$actual" = "$expected" ] || exit 126',
          "unset ELECTRON_RUN_AS_NODE T3_ACP_CGROUP_WRAPPER",
          "trap 'exit 125' 0",
          '[ -f "$1" ] && [ -x "$1" ] || { printf "%s: %s: not an executable file\\n" "$0" "$1" >&2; exit 125; }',
          'exec "$@"',
        ].join("\n"),
        "t3-acp-cgroup-wrapper",
        path.join(dir, "no-lease"),
        "relative",
        "/usr/bin/touch",
        mark("acp-never"),
      ],
    ],
    envCapture: ["/bin/sh", ["-c", "printf '%s\\n' '__T3_ENV_START__'; printenv PATH || true; printf '%s\\n' '__T3_ENV_END__'"]],
    envPathBare: ["/usr/bin/env", ["PATH=/usr/bin:/bin", "touch", mark("env-path")]],
    envIgnoreBare: ["/usr/bin/env", ["-i", "HOME=/tmp", "touch", mark("env-i")]],
    shellPathLiteral: ["/bin/sh", ["-c", `PATH=/usr/bin:/bin touch ${mark("shell-path")}; command -v curl >/dev/null; for host in a; do :; done`]],
    setOptions: ["/bin/sh", ["-c", 'set -eu; exec "$@"', "sh", "/usr/bin/touch", mark("set-options")]],
  };
  // Plain wrapper uses through spawnSync and execSync.
  const sync = [
    `${cp}.spawnSync("/usr/bin/env", ["-i", "A=1", "/usr/bin/touch", ${JSON.stringify(mark("sync-env"))}]);`,
    `${cp}.spawnSync("/usr/bin/env", ["-S", ${JSON.stringify(`/usr/bin/touch '${mark("sync-split")}'`)}]);`,
    `${cp}.spawnSync("nice", ["-n", "5", "/usr/bin/touch", ${JSON.stringify(mark("sync-nice"))}]);`,
    `${cp}.execSync(${JSON.stringify(`nohup /usr/bin/touch ${mark("sync-shell")} >/dev/null 2>&1`)});`,
  ].join("\n");
  const results = await Promise.all([...Object.values(cases).map(([file, args]) => tripped(spawned(file, args), { PATH: "/usr/bin:/bin" })), tripped(sync)]);
  [...Object.keys(cases), "sync"].forEach((name, i) => assert.deepEqual(results[i], [], name));
  for (const name of ["agent", "scoped", "claude", "env-path", "env-i", "shell-path", "set-options", "sync-env", "sync-split", "sync-nice", "sync-shell"]) assert.ok(fs.existsSync(mark(name)), name);
});
