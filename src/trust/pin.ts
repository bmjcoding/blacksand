// pin.json's shape and how one pin may follow another: the rules an evaluator
// commit is held to (evaluator.ts). The evaluator chooses the upstream release
// each channel builds; its key could be stolen, so a pin it writes must be
// exactly this shape, name canonical release tags, and only move forward.

import { createHash } from "node:crypto";

import { compareVersions, parseVersion } from "./semver.ts";

export const CHANNELS = ["nightly", "preview", "stable"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export interface ChannelPin {
  ref: string;
  sha: string;
  evaluatedAt: string;
  leftOut: string[];
}

export interface ToolLock {
  sha256: string;
  lock: string;
}

export interface Pin {
  version: 1;
  channels: Partial<Record<ChannelName, ChannelPin>>;
  deviceTools: string[];
  deviceToolLocks?: Record<string, ToolLock>;
}

// Canonical release tags only: no leading zeros, a real date, so two spellings
// can't name the same release (v0.1.6 and v00.1.6) and dodge the same-tag check.
const NUM = "(0|[1-9]\\d*)";
const REF = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}(?:-(nightly|preview)\\.(\\d{4})(\\d{2})(\\d{2})\\.${NUM})?$`);
const SHA = /^[0-9a-f]{40}$/;
const TOOL_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

/** Whether `ref` is a canonical upstream release tag, on `channel` when one is given. */
export function isReleaseTag(ref: unknown, channel: ChannelName | null = null): boolean {
  const match = REF.exec(String(ref ?? ""));
  if (!match) return false;
  const [, , , , kind, year, month, day] = match;
  if (kind) {
    const [y, m, d] = [Number(year), Number(month), Number(day)];
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  }
  return !channel || (kind ?? "stable") === channel;
}

/** Whether `tool` is name@version with a SemVer version. */
function isToolPin(tool: unknown): boolean {
  const text = String(tool);
  const at = text.lastIndexOf("@");
  return at > 0 && TOOL_NAME.test(text.slice(0, at)) && parseVersion(text.slice(at + 1)) !== null && !text.slice(at + 1).startsWith("v");
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Throws unless `value` is exactly a pin's shape; returns it, typed. */
export function validatePin(value: unknown): Pin {
  const fail = (why: string): never => {
    throw new Error(`pin.json is invalid: ${why}`);
  };
  if (!isObject(value)) return fail("not an object");
  const keys = Object.keys(value).filter((key) => key !== "deviceToolLocks").sort().join(",");
  if (keys !== "channels,deviceTools,version") fail(`unexpected keys ${keys}`);
  if (value.version !== 1) fail("version must be 1");
  const channels = value.channels;
  if (!isObject(channels)) return fail("channels must be an object");
  for (const [channel, entry] of Object.entries(channels)) {
    if (!(CHANNELS as readonly string[]).includes(channel)) fail(`unknown channel ${channel}`);
    if (Object.keys(entry ?? {}).sort().join(",") !== "evaluatedAt,leftOut,ref,sha") fail(`${channel}: unexpected keys`);
    const { ref, sha, evaluatedAt, leftOut } = entry as Record<string, unknown>;
    if (!isReleaseTag(ref)) fail(`${channel}: ref ${String(ref)} isn't a release tag`);
    const tag = ref as string;
    const refChannel = tag.includes("-nightly.") ? "nightly" : tag.includes("-preview.") ? "preview" : "stable";
    if (refChannel !== channel) fail(`${channel}: ref ${tag} is a ${refChannel} release`);
    if (!SHA.test(String(sha))) fail(`${channel}: sha must be a full commit id`);
    if (Number.isNaN(Date.parse(String(evaluatedAt)))) fail(`${channel}: evaluatedAt must be a date`);
    if (!Array.isArray(leftOut) || leftOut.some((name) => !/^[a-z][a-z0-9-]*$/.test(String(name)))) fail(`${channel}: leftOut must list feature names`);
  }
  const tools = value.deviceTools;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !isToolPin(tool))) return fail("deviceTools must list name@version");
  if (new Set(tools).size !== tools.length) fail("deviceTools lists a version twice");
  if ("deviceToolLocks" in value) {
    const locks = value.deviceToolLocks;
    if (!isObject(locks)) return fail("deviceToolLocks must be an object");
    for (const [tool, entry] of Object.entries(locks)) {
      if (!isToolPin(tool)) fail(`deviceToolLocks: ${tool} isn't name@version`);
      if (!isObject(entry) || Object.keys(entry).sort().join(",") !== "lock,sha256") return fail(`deviceToolLocks: ${tool} must have exactly sha256 and lock`);
      if (typeof entry.lock !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return fail(`deviceToolLocks: ${tool} needs a lock and its sha256`);
      if (createHash("sha256").update(entry.lock, "utf8").digest("hex") !== entry.sha256) fail(`deviceToolLocks: ${tool}'s lock doesn't match its sha256`);
    }
  }
  return value as unknown as Pin;
}

/**
 * Negative, zero or positive as release `a` is older than, the same as, or newer
 * than `b`: by version, then a prerelease's date and build; a stable release sorts
 * after its prereleases. Only canonical tags compare, so zero means the same tag.
 */
export function compareRefs(a: string, b: string): number {
  for (const ref of [a, b]) if (!isReleaseTag(ref)) throw new Error(`${ref} isn't a release tag`);
  const key = (ref: string) => ref.replace(/-(?:nightly|preview)\./, "-").slice(1);
  return compareVersions(key(a), key(b));
}

/** The channels a pin names, with their entries. */
export const channelsOf = (pin: Pin) => Object.entries(pin.channels) as [ChannelName, ChannelPin][];

/**
 * Why `next` isn't a forward move from `previous`, or null. Every channel already
 * pinned must stay pinned and move to the same or a newer release: a stolen
 * evaluator key must not be able to roll a channel back to a release with known
 * holes, or drop it. Reviewed device tools, and their locks, may only be added.
 */
export function backwardMove(previous: Pin | null, next: Pin): string | null {
  if (!previous) return null;
  for (const [channel, entry] of channelsOf(previous)) {
    const moved = next.channels[channel];
    if (!moved) return `drops the ${channel} pin`;
    const order = compareRefs(moved.ref, entry.ref);
    if (order < 0) return `moves ${channel} back from ${entry.ref} to ${moved.ref}`;
    if (order === 0 && moved.sha !== entry.sha) return `changes ${entry.ref}'s commit`;
  }
  const kept = new Set(next.deviceTools);
  const dropped = previous.deviceTools.filter((tool) => !kept.has(tool));
  if (dropped.length) return `removes reviewed device tools ${dropped.join(", ")}`;
  // A reviewed tool's frozen closure is part of what was reviewed: another lock
  // for the same version is a substitution, and dropping one loses the review.
  for (const [tool, entry] of Object.entries(previous.deviceToolLocks ?? {})) {
    const now = next.deviceToolLocks?.[tool];
    if (!now) return `removes ${tool}'s reviewed dependency lock`;
    if (now.sha256 !== entry.sha256) return `replaces ${tool}'s reviewed dependency lock`;
  }
  return null;
}

/** Device tools `next` approves, or locks, that `previous` didn't. */
export function addedApprovals(previous: Pin, next: Pin): Set<string> {
  const locked = previous.deviceToolLocks ?? {};
  return new Set([...next.deviceTools.filter((tool) => !previous.deviceTools.includes(tool)), ...Object.keys(next.deviceToolLocks ?? {}).filter((tool) => !Object.hasOwn(locked, tool))]);
}
