// Taking a history commit by commit, as self-update takes each onto its first
// parent: who signed it, judged by the list its first parent has, and whether an
// evaluator commit stays in its bounds. Read in a few git calls, not several per
// commit.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EVALUATOR, evaluatorShape } from "./evaluator.ts";
import { catBatch, objectIds, out, type Git } from "./git.ts";
import { LAYOUTS, ambiguous, layoutNames, layoutOf, pinPath, type Layout } from "./layout.ts";
import { SIGNERS, signatureKind, type SignatureKind } from "./signers.ts";

export interface TakenCommit {
  sha: string;
  parents: string[];
  /** The principal whose key signed it. */
  principal: string;
  /** Whether its pin file's contents differ from its first parent's. */
  pinChanged: boolean;
}

export type Taken = { problem: string } | { commits: TakenCommit[] };

export const short = (sha: string) => sha.slice(0, 10);

const UNREADABLE = { problem: "this clone's history can't be read; make a full clone (git fetch --unshallow)" };

interface Signed {
  status: string;
  principal: string;
}

/**
 * Checks every signature on `shas` (SSH-signed commits) against the
 * allowed-signers `text`, in one `git log` (ssh-keygen checks each one, about
 * 12 ms apiece, so long histories get time for it). A signature is good ("G")
 * only when ssh-keygen finds its key in the list, for the principal git then
 * names (%GS): that principal is taken byte for byte, with no second reading of
 * the list here. `dir`: a private folder for the list git reads.
 */
function checkSignatures(git: Git, dir: string, name: string, text: string, shas: readonly string[], into: Map<string, Signed>) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
  // -z ends each commit's record with NUL too, so the output is NUL-separated
  // (sha, status, principal) triples: nothing a principal can hold splits them.
  const args = ["-c", "gpg.ssh.program=ssh-keygen", "-c", `gpg.ssh.allowedSignersFile=${file}`, "log", "-z", "--no-walk=unsorted", "--stdin", "--no-show-signature", "--format=%H%x00%G?%x00%GS"];
  const checked = git.text(args, { input: `${shas.join("\n")}\n`, timeout: Math.max(60_000, shas.length * 100) });
  if (checked.status !== 0) return;
  const fields = checked.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  // Anything but whole triples is output this can't read: record nothing, so every commit is refused.
  if (fields.length % 3 !== 0) return;
  for (let i = 0; i < fields.length; i += 3) into.set(fields[i]!, { status: fields[i + 1]!, principal: fields[i + 2]! });
}

/** The files each of `shas` changes over its first parent, by one `git diff-tree`; null when git fails. */
function changedFiles(git: Git, shas: readonly string[]): Map<string, string[]> | null {
  const files = new Map<string, string[]>();
  if (!shas.length) return files;
  const changed = git.text(["diff-tree", "--stdin", "--always", "-r", "--name-only", "-z"], { input: `${shas.join("\n")}\n` });
  if (changed.status !== 0) return null;
  let current: string[] | null = null;
  for (const token of changed.stdout.split("\0")) {
    if (token === shas[files.size]) files.set(token, (current = []));
    else if (token && current) current.push(token);
  }
  return files;
}

/**
 * The commits `revs` names (rev-list's arguments: the tip, and ^ what's already
 * trusted), each taken as self-update takes it onto its first parent, oldest
 * first and every commit after its parents, side branches included. Each must
 * carry a good SSH signature from a principal its first parent's
 * .allowed_signers lists, so a commit can't change who may sign it, and only a
 * commit the owner signs changes who may sign the ones after it. An evaluator
 * commit must keep to its bounds (evaluatorShape) in its first parent's layout,
 * and leave that layout as it was: only a commit the owner signs moves the
 * package. A commit, or a first parent, with more than one package folder has
 * no layout (layout.ts), and is refused. A signature's kind is read from the
 * raw commit first: only SSH signatures go to git to be checked, so no OpenPGP
 * or X.509 program runs.
 * A commit without a parent is refused unless it's `root` (the clone's first
 * commit, judged by its own list, and not the evaluator's).
 */
