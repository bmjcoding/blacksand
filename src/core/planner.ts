// From a machine config and what discovery saw to the steps of a plan. Pure:
// nothing here reads or changes the machine. A resource that couldn't be seen
// is a step with action `unknown` (or, for what apply can't set, a warning),
// never a guess. What apply can't set (disk encryption, Tailscale, tool
// versions) is a warning for the owner, never a step.

import { createHash } from "node:crypto";

import { satisfies } from "../../tooling/t3code/lib/semver.mjs";
import type { Warning } from "./envelope.ts";
import type { MachineConfig } from "./machine.ts";
import type { Json, Plan, Step } from "./plan.ts";
import { NO_LOGIN, resourcesOf, type Machine, type Observed, type Resource, type Tool, type Wanted } from "./resource.ts";
/** sshd keywords whose `no` is the closed value (PermitTunnel and PermitRootLogin too: anything but `no` opens something). */
const CLOSED_BY_NO = new Set(["allowagentforwarding", "allowtcpforwarding", "gatewayports", "kbdinteractiveauthentication", "passwordauthentication", "permitemptypasswords", "permitrootlogin", "permittunnel", "usepam", "x11forwarding"]);

export interface Planned {
  steps: Step[];
  warnings: Warning[];
  /** The resources the plan depends on: apply observes these again and compares their digest. */
  observed: Resource[];
}

/** JSON with every object's keys sorted, so the same observation always has the same digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as { [key: string]: unknown })[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** observed_sha256: the platform and the resources the plan depends on. */
export const observedDigest = (platform: string, observed: readonly Resource[]) => sha256(canonicalJson({ platform, resources: observed }));

const listFind = <T>(list: Observed<T[]>, match: (item: T) => boolean): Observed<T> =>
  list.state !== "present" ? list : ((found) => (found ? { state: "present", value: found } : { state: "absent" }))(list.value.find(match));

/**
 * Why apply must refuse `plan`, whatever its digest: any step or warning that
 * is unknown. A digest binds what was seen; it can't bind what wasn't, so an
 * unknown that hashes the same as last time is still unknown. `apply`, when it
 * exists, calls this before anything else.
 */
export function applyBlockers(plan: Pick<Plan, "steps" | "warnings">): string[] {
  return [...plan.steps.filter((s) => s.action === "unknown").map((s) => `${s.id}: ${s.summary}`), ...plan.warnings.filter((w) => w.code.startsWith("unknown/")).map((w) => `${w.code}: ${w.text}`)];
}

/** What discovery must look at for `config` (observe's `wanted`): its jobs, and, when it checks sshd, its accounts' connections. */
export function wantedOf(config: MachineConfig): Wanted {
  const named = [...Object.keys(config.users), ...Object.values(config.groups).flatMap((g) => g.members)];
  return { jobs: Object.keys(config.jobs), sshdUsers: Object.keys(config.sshd.settings).length ? [...new Set(named)].sort() : null };
}

/** Whether sshd's entries for a keyword are `want`: exactly one entry for a single value, the same entries in any order for a list. */
const same = (entries: readonly string[], want: string | readonly string[]) =>
  typeof want === "string" ? entries.length === 1 && entries[0] === want : JSON.stringify([...entries].sort()) === JSON.stringify([...want].sort());
const shown = (value: string | readonly string[]) => (typeof value === "string" ? value : value.length ? value.join(", ") : "none");

const step = (id: string, action: Step["action"], widens: boolean, summary: string, after: { [key: string]: Json }, reason: string): Step => ({ id, action, widens_access: widens, summary, after, reason });

/** A step whose current state wasn't seen. It counts as widening access: apply lists it first, and nobody assumes it's harmless. */
const unknownStep = (id: string, seen: { why: string }, after: { [key: string]: Json }, reason: string) => step(id, "unknown", true, `can't be seen: ${seen.why}`, after, reason);

