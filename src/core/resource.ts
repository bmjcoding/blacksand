// What discovery saw, as typed resources: each one present (with what it is),
// absent, or unknown (with why: usually that seeing it needs root). `status`
// lists them; `plan` compares them with the machine config.

import type { Json } from "./plan.ts";

export type Observed<T> = { state: "present"; value: T } | { state: "absent" } | { state: "unknown"; why: string };

export const present = <T>(value: T): Observed<T> => ({ state: "present", value });
export const absent: Observed<never> = { state: "absent" };
export const unknown = (why: string): Observed<never> => ({ state: "unknown", why });

export interface User {
  name: string;
  uid: number;
  gid: number;
  shell: string;
  home: string;
  /** macOS's IsHidden; null where the platform has no such thing. */
  hidden: boolean | null;
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

/** A launchd job or systemd unit the service manager has loaded. */
export interface Job {
  label: string;
  /** Running now. */
  running: boolean;
  /** Whether the service manager's own switch for it says enabled; null when it has none. */
  enabled: boolean | null;
}

/** sshd's effective settings, as sshd prints them: lowercase keyword -> one entry per line it printed. */
export type SshdSettings = { [keyword: string]: string[] };

/** What sshd would apply to one connection (`sshd -G -T -C user=…,host=…,addr=…`): its Match blocks evaluated. */
export interface SshdConnection {
  user: string;
  addr: string;
  /** Null when sshd couldn't evaluate it; `why` says what it said. */
  settings: SshdSettings | null;
  why?: string;
}

export interface Sshd {
  /** The service manager would start sshd (Remote Login, on macOS). Null when that can't be seen. */
  enabled: boolean | null;
  /**
   * The global effective settings (`sshd -G`), for the keywords blacksand checks.
   * sshd's policy only when read as root (`authoritative`): unprivileged, sshd
   * silently skips an Include folder this account can't read.
   */
  settings: SshdSettings;
  authoritative: boolean;
  /** The same for each connection plan sampled; empty for status. A sample's difference is real; a sample's agreement proves nothing about others. */
  connections: SshdConnection[];
  /** Match predicates sshd reports reading (`sshd -G -ddd`), with their lines: bound into the digest, not interpreted. */
  matches: string[];
  /**
   * Why these observations don't establish what every connection gets. Never
   * empty yet: nothing here can prove coverage, so a plan that checks sshd
   * settings stays unknown (and apply refuses it) whatever its digest.
   */
  uncovered: string[];
}

export interface Firewall {
  enabled: boolean;
  /** macOS only: stealth mode and block-all; null elsewhere. */
  stealth: boolean | null;
  blockAll: boolean | null;
}

export interface Tool {
  path: string;
  /** Null when the version can't be told (an unrecognised pnpm build, say). */
  version: string | null;
  /** SHA-256 of the file, where the version is told by digest (pnpm). */
  sha256?: string;
}

/** Everything one discovery saw. Lists that can't be read at all are unknown as a whole. */
export interface Machine {
  users: Observed<User[]>;
  groups: Observed<Group[]>;
  jobs: Observed<Job[]>;
  sshd: Observed<Sshd>;
  firewall: Observed<Firewall>;
  /** FileVault, or LUKS under the root filesystem. */
  diskEncryption: Observed<{ enabled: boolean }>;
  tailscale: Observed<Tool>;
  tools: { git: Observed<Tool>; node: Observed<Tool>; pnpm: Observed<Tool> };
}

/** Shells that let nobody log in. */
export const NO_LOGIN: ReadonlySet<string> = new Set(["/usr/bin/false", "/bin/false", "/sbin/nologin", "/usr/sbin/nologin"]);

/**
 * What a plan needs looked at beyond what discovery always sees: units to
 * query by name (Linux), and, when the config checks sshd, the accounts whose
 * connections to evaluate (every account that can log in is added); null when
 * it doesn't.
 */
export interface Wanted {
  jobs: readonly string[];
  sshdUsers: readonly string[] | null;
}

/** One resource as status and plan print it: `<kind>/<name>`, and what was seen. */
export interface Resource {
  id: string;
  observed: Observed<{ [key: string]: Json }>;
}

const asJson = (value: object): { [key: string]: Json } => JSON.parse(JSON.stringify(value)) as { [key: string]: Json };

function each<T extends object>(kind: string, list: Observed<T[]>, name: (item: T) => string): Resource[] {
  if (list.state !== "present") return [{ id: `${kind}/*`, observed: list }];
  return list.value.map((item) => ({ id: `${kind}/${name(item)}`, observed: present(asJson(item)) }));
}

const one = <T extends object>(id: string, seen: Observed<T>): Resource => ({ id, observed: seen.state === "present" ? present(asJson(seen.value)) : seen });

/** The machine as a flat list of resources, sorted by id. A list that couldn't be read is one `<kind>/*` resource. */
export function resourcesOf(machine: Machine): Resource[] {
  return [
    ...each("user", machine.users, (u) => u.name),
    ...each("group", machine.groups, (g) => g.name),
    ...each("job", machine.jobs, (j) => j.label),
    one("sshd/service", machine.sshd),
    one("firewall/system", machine.firewall),
    one("disk/encryption", machine.diskEncryption),
    one("tool/tailscale", machine.tailscale),
    one("tool/git", machine.tools.git),
    one("tool/node", machine.tools.node),
    one("tool/pnpm", machine.tools.pnpm),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
