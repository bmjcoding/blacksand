// The GitHub API token lib/advisories.mjs sends to api.github.com, and how it
// reaches the Blacksand processes that need it without reaching anything they
// start. The advisory endpoints are public: any token, even one with no
// permissions, only raises the rate limit from 60 requests an hour per address.
//
// A process takes it, the first one found, when this module loads (before it
// starts anything) and again on each use:
//   - BLACKSAND_T3_GITHUB_TOKEN_FILE: a one-shot handoff file, deleted once read.
//     A Blacksand process writes one for its rerun and for the build account
//     (githubTokenHandoff); its environment names the file, never the token;
//   - BLACKSAND_T3_GITHUB_TOKEN: the token itself (CI passes the job's);
//   - state/github-token in this clone: the owner's own, kept (a Mac's way to
//     set one; create it with mode 0600).
// Both variables leave this process's environment as soon as they're read, so
// pnpm, upstream's build and whatever else it starts never inherit them. A
// file counts only when it's a regular file this account owns, opened without
// following a link, with no mode bits for anyone else; a handoff is written
// into a new folder of its own (writeHandoffFile).
//
// What this can't do is keep the token from code running as the same account.
// On macOS that account's `ps -E` shows the environment a process started
// with for as long as it runs, which is why a file is the handoff here. Code
// that can debug a process can read its memory, so a hostile build script in
// the build account (which runs upstream's build as itself), or in a CI job
// (which has sudo and the runner's own token), could take it. Give Blacksand a
// token that can do nothing else: GitHub's job token in these workflows is
// read-only, and on a Mac a fine-grained token with no permissions will do.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { STATE } from "./util.mjs";

export const TOKEN_ENV = "BLACKSAND_T3_GITHUB_TOKEN";
export const TOKEN_FILE_ENV = "BLACKSAND_T3_GITHUB_TOKEN_FILE";
/** The owner's own token file on a machine: kept, never deleted. */
export const OWN_TOKEN_FILE = path.join(STATE, "github-token");
/** What a GitHub token looks like (ghp_, github_pat_, ghs_ ...); anything else could split the header. */
const TOKEN = /^[A-Za-z0-9_.-]{1,512}$/;

let held = null;
let problem = null;

/**
 * Writes `content` to a new file `token` in a new folder under `parent`, both
 * this account's alone: the folder 0700, the file 0600, created exclusively
 * and without following a link (O_EXCL | O_NOFOLLOW). Returns the file's path.
 * `deps`: { fs, path }. Self-contained, so the build account runs this very
 * code to make its own handoff (lib/builder.mjs).
 */
export function writeHandoffFile(deps, parent, content) {
  const { fs, path } = deps;
  const dir = fs.mkdtempSync(path.join(parent, "t3b-github-token-"));
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "token");
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return file;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The token in file `file`, or why not. It's opened without following a link,
 * and must be a regular file this account owns, with no permission bits for
 * anyone else.
 */
function readTokenFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(error.code === "ELOOP" ? `${file} isn't a regular file` : `${file} can't be read (${error.code ?? error.message})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} isn't a regular file`);
    if (stat.uid !== process.getuid()) throw new Error(`${file} isn't this account's`);
    if (stat.mode & 0o077) throw new Error(`${file} can be read or written by others (chmod 600 it)`);
    const token = fs.readFileSync(fd, "utf8").trim();
    if (!TOKEN.test(token)) throw new Error(`${file} doesn't hold a GitHub token`);
    return token;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The token, or null. Takes what the environment hands over (a handoff file,
 * deleted once read, or the variable), else reads the owner's file. One that
 * isn't usable is no token, and githubTokenProblem() says why: requests go
 * unauthenticated (only slower to the rate limit), and nothing fails to start.
 */
export function githubToken() {
  const handoff = process.env[TOKEN_FILE_ENV];
  const value = process.env[TOKEN_ENV];
  delete process.env[TOKEN_FILE_ENV];
  delete process.env[TOKEN_ENV];
  const take = (read) => {
    try {
      held = read();
      problem = null;
    } catch (error) {
      held = null;
      problem = error.message;
    }
  };
  if (handoff !== undefined && handoff !== "") {
    take(() => {
      try {
        return readTokenFile(handoff);
      } finally {
        fs.rmSync(handoff, { force: true });
      }
    });
  } else if (value !== undefined) {
    take(() => {
      const token = value.trim();
      if (token && !TOKEN.test(token)) throw new Error(`${TOKEN_ENV} doesn't hold a GitHub token`);
      return token || null;
    });
  } else if (held === null && problem === null && fs.existsSync(OWN_TOKEN_FILE)) {
    take(() => readTokenFile(OWN_TOKEN_FILE));
  }
  return held;
}

/** Why a token that was handed over or found isn't used, or null. */
export const githubTokenProblem = () => problem;

/** Forgets the token (tests). */
export const forgetGithubToken = () => {
  held = null;
  problem = null;
};

/** Writes `token` for a child of this account (writeHandoffFile, in a temporary folder); returns { file, remove }. */
function writePrivate(token) {
  const file = writeHandoffFile({ fs, path }, os.tmpdir(), `${token}\n`);
  return { file, remove: () => fs.rmSync(path.dirname(file), { recursive: true, force: true }) };
}

/**
 * writeHandoffFile as a script for `node -e` (the build account's, lib/builder.mjs):
 * the folder to make it in is its argument, the token its standard input, and
 * it prints the file's path.
 */
export const HANDOFF_WRITER_SCRIPT = [
  `const writeHandoffFile = ${writeHandoffFile};`,
  `const fs = require("node:fs");`,
  `process.stdout.write(writeHandoffFile({ fs, path: require("node:path") }, process.argv[1], fs.readFileSync(0, "utf8")));`,
].join("\n");

/**
 * A one-shot handoff of the token to a Blacksand process this one is about to
 * start: { env: { BLACKSAND_T3_GITHUB_TOKEN_FILE }, remove() }, or null when
 * there's no token. The child reads the file and deletes it as it starts;
 * remove() cleans up after a child that never did. `write(token)` -> { file,
 * remove } puts it where the child can read it (the build account's own
 * folder, say); by default a private temporary folder of this account's.
 */
export function githubTokenHandoff({ write = writePrivate } = {}) {
  const token = githubToken();
  if (!token) return null;
  const { file, remove } = write(token);
  return { env: { [TOKEN_FILE_ENV]: file }, remove };
}

githubToken();
