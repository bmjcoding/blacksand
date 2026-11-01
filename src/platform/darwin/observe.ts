// What a Mac looks like, read without root and without changing anything.
// Every program run is a read-only query of Apple's own, by absolute path:
//   dscl . -readall              users and groups
//   launchctl print system       loaded LaunchDaemons and launchd's on/off switches
//   socketfilterfw --get…        the application firewall
//   fdesetup status              FileVault (fdesetup list, who can unlock, needs root)
//   xcode-select -p              where Apple's developer tools are, so their git runs
//                                directly: /usr/bin/git is a shim that can open the
//                                "install command line tools" dialog
//   plutil -extract … -o -       an app's version from its Info.plist, to stdout
//   sshd -G [-T -C …]            sshd's effective settings, from sshd itself (shared.ts)
// plus `--version`/`version` of the git and tailscale found. pf's state needs
// root (/dev/pf), so the inbound Screen Sharing anchor isn't observed here.

import { absent, present, unknown, type Firewall, type Group, type Job, type Machine, type Observed, type Tool, type User, type Wanted } from "../../core/resource.ts";
import type { Host } from "../host.ts";
import { ParseError, parseDscl, parseLaunchd } from "../parse.ts";
import { pnpmTool, sshdOf, sshdUsers, toolVersion } from "../shared.ts";

const DSCL = "/usr/bin/dscl";
const LAUNCHCTL = "/bin/launchctl";
const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";
const FDESETUP = "/usr/bin/fdesetup";
const XCODE_SELECT = "/usr/bin/xcode-select";
const PLUTIL = "/usr/bin/plutil";

/** Apple's sshd, as launchd knows it (Remote Login). */
const SSHD_LABEL = "com.openssh.sshd";
/** The git a missing developer-tools install answers with a dialog. */
const GIT_SHIM = "/usr/bin/git";

/** Homebrew's (Apple silicon, then Intel), then Apple's developer tools': the order install.sh puts them on PATH. */
const GITS = ["/opt/homebrew/bin/git", "/usr/local/bin/git"];
const TAILSCALE_APP = "/Applications/Tailscale.app";
const TAILSCALES = ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

const why = (program: string, out: { status: number | null; stderr: string; error?: string }) =>
  `${program} ${out.error ?? `exited ${out.status}${out.stderr.trim() ? `: ${out.stderr.trim().split("\n")[0]}` : ""}`}`;

function readAll(host: Host, kind: "Users" | "Groups", attributes: string[]): Observed<Array<Map<string, string[]>>> {
  const out = host.exec(DSCL, [".", "-readall", `/${kind}`, ...attributes]);
  if (out.status !== 0) return unknown(why("dscl", out));
  try {
    return present(parseDscl(out.stdout));
  } catch (error) {
    if (error instanceof ParseError) return unknown(error.message);
    throw error;
  }
}

const first = (record: Map<string, string[]>, name: string) => record.get(name)?.[0];

function int(value: string | undefined): number | null {
  return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : null;
}

export function users(host: Host): Observed<User[]> {
  const records = readAll(host, "Users", ["RecordName", "UniqueID", "PrimaryGroupID", "UserShell", "NFSHomeDirectory", "IsHidden"]);
  if (records.state !== "present") return records;
  const list: User[] = [];
  for (const r of records.value) {
    const name = first(r, "RecordName");
    const uid = int(first(r, "UniqueID"));
    const gid = int(first(r, "PrimaryGroupID"));
    if (!name || uid === null || gid === null) return unknown(`dscl listed a user without a name, uid or group: ${JSON.stringify(Object.fromEntries(r))}`);
    const hidden = first(r, "dsAttrTypeNative:IsHidden") ?? first(r, "IsHidden");
    list.push({ name, uid, gid, shell: first(r, "UserShell") ?? "", home: first(r, "NFSHomeDirectory") ?? "", hidden: hidden === undefined ? false : /^(?:1|yes|true)$/i.test(hidden) });
  }
  return present(list);
}

export function groups(host: Host): Observed<Group[]> {
  const records = readAll(host, "Groups", ["RecordName", "PrimaryGroupID", "GroupMembership"]);
  if (records.state !== "present") return records;
  const list: Group[] = [];
  for (const r of records.value) {
    const name = first(r, "RecordName");
    const gid = int(first(r, "PrimaryGroupID"));
    if (!name || gid === null) return unknown(`dscl listed a group without a name or id: ${JSON.stringify(Object.fromEntries(r))}`);
    list.push({ name, gid, members: [...(r.get("GroupMembership") ?? [])].sort() });
  }
  return present(list);
}

