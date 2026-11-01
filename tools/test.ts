// Runs a test tier: node tools/test.ts fast|deep|all [node --test options]
//
// Test files are *.test.ts beside the code (src/, tools/) and *.test.mjs or
// *.test.ts in a package's test/ folder. A file named *.deep.test.* is deep;
// every other one is fast.
// - fast (npm test, the pre-push hook): under 10 s on the owner's Mac. Nothing
//   waits on wall time (inject a Clock from src/core/clock.ts, or use
//   mock.timers); no signed git histories, installer runs or property sweeps.
// - deep (npm run test:deep): what fast leaves out. A test that outgrows the
//   fast tier moves to a *.deep.test.* file, with the reason in its header.
// Each file runs in its own process, as many at once as there are cores:
// --test-isolation=none measured slower here, since it runs files one at a time.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAST_BUDGET_MS = 10_000;
const TIERS = ["fast", "deep", "all"] as const;
type Tier = (typeof TIERS)[number];

const isTest = (name: string) => /\.test\.(?:ts|mjs)$/.test(name);
const isDeep = (name: string) => /\.deep\.test\.(?:ts|mjs)$/.test(name);

/** Every test file under `dir`, recursively. */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && isTest(entry.name) ? [full] : [];
  });
}

/** A package's test/ folder, not its subfolders (test/stripped/ holds upstream's tests). */
function packageTests(pkg: string): string[] {
  const dir = path.join(ROOT, "packages", pkg, "test");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && isTest(e.name)).map((e) => path.join(dir, e.name));
}

export function testFiles(tier: Tier): string[] {
  const all = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "tools")), ...fs.readdirSync(path.join(ROOT, "packages")).flatMap(packageTests)];
  return all.filter((file) => tier === "all" || isDeep(file) === (tier === "deep")).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tier, ...options] = process.argv.slice(2);
  if (!TIERS.includes(tier as Tier)) {
    console.error(`usage: node tools/test.ts ${TIERS.join("|")} [node --test options]`);
    process.exit(2);
  }
  const files = testFiles(tier as Tier).map((file) => path.relative(ROOT, file));
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${os.availableParallelism()}`, ...options, ...files], { cwd: ROOT, stdio: "inherit" });
  const ms = Math.round(performance.now() - started);
  console.error(`${tier} tier: ${files.length} files in ${(ms / 1000).toFixed(1)} s`);
  if (tier === "fast" && ms > FAST_BUDGET_MS) console.error(`the fast tier took over ${FAST_BUDGET_MS / 1000} s: move the slowest tests to a *.deep.test.* file`);
  process.exit(result.status ?? 1);
}
