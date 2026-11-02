// Shared by test/trust-*.test.mjs: throwaway upstream, origin and clone
// repositories with throwaway SSH keys, for self-update and a fresh clone's check
// (lib/selfupdate.mjs), and a mocked npm. Nothing here touches this clone or ~/.ssh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import { inspect } from "node:util";
import assert from "node:assert/strict";

// The tests' git must not pick up this machine's signing program, hooks or log settings.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { oracle } = await import("./trust-oracle.mjs");
const { BOT_PRINCIPAL } = oracle;
const active = await import("../lib/selfupdate.mjs");
const { selfUpdate } = active;
const { RECORD, verifiedHere, checkTip, verifyHead: verifyHeadTs } = await import("../../../src/trust/check.ts");
const { localGit } = await import("../../../src/trust/git.ts");
const { t3Gates } = await import("../lib/trust-gates.mjs");

export const DAY = 86_400_000;
export const scratch = [];
after(() => scratch.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
export const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
export const NIGHTLY = (build) => `v0.1.6-nightly.20261030.${build}`;

export function run(cwd, args, opts = {}) {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", ...opts });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A one-package pnpm lockfile per release: `deps` (name@version -> integrity), as importer dependencies. */
export function lockfileOf(deps) {
  const entries = Object.entries(deps);
  const name = (pkg) => pkg.slice(0, pkg.lastIndexOf("@"));
  const version = (pkg) => pkg.slice(pkg.lastIndexOf("@") + 1);
  const quote = (key) => (key.startsWith("@") ? `'${key}'` : key);
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...entries.flatMap(([pkg]) => [`      ${quote(name(pkg))}:`, `        specifier: ${version(pkg)}`, `        version: ${version(pkg)}`]),
    "packages:",
    ...entries.flatMap(([pkg, resolution]) => [`  ${quote(pkg)}:`, `    resolution: ${typeof resolution === "string" ? `{integrity: ${resolution}}` : JSON.stringify(resolution)}`]),
    "snapshots:",
    ...entries.map(([pkg]) => `  ${quote(pkg)}: {}`),
    "",
  ].join("\n");
}

export const OLD_DEPS = { "trust-su-dep@1.0.0": "sha512-b2xk" };

/** Upstream with three nightly tags (the middle one annotated), a branch that only looks like a tag, an owner and an evaluator key, origin, and a clone of it. `locks[n]`: release n's dependencies. */
export function fixture({ knownHosts = "", knownTools = "", locks = [OLD_DEPS, OLD_DEPS, OLD_DEPS] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-"));
  scratch.push(dir);
  const key = (name) => {
    const file = path.join(dir, name);
    assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]).status, 0);
    return { file, pub: fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
  };
  const owner = key("owner");
  const bot = key("bot");
  const stranger = key("stranger");

  const upstream = path.join(dir, "upstream");
  run(dir, ["init", "-q", "-b", "main", upstream]);
  const shas = [];
  // What each release pins in apps/server/src/device/deviceToolVersions.json.
  const tools = [
    { "trust-su-tool": "1.0.0" },
    { "trust-su-tool": "1.1.0", "trust-su-deps": "1.1.0", "trust-su-host": "1.1.0", "trust-su-net": "1.1.0", "trust-su-new": "2.0.0" },
    { "trust-su-tool": "1.1.0" },
  ];
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(upstream, "file"), `${n}\n`);
    fs.mkdirSync(path.join(upstream, "apps/server/src/device"), { recursive: true });
    fs.writeFileSync(path.join(upstream, "apps/server/src/device/deviceToolVersions.json"), JSON.stringify(tools[n - 1]));
    fs.writeFileSync(path.join(upstream, "pnpm-lock.yaml"), lockfileOf(locks[n - 1]));
    run(upstream, ["add", "-A"]);
    run(upstream, ["commit", "-q", "--no-gpg-sign", "-m", `upstream ${n}`]);
    shas.push(run(upstream, ["rev-parse", "HEAD"]));
  }
  run(upstream, ["tag", NIGHTLY(3904), shas[0]]);
  run(upstream, ["tag", "-a", "-m", "release", NIGHTLY(3917), shas[1]]);
  run(upstream, ["tag", NIGHTLY(3940), shas[2]]);
  run(upstream, ["update-ref", `refs/heads/refs/tags/${NIGHTLY(3999)}`, shas[2]]);

  const origin = path.join(dir, "origin");
  run(dir, ["init", "-q", "-b", "main", origin]);
  const commit = (signer, files, message) => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(origin, name)), { recursive: true });
      fs.writeFileSync(path.join(origin, name), content);
    }
    run(origin, ["add", "-A"]);
    const sign = signer ? ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${signer.file}`, "commit", "-q", "-S"] : ["commit", "-q", "--no-gpg-sign"];
    run(origin, [...sign, "-m", message]);
    return run(origin, ["rev-parse", "HEAD"]);
  };
  commit(
    owner,
    {
      ".allowed_signers": `owner@example.com namespaces="git" ${owner.pub}\n${BOT_PRINCIPAL} namespaces="git" ${bot.pub}\n`,
      "pin.json": pin(NIGHTLY(3904), shas[0]),
      "lib/known-device-tools.txt": `# read by hand\n${knownTools}\n`,
      "lib/known-hosts.txt": `${knownHosts}\n`,
      "README.md": "fixture\n",
    },
    "root",
  );
  const clone = path.join(dir, "clone");
  run(dir, ["clone", "-q", origin, clone]);
  const logs = [];
  // The dependency-closure review runs npm; lib/device-tools.mjs's own tests cover it, so it passes here unless a test says otherwise.
  // Self-update fetches only from GitHub unless told where (`remote`): here, the local origin.
  // The registry's clock agrees with the test's `now` unless a test says otherwise (lib/selfupdate.mjs clockProblem).
  // Both run the old verifier and the new one (src/trust) on the same clone, and fail on any difference (bothUpdate, bothVerify).
  const update = (opts = {}) => bothUpdate({ repo: clone, remote: origin, upstream, report: (line) => logs.push(line), reviewClosure: passClosure, clock: async () => opts.now ?? Date.now(), ...opts });
  /** verifyHead on `repo`, as bin/t3's update runs it, with no advisories open. */
  const verify = (repo, opts = {}) => bothVerify({ repo, upstream, report: (line) => logs.push(line), reviewClosure: passClosure, advisories: async () => [], clock: async () => opts.now ?? Date.now(), ...opts });
  /** A new clone of origin as it is now (what install.sh's first build builds); `args` such as --depth go to git clone. */
  const fresh = (name = "fresh", args = []) => {
    const target = path.join(dir, name);
    run(dir, ["clone", "-q", ...args, args.length ? `file://${origin}` : origin, target]);
    return target;
  };
  /** A merge of `parents` (first parent first) with `tree`, signed by `who`, made origin's main. */
  const merge = (parents, tree, who = owner) => {
    const sha = run(origin, ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${who.file}`, "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-S", "-m", "merge"]);
    run(origin, ["reset", "-q", "--hard", sha]);
    return sha;
  };
  return { dir, upstream, origin, clone, shas, owner, bot, stranger, commit, update, verify, fresh, merge, logs, head: () => run(clone, ["rev-parse", "HEAD"]) };
}

const passClosure = async (pin) => ({ ok: true, pin, reasons: [], notes: [] });

// ------------------------------------------------- old and new verifiers --
// verifyBoth defaults to the byte-frozen scripts/oracles/selfupdate.mjs for
// historical differential coverage. bothVerify and bothUpdate use the active
// updater, keeping its existing coverage too. Each comparison requires the same
// verdict, message, notes and record. The selected older
// verifier runs first, against the test's mocks; the new one then gets replays
// of exactly what the old one was answered (npm, the advisory sources, the
// registry's clock, the closure review), so a test sees each call once, and a
// call only the new verifier makes, or one it doesn't, is a disagreement.

/** What a promise came to: { value } or { threw: its message }. */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ threw: String(error?.message ?? error) }));

/** The file `repo` records its verified HEAD in, and what it holds (null when absent). */
const recordFile = (repo, record = RECORD) => path.resolve(run(repo, ["rev-parse", "--path-format=absolute", "--git-path", record]));
const readRecord = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const putRecord = (file, text) => (text === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, text, { mode: 0o600 }));

const REPLAYED = ["advisories", "reviewClosure", "isKnownHost", "clock"];

/** A fresh Response with `response`'s status and headers and body `bytes`. */
const copyOf = ({ bytes, response }) => new Response([101, 204, 205, 304].includes(response.status) || !bytes.length ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });

/**
 * A tape of the calls the old verifier makes to the functions in `options` and
 * to fetch: `record(run)` runs it with recording versions, `replay(run)` with
 * versions answering from the tape; `unplayed()` lists the calls the replay never made.
 */
function tape(options) {
  const calls = [];
  const show = (name, args) => `${name}(${args.map((arg) => inspect(arg, { depth: Infinity, breakLength: Infinity, sorted: true })).join(", ")})`;
  const recording = (name, fn) => (...args) => {
    const entry = { name, shown: show(name, name === "fetch" ? [String(args[0])] : args), used: false };
    calls.push(entry);
    entry.result = fn(...args);
    // A response is read once and served as a copy to each verifier: a clone's body would keep the
    // other's cancel() waiting for ever (a tee is cancelled only once both of its branches are).
    if (name === "fetch") entry.result = entry.result.then(async (response) => ((entry.copy = { bytes: Buffer.from(await response.arrayBuffer()), response }), copyOf(entry.copy)));
    return entry.result;
  };
  const replaying = (name) => (...args) => {
    const key = name === "fetch" ? [String(args[0])] : args;
    // By what the arguments show: callbacks among them (a waiver, a host check) are each run's own closures.
    const shown = show(name, key);
    const entry = calls.find((call) => !call.used && call.shown === shown);
    if (!entry) throw new Error(`only the new verifier calls ${shown}`);
    entry.used = true;
    return name === "fetch" ? entry.result.then(() => copyOf(entry.copy)) : entry.result;
  };
  const using = async (wrap, body) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = wrap("fetch", fetch);
    try {
      return await body(Object.fromEntries(REPLAYED.filter((name) => typeof options[name] === "function").map((name) => [name, wrap(name, options[name])])));
    } finally {
      globalThis.fetch = fetch;
    }
  };
  return {
    record: (body) => using(recording, body),
    replay: (body) => using((name) => replaying(name), body),
    // Not fetches: the gates' code is shared, and its npm cache answers the second verifier from the first one's.
    unplayed: () => calls.filter((call) => !call.used && call.name !== "fetch").map((call) => call.shown),
  };
}

/** The new verifier's gates, from verifyHead's options (src/trust/check.ts PinGates by lib/trust-gates.mjs). */
const gatesOf = (options, now, report) => t3Gates({ ...options, now, report });

/**
 * verifyHead by the old verifier, then (from the same record) by the new one:
 * { old, new }, each { value } or { threw }, with the record it left, the notes
 * it reported and (the new one) the outside calls it didn't make. The record is
 * left as the old verifier left it.
 */
export async function verifyBoth({ verifier = oracle, repo, report = () => {}, now = Date.now(), ...options }) {
  // Frozen differential cases intentionally give TS a legacy-named TEST record.
  // Production adapters always use the new default, tested separately.
  const record = verifier === oracle ? "t3blackout-verified" : RECORD;
  const file = recordFile(repo, record);
  const before = readRecord(file);
  const heard = { new: [], old: [] };
  const calls = tape(options);
  const old = await calls.record((recorded) => settle(verifier.verifyHead({ repo, now, ...options, ...recorded, report: (line) => (heard.old.push(line), report(line)) })));
  const left = readRecord(file);
  putRecord(file, before);
  const fresh = await calls.replay((replayed) => settle(verifyHeadTs({ repo, now, record, gates: gatesOf({ ...options, ...replayed }, now, (line) => heard.new.push(line)) })));
  const theirs = { ...fresh, record: readRecord(file), reports: heard.new, unplayed: calls.unplayed() };
  putRecord(file, left);
  return { old: { ...old, record: left, reports: heard.old, unplayed: [] }, new: theirs };
}

/** Active updater versus TS, failing on any difference; historical oracle comparisons use verifyBoth directly. */
export async function bothVerify(options) {
  const both = await verifyBoth({ ...options, verifier: active });
  assert.deepEqual(both.new, both.old, `the new verifier disagrees with the old one on ${options.repo}`);
  if ("threw" in both.old) throw new Error(both.old.threw);
  return both.old.value;
}

/** Messages self-update logs before it gets to the check the verifiers share (lib/selfupdate.mjs selfUpdate). */
const BEFORE_CHECK = /^self-update (?:skipped: (?:not on main|uncommitted changes|couldn't fetch \()|refused: origin\/main \(\w+\) isn't a fast-forward)/;

/**
 * Hourly self-update by the old verifier; when it got as far as the shared check
 * (checkTip, from the HEAD it had to the tip it fetched: `remote`'s main), the
 * new verifier's checkTip must reach the same verdict, with the same notes and
 * outside calls.
 */
export async function bothUpdate({ repo, report = () => {}, now = Date.now(), ...options }) {
  const rev = (at, name) => spawnSync("git", ["-C", at, "rev-parse", "--verify", "--quiet", `${name}^{commit}`], { encoding: "utf8" }).stdout.trim() || null;
  const head = rev(repo, "HEAD");
  const start = verifiedHere(localGit(repo), RECORD, now);
  const tip = options.remote ? rev(options.remote, "main") : null;
  const heard = [];
  const calls = tape(options);
  const result = await calls.record((recorded) => selfUpdate({ repo, now, ...options, ...recorded, report: (line) => (heard.push(line), report(line)) }));
  const last = heard.at(-1) ?? "";
  const checked = result === "updated" ? { result: "verified" } : /^self-update (refused|held|skipped): /.test(last) && !BEFORE_CHECK.test(last) ? { result: last.split(" ")[1].slice(0, -1), message: last.slice(last.indexOf(": ") + 2) } : null;
  if (checked && tip) {
    const notes = [];
    const fresh = await calls.replay((replayed) => checkTip(localGit(repo), { tip, start, gates: gatesOf({ ...options, ...replayed }, now, (line) => notes.push(line)) }));
    const verdict = fresh.result === "verified" ? { result: "verified" } : fresh;
    assert.deepEqual({ ...verdict, reports: notes, unplayed: calls.unplayed() }, { ...checked, reports: heard.slice(0, -1), unplayed: [] }, `the new verifier's check disagrees with self-update's on ${repo}`);
  }
  return result;
}

/** The commit recorded as verified in `repo` (the record is "<sha> <when>"), or null. */
export function recorded(repo) {
  try {
    return fs.readFileSync(path.join(repo, ".git", RECORD), "utf8").split(" ")[0];
  } catch {
    return null;
  }
}

/** npm metadata (no tarballs) for { name: { version: { publishedAt, integrity, user, repository } } }, as fetch handlers by URL. */
export function npmRoutes(packages) {
  const routes = {};
  for (const [name, versions] of Object.entries(packages)) {
    const meta = { versions: {}, time: {} };
    for (const [version, { publishedAt, integrity, user = "maintainer", repository = "github:example/dep" }] of Object.entries(versions)) {
      meta.versions[version] = { name, version, _npmUser: { name: user }, repository, dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } };
      meta.time[version] = publishedAt;
    }
    routes[`https://registry.npmjs.org/${name}`] = () => new Response(JSON.stringify(meta), { status: 200 });
  }
  return routes;
}

