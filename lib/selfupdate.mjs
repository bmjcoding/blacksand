// Keeps each machine's copy of t3blackout current, so a rule fix pushed from one
// machine reaches the others before their next build. It only fast-forwards to
// commits each signed with SSH by a principal in .allowed_signers as its first
// parent has it (takeHistory): an incoming commit can't change who may sign it,
// so someone who gets into the GitHub account can't push code that every
// machine runs within the hour, and a key an owner commit removes signs nothing
// after it, even in the same batch. GPG and X.509 signatures are refused
// outright: git would check those against whatever keyring the machine has, not
// against the allowlist.
//
// It runs under the update lock (bin/t3blackout cmdUpdate) and reads FETCH_HEAD
// once: everything after works on that exact commit id, and the fast-forward must
// land on it, so another fetch can't swap in commits nobody verified.
//
// The evaluator's key (principal BOT_PRINCIPAL, used by .github/workflows/
// evaluate.yml) may only pin a real, newer upstream release, and this machine,
// not CI, decides whether it may have it: the evaluator's verdicts are only a
// proposal (lib/pincheck.mjs), and its key could be stolen. A commit it signed is
// accepted only if it changes pin.json and nothing else, has one parent, follows
// a pin (it can't write the first one, or a channel's first), leaves a valid pin
// of canonical release tags, rolls no channel back (pin.mjs backwardMove), and
// approves device tools or their locks only alongside a forward move. Then the
// gates for the pin the update builds are worked out again here, once, over the
// pin it rests on along the tip's first parents (checkTip, pinBasis: the one this
// clone trusts, or a later one the owner signed on that line; never one on a
// merged side branch), from upstream's git, npm and the advisory sources
// (lib/advisories.mjs):
//   - each channel it moves names the commit its tag points at upstream (git
//     ls-remote), so a stolen key can't pass off an old or unreleased commit
//     under a newer release's name;
//   - every tool it approves is one a build of the release it moves to installs
//     (its pins, raised by the device tool overrides in lib/overrides.json as
//     this clone trusts it) and, with its dependency closure, passes review
//     (gates.mjs reviewAddedDeviceTools; a young version only through the
//     tool's security fast lane, lib/device-tools.mjs toolFastLane);
//   - every dependency version the release adds over the release the pin it
//     rests on names (which this clone already trusts) is at least MIN_AGE_DAYS
//     old, keeps its bytes and has the registry's, unless the fast lane, worked out
//     from that release's own lockfile and the owner's overrides, waives it as a
//     security fix (lib/fastlane.mjs). A young one holds the update until it's old
//     enough; nothing else the update carries is taken before then either.
// The build that follows strips, typechecks, scans and smoke-tests the release
// here before anything is installed (lib/build.mjs).
//
// Every age is measured by this machine's clock, so an admission that rests on one
// is only taken once that clock is no more than CLOCK_SLACK ahead of the registry's
// (its HTTPS Date header): a clock days fast would let a young dependency through.
//
// A pin that didn't arrive through self-update (a fresh clone's, whose evaluator
// commits came with the clone, or one pulled by hand) gets the same checks before
// it's built (verifyHead, called by bin/t3blackout's update), with trust taken
// from the history, never from HEAD: forward from the clone's first commit (or
// the last one verified here), each commit is taken as self-update takes it onto
// its first parent, by the same code (checkTip).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openAdvisories } from "./evaluate.mjs";
import { makeFastLane } from "./fastlane.mjs";
import { DEADLINES, UPSTREAM_URL, gitEnv, ownConfig, publicGit, releaseSnapshot } from "./git.mjs";
import { MIN_AGE_DAYS, dependencyAgeGate, heldDependencies, lockIdentities, registryTime, reviewAddedDeviceTools } from "./gates.mjs";
import { DEVICE_TOOL_PINS, deviceToolsInUse, toolNames, trustedInventory } from "./inventory.mjs";
import { parseOverrides, parseToolOverrides } from "./overrides.mjs";
import { PIN_FILE, backwardMove, compareRefs, unreleasedPin, validatePin } from "./pin.mjs";
import { ROOT, log } from "./util.mjs";

export const BOT_PRINCIPAL = "t3blackout-evaluator";

/** How far this machine's clock may run ahead of the registry's before an age measured by it isn't taken. */
const CLOCK_SLACK = 10 * 60_000;

const SIGNERS = ".allowed_signers";
const KNOWN_DEVICE_TOOLS = "lib/known-device-tools.txt";
const KNOWN_HOSTS = "lib/known-hosts.txt";
const OVERRIDES = "lib/overrides.json";