export function takeHistory(git: Git, revs: readonly string[], { root = null }: { root?: string | null } = {}): Taken {
  const listed = out(git, ["rev-list", "--topo-order", "--reverse", "--parents", ...revs]);
  if (listed === null) return UNREADABLE;
  const commits = listed
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...parents] = line.split(" ");
      return { sha, parents };
    });
  // What each commit is judged by: its first parent's list (the first commit's own), and the pins it moves between.
  const by = (c: { sha: string; parents: string[] }) => c.parents[0] ?? c.sha;
  const described = [...new Set(commits.flatMap((c) => [c.sha, ...c.parents.slice(0, 1)]))];
  const names = [...new Set([...commits.map((c) => `${by(c)}:${SIGNERS}`), ...described.flatMap((rev) => [...layoutNames(rev), ...LAYOUTS.map((at) => `${rev}:${pinPath(at)}`)])])];
  const ids = objectIds(git, names);
  const raw = catBatch(git, commits.map((c) => c.sha));
  if (!ids || !raw) return UNREADABLE;
  const blob = (name: string) => {
    const found = ids.get(name);
    return found?.type === "blob" ? found.id : null;
  };
  const modeOf = (name: string) => ids.get(name)?.mode ?? null;
  const kinds = new Map<string, SignatureKind | null>(commits.map((c) => [c.sha, raw.get(c.sha)?.type === "commit" ? signatureKind(raw.get(c.sha)?.bytes.toString("utf8") ?? "") : null]));
  const layout = (rev: string) => layoutOf(rev, (name) => ids.get(name)?.type ?? null);
  // A commit with no one layout has no pin file: it's refused below, before any pin is compared.
  const pinFileOf = (rev: string) => {
    const at = layout(rev);
    return at && pinPath(at);
  };
  const pinBlob = (rev: string) => {
    const pinFile = pinFileOf(rev);
    return pinFile && blob(`${rev}:${pinFile}`);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-signers-"));
  try {
    // Each list once, written out for git, with every signature it judges checked in one git call.
    const lists = new Map<string, string[]>();
    for (const c of commits) {
      const list = blob(`${by(c)}:${SIGNERS}`);
      if (list && kinds.get(c.sha) === "ssh") lists.set(list, [...(lists.get(list) ?? []), c.sha]);
    }
    const texts = catBatch(git, [...lists.keys()]);
    if (!texts) return UNREADABLE;
    const signed = new Map<string, Signed>();
    for (const [list, shas] of lists) checkSignatures(git, dir, list, texts.get(list)?.bytes.toString("utf8") ?? "", shas, signed);

    // An evaluator commit's changed files and pins, for its bounds.
    const bot = commits.filter((c) => signed.get(c.sha)?.principal === EVALUATOR && c.parents.length === 1);
    const files = changedFiles(git, bot.map((c) => c.sha));
    if (!files) return UNREADABLE;
    const pinBlobs = bot.flatMap((c) => {
      const pinFile = pinFileOf(c.parents[0] ?? c.sha);
      return pinFile ? [blob(`${c.sha}:${pinFile}`), blob(`${c.parents[0]}:${pinFile}`)] : [];
    });
    const pins = catBatch(git, [...new Set(pinBlobs.filter((id) => id !== null))]);
    if (!pins) return UNREADABLE;
    const pinText = (rev: string, pinFile: string) => {
      const id = blob(`${rev}:${pinFile}`);
      return id ? (pins.get(id)?.bytes.toString("utf8") ?? null) : null;
    };

    const taken: TakenCommit[] = [];
    for (const c of commits) {
      const [parent] = c.parents;
      if (parent === undefined && c.sha !== root) return { problem: `commit ${short(c.sha)} has no parent: a history that isn't this clone's` };
      const label = parent === undefined ? `the first commit, ${short(c.sha)},` : `commit ${short(c.sha)}`;
      if (!blob(`${by(c)}:${SIGNERS}`)) return { problem: parent === undefined ? `${label} has no ${SIGNERS}` : `${label} follows ${short(parent)}, which has no ${SIGNERS}` };
      const object = raw.get(c.sha);
      if (object?.type !== "commit") return { problem: `${label} can't be read` };
      const kind = kinds.get(c.sha);
      if (kind !== "ssh") return { problem: `${label} ${kind ? `is signed with ${kind === "unknown" ? "an unrecognized signature" : kind}, not an SSH key in ${SIGNERS}` : "isn't signed"}` };
      const { status, principal } = signed.get(c.sha) ?? { status: "E", principal: "" };
      if (status !== "G") return { problem: `${label} isn't signed by a key in ${SIGNERS} (${status})` };
      // The first parent's layout says where this commit's pin is; a taken parent was checked before it, the trusted start wasn't.
      const before: Layout | null = layout(by(c));
      if (before === null) return { problem: ambiguous(parent === undefined ? label : `commit ${short(parent)}, which ${short(c.sha)} follows,`) };
      if (principal === EVALUATOR) {
        if (parent === undefined) return { problem: `${label} is the evaluator's; it needs one you sign` };
        const pinFile = pinPath(before);
        const why = evaluatorShape({ parents: c.parents.length, files: files.get(c.sha) ?? [], pinFile, after: pinText(c.sha, pinFile), before: pinText(parent, pinFile), afterMode: modeOf(`${c.sha}:${pinFile}`), beforeMode: modeOf(`${parent}:${pinFile}`) });
        if (why) return { problem: `evaluator commit ${short(c.sha)} ${why}` };
      }
      const after = layout(c.sha);
      if (after === null) return { problem: ambiguous(label) };
      // An empty package tree changes no file, but would move where the pin is read.
      if (principal === EVALUATOR && after !== before) return { problem: `evaluator commit ${short(c.sha)} changes the layout from ${before} to ${after}; only a commit you sign may` };
      taken.push({ sha: c.sha, parents: c.parents, principal, pinChanged: parent !== undefined && pinBlob(c.sha) !== pinBlob(parent) });
    }
    return { commits: taken };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Along `chain` (a tip's first parents, oldest first, from a commit whose pin is
 * trusted), what the tip's pin rests on: the newest commit on it the owner signed
 * that changes the pin over its own first parent (else the start), and the
 * evaluator commits on it since. A side branch's pin reaches the tip only through
 * an owner merge that changes the pin over its first parent, so no commit off the
 * chain vouches for one on it. `of`: takeHistory's commits by sha.
 */
export function pinBasis(chain: readonly string[], of: ReadonlyMap<string, Pick<TakenCommit, "principal" | "pinChanged">>): { trusted: string; bot: string[] } {
  let trusted = chain[0] ?? "";
  const bot: string[] = [];
  for (const sha of chain.slice(1)) {
    const commit = of.get(sha);
    if (commit?.principal === EVALUATOR) bot.push(sha);
    else if (commit?.pinChanged) {
      trusted = sha;
      bot.length = 0;
    }
  }
  return { trusted, bot };
}
