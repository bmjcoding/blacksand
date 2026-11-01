// Whether a tip may be built: the one check hourly self-update and a fresh
// clone's verifyHead share. Trust comes from the history, never from HEAD: every
// commit since a trusted one is taken by takeHistory, and the pin the tip builds,
// over the one it rests on (pinBasis), passes the pin gates, which the package
// supplies (PinGates): they ask upstream and the registries, so they can be
// faked in tests and swapped for another package's.

import * as fs from "node:fs";
import * as path from "node:path";

import { REGULAR, localGit, objectIds, out, type Git } from "./git.ts";
import { PACKAGE_DIR, layoutOf, packagePath, pinPath } from "./layout.ts";
import { pinBasis, short, takeHistory, type TakenCommit } from "./history.ts";
import { addedApprovals, validatePin, type Pin } from "./pin.ts";
import { compareWorktree, type WorkingTree } from "./worktree.ts";

/** Why a tip isn't verified: "refused" for good, "held" until something ages or a clock is fixed, "skipped" until upstream or a registry answers. */
export interface Unverified {
  result: "refused" | "held" | "skipped";
  message: string;
}

export interface Verified {
  result: "verified";
  message: string;
}

/** A move from pin `before` to `after` (both valid; `after` only forward of `before`), told as evaluator commit `short`'s. */
export interface PinMove {
  short: string;
  before: Pin;
  after: Pin;
  /** The tip, whose owner-written files (lists, overrides) the gates read. */
  at: string;
  /** `file` (a path in the package, such as "lib/overrides.json") as `at` has it, trimmed; null when absent. */
  read(file: string): string | null;
}

/** What a package checks before an evaluator's pin is built: each resolves to null (or `aged`) when it passes. */
export interface PinGates {
  /** The device tools `after` approves over `before`, against the releases it moves to. */
  approvals(move: PinMove): Promise<Unverified | null>;
  /** The dependencies the releases `after` moves to add over `before`'s; `aged` when one was admitted on its age. */
  dependencies(move: PinMove): Promise<Unverified | { aged: boolean }>;
  /** Whether ages measured by this machine's clock can be taken (null when they can). */
  clock(): Promise<Unverified | null>;
}

const FULL_CLONE = "make a full clone (git fetch --unshallow)";

/** The layout of `rev` (any revision git takes, such as sha^). */
function layoutAt(git: Git, rev: string) {
  const name = `${rev}:${PACKAGE_DIR}`;
  return layoutOf(objectIds(git, [name])?.get(name)?.type ?? null);
}

