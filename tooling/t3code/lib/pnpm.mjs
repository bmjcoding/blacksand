// The pnpm a build runs: the one pinned here, and nothing else. install.sh
// installs PNPM_VERSION for builds from the registry tarballs this file pins by
// digest (`node lib/pnpm-cli.mjs fetch`). Every pnpm the build runs (the lockfile re-resolution, the installs,
// the staged install's guard and its pnpm shim, CI's stripped tests) is that
// file, by absolute path, its bytes checked against the binary those tarballs
// carry each time it's about to run (verifiedPnpm): never a `pnpm` found on
// PATH, where upstream's node_modules/.bin, Corepack (which takes its version,
// registry and keys from the checkout) or a version manager such as Vite+ could
// answer instead. The build account, which runs upstream's install scripts and
// build, gets it from a tools directory only root can change (BUILD_TOOLS_ROOT);
// so does the Vite+ home upstream's build runs pnpm from.
//
// pnpm itself would also switch to the version upstream's package.json names
// (packageManager, or devEngines.packageManager), downloaded and checked against
// nothing; upstream's pnpm-workspace.yaml or .npmrc can't turn that off, only
// the environment can (PNPM_ENV). A release that asks for another pnpm stops
// the build, so the pin is raised deliberately, never by upstream.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { tryFlock } from "./lock.mjs";
import { BUILDER_USER, IS_BUILDER } from "./util.mjs";

/**
 * The pinned pnpm, outside any package manager's age gate: raise it deliberately,
 * and only to a release at least 3 days old. PNPM_VERSION matches upstream's
 * packageManager; PNPM_TARBALL_SHA512 pins the registry tarballs it's laid out
 * from (the wrapper package, which carries node-gyp, and each platform's native
 * build, which replaces the wrapper's placeholders, as pnpm's own install script
 * does); PNPM_BINARY_SHA256 is the native binary they carry, the only bytes a
 * build runs, checked before each run. Raising it: the version and the tarball
 * digests by hand, then `node lib/pnpm-cli.mjs digests` prints the binaries' digests,
 * from those tarballs.
 */
export const PNPM_VERSION = "12.14.0";

const PNPM_TARBALL_SHA512 = {
  wrapper: "c18ba6d87993d3d164cb5e8948f32b2c06ee854487e06cd8d86781342fb3e5bb4634367034711e86802baa9c37bea906ce1929ad08d70884c97d801df13389a6",
  "darwin-arm64": "b67add501f1e709a1e86e28aaa2d581c205597ad71b49f57546731e44be20ba7d63b80de188f06b57ae3bc9c4304cde7b958c97968acb60b14a7f375e36c78b3",
  "darwin-x64": "be505f1a4aeea9046c1074d6e3770fc2961ded095b209fff72fa4075bddb557908f128133e85e10a7734e66f993623ebac4901b17fedeca1f0f5a5e99333e6dd",
  "linux-x64": "17a2bc7bf8d6c62b84609690b514541bdca70524c41dafadecb7fce8c2ae38ee5403b59554c6e2fa807c9d8ea2296fbe9dc592db21ba4fd7da5d91b1a8db1fa1",
  "linux-arm64": "ee3a064a1678e0d9375a9354fbad09a0e3e3097960c61240ab5d52d94895b700940e04deaf5c933cf7f1196f29c5a0fad38e9a72d60b2180db64d96e6c75acd0",
};

export const PNPM_BINARY_SHA256 = {
  "darwin-arm64": "d536ab6b857027a28ad182e843a611946b96aab9194b84de24620cb9d15ca110",
  "darwin-x64": "e4728e6458c5cce82fc49feae2c087243f5d9e2f9bfc104e0d4b26c49a897d74",
  "linux-x64": "5e9119e6f4f18dace3795169e9b3672231ab3662505862dc3026571303a8ef32",
  "linux-arm64": "a41a079692ebef7415797237ae3bd20dc792447eaf1aaf758d3b6916c276783a",
};

/**
 * Turns pnpm's own version switching off: manage-package-manager-versions and,
 * pnpm 11's name for it, pm-on-fail (pnpm 12 honours both). pnpm's prefix, not
 * npm_config_: npm warns about every npm_config_ setting it doesn't know, and
 * says it will refuse them.
 */
