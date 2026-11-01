// How property tests run (fast-check): a fixed seed and a few hundred cases in
// the fast tier, so the pre-push hook and CI see the same inputs every time; a
// fresh seed and many more cases in the deep tier, which searches. A failure
// names the seed and the shrunk case's path, and the command that replays it:
//   FUZZ_SEED=<seed> FUZZ_PATH=<path> node --test --test-name-pattern='^<test>$' <file>
// Generated inputs never reach the network, a subprocess with privileges, or
// the machine's own state: each property tests pure functions, or programs run
// only on files the test wrote into its own temporary folder.

import fc from "fast-check";

export type Tier = "fast" | "deep";

/** The fast tier's seed: any fixed number works, as long as it doesn't change by itself. */
const FAST_SEED = 20261031;

const replaySeed = process.env.FUZZ_SEED === undefined ? undefined : Number(process.env.FUZZ_SEED);
const replayPath = process.env.FUZZ_PATH;

export interface Runs {
  fast: number;
  deep: number;
  /** The deep tier stops a property after this long, whatever its count, so one loaded machine can't stretch the tier (default 6). */
  deepSeconds?: number;
}

/** A test's name as node:test gives it (TestContext): the replay command selects that test alone. */
export interface Named {
  name: string;
}

/** `name` as a --test-name-pattern that matches only it, quoted for a POSIX shell. */
const pattern = (name: string) => `'^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "'\\''")}$'`;

/** Runs `property` for `tier` as test `t`; throws, with the seed and how to replay just this test, on a counterexample. */
export async function check<T>(t: Named, tier: Tier, property: fc.IProperty<T> | fc.IAsyncProperty<T>, runs: Runs): Promise<void> {
  const seed = replaySeed ?? (tier === "fast" ? FAST_SEED : (Date.now() ^ (Math.random() * 2 ** 31)) | 0);
  const details = await fc.check(property, {
    seed,
    numRuns: runs[tier],
    ...(replayPath ? { path: replayPath, endOnFailure: true } : {}),
    ...(tier === "deep" ? { interruptAfterTimeLimit: (runs.deepSeconds ?? 6) * 1000, markInterruptAsFailure: false } : {}),
  });
  if (!details.failed) return;
  const replay = `FUZZ_SEED=${details.seed} FUZZ_PATH=${details.counterexamplePath ?? ""} node --test --test-name-pattern=${pattern(t.name)} <this file>`;
  const cause = details.errorInstance instanceof Error ? details.errorInstance : new Error(String(details.errorInstance));
  throw new Error(`${fc.defaultReportMessage(details) ?? "property failed"}\nfailed with: ${cause.message}\nreplay: ${replay}`, { cause });
}
