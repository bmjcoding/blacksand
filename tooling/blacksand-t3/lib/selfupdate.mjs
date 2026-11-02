// Fetch one exact tip, verify it with src/trust, then fast-forward to that id.
// Both update and direct pre-build verification use the same versioned record
// and four-layout TS verifier. Pin gates live separately to avoid an import cycle.
import { spawnSync } from "node:child_process";
import { checkTip, verifyHead as verifyHeadTs, verifiedHere, writeVerified, RECORD } from "../../../src/trust/check.ts";
import { localGit } from "../../../src/trust/git.ts";
import { EVALUATOR, evaluatorShape, isEvaluator } from "../../../src/trust/evaluator.ts";
export { isEvaluator };
export { signatureKind } from "../../../src/trust/signers.ts";
export { pinBasis } from "../../../src/trust/history.ts";
export { addedApprovals, checkDependencies, clockProblem, pinGates, reviewApprovals } from "./pin-gates.mjs";
import { openAdvisories } from "./evaluate.mjs";
import { registryTime } from "./gates.mjs";
import { DEADLINES, UPSTREAM_URL, gitEnv, ownConfig, publicGit } from "./git.mjs";
import { ROOT, log } from "./util.mjs";
import { t3Gates } from "./trust-gates.mjs";
export const BOT_PRINCIPAL = EVALUATOR;
// Historical callers ask about a root-layout pin; production uses evaluatorShape
// with the first parent's layout via src/trust/history.ts.
export const botShape = ({ pinFile = "pin.json", afterMode = "100644", beforeMode = "100644", ...shape }) => evaluatorShape({ ...shape, pinFile, afterMode, beforeMode });
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

const SIGNERS = ".allowed_signers";
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

/** Direct pre-build verification, including fresh clones and manual pulls. */
export function verifyHead({ repo = ROOT, now = Date.now(), ...options } = {}) {
  return verifyHeadTs({ repo, now, gates: t3Gates({ now, ...options }) });
}

/**
 * Fast-forwards this clone to signed new commits on main, once the tip passes
 * the check verifyHead makes too (checkTip, from the last current-verifier record on
 * the tip's first-parent chain, otherwise from the first commit): "updated",
 * "refused", "held" (an evaluator pin waits for its dependencies to age) or
 * "skipped". Call it holding the update lock. The options other than `report` are for tests
 * (`remote`: where main is fetched from instead of origin's GitHub repository).
 */
export async function selfUpdate({ repo = ROOT, remote = null, upstream = UPSTREAM_URL, report = log, isKnownHost = null, reviewClosure, advisories = openAdvisories, now = Date.now(), clock = registryTime } = {}) {
  const git = gitIn(repo);
  const out = outOf(git);
  const trustGit = localGit(repo);
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
  const recordedHead = verifiedHere(trustGit, RECORD, now);
  // The one check verifyHead makes too (checkTip), from the current verifier's last record, or the root, before
  // anything lands or runs: each new commit signed by a key its first parent's list has (so a key an owner
  // commit in this batch removes signs nothing after it, and one it adds signs from the next commit on), and the
  // pin the tip builds, over what it rests on along first parents, through the gates.
  const checked = await checkTip(trustGit, { tip, start: recordedHead, gates: t3Gates({ upstream, isKnownHost, reviewClosure, advisories, now, clock, report }) });
  if (checked.result !== "verified") {
    report(`self-update ${checked.result}: ${checked.message}`);
    return checked.result;
  }
  const added = new Set((out(["rev-list", tip, `^${head}`]) ?? "").split("\n").filter(Boolean));
  const bot = checked.commits.filter((commit) => added.has(commit.sha) && isEvaluator(commit.principal)).length;
  // By its id, so it lands on exactly the commit verified, whatever FETCH_HEAD says by now.
  if (out(["rev-parse", "HEAD"]) !== head) {
    report("self-update skipped: HEAD moved while the tip was checked");
    return "skipped";
  }
  if (git(["merge", "--ff-only", "--quiet", tip]).status !== 0) {
    report("self-update failed to fast-forward");
    return "skipped";
  }
  if (out(["rev-parse", "HEAD"]) !== tip) {
    report("self-update skipped: HEAD differs from the verified tip");
    return "skipped";
  }
  // Verified here, on top of a HEAD verified here too: verifyHead needn't check it again. From a HEAD that
  // wasn't (a fresh clone's), it isn't recorded: verifyHead still checks what the clone came with.
  if (recordedHead === head) writeVerified(trustGit, RECORD, tip, now);
  report(`self-updated t3blackout to ${tip.slice(0, 10)} (${added.size} signed commit(s)${bot ? `, ${bot} from the evaluator` : ""})`);
  return "updated";
}
