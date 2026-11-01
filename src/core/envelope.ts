// What every command prints with --json: one object whose `schema` names its
// shape and major version (blacksand.<kind>/<major>). A consumer refuses a
// schema it doesn't know; a change that would break a consumer bumps the major.

import pkg from "../../package.json" with { type: "json" };

import type { Plan } from "./plan.ts";
import type { Resource } from "./resource.ts";

export const SCHEMA = {
  status: "blacksand.status/1",
  verify: "blacksand.verify/1",
  plan: "blacksand.plan/1",
  help: "blacksand.help/1",
  error: "blacksand.error/1",
} as const;

export type Schema = (typeof SCHEMA)[keyof typeof SCHEMA];

/**
 * Exit codes every command keeps: 0 passed, 1 drift, 2 usage, 3 held, 4 refused
 * (a guard said no, there was nothing to compare against, or the command failed).
 */
export const EXIT = { ok: 0, drift: 1, usage: 2, held: 3, refused: 4 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type PlatformId = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

/** Which blacksand produced the output. `commit`: the verified tree's commit, null until the trust code supplies it. */
export interface BlacksandInfo {
  version: string;
  commit: string | null;
}

export interface Warning {
  /** Stable, `area/name`; text can change, codes don't. */
  code: string;
  text: string;
}

export interface StatusEnvelope {
  schema: typeof SCHEMA.status;
  blacksand: BlacksandInfo;
  platform: PlatformId;
  node: string;
  privileged: boolean;
  /** What discovery saw: users, groups, jobs, sshd, firewall, disk encryption, Tailscale and tools, sorted by id. */
  resources: Resource[];
  warnings: Warning[];
}

export interface Check {
  id: string;
  ok: boolean;
  text: string;
}

export interface VerifyEnvelope {
  schema: typeof SCHEMA.verify;
  blacksand: BlacksandInfo;
  result: "passed" | "drift" | "refused";
  checks: Check[];
  warnings: Warning[];
}

export interface CommandSummary {
  name: string;
  summary: string;
  usage: string;
}

export interface HelpEnvelope {
  schema: typeof SCHEMA.help;
  blacksand: BlacksandInfo;
  commands: CommandSummary[];
}

export interface ErrorEnvelope {
  schema: typeof SCHEMA.error;
  blacksand: BlacksandInfo;
  error: { code: string; text: string };
}

export type Envelope = StatusEnvelope | VerifyEnvelope | Plan | HelpEnvelope | ErrorEnvelope;

export const blacksandInfo = (): BlacksandInfo => ({ version: pkg.version, commit: null });

export const errorEnvelope = (code: string, text: string): ErrorEnvelope => ({ schema: SCHEMA.error, blacksand: blacksandInfo(), error: { code, text } });
