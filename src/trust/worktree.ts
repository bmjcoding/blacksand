// Whether a clone's working tree is a commit's tree: the files on disk, byte for
// byte and mode for mode, against the commit's own blobs. Not `git status`,
// which trusts the index (assume-unchanged and skip-worktree flags hide edits),
// runs clean filters (which can turn changed bytes back into the commit's), and
// follows core.worktree to another folder. So none of those is modelled: a clone
// that uses one is refused, and so is a symlink or a submodule in the tree,
// which this doesn't compare.
//
// Outside the comparison: paths the tree doesn't have that its own .gitignore
// files (byte-checked here, being in the tree), .git/info/exclude or the clone's
// core.excludesFile ignore, such as node_modules/ and tooling/t3code/{build,state,upstream}/.
// They're reported; no verified code imports them.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { REGULAR, out, type Git } from "./git.ts";

export interface WorkingTree {
  /** Why the comparison wasn't made, or null when it was. */
  refused: string | null;
  /** Paths that differ from the commit: changed, missing, or there and not ignored. */
  differs: string[];
  /** Paths outside the comparison: not in the commit, and ignored. */
  outside: string[];
}

const EXECUTABLE = "100755";

/** Settings in the clone's own configuration that change what a checkout holds, or where. */
const CHECKOUT_KEY = /^(?:core\.worktree|core\.sparsecheckout|core\.sparsecheckoutcone|filter\..+)$/;

/** Why the clone checks out other than plainly into `git.repo`, or null. */
function unsupported(git: Git): string | null {
  const top = out(git, ["rev-parse", "--show-toplevel"]);
  if (top === null || path.resolve(top) !== fs.realpathSync(git.repo)) return `git reads ${top ?? "no"} working tree, not ${git.repo}`;
  const listed = git.text(["config", "--list", "--show-scope", "--includes", "-z"]);
  if (listed.status !== 0) return "this clone's git configuration can't be read";
  // -z: scope NUL key LF value NUL, a value-less key without the LF.
  const parts = listed.stdout.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = (parts[i + 1] ?? "").split("\n")[0] ?? "";
    if (CHECKOUT_KEY.test(key)) return `this clone sets ${key}, which this check doesn't model`;
  }
  // The index's flags: lowercase is assume-unchanged, S skip-worktree.
  const flags = git.text(["ls-files", "-v", "-z"]);
  if (flags.status !== 0) return "this clone's index can't be read";
  const flagged = flags.stdout.split("\0").find((entry) => /^(?:[a-z]|S) /.test(entry));
  if (flagged) return `${flagged.slice(2)} is marked ${flagged.startsWith("S") ? "skip-worktree" : "assume-unchanged"} in the index, which this check doesn't model`;
  return null;
}

/** The blob id git would give `bytes`, in the clone's object format. */
const blobId = (format: string, bytes: Buffer) => createHash(format === "sha256" ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** `commit`'s tree compared with the files under `git.repo`. */
export function compareWorktree(git: Git, commit: string): WorkingTree {
  const refuse = (why: string): WorkingTree => ({ refused: why, differs: [], outside: [] });
  const why = unsupported(git);
  if (why) return refuse(why);
  const format = out(git, ["rev-parse", "--show-object-format"]) ?? "";
  const listed = git.text(["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (listed.status !== 0 || !["sha1", "sha256"].includes(format)) return refuse(`${commit.slice(0, 10)}'s tree can't be read`);
  // "mode type id\tpath" per blob; folders only as the paths they hold.
  const tree = new Map<string, { mode: string; id: string }>();
  const folders = new Set<string>();
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode = "", , id = ""] = entry.slice(0, tab).split(" ");
    const name = entry.slice(tab + 1);
    if (mode !== REGULAR && mode !== EXECUTABLE) return refuse(`${commit.slice(0, 10)} has ${name} as mode ${mode}, which this check doesn't compare`);
    tree.set(name, { mode, id });
    for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) folders.add(name.slice(0, at));
  }
  const differs: string[] = [];
  const extra: string[] = [];
  const seen = new Set<string>();
  // Folders the tree has are walked without following symlinks; anything else on disk is an extra.
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(path.join(git.repo, folder), { withFileTypes: true })) {
      const name = folder ? `${folder}/${entry.name}` : entry.name;
      if (!folder && entry.name === ".git") continue;
      if (entry.isDirectory() && folders.has(name)) walk(name);
      else if (entry.isFile() && tree.has(name)) {
        seen.add(name);
        const file = path.join(git.repo, name);
        const want = tree.get(name);
        const mode = fs.lstatSync(file).mode & 0o100 ? EXECUTABLE : REGULAR;
        if (mode !== want?.mode || blobId(format, fs.readFileSync(file)) !== want.id) differs.push(name);
      } else extra.push(entry.isDirectory() ? `${name}/` : name);
    }
  };
  walk("");
  for (const name of tree.keys()) if (!seen.has(name)) differs.push(name);
  // Of the extras, the ignored ones are outside the comparison; the rest differ.
  const outside = new Set<string>();
  if (extra.length) {
    const ignored = git.text(["check-ignore", "--no-index", "-z", "--stdin"], { input: `${extra.join("\0")}\0` });
    if (ignored.status !== 0 && ignored.status !== 1) return refuse("which paths this clone ignores can't be read");
    for (const name of ignored.stdout.split("\0").filter(Boolean)) outside.add(name);
  }
  differs.push(...extra.filter((name) => !outside.has(name)));
  return { refused: null, differs: differs.sort(), outside: [...outside].sort() };
}
