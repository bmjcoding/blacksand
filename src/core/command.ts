// The shape of a blacksand command, and what it's given: everything it reads
// from or does to the outside comes through the Context, so tests pass fakes.

import { spawnSync } from "node:child_process";

import { systemClock, type Clock } from "./clock.ts";
import type { Host } from "../platform/host.ts";
import type { HeadCheck } from "../trust/check.ts";
import { EXIT, errorEnvelope, type Envelope, type ExitCode } from "./envelope.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Runs a program with the caller's stdio and waits for it; tests pass one that records argv. */
export type Runner = (command: string, args: readonly string[]) => { status: number | null; signal: NodeJS.Signals | null };

export interface Context {
  /** --json: print the envelope instead of text. */
  json: boolean;
  io: Io;
  clock: Clock;
  run: Runner;
  /** What discovery reads the machine through; systemHost() when not given. */
  host?: Host;
  /** How verify checks the clone it runs from; checkHead on that clone when not given. */
  headCheck?: () => HeadCheck;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** Hands every argument to the command untouched, --json and --help included (a package's own CLI). */
  passthrough?: boolean;
  /** Returns the exit code (EXIT, or a package CLI's own). */
  run(args: readonly string[], ctx: Context): Promise<number>;
}

const runInherit: Runner = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  return { status: result.status, signal: result.signal };
};

export const processContext = (json: boolean): Context => ({
  json,
  io: { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
  clock: systemClock,
  run: runInherit,
});

/** Prints `envelope` with --json, else `text`, and returns `exit`. */
export function emit(ctx: Context, envelope: Envelope, text: string, exit: ExitCode): number {
  ctx.io.out(ctx.json ? `${JSON.stringify(envelope, null, 2)}\n` : `${text}\n`);
  return exit;
}

/** A usage error: the error envelope with --json, else `text` on stderr. Returns EXIT.usage. */
export function usageError(ctx: Context, text: string): number {
  if (ctx.json) ctx.io.out(`${JSON.stringify(errorEnvelope("usage", text), null, 2)}\n`);
  else ctx.io.err(`blacksand: ${text}\n`);
  return EXIT.usage;
}