export const PNPM_ENV = { pnpm_config_manage_package_manager_versions: "false", pnpm_config_pm_on_fail: "ignore" };

/** The name of this machine's pnpm build (@pnpm/exe.<target>), or null. */
export function pnpmTarget(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", linux: "linux" }[platform];
  const cpu = { arm64: "arm64", x64: "x64" }[arch];
  return os && cpu ? `${os}-${cpu}` : null;
}

/**
 * Where root's build tools live: on macOS outside /usr/local, which an Intel Mac's
 * Homebrew owns, in a directory every ancestor of which is root's; install.sh checks
 * that the whole way up (install_build_pnpm) and fails there, not at a build.
 */
export const buildToolsRoot = (platform = process.platform) => (platform === "darwin" ? "/Library/Application Support/blacksand/tools" : "/usr/local/libexec/blacksand/tools");
export const BUILD_TOOLS_ROOT = buildToolsRoot();
export const ROOT_PNPM_PREFIX = path.join(BUILD_TOOLS_ROOT, "pnpm");
export const ROOT_VITE_PLUS_HOME = path.join(BUILD_TOOLS_ROOT, "vite-plus");

/**
 * Whether this runs as the build account: by its user, not just the environment,
 * which the packager hands on through upstream's code to the stage guard.
 */
export const runsAsBuilder = () => IS_BUILDER || os.userInfo().username === BUILDER_USER;

/**
 * Where install.sh puts the pnpm builds run: root's, for the build account; yours
 * (--unisolated-build, CI) in <home>/.local.
 */
export const pinnedPnpmPath = ({ builder = runsAsBuilder(), home = os.homedir() } = {}) =>
  builder ? path.join(ROOT_PNPM_PREFIX, "lib", "node_modules", "pnpm", "pnpm") : path.join(home, ".local", "lib", "node_modules", "pnpm", "pnpm");

/**
 * Why `at`'s access control list could let anyone change it, or null. Unix modes
 * don't show an ACL's grants, and chmod keeps them: on macOS any `allow` entry
 * (inherited or not) counts, read with Apple's own ls (`ls -lde`, never one PATH
 * finds); elsewhere any ACL at all (the `+` after `ls -ld`'s modes), since none
 * is set there by install.sh.
 */
export function aclProblem(at, options = {}) {
  const entries = aclEntries(at, options);
  if (entries === null) return "has an access control list ls can't read";
  if ((options.platform ?? process.platform) !== "darwin") return entries.length ? "has an access control list" : null;
  const allow = entries.find((entry) => /^\S+ (?:inherited )?allow /.test(entry));
  return allow ? `has an access control list that allows more than root (${allow})` : null;
}

/** `at`'s ACL entries as Apple's ls lists them ("user:x allow read"); elsewhere ["+"] when ls -ld shows one. Null when ls can't say. */
function aclEntries(at, { platform = process.platform, run = spawnSync } = {}) {
  const listed = run("/bin/ls", platform === "darwin" ? ["-lde", "--", at] : ["-ld", "--", at], { encoding: "utf8", timeout: 10_000 });
  if (listed.status !== 0) return null;
  const [first = "", ...rest] = String(listed.stdout ?? "").split("\n");
  if (platform !== "darwin") return /^\S{10}\+/.test(first) ? ["+"] : [];
  return rest.map((line) => /^\s*\d+: (.*)$/.exec(line)?.[1]).filter(Boolean);
}