// git for `repo` and nothing else: GIT_DIR, GIT_WORK_TREE and every other git setting in
// the environment are dropped after `opts.env` is merged, so a hook or shell that
// exports them can't point the check at another repository. Replace refs and a grafts
// file are off too: either would have git read a history other than the commits' own.
const gitIn = (repo) => (args, opts = {}) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20, ...opts, env: { ...gitEnv({ ...process.env, ...opts.env }, "file"), GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" } });

const outOf = (git) => (args) => {
  const result = git(args);
  return result.status === 0 ? result.stdout.trim() : null;
};

/** A GitHub repository URL in any form git takes (https, ssh, scp-like): its owner/repo, else null. */
const GITHUB_URL = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/(?:[\w.-]+@)?github\.com(?::\d+)?\/|(?:[\w.-]+@)?github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;

/**
 * https://github.com/<owner>/<repo>.git for this clone's origin, in whatever URL
 * form it's written, or null when that isn't one GitHub repository. Read as the
 * clone's own configuration writes it (lib/git.mjs ownConfig), not as `git
 * remote get-url` would: an `insteadOf` rule in any git configuration would make
 * that something else.
 */
export function githubOrigin(repo) {
  let urls;
  try {
    urls = ownConfig(repo, "remote.origin.url");
  } catch {
    return null;
  }
  const name = urls.length === 1 ? GITHUB_URL.exec(urls[0])?.[1] : null;
  return name ? `https://github.com/${name}.git` : null;
}

/**
 * Fetches main without prompting, only through lib/git.mjs (HTTPS only, none of
 * this machine's git configuration, the clone's own checked first): from
 * `remote` when the caller names one (a local path, for tests), else from this
 * clone's GitHub origin over HTTPS, which a public repository needs no login
 * for. Nothing else is fetched: an SSH key behind an agent like 1Password would
 * wait for an approval nobody gives at 04:00, and a git configuration's rewrite
 * could send the fetch anywhere.
 */
function fetchMain(repo, remote) {
  const url = remote ?? githubOrigin(repo);
  if (!url) return { status: 1, stderr: "origin isn't a github.com repository URL, and self-update fetches only from GitHub" };
  try {
    return publicGit(["fetch", "--quiet", url, "main"], { url, repo, timeout: DEADLINES.fetch });
  } catch (error) {
    // The clone's own git configuration would send the fetch elsewhere (lib/git.mjs checkRepoTransport).
    return { status: 1, stderr: error.message };
  }
}

/** The signature on a raw commit object: "ssh", "openpgp", "x509", "unknown" (several, or another kind), or null when unsigned. */
export function signatureKind(raw) {
  const end = raw.indexOf("\n\n");
  const headers = [...(end === -1 ? raw : raw.slice(0, end)).matchAll(/^gpgsig(?:-sha256)? (.*)$/gm)];
  if (!headers.length) return null;
  if (headers.length > 1) return "unknown";
  return { "-----BEGIN SSH SIGNATURE-----": "ssh", "-----BEGIN PGP SIGNATURE-----": "openpgp", "-----BEGIN SIGNED MESSAGE-----": "x509" }[headers[0][1].trim()] ?? "unknown";
}

/** The principals an allowed-signers file lists. */
export function principalsOf(text) {
  const principals = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const field = trimmed.startsWith('"') ? trimmed.slice(1, trimmed.indexOf('"', 1)) : trimmed.split(/\s+/)[0];
    for (const principal of field.split(",")) if (principal) principals.add(principal);
  }
  return principals;
}

/** The tree-entry mode of a regular, non-executable file. */
const REGULAR = "100644";

/**
 * Why an evaluator-signed commit is out of bounds, or null when it only moves
 * the pin forward: from its count of `parents`, the `files` it changes over its
 * first parent, and pin.json's text and tree-entry mode after it and before it
 * (null when absent). The pin must stay a regular file: a symlink's text is the
 * name of what it points at, so a checkout wouldn't read the pin verified here.
 */
function botShape({ parents, files, after, before, afterMode = REGULAR, beforeMode = REGULAR }) {
  if (parents !== 1) return "is a merge or a root commit";
  if (files.length !== 1 || files[0] !== PIN_FILE) return `changes ${files.join(", ") || "nothing"}, not just ${PIN_FILE}`;
  if (after !== null && afterMode !== REGULAR) return `makes ${PIN_FILE} mode ${afterMode}; it must stay a regular file (${REGULAR})`;
  if (before !== null && beforeMode !== REGULAR) return `follows a ${PIN_FILE} of mode ${beforeMode}, not a regular file (${REGULAR})`;
  let next;
  try {
    next = validatePin(JSON.parse(after ?? "null"));
  } catch (error) {
    return `leaves ${error.message}`;
  }
  // The first pin, and a channel's first, have nothing trusted to be measured
  // against (dependency age, device tools): the owner signs those.
  if (before === null) return `creates ${PIN_FILE}; its first version needs a commit you sign`;
  let previous;
  try {
    previous = validatePin(JSON.parse(before));
  } catch (error) {
    return `follows an invalid ${PIN_FILE} (${error.message})`;
  }
  const backward = backwardMove(previous, next);
  if (backward) return backward;
  const added = Object.keys(next.channels).filter((channel) => !previous.channels[channel]);
  if (added.length) return `adds a ${added.join(", ")} pin; a channel's first pin needs a commit you sign`;
  const approved = [...addedApprovals(previous, next)];
  const moved = Object.entries(next.channels).some(([channel, entry]) => compareRefs(entry.ref, previous.channels[channel].ref) > 0);
  if (approved.length && !moved) return `approves device tools ${approved.join(", ")} without moving a channel forward`;
  return null;
}

