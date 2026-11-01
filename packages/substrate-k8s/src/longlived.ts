// Long-lived mode, for an always-on agent: an interface only, so per-run code
// doesn't grow assumptions it would later have to unlearn. Not implemented.
//
// How it differs from per-run mode:
// - its own identity and a PersistentVolume for its workspace, which survive
//   stop and start; a per-run writable layer is never reused as one;
// - provider grants and an egress allowlist of its own, with proxy tokens that
//   rotate per session, never one token for its lifetime;
// - every session and volume snapshot is recorded; snapshots that hold secrets
//   never cross trust levels;
// - its orchestration (durable workflows) runs outside the sandbox and calls
//   this interface, never the other way round.

import type { Allow, RouteSpec } from "./policy.ts";
import type { RunStatus } from "./record.ts";

export interface LongLivedSpec {
  /** Stable name for the agent's identity, volume and Sandbox. */
  name: string;
  image: string;
  runtimeClass: string;
  routes: RouteSpec[];
  allow: Allow[];
  /** Size of its PersistentVolume, e.g. 20Gi. */
  volume: string;
}

export interface LongLivedSession {
  name: string;
  session: string;
  sandboxUid: string;
  podUid: string;
  started: string;
}

export interface LongLivedSubstrate {
  /** Creates the identity, volume and a stopped Sandbox; idempotent for an identical spec, refuses a different one. */
  create(spec: LongLivedSpec): Promise<void>;
  /** Starts (or joins) a session: a running Pod on the same volume, with a fresh proxy token. */
  attach(name: string): Promise<LongLivedSession>;
  /** Ends the session: the Pod goes, the volume stays; records the session's end and status. */
  stop(name: string, session: string): Promise<{ status: RunStatus }>;
}

export class NotImplemented extends Error {}

export const longLived: LongLivedSubstrate = {
  create: () => Promise.reject(new NotImplemented("long-lived mode isn't implemented yet")),
  attach: () => Promise.reject(new NotImplemented("long-lived mode isn't implemented yet")),
  stop: () => Promise.reject(new NotImplemented("long-lived mode isn't implemented yet")),
};