/** Whether the account running this could write `at` (its ACLs and groups included). */
const writableHere = (at) => {
  try {
    fs.accessSync(at, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Why `file` could be changed by anyone but root, or null: it and every directory
 * above it must be root's, not writable by group or others, no symlink, with no
 * access control list granting more, and not writable by the account running this
 * (the build account, before each run). For the build account's tools, which
 * upstream's code runs beside.
 */
export function rootOwnedProblem(file, { lstat = fs.lstatSync, acl = aclProblem, writable = writableHere } = {}) {
  const full = path.resolve(file);
  for (let at = full; ; at = path.dirname(at)) {
    let stat;
    try {
      stat = lstat(at);
    } catch {
      return `${at} doesn't exist`;
    }
    if (stat.isSymbolicLink()) return `${at} is a symlink`;
    if (stat.uid !== 0) return `${at} isn't root's (owner uid ${stat.uid})`;
    if (stat.mode & 0o022) return `${at} is writable by more than root (mode ${(stat.mode & 0o7777).toString(8)})`;
    const grants = acl(at);
    if (grants) return `${at} ${grants}`;
    if (writable(at)) return `${at} is writable by ${os.userInfo().username}`;
    if (at === path.dirname(at)) return null;
  }
}

const sha256File = (file) => {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; ) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
};

/**
 * The pinned pnpm, authenticated: `file` (install.sh's, by default) must be a
 * regular file, not a symlink, whose bytes are the pinned binary for this
 * platform, and for the build account (`rootOwned`) root's, out of its
 * reach. Returns its absolute path to run; throws, saying what to do, otherwise.
 * Call it right before each run, never once for several.
 */
export function verifiedPnpm({ file = pinnedPnpmPath(), target = pnpmTarget(), digests = PNPM_BINARY_SHA256, rootOwned = runsAsBuilder(), ...seams } = {}) {
  const want = digests[target];
  if (!want) throw new Error(`no pnpm is pinned for ${target ?? `${process.platform}-${process.arch}`}`);
  const reinstall = `remove ${path.dirname(file)} and rerun ./install.sh (it installs pnpm ${PNPM_VERSION} from its pinned tarballs). Nothing was installed.`;
  if (rootOwned) {
    const problem = rootOwnedProblem(file, seams);
    if (problem) throw new Error(`the build account's pnpm must be root's and only root's to change (${file}: ${problem}); rerun ./install.sh. Nothing was installed.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`pnpm ${PNPM_VERSION} isn't installed at ${file}; rerun ./install.sh. Nothing was installed.`);
  }
  if (!stat.isFile()) throw new Error(`${file} isn't the file install.sh installed (${stat.isSymbolicLink() ? "a symlink" : "not a regular file"}); ${reinstall}`);
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`${os.userInfo().username} can't read and run ${file} (a directory above it, or the file, keeps it out); rerun ./install.sh. Nothing was installed.`);
  }
  const got = sha256File(file);
  if (got !== want) throw new Error(`${file} isn't the pinned pnpm ${PNPM_VERSION} (its sha-256 is ${got}); ${reinstall}`);
  return path.resolve(file);
}

/** What to do when upstream moves to another pnpm. */
export const RAISE_PNPM =
  "Raise PNPM_VERSION and PNPM_TARBALL_SHA512 in lib/pnpm.mjs to the pnpm upstream asks for once it is at least 3 days old, then PNPM_BINARY_SHA256 (`node lib/pnpm-cli.mjs digests` prints them); rerun ./install.sh, then rerun.";

/** Each package manager `manifest` (a parsed package.json) asks for: [field, what it says, the pnpm version or null]. */
function requests(manifest) {
  const found = [];
  if (manifest.packageManager !== undefined) {
    const value = String(manifest.packageManager);
    // Corepack's form: pnpm@<version>, optionally +<hash>; pnpm switches on either.
    found.push(["packageManager", value, /^pnpm@([^+\s]+)(?:\+\S+)?$/.exec(value)?.[1] ?? null]);
  }
  const engines = manifest.devEngines?.packageManager;
  for (const entry of engines === undefined ? [] : [engines].flat()) {
    const name = entry?.name ?? "?";
    found.push(["devEngines.packageManager", `${name}@${entry?.version ?? "?"}`, name === "pnpm" && typeof entry?.version === "string" ? entry.version : null]);
  }
  return found;
}

/** Why a checkout whose root package.json reads `text` can't build with pnpm `pinned`; null when it can. */
export function pnpmPinProblem(text, pinned = PNPM_VERSION) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return "upstream's package.json isn't valid JSON";
  }
  if (!manifest || typeof manifest !== "object") return "upstream's package.json isn't an object";
  const other = requests(manifest).find(([, , version]) => version !== pinned);
  return other ? `upstream asks for ${other[1]} (${other[0]} in package.json), not pnpm ${pinned}, the one Blacksand T3 pins` : null;
}

