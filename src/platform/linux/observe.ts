// What a Linux machine looks like, read without root and without changing
// anything. Every program run is a read-only query, by absolute path:
//   getent passwd / getent group        users and groups (NSS, so LDAP users too)
//   systemctl list-unit-files …         blacksand's installed unit files, by name
//   systemctl show --property=…         each unit's load, active and unit-file state:
//                                       blacksand's, sshd's, tailscaled and any plan asks for
//   findmnt / lsblk                     whether the root filesystem sits on dm-crypt (LUKS)
//   nft list table inet blacksand       whether blacksand's firewall table exists (root only)
//   sshd -G [-T -C …]                   sshd's effective settings, from sshd itself (shared.ts)
// plus `--version`/`version` of the git and tailscale found. Exercised with
// fakes; no Linux machine has run it yet, so the firewall's enforcement is
// unknown until a native check exists.

import { absent, present, unknown, type Group, type Job, type Machine, type Observed, type Tool, type User, type Wanted } from "../../core/resource.ts";
import type { Host } from "../host.ts";
import { ParseError, parseColons, parseShow, parseUnitFiles } from "../parse.ts";
import { pnpmTool, sshdOf, sshdUsers, toolVersion } from "../shared.ts";

const GETENT = "/usr/bin/getent";
const SYSTEMCTL = "/usr/bin/systemctl";
const FINDMNT = "/usr/bin/findmnt";
const LSBLK = "/usr/bin/lsblk";
const NFT = "/usr/sbin/nft";
const GIT = "/usr/bin/git";
const TAILSCALE = "/usr/bin/tailscale";

/** Unit files status lists by pattern. */
const PATTERNS = ["blacksand-*", "t3blackout-*"];
/** sshd's units (Debian and Ubuntu call it `ssh`, and may start it from a socket), and tailscaled. */
const SSHD_UNITS = ["ssh.service", "ssh.socket", "sshd.service"];
const ALWAYS = [...SSHD_UNITS, "tailscaled.service"];

const why = (program: string, out: { status: number | null; stderr: string; error?: string }) =>
  `${program} ${out.error ?? `exited ${out.status}${out.stderr.trim() ? `: ${out.stderr.trim().split("\n")[0]}` : ""}`}`;

function table(host: Host, database: "passwd" | "group", fields: number): Observed<string[][]> {
  const out = host.exec(GETENT, [database]);
  if (out.status !== 0) return unknown(why("getent", out));
  try {
    return present(parseColons(out.stdout, fields, `getent ${database}`));
  } catch (error) {
    if (error instanceof ParseError) return unknown(error.message);
    throw error;
  }
}

const int = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : null);

export function users(host: Host): Observed<User[]> {
  const rows = table(host, "passwd", 7);
  if (rows.state !== "present") return rows;
  const list: User[] = [];
  for (const [name = "", , uid, gid, , home = "", shell = ""] of rows.value) {
    const u = int(uid);
    const g = int(gid);
    if (!name || u === null || g === null) return unknown(`getent passwd listed ${JSON.stringify(name)} without a numeric uid and gid`);
    list.push({ name, uid: u, gid: g, shell, home, hidden: null });
  }
  return present(list);
}

export function groups(host: Host): Observed<Group[]> {
  const rows = table(host, "group", 4);
  if (rows.state !== "present") return rows;
  const list: Group[] = [];
  for (const [name = "", , gid, members = ""] of rows.value) {
    const g = int(gid);
    if (!name || g === null) return unknown(`getent group listed ${JSON.stringify(name)} without a numeric gid`);
    list.push({ name, gid: g, members: members.split(",").filter(Boolean).sort() });
  }
  return present(list);
}

/**
 * Each unit by name, from systemd itself: blacksand's installed unit files,
 * sshd's, tailscaled and every one `wanted` names. A unit systemd says it
 * can't find is absent; a load state other than loaded, masked or not-found
 * leaves the jobs unknown. sshd is enabled when one of its units' files is.
 */
