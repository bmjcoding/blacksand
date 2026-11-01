// node --test test/: a build runs only the pinned pnpm (lib/pnpm.mjs): install.sh's
// copy of it, by absolute path, its bytes checked right before each run, never a
// `pnpm` PATH finds (upstream's node_modules/.bin, Corepack, a version manager).
// pnpm's own version switching is off in the build's environment, a release whose
// package.json asks for another pnpm stops the build, and upstream's Vite+ runs the
// same binary from a home the build hands it, which may hold nothing else.
// T3BLACKOUT_REAL_PNPM=<the pinned pnpm binary> also runs the real one;
// T3BLACKOUT_PNPM_DIGESTS_ONLINE=1 derives PNPM_BINARY_SHA256 again from the registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildEnv, resolveLockfile } from "../lib/build.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import {
  BUILD_TOOLS_ROOT,
  PNPM_BINARY_SHA256,
  PNPM_ENV,
  PNPM_VERSION,
  RAISE_PNPM,
  ROOT_PNPM_PREFIX,
  ROOT_VITE_PLUS_HOME,
  VITE_PLUS_LAUNCHERS,
  aclProblem,
  buildToolsRoot,
  checkVitePlusHome,
  pinnedPnpmPath,
  pnpmPinProblem,
  pnpmPinProblemIn,
  pnpmTarget,
  rootOwnedProblem,
  runsAsBuilder,
  seedVitePlusHome,
  verifiedPnpm,
  vitePlusHome,
} from "../lib/pnpm.mjs";
import { guardedInstall, main } from "../lib/stage-install.mjs";

const ROOT = new URL("..", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), "utf8");
const INSTALL_SH = read("install.sh");
const manifest = (fields) => JSON.stringify({ name: "upstream", private: true, ...fields });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-pnpm-")));

/** A stand-in pnpm: a script logging its arguments to `log` and printing PNPM_VERSION; its digest table, as verifiedPnpm takes it. */
function fakePnpm(dir, log, name = "pnpm") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${log}'\n[ "$1" = --version ] && echo ${PNPM_VERSION}\nexit 0\n`, { mode: 0o755 });
  return { file, digests: { [pnpmTarget()]: sha256(fs.readFileSync(file)) } };
}