export const YOUNG = "sha512-eW91bmc=";

/** A fixture whose 3917 release adds `name`@1.0.0 (integrity YOUNG), and an evaluator commit pinning it; `routes` has npm publish it an hour before `now`. */
export function youngPin(name, now = Date.now()) {
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, [`${name}@1.0.0`]: YOUNG }, OLD_DEPS] });
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  return Object.assign(f, { routes: npmRoutes({ [name]: { "1.0.0": { publishedAt: new Date(now - 3_600_000).toISOString(), integrity: YOUNG } } }) });
}

/** pin.json naming `ref` at `sha`; each tool in `locked` gets a frozen dependency lock (lib/device-tools.mjs). */
export function pin(ref, sha, deviceTools = ["trust-su-tool@1.0.0"], locked = deviceTools.filter((tool) => tool !== "trust-su-tool@1.0.0")) {
  const lockOf = (tool) => {
    const lock = `${JSON.stringify({ name: "t3blackout-device-tool", lockfileVersion: 3, packages: { [`node_modules/${tool.slice(0, tool.lastIndexOf("@"))}`]: {} } })}\n`;
    return { sha256: createHash("sha256").update(lock).digest("hex"), lock };
  };
  const locks = locked.length ? { deviceToolLocks: Object.fromEntries(locked.map((tool) => [tool, lockOf(tool)])) } : {};
  return `${JSON.stringify({ version: 1, channels: { nightly: { ref, sha, evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } }, deviceTools, ...locks }, null, 2)}\n`;
}