export function planSteps(config: MachineConfig, machine: Machine): Planned {
  const steps: Step[] = [];
  const warnings: Warning[] = [];
  const depends = new Set<string>();
  const all = resourcesOf(machine);

  for (const [name, wanted] of Object.entries(config.users)) {
    const id = `user/${name}`;
    depends.add(machine.users.state === "present" ? id : "user/*");
    const seen = listFind(machine.users, (u) => u.name === name);
    const after = { name, ...wanted } as { [key: string]: Json };
    const reason = `users.${name} in the machine config`;
    if (seen.state === "unknown") steps.push(unknownStep(id, seen, after, reason));
    else if (seen.state === "absent") steps.push(step(id, "create", true, `create the standard account ${name}`, after, reason));
    else {
      const u = seen.value;
      // A field this platform doesn't have (hidden, on Linux) is asked for but can't be checked: never skipped.
      for (const key of ["shell", "home", "hidden"] as const) {
        if (wanted[key] !== undefined && u[key] === null) warnings.push({ code: `unknown/user-${key}`, text: `users.${name}.${key} can't be checked on this platform` });
      }
      const differs = (["shell", "home", "hidden"] as const).filter((key) => wanted[key] !== undefined && u[key] !== null && u[key] !== wanted[key]);
      if (differs.length) {
        const opensLogin = wanted.shell !== undefined && NO_LOGIN.has(u.shell) && !NO_LOGIN.has(wanted.shell);
        steps.push(step(id, "update", opensLogin, `set ${name}'s ${differs.join(", ")}`, after, reason));
      }
    }
  }

  for (const [name, wanted] of Object.entries(config.groups)) {
    const id = `group/${name}`;
    depends.add(machine.groups.state === "present" ? id : "group/*");
    const seen = listFind(machine.groups, (g) => g.name === name);
    const reason = `groups.${name} in the machine config`;
    if (seen.state === "unknown") steps.push(unknownStep(id, seen, { name, members: wanted.members }, reason));
    else if (seen.state === "absent") steps.push(step(id, "create", wanted.members.length > 0, `create the group ${name}`, { name, members: wanted.members }, reason));
    else {
      const missing = wanted.members.filter((m) => !seen.value.members.includes(m));
      if (missing.length) steps.push(step(id, "update", true, `add ${missing.join(", ")} to ${name}`, { name, members: [...new Set([...seen.value.members, ...missing])].sort() }, reason));
    }
  }

  for (const [label, wanted] of Object.entries(config.jobs)) {
    const id = `job/${label}`;
    depends.add(machine.jobs.state === "present" ? id : "job/*");
    const seen = listFind(machine.jobs, (j) => j.label === label);
    const after = { label, ...wanted } as { [key: string]: Json };
    const reason = `jobs.${label} in the machine config`;
    if (seen.state === "unknown") steps.push(unknownStep(id, seen, after, reason));
    else if (seen.state === "absent") steps.push(step(id, "create", false, `load the job ${label}`, after, reason));
    else if (wanted.running !== undefined && seen.value.running !== wanted.running) steps.push(step(id, "update", false, `${wanted.running ? "start" : "stop"} ${label}`, after, reason));
  }

  const sshdWanted = Object.keys(config.sshd.settings).length > 0 || config.sshd.enabled !== undefined;
  if (sshdWanted) {
    depends.add("sshd/service");
    const seen = machine.sshd;
    if (config.sshd.enabled !== undefined) {
      const id = "sshd/service";
      const reason = "sshd.enabled in the machine config";
      const after = { enabled: config.sshd.enabled };
      if (seen.state !== "present") steps.push(unknownStep(id, seen.state === "unknown" ? seen : { why: "sshd isn't installed" }, after, reason));
      else if (seen.value.enabled === null) steps.push(unknownStep(id, { why: "whether sshd starts isn't visible" }, after, reason));
      else if (seen.value.enabled !== config.sshd.enabled) steps.push(step(id, "update", config.sshd.enabled, `turn ${config.sshd.enabled ? "on" : "off"} sshd (Remote Login)`, after, reason));
    }
    // What each evaluated connection gets, by keyword: a Match block can give some connections another value than the global one.
    const conflicts = new Map<string, { keyword: string; user: string; theirs: string[]; addrs: string[] }>();
    for (const [keyword, value] of Object.entries(config.sshd.settings)) {
      const id = `sshd/${keyword}`;
      const reason = `sshd.settings.${keyword} in the machine config`;
      const after = { value } as { [key: string]: Json };
      if (seen.state !== "present") {
        steps.push(unknownStep(id, seen.state === "unknown" ? seen : { why: "sshd isn't there" }, after, reason));
        continue;
      }
      const current = seen.value.settings[keyword] ?? [];
      if (!seen.value.authoritative) {
        steps.push(unknownStep(id, { why: `sshd -G as this account reads ${keyword} ${shown(current)}, but only root's reading is sshd's policy (sudo blacksand plan)` }, after, reason));
      } else if (!same(current, value)) {
        const closes = (CLOSED_BY_NO.has(keyword) && value === "no") || (keyword === "maxauthtries" && typeof value === "string" && current.length === 1 && Number(value) <= Number(current[0]));
        steps.push(step(id, "update", !closes, `set sshd's ${keyword} to ${shown(value)} (now ${shown(current)})`, after, reason));
      }
      for (const c of seen.value.connections) {
        const theirs = c.settings?.[keyword] ?? [];
        // The global value's own difference is the step above; a connection that gets something else is a Match block's doing.
        if (c.settings === null || same(theirs, value) || same(theirs, current)) continue;
        const key = `${keyword}\0${c.user}\0${theirs.join("\0")}`;
        const found = conflicts.get(key) ?? { keyword, user: c.user, theirs, addrs: [] };
        found.addrs.push(c.addr);
        conflicts.set(key, found);
      }
    }
    for (const { keyword, user, theirs, addrs } of conflicts.values()) {
      warnings.push({ code: "drift/sshd-conditional", text: `a Match block gives ${user} ${keyword} ${shown(theirs)} from ${addrs.join(", ")}, not what the machine config wants` });
    }
    // A connection sshd couldn't evaluate, or an account that doesn't exist yet (Match Group needs it), could get anything;
    // and the samples, however many agree, aren't every connection.
    if (seen.state === "present" && Object.keys(config.sshd.settings).length) {
      warnings.push({ code: "unknown/sshd-conditional", text: `what every connection gets from sshd isn't established: ${seen.value.uncovered.join("; ")}` });
      for (const c of seen.value.connections) if (c.settings === null) warnings.push({ code: "unknown/sshd-conditional", text: `sshd couldn't evaluate ${c.user} from ${c.addr}: ${c.why ?? "no answer"}` });
      if (machine.users.state === "present") {
        for (const name of wantedOf(config).sshdUsers ?? []) {
          if (!machine.users.value.some((u) => u.name === name)) warnings.push({ code: "unknown/sshd-conditional", text: `${name} doesn't exist yet, so what sshd's Match blocks give it can't be evaluated` });
        }
      }
    }
  }

  if (config.firewall.enabled !== undefined || config.firewall.stealth !== undefined) {
    const id = "firewall/system";
    depends.add(id);
    const seen = machine.firewall;
    const after = { ...config.firewall } as { [key: string]: Json };
    const reason = "firewall in the machine config";
    if (seen.state !== "present") steps.push(unknownStep(id, seen.state === "unknown" ? seen : { why: "no firewall found" }, after, reason));
    else {
      for (const key of ["enabled", "stealth"] as const) {
        if (config.firewall[key] !== undefined && seen.value[key] === null) warnings.push({ code: `unknown/firewall-${key}`, text: `firewall.${key} can't be checked on this platform` });
      }
      const differs = (["enabled", "stealth"] as const).filter((key) => config.firewall[key] !== undefined && seen.value[key] !== null && seen.value[key] !== config.firewall[key]);
      if (differs.length) steps.push(step(id, "update", differs.some((key) => config.firewall[key] === false), `set the firewall's ${differs.join(", ")}`, after, reason));
    }
  }

  // Checked, not set: apply has no supported command for these, so they're the owner's to fix.
  const check = <T>(id: string, code: string, seen: Observed<T>, problem: (value: T) => string | null, wanted: string) => {
    depends.add(id);
    const found = seen.state === "unknown" ? `can't be seen: ${seen.why}` : seen.state === "absent" ? `isn't there; the machine config wants ${wanted}` : problem(seen.value);
    if (found) warnings.push({ code: `${seen.state === "unknown" ? "unknown" : "drift"}/${code}`, text: `${id} ${found}` });
  };
  if (config.disk_encryption !== undefined) {
    const wanted = config.disk_encryption;
    check("disk/encryption", "disk-encryption", machine.diskEncryption, (v) => (v.enabled === wanted ? null : `is ${v.enabled ? "on" : "off"}; the machine config wants it ${wanted ? "on" : "off"}`), `it ${wanted ? "on" : "off"}`);
  }
  if (config.tailscale === true) check("tool/tailscale", "tailscale", machine.tailscale, () => null, "Tailscale installed");
  if (config.tailscale === false) {
    depends.add("tool/tailscale");
    if (machine.tailscale.state !== "absent") warnings.push({ code: `${machine.tailscale.state === "unknown" ? "unknown" : "drift"}/tailscale`, text: "tool/tailscale: the machine config wants no Tailscale here" });
  }
  for (const [name, range] of Object.entries(config.tools) as Array<[keyof Machine["tools"], string]>) {
    const problem = (t: Tool) =>
      t.version === null ? `is at ${t.path}, whose version can't be told${t.sha256 ? ` (its sha256 isn't the pinned build's)` : ""}; wanted ${range}` : satisfies(t.version, range) ? null : `is ${t.version} at ${t.path}; wanted ${range}`;
    check(`tool/${name}`, name, machine.tools[name], problem, range);
  }

  const observed = all.filter((r) => depends.has(r.id));
  // A wanted resource that's absent has no resource of its own: record its absence so its appearing changes the digest.
  for (const id of depends) if (!observed.some((r) => r.id === id)) observed.push({ id, observed: { state: "absent" } });
  observed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  steps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { steps, warnings, observed };
}