export function units(host: Host, wanted: readonly string[]): Observed<{ jobs: Job[]; sshdEnabled: boolean | null }> {
  const files = host.exec(SYSTEMCTL, ["list-unit-files", "--no-legend", "--no-pager", "--plain", "--", ...PATTERNS]);
  // systemctl exits 1, printing nothing, when no unit file matches.
  if (files.status !== 0 && !(files.status === 1 && !files.stdout.trim())) return unknown(why("systemctl list-unit-files", files));
  let names: string[];
  let shown: Array<Map<string, string>>;
  try {
    names = [...new Set([...(files.status === 0 ? parseUnitFiles(files.stdout) : []), ...ALWAYS, ...wanted])].sort();
    const out = host.exec(SYSTEMCTL, ["show", "--property=Id,LoadState,ActiveState,UnitFileState", "--", ...names]);
    if (out.status !== 0) return unknown(why("systemctl show", out));
    shown = parseShow(out.stdout);
  } catch (error) {
    if (error instanceof ParseError) return unknown(error.message);
    throw error;
  }
  if (shown.length !== names.length) return unknown(`systemctl show answered for ${shown.length} of ${names.length} units`);
  const jobs: Job[] = [];
  const fileStates = new Map<string, string>();
  for (const [i, label] of names.entries()) {
    const props = shown[i] as Map<string, string>;
    const load = props.get("LoadState");
    const file = props.get("UnitFileState") ?? "";
    fileStates.set(label, load === "not-found" ? "not-found" : file);
    if (load === "not-found") continue;
    if (load !== "loaded" && load !== "masked") return unknown(`systemd can't load ${label} (${load})`);
    jobs.push({ label, running: props.get("ActiveState") === "active", enabled: /^enabled/.test(file) ? true : /^(?:disabled|masked)/.test(file) || load === "masked" ? false : null });
  }
  const states = SSHD_UNITS.map((u) => fileStates.get(u) ?? "");
  const sshdEnabled = states.some((f) => /^enabled/.test(f)) ? true : states.every((f) => /^(?:not-found|disabled|masked)/.test(f)) ? false : null;
  return present({ jobs, sshdEnabled });
}

/**
 * Whether blacksand's nftables table exists (section 3: `inet blacksand`);
 * reading any table needs root. A table that exists isn't proof it enforces
 * anything, so that's unknown until a native check reads its chains; only a
 * table nft confirms is missing is a firewall that's off.
 */
export function firewall(host: Host): Observed<{ enabled: boolean; stealth: null; blockAll: null }> {
  if (host.uid !== 0) return unknown("reading nftables needs root (sudo blacksand plan)");
  const out = host.exec(NFT, ["list", "table", "inet", "blacksand"]);
  if (out.status === 0) return unknown("the inet blacksand table exists; whether it enforces anything isn't checked yet");
  if (out.status !== null && /No such file or directory/.test(out.stderr)) return present({ enabled: false, stealth: null, blockAll: null });
  return unknown(why("nft", out));
}

/** Whether the root filesystem's device stack includes a dm-crypt layer: LUKS (verify only). */
export function rootEncryption(host: Host): Observed<{ enabled: boolean }> {
  const source = host.exec(FINDMNT, ["-n", "-o", "SOURCE", "--target", "/"]);
  const device = source.stdout.trim();
  if (source.status !== 0 || !device.startsWith("/dev/")) return unknown(device ? `the root filesystem is on ${device}, not a block device` : why("findmnt", source));
  const stack = host.exec(LSBLK, ["-s", "-n", "-o", "TYPE", device]);
  if (stack.status !== 0) return unknown(why("lsblk", stack));
  return present({ enabled: stack.stdout.split("\n").some((type) => type.trim() === "crypt") });
}

const tool = (host: Host, file: string, args: string[], pattern: RegExp): Observed<Tool> => (host.exists(file) ? toolVersion(host, file, args, pattern) : absent);

/** What the machine looks like; with `wanted` (plan), the units it names too, and sshd for each connection plan checks. */
export function observe(host: Host, wanted?: Wanted): Machine {
  const jobs = units(host, wanted?.jobs ?? []);
  const people = users(host);
  return {
    users: people,
    groups: groups(host),
    jobs: jobs.state === "present" ? present(jobs.value.jobs) : jobs,
    sshd: sshdOf(host, jobs.state === "present" ? jobs.value.sshdEnabled : null, sshdUsers(people, wanted?.sshdUsers ?? null)),
    firewall: firewall(host),
    diskEncryption: rootEncryption(host),
    tailscale: tool(host, TAILSCALE, ["version"], /^(\d+\.\d+\.\d+)/),
    tools: {
      git: tool(host, GIT, ["--version"], /^git version (\d+\.\d+(?:\.\d+)?)/),
      node: present({ path: host.node.path, version: host.node.version.replace(/^v/, "") }),
      pnpm: pnpmTool(host),
    },
  };
}