/** Writes a commit object carrying `signature` as its gpgsig header straight onto origin's main. */
export function forgeSigned(f, armor) {
  const parent = run(f.origin, ["rev-parse", "HEAD"]);
  const tree = run(f.origin, ["rev-parse", "HEAD^{tree}"]);
  const body = [`tree ${tree}`, `parent ${parent}`, "author t <t@example.com> 1761800000 +0000", "committer t <t@example.com> 1761800000 +0000", `gpgsig -----BEGIN ${armor}-----`, " ", " AAAA", ` -----END ${armor}-----`, "", "forged", ""].join("\n");
  const sha = run(f.origin, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: body });
  run(f.origin, ["update-ref", "refs/heads/main", sha]);
  return sha;
}

/** npm serving `name` with versions { version: { files, publishedAt } }; returns fetch handlers by URL. */
export function npm(name, versions) {
  const routes = {};
  const meta = { versions: {}, time: {} };
  for (const [version, { files, publishedAt }] of Object.entries(versions)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-tgz-"));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(tmp, "package"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "package", file), content);
    }
    assert.equal(spawnSync("tar", ["-czf", path.join(tmp, "p.tgz"), "-C", tmp, "package"]).status, 0);
    const bytes = fs.readFileSync(path.join(tmp, "p.tgz"));
    fs.rmSync(tmp, { recursive: true, force: true });
    const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    routes[url] = () => new Response(bytes, { status: 200 });
    meta.versions[version] = { dist: { tarball: url, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
    meta.time[version] = publishedAt;
  }
  routes[`https://registry.npmjs.org/${name}`] = () => new Response(JSON.stringify(meta), { status: 200 });
  return routes;
}

export function mockFetch(routes, onCall = () => {}) {
  globalThis.fetch = async (url) => {
    onCall(String(url));
    const handler = routes[String(url)];
    return handler ? handler() : new Response("not found", { status: 404 });
  };
}