/** The valid pin at `rev`, in its own layout, or null (a symlink, or any file but a regular one, isn't one). */
function pinAt(git: Git, rev: string): Pin | null {
  const name = `${rev}:${pinPath(layoutAt(git, rev))}`;
  if (objectIds(git, [name])?.get(name)?.mode !== REGULAR) return null;
  const text = out(git, ["show", name]);
  if (text === null) return null;
  try {
    return validatePin(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A history every commit of which was taken, and what the tip's pin rests on. */
export interface TakenHistory {
  result: "verified";
  commits: TakenCommit[];
  /** The commit the tip's pin rests on, and the evaluator commits along the first-parent line since (pinBasis). */
  trusted: string;
  bot: string[];
}

/**
 * Whether every commit behind `tip` may be taken, with no pin gate asked: what
 * a commit's signatures and the evaluator's bounds decide. A shallow clone is
 * refused (what it lacks can't be checked). From `start` (a commit whose pin is
 * trusted here) when it's on tip's first-parent chain, else from the chain's
 * first commit, every commit since is taken by takeHistory.
 */
export function checkHistory(git: Git, { tip, start }: { tip: string; start: string | null }): Unverified | TakenHistory {
  if (out(git, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    return { result: "refused", message: `this clone is shallow: the history ${short(tip)} is checked along isn't all here; ${FULL_CLONE}` };
  }
  const chain = (out(git, ["rev-list", "--first-parent", "--reverse", tip]) ?? "").split("\n").filter(Boolean);
  if (chain.at(-1) !== tip) return { result: "refused", message: `this clone's history behind ${short(tip)} can't be read; ${FULL_CLONE}` };
  const from = start === null ? 0 : Math.max(0, chain.indexOf(start));
  const taken = takeHistory(git, from ? [tip, `^${chain[from]}`] : [tip], { root: from ? null : (chain[0] ?? null) });
  if ("problem" in taken) return { result: "refused", message: taken.problem };
  return { result: "verified", commits: taken.commits, ...pinBasis(chain.slice(from), new Map(taken.commits.map((commit) => [commit.sha, commit]))) };
}

/**
 * Whether `tip` may be built: its history taken (checkHistory), then the pin tip
 * builds, over the one it rests on, through the gates: each evaluator commit
 * that approves a device tool, against the release it moves to, and the
 * dependencies once, from the trusted pin to the built one; then, if any
 * admission rested on an age, the clock.
 */
export async function checkTip(git: Git, { tip, start, gates }: { tip: string; start: string | null; gates: PinGates }): Promise<Unverified | (Verified & { commits: TakenCommit[] })> {
  const taken = checkHistory(git, { tip, start });
  if (!("commits" in taken)) return taken;
  const { trusted, bot } = taken;
  const last = bot.at(-1);
  if (last !== undefined) {
    const tipLayout = layoutAt(git, tip);
    const read = (file: string) => out(git, ["show", `${tip}:${packagePath(tipLayout, file)}`]);
    // takeHistory took only evaluator commits that follow and leave valid pins, in an unchanged layout; a history
    // where that doesn't hold here is refused, not a crash.
    const unreadable = (sha: string): Unverified => ({ result: "refused", message: `evaluator commit ${short(sha)} moves between pins that can't be read` });
    let aged = false;
    for (const sha of bot) {
      const [before, after] = [pinAt(git, `${sha}^`), pinAt(git, sha)];
      if (!before || !after) return unreadable(sha);
      if (!addedApprovals(before, after).size) continue;
      const problem = await gates.approvals({ short: short(sha), before, after, at: tip, read });
      if (problem) return problem;
      aged = true;
    }
    // The pin tip builds is the last evaluator commit's: nothing on the chain after it sets one.
    const [base, built] = [pinAt(git, trusted), pinAt(git, tip)];
    if (!base || !built) return unreadable(last);
    const dependencies = await gates.dependencies({ short: short(last), before: base, after: built, at: tip, read });
    if ("result" in dependencies) return dependencies;
    const late = aged || dependencies.aged ? await gates.clock() : null;
    if (late) return late;
  }
  return { result: "verified", message: `${short(tip)} verified here${bot.length ? ` (${bot.length} evaluator commit(s) since ${short(trusted)})` : ""}`, commits: taken.commits };
}

/** Where a clone keeps the last HEAD verified in it, and when: in its git directory, so a fresh clone starts without one. */
export const RECORD = "t3blackout-verified";

const recordOf = (git: Git, record: string) => {
  const file = out(git, ["rev-parse", "--path-format=absolute", "--git-path", record]);
  return file ? path.resolve(file) : null;
};

/** The commit recorded as verified, unless the clock now reads earlier than when it was (it was ahead then, or has been set back since). */
function verifiedHere(git: Git, record: string, now: number): string | null {
  const file = recordOf(git, record);
  if (!file) return null;
  try {
    const [sha = "", at] = fs.readFileSync(file, "utf8").trim().split(" ");
    return /^\d+$/.test(at ?? "") && Number(at) <= now ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Whether `repo`'s HEAD may be built, worked out as self-update would have for
 * the commits it didn't bring, by the same check (checkTip). It starts at the
 * commit last verified here, when it's on HEAD's first-parent chain, else at the
 * clone's first commit. A HEAD that passes is recorded with the time (`now`, by
 * this machine's clock), so it's checked once.
 */
export async function verifyHead({ repo, gates, now, record = RECORD, git = localGit(repo) }: { repo: string; gates: PinGates; now: number; record?: string; git?: Git }): Promise<Unverified | Verified> {
  const head = out(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) return { result: "refused", message: "this clone has no commit" };
  const recorded = verifiedHere(git, record, now);
  if (recorded === head) return { result: "verified", message: `${short(head)} was verified here` };
  const verdict = await checkTip(git, { tip: head, start: recorded, gates });
  if (verdict.result === "verified") {
    const file = recordOf(git, record);
    if (file) fs.writeFileSync(file, `${head} ${Math.floor(now)}\n`, { mode: 0o600 });
  }
  return { result: verdict.result, message: verdict.message };
}

export interface HeadCheck {
  /** The commit checked, or null when there's none. */
  head: string | null;
  /** Its history, judged by signatures and the evaluator's bounds alone (checkHistory). */
  history: Unverified | TakenHistory;
  /** The working tree, file by file, against that commit's tree (compareWorktree). */
  tree: WorkingTree;
}

/**
 * Whether the clone at `git` runs signed code: HEAD's history taken from its
 * first commit (judged by its own list), every time, recording nothing, and the working tree
 * compared with that commit's tree, file by file. HEAD is read again at the end:
 * a checkout while this ran is refused, never reported as the commit it left.
 * What `blacksand verify` reports. A record is a shortcut the clone's own user
 * can write, which a read-only check doesn't take on trust. The pin gates
 * aren't asked: the evaluator can only change pin.json, which decides what the
 * t3 package builds, not the code that runs here, and `blacksand t3 update`
 * gates it before building.
 */
export function checkHead(git: Git): HeadCheck {
  const head = out(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) return { head: null, history: { result: "refused", message: "this clone has no commit" }, tree: { refused: "there's no commit to compare the working tree with", differs: [], outside: [] } };
  const history = checkHistory(git, { tip: head, start: null });
  let tree = compareWorktree(git, head);
  const now = out(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (now !== head) tree = { refused: `HEAD moved from ${short(head)} to ${now ? short(now) : "nothing"} while it was checked`, differs: [], outside: [] };
  return { head, history, tree };
}
