// The run's patch, made outside the sandbox by git the agent never touched.
//
// Inputs: the bundle of the original base (made by the runner before the
// run) and a tar of the frozen workspace's files (every .git left out). Both
// go into a fresh bare repository with no user or system config, no hooks,
// no replace objects and no attributes from the tree: the tar is read here
// and written straight into git's object store with fast-import, never
// extracted onto disk. The patch is base → exported tree.
//
// New files the export's own .gitignore files ignore are left out (build
// output, dependencies). A file the base tracks is always compared, ignore
// rules or not, and the .gitignore files are themselves in the diff, so no
// rule the agent writes can hide a change to the repository.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class CollectError extends Error {}

export interface TarEntry {
  path: string;
  kind: "file" | "symlink" | "dir" | "hardlink" | "other";
  executable: boolean;
  offset: number;
  size: number;
  link: string;
}

const BLOCK = 512;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function octal(header: Buffer, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    let value = 0; // base-256, for sizes over 8 GiB
    for (let i = 1; i < field.length; i++) value = value * 256 + (field[i] ?? 0);
    return value;
  }
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

const cstring = (header: Buffer, start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");

/** The entries of a POSIX (pax) or ustar archive. Throws on anything malformed. */
export function readTar(file: string): TarEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const total = fs.fstatSync(fd).size;
    const entries: TarEntry[] = [];
    const header = Buffer.alloc(BLOCK);
    let at = 0;
    let pax: Record<string, string> = {};
    for (;;) {
      if (at + BLOCK > total) throw new CollectError("the export ends without its closing blocks");
      fs.readSync(fd, header, 0, BLOCK, at);
      if (header.every((b) => b === 0)) return entries;
      if (cstring(header, 257, 5) !== "ustar") throw new CollectError("the export isn't a ustar/pax archive");
      let checksum = 0;
      for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
      if (checksum !== octal(header, 148, 8)) throw new CollectError("the export has a corrupt header");
      const type = String.fromCharCode(header[156] ?? 48);
      const size = pax.size !== undefined ? Number(pax.size) : octal(header, 124, 12);
      const offset = at + BLOCK;
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > total) throw new CollectError("the export has an entry past its end");
      at = offset + Math.ceil(size / BLOCK) * BLOCK;
      if (type === "x") {
        pax = parsePax(fd, offset, size);
        continue;
      }
      if (type === "g") continue;
      const prefix = cstring(header, 345, 155);
      const name = pax.path ?? (prefix ? `${prefix}/${cstring(header, 0, 100)}` : cstring(header, 0, 100));
      const link = pax.linkpath ?? cstring(header, 157, 100);
      pax = {};
      const kind = type === "0" || type === "\0" || type === "7" ? "file" : type === "2" ? "symlink" : type === "5" ? "dir" : type === "1" ? "hardlink" : "other";
      entries.push({ path: name, kind, executable: (octal(header, 100, 8) & 0o111) !== 0, offset, size, link });
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parsePax(fd: number, offset: number, size: number): Record<string, string> {
  const data = Buffer.alloc(size);
  fs.readSync(fd, data, 0, size, offset);
  const records: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const length = Number(data.subarray(i, space).toString("latin1"));
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0 || i + length > data.length) throw new CollectError("the export has a corrupt pax header");
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    records[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return records;
}

/** A repository-relative path from the export, or null if it's one git can't or mustn't hold. */
export function cleanPath(raw: string): string | null {
  const p = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (!p || p === "." || p.startsWith("/") || p.includes("\0") || p.includes("\n")) return null;
  const parts = p.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  return p;
}

/** C-style quoting, which fast-import accepts for any path. */
function quote(p: string): string {
  let out = '"';
  for (const byte of Buffer.from(p, "utf8")) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

export interface Collected {
  patch: Buffer;
  files: number;
  /** New files left out because the exported .gitignore files ignore them. */
  ignored: number;
  /** New entries a patch can't hold (devices, pipes, sockets, paths git refuses). A tracked file among them fails collection instead. */
  skipped: number;
}

/** The patch from `base` (inside `bundle`) to the exported tree in `exportTar`. */
export function collectPatch(bundle: Buffer, base: string, exportTar: string): Collected {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new CollectError("the base isn't a commit id");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-collect-"));
  try {
    const gitDir = path.join(tmp, "git");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    /** `stdin`: a file descriptor to read from, for input too big to hold. */
    const git = (args: string[], stdin?: number) => {
      const r = spawnSync("git", ["--git-dir", gitDir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", `attr.tree=${EMPTY_TREE}`, ...args], { env, stdio: [stdin ?? "ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
      if (r.status !== 0) throw new CollectError(`git ${args[0]} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
      return r.stdout;
    };
    const init = spawnSync("git", ["init", "--quiet", "--bare", gitDir], { env });
    if (init.status !== 0) throw new CollectError("git init failed");
    const bundleFile = path.join(tmp, "base.bundle");
    fs.writeFileSync(bundleFile, bundle);
    git(["fetch", "--quiet", "--no-tags", bundleFile, "HEAD"]);
    if (git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).toString().trim() !== base) throw new CollectError("the bundle's HEAD isn't the run's base");
    const tracked = new Set(git(["ls-tree", "-r", "-z", "--name-only", base]).toString("utf8").split("\0").filter(Boolean));

    const entries = readTar(exportTar);
    let skipped = 0;
    const kept = new Map<string, TarEntry>();
    for (const e of entries) {
      if (e.kind === "dir") continue;
      // The exporter dereferences hard links (GNU tar --hard-dereference), so every name carries its own bytes. A link entry means this archive didn't come from it.
      if (e.kind === "hardlink") throw new CollectError("the export has a hard-link entry: it didn't come from the run's exporter");
      const p = cleanPath(e.path);
      if (p && e.kind === "other" && tracked.has(p)) throw new CollectError("a file the base tracks is a device, pipe or socket in the export: its contents can't be compared");
      if (!p || e.kind === "other") {
        skipped++;
        continue;
      }
      kept.set(p, e); // a later entry for the same path wins, as extraction would
    }

    // .gitignore rules from the export only, read by git from a scratch tree that holds nothing else.
    const ruleTree = path.join(tmp, "rules");
    fs.mkdirSync(ruleTree);
    const fd = fs.openSync(exportTar, "r");
    const read = (e: TarEntry) => {
      const data = Buffer.alloc(e.size);
      fs.readSync(fd, data, 0, e.size, e.offset);
      return data;
    };
    let ignored = 0;
    try {
      for (const [p, e] of kept) {
        if (path.posix.basename(p) !== ".gitignore" || e.kind !== "file" || e.size > 1024 * 1024) continue;
        fs.mkdirSync(path.join(ruleTree, path.dirname(p)), { recursive: true });
        fs.writeFileSync(path.join(ruleTree, p), read(e), { flag: "wx" });
      }
      const candidates = [...kept.keys()].filter((p) => !tracked.has(p));
      if (candidates.length) {
        const check = spawnSync("git", ["--git-dir", gitDir, "--work-tree", ruleTree, "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"], { env, input: `${candidates.join("\0")}\0`, maxBuffer: 256 * 1024 * 1024 });
        if (check.status !== 0 && check.status !== 1) throw new CollectError(`git check-ignore failed: ${check.stderr.toString().trim().slice(0, 300)}`);
        for (const p of check.stdout.toString("utf8").split("\0").filter(Boolean)) if (kept.delete(p)) ignored++;
      }

      // The exported tree as one commit, written by fast-import from the archive's bytes.
      const stream = path.join(tmp, "import");
      const out = fs.openSync(stream, "w");
      try {
        fs.writeSync(out, `commit refs/heads/export\ncommitter blacksand <blacksand@blacksand.invalid> 0 +0000\ndata 7\nexport\nfrom ${base}\ndeleteall\n`);
        for (const [p, e] of [...kept].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (e.kind === "symlink") {
            const target = Buffer.from(e.link, "utf8");
            fs.writeSync(out, `M 120000 inline ${quote(p)}\ndata ${target.length}\n`);
            fs.writeSync(out, target);
          } else {
            fs.writeSync(out, `M ${e.executable ? "100755" : "100644"} inline ${quote(p)}\ndata ${e.size}\n`);
            fs.writeSync(out, read(e));
          }
          fs.writeSync(out, "\n");
        }
      } finally {
        fs.closeSync(out);
      }
      const input = fs.openSync(stream, "r");
      try {
        git(["fast-import", "--quiet"], input);
      } finally {
        fs.closeSync(input);
      }
    } finally {
      fs.closeSync(fd);
    }
    const patch = git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, "refs/heads/export"]);
    return { patch, files: (patch.toString("latin1").match(/^diff --git /gm) ?? []).length, ignored, skipped };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