/** `git cat-file --batch` over `names` (objects, or rev:path): Map name -> { type, bytes }, without the missing; null when git fails. */
function catBatch(git, names) {
  if (!names.length) return new Map();
  const result = git(["cat-file", "--batch"], { input: names.map((name) => `${name}\n`).join(""), encoding: null });
  if (result.status !== 0) return null;
  const buffer = result.stdout;
  const found = new Map();
  let at = 0;
  for (const name of names) {
    const end = buffer.indexOf(10, at);
    if (end < 0) return null;
    const header = buffer.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header.length !== 3) continue;
    const size = Number(header[2]);
    found.set(name, { type: header[1], bytes: buffer.subarray(at, at + size) });
    at += size + 1;
  }
  return found;
}

/**
 * The blob each of `names` (rev:path) names, by `git cat-file --batch-check`: Map
 * name -> { id, mode } (its tree-entry mode, such as 100644 or a symlink's 120000),
 * or null where there's none; null when git fails.
 */
function blobIds(git, names) {
  if (!names.length) return new Map();
  const result = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectmode)"], { input: names.map((name) => `${name}\n`).join("") });
  const lines = result.status === 0 ? result.stdout.split("\n") : [];
  if (lines.length < names.length) return null;
  return new Map(
    names.map((name, i) => {
      const [id, type, mode] = lines[i].split(" ");
      return [name, type === "blob" ? { id, mode } : null];
    }),
  );
}

/**
 * The commits `revs` names (rev-list's arguments: the tip, and ^ what's already
 * trusted), each taken as self-update takes it onto its first parent, oldest
 * first and every commit after its parents, side branches included: it must
 * carry a good SSH signature (GPG and X.509 are refused outright: git would
 * check those against whatever keyring the machine has) from a principal its
 * first parent's .allowed_signers lists, so a commit can't change who may sign
 * it, and only a commit the owner signs changes who may sign the ones after it;
 * an evaluator commit must keep to its bounds (botShape). A commit without a
 * parent is refused unless it's `root` (the clone's first commit, judged by its
 * own list, and not the evaluator's). The history is read in a few git calls,
 * not several per commit. { problem } or { commits: [{ sha, parents, principal,
 * pinChanged (over its first parent) }] }. Shared by selfUpdate and verifyHead
 * (checkTip), so what one takes, the other does.
 */
