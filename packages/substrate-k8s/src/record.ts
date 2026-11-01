// blacksand.run/1: what one run did, written when it ends, failed and
// cancelled runs included. It records what was observed in the cluster (the
// Pods' resolved images, their UIDs, the node's egress floor, the policies in
// effect, the proxy's sealed audit), not only what was asked for, and reports
// cleanup separately from the run's own status. `complete` is true only when
// every step ran and its evidence was captured; an incomplete record can't
// stand in for a finished run.

import type { BlacksandInfo } from "../../../src/core/envelope.ts";
import type { ModelCall } from "./audit.ts";
import type { Allow, Limits } from "./policy.ts";

export type { ModelCall };

export const RUN_SCHEMA = "blacksand.run/1";

export type RunStatus = "completed" | "failed" | "timed_out" | "cancelled";

export interface Artifact {
  file: string;
  sha256: string;
  bytes: number;
}

export interface RunRecord {
  schema: typeof RUN_SCHEMA;
  blacksand: BlacksandInfo;
  run: { id: string; key: string | null; status: RunStatus; complete: boolean; error: string | null };
  substrate: { kind: "kubernetes"; adapter: "substrate-k8s"; mode: "per-run" };
  times: { started: string; sandbox_ready: string | null; agent_started: string | null; agent_ended: string | null; ended: string; deadline: string };
  cluster: { server_version: string | null; node: { name: string | null; os_image: string | null; kernel: string | null; container_runtime: string | null; architecture: string | null } };
  sandbox: {
    namespace: string;
    name: string;
    uid: string | null;
    pod_uid: string | null;
    runtime_class: string;
    runtime_handler: string | null;
    /** What the sandbox itself reports: gVisor shows in its kernel's first message. */
    observed: { uid: string | null; kernel: string | null; dmesg: string | null };
    controller_image: string | null;
    /** The node's egress floor: the digest its label carries, and the tripwire's direct try at the canary (reached means no floor). */
    floor: { node_label: string | null; canary: string | null; canary_reached: boolean | null };
    /** Processes still able to run after the freeze, before the export: must be none. */
    left_running: number | null;
  };
  /** `tools`: the read-only tools image, pinned by digest (an image volume reports no resolved digest of its own). */
  image: { requested: string; resolved: string | null; matches: boolean; tools: string | null };
  proxy: { pod: string; pod_uid: string | null; image: string; resolved: string | null; matches: boolean; source_sha256: string };
  policy: {
    allow: Allow[];
    route: { kind: string; origin: string; base_path: string; secret: string };
    /** The models the run's token may name. */
    models: string[];
    limits: Limits;
    /** SHA-256 of policies.json: every NetworkPolicy in both namespaces as read back during the run, canonical JSON. */
    effective_sha256: string | null;
    /** SHA-256 of the run's inputs (steps, agent script, prompt, repository source) as canonical JSON. */
    inputs_sha256: string;
  };
  source: { repo: string; kind: "local" | "url"; base: string | null };
  /** `settings`: how its harness was set to run, e.g. Codex's sandbox_mode, approval_policy and model_reasoning_effort (agents run with full access; the sandbox is the boundary). */
  agent: { name: string; model: string; route: string; settings: Record<string, string>; exit_status: number | null; env_names: string[] };
  egress: {
    allowed: number;
    denied: number;
    denied_hosts: Record<string, number>;
    model_calls: ModelCall[];
    /** The audit's own state: lines, whether it closed with its marker, and why it can't be relied on, if it can't. */
    audit: { entries: number; sealed: boolean; problems: string[] } | null;
  };
  result: { patch: Artifact | null; patch_files: number | null; ignored_files: number | null; skipped_entries: number | null };
  artifacts: Artifact[];
  /** `remaining`: this run's own objects still there. `foreign`: objects wearing its label that it didn't create, left alone. */
  cleanup: { status: "verified-absent" | "incomplete" | "not-run"; remaining: string[]; foreign: string[] };
}

const STATUSES: readonly RunStatus[] = ["completed", "failed", "timed_out", "cancelled"];
const HEX64 = /^[0-9a-f]{64}$/;

/** What's wrong with a record, if anything: an empty list means it's well-formed and consistent. */
export function recordProblems(r: RunRecord): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, text: string) => void (ok || problems.push(text));
  need(r.schema === RUN_SCHEMA, `schema is ${JSON.stringify(r.schema)}`);
  need(/^[0-9a-f]{12}$/.test(r.run.id), "run.id isn't 12 hex digits");
  need(STATUSES.includes(r.run.status), "run.status is unknown");
  need(!Number.isNaN(Date.parse(r.times.started)) && !Number.isNaN(Date.parse(r.times.ended)), "times aren't ISO timestamps");
  need(Date.parse(r.times.ended) >= Date.parse(r.times.started), "the run ended before it started");
  need(/@sha256:[0-9a-f]{64}$/.test(r.image.requested) && /@sha256:[0-9a-f]{64}$/.test(r.proxy.image), "an image isn't pinned by digest");
  need(r.image.tools === null || /@sha256:[0-9a-f]{64}$/.test(r.image.tools), "image.tools isn't pinned by digest");
  need(HEX64.test(r.proxy.source_sha256) && HEX64.test(r.policy.inputs_sha256), "a source digest is malformed");
  need(r.run.status === "completed" || r.run.error !== null, "a run that didn't complete says why");
  for (const a of [...r.artifacts, ...(r.result.patch ? [r.result.patch] : [])]) need(HEX64.test(a.sha256) && Number.isInteger(a.bytes), `artifact ${a.file} has a malformed digest`);
  need(r.agent.settings !== undefined && Object.values(r.agent.settings).every((v) => typeof v === "string"), "agent.settings is missing or malformed");
  for (const name of r.agent.env_names) need(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), `env name ${name} is malformed`);
  // `complete` is earned, never asserted: each piece of evidence must be there.
  if (r.run.complete) {
    need(r.run.status === "completed", "complete, but the run didn't complete");
    need(r.sandbox.uid !== null && r.sandbox.pod_uid !== null && r.proxy.pod_uid !== null, "complete without the Pods' UIDs");
    need(r.image.resolved !== null && r.image.matches, "complete without the agent image matching its pin");
    need(r.proxy.resolved !== null && r.proxy.matches, "complete without the proxy image matching its pin");
    need(r.sandbox.floor.node_label !== null && r.sandbox.floor.canary_reached === false, "complete without the node's egress floor in effect");
    need(r.sandbox.left_running === 0, "complete without the agent frozen before its export");
    need(r.policy.effective_sha256 !== null && HEX64.test(r.policy.effective_sha256), "complete without the effective policy");
    need(r.source.base !== null && /^[0-9a-f]{40}$/.test(r.source.base), "complete without the base commit");
    need(r.agent.exit_status !== null, "complete without the agent's exit status");
    need(r.result.patch !== null, "complete without the patch");
    need(r.egress.audit !== null && r.egress.audit.sealed && r.egress.audit.problems.length === 0, "complete without the proxy's whole, sealed audit");
    need(r.times.sandbox_ready !== null && r.times.agent_started !== null && r.times.agent_ended !== null, "complete without step times");
  }
  return problems;
}