/** pnpmPinProblem for the checkout in `dir`. */
export function pnpmPinProblemIn(dir, pinned = PNPM_VERSION) {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return "upstream has no package.json";
  return pnpmPinProblem(fs.readFileSync(file, "utf8"), pinned);
}

/**
 * Vite+'s launchers for the pnpm next to them, byte for byte. Vite+'s own call `dirname`, which they'd
 * find on the build's PATH (upstream's node_modules/.bin first): these find
 * their directory with the shell's own `${0%/*}` and run nothing from PATH.
 */
export const VITE_PLUS_LAUNCHERS = {
  pnpm: '#!/bin/sh\nexec "${0%/*}/pnpm.native" "$@"\n',
  pnpx: '#!/bin/sh\nexec "${0%/*}/pnpm.native" dlx "$@"\n',
};

const vitePlusEntries = () => {
  const bin = ["package_manager", "pnpm", PNPM_VERSION, "pnpm", "bin"];
  const dirs = bin.map((_, i) => bin.slice(0, i + 1).join("/"));
  return {
    dirs,
    files: { [`package_manager/pnpm/${PNPM_VERSION}.lock`]: "", ...Object.fromEntries(Object.entries(VITE_PLUS_LAUNCHERS).map(([name, text]) => [`${bin.join("/")}/${name}`, text])) },
    native: `${bin.join("/")}/pnpm.native`,
  };
};

/**
 * The Vite+ home (VP_HOME) the build runs upstream's Vite+ with. Upstream's build
 * runs `vp run ...` and `vp exec ...`, which bring their own pnpm: downloaded from
 * whatever registry the checkout's npm config names, put first on PATH for every
 * script they run and named in npm_execpath. Given a home that already holds
 * the pinned binary where Vite+ keeps a pnpm it downloaded, Vite+ runs that one
 * and downloads nothing. The build account's is root's, read-only to it
 * (install.sh copies one fetchPinnedPnpm made); yours (`data`, --unisolated-build,
 * CI) is made fresh for each build (seedVitePlusHome).
 */
export const vitePlusHome = ({ builder = runsAsBuilder(), data } = {}) => (builder ? ROOT_VITE_PLUS_HOME : path.join(data, "vite-plus"));

/** A fresh Vite+ home in `dir`, for a build that runs as you, holding `pnpm`'s bytes. Returns the env entry. */
export function seedVitePlusHome(dir, pnpm = verifiedPnpm()) {
  fs.rmSync(dir, { recursive: true, force: true });
  const { dirs, files, native } = vitePlusEntries();
  for (const entry of dirs) fs.mkdirSync(path.join(dir, entry), { recursive: true, mode: 0o700 });
  fs.copyFileSync(pnpm, path.join(dir, native));
  fs.chmodSync(path.join(dir, native), 0o755);
  for (const [entry, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, entry), text, { mode: text ? 0o755 : 0o644 });
  return { VP_HOME: dir };
}

/**
 * Throws unless the Vite+ home `dir` is exactly what seedVitePlusHome put there: these directories and files and nothing else (no other package
 * manager, version or runtime), no symlinks, the launchers byte for byte, the
 * binary pnpm's; for the build account (`rootOwned`) every entry, and every
 * directory above, root's and writable by root only. Run before the build's Vite+
 * commands and after them. A home you own can't prove more than its state at the
 * moment it's checked: something that changed it and put it back in between
 * leaves no trace. Root's can't be changed by the build at all.
 */