function takeHistory(git, revs, { root = null } = {}) {
  const out = outOf(git);
  const short = (sha) => sha.slice(0, 10);
  const unreadable = { problem: "this clone's history can't be read; make a full clone (git fetch --unshallow)" };
  const listed = out(["rev-list", "--topo-order", "--reverse", "--parents", ...revs]);
  if (listed === null) return unreadable;
  const commits = listed
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...parents] = line.split(" ");
      return { sha, parents };
    });
  // What each commit is judged by: its first parent's list (the first commit's own), and the pins it moves between.
  const by = (c) => c.parents[0] ?? c.sha;
  const found = blobIds(git, [...new Set(commits.flatMap((c) => [`${by(c)}:${SIGNERS}`, `${c.sha}:${PIN_FILE}`, ...(c.parents.length ? [`${c.parents[0]}:${PIN_FILE}`] : [])]))]);
  const raw = catBatch(git, commits.map((c) => c.sha));
  if (!found || !raw) return unreadable;
  const ids = new Map([...found].map(([name, blob]) => [name, blob?.id ?? null]));
  const modeOf = (name) => found.get(name)?.mode ?? null;
  // Each commit's signature kind, from the raw object, before git checks any: only an
  // SSH signature goes to git, so no OpenPGP or X.509 program the clone configures runs.
  const kinds = new Map(commits.map((c) => [c.sha, raw.get(c.sha)?.type === "commit" ? signatureKind(raw.get(c.sha).bytes.toString("utf8")) : null]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-signers-"));
  try {
    // Each list once, written out for git, with every signature it judges checked in one git call.
    const lists = new Map();
    for (const c of commits) {
      const blob = ids.get(`${by(c)}:${SIGNERS}`);
      if (blob && kinds.get(c.sha) === "ssh") lists.set(blob, [...(lists.get(blob) ?? []), c.sha]);
    }
    const texts = catBatch(git, [...lists.keys()]);
    if (!texts) return unreadable;
    const signed = new Map();
    for (const [blob, shas] of lists) {
      const text = texts.get(blob)?.bytes.toString("utf8") ?? "";
      const file = path.join(dir, blob);
      fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
      const principals = principalsOf(text);
      // ssh-keygen checks each signature (about 12 ms apiece): long histories get time for it.
      const checked = git(["-c", "gpg.ssh.program=ssh-keygen", "-c", `gpg.ssh.allowedSignersFile=${file}`, "log", "--no-walk=unsorted", "--stdin", "--no-show-signature", "--format=%x02%H%x00%G?%x00%GS"], { input: `${shas.join("\n")}\n`, timeout: Math.max(60_000, shas.length * 100) });
      for (const entry of checked.status === 0 ? checked.stdout.split("\x02").slice(1) : []) {
        const [sha, status, principal = ""] = entry.split("\0");
        signed.set(sha, { status, principal: principal.trim(), known: principals.has(principal.trim()) });
      }
    }
    // An evaluator commit's changed files and pins, for its bounds.
    const bot = commits.filter((c) => signed.get(c.sha)?.principal === BOT_PRINCIPAL && c.parents.length === 1);
    const files = new Map();
    if (bot.length) {
      const changed = git(["diff-tree", "--stdin", "--always", "-r", "--name-only", "-z"], { input: `${bot.map((c) => c.sha).join("\n")}\n` });
      if (changed.status !== 0) return unreadable;
      let current = null;
      for (const token of changed.stdout.split("\0")) {
        if (token === bot[files.size]?.sha) files.set((current = token), []);
        else if (token && current) files.get(current).push(token);
      }
    }
    const pins = catBatch(git, [...new Set(bot.flatMap((c) => [ids.get(`${c.sha}:${PIN_FILE}`), ids.get(`${c.parents[0]}:${PIN_FILE}`)]).filter(Boolean))]);
    if (!pins) return unreadable;
    const pinText = (rev) => {
      const blob = ids.get(`${rev}:${PIN_FILE}`);
      return blob ? (pins.get(blob)?.bytes.toString("utf8") ?? null) : null;
    };
    for (const c of commits) {
      const first = !c.parents.length;
      if (first && c.sha !== root) return { problem: `commit ${short(c.sha)} has no parent: a history that isn't this clone's` };
      const label = first ? `the first commit, ${short(c.sha)},` : `commit ${short(c.sha)}`;
      if (!ids.get(`${by(c)}:${SIGNERS}`)) return { problem: first ? `${label} has no ${SIGNERS}` : `${label} follows ${short(c.parents[0])}, which has no ${SIGNERS}` };
      const object = raw.get(c.sha);
      if (object?.type !== "commit") return { problem: `${label} can't be read` };
      const kind = kinds.get(c.sha);
      if (kind !== "ssh") return { problem: `${label} ${kind ? `is signed with ${kind === "unknown" ? "an unrecognized signature" : kind}, not an SSH key in ${SIGNERS}` : "isn't signed"}` };
      const { status = "E", principal, known } = signed.get(c.sha) ?? {};
      if (status !== "G" || !known) return { problem: `${label} isn't signed by a key in ${SIGNERS} (${status})` };
      c.principal = principal;
      if (principal === BOT_PRINCIPAL) {
        if (first) return { problem: `${label} is the evaluator's; it needs one you sign` };
        const why = botShape({ parents: c.parents.length, files: files.get(c.sha) ?? [], after: pinText(c.sha), before: pinText(c.parents[0]), afterMode: modeOf(`${c.sha}:${PIN_FILE}`), beforeMode: modeOf(`${c.parents[0]}:${PIN_FILE}`) });
        if (why) return { problem: `evaluator commit ${short(c.sha)} ${why}` };
      }
      c.pinChanged = !first && ids.get(`${c.sha}:${PIN_FILE}`) !== ids.get(`${c.parents[0]}:${PIN_FILE}`);
    }
    return { commits };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Device tools `next` approves, or locks, that `previous` didn't. */
const addedApprovals = (previous, next) =>
  new Set([
    ...next.deviceTools.filter((tool) => !previous.deviceTools.includes(tool)),
    ...Object.keys(next.deviceToolLocks ?? {}).filter((tool) => !Object.hasOwn(previous.deviceToolLocks ?? {}, tool)),
  ]);

/** A list file's entries at a commit (comments and blank lines dropped); empty when the file isn't there. */
const listAt = (out, rev, file) =>
  (out(["show", `${rev}:${file}`]) ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);

/**
 * The fast lane (lib/fastlane.mjs) for dependencies new since the release with
 * lockfile `baseLock`, from what only upstream (that release's lockfile and
 * device tool pins, `toolsText`) and the owner (`overrides`, `toolOverrides`)
 * wrote. Made once, on the first young version; when it can't be (an advisory
 * source unreachable, say), nothing is waived, which only ever holds more back.
 * Whether a fix is still flagged is asked of the same `advisories`.
 */
function lazyFastLane({ baseLock, toolsText, overrides, toolOverrides, advisories, now }) {
  let lane = null;
  const make = async () => {
    try {
      const tools = deviceToolsInUse(toolsText(), toolOverrides());
      const packages = trustedInventory({ upstreamLock: baseLock, deviceTools: tools, overrides: overrides() });
      const watch = toolNames(tools);
      return makeFastLane({ basePackages: packages, openAdvisories: await advisories(packages, { watch }), now, watch, advisories });
    } catch {
      return null;
    }
  };
  return async (pkg) => {
    lane ??= make();
    const waive = await lane;
    return waive ? waive(pkg) : null;
  };
}

/** The owner's device tool overrides as committed at `at` (the evaluator can't change them: botShape). */
const toolOverridesAt = (out, at) => {
  const text = out(["show", `${at}:${OVERRIDES}`]);
  return text === null ? [] : parseToolOverrides(text);
};

/**
 * The device tools an evaluator commit approves (or locks) in `after` over
 * `before`, checked against the releases it moves to (`moved`, read from
 * `snapshot`): each must be one a build of them installs, raised by the owner's
 * device tool overrides as `at` has them, and pass review with its dependency
 * closure (a young version only through the tool's fast lane). Returns {
 * result, message } or null.
 */
async function reviewApprovals({ short, before, after, moved, snapshot, out, at, isKnownHost, reviewClosure, advisories, now, report }) {
  const approved = [...addedApprovals(before, after)];
  const raise = toolOverridesAt(out, at);
  const pinned = new Set(moved.flatMap(([, entry]) => deviceToolsInUse(snapshot.show(entry.sha, DEVICE_TOOL_PINS), raise)));
  const stray = approved.filter((tool) => !pinned.has(tool));
  if (stray.length) return { result: "refused", message: `evaluator commit ${short} approves ${stray.join(", ")}, which ${moved.map(([, entry]) => entry.ref).join(", ")} doesn't pin` };
  const known = new Set(listAt(out, at, KNOWN_HOSTS));
  const { isReservedHost } = isKnownHost ? {} : await import("./build.mjs");
  let reviews;
  try {
    reviews = await reviewAddedDeviceTools(before.deviceTools, after.deviceTools, {
      knownDeviceTools: listAt(out, at, KNOWN_DEVICE_TOOLS),
      isKnownHost: isKnownHost ?? ((host) => known.has(host) || isReservedHost(host)),
      closure: reviewClosure,
      locks: after.deviceToolLocks ?? {},
      previousLocks: before.deviceToolLocks ?? {},
      advisories,
      toolOverrides: raise,
      now,
    });
  } catch (error) {
    return { result: "skipped", message: `couldn't review the device tools evaluator commit ${short} approves (${error.message})` };
  }
  const failed = reviews.find((review) => !review.ok);
  if (failed) return { result: "refused", message: `evaluator commit ${short} approves device tool ${failed.tool}, which fails review here: ${failed.reasons.join("; ")}` };
  for (const note of reviews.flatMap((review) => review.notes ?? [])) if (note.startsWith("fast lane: ")) report(`evaluator commit ${short}: ${note}`);
  return null;
}

/**
 * The dependency versions each release in `moved` adds over the one `before`
 * names (which this clone already trusts): each at least MIN_AGE_DAYS old, with
 * its bytes kept and the registry's, unless the fast lane waives it. Returns {
 * result, message } or null; `aged` hears whether any version was added (an
 * admission resting on this machine's clock).
 */
async function checkDependencies({ short, before, moved, snapshot, out, at, advisories, now, report, aged }) {
  for (const [channel, entry] of moved) {
    const previous = before.channels[channel];
    const [baseLock, lock] = [snapshot.show(previous.sha, "pnpm-lock.yaml"), snapshot.show(entry.sha, "pnpm-lock.yaml")];
    if (!baseLock || !lock) return { result: "refused", message: `evaluator commit ${short}: no pnpm-lock.yaml at ${baseLock ? entry.ref : previous.ref}` };
    try {
      lockIdentities(baseLock);
      lockIdentities(lock);
    } catch (error) {
      return { result: "refused", message: `evaluator commit ${short} pins ${entry.ref}, whose dependencies can't be checked: ${error.message}` };
    }
    const waive = lazyFastLane({
      baseLock,
      toolsText: () => snapshot.show(previous.sha, DEVICE_TOOL_PINS),
      overrides: () => {
        const text = out(["show", `${at}:${OVERRIDES}`]);
        return text === null ? [] : parseOverrides(text);
      },
      toolOverrides: () => toolOverridesAt(out, at),
      advisories,
      now,
    });
    let gate;
    try {
      gate = await dependencyAgeGate(baseLock, lock, { waive, now });
    } catch (error) {
      return { result: "skipped", message: `couldn't check the dependencies ${entry.ref} adds (${error.message})` };
    }
    if (gate.substituted.length) {
      return { result: "refused", message: `evaluator commit ${short} pins ${entry.ref}, which changes or misstates dependencies' bytes: ${heldDependencies({ young: [], unknown: [], substituted: gate.substituted }).join(", ")}` };
    }
    const held = heldDependencies(gate);
    if (held.length) {
      return { result: "held", message: `evaluator commit ${short} pins ${entry.ref}, which adds dependencies under ${MIN_AGE_DAYS} days old over ${previous.ref}; waiting until they're old enough: ${held.join(", ")}` };
    }
    for (const { pkg, reason } of gate.waived) report(`evaluator commit ${short}: fast lane: ${pkg}: ${reason}`);
    if (gate.added) aged.taken = true;
  }
  return null;
}

/** The valid pin at `rev`, or null. */
function pinAt(out, rev) {
  const text = out(["show", `${rev}:${PIN_FILE}`]);
  if (text === null) return null;
  try {
    return validatePin(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * `check` (reviewApprovals or checkDependencies) on a move from pin `before` to
 * `after` (both valid, `after` only forward of `before`: botShape), told as
 * evaluator commit `short`'s, once each channel it moves names the commit its
 * tag points at upstream; the owner's overrides and lists as `at` has them.
 * { result: "refused" | "held" | "skipped", message } or null.
 */
async function pinGates(git, { short, before, after, upstream, check, ...rest }) {
  const moved = Object.entries(after.channels).filter(([channel, entry]) => before.channels[channel].ref !== entry.ref || before.channels[channel].sha !== entry.sha);
  if (!moved.length) return null;
  try {
    const why = unreleasedPin(before, after, upstream);
    if (why) return { result: "refused", message: `evaluator commit ${short} ${why}` };
  } catch (error) {
    return { result: "skipped", message: `couldn't check the tags evaluator commit ${short} pins upstream (${error.message})` };
  }
  let snapshot;
  try {
    // The releases it moves to by tag (just checked upstream); the ones it moves
    // from by commit: they're trusted already, whatever their tags say now.
    snapshot = releaseSnapshot(
      moved.map(([, entry]) => ({ ref: entry.ref, sha: entry.sha })),
      { url: upstream, trusted: moved.map(([channel]) => before.channels[channel].sha) },
    );
  } catch (error) {
    return { result: error.transient ? "skipped" : "refused", message: `evaluator commit ${short}: ${error.message}` };
  }
  try {
    return await check({ short, before, after, moved, snapshot, out: outOf(git), ...rest });
  } catch (error) {
    return { result: error.transient ? "skipped" : "refused", message: `evaluator commit ${short}: ${error.message}` };
  } finally {
    snapshot.close();
  }
}

/**
 * Whether ages measured at `now`, by this machine's clock, can be taken: null
 * when it's no more than CLOCK_SLACK ahead of `clock`'s time (the registry's,
 * lib/gates.mjs registryTime), else "held" (a clock behind only holds more
 * back), or "skipped" when the registry can't be asked.
 */
async function clockProblem(clock, now) {
  let at;
  try {
    at = await clock();
    if (!Number.isFinite(at)) throw new Error("it sent no time");
  } catch (error) {
    return { result: "skipped", message: `couldn't check this machine's clock against the npm registry's (${error.message})` };
  }
  if (now - at <= CLOCK_SLACK) return null;
  const minutes = Math.round((now - at) / 60_000);
  const by = minutes < 120 ? `${minutes} minutes` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes / 1440)} days`;
  const fix = process.platform === "darwin" ? "this Mac's clock is ahead; turn on Set time automatically (System Settings > General > Date & Time)" : "this machine's clock is ahead; turn on network time (timedatectl set-ntp true)";
  return { result: "held", message: `${fix}: it's ${by} ahead of the npm registry's, and dependency ages are measured by it` };
}

/**
 * Along `chain` (a tip's first parents, oldest first, from a commit whose pin
 * is trusted), what the tip's pin rests on: the newest commit on it the owner
 * signed that changes pin.json over its own first parent (else the start), and
 * the evaluator commits on it since. A side branch's pin reaches the tip only
 * through an owner merge that changes pin.json over its first parent, so no
 * commit off the chain vouches for one on it. `of`: takeHistory's commits by sha.
 */
function pinBasis(chain, of) {
  let trusted = chain[0];
  const bot = [];
  for (const sha of chain.slice(1)) {
    const commit = of.get(sha);
    if (commit.principal === BOT_PRINCIPAL) bot.push(sha);
    else if (commit.pinChanged) {
      trusted = sha;
      bot.length = 0;
    }
  }
  return { trusted, bot };
}

const FULL_CLONE = "make a full clone (git fetch --unshallow)";

/**
 * Whether `tip` may be built: the one check self-update and verifyHead share.
 * A shallow clone is refused (what it lacks can't be checked). From `start` (a
 * commit whose pin is trusted here: this clone's HEAD, or the one recorded as
 * verified) when it's on tip's first-parent chain, else from the chain's first
 * commit, every commit since is taken by takeHistory; then the pin tip builds,
 * over the one it rests on (pinBasis), passes the gates: each evaluator commit
 * that approves a device tool, against the release it moves to (approvals stay
 * in later pins after a later release installs a newer version), and the
 * dependencies once, from the trusted pin to the built one; all by a clock no
 * more than CLOCK_SLACK ahead. { result: "verified" | "refused" | "held" |
 * "skipped", message, commits }: "skipped" when npm or upstream can't be
 * reached, "held" while a dependency is too young or this machine's clock is
 * ahead (each run retries).
 */
async function checkTip(git, { tip, start, upstream, isKnownHost, reviewClosure, advisories, now, clock, report }) {
  const out = outOf(git);
  const short = (sha) => sha.slice(0, 10);
  if (out(["rev-parse", "--is-shallow-repository"]) !== "false") {
    return { result: "refused", message: `this clone is shallow: the history ${short(tip)} is checked along isn't all here; ${FULL_CLONE}` };
  }
  const chain = (out(["rev-list", "--first-parent", "--reverse", tip]) ?? "").split("\n").filter(Boolean);
  if (chain.at(-1) !== tip) return { result: "refused", message: `this clone's history behind ${short(tip)} can't be read; ${FULL_CLONE}` };
  const from = Math.max(0, chain.indexOf(start));
  const taken = takeHistory(git, from ? [tip, `^${chain[from]}`] : [tip], { root: from ? null : chain[0] });
  if (taken.problem) return { result: "refused", message: taken.problem };
  const { trusted, bot } = pinBasis(chain.slice(from), new Map(taken.commits.map((commit) => [commit.sha, commit])));
  if (bot.length) {
    const aged = { taken: false };
    const context = { at: tip, upstream, isKnownHost, reviewClosure, advisories, now, report, aged };
    for (const sha of bot) {
      const [before, after] = [pinAt(out, `${sha}^`), pinAt(out, sha)];
      if (!addedApprovals(before, after).size) continue;
      const problem = await pinGates(git, { ...context, short: short(sha), before, after, check: reviewApprovals });
      if (problem) return problem;
      aged.taken = true;
    }
    // The pin tip builds is the last evaluator commit's: nothing on the chain after it sets one.
    const problem = await pinGates(git, { ...context, short: short(bot.at(-1)), before: pinAt(out, trusted), after: pinAt(out, tip), check: checkDependencies });
    if (problem) return problem;
    const late = aged.taken ? await clockProblem(clock, now) : null;
    if (late) return late;
  }
  return { result: "verified", message: `${short(tip)} verified here${bot.length ? ` (${bot.length} evaluator commit(s) since ${short(trusted)})` : ""}`, commits: taken.commits };
}

/**
 * Where this clone keeps the last HEAD whose pin was verified here, and when (by
 * this machine's clock): in its git directory, so a fresh clone (whose commits
 * nobody here checked) starts without one.
 */
const recordOf = (git) => {
  const file = outOf(git)(["rev-parse", "--path-format=absolute", "--git-path", "t3blackout-verified"]);
  return file ? path.resolve(file) : null;
};
/**
 * The commit recorded as verified here, unless the clock now reads earlier than
 * when it was (it was ahead then, or has been set back since): then none is.
 */
const verifiedHere = (git, now) => {
  try {
    const [sha, at] = fs.readFileSync(recordOf(git), "utf8").trim().split(" ");
    return /^\d+$/.test(at ?? "") && Number(at) <= now ? sha : null;
  } catch {
    return null;
  }
};
const writeRecord = (git, sha, now) => {
  const file = recordOf(git);
  if (file) fs.writeFileSync(file, `${sha} ${Math.floor(now)}\n`, { mode: 0o600 });
};

/**
 * Whether this clone's HEAD may be built, worked out as self-update would have
 * for the commits it didn't bring (see the top of this file), by the same check
 * (checkTip): { result: "verified" | "refused" | "held" | "skipped", message }.
 * It starts at the commit last verified here, when it's on HEAD's first-parent
 * chain, else at the clone's first commit, which must be signed by a principal
 * its own .allowed_signers lists other than the evaluator; a shallow or
 * incomplete clone is refused, since what it lacks can't be checked. A HEAD
 * that passes is recorded with the time, so it's checked once. Options other
 * than `report` are for tests.
 */
export async function verifyHead({ repo = ROOT, upstream = UPSTREAM_URL, report = log, isKnownHost = null, reviewClosure, advisories = openAdvisories, now = Date.now(), clock = registryTime } = {}) {
  const git = gitIn(repo);
  const out = outOf(git);
  const short = (sha) => sha.slice(0, 10);
  const head = out(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) return { result: "refused", message: "this clone has no commit" };
  const recorded = verifiedHere(git, now);
  if (recorded === head) return { result: "verified", message: `${short(head)} was verified here` };
  const { result, message } = await checkTip(git, { tip: head, start: recorded, upstream, isKnownHost, reviewClosure, advisories, now, clock, report });
  if (result === "verified") writeRecord(git, head, now);
  return { result, message };
}

/**
 * Fast-forwards this clone to signed new commits on main, once the tip passes
 * the check verifyHead makes too (checkTip, from this clone's HEAD, or from the
 * first commit when HEAD is only a merge's second parent): "updated",
 * "refused", "held" (an evaluator pin waits for its dependencies to age) or
 * "skipped". Call it holding the update lock. The options other than `report` are for tests
 * (`remote`: where main is fetched from instead of origin's GitHub repository).
 */
export async function selfUpdate({ repo = ROOT, remote = null, upstream = UPSTREAM_URL, report = log, isKnownHost = null, reviewClosure, advisories = openAdvisories, now = Date.now(), clock = registryTime } = {}) {
  const git = gitIn(repo);
  const out = outOf(git);
  const head = out(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const signers = head ? out(["show", `${head}:${SIGNERS}`]) : null;
  if (!signers) return "skipped";
  if (out(["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") {
    report("self-update skipped: not on main");
    return "skipped";
  }
  if (out(["status", "--porcelain", "--untracked-files=no"])) {
    report("self-update skipped: uncommitted changes");
    return "skipped";
  }
  const fetched = fetchMain(repo, remote);
  if (fetched.status !== 0) {
    report(`self-update skipped: couldn't fetch (${(fetched.stderr || fetched.error?.message || "timed out").trim().split("\n")[0]})`);
    return "skipped";
  }
  const tip = out(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  if (!tip || tip === head) return "skipped";
  if (git(["merge-base", "--is-ancestor", head, tip]).status !== 0) {
    report(`self-update refused: origin/main (${tip.slice(0, 10)}) isn't a fast-forward of this clone`);
    return "refused";
  }
  const recordedHead = verifiedHere(git, now);
  // The one check verifyHead makes too (checkTip), from this clone's HEAD (its pin is this clone's), before
  // anything lands or runs: each new commit signed by a key its first parent's list has (so a key an owner
  // commit in this batch removes signs nothing after it, and one it adds signs from the next commit on), and the
  // pin the tip builds, over what it rests on along first parents, through the gates.
  const checked = await checkTip(git, { tip, start: head, upstream, isKnownHost, reviewClosure, advisories, now, clock, report });
  if (checked.result !== "verified") {
    report(`self-update ${checked.result}: ${checked.message}`);
    return checked.result;
  }
  const added = new Set((out(["rev-list", tip, `^${head}`]) ?? "").split("\n").filter(Boolean));
  const bot = checked.commits.filter((commit) => added.has(commit.sha) && commit.principal === BOT_PRINCIPAL).length;
  // By its id, so it lands on exactly the commit verified, whatever FETCH_HEAD says by now.
  if (git(["merge", "--ff-only", "--quiet", tip]).status !== 0) {
    report("self-update failed to fast-forward");
    return "skipped";
  }
  // Verified here, on top of a HEAD verified here too: verifyHead needn't check it again. From a HEAD that
  // wasn't (a fresh clone's), it isn't recorded: verifyHead still checks what the clone came with.
  if (recordedHead === head) writeRecord(git, tip, now);
  report(`self-updated t3blackout to ${tip.slice(0, 10)} (${added.size} signed commit(s)${bot ? `, ${bot} from the evaluator` : ""})`);
  return "updated";
}
