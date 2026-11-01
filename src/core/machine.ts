// blacksand.machine/1: the machine config, what a machine should look like
// (~/.config/blacksand/machine.json, private). Every section is optional; what
// it doesn't name, plan leaves alone. Read only through parseMachineConfig:
// every field checked, unknown fields refused, so a typo is an error and not a
// setting silently ignored.
//
//   { "schema": "blacksand.machine/1",
//     "machine": { "id": "agent-host", "role": "host" },
//     "users":  { "_blacksand-egress": { "shell": "/usr/bin/false", "hidden": true } },
//     "groups": { "com.apple.access_ssh": { "members": ["admin"] } },
//     "jobs":   { "dev.blacksand.updater": { "running": false } },
//     "sshd":   { "enabled": true, "settings": { "PasswordAuthentication": "no", "AllowUsers": ["owner"] } },
//     "firewall": { "enabled": true, "stealth": true },
//     "disk_encryption": true,
//     "tailscale": true,
//     "tools":  { "git": ">=2.55.0", "node": "24.x", "pnpm": "12.14.0" } }
//
// Tool versions are npm ranges. sshd settings take the values sshd -G prints,
// one string for a single-valued keyword and a list for one sshd repeats
// (Port, AllowUsers, …); a value sshd wouldn't take is refused here. Disk
// encryption, Tailscale and tools are checked, not set: a difference is a
// warning for the owner, not a step.

import { parseRange } from "../../packages/t3/lib/semver.mjs";
import type { Role } from "./plan.ts";

export const MACHINE_SCHEMA = "blacksand.machine/1";

export interface UserWanted {
  shell?: string;
  home?: string;
  hidden?: boolean;
}

export interface MachineConfig {
  schema: typeof MACHINE_SCHEMA;
  machine: { id: string; role: Role };
  users: { [name: string]: UserWanted };
  /** Members each group must include (others may be there too). */
  groups: { [name: string]: { members: string[] } };
  /** Jobs that must be loaded; `running` when it matters whether they are running. */
  jobs: { [label: string]: { running?: boolean } };
  /** `settings` by lowercase keyword, values as sshd -G prints them: a list for SSHD_KEYWORDS' list keywords. */
  sshd: { enabled?: boolean; settings: { [keyword: string]: string | string[] } };
  firewall: { enabled?: boolean; stealth?: boolean };
  disk_encryption?: boolean;
  tailscale?: boolean;
  tools: { git?: string; node?: string; pnpm?: string };
}

export class ConfigError extends Error {}

export interface SshdKeyword {
  /** sshd prints it once per value (Port 22, Port 2222): the config gives a list. */
  list: boolean;
  valid: (value: string) => boolean;
  /** What a valid value is, for the error. */
  what: string;
}

const choice = (...values: string[]): SshdKeyword => ({ list: false, valid: (v) => values.includes(v), what: `one of ${values.join(", ")}` });
const YES_NO = choice("yes", "no");
const between = (min: number, max: number) => (v: string) => /^[1-9]\d{0,4}$/.test(v) && Number(v) >= min && Number(v) <= max;
const METHOD = /^(?:publickey|password|hostbased|gssapi-with-mic|keyboard-interactive(?::(?:pam|bsdauth))?)$/;
/** A user or group pattern as sshd prints one: no spaces, quotes or commas (which would make it something else). */
const PATTERN: SshdKeyword = { list: true, valid: (v) => /^[A-Za-z0-9_.@*?!%:[\]/+-]{1,64}$/.test(v), what: "a user or group pattern without spaces, quotes or commas" };

/** The sshd keywords plan checks, lowercase, with the values sshd -G prints for each. */
export const SSHD_KEYWORDS: { readonly [keyword: string]: SshdKeyword } = {
  allowagentforwarding: YES_NO,
  allowgroups: PATTERN,
  allowtcpforwarding: choice("yes", "no", "local", "remote"),
  allowusers: PATTERN,
  authenticationmethods: { list: false, valid: (v) => v === "any" || v.split(" ").every((set) => set.split(",").every((m) => METHOD.test(m))), what: "any, or space-separated lists of comma-joined methods (publickey, password, keyboard-interactive, …)" },
  denygroups: PATTERN,
  denyusers: PATTERN,
  gatewayports: choice("yes", "no", "clientspecified"),
  kbdinteractiveauthentication: YES_NO,
  maxauthtries: { list: false, valid: between(1, 100), what: "a whole number from 1 to 100" },
  passwordauthentication: YES_NO,
  permitemptypasswords: YES_NO,
  permitrootlogin: choice("yes", "no", "prohibit-password", "forced-commands-only"),
  permittunnel: choice("yes", "no", "point-to-point", "ethernet"),
  port: { list: true, valid: between(1, 65535), what: "a port from 1 to 65535, as a string" },
  pubkeyauthentication: YES_NO,
  usepam: YES_NO,
  x11forwarding: YES_NO,
};