export function checkVitePlusHome(dir, { target = pnpmTarget(), digests = PNPM_BINARY_SHA256, rootOwned = runsAsBuilder(), lstat = fs.lstatSync, acl, writable } = {}) {
  const fail = (why) => {
    throw new Error(`upstream's Vite+ home isn't what Blacksand T3 gave it (${why} in ${dir}); nothing was installed`);
  };
  const { dirs, files, native } = vitePlusEntries();
  // This account must get into every directory (top down, before anything is read
  // through them) and run the launchers and the binary.
  const usable = (entry, mode) => {
    try {
      fs.accessSync(path.join(dir, entry), mode);
    } catch (error) {
      if (error.code === "ENOENT" && entry !== ".") return;
      if (error.code === "ENOENT") fail("it isn't there; rerun ./install.sh");
      fail(`${os.userInfo().username} can't use ${entry} (mode ${(lstat(path.join(dir, entry)).mode & 0o7777).toString(8)}); rerun ./install.sh`);
    }
  };
  for (const entry of [".", ...dirs]) usable(entry, fs.constants.R_OK | fs.constants.X_OK);
  const expected = [...dirs, ...Object.keys(files), native].map((entry) => entry.split("/").join(path.sep));
  const found = fs.readdirSync(dir, { recursive: true }).map(String);
  const extra = found.filter((entry) => !expected.includes(entry));
  if (extra.length) fail(`fetched or added: ${extra.slice(0, 5).join(", ")}`);
  const missing = expected.filter((entry) => !found.includes(entry));
  if (missing.length) fail(`missing: ${missing.join(", ")}`);
  if (rootOwned) {
    const seams = { lstat, ...(acl ? { acl } : {}), ...(writable ? { writable } : {}) };
    for (const entry of [".", ...expected]) {
      const problem = rootOwnedProblem(path.join(dir, entry), seams);
      if (problem) fail(problem);
    }
  }
  for (const entry of dirs) if (!lstat(path.join(dir, entry)).isDirectory()) fail(`${entry} isn't a directory`);
  for (const [entry, text] of Object.entries(files)) {
    if (!lstat(path.join(dir, entry)).isFile()) fail(`${entry} isn't a regular file`);
    if (fs.readFileSync(path.join(dir, entry), "utf8") !== text) fail(`${entry} isn't Vite+'s launcher as Blacksand T3 writes it`);
  }
  for (const [entry, text] of Object.entries(files)) usable(entry, text ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
  verifiedPnpm({ file: path.join(dir, native), target, digests, rootOwned: false });
}

/** `target`'s pinned tarball ("wrapper", or a platform's native build) unpacked into `dir`, its SHA-512 checked first. */
async function unpackTarball(target, dir, tarballs) {
  const url = target === "wrapper" ? `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz` : `https://registry.npmjs.org/@pnpm/exe.${target}/-/exe.${target}-${PNPM_VERSION}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(bytes).digest("hex") !== tarballs[target]) throw new Error(`${url} doesn't match its pinned SHA-512`);
  fs.mkdirSync(dir, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", "-", "-C", dir, "--strip-components", "1"], { input: bytes, encoding: "utf8" });
  if (untar.status !== 0) throw new Error(`couldn't unpack ${url}: ${untar.stderr.trim()}`);
}

/**
 * `node lib/pnpm-cli.mjs fetch <dir>`: the pinned pnpm for this machine, from its
 * registry tarballs (no install script runs), laid out in <dir>/pnpm as npm -g
 * lays it out under a prefix, and a Vite+ home holding the same binary in
 * <dir>/vite-plus (seedVitePlusHome). install.sh copies them where they go.
 */
export async function fetchPinnedPnpm(dir, { target = pnpmTarget(), tarballs = PNPM_TARBALL_SHA512, digests = PNPM_BINARY_SHA256 } = {}) {
  if (!tarballs[target] || !digests[target]) throw new Error(`no pnpm is pinned for ${target ?? `${process.platform}-${process.arch}`}`);
  const pkg = path.join(dir, "pnpm", "lib", "node_modules", "pnpm");
  const exe = path.join(dir, "exe");
  try {
    await unpackTarball("wrapper", pkg, tarballs);
    await unpackTarball(target, exe, tarballs);
    fs.mkdirSync(path.join(dir, "pnpm", "bin"));
    for (const name of ["pnpm", "pn", "pnpx", "pnx"]) {
      fs.copyFileSync(path.join(exe, "pnpm"), path.join(pkg, name));
      fs.chmodSync(path.join(pkg, name), 0o755);
      fs.symlinkSync(`../lib/node_modules/pnpm/${name}`, path.join(dir, "pnpm", "bin", name));
    }
  } finally {
    fs.rmSync(exe, { recursive: true, force: true });
  }
  seedVitePlusHome(path.join(dir, "vite-plus"), verifiedPnpm({ file: path.join(pkg, "pnpm"), target, digests, rootOwned: false }));
}

/** `node lib/pnpm-cli.mjs digests`: PNPM_BINARY_SHA256 for PNPM_VERSION, from the pinned tarballs. Run it when raising the pin. */
export async function printBinaryDigests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-pnpm-"));
  try {
    const out = {};
    for (const target of Object.keys(PNPM_TARBALL_SHA512).filter((key) => key !== "wrapper")) {
      await unpackTarball(target, path.join(dir, target), PNPM_TARBALL_SHA512);
      out[target] = sha256File(path.join(dir, target, "pnpm"));
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- the tools' lock --

/**
 * The lock beside root's build tools (`<tools>.lock`): ./install.sh holds it
 * exclusive from before it first checks the tools to after it checks the ones it
 * put in their place (install_build_pnpm), and a build as the build account holds
 * it shared while it uses them (lib/build.mjs buildArtifact). So no build sees the
 * tools half-replaced (a swap's two renames), none starts while they're replaced,
 * and two installs never work on them at once. It's an OS file lock (flock(2)): it
 * belongs to the open file, so it lasts while any descriptor on that open file
 * does (the installing shell's fd 8 and what it started meanwhile; a build's own
 * descriptor) and goes when they close, however their holders end.
 *
 * Anyone who can open a file can flock it, read-only included, and so hold the
 * others off for good: so only root, admins (you) and the build account may open
 * this one (toolsLockPolicy). Agent accounts, standard accounts by
 * scripts/add-agent-account.sh, can't.
 */
export const buildToolsLock = (root = BUILD_TOOLS_ROOT) => `${root}.lock`;
export const BUILD_TOOLS_LOCK = buildToolsLock();

/** macOS's admin group, gid 80 on every Mac: the admin who installs is in it; standard accounts aren't. */
const MACOS_ADMIN_GID = 80;

/**
 * What the tools' lock must be (install.sh provision_tools_lock): root's; on macOS
 * group admin, 0640, and exactly one ACL entry, letting the build account read it;
 * elsewhere (no agent accounts, as for the build account's home) group root, 0644,
 * no ACL. Nobody but root can write it.
 */
export const toolsLockPolicy = ({ platform = process.platform, builder = BUILDER_USER } = {}) =>
  platform === "darwin" ? { uid: 0, gid: MACOS_ADMIN_GID, mode: 0o640, acl: [`user:${builder} allow read`] } : { uid: 0, gid: 0, mode: 0o644, acl: [] };

/**
 * Why `file` isn't the tools' lock toolsLockPolicy describes, or null: a regular
 * file (no symlink), its owner, group, mode and ACL exactly, the directories above
 * it root's alone, and `fd`, when given, open on that very file (not one it
 * replaced). `policy`, `lstat`, `run` and `ancestors` are for tests.
 */
export function toolsLockProblem(file, { platform = process.platform, builder = BUILDER_USER, policy = toolsLockPolicy({ platform, builder }), fd = null, lstat = fs.lstatSync, run = spawnSync, ancestors = (dir) => rootOwnedProblem(dir) } = {}) {
  let stat;
  try {
    stat = lstat(file);
  } catch (error) {
    return error.code === "ENOENT" ? `${file} isn't there` : `${file} can't be read (${error.code})`;
  }
  if (stat.isSymbolicLink()) return `${file} is a symlink`;
  if (!stat.isFile()) return `${file} isn't a regular file`;
  const mode = stat.mode & 0o7777;
  if (stat.uid !== policy.uid || stat.gid !== policy.gid || mode !== policy.mode) {
    return `${file} is owner uid ${stat.uid}, group gid ${stat.gid}, mode ${mode.toString(8)}, not uid ${policy.uid}, gid ${policy.gid}, mode ${policy.mode.toString(8)}`;
  }
  const entries = aclEntries(file, { platform, run });
  if (entries === null) return `${file}'s access control list can't be read`;
  if (entries.join("\n") !== policy.acl.join("\n")) {
    return `${file}'s access control list is ${entries.length ? entries.join("; ") : "empty"}, not ${policy.acl.length ? policy.acl.join("; ") : "empty"}`;
  }
  if (fd !== null) {
    const open = fs.fstatSync(fd);
    if (open.dev !== stat.dev || open.ino !== stat.ino) return `the descriptor open on ${file} is on another file (it was replaced)`;
  }
  const above = ancestors(path.dirname(file));
  return above ? `the directories above ${file}: ${above}` : null;
}

/** How long to wait for the tools' lock: BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS, or `seconds`. */
const toolsLockWaitMs = (seconds) => 1000 * (Number(process.env.BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS) || seconds);

/**
 * Takes the tools' lock at `file`, shared (a build) or exclusive, waiting while it's
 * held the other way, up to `waitMs` (`report` hears once that it waits).
 * `rootOwned` (the build account's case): the file must be the lock
 * toolsLockPolicy describes, before it's opened and as opened (`lockProblem`, for
 * tests). Resolves to an async release().
 */
export async function lockBuildTools({ file = BUILD_TOOLS_LOCK, shared, waitMs = toolsLockWaitMs(shared ? 30 * 60 : 2 * 3600), report = () => {}, rootOwned = runsAsBuilder(), lockProblem = (at, fd) => toolsLockProblem(at, { fd }) } = {}) {
  const fail = (why) => new Error(`couldn't take the build tools' lock ${file}: ${why}`);
  if (rootOwned) {
    const problem = lockProblem(file, null);
    if (problem) throw fail(`${problem}; rerun ./install.sh`);
  }
  const deadline = Date.now() + waitMs;
  let waiting = false;
  for (;;) {
    let fd;
    try {
      fd = tryFlock(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, shared });
    } catch (error) {
      throw fail(error.code === "ENOENT" ? "it isn't there; rerun ./install.sh" : error.code === "EACCES" ? "this account can't open it; rerun ./install.sh" : error.message);
    }
    if (fd !== null) {
      const problem = !fs.fstatSync(fd).isFile() ? "it isn't a regular file" : rootOwned ? lockProblem(file, fd) : null;
      if (problem) {
        fs.closeSync(fd);
        throw fail(`${problem}; rerun ./install.sh`);
      }
      let open = true;
      return async () => {
        if (open) fs.closeSync(fd);
        open = false;
      };
    }
    const holder = shared ? "./install.sh is replacing the build tools" : "a build is using the build tools, or another ./install.sh is replacing them";
    if (Date.now() >= deadline) throw fail(`gave up after ${waitMs >= 60_000 ? `${Math.round(waitMs / 60_000)} min` : `${waitMs / 1000} s`}: ${holder} (\`lsof ${file}\` shows what holds it)`);
    if (!waiting) report(`waiting: ${holder} (${file})`);
    waiting = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** For a build: the tools' lock held shared while it uses root's tools (the build account); your own tools: nothing to hold. */
export async function holdBuildTools({ report, builder = runsAsBuilder(), ...options } = {}) {
  return builder ? lockBuildTools({ shared: true, report, rootOwned: true, ...options }) : async () => {};
}

/**
 * `node lib/pnpm-cli.mjs check-tools-lock <file> <build account> [fd]`: install.sh's
 * check of the tools' lock, and, with `fd`, that its own descriptor is on it.
 * Prints why not: status 2 when the directories above it aren't root's alone (so
 * install.sh touches nothing there), 1 for the lock itself.
 */
export function checkToolsLock(file, builder, fd) {
  const above = rootOwnedProblem(path.dirname(file));
  if (above) {
    console.error(`the directories above ${file}: ${above}`);
    return 2;
  }
  const problem = toolsLockProblem(file, { builder, fd: fd === undefined ? null : Number(fd), ancestors: () => null });
  if (problem) console.error(problem);
  return problem ? 1 : 0;
}

/** `node lib/pnpm-cli.mjs check-pnpm <file>`: install.sh's check that the pnpm at <file> is the pinned binary. Prints why not. */
export function checkPnpm(file) {
  try {
    verifiedPnpm({ file, rootOwned: false });
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

/**
 * `node lib/pnpm-cli.mjs check-build-tools <dir>`: install.sh's check of root's tools in
 * <dir> (pnpm/ and vite-plus/), staged or in place, before it hands them to the build
 * account: what the build account's check before each build requires. Prints why not.
 */
export function checkBuildTools(dir) {
  try {
    verifiedPnpm({ file: path.join(dir, "pnpm", "lib", "node_modules", "pnpm", "pnpm"), rootOwned: true });
    checkVitePlusHome(path.join(dir, "vite-plus"), { rootOwned: true });
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
