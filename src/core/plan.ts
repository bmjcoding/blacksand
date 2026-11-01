// blacksand.plan/1: what `blacksand plan` proposes and `sudo blacksand apply`
// takes. A plan is a file anyone (an agent included) can write, so apply reads
// it only through parsePlan: every field checked, nothing extra kept.

import { SCHEMA, type BlacksandInfo, type PlatformId, type Warning } from "./envelope.ts";

export type Role = "desktop" | "host" | "proxy" | "single";

/** `unknown`: a step whose current state can't be seen without root (plan as root to see it). */
export type StepAction = "create" | "update" | "remove" | "unknown";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Step {
  /** `<resource kind>/<name>`, unique in the plan, e.g. `account/agent-work`. */
  id: string;
  action: StepAction;
  /** Whether the step gives anyone more access than before; apply lists these first. */
  widens_access: boolean;
  summary: string;
  /** The resource's desired state after the step. */
  after: { [key: string]: Json };
  /** Why the step is in the plan: the config entry or package that asks for it. */
  reason: string;
}

export interface Plan {
  schema: typeof SCHEMA.plan;
  blacksand: BlacksandInfo;
  /** `id` and `role` come from the machine config: null when there is none. */
  machine: { id: string | null; role: Role | null; platform: PlatformId };
  /** SHA-256 of the machine config's bytes; null when there is none. */
  config_sha256: string | null;
  /** SHA-256 of what was observed; apply observes again and refuses if it differs. */
  observed_sha256: string;
  steps: Step[];
  warnings: Warning[];
}

export class PlanError extends Error {}

const ROLES: readonly Role[] = ["desktop", "host", "proxy", "single"];
const ACTIONS: readonly StepAction[] = ["create", "update", "remove", "unknown"];
const PLATFORMS: readonly PlatformId[] = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

type Fields = { [key: string]: unknown };

const fail = (at: string, why: string): never => {
  throw new PlanError(`plan ${at}: ${why}`);
};

/** `value` as an object with exactly `keys` (no others), or a PlanError naming `at`. */
function fields(value: unknown, at: string, keys: readonly string[]): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(at, "isn't an object");
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) fail(at, `has unknown field ${extra.join(", ")}`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(at, `has no ${missing.join(", ")}`);
  return value as Fields;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || !value) return fail(at, "isn't a non-empty string");
  return value;
}

function oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) return fail(at, `isn't one of ${allowed.join(", ")}`);
  return value as T;
}

function matching(value: unknown, at: string, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail(at, `isn't ${what}`);
  return value;
}

const orNull = <T>(value: unknown, read: (value: unknown) => T): T | null => (value === null ? null : read(value));

function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) return fail(at, "isn't a list");
  return value;
}

function warning(value: unknown, at: string): Warning {
  const w = fields(value, at, ["code", "text"]);
  return { code: text(w.code, `${at}.code`), text: text(w.text, `${at}.text`) };
}

function step(value: unknown, at: string): Step {
  const s = fields(value, at, ["id", "action", "widens_access", "summary", "after", "reason"]);
  if (typeof s.widens_access !== "boolean") fail(`${at}.widens_access`, "isn't true or false");
  const after = s.after;
  if (typeof after !== "object" || after === null || Array.isArray(after)) fail(`${at}.after`, "isn't an object");
  return {
    id: text(s.id, `${at}.id`),
    action: oneOf(s.action, `${at}.action`, ACTIONS),
    widens_access: s.widens_access as boolean,
    summary: text(s.summary, `${at}.summary`),
    after: after as { [key: string]: Json },
    reason: text(s.reason, `${at}.reason`),
  };
}

/** A blacksand.plan/1 from parsed JSON, checked field by field; throws PlanError saying what's wrong. */
export function parsePlan(value: unknown): Plan {
  const p = fields(value, "", ["schema", "blacksand", "machine", "config_sha256", "observed_sha256", "steps", "warnings"]);
  if (p.schema !== SCHEMA.plan) fail("schema", `is ${JSON.stringify(p.schema)}, not ${SCHEMA.plan}`);
  const b = fields(p.blacksand, "blacksand", ["version", "commit"]);
  const m = fields(p.machine, "machine", ["id", "role", "platform"]);
  const steps = list(p.steps, "steps").map((s, i) => step(s, `steps[${i}]`));
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) fail("steps", `lists ${s.id} twice`);
    seen.add(s.id);
  }
  return {
    schema: SCHEMA.plan,
    blacksand: {
      version: text(b.version, "blacksand.version"),
      commit: orNull(b.commit, (v) => matching(v, "blacksand.commit", COMMIT, "a full commit id")),
    },
    machine: {
      id: orNull(m.id, (v) => text(v, "machine.id")),
      role: orNull(m.role, (v) => oneOf(v, "machine.role", ROLES)),
      platform: oneOf(m.platform, "machine.platform", PLATFORMS),
    },
    config_sha256: orNull(p.config_sha256, (v) => matching(v, "config_sha256", SHA256, "a SHA-256")),
    observed_sha256: matching(p.observed_sha256, "observed_sha256", SHA256, "a SHA-256"),
    steps,
    warnings: list(p.warnings, "warnings").map((w, i) => warning(w, `warnings[${i}]`)),
  };
}