/** launchd's system domain: every job loaded in it (status shows only some; plan reads them all), and whether Remote Login is on. */
export function launchd(host: Host): Observed<{ jobs: Job[]; sshdEnabled: boolean }> {
  const out = host.exec(LAUNCHCTL, ["print", "system"]);
  if (out.status !== 0) return unknown(why("launchctl", out));
  let parsed;
  try {
    parsed = parseLaunchd(out.stdout);
  } catch (error) {
    if (error instanceof ParseError) return unknown(error.message);
    throw error;
  }
  const jobs = [...parsed.services]
    .map(([label, { pid }]) => ({ label, running: pid > 0, enabled: parsed.disabled.has(label) ? !parsed.disabled.get(label) : null }))
    .sort((a, b) => (a.label < b.label ? -1 : 1));
  // Remote Login on: launchd has sshd loaded (on demand, pid 0) and its switch isn't off.
  const sshdEnabled = parsed.services.has(SSHD_LABEL) && parsed.disabled.get(SSHD_LABEL) !== true;
  return present({ jobs, sshdEnabled });
}

export function firewall(host: Host): Observed<Firewall> {
  const ask = (flag: string) => host.exec(SOCKETFILTERFW, [flag]);
  const state = ask("--getglobalstate");
  if (state.status !== 0) return unknown(why("socketfilterfw", state));
  // "Firewall is enabled. (State = 1)", "… (State = 2)" (block all), "Firewall is disabled. (State = 0)".
  const match = /\(State = (\d)\)/.exec(state.stdout);
  if (!match) return unknown(`socketfilterfw said ${JSON.stringify(state.stdout.trim())}`);
  const stealth = ask("--getstealthmode");
  const blockAll = ask("--getblockall");
  const onOff = (out: typeof stealth, on: RegExp, off: RegExp) => (out.status === 0 && on.test(out.stdout) ? true : out.status === 0 && off.test(out.stdout) ? false : null);
  return present({
    enabled: match[1] !== "0",
    stealth: onOff(stealth, /stealth mode is on/i, /stealth mode is off/i),
    blockAll: onOff(blockAll, /block all state set to enabled/i, /block all state set to disabled/i),
  });
}

export function fileVault(host: Host): Observed<{ enabled: boolean }> {
  const out = host.exec(FDESETUP, ["status"]);
  if (out.status !== 0) return unknown(why("fdesetup", out));
  // Only the settled answers count: "FileVault is On." can come with "Encryption in progress: …",
  // "Deferred enablement …" or a restart still to do, and none of those is a disk that's encrypted yet.
  const said = out.stdout.trim();
  if (said === "FileVault is On.") return present({ enabled: true });
  if (said === "FileVault is Off.") return present({ enabled: false });
  return unknown(`FileVault isn't settled: fdesetup said ${JSON.stringify(said)}`);
}

/** The git install.sh would find first: Homebrew's, else the one in Apple's developer tools; never /usr/bin/git, the shim, by any name. */
export function git(host: Host): Observed<Tool> {
  const dev = host.exec(XCODE_SELECT, ["-p"]);
  const apple = dev.status === 0 && dev.stdout.trim().startsWith("/") ? [`${dev.stdout.trim()}/usr/bin/git`] : [];
  for (const file of [...GITS, ...apple]) {
    const real = host.realpath(file);
    if (real === null || real === GIT_SHIM) continue;
    return toolVersion(host, file, ["--version"], /^git version (\d+\.\d+(?:\.\d+)?)/);
  }
  return absent;
}

export function tailscale(host: Host): Observed<Tool> {
  const plist = `${TAILSCALE_APP}/Contents/Info.plist`;
  if (host.exists(plist)) {
    const out = host.exec(PLUTIL, ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
    return present({ path: TAILSCALE_APP, version: out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null });
  }
  // Tailscale's docs: started from a script, its macOS executable can open the app unless told it's a CLI.
  for (const file of TAILSCALES) if (host.exists(file)) return toolVersion(host, file, ["version"], /^(\d+\.\d+\.\d+)/, { TAILSCALE_BE_CLI: "1" });
  return absent;
}

/** What the Mac looks like; with `wanted` (plan), sshd is also evaluated for each connection plan checks. */
export function observe(host: Host, wanted?: Wanted): Machine {
  const jobs = launchd(host);
  const people = users(host);
  const sshd = sshdOf(host, jobs.state === "present" ? jobs.value.sshdEnabled : null, sshdUsers(people, wanted?.sshdUsers ?? null));
  return {
    users: people,
    groups: groups(host),
    jobs: jobs.state === "present" ? present(jobs.value.jobs) : jobs,
    sshd,
    firewall: firewall(host),
    diskEncryption: fileVault(host),
    tailscale: tailscale(host),
    tools: {
      git: git(host),
      node: present({ path: host.node.path, version: host.node.version.replace(/^v/, "") }),
      pnpm: pnpmTool(host),
    },
  };
}
