// blacksand status: what this machine runs, and what discovery sees on it.
// Read-only, unprivileged.

import { emit, usageError, type Command } from "../core/command.ts";
import { EXIT, SCHEMA, blacksandInfo, type StatusEnvelope } from "../core/envelope.ts";
import type { Json } from "../core/plan.ts";
import { resourcesOf, type Machine, type Resource } from "../core/resource.ts";
import { systemHost } from "../platform/host.ts";
import { observe } from "../platform/index.ts";

/** Groups that decide who may log in or administer, by name. */
const ACCESS_GROUPS = new Set(["admin", "wheel", "sudo", "com.apple.access_ssh", "com.apple.access_ssh-disabled", "com.apple.access_screensharing"]);
const OURS = /blacksand|t3blackout/;
/** The launchd jobs status lists: blacksand's, today's product's, Apple's sshd and Screen Sharing, and Tailscale's. */
const JOB_PREFIXES = ["run.blacksand.", "dev.t3blackout.", "com.t3blackout.", "com.openssh.sshd", "com.apple.screensharing", "com.tailscale.", "homebrew.mxcl.tailscale"];
/** sshd settings the text output shows (--json has every one). */
const SSHD_SHOWN = ["passwordauthentication", "kbdinteractiveauthentication", "permitrootlogin", "allowusers", "allowgroups"];

/**
 * The part of what was seen that status shows: people's accounts (not the OS's
 * own service accounts), the groups that grant access, blacksand's own, and on
 * a Mac only the launchd jobs above (Linux queries just those units). Only
 * what's displayed is filtered: plan reads everything.
 */
export function shown(machine: Machine, darwin: boolean): Machine {
  const firstHuman = darwin ? 500 : 1000;
  return {
    ...machine,
    users: machine.users.state === "present" ? { state: "present", value: machine.users.value.filter((u) => (u.uid >= firstHuman && u.uid < 60000) || OURS.test(u.name)) } : machine.users,
    groups: machine.groups.state === "present" ? { state: "present", value: machine.groups.value.filter((g) => ACCESS_GROUPS.has(g.name) || OURS.test(g.name)) } : machine.groups,
    jobs: darwin && machine.jobs.state === "present" ? { state: "present", value: machine.jobs.value.filter((j) => JOB_PREFIXES.some((prefix) => j.label.startsWith(prefix))) } : machine.jobs,
  };
}

const show = (value: Json): string => (Array.isArray(value) ? value.map(show).join(",") || "none" : value === null ? "?" : typeof value === "object" ? JSON.stringify(value) : String(value));

function line(r: Resource): string {
  const o = r.observed;
  if (o.state === "absent") return `${r.id}: absent`;
  if (o.state === "unknown") return `${r.id}: unknown (${o.why})`;
  if (r.id === "sshd/service") {
    const settings = o.value.settings as { [keyword: string]: string[] };
    const parts = SSHD_SHOWN.map((k) => `${k}=${show(settings[k] ?? [])}`);
    return `${r.id}: enabled=${show(o.value.enabled ?? null)} ${parts.join(" ")}${o.value.authoritative ? "" : " (as this account reads it; root's reading is sshd's policy)"}`;
  }
  return `${r.id}: ${Object.entries(o.value)
    .filter(([key]) => key !== "name" && key !== "label")
    .map(([key, value]) => `${key}=${show(value)}`)
    .join(" ")}`;
}

export const status: Command = {
  name: "status",
  summary: "show what this machine runs and what discovery sees on it",
  usage: "blacksand status [--json]",
  async run(args, ctx) {
    if (args.length) return usageError(ctx, `usage: ${this.usage}`);
    const host = ctx.host ?? systemHost();
    const resources = resourcesOf(shown(observe(host), host.platform.startsWith("darwin")));
    const envelope: StatusEnvelope = {
      schema: SCHEMA.status,
      blacksand: blacksandInfo(),
      platform: host.platform,
      node: host.node.version,
      privileged: host.uid === 0,
      resources,
      warnings: [],
    };
    const text = [
      `blacksand ${envelope.blacksand.version}${envelope.blacksand.commit ? ` (${envelope.blacksand.commit.slice(0, 10)})` : ""}`,
      `platform:  ${envelope.platform}`,
      `node:      ${envelope.node}`,
      "",
      ...resources.map(line),
    ].join("\n");
    return emit(ctx, envelope, text, EXIT.ok);
  },
};
