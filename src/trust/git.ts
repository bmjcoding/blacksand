// Git, for reading a clone's own history: a subprocess per call, under rules that
// keep this machine's configuration and environment from deciding what's read.
// No global or system configuration (a signing program, an fsmonitor command, a
// URL rewrite), nothing GIT_* from the environment (GIT_DIR in a hook's
// environment would point every call at another repository), nothing that can
// prompt or reach an SSH agent, and no lazy fetch: verifying never touches the
// network, so a blobless clone's missing file is refused, not fetched; it takes
// no optional lock, so it writes nothing to the clone; and no replace refs or
// grafts file stand other commits in for the ones the history has.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const FALSE = ["/usr/bin/false", "/bin/false"].find((file) => fs.existsSync(file)) ?? "false";

/** How long a call may run, in ms, unless it says otherwise. */
const DEADLINE = 60_000;

export interface GitResult<T> {
  status: number | null;
  stdout: T;
  stderr: string;
}

export interface GitCall {
  /** Written to git's stdin. */
  input?: string;
  timeout?: number;
}

/** Git in one repository (`repo`, its working tree): `text` for output read as UTF-8, `bytes` for raw objects. */
export interface Git {
  readonly repo: string;
  text(args: readonly string[], call?: GitCall): GitResult<string>;
  bytes(args: readonly string[], call?: GitCall): GitResult<Buffer>;
}

/** `env` without anything that configures git or reaches an SSH agent, and with no global or system configuration. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !name.startsWith("GIT_") && !["SSH_ASKPASS", "SSH_AUTH_SOCK", "GCM_INTERACTIVE"].includes(name));
  return {
    ...Object.fromEntries(kept),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: FALSE,
    GIT_SSH_COMMAND: FALSE,
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_NO_LAZY_FETCH: "1",
    // Reading takes no lock and writes nothing.
    GIT_OPTIONAL_LOCKS: "0",
    // The commits themselves, not what refs/replace or info/grafts say they are.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
  };
}

/** Options for every call: no hooks or fsmonitor program (commands that read the index can run it), signatures shown only when asked for. */
const CONFIG = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "log.showSignature=false"].flatMap((option) => ["-c", option]);

/** Git in `repo`, under the rules above. */
export function localGit(repo: string, env: NodeJS.ProcessEnv = process.env): Git {
  const clean = gitEnv(env);
  const run = (args: readonly string[], call: GitCall, encoding: "utf8" | "buffer") =>
    spawnSync("git", [...CONFIG, "-C", repo, ...args], { encoding, input: Buffer.from(call.input ?? ""), timeout: call.timeout ?? DEADLINE, maxBuffer: 64 << 20, env: clean });
  return {
    repo,
    text(args, call = {}) {
      const result = run(args, call, "utf8");
      return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    },
    bytes(args, call = {}) {
      const result = run(args, call, "buffer");
      return { status: result.status, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0), stderr: String(result.stderr ?? "") };
    },
  };
}

/** `args`'s output, trimmed, or null when git fails. */
export function out(git: Git, args: readonly string[]): string | null {
  const result = git.text(args);
  return result.status === 0 ? result.stdout.trim() : null;
}

export interface GitObject {
  type: string;
  bytes: Buffer;
}

/** `git cat-file --batch` over `names` (objects, or rev:path): name -> object, without the missing; null when git fails. */
export function catBatch(git: Git, names: readonly string[]): Map<string, GitObject> | null {
  const found = new Map<string, GitObject>();
  if (!names.length) return found;
  const result = git.bytes(["cat-file", "--batch"], { input: names.map((name) => `${name}\n`).join("") });
  if (result.status !== 0) return null;
  const buffer = result.stdout;
  let at = 0;
  for (const name of names) {
    const end = buffer.indexOf(10, at);
    if (end < 0) return null;
    const header = buffer.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header.length !== 3) continue;
    const size = Number(header[2]);
    found.set(name, { type: header[1] ?? "", bytes: buffer.subarray(at, at + size) });
    at += size + 1;
  }
  return found;
}

export interface ObjectId {
  id: string;
  type: string;
  /** The tree-entry mode a rev:path name has (100644 a regular file, 120000 a symlink); "" for a bare object. */
  mode: string;
}

/** The tree-entry mode of a regular, non-executable file. */
export const REGULAR = "100644";

/** What each of `names` (rev:path) names, by `git cat-file --batch-check`: name -> { id, type, mode }, or null where there's nothing; null when git fails. */
export function objectIds(git: Git, names: readonly string[]): Map<string, ObjectId | null> | null {
  if (!names.length) return new Map();
  const result = git.text(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectmode)"], { input: names.map((name) => `${name}\n`).join("") });
  const lines = result.status === 0 ? result.stdout.split("\n") : [];
  if (lines.length < names.length) return null;
  return new Map(
    names.map((name, i) => {
      const [id = "", type = "", mode = ""] = (lines[i] ?? "").split(" ");
      return [name, type === "missing" || type === "ambiguous" || !type ? null : { id, type, mode }];
    }),
  );
}
