// What discovery may do to the machine: run a program by its absolute path and
// read files. Nothing else, and nothing that changes anything: every program
// discovery runs is a read-only query (each adapter lists its own). Tests pass
// a fake Host; systemHost is the only one that touches the real machine.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { aclProblem } from "../../tooling/blacksand-t3/lib/pnpm.mjs";
import type { PlatformId } from "../core/envelope.ts";
import { platformId } from "./index.ts";

export interface Output {
  /** The exit status, or null when the program didn't run or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Why it didn't run or finish: not found, refused, timed out. */
  error?: string;
}

export type Read = { ok: true; bytes: Buffer } | { ok: false; why: "missing" | "denied" | "other" };

export interface Host {
  platform: PlatformId;
  /** The user discovery runs as; as root, it runs no program that anyone else could have replaced. */
  uid: number;
  home: string;
  /** The Node running blacksand. */
  node: { path: string; version: string };
  /** Runs `file` (an absolute path) with `args`: no shell, a fixed environment (plus `env`), no stdin, a deadline. */
  exec(file: string, args: readonly string[], env?: { readonly [name: string]: string }): Output;
  read(file: string): Read;
  /** Whether `file` exists (following links), without reading it. */
  exists(file: string): boolean;
  /** Where `file` leads once every link is followed; null when it doesn't exist. */
  realpath(file: string): string | null;
}

/**
 * The environment every program gets: Apple's and the distribution's own
 * folders, and the C locale, so output parses the same everywhere. No HOME and
 * nothing of the caller's: a program reads no user configuration and inherits
 * no token.
 */
export const EXEC_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C" } as const;

const DEADLINE_MS = 5_000;

/** Runs one of the OS's own programs the way exec does: the fixed environment, no stdin, the deadline. */
const cleanRun = (file: string, args: readonly string[], options: { encoding: "utf8" }) =>
  spawnSync(file, args, { ...options, env: EXEC_ENV, cwd: "/", stdio: ["ignore", "pipe", "pipe"], timeout: DEADLINE_MS, killSignal: "SIGKILL" });

/** Why `at`'s access control list could let someone other than root change it (tooling/blacksand-t3/lib/pnpm.mjs, Apple's ls), or null. */
const cleanAcl = (at: string) => aclProblem(at, { run: cleanRun });

export interface RootChecks {
  lstat?: (at: string) => fs.Stats;
  acl?: (at: string) => string | null;
}

/**
 * Why root mustn't run `file`, or null. Every name on its path, from `/` down,
 * must be a real folder (the last a regular executable file), root's, writable
 * by no group or other, with no access control list granting more, and no
 * symbolic link anywhere: a link in a folder someone else can write could
 * point at a safe program while checked and at theirs when run. Root running
 * a program its user can replace would hand that user root (a Homebrew git, say).
 */
export function rootRunProblem(file: string, { lstat = fs.lstatSync, acl = cleanAcl }: RootChecks = {}): string | null {
  if (!path.isAbsolute(file) || path.posix.normalize(file) !== file) return `${file} isn't a plain absolute path`;
  const parts = file.split("/").filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const at = `/${parts.slice(0, i).join("/")}`;
    const last = i === parts.length;
    let s: fs.Stats;
    try {
      s = lstat(at);
    } catch {
      return `${at} doesn't exist`;
    }
    if (s.isSymbolicLink()) return `${at} is a symbolic link`;
    if (last ? !s.isFile() : !s.isDirectory()) return `${at} isn't a ${last ? "regular file" : "folder"}`;
    if (s.uid !== 0) return `${at} isn't root's`;
    if (s.mode & 0o022) return `${at} is writable by others`;
    if (last && !(s.mode & 0o111)) return `${at} isn't executable`;
    const problem = acl(at);
    if (problem) return `${at} ${problem}`;
  }
  return null;
}

function exec(uid: number, checked: Map<string, string | null>, file: string, args: readonly string[], env: { readonly [name: string]: string } = {}): Output {
  if (!path.isAbsolute(file)) return { status: null, stdout: "", stderr: "", error: `${file} isn't an absolute path` };
  if (uid === 0) {
    if (!checked.has(file)) checked.set(file, rootRunProblem(file));
    const problem = checked.get(file);
    if (problem) return { status: null, stdout: "", stderr: "", error: `not run as root: ${problem}` };
  }
  const result = spawnSync(file, args, {
    env: { ...env, ...EXEC_ENV },
    cwd: "/",
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: DEADLINE_MS,
    killSignal: "SIGKILL",
    maxBuffer: 16 << 20,
    shell: false,
  });
  const error = result.error ? ((result.error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : result.error.message) : result.signal ? `killed by ${result.signal}` : undefined;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(error ? { error } : {}) };
}

function read(file: string): Read {
  try {
    return { ok: true, bytes: fs.readFileSync(file) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, why: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "EACCES" || code === "EPERM" ? "denied" : "other" };
  }
}

export function systemHost(): Host {
  const uid = process.getuid?.() ?? -1;
  /** As root: each program's rootRunProblem, checked once per run. */
  const checked = new Map<string, string | null>();
  return {
    platform: platformId(),
    uid,
    home: os.homedir(),
    node: { path: process.execPath, version: process.version },
    exec: (file, args, env) => exec(uid, checked, file, args, env),
    read,
    exists: (file) => fs.existsSync(file),
    realpath: (file) => {
      try {
        return fs.realpathSync(file);
      } catch {
        return null;
      }
    },
  };
}