const ROLES: readonly Role[] = ["desktop", "host", "proxy", "single"];
/** Account and group names: what dscl and useradd both take, plus macOS's dotted group names. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

type Fields = { [key: string]: unknown };

const fail = (at: string, why: string): never => {
  throw new ConfigError(`machine config ${at}: ${why}`);
};

/** `value` as an object whose keys are all in `allowed` (and include every one of `required`). */
function fields(value: unknown, at: string, allowed: readonly string[], required: readonly string[] = []): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(at, "isn't an object");
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(at, `has unknown field ${extra.join(", ")}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(at, `has no ${missing.join(", ")}`);
  return value as Fields;
}

/** An object used as a map: every key matching `key`, every value read by `read`. */
function mapOf<T>(value: unknown, at: string, key: RegExp, what: string, read: (v: unknown, at: string) => T): { [name: string]: T } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(at, "isn't an object");
  const out: { [name: string]: T } = {};
  for (const [name, v] of Object.entries(value)) {
    if (!key.test(name)) fail(at, `${JSON.stringify(name)} isn't ${what}`);
    Object.defineProperty(out, name, { value: read(v, `${at}.${name}`), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function bool(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") return fail(at, "isn't true or false");
  return value;
}

function text(value: unknown, at: string, pattern = /^\S(?:.*\S)?$/s): string {
  if (typeof value !== "string" || !pattern.test(value) || /[\0-\x1f\x7f]/.test(value)) return fail(at, "isn't a non-empty string without control characters or edge spaces");
  return value;
}

const optional = <T>(f: Fields, key: string, read: (v: unknown, at: string) => T, at: string): { [k: string]: T } => (f[key] === undefined ? {} : { [key]: read(f[key], at ? `${at}.${key}` : key) });

function range(value: unknown, at: string): string {
  const r = text(value, at);
  try {
    parseRange(r);
  } catch {
    fail(at, `${JSON.stringify(r)} isn't an npm version range`);
  }
  return r;
}

/** A blacksand.machine/1 config from parsed JSON; throws ConfigError saying what's wrong. */
export function parseMachineConfig(value: unknown): MachineConfig {
  const c = fields(value, "", ["schema", "machine", "users", "groups", "jobs", "sshd", "firewall", "disk_encryption", "tailscale", "tools"], ["schema", "machine"]);
  if (c.schema !== MACHINE_SCHEMA) fail("schema", `is ${JSON.stringify(c.schema)}, not ${MACHINE_SCHEMA}`);
  const m = fields(c.machine, "machine", ["id", "role"], ["id", "role"]);
  if (typeof m.id !== "string" || !ID.test(m.id)) fail("machine.id", "isn't a lowercase name (letters, digits, hyphens)");
  if (!ROLES.includes(m.role as Role)) fail("machine.role", `isn't one of ${ROLES.join(", ")}`);

  const users = mapOf(c.users, "users", NAME, "an account name", (v, at) => {
    const u = fields(v, at, ["shell", "home", "hidden"]);
    const absolute = /^\/\S*$/;
    return { ...optional(u, "shell", (s, a) => text(s, a, absolute), at), ...optional(u, "home", (s, a) => text(s, a, absolute), at), ...optional(u, "hidden", bool, at) } as UserWanted;
  });
  const groups = mapOf(c.groups, "groups", NAME, "a group name", (v, at) => {
    const g = fields(v, at, ["members"], ["members"]);
    if (!Array.isArray(g.members)) return fail(`${at}.members`, "isn't a list");
    const members = g.members.map((name, i) => (typeof name === "string" && NAME.test(name) ? name : fail(`${at}.members[${i}]`, "isn't an account name")));
    if (new Set(members).size !== members.length) fail(`${at}.members`, "lists a name twice");
    return { members: [...members].sort() };
  });
  const jobs = mapOf(c.jobs, "jobs", LABEL, "a job label", (v, at) => optional(fields(v, at, ["running"]), "running", bool, at) as { running?: boolean });

  const sshdFields = c.sshd === undefined ? {} : fields(c.sshd, "sshd", ["enabled", "settings"]);
  const settings: { [keyword: string]: string | string[] } = {};
  if (sshdFields.settings !== undefined) {
    const s = sshdFields.settings;
    if (typeof s !== "object" || s === null || Array.isArray(s)) fail("sshd.settings", "isn't an object");
    for (const [keyword, v] of Object.entries(s as Fields)) {
      const lower = keyword.toLowerCase();
      const at = `sshd.settings.${keyword}`;
      const kind = Object.hasOwn(SSHD_KEYWORDS, lower) ? SSHD_KEYWORDS[lower] : undefined;
      if (!kind) return fail("sshd.settings", `${JSON.stringify(keyword)} isn't a keyword blacksand checks (${Object.keys(SSHD_KEYWORDS).join(", ")})`);
      if (Object.hasOwn(settings, lower)) fail("sshd.settings", `sets ${lower} twice`);
      const one = (value: unknown, where: string) => (typeof value === "string" && kind.valid(value) ? value : fail(where, `isn't ${kind.what}`));
      if (!kind.list) settings[lower] = one(v, at);
      else {
        if (!Array.isArray(v)) return fail(at, `isn't a list (sshd takes several ${lower} values)`);
        const values = v.map((item, i) => one(item, `${at}[${i}]`));
        if (new Set(values).size !== values.length) fail(at, "lists a value twice");
        settings[lower] = values;
      }
    }
  }
  const firewall = c.firewall === undefined ? {} : fields(c.firewall, "firewall", ["enabled", "stealth"]);
  const tools = c.tools === undefined ? {} : fields(c.tools, "tools", ["git", "node", "pnpm"]);

  return {
    schema: MACHINE_SCHEMA,
    machine: { id: m.id as string, role: m.role as Role },
    users,
    groups,
    jobs,
    sshd: { ...optional(sshdFields, "enabled", bool, "sshd"), settings },
    firewall: { ...optional(firewall, "enabled", bool, "firewall"), ...optional(firewall, "stealth", bool, "firewall") },
    ...optional(c, "disk_encryption", bool, ""),
    ...optional(c, "tailscale", bool, ""),
    tools: { ...optional(tools, "git", range, "tools"), ...optional(tools, "node", range, "tools"), ...optional(tools, "pnpm", range, "tools") },
  };
}
