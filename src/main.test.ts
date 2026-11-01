// The entry point as a process: src/main.ts under a preload that refuses and
// records every filesystem change and child process, and lists the modules
// that load. It can also make the process look like root (PROBE_UID0) or like
// a single binary (PROBE_SEA: node:sea becomes a module whose isSea() says yes), neither of which a
// test can be for real.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "src", "main.ts");

const PRELOAD = `
import fs from "node:fs";
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
const tried = [];
const loaded = [];
const SEA = "data:text/javascript,export const isSea = () => true; export const getAsset = () => { throw new Error('probe: no assets'); };";
registerHooks({
  resolve: (specifier, context, next) => (specifier === "node:sea" && process.env.PROBE_SEA === "1" ? { url: SEA, shortCircuit: true } : next(specifier, context)),
  load(url, context, next) { if (url.startsWith("file:")) loaded.push(url); return next(url, context); },
});
const refuse = (what) => (target) => { tried.push(what + " " + String(target)); throw Object.assign(new Error("probe: " + what + " refused"), { code: "EPERM" }); };
for (const name of ["mkdirSync", "mkdtempSync", "writeFileSync", "appendFileSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "cpSync", "symlinkSync", "linkSync", "chmodSync", "chownSync", "truncateSync", "utimesSync", "mkdir", "mkdtemp", "writeFile", "appendFile", "rm", "rename", "chmod"]) fs[name] = refuse("fs." + name);
const openSync = fs.openSync;
fs.openSync = (file, flags = "r", ...rest) => (flags === "r" || flags === 0 ? openSync(file, flags, ...rest) : refuse("fs.openSync " + flags)(file));
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) childProcess[name] = refuse("child_process." + name);
if (process.env.PROBE_UID0 === "1") process.getuid = process.geteuid = () => 0;
syncBuiltinESMExports();
process.on("exit", () => fs.writeSync(2, "\\nPROBE " + JSON.stringify({ tried, loaded }) + "\\n"));
`;

/** Runs src/main.ts with `args` under the preload, from an empty folder; returns its exit code, output, what it tried and what loaded (paths in this repository). */
function probe(args: string[], env: Record<string, string> = {}) {
  const away = mkdtempSync(join(tmpdir(), "blacksand-entry-"));
  try {
    const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(PRELOAD)}`, MAIN, ...args], { cwd: away, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
    const line = result.stderr.split("\n").find((text) => text.startsWith("PROBE ")) ?? "PROBE null";
    const { tried, loaded } = JSON.parse(line.slice("PROBE ".length)) as { tried: string[]; loaded: string[] };
    return { exit: result.status, out: result.stdout, err: result.stderr.replace(line, "").trim(), tried, loaded: loaded.map((url) => fileURLToPath(url).slice(ROOT.length)) };
  } finally {
    rmSync(away, { recursive: true, force: true });
  }
}

test("help changes nothing on disk and starts nothing, wherever a leftover build role points", () => {
  for (const env of [{}, { BLACKSAND_T3_ROLE: "builder" }, { PROBE_SEA: "1", BLACKSAND_T3_ROLE: "builder" }]) {
    const help = probe(["--json", "help"], env);
    assert.deepEqual([help.exit, JSON.parse(help.out).schema, help.tried], [0, "blacksand.help/1", []], JSON.stringify(env));
  }
});

test("root is refused before any command's module loads", () => {
  for (const args of [["--json", "help"], ["verify"], ["t3", "status"]]) {
    const root = probe(args, { PROBE_UID0: "1", BLACKSAND_T3_ROLE: "builder" });
    assert.equal(root.exit, 4, args.join(" "));
    assert.deepEqual(root.tried, []);
    assert.deepEqual(root.loaded.sort(), ["package.json", "src/core/envelope.ts", "src/main.ts"]);
  }
  assert.match(probe(["help"], { PROBE_UID0: "1" }).err, /^blacksand: refusing to run as root/);
  assert.equal(JSON.parse(probe(["--json", "help"], { PROBE_UID0: "1" }).out).error.code, "root");
});

test("a single binary's verify refuses for want of a trust anchor, before it runs git or reads a history", () => {
  // From source, this clone (a repository with its own signed history) is what verify would read: the binary reads none.
  const sea = probe(["--json", "verify"], { PROBE_SEA: "1" });
  assert.equal(sea.exit, 4);
  assert.deepEqual(sea.tried, []);
  const envelope = JSON.parse(sea.out);
  assert.deepEqual([envelope.schema, envelope.error.code, envelope.checks], ["blacksand.error/1", "verify/no-anchor", undefined]);
  assert.match(envelope.error.text, /no trust anchor yet: blacksand init will record your signing key and first commit; until then, verify from a clone/);
  // The flag that once named another clone is gone: a usage error, still before git.
  const named = probe(["--json", "verify", "--repo", ROOT], { PROBE_SEA: "1" });
  assert.deepEqual([named.exit, JSON.parse(named.out).error.code, named.tried], [2, "usage", []]);
});
