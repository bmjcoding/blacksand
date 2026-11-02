// Observations both platform adapters make the same way.

import { createHash } from "node:crypto";

import { PNPM_BINARY_SHA256, PNPM_VERSION, buildToolsRoot } from "../../tooling/blacksand-t3/lib/pnpm.mjs";
import { SSHD_KEYWORDS } from "../core/machine.ts";
import { NO_LOGIN, absent, present, unknown, type Observed, type Sshd, type SshdConnection, type SshdSettings, type Tool, type User } from "../core/resource.ts";
import type { Host, Output } from "./host.ts";
import { ParseError, parseSshdDump } from "./parse.ts";

export const SSHD_CONFIG = "/etc/ssh/sshd_config";

/** `file args`'s version, the first match of `pattern` in its output; present with a null version when it can't be read. */
export function toolVersion(host: Host, file: string, args: readonly string[], pattern: RegExp, env?: { readonly [name: string]: string }): Observed<Tool> {
  const out = host.exec(file, args, env);
  if (out.error && out.status === null) return unknown(`${file}: ${out.error}`);
  return present({ path: file, version: out.status === 0 ? (pattern.exec(out.stdout.trim())?.[1] ?? null) : null });
}

export const SSHD = "/usr/sbin/sshd";

/**
 * Where each evaluated connection comes from: loopback, the tailnet (CGNAT
 * range), a LAN, and the internet (a documentation address), so a Match
 * Address block for any of them shows. The host is the address, as sshd sees
 * it without UseDNS.
 */
export const PROBE_ADDRS = ["127.0.0.1", "100.64.0.1", "192.168.1.2", "203.0.113.1"] as const;

const said = (out: Output) => out.error ?? (out.stderr.trim().split("\n")[0] || `exited ${out.status}`);
const sshdWhy = (out: Output) => (/illegal option|unknown option|usage:/i.test(out.stderr) ? `this sshd has no -G (OpenSSH before 9.3): ${said(out)}` : `sshd -G: ${said(out)}`);

/** The dump's entries for the keywords plan checks; a keyword sshd didn't print has none. */
function tracked(out: Output): SshdSettings | string {
  if (out.status !== 0) return sshdWhy(out);
  try {
    const dump = parseSshdDump(out.stdout);
    return Object.fromEntries(Object.keys(SSHD_KEYWORDS).map((k) => [k, dump.get(k) ?? []]));
  } catch (error) {
    if (error instanceof ParseError) return error.message;
    throw error;
  }
}

/**
 * The accounts whose sshd connections plan samples: the ones the machine
 * config names, and every account that can log in (a shell that isn't a
 * no-login one). Null for status (none sampled); unknown when the accounts
 * couldn't be listed, which is never "there are none".
 */
export function sshdUsers(users: Observed<User[]>, wanted: readonly string[] | null): Observed<string[]> | null {
  if (wanted === null) return null;
  if (users.state !== "present") return users.state === "unknown" ? users : unknown("no accounts were listed");
  const login = users.value.filter((u) => !NO_LOGIN.has(u.shell)).map((u) => u.name);
  return present([...new Set([...wanted, ...login])].sort());
}

/**
 * The Match predicates sshd reports checking while it reads `config`, with
 * their line numbers where it gives them (OpenSSH 10 does, 9.6 doesn't); null
 * when it won't say, including when it printed no debug output at all.
 */
function matchBlocks(host: Host, config: string): string[] | null {
  const out = host.exec(SSHD, ["-G", "-ddd", "-f", config]);
  if (out.status !== 0 || !/^debug3: /m.test(out.stderr)) return null;
  return [...out.stderr.matchAll(/^debug3: checking syntax for '(Match [^\n]*)'(?: on line (\d+))?$/gm)].map(([, match = "", line]) => (line ? `${match} (line ${line})` : match));
}

/**
 * sshd's settings, from sshd itself: `sshd -G` (no host key, no root;
 * OpenSSH 9.3 and later) for the global ones, and, for a plan (`accounts` not
 * null), `sshd -G -T -C` for each account from each PROBE_ADDRS, which
 * evaluates its Match blocks. No fallback reading of the files: a config only
 * sshd can interpret, or an sshd without -G, is unknown. What's seen is
 * diagnostic, not proof: `uncovered` says why.
 */
export function sshdOf(host: Host, enabled: boolean | null, accounts: Observed<string[]> | null = null, config = SSHD_CONFIG): Observed<Sshd> {
  const global = tracked(host.exec(SSHD, ["-G", "-f", config]));
  if (typeof global === "string") return unknown(global);
  const users = accounts?.state === "present" ? accounts.value : [];
  const connections = users.flatMap((user) =>
    PROBE_ADDRS.map((addr): SshdConnection => {
      if (!/^[A-Za-z0-9_.-]+$/.test(user)) return { user, addr, settings: null, why: "the name can't be passed to sshd -C" };
      const settings = tracked(host.exec(SSHD, ["-G", "-T", "-f", config, "-C", `user=${user},host=${addr},addr=${addr}`]));
      return typeof settings === "string" ? { user, addr, settings: null, why: settings } : { user, addr, settings };
    }),
  );
  const matches = accounts === null ? [] : matchBlocks(host, config);
  const uncovered = [
    ...(host.uid !== 0 ? ["sshd -G ran as this account, and skips an Include folder it can't read without saying so: only root's reading is sshd's policy (sudo blacksand plan)"] : []),
    ...(accounts && accounts.state !== "present" ? [`the accounts to check couldn't be listed (${accounts.state === "unknown" ? accounts.why : "none"})`] : []),
    "the connections checked are samples (each account that can log in or that the config names, from four addresses): a Match block on a host name, local address or port, another address or another account isn't evaluated",
    ...(matches === null ? ["sshd didn't say which Match blocks it read"] : matches.length ? [`sshd read Match blocks: ${matches.join("; ")}`] : []),
  ];
  return present({ enabled, settings: global, authoritative: host.uid === 0, connections, matches: matches ?? [], uncovered });
}

/**
 * The pnpm builds run with (tooling/blacksand-t3/lib/pnpm.mjs): root's, for the build
 * account, else the one in the owner's ~/.local. Told by its SHA-256, without
 * running it: the pinned version when the digest is the pinned build's, else
 * null.
 */
export function pnpmTool(host: Host): Observed<Tool> {
  const os = host.platform.startsWith("darwin") ? "darwin" : "linux";
  const candidates = [`${buildToolsRoot(os)}/pnpm/lib/node_modules/pnpm/pnpm`, `${host.home}/.local/lib/node_modules/pnpm/pnpm`];
  for (const file of candidates) {
    const got = host.read(file);
    if (!got.ok && got.why === "missing") continue;
    if (!got.ok) return unknown(`${file} can't be read (${got.why})`);
    const sha256 = createHash("sha256").update(got.bytes).digest("hex");
    return present({ path: file, version: PNPM_BINARY_SHA256[host.platform] === sha256 ? PNPM_VERSION : null, sha256 });
  }
  return absent;
}