test("the pin is lib/pnpm.mjs's alone, and install.sh puts root's tools where builds look for them", () => {
  assert.match(PNPM_VERSION, /^\d+\.\d+\.\d+$/);
  for (const digest of Object.values(PNPM_BINARY_SHA256)) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(INSTALL_SH, /PNPM_VERSION|pnpm_sha512|pnpm_binary_sha256|registry\.npmjs\.org\/pnpm/, "install.sh has no pin of its own: it asks lib/pnpm.mjs (fetch, check-pnpm)");
  assert.match(INSTALL_SH, /^pnpm_fetch\(\) \{ node "\$PNPM_CHECK" fetch "\$1"; \}$/m);
  assert.equal(pnpmTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(pnpmTarget("linux", "x64"), "linux-x64");
  assert.equal(pnpmTarget("win32", "x64"), null);
  assert.equal(pinnedPnpmPath({ builder: false, home: "/home/me" }), "/home/me/.local/lib/node_modules/pnpm/pnpm", "where install_pnpm puts yours");
  assert.equal(pinnedPnpmPath({ builder: true }), path.join(BUILD_TOOLS_ROOT, "pnpm", "lib", "node_modules", "pnpm", "pnpm"), "root's, for the build account");
  assert.equal(vitePlusHome({ builder: true }), path.join(BUILD_TOOLS_ROOT, "vite-plus"));
  assert.equal(vitePlusHome({ builder: false, data: "/build" }), "/build/vite-plus");
  // install.sh installs root's tools where lib/pnpm.mjs looks for them, per platform.
  assert.match(INSTALL_SH, new RegExp(`^  Darwin\\) BUILD_TOOLS="${buildToolsRoot("darwin")}" ;;$`, "m"));
  assert.match(INSTALL_SH, new RegExp(`^  \\*\\) BUILD_TOOLS=${buildToolsRoot("linux")} ;;$`, "m"));
  assert.equal(ROOT_PNPM_PREFIX, path.join(BUILD_TOOLS_ROOT, "pnpm"));
  assert.equal(ROOT_VITE_PLUS_HOME, path.join(BUILD_TOOLS_ROOT, "vite-plus"));
  // On macOS not under /usr/local (an Intel Mac's Homebrew owns it), but under a root-owned tree.
  assert.ok(buildToolsRoot("darwin").startsWith("/Library/Application Support/"), buildToolsRoot("darwin"));
  assert.equal(runsAsBuilder(), os.userInfo().username === "_t3blackout", "these tests don't run as the build account");
});

test("the build's environment turns pnpm's version switching off, both ways pnpm 12 reads it", () => {
  const env = buildEnv();
  assert.deepEqual(PNPM_ENV, { pnpm_config_manage_package_manager_versions: "false", pnpm_config_pm_on_fail: "ignore" });
  for (const [key, value] of Object.entries(PNPM_ENV)) assert.equal(env[key], value, key);
  // npm reads npm_config_*, warns about each it doesn't know and says it will refuse them.
  assert.deepEqual(Object.keys(env).filter((key) => /^npm_config_/i.test(key)), []);
});

test("a release that asks for the pinned pnpm builds; one that asks for any other stops", () => {
  for (const ok of [
    manifest({ packageManager: `pnpm@${PNPM_VERSION}` }),
    manifest({ packageManager: `pnpm@${PNPM_VERSION}+sha512.${"a".repeat(128)}` }),
    manifest({}),
    manifest({ packageManager: `pnpm@${PNPM_VERSION}`, devEngines: { packageManager: { name: "pnpm", version: PNPM_VERSION, onFail: "download" } } }),
  ]) {
    assert.equal(pnpmPinProblem(ok), null, ok);
  }
  for (const [text, says] of [
    [manifest({ packageManager: "pnpm@12.16.1" }), /asks for pnpm@12\.16\.1 \(packageManager in package\.json\), not pnpm 12\.14\.0, the one T3 Blackout pins/],
    // Older is another pnpm too: pnpm switches down as readily as up.
    [manifest({ packageManager: "pnpm@12.12.0" }), /pnpm@12\.12\.0/],
    [manifest({ packageManager: "pnpm@12.16.1+sha512.0000" }), /pnpm@12\.16\.1\+sha512\.0000/],
    [manifest({ packageManager: "yarn@4.5.0" }), /yarn@4\.5\.0/],
    [manifest({ packageManager: "pnpm" }), /asks for pnpm \(packageManager/],
    [manifest({ packageManager: `pnpm@${PNPM_VERSION}`, devEngines: { packageManager: { name: "pnpm", version: "12.16.1", onFail: "download" } } }), /pnpm@12\.16\.1 \(devEngines\.packageManager/],
    [manifest({ devEngines: { packageManager: [{ name: "pnpm", version: PNPM_VERSION }, { name: "bun", version: "1.3.0" }] } }), /bun@1\.3\.0/],
    [manifest({ devEngines: { packageManager: { name: "pnpm", version: `^${PNPM_VERSION}` } } }), /pnpm@\^12\.14\.0/],
    ["{ not json", /isn't valid JSON/],
    ["null", /isn't an object/],
  ]) {
    assert.match(pnpmPinProblem(text) ?? "", says, text);
  }
  assert.match(RAISE_PNPM, /PNPM_VERSION and PNPM_TARBALL_SHA512 in lib\/pnpm\.mjs[\s\S]*3 days[\s\S]*PNPM_BINARY_SHA256 \(`node lib\/pnpm\.mjs digests`/);
});

test("pnpmPinProblemIn reads the checkout's root package.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-pnpm-pin-"));
  try {
    assert.equal(pnpmPinProblemIn(dir), "upstream has no package.json");
    fs.writeFileSync(path.join(dir, "package.json"), manifest({ packageManager: `pnpm@${PNPM_VERSION}` }));
    assert.equal(pnpmPinProblemIn(dir), null);
    fs.writeFileSync(path.join(dir, "package.json"), manifest({ packageManager: "pnpm@12.16.1" }));
    assert.match(pnpmPinProblemIn(dir), /pnpm@12\.16\.1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifiedPnpm runs the pinned binary only: its bytes, not its version string", () => {
  const dir = scratch();
  try {
    const log = path.join(dir, "calls.log");
    const real = fakePnpm(dir, log);
    assert.equal(verifiedPnpm({ file: real.file, digests: real.digests }), real.file);
    // A shadow: anything else that prints the pinned version is refused.
    const shim = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, "pnpm"), `#!/bin/sh\necho ${PNPM_VERSION}\n`, { mode: 0o755 });
    assert.throws(() => verifiedPnpm({ file: path.join(shim, "pnpm"), digests: real.digests }), /isn't the pinned pnpm 12\.14\.0 \(its sha-256 is [0-9a-f]{64}\); remove .* and rerun \.\/install\.sh/);
    // A symlink to the right bytes isn't the installed file either.
    fs.symlinkSync(real.file, path.join(dir, "linked"));
    assert.throws(() => verifiedPnpm({ file: path.join(dir, "linked"), digests: real.digests }), /a symlink/);
    assert.throws(() => verifiedPnpm({ file: path.join(dir, "missing"), digests: real.digests }), /isn't installed at .*; rerun \.\/install\.sh/);
    assert.throws(() => verifiedPnpm({ file: real.file, target: "win32-x64" }), /no pnpm is pinned for win32-x64/);
    // The real table never takes a stand-in.
    assert.throws(() => verifiedPnpm({ file: real.file }), /isn't the pinned pnpm/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout's node_modules/.bin/pnpm or Corepack setup never runs: the build calls pnpm by path", () => {
  const dir = scratch();
  try {
    const log = path.join(dir, "calls.log");
    const real = fakePnpm(dir, log);
    // Two routes in: upstream's .bin first on PATH, and a Corepack shim that
    // would honour the checkout's .corepack.env (registry, integrity keys).
    const work = path.join(dir, "work");
    fs.mkdirSync(path.join(work, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(work, "package.json"), manifest({ packageManager: `pnpm@${PNPM_VERSION}` }));
    fs.writeFileSync(path.join(work, ".corepack.env"), "COREPACK_NPM_REGISTRY=http://127.0.0.1:9\nCOREPACK_INTEGRITY_KEYS=0\n");
    fakePnpm(path.join(work, "node_modules", ".bin"), log, "pnpm");
    const corepack = path.join(dir, "corepack-bin");
    fs.mkdirSync(corepack);
    fakePnpm(corepack, log, "pnpm");
    const env = { PATH: [path.join(work, "node_modules", ".bin"), corepack, "/usr/bin", "/bin"].join(":"), ...PNPM_ENV };
    fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    resolveLockfile({ cwd: work, env }, { pnpm: () => verifiedPnpm({ file: real.file, digests: real.digests }) });
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile --no-trust-lockfile"]);
    assert.equal(calls.length, 1, "only the verified file ran");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no build path finds pnpm by name: lockfile resolution, installs, store pruning, the stage, the stripped tests", () => {
  const build = read("lib/build.mjs");
  const stage = read("lib/stage-install.mjs");
  const stripped = read("ci/stripped-tests.mjs");
  for (const [name, text] of [["lib/build.mjs", build], ["lib/stage-install.mjs", stage], ["ci/stripped-tests.mjs", stripped]]) {
    assert.doesNotMatch(text, /\b(?:run|runTail|spawnSync|execFileSync)\("pnpm"/, `${name} runs pnpm by name`);
  }
  assert.equal((build.match(/run\(verifiedPnpm\(\), \[/g) ?? []).length, 2, "the frozen install and the store prune");
  assert.match(build, /run\(pnpm\(\), \["install", "--lockfile-only"/, "the re-resolution, verifiedPnpm by default");
  assert.match(build, /export function resolveLockfile\(opts = \{ cwd: WORK, env: buildEnv\(\) \}, \{ pnpm = verifiedPnpm \} = \{\}\)/);
  assert.match(build, /real: \{ pnpm: verifiedPnpm\(\) \}/, "the packager's pnpm shim runs the verified file");
  assert.match(stage, /export async function guardedInstall\(dir, env = process\.env, \{ installer = \(\) => verifiedPnpm\(\) \} = \{\}\)/);
  assert.match(stripped, /spawnSync\(verifiedPnpm\(\), \["exec", "vp", "test", "run"/);
  // A release asking for another pnpm is held like a strict rule that stopped matching.
  assert.match(build, /const pnpm = pnpmPinProblemIn\(WORK\);[\s\S]*if \(strict\.length \|\| hosts\.length \|\| tools\.length \|\| locks\.length \|\| pnpm\) \{\n\s+throw new StrictDrift\(stopMessage\(\{ strict, hosts, tools, locks, pnpm \}\)/);
});

test("the stage guard and the packager's pnpm shim run only the verified file, whatever the environment says", async () => {
  const dir = scratch();
  try {
    const log = path.join(dir, "calls.log");
    const fake = fakePnpm(dir, log);
    const app = path.join(dir, "stage", "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "package.json"), manifest({}));
    fs.writeFileSync(path.join(dir, "verified.yaml"), "lockfileVersion: '9.0'\n");
    const env = { PATH: "/usr/bin:/bin", T3BLACKOUT_REAL_PNPM: fake.file, T3BLACKOUT_SHIM_DIR: path.join(dir, "shims"), T3BLACKOUT_STAGE_ROOT: dir, T3BLACKOUT_VERIFIED_LOCK: path.join(dir, "verified.yaml"), T3BLACKOUT_STAGE_RECORD: path.join(dir, "record.jsonl") };
    // The guard installs with what verifiedPnpm accepts (by default install.sh's file; given
    // here so the test doesn't depend on what's installed in this HOME): not the stand-in.
    await assert.rejects(guardedInstall(app, env, { installer: () => verifiedPnpm({ file: fake.file, rootOwned: false }) }), /isn't the pinned pnpm 12\.14\.0/);
    // A pnpm the packager runs through the shim: the environment names a file, its bytes decide.
    await assert.rejects(main("pnpm", ["--version"], { cwd: dir, env }), /isn't the pinned pnpm 12\.14\.0/);
    assert.equal(fs.existsSync(log), false, "nothing ran");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A pnpm-lock.yaml with `pkg` (name@version) as the one dependency, as pnpm 12 writes it. */
const lockOf = (pkg) => {
  const [name, version] = [pkg.slice(0, pkg.lastIndexOf("@")), pkg.slice(pkg.lastIndexOf("@") + 1)];
  return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      ${name}:\n        specifier: ${version}\n        version: ${version}\n\npackages:\n\n  ${pkg}:\n    resolution: {integrity: sha512-AAAA}\n\nsnapshots:\n\n  ${pkg}: {}\n`;
};

test("the stage guard checks pnpm again right before each run, so one run's code can't swap what the next runs", async () => {
  const dir = scratch();
  try {
    const log = path.join(dir, "calls.log");
    const app = path.join(dir, "stage", "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "package.json"), manifest({ dependencies: { "is-number": "^7.0.0" } }));
    fs.writeFileSync(path.join(dir, "verified.yaml"), lockOf("is-number@7.0.0"));
    fs.writeFileSync(path.join(dir, "resolved.yaml"), lockOf("is-number@7.0.0"));
    // A stand-in whose resolution run replaces the binary, as a stage .pnpmfile.cjs hook did.
    const file = path.join(dir, "pnpm");
    fs.writeFileSync(file, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *--lockfile-only*) cp '${path.join(dir, "resolved.yaml")}' pnpm-lock.yaml; printf '#!/bin/sh\\necho replaced >> ${log}\\n' > "$0" ;; esac\nexit 0\n`, { mode: 0o755 });
    const digests = { [pnpmTarget()]: sha256(fs.readFileSync(file)) };
    const checks = [];
    const installer = () => {
      checks.push(sha256(fs.readFileSync(file)) === digests[pnpmTarget()] ? "pinned" : "swapped");
      return verifiedPnpm({ file, digests, rootOwned: false });
    };
    const env = { PATH: "/usr/bin:/bin", T3BLACKOUT_SHIM_DIR: path.join(dir, "shims"), T3BLACKOUT_STAGE_ROOT: dir, T3BLACKOUT_VERIFIED_LOCK: path.join(dir, "verified.yaml"), T3BLACKOUT_STAGE_RECORD: path.join(dir, "record.jsonl") };
    await assert.rejects(guardedInstall(app, env, { installer }), /isn't the pinned pnpm 12\.14\.0/);
    assert.deepEqual(checks, ["pinned", "pinned", "swapped"], "checked first, before the resolution, and before the install");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["install --prod --lockfile-only --ignore-scripts"], "the swapped binary never ran");
    assert.equal(fs.existsSync(path.join(dir, "record.jsonl")), false, "nothing recorded as checked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the build account's pnpm must be root's, and only root's to change, all the way up", () => {
  assert.equal(rootOwnedProblem("/usr/bin/true"), null, "a system file: root's, as is every directory above it");
  const dir = scratch();
  try {
    const log = path.join(dir, "calls.log");
    const fake = fakePnpm(dir, log);
    assert.match(rootOwnedProblem(fake.file), /isn't root's \(owner uid \d+\)/);
    // The digest alone isn't enough for the build account: a copy it can write is refused.
    assert.equal(verifiedPnpm({ file: fake.file, digests: fake.digests, rootOwned: false }), fake.file);
    assert.throws(() => verifiedPnpm({ file: fake.file, digests: fake.digests, rootOwned: true }), /the build account's pnpm must be root's and only root's to change .* rerun \.\/install\.sh/);
    // Each directory on the way up counts (stand-in stats: path → uid, mode, kind).
    // (No ACLs and no write access for this account, the other two checks, are tested below.)
    const fakeStat = (table) => ({
      lstat: (at) => {
        const entry = table[at] ?? { uid: 0, mode: 0o40755 };
        return { uid: entry.uid, mode: entry.mode, isSymbolicLink: () => entry.link === true };
      },
      acl: () => null,
      writable: () => false,
    });
    const binary = path.join(ROOT_PNPM_PREFIX, "lib", "node_modules", "pnpm", "pnpm");
    const grandparent = path.dirname(path.dirname(BUILD_TOOLS_ROOT));
    assert.equal(rootOwnedProblem(binary, fakeStat({ [binary]: { uid: 0, mode: 0o100755 } })), null);
    assert.match(rootOwnedProblem(binary, fakeStat({ [grandparent]: { uid: 0, mode: 0o40775 } })), new RegExp(`^${grandparent} is writable by more than root \\(mode 775\\)`));
    assert.match(rootOwnedProblem(binary, fakeStat({ [ROOT_PNPM_PREFIX]: { uid: 501, mode: 0o40755 } })), /pnpm isn't root's \(owner uid 501\)/);
    assert.match(rootOwnedProblem(binary, fakeStat({ [path.dirname(BUILD_TOOLS_ROOT)]: { uid: 0, mode: 0o120755, link: true } })), /t3blackout is a symlink/);
    assert.match(rootOwnedProblem(binary, fakeStat({ [binary]: { uid: 0, mode: 0o100757 } })), /writable by more than root \(mode 757\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an access control list granting more than root, or write access for this account, anywhere up the way, is refused", { skip: process.platform !== "darwin" && "macOS ACLs" }, () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "file");
    fs.writeFileSync(file, "x");
    assert.equal(aclProblem(file), null);
    spawnSync("/bin/chmod", ["+a", "group:everyone allow write", file]);
    fs.chmodSync(file, 0o555);
    assert.match(aclProblem(file), /has an access control list that allows more than root \(group:everyone allow write\)/, "chmod keeps the grant; the check doesn't");
    spawnSync("/bin/chmod", ["+a", `user:${os.userInfo().username} deny delete`, dir]);
    assert.equal(aclProblem(dir), null, "a deny entry takes nothing away from root's exclusive control");
    // rootOwnedProblem runs both, on every directory up the way.
    const allRoot = (at) => ({ uid: 0, mode: 0o40755, isSymbolicLink: () => false });
    const tool = "/x/tools/pnpm";
    assert.equal(rootOwnedProblem(tool, { lstat: allRoot, acl: () => null, writable: () => false }), null);
    assert.match(rootOwnedProblem(tool, { lstat: allRoot, acl: (at) => (at === "/x" ? "has an access control list that allows more than root (0: user:_t3blackout allow add_subdirectory,delete_child)" : null), writable: () => false }), /^\/x has an access control list/);
    assert.match(rootOwnedProblem(tool, { lstat: allRoot, acl: () => null, writable: (at) => at === "/x/tools" }), /^\/x\/tools is writable by /);
    assert.throws(() => verifiedPnpm({ file: tool, rootOwned: true, lstat: allRoot, acl: () => "has an access control list that allows more than root (0: group:everyone allow write)", writable: () => false }), /must be root's and only root's to change \(\/x\/tools\/pnpm: \/x\/tools\/pnpm has an access control list/);
  } finally {
    spawnSync("/bin/chmod", ["-R", "-N", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tools the running account can't get to are refused with what to do, not a stack trace", () => {
  const dir = scratch();
  try {
    const fake = fakePnpm(dir, path.join(dir, "calls.log"));
    fs.chmodSync(fake.file, 0o600);
    assert.throws(() => verifiedPnpm({ file: fake.file, digests: fake.digests, rootOwned: false }), /can't read and run .*; rerun \.\/install\.sh/);
    fs.chmodSync(fake.file, 0o755);
    const home = path.join(dir, "vite-plus");
    seedVitePlusHome(home, fake.file);
    const opts = { target: pnpmTarget(), digests: fake.digests, rootOwned: false };
    checkVitePlusHome(home, opts);
    // A directory it can't get into (as the umask 077 install made them): named, before anything is read through it.
    fs.chmodSync(path.join(home, "package_manager", "pnpm"), 0o700 & ~0o100);
    assert.throws(() => checkVitePlusHome(home, opts), /can't use package_manager\/pnpm \(mode 600\); rerun \.\/install\.sh/);
    fs.chmodSync(path.join(home, "package_manager", "pnpm"), 0o755);
    fs.chmodSync(path.join(home, "package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin", "pnpx"), 0o644);
    assert.throws(() => checkVitePlusHome(home, opts), /can't use package_manager\/pnpm\/12\.14\.0\/pnpm\/bin\/pnpx \(mode 644\)/);
  } finally {
    spawnSync("/bin/chmod", ["-R", "u+rwx", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Vite+ home is exactly what T3 Blackout gave it: entries, kinds, launchers, binary and, for the build account, owner", () => {
  const dir = scratch();
  try {
    const fake = fakePnpm(dir, path.join(dir, "calls.log"));
    const opts = { target: pnpmTarget(), digests: fake.digests, rootOwned: false };
    const home = path.join(dir, "vite-plus");
    const bin = path.join(home, "package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin");
    const fresh = () => seedVitePlusHome(home, fake.file);
    fresh();
    assert.equal(fs.readFileSync(path.join(bin, "pnpm"), "utf8"), VITE_PLUS_LAUNCHERS.pnpm);
    assert.equal(fs.readFileSync(path.join(bin, "pnpx"), "utf8"), VITE_PLUS_LAUNCHERS.pnpx);
    checkVitePlusHome(home, opts);
    // A launcher replaced, the binary left alone.
    fs.writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\necho replaced\n");
    assert.throws(() => checkVitePlusHome(home, opts), /pnpm isn't Vite\+'s launcher as T3 Blackout writes it/);
    // A launcher made a symlink (to the binary, even), a lock gone, a directory swapped for a file.
    fresh();
    fs.rmSync(path.join(bin, "pnpx"));
    fs.symlinkSync("pnpm.native", path.join(bin, "pnpx"));
    assert.throws(() => checkVitePlusHome(home, opts), /pnpx isn't a regular file/);
    fresh();
    fs.rmSync(path.join(home, "package_manager", "pnpm", `${PNPM_VERSION}.lock`));
    assert.throws(() => checkVitePlusHome(home, opts), /missing: package_manager\/pnpm\/12\.14\.0\.lock/);
    // For the build account, every entry and every directory above must be root's.
    fresh();
    assert.throws(() => checkVitePlusHome(home, { ...opts, rootOwned: true }), /isn't root's \(owner uid \d+\)/);
    const rootStat = (at) => {
      const real = fs.lstatSync(at);
      return { uid: 0, mode: real.mode & ~0o022, isSymbolicLink: () => real.isSymbolicLink(), isDirectory: () => real.isDirectory(), isFile: () => real.isFile() };
    };
    checkVitePlusHome(home, { ...opts, rootOwned: true, lstat: rootStat, writable: () => false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Vite+ launchers run the pnpm beside them, whatever dirname the build's PATH has", () => {
  const dir = scratch();
  try {
    const bin = path.join(dir, "bin");
    const evil = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(bin, "pnpm.native"), "#!/bin/sh\necho pinned \"$@\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(evil, "pnpm.native"), "#!/bin/sh\necho replaced\n", { mode: 0o755 });
    // A planted dirname: another directory, for the launcher only.
    fs.writeFileSync(path.join(evil, "dirname"), `#!/bin/sh\necho ${evil}\n`, { mode: 0o755 });
    const run = (name, text) => {
      fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
      return spawnSync(path.join(bin, name), ["--version"], { encoding: "utf8", env: { PATH: `${evil}:/usr/bin:/bin` } }).stdout.trim();
    };
    assert.equal(run("pnpm", VITE_PLUS_LAUNCHERS.pnpm), "pinned --version");
    assert.equal(run("pnpx", VITE_PLUS_LAUNCHERS.pnpx), "pinned dlx --version");
    // What the launchers used to say ran the planted one: the probe is real.
    assert.equal(run("old", '#!/bin/sh\nexec "$(dirname "$0")/pnpm.native" "$@"\n'), "replaced");
    for (const text of Object.values(VITE_PLUS_LAUNCHERS)) assert.doesNotMatch(text, /\$\(|`|dirname/, "nothing from PATH");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upstream's Vite+ runs the pinned pnpm from a home the build seeds, and may fetch nothing into it", () => {
  const dir = scratch();
  try {
    const log = path.join(dir, "calls.log");
    const fake = fakePnpm(dir, log);
    const opts = { target: pnpmTarget(), digests: fake.digests, rootOwned: false };
    const home = path.join(dir, "vite-plus");
    fs.mkdirSync(path.join(home, "left-over"), { recursive: true });
    assert.deepEqual(seedVitePlusHome(home, fake.file), { VP_HOME: home });
    // Where Vite+ keeps a pnpm it downloaded, with its launchers; nothing left from before.
    const bin = path.join(home, "package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin");
    assert.equal(fs.readFileSync(path.join(bin, "pnpm.native"), "utf8"), fs.readFileSync(fake.file, "utf8"));
    assert.match(fs.readFileSync(path.join(bin, "pnpm"), "utf8"), /exec "\$\{0%\/\*\}\/pnpm\.native" "\$@"/);
    assert.match(fs.readFileSync(path.join(bin, "pnpx"), "utf8"), /pnpm\.native" dlx "\$@"/);
    assert.equal(fs.existsSync(path.join(home, "left-over")), false);
    checkVitePlusHome(home, opts);
    // Another manager, version or runtime fetched into it: the build stops.
    for (const extra of [["package_manager", "pnpm", "12.16.1"], ["package_manager", "npm"], ["node"]]) {
      seedVitePlusHome(home, fake.file);
      fs.mkdirSync(path.join(home, ...extra), { recursive: true });
      assert.throws(() => checkVitePlusHome(home, opts), /upstream's Vite\+ home isn't what T3 Blackout gave it \(fetched or added: /, extra.join("/"));
    }
    // Its binary swapped: the build stops too.
    seedVitePlusHome(home, fake.file);
    fs.appendFileSync(path.join(bin, "pnpm.native"), "# changed\n");
    assert.throws(() => checkVitePlusHome(home, opts), /isn't the pinned pnpm 12\.14\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every build checks Vite+'s home before the install and after packaging; one as you seeds it first", () => {
  const build = read("lib/build.mjs");
  assert.match(build, /VP_HOME: VITE_PLUS_HOME,/, "the build's environment names it");
  assert.match(build, /const VITE_PLUS_HOME = vitePlusHome\(\{ data: path\.dirname\(WORK\) \}\);/, "root's for the build account (lib/pnpm.mjs vitePlusHome)");
  const body = build.slice(build.indexOf("export async function buildArtifact("));
  const at = (text) => body.indexOf(text);
  const install = at("await installDependencies(opts, sha);");
  assert.ok(at("if (!runsAsBuilder()) seedVitePlusHome(VITE_PLUS_HOME);\n    checkVitePlusHome(VITE_PLUS_HOME);") !== -1, "seeded only for a build as you, checked either way");
  assert.ok(at("checkVitePlusHome(VITE_PLUS_HOME);") < install, "before the install");
  const after = body.indexOf("checkVitePlusHome(VITE_PLUS_HOME);", install);
  assert.ok(after > at("await packageApp(") && after < at("scanDist();"), "and after packaging, before the scans");
  assert.match(read("ci/stripped-tests.mjs"), /Object\.assign\(env, seedVitePlusHome\(/);
});

test("CI installs the pinned pnpm through install.sh, never Corepack", () => {
  for (const name of ["../../.github/workflows/evaluate.yml", "../../.github/workflows/build.yml"]) {
    const text = read(name);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ""), /corepack/, name);
    const workflow = parseYaml(text, { blockScalars: true })[0];
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const pinned = steps.find((step) => step.name === "Pinned pnpm");
    assert.ok(pinned, `${name} has the pinned pnpm step`);
    assert.match(pinned.run, /bash -c 'source \.\/install\.sh && install_pnpm "\$HOME\/\.local"'/);
    assert.match(pinned.run, /echo "\$HOME\/\.local\/bin" >> "\$GITHUB_PATH"/);
  }
});

const REAL = process.env.T3BLACKOUT_REAL_PNPM;

test("real pnpm: the pinned binary verifies, and with the build's settings a project asking for another pnpm still runs it", { skip: !REAL && "set T3BLACKOUT_REAL_PNPM to the pinned pnpm (<prefix>/lib/node_modules/pnpm/pnpm)" }, () => {
  const file = verifiedPnpm({ file: REAL });
  const root = scratch();
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), manifest({ packageManager: "pnpm@12.16.1", devEngines: { packageManager: { name: "pnpm", version: "12.16.1", onFail: "download" } } }));
    for (const settings of [PNPM_ENV, { pnpm_config_manage_package_manager_versions: "false" }, { pnpm_config_pm_on_fail: "ignore" }]) {
      const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root, ...settings };
      const result = spawnSync(file, ["--version"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), PNPM_VERSION, JSON.stringify(settings));
    }
    // It didn't fetch 12.16.1 to run instead (pnpm keeps those under its home).
    assert.deepEqual(fs.readdirSync(home, { recursive: true }).filter((entry) => String(entry).includes("package-manager-store")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("online: PNPM_BINARY_SHA256 is what the pinned tarballs carry", { skip: process.env.T3BLACKOUT_PNPM_DIGESTS_ONLINE !== "1" && "set T3BLACKOUT_PNPM_DIGESTS_ONLINE=1 (downloads four pnpm tarballs)" }, () => {
  const result = spawnSync(process.execPath, [new URL("../lib/pnpm.mjs", import.meta.url).pathname, "digests"], { encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), PNPM_BINARY_SHA256);
});

