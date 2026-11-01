// node --test test/: install.sh, sourced for its functions (it runs its main
// only when run), with stubs in place of sudo, Homebrew, the build account and
// bin/t3; the CLI's own refusals run in a scratch clone. Upstream's code
// (pnpm and its pnpmfile, the build, the built server) never runs as you unless
// you chose that (--unisolated-build, or CI's BLACKSAND_T3_UNISOLATED_BUILD=1 in a
// checkout that isn't an install); the build account's home is closed to every
// account but it and yours, and what runs as another account starts in /, since
// the clone it's run from is in your private home; Node and git meet their
// security floors, in install.sh and before every git Blacksand T3 runs; and pnpm
// is the pinned one, laid out from tarballs checked against their digests
// (lib/pnpm.mjs). Nothing here needs root, the network or a real build account.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { GIT_MIN, gitFailure, gitVersionProblem, publicGit } from "../lib/git.mjs";
import { INSTALL_STATE, UNISOLATED_ENV, buildAsYouProblem, readInstallConfig, saveInstallConfig } from "../lib/install-config.mjs";
import { checkVitePlusHome, fetchPinnedPnpm, pnpmTarget } from "../lib/pnpm.mjs";
import { BUILDER_MARKER } from "../lib/util.mjs";

const ROOT = fs.realpathSync(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
const INSTALL = path.join(ROOT, "install.sh");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-install-")));
// A machine with a real build account makes the CLI use it; these tests are about one without.
const hasBuilder = fs.existsSync(BUILDER_MARKER) && "this machine has a build account";

// brew and op that refuse to run: a test that forgets to stub them never reaches this
// Mac's Homebrew, or 1Password (whose every CLI call asks the owner to approve it).
const GUARDS = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-install-guards-"));
for (const name of ["brew", "op"]) fs.writeFileSync(path.join(GUARDS, name), `#!/bin/sh\necho "test ran the real ${name}: stub it" >&2\nexit 99\n`, { mode: 0o755 });

/** Runs `script` in bash after sourcing install.sh, in `cwd`. */
const bash = (script, options = {}) => {
  assert.equal(typeof options, "object", "bash(script, { cwd, env })");
  const { cwd = tmp(), env = {} } = options;
  return spawnSync("bash", ["-c", `source ${JSON.stringify(INSTALL)}\n${script}`], { cwd, encoding: "utf8", env: { ...process.env, ...env, PATH: `${GUARDS}:${env.PATH ?? process.env.PATH}` } });
};

// ------------------------------------------------------------- the scripts --

test("the scripts parse, and shellcheck passes where it's installed", () => {
  for (const file of [INSTALL, path.join(ROOT, "scripts", "add-agent-account.sh"), path.join(ROOT, "scripts", "set-claude-token.sh")]) {
    const parsed = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
  if (spawnSync("shellcheck", ["--version"]).status !== 0) return;
  const linted = spawnSync("shellcheck", ["-S", "warning", INSTALL, path.join(ROOT, "scripts", "add-agent-account.sh"), path.join(ROOT, "scripts", "set-claude-token.sh")], { encoding: "utf8" });
  assert.equal(linted.status, 0, linted.stdout);
});

test("install.sh takes --unisolated-build and still refuses unknown options", () => {
  const unknown = spawnSync("bash", [INSTALL, "--unisolated"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: \.\/install\.sh \[--role ui\|host\|both\] \[--unisolated-build\]/);
  // Parsed as an option: what stops this run is the role after it.
  const parsed = spawnSync("bash", [INSTALL, "--unisolated-build", "--role", "server"], { encoding: "utf8" });
  assert.equal(parsed.status, 2);
  assert.match(parsed.stderr, /unknown role: server/);
  assert.match(bash('echo "UNISOLATED=$UNISOLATED"').stdout, /UNISOLATED=0/, "off unless given");
});

test("host and both roles are refused on Linux before anything runs", () => {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
  for (const role of ["host", "both"]) {
    const result = spawnSync("bash", [INSTALL, "--role", role], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`--role ${role} is macOS only`));
  }
});

// --------------------------------------------------------- build isolation --

/**
 * main() with the OS setup, the build account's setup and bin/t3
 * stubbed: `sudoWorks` is whether `sudo -v` authorizes; every step taken is
 * appended to steps.log, bin/t3's calls with their arguments.
 */
function runMain({ sudoWorks, unisolated = false, noSudo = false }) {
  const cwd = tmp();
  const steps = path.join(cwd, "steps.log");
  fs.mkdirSync(path.join(cwd, "bin"));
  fs.writeFileSync(path.join(cwd, "bin", "t3"), `#!/bin/sh\necho "t3 $*" >>${JSON.stringify(steps)}\n`, { mode: 0o755 });
  const script = `
step() { echo "$*" >>${JSON.stringify(steps)}; }
legacy_install() { return 1; } # test/legacy-install.test.mjs covers the refusal
mac_setup() { step mac_setup; }
linux_setup() { step linux_setup; }
${noSudo ? "have() { [[ \"$1\" != sudo ]] && command -v \"$1\" >/dev/null 2>&1; }" : ""}
sudo() { step "sudo $*"; ${sudoWorks ? "return 0" : "return 1"}; }
setup_builder() { step setup_builder; }
setup_own_toolchain() { step setup_own_toolchain; }
UNISOLATED=${unisolated ? 1 : 0}
main
echo FINISHED`;
  const result = bash(script, { cwd });
  return { result, steps: fs.existsSync(steps) ? fs.readFileSync(steps, "utf8").trim().split("\n") : [] };
}

test("a failed sudo for the build account stops the install before any build or config, with how to proceed", () => {
  for (const noSudo of [false, true]) {
    const { result, steps } = runMain({ sudoWorks: false, noSudo });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /FINISHED/);
    assert.match(result.stderr, noSudo ? /sudo isn't installed/ : /sudo didn't authorize you/);
    assert.match(result.stderr, /only as its build account _blacksand-build/);
    assert.match(result.stderr, /\.\/install\.sh --unisolated-build/);
    // Nothing that runs upstream code, sets up your own toolchain or saves a config came after.
    assert.deepEqual(steps.filter((s) => !s.startsWith("sudo")), [os.platform() === "darwin" ? "mac_setup" : "linux_setup"]);
  }
});

test("with sudo, the build account is set up and the config requires it", () => {
  const { result, steps } = runMain({ sudoWorks: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(steps.includes("setup_builder"));
  assert.ok(!steps.includes("setup_own_toolchain"));
  assert.ok(steps.includes("t3 configure --role ui"), steps.join("\n"));
  assert.ok(steps.indexOf("setup_builder") < steps.indexOf("t3 update"));
  assert.doesNotMatch(result.stderr, /builds as you/);
});

test("--unisolated-build is the only way to build as you, saved as such, and said before the build", () => {
  const { result, steps } = runMain({ sudoWorks: false, unisolated: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(steps.includes("setup_own_toolchain"));
  assert.ok(!steps.includes("setup_builder"));
  const configure = steps.indexOf("t3 configure --role ui --unisolated-build");
  assert.ok(configure >= 0, steps.join("\n"));
  assert.ok(configure < steps.indexOf("t3 update"), "saved before the build");
  assert.match(result.stderr, /sudo didn't authorize you, so this install builds as you \(--unisolated-build\)/);
  assert.match(result.stderr, /Building as you \(--unisolated-build\)/);
  // Given the flag but with sudo working, it still sets up the build account and doesn't save the flag.
  const isolated = runMain({ sudoWorks: true, unisolated: true });
  assert.ok(isolated.steps.includes("setup_builder"));
  assert.ok(isolated.steps.includes("t3 configure --role ui"));
});

test("builds may run as you only by an explicit choice: a saved --unisolated-build, or CI's variable in a checkout that isn't an install", () => {
  const dir = tmp();
  const state = path.join(dir, "state");
  const file = path.join(state, "install.json");
  const problem = (config, env = {}) => buildAsYouProblem(config, { env, state });
  // No install here: only with BLACKSAND_T3_UNISOLATED_BUILD=1 (CI, development).
  assert.match(problem(null), /this checkout isn't an install: run \.\/install\.sh, or, in CI or a development checkout, set BLACKSAND_T3_UNISOLATED_BUILD=1/);
  assert.equal(problem(null, { [UNISOLATED_ENV]: "1" }), null);
  assert.match(problem(null, { [UNISOLATED_ENV]: "true" }), /isn't an install/, "only 1");
  // An install's choice is saved, and not inherited by a configure without the flag.
  assert.equal(saveInstallConfig({ role: "ui", env: {}, file }).unisolatedBuild, false);
  assert.match(problem(readInstallConfig(file), { [UNISOLATED_ENV]: "1" }), /this install builds only as its build account/, "CI's variable doesn't override an install");
  assert.equal(saveInstallConfig({ role: "ui", unisolatedBuild: true, env: {}, file }).unisolatedBuild, true);
  assert.equal(problem(readInstallConfig(file)), null);
  assert.equal(saveInstallConfig({ env: {}, file }).unisolatedBuild, false);
  fs.writeFileSync(file, JSON.stringify({ role: "ui", env: {} }));
  assert.match(problem(readInstallConfig(file)), /builds only as its build account/, "a config from before the setting");
  for (const bad of ["yes", 1, null]) {
    fs.writeFileSync(file, JSON.stringify({ role: "ui", unisolatedBuild: bad, env: {} }));
    assert.throws(() => readInstallConfig(file), /unisolatedBuild is .*, not true or false/, JSON.stringify(bad));
  }
  // What an install leaves, without its install.json: an install, not CI, whatever the environment says.
  fs.rmSync(file);
  for (const name of INSTALL_STATE) {
    fs.writeFileSync(path.join(state, name), "{}");
    assert.match(problem(null, { [UNISOLATED_ENV]: "1" }), new RegExp(`installed builds \\(state/${name.replace(".", "\\.")}\\) but no state/install\\.json: rerun \\./install\\.sh`), name);
    fs.rmSync(path.join(state, name));
  }
  fs.writeFileSync(path.join(state, "blacksand-t3.log"), "");
  assert.equal(problem(null, { [UNISOLATED_ENV]: "1" }), null, "a log is no install");
});

/**
 * A scratch clone (bin/ and lib/) whose runs can't reach the network (HTTPS goes to a closed
 * local port), with a pnpm first on PATH that leaves pnpm-ran behind, and a built server
 * (build/work/apps/server/dist/bin.mjs) that leaves server-ran behind: neither may run as you.
 */
function clone(extraEnv = {}) {
  const dir = tmp();
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(ROOT, part), path.join(repo, part), { recursive: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const tools = path.join(dir, "tools");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "pnpm"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(dir, "pnpm-ran"))}\nexit 1\n`, { mode: 0o755 });
  const server = path.join(repo, "build", "work", "apps", "server", "dist");
  fs.mkdirSync(server, { recursive: true });
  fs.writeFileSync(path.join(server, "bin.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(dir, "server-ran"))}, String(process.getuid()));\n`);
  const env = {
    PATH: `${tools}:${process.env.PATH}`, HOME: home, BLACKSAND_T3_HEADLESS: "1",
    BLACKSAND_T3_APPS: path.join(dir, "Apps"), BLACKSAND_T3_UPDATE_REQUESTS: path.join(dir, "requests"),
    XDG_DATA_HOME: path.join(dir, "data"), XDG_CONFIG_HOME: path.join(dir, "config"),
    HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", GIT_CONFIG_GLOBAL: "/dev/null",
    ...extraEnv,
  };
  const run = (args, more = {}) => spawnSync(process.execPath, [path.join(repo, "bin", "t3"), ...args], { cwd: repo, encoding: "utf8", env: { ...env, ...more }, timeout: 60_000 });
  const ran = (what) => fs.existsSync(path.join(dir, `${what}-ran`));
  return { repo, run, ran, state: path.join(repo, "state") };
}

const UPSTREAM_STEPS = [["smoke"], ["check"], ["check", "--build"], ["update"], ["poll"], ["evaluate"], ["evaluate", "--build"]];

test("an install saved without --unisolated-build refuses every upstream step, plain evaluate included, when there's no build account", { skip: hasBuilder }, () => {
  const c = clone();
  assert.equal(c.run(["configure", "--role", "ui"]).status, 0);
  for (const args of UPSTREAM_STEPS) {
    const refused = c.run(args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stdout + refused.stderr, /this install builds only as its build account/, args.join(" "));
  }
  assert.match(c.run(["evaluate"]).stdout, /evaluate runs upstream's pnpm as you, and this install builds only as its build account/);
  assert.equal(fs.existsSync(path.join(c.repo, "build", "upstream")), false, "nothing fetched as you");
  assert.equal(c.ran("pnpm"), false, "pnpm (and upstream's pnpmfile) never ran as you");
  assert.equal(c.ran("server"), false, "the built server never ran as you");
  assert.match(c.run(["status"]).stdout, /^builds: +refused: this install builds only as its build account: rerun \.\/install\.sh/m);
});

test("a checkout with no install.json refuses upstream steps unless CI's variable says otherwise, and always once it holds an install's state", { skip: hasBuilder }, () => {
  const c = clone();
  for (const args of UPSTREAM_STEPS) {
    const refused = c.run(args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stdout + refused.stderr, /this checkout isn't an install: run \.\/install\.sh, or, in CI or a development checkout, set BLACKSAND_T3_UNISOLATED_BUILD=1/, args.join(" "));
  }
  assert.equal(c.ran("pnpm") || c.ran("server"), false);
  // CI's variable: past the check (the scratch server runs, as you, as CI's would).
  const ci = { BLACKSAND_T3_UNISOLATED_BUILD: "1" };
  c.run(["smoke"], ci);
  assert.equal(c.ran("server"), true, "positive control: the fixture server is what smoke runs");
  assert.match(c.run(["status"], ci).stdout, /^builds: +as you \(BLACKSAND_T3_UNISOLATED_BUILD=1; not an install\)$/m);
  // An install whose install.json is gone, even with the variable set.
  const installed = clone(ci);
  fs.mkdirSync(installed.state, { recursive: true });
  fs.writeFileSync(path.join(installed.state, "current.json"), JSON.stringify({ ref: "v1", sha: "1".repeat(40) }));
  const refused = installed.run(["smoke"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /this clone has installed builds \(state\/current\.json\) but no state\/install\.json: rerun \.\/install\.sh/);
  assert.equal(installed.ran("server"), false);
});

test("with --unisolated-build saved, builds may run as you, and status says so", { skip: hasBuilder }, () => {
  const optedIn = clone();
  const saved = optedIn.run(["configure", "--role", "ui", "--unisolated-build"]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /builds may run as you \(--unisolated-build\)/);
  const smoke = optedIn.run(["smoke"]);
  assert.doesNotMatch(smoke.stdout + smoke.stderr, /builds only as|isn't an install/);
  assert.equal(optedIn.ran("server"), true);
  assert.match(optedIn.run(["status"]).stdout, /^builds: +as you \(installed with --unisolated-build/m);
});

test("CI's workflows say BLACKSAND_T3_UNISOLATED_BUILD=1 on every step that checks, builds or evaluates", () => {
  const workflows = path.join(ROOT, "..", "..", ".github", "workflows");
  let steps = 0;
  for (const file of fs.readdirSync(workflows)) {
    const text = fs.readFileSync(path.join(workflows, file), "utf8");
    // Each step (from "- name:" to the next) that runs one of them, comments aside.
    const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    for (const step of code.split(/\n(?=\s+- (?:name|uses|run):)/)) {
      if (!/node bin\/t3 (check|evaluate|update|smoke|poll)\b/.test(step)) continue;
      steps++;
      assert.match(step, /\n\s+BLACKSAND_T3_UNISOLATED_BUILD: "1"\n/, `${file}: ${step.trim().split("\n")[0]}`);
    }
  }
  assert.ok(steps >= 3, "ci.yml's check, build.yml's check --build and evaluate.yml's evaluate");
});

// ------------------------------------------------------ the build account --

/** Stubs for setup_builder: sudo and account creation do nothing; the build account is this one. */
const BUILDER_STUBS = `
uname() { if [[ "\${1:-}" == -m ]]; then command uname -m; else echo Darwin; fi; }
sudo() { :; }
id() { echo staff; }
builder_user_mac() { :; }
pnpm_installed() { :; }
build_tools_problem() { :; }
provision_tools_lock() { :; }
hold_tools_lock() { :; }
private_home() { [[ "$(ls -ld "$HOME" | cut -c5-10)" == "------" ]]; }
as_builder() {
  case "$1" in
    node) [[ -z "\${FAKE_OLD_NODE:-}" ]] ;;
    cargo) return 0 ;;
    test) ! private_home ;;
    *) "$@" ;;
  esac
}
BUILDER_HOME="$PWD/builder"
mkdir -p "$BUILDER_HOME" upstream build
`;

test("setup_builder stops at the first failing step, before the marker and the cleanup", () => {
  const cwd = tmp();
  const result = bash(`${BUILDER_STUBS}\nas_builder() { return 0; }\nbuild_tools_problem() { return 1; }\npnpm_fetch() { echo "no network" >&2; return 3; }\nsetup_builder\necho REACHED`, { cwd, env: { HOME: cwd } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /couldn't get the pinned pnpm/);
  assert.doesNotMatch(result.stdout, /REACHED/);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".blacksand-builder")), false);
  assert.equal(fs.existsSync(path.join(cwd, "build")), true);
});

test("the build account's Node must meet the security floor", () => {
  const cwd = tmp();
  const result = bash(`${BUILDER_STUBS}\nsetup_builder\necho REACHED`, { cwd, env: { HOME: cwd, FAKE_OLD_NODE: "1" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /isn't Node 24\+ with the Oct 2026 security fixes/);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".blacksand-builder")), false);
});

test("a home the build account can read is made private before builds use the account", () => {
  const cwd = tmp();
  fs.chmodSync(cwd, 0o750);
  const result = bash(`${BUILDER_STUBS}\nsetup_builder\necho REACHED`, { cwd, env: { HOME: cwd } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Making .* private/);
  assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".blacksand-builder")), true);
  assert.equal(fs.existsSync(path.join(cwd, "build")), false, "old build data cleared only at the end");
});

test("the build account's own git must meet the floor before builds use it", () => {
  const cwd = tmp();
  const stubs = `
uname() { if [[ "\${1:-}" == -m ]]; then command uname -m; else echo Darwin; fi; }
sudo() { :; }
id() { echo staff; }
builder_user_mac() { :; }
pnpm_installed() { :; }
build_tools_problem() { :; }
provision_tools_lock() { :; }
hold_tools_lock() { :; }
as_builder() {
  case "$1" in
    node | cargo) return 0 ;;
    test) return 1 ;;
    git) echo "git version 2.54.0 (Apple Git-157)" ;;
    *) "$@" ;;
  esac
}
BUILDER_HOME="$PWD/builder"
mkdir -p "$BUILDER_HOME"
chmod 700 "$HOME"
setup_builder
echo REACHED`;
  const result = bash(stubs, { cwd, env: { HOME: cwd } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /_blacksand-build's git: git 2\.54\.0 is too old/);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".blacksand-builder")), false, "the marker comes only after the checks");
});

test("on macOS the build account's home is 700 with one ACL entry letting you through, set again on every run", () => {
  const cwd = tmp();
  const home = path.join(cwd, "builder");
  fs.mkdirSync(home);
  const log = path.join(cwd, "sudo.log");
  const result = bash(`uname() { echo Darwin; }\nsudo() { echo "$*" >> ${JSON.stringify(log)}; }\nBUILDER_HOME=${JSON.stringify(home)}\nbuilder_home\necho DONE`, { cwd });
  assert.equal(result.status, 0, result.stderr);
  const me = os.userInfo().username;
  const group = spawnSync("id", ["-gn", "_blacksand-build"], { encoding: "utf8" }).stdout.trim();
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    `install -d -o _blacksand-build -g ${group} -m 700 ${home}`,
    `chmod -N ${home}`,
    `chmod +a user:${me} allow list,search,readattr,readextattr,readsecurity ${home}`,
  ]);
  // Linux has no agent accounts: there it stays as before.
  fs.rmSync(log);
  assert.equal(bash(`uname() { echo Linux; }\nsudo() { echo "$*" >> ${JSON.stringify(log)}; }\nBUILDER_HOME=${JSON.stringify(home)}\nbuilder_home`, { cwd }).status, 0);
  assert.match(fs.readFileSync(log, "utf8"), /^install -d -o _blacksand-build -g \S* -m 755 /);
});

test("that ACL entry, as macOS applies it, lets you list and pass through a folder whose mode lets no one in, and no more", { skip: process.platform !== "darwin" && "macOS ACLs" }, () => {
  const cwd = tmp();
  const home = path.join(cwd, "builder");
  // sudo runs install.sh's own commands here; install makes the folder with no mode bits at all,
  // so only the ACL entry can let you in (as only it lets you in, not an agent account, on a host).
  const run = (chmodAcl = "") => bash(`uname() { echo Darwin; }\nsudo() { "$@"; }\ninstall() { mkdir -p "\${@: -1}" && chmod 000 "\${@: -1}"; }\n${chmodAcl}BUILDER_HOME=${JSON.stringify(home)}\nbuilder_home\necho DONE`, { cwd });
  try {
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    const acl = spawnSync("/bin/ls", ["-led", home], { encoding: "utf8" }).stdout;
    assert.match(acl, /^d---------/);
    assert.deepEqual(acl.split("\n").filter((line) => /^\s*\d+: /.test(line)).map((line) => line.trim()), [`0: user:${os.userInfo().username} allow list,search,readattr,readextattr,readsecurity`]);
    fs.chmodSync(home, 0o000);
    assert.deepEqual(fs.readdirSync(home), [], "listed through the ACL");
    assert.throws(() => fs.writeFileSync(path.join(home, "new"), ""), /EACCES/, "but nothing written");
    // Without the entry (chmod +a refused), install.sh stops: nothing could reach you.
    fs.chmodSync(home, 0o755);
    fs.rmSync(home, { recursive: true });
    const refused = run(`chmod() { [[ "$1" == +a ]] && return 0; command chmod "$@"; }\n`);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /you can't open .*builder, where builds come back to you/);
  } finally {
    if (fs.existsSync(home)) {
      spawnSync("chmod", ["-N", home]);
      fs.chmodSync(home, 0o755);
    }
  }
});

test("rerunning install.sh closes a build home an older install left 755, ACL entries and all, and status says when one is still open", { skip: process.platform !== "darwin" && "macOS ACLs" }, async () => {
  const { builderHomeProblem } = await import("../lib/builder.mjs");
  const cwd = tmp();
  const home = path.join(cwd, "builder");
  // As the VMs had it: made by install.sh before builder_home, 755, readable inside; plus a stray entry.
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  fs.writeFileSync(path.join(home, "file"), "builder's\n", { mode: 0o644 });
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow list,search,read", home]).status, 0);
  assert.equal(builderHomeProblem(fs.statSync(home).mode, "darwin"), `/private/var/blacksand-build is open to other accounts (mode 755); rerun ./install.sh`);
  // install.sh's own commands, run here (install without -o/-g, which need root).
  const result = bash(`uname() { echo Darwin; }\nsudo() { "$@"; }\ninstall() { local args=(); while (($#)); do case "$1" in -o | -g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; /usr/bin/install "\${args[@]}"; }\nBUILDER_HOME=${JSON.stringify(home)}\nbuilder_home\necho DONE`, { cwd });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    const entries = spawnSync("/bin/ls", ["-led", home], { encoding: "utf8" }).stdout.split("\n").filter((line) => /^\s*\d+: /.test(line)).map((line) => line.trim());
    assert.deepEqual(entries, [`0: user:${os.userInfo().username} allow list,search,readattr,readextattr,readsecurity`], "the stray entry is gone, yours is the only one");
    assert.equal(builderHomeProblem(fs.statSync(home).mode, "darwin"), null);
    assert.equal(fs.readFileSync(path.join(home, "file"), "utf8"), "builder's\n", "what's inside stays readable to you");
  } finally {
    spawnSync("/bin/chmod", ["-N", home]);
    fs.chmodSync(home, 0o755);
  }
  assert.equal(builderHomeProblem(0o40755, "linux"), null, "Linux keeps 755: no agent accounts there");
});

// ------------------------------------------------ run as another account --

/**
 * A scratch layout: `home/clone` (the folder commands run from, made unreadable
 * by chmod 000 on `home` while they run), and `bin/sudo`, which appends the
 * folder it starts in (or UNREADABLE) and its arguments to `sudo.log`.
 */
function layout() {
  const dir = tmp();
  const clone = path.join(dir, "home", "clone");
  fs.mkdirSync(clone, { recursive: true });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "sudo.log");
  fs.writeFileSync(path.join(bin, "sudo"), `#!/bin/sh\ncat >/dev/null 2>&1\nprintf '%s\\t%s\\n' "$(/bin/pwd -P 2>/dev/null || echo UNREADABLE)" "$*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  /** Runs bash `script` from the unreadable clone folder, with the recording sudo first on PATH. */
  const fromPrivateHome = (script, env = {}) => {
    try {
      return spawnSync("/bin/bash", ["-c", `cd ${JSON.stringify(clone)} && chmod 000 ${JSON.stringify(path.dirname(clone))} && ${script}`], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
        timeout: 60_000,
      });
    } finally {
      fs.chmodSync(path.dirname(clone), 0o755);
    }
  };
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("\t")) : []);
  return { dir, clone, fromPrivateHome, starts };
}

// Linux's getcwd(2) answers from the kernel whatever the folders above allow, so
// there the folder stays one a command can start in; the failure is macOS's.
const macCwd = { skip: process.platform !== "darwin" && "macOS getcwd: an unreadable folder above fails it (EACCES)" };

test("the fixture's folder really is one another account couldn't open (positive control)", macCwd, () => {
  const l = layout();
  const result = l.fromPrivateHome("sudo -u someone true");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(l.starts(), [["UNREADABLE", "-u someone true"]]);
});

test("lib/builder.mjs starts every command as the build account in /, wherever the update runs from", () => {
  const l = layout();
  // A copy of bin/ and lib/, so nothing here writes the repository's state/.
  const repo = path.join(l.dir, "repo");
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(ROOT, part), path.join(repo, part), { recursive: true });
  const helper = path.join(l.dir, "helper.mjs");
  fs.writeFileSync(
    helper,
    `import { builderReachable, runAsBuilder } from ${JSON.stringify(path.join(repo, "lib", "builder.mjs"))};\n` +
      "console.log(`reachable ${builderReachable()}`);\nawait runAsBuilder([\"fetch\"]);\nconsole.log(\"ran\");\n",
  );
  const result = l.fromPrivateHome(`${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`, { BLACKSAND_T3_GITHUB_TOKEN: "", GITHUB_TOKEN: "", GH_TOKEN: "" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reachable true[\s\S]*ran/);
  const starts = l.starts();
  // builderReachable, the code copied over (syncCode), the run itself.
  assert.ok(starts.length >= 3, JSON.stringify(starts));
  for (const [cwd, args] of starts) assert.equal(cwd, "/", args);
  assert.ok(starts.some(([, args]) => /bin\/t3 fetch --json$/.test(args)), "the build account's run is among them");
});

test("the smoke-tested server starts in its own folder, so Node's --require preloads don't die on the caller's (EACCES uv_cwd)", () => {
  const l = layout();
  const marker = path.join(l.dir, "server-cwd");
  const server = path.join(l.dir, "server.mjs");
  fs.writeFileSync(server, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.cwd());\n`);
  const preload = path.join(l.dir, "preload.cjs");
  fs.writeFileSync(preload, "// as the tripwire is loaded: --require\n");
  const helper = path.join(l.dir, "helper.mjs");
  fs.writeFileSync(
    helper,
    `import { spawnSync } from "node:child_process";\nimport { openSync } from "node:fs";\nimport { observeServer } from ${JSON.stringify(path.join(ROOT, "lib", "smoke.mjs"))};\n` +
      // Control: started where the caller is, Node dies before the server runs.
      `const inherited = spawnSync(process.execPath, ["--require", ${JSON.stringify(preload)}, ${JSON.stringify(server)}], { encoding: "utf8" });\n` +
      "console.log(`inherited ${inherited.status} ${/EACCES: process.cwd failed/.test(inherited.stderr)}`);\n" +
      `const out = openSync(${JSON.stringify(path.join(l.dir, "smoke.log"))}, "w");\n` +
      `try { await observeServer({ args: ["--require", ${JSON.stringify(preload)}, ${JSON.stringify(server)}], env: { PATH: process.env.PATH }, port: 9, out, observeMs: 100, startupMs: 2000 }); } catch (error) { console.log(\`observed: \${error.message}\`); }\n`,
  );
  const result = l.fromPrivateHome(`${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  if (!macCwd.skip) assert.match(result.stdout, /^inherited 1 true$/m, "positive control: the failure the VMs saw");
  assert.equal(fs.readFileSync(marker, "utf8"), fs.realpathSync(os.tmpdir()), "the server ran, in the temporary folder");
  const smoke = fs.readFileSync(path.join(ROOT, "lib", "smoke.mjs"), "utf8");
  assert.match(smoke, /await observeServer\(\{\n\s+args: \[entry,[^\n]*\n\s+cwd: home,/, "smokeTest starts it in its scratch home");
});

test("install.sh's as_builder runs from /, so the build account's pnpm and Node can start on a rerun", () => {
  const l = layout();
  const result = l.fromPrivateHome(`source ${JSON.stringify(path.join(ROOT, "install.sh"))}; as_builder pnpm --version && as_builder true && echo DONE`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DONE/);
  const starts = l.starts();
  assert.equal(starts.length, 2, JSON.stringify(starts));
  for (const [cwd, args] of starts) {
    assert.equal(cwd, "/", args);
    assert.match(args, /^-n -u _blacksand-build -H env HOME=\S+ PATH=\S+ (pnpm --version|true)$/);
  }
});

test("add-agent-account.sh and add-phone-service.sh run each command as another account from /", () => {
  for (const script of ["add-agent-account.sh", "add-phone-service.sh"]) {
    const l = layout();
    const result = l.fromPrivateHome(`source ${JSON.stringify(path.join(ROOT, "scripts", script))}; as_user agent-test /bin/test -d /; echo DONE`);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /DONE/, script);
    assert.deepEqual(l.starts(), [["/", "-u agent-test -H -- /bin/test -d /"]], script);
  }
});

// ------------------------------------------------------- Node and git --

test("node_ok checks the given Node against the security floor", () => {
  const dir = tmp();
  const fake = (version) => {
    const file = path.join(dir, `node-${version}`);
    // A Node that reports `version` but runs the real check (called as: node -e CHECK ARGS...).
    const shim = [
      `const real = globalThis.process; const versions = { ...real.versions, node: "${version}" };`,
      'const process = new Proxy(real, { get: (t, k) => (k === "versions" ? versions : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });',
      "eval(real.env.T3B_CHECK);",
    ].join(" ");
    fs.writeFileSync(file, `#!/bin/sh\nshift\nT3B_CHECK="$1"; export T3B_CHECK; shift\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(shim)} "$@"\n`, { mode: 0o755 });
    return file;
  };
  const ok = (version) => bash(`node_ok ${JSON.stringify(fake(version))} -- && echo yes || echo no`).stdout.trim();
  assert.equal(ok("24.22.1"), "yes");
  assert.equal(ok("24.22.0"), "no");
  assert.equal(ok("22.23.4"), "no", "under NODE_MAJOR");
  assert.equal(ok("26.12.1"), "yes");
  assert.equal(ok("26.11.9"), "no");
});

/** A git that reports `output` for --version (or fails), and records any other use in `ran`. */
function fakeGit(dir, output, status = 0) {
  const file = path.join(dir, `git-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\nexit ${status}\n`, { mode: 0o755 });
  return file;
}

const gitProblem = (output, status = 0) => {
  const dir = tmp();
  const result = bash(`git_problem ${JSON.stringify(fakeGit(dir, output, status))} && echo OK`);
  return result.stdout.trim();
};

const VERSIONS = [
  "git version 2.55.0", "git version 2.56.0", "git version 2.55.0.rc1", "git version 2.56.0.vfs.0.0", "git version 3.0.0",
  "git version 2.54.0 (Apple Git-157)", "git version 2.54.9", "git version 2.50.1 (Apple Git-155)", "git version 2.45.4",
  "git version 2.44.4", "git version 2.39.5 (Apple Git-154)", "hub version 2.14.2",
];

test("git needs 2.55.0 or later (every advisory's fix, the last CVE-2024-52005's sideband filtering); Apple's 2.54.0 doesn't pass", () => {
  for (const version of VERSIONS.slice(0, 5)) assert.equal(gitProblem(version), "OK", version);
  for (const version of VERSIONS.slice(5, -1)) {
    assert.match(gitProblem(version), /^git 2\.\d+\.\d+ is too old: Blacksand T3 needs 2\.55\.0 or later, for security fixes \(CVE-2024-52005\)$/, version);
  }
  assert.match(gitProblem("hub version 2.14.2"), /can't read git's version \(hub version 2\.14\.2\)/);
  assert.match(gitProblem("", 127), /no git found/);
  assert.match(bash(`git_problem ${JSON.stringify(path.join(tmp(), "missing"))}`).stdout, /no git found/);
});

test("install.sh and lib/git.mjs hold the same floor and say the same thing", () => {
  assert.equal(bash('echo "$GIT_MIN"').stdout.trim(), GIT_MIN);
  for (const version of VERSIONS) {
    const shell = gitProblem(version);
    assert.equal(shell === "OK" ? null : shell, gitVersionProblem(version), version);
  }
});

/**
 * mac_setup with Homebrew at `brew` (its bin/ maybe holding a git), macOS's
 * git (Apple's 2.54.0) in `apple`, which PATH lists before /usr/bin; `upgrades`
 * says whether brew install/upgrade git leaves 2.56.0 in Homebrew's bin.
 */
function macSetup({ brewGit = null, upgrades = true, startPath = (apple) => `${apple}:/usr/bin:/bin` }) {
  const dir = tmp();
  const brew = path.join(dir, "homebrew");
  const apple = path.join(dir, "apple");
  fs.mkdirSync(path.join(brew, "bin"), { recursive: true });
  fs.mkdirSync(apple);
  const gitScript = (version) => `#!/bin/sh\necho "git version ${version}"\n`;
  fs.writeFileSync(path.join(apple, "git"), gitScript("2.54.0 (Apple Git-157)"), { mode: 0o755 });
  if (brewGit) fs.writeFileSync(path.join(brew, "bin", "git"), gitScript(brewGit), { mode: 0o755 });
  const log = path.join(dir, "brew.log");
  const script = `
uname() { echo Darwin; }
xcode-select() { return 0; }
brew() {
  echo "brew $*" >>${JSON.stringify(log)}
  case "$1" in
    --prefix) echo ${JSON.stringify(brew)} ;;
    list) [[ -x ${JSON.stringify(path.join(brew, "bin", "git"))} ]] ;;
    install | upgrade) ${upgrades ? `printf '#!/bin/sh\\necho "git version 2.56.0"\\n' >${JSON.stringify(path.join(brew, "bin", "git"))}; chmod 755 ${JSON.stringify(path.join(brew, "bin", "git"))}` : ":"} ;;
  esac
}
node_ok() { return 0; }
cargo() { :; }
op() { :; }
PATH=${JSON.stringify(startPath(apple, path.join(brew, "bin")))}
mac_setup
echo "PATH=$PATH"
echo "GIT=$(command -v git)"`;
  const result = bash(script);
  return { result, brew, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

test("on macOS, Apple's git makes install.sh install Homebrew's and put Homebrew first on PATH, for this run and what it sets up", () => {
  const fresh = macSetup({});
  assert.equal(fresh.result.status, 0, fresh.result.stderr);
  assert.match(fresh.log, /^brew install git$/m);
  assert.match(fresh.result.stdout, new RegExp(`^PATH=${fresh.brew}/bin:`, "m"), "Homebrew first: the job and the build account inherit this order");
  assert.match(fresh.result.stdout, new RegExp(`^GIT=${fresh.brew}/bin/git$`, "m"));
  // Homebrew's git there but old: upgraded.
  const old = macSetup({ brewGit: "2.54.0" });
  assert.equal(old.result.status, 0, old.result.stderr);
  assert.match(old.log, /^brew upgrade git$/m);
  // Already current, only behind Apple's on PATH: no brew install, just the order.
  const current = macSetup({ brewGit: "2.56.0" });
  assert.equal(current.result.status, 0, current.result.stderr);
  assert.doesNotMatch(current.log, /^brew (install|upgrade) git$/m);
  assert.match(current.result.stdout, new RegExp(`^GIT=${current.brew}/bin/git$`, "m"));
});

test("if Homebrew can't bring git up to the floor, install.sh stops with a short message", () => {
  const stuck = macSetup({ brewGit: "2.54.0", upgrades: false });
  assert.equal(stuck.result.status, 1);
  assert.doesNotMatch(stuck.result.stdout, /^PATH=/m);
  assert.match(stuck.result.stderr, /git 2\.54\.0 is too old: Blacksand T3 needs 2\.55\.0 or later, for security fixes \(CVE-2024-52005\) \(git on PATH: .*\/homebrew\/bin\/git\)\. Run: brew install git/);
});

test("homebrew_first puts Homebrew's bin first, even when PATH repeats /usr/bin after it", () => {
  const dir = tmp();
  const brew = path.join(dir, "homebrew");
  fs.mkdirSync(path.join(brew, "bin"), { recursive: true });
  const run = (start) =>
    spawnSync("/bin/bash", ["-c", `source ${JSON.stringify(path.join(ROOT, "install.sh"))}\nbrew() { echo ${JSON.stringify(brew)}; }\nPATH=${JSON.stringify(start)}\nhomebrew_first\nprintf '%s' "$PATH"`], { encoding: "utf8" }).stdout;
  const bin = path.join(brew, "bin");
  const repeated = `/usr/bin:/bin:${bin}:/usr/local/bin:/usr/bin:/usr/sbin:/sbin`;
  assert.equal(run(repeated), `${bin}:${repeated}`, "/usr/bin first, then Homebrew's, then /usr/bin again");
  assert.equal(run(`${bin}:/usr/bin:/bin`), `${bin}:/usr/bin:/bin`, "already first: unchanged");
  assert.equal(run("/bin:/usr/sbin"), `${bin}:/bin:/usr/sbin`, "no /usr/bin at all");
});

test("every git Blacksand T3 runs is checked first, on whatever PATH the run has (yours, the job's, the build account's)", () => {
  const dir = tmp();
  const repo = path.join(dir, "local.git");
  assert.equal(spawnSync("git", ["init", "--quiet", "--bare", repo]).status, 0);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  /** A git first on PATH that reports `version` and otherwise records its use and runs the real one. */
  const shim = (version) => {
    const bin = path.join(dir, `bin-${version}`);
    fs.mkdirSync(bin);
    const used = path.join(bin, "used");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = --version ]; then echo "git version ${version}"; exit 0; fi\necho "$@" >> ${JSON.stringify(used)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, used: () => fs.existsSync(used) };
  };
  const old = shim("2.54.0 (Apple Git-157)");
  const refused = publicGit(["ls-remote", repo], { url: repo, env: old.env, timeout: 30_000 });
  assert.equal(refused.status, 128);
  assert.match(gitFailure(refused, 30_000), /^fatal: git 2\.54\.0 is too old: Blacksand T3 needs 2\.55\.0 or later, for security fixes \(CVE-2024-52005\); install a newer git \(macOS: brew install git, with Homebrew first on PATH\)$/);
  assert.equal(old.used(), false, "the old git ran nothing");
  const current = shim("2.56.0");
  const ok = publicGit(["ls-remote", repo], { url: repo, env: current.env, timeout: 30_000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(current.used(), true, "positive control: a git at the floor runs");
});

// -------------------------------------------------------------------- pnpm --

const EXE = "#!/bin/sh\necho 12.14.0\n";

/** npm-style tarballs (package/...) for a pnpm whose native binary is `exe`, served by fetch, and fetchPinnedPnpm's pins for them. */
function pnpmRelease(exe = EXE) {
  const dir = tmp();
  const tarball = (name, files) => {
    const src = path.join(dir, name, "package");
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
      fs.writeFileSync(path.join(src, file), content, { mode: 0o755 });
    }
    const tgz = path.join(dir, `${name}.tgz`);
    assert.equal(spawnSync("tar", ["-czf", tgz, "-C", path.dirname(src), "package"]).status, 0);
    return fs.readFileSync(tgz);
  };
  const target = pnpmTarget();
  const wrapper = tarball("wrapper", { "package.json": "{}", pnpm: "placeholder", pn: "placeholder", pnpx: "placeholder", pnx: "placeholder", "dist/node-gyp-bin/node-gyp": "gyp" });
  const native = tarball("exe", { pnpm: exe });
  const served = [];
  globalThis.fetch = async (url) => {
    served.push(String(url));
    return new Response(/\/exe\./.test(String(url)) ? native : wrapper, { status: 200 });
  };
  const sha512 = (data) => createHash("sha512").update(data).digest("hex");
  return { target, served, options: { target, tarballs: { wrapper: sha512(wrapper), [target]: sha512(native) }, digests: { [target]: createHash("sha256").update(exe).digest("hex") } } };
}

test("the pinned pnpm is laid out from its two tarballs as npm -g would, with a Vite+ home holding the same binary, and no install script run", async () => {
  const release = pnpmRelease();
  const dir = tmp();
  await fetchPinnedPnpm(dir, release.options);
  assert.deepEqual(release.served.map((url) => url.replace(/\d+\.\d+\.\d+\.tgz$/, "V.tgz")), [
    "https://registry.npmjs.org/pnpm/-/pnpm-V.tgz",
    `https://registry.npmjs.org/@pnpm/exe.${release.target}/-/exe.${release.target}-V.tgz`,
  ]);
  const pkg = path.join(dir, "pnpm", "lib", "node_modules", "pnpm");
  for (const name of ["pnpm", "pn", "pnpx", "pnx"]) {
    assert.equal(fs.readlinkSync(path.join(dir, "pnpm", "bin", name)), `../lib/node_modules/pnpm/${name}`);
    assert.equal(fs.readFileSync(path.join(pkg, name), "utf8"), EXE, `${name}: the native binary, not the wrapper's placeholder`);
  }
  assert.equal(fs.existsSync(path.join(pkg, "dist", "node-gyp-bin", "node-gyp")), true);
  assert.equal(spawnSync(path.join(dir, "pnpm", "bin", "pnpx"), ["--version"], { encoding: "utf8" }).stdout, "12.14.0\n");
  assert.doesNotThrow(() => checkVitePlusHome(path.join(dir, "vite-plus"), { target: release.target, digests: release.options.digests, rootOwned: false }));
});

test("a tarball that doesn't match its pinned SHA-512, or a binary that isn't the pinned one, stops it before anything is laid out for use", async () => {
  for (const [what, edit, why] of [
    ["the wrapper", (o) => (o.tarballs.wrapper = "0".repeat(128)), /pnpm-[\d.]+\.tgz doesn't match its pinned SHA-512/],
    ["the native build", (o) => (o.tarballs[o.target] = "0".repeat(128)), /exe\.[\w-]+-[\d.]+\.tgz doesn't match its pinned SHA-512/],
    ["the binary", (o) => (o.digests[o.target] = "0".repeat(64)), /isn't the pinned pnpm/],
  ]) {
    const release = pnpmRelease();
    edit(release.options);
    const dir = tmp();
    await assert.rejects(fetchPinnedPnpm(dir, release.options), why, what);
    assert.equal(fs.existsSync(path.join(dir, "vite-plus")), false, what);
  }
});

/** pnpm_fetch as lib/pnpm.mjs lays it out, with `exe` for the binary. */
const fetchStub = (exe = EXE) => `pnpm_fetch() {
  local pkg="$1/pnpm/lib/node_modules/pnpm" bin
  mkdir -p "$pkg/dist" "$1/pnpm/bin" "$1/vite-plus"
  for bin in pnpm pn pnpx pnx; do printf ${JSON.stringify(exe)} >"$pkg/$bin"; chmod 755 "$pkg/$bin"; ln -s "../lib/node_modules/pnpm/$bin" "$1/pnpm/bin/$bin"; done
}
`;

test("install_pnpm copies the fetched pnpm into your prefix with npm -g's links, and stops if what's there isn't the pinned binary", () => {
  const prefix = path.join(tmp(), "prefix");
  const byContent = `pnpm_installed() { grep -q 12.14.0 "$1/lib/node_modules/pnpm/pnpm"; }\n`;
  const ok = bash(`${fetchStub()}${byContent}install_pnpm ${JSON.stringify(prefix)}\n${JSON.stringify(prefix)}/bin/pnpx --version`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^12\.14\.0$/m);
  assert.equal(fs.readlinkSync(path.join(prefix, "bin", "pnpm")), "../lib/node_modules/pnpm/pnpm");
  // The real check: these bytes aren't the pinned binary.
  const bad = bash(`${fetchStub()}install_pnpm ${JSON.stringify(path.join(tmp(), "prefix"))}\necho REACHED`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /isn't the pinned binary/);
  assert.doesNotMatch(bad.stdout, /REACHED/);
  // Nothing fetched, nothing installed.
  const offline = bash(`pnpm_fetch() { return 1; }\ninstall_pnpm ${JSON.stringify(path.join(tmp(), "prefix"))}\necho REACHED`);
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /couldn't get the pinned pnpm/);
});

test("pnpm_installed goes by the binary's bytes, not what it says: the pinned version string from other bytes, a symlink or nothing is not installed", () => {
  const prefix = path.join(tmp(), "prefix");
  const installed = () => bash(`pnpm_installed ${JSON.stringify(prefix)} && echo YES || echo NO`).stdout.trim();
  assert.equal(installed(), "NO", "nothing there");
  const file = path.join(prefix, "lib", "node_modules", "pnpm", "pnpm");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, EXE, { mode: 0o755 });
  assert.equal(spawnSync(file, ["--version"], { encoding: "utf8" }).stdout.trim(), "12.14.0", "it says it's the pinned version");
  assert.equal(installed(), "NO", "but its bytes aren't the pinned binary's");
  // setup_own_toolchain reinstalls it then, and leaves a pnpm that passes alone.
  const log = (pass) => bash(`pnpm_installed() { ${pass ? "return 0" : "return 1"}; }\ninstall_pnpm() { echo "install_pnpm $1"; }\ncargo() { :; }\nsetup_own_toolchain`, { env: { HOME: path.dirname(prefix) } }).stdout;
  assert.match(log(false), /^install_pnpm .*\/\.local$/m);
  assert.doesNotMatch(log(true), /install_pnpm/);
});

const REAL = process.env.BLACKSAND_T3_REAL_PNPM;
test("real pnpm: the pinned binary counts as installed", { skip: !REAL && "set BLACKSAND_T3_REAL_PNPM to the pinned pnpm (<prefix>/lib/node_modules/pnpm/pnpm)" }, () => {
  const prefix = path.resolve(REAL, "..", "..", "..", "..");
  assert.equal(bash(`pnpm_installed ${JSON.stringify(prefix)} && echo YES || echo NO`).stdout.trim(), "YES");
});
