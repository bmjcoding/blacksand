// What a run left in the cluster, and how to delete exactly that.
//
// An object belongs to a run only if it's one this runner creates for it: the
// expected kind, name and role in the expected namespace (and, for the Pod
// the Sandbox controller makes, an owner reference to that run's Sandbox).
// Anything else carrying a run label is foreign: it's reported, never deleted.
// Each object is deleted by its UID, so one replaced in the meantime survives.
//
// A run's lifetime is the latest deadline any of its own objects records
// (they're all written with the same one). An object without a deadline can't
// shorten it; a run whose objects record none is reported, never deleted.

import { getJson, type Kubectl } from "./kubectl.ts";
import { DEADLINE, LABEL, NS } from "./manifests.ts";

export type Kind = "Sandbox" | "Pod" | "ConfigMap" | "NetworkPolicy";

export interface RunObject {
  kind: Kind;
  namespace: string;
  name: string;
  uid: string;
  /** Seconds since the epoch; null when the object carries no valid deadline. */
  deadline: number | null;
}

export interface Census {
  runs: Map<string, RunObject[]>;
  /** Labelled objects no run of ours created, as namespace/Kind/name. */
  foreign: string[];
}

interface Item {
  kind: string;
  metadata: { name: string; uid: string; labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[] };
}

const ID = /^[0-9a-f]{12}$/;

/** Every labelled object in both namespaces (or only one run's, with `id`), sorted into runs and foreign objects. */
export async function census(kubectl: Kubectl, id?: string): Promise<Census> {
  const runs = new Map<string, RunObject[]>();
  const foreign: string[] = [];
  const pods: { item: Item; id: string }[] = [];
  const add = (id: string, item: Item, namespace: string) => {
    const deadline = Number(item.metadata.annotations?.[DEADLINE]);
    const object: RunObject = { kind: item.kind as Kind, namespace, name: item.metadata.name, uid: item.metadata.uid, deadline: Number.isFinite(deadline) && deadline > 0 ? deadline : null };
    runs.set(id, [...(runs.get(id) ?? []), object]);
  };
  for (const namespace of [NS.runs, NS.egress]) {
    const listed = await getJson<{ items: Item[] }>(kubectl, ["get", "sandbox,pod,configmap,networkpolicy", "-n", namespace, "-l", id ? `${LABEL.run}=${id}` : LABEL.run]);
    for (const item of listed.items) {
      const run = item.metadata.labels?.[LABEL.run] ?? "";
      const role = item.metadata.labels?.[LABEL.role];
      const ours =
        ID.test(run) &&
        ((namespace === NS.runs && role === "sandbox" && item.metadata.name === `s${run}` && ["Sandbox", "ConfigMap", "NetworkPolicy", "Pod"].includes(item.kind)) ||
          (namespace === NS.egress && role === "proxy" && item.metadata.name === `p${run}` && ["Pod", "ConfigMap", "NetworkPolicy"].includes(item.kind)));
      if (!ours) foreign.push(`${namespace}/${item.kind}/${item.metadata.name}`);
      else if (item.kind === "Pod" && namespace === NS.runs) pods.push({ item, id: run });
      else add(run, item, namespace);
    }
  }
  // The sandbox Pod is the controller's: it's the run's only if the run's own Sandbox owns it (or, that Sandbox gone, one by that name did).
  for (const { item, id: run } of pods) {
    const sandbox = runs.get(run)?.find((o) => o.kind === "Sandbox");
    const owner = item.metadata.ownerReferences?.find((o) => o.kind === "Sandbox" && o.controller && o.name === `s${run}`);
    if (owner && (!sandbox || owner.uid === sandbox.uid)) add(run, item, NS.runs);
    else foreign.push(`${NS.runs}/${item.kind}/${item.metadata.name}`);
  }
  return { runs, foreign: foreign.sort() };
}

const PATHS: Record<Kind, (ns: string, name: string) => string> = {
  Sandbox: (ns, name) => `/apis/agents.x-k8s.io/v1beta1/namespaces/${ns}/sandboxes/${name}`,
  Pod: (ns, name) => `/api/v1/namespaces/${ns}/pods/${name}`,
  ConfigMap: (ns, name) => `/api/v1/namespaces/${ns}/configmaps/${name}`,
  NetworkPolicy: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${name}`,
};
const ORDER: Kind[] = ["Sandbox", "Pod", "NetworkPolicy", "ConfigMap"];

/** Deletes exactly these objects, each only while it still has the UID it had when found; then waits for them to go. */
export async function deleteObjects(kubectl: Kubectl, objects: readonly RunObject[]): Promise<void> {
  const sorted = [...objects].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const o of sorted) {
    const options = { kind: "DeleteOptions", apiVersion: "v1", preconditions: { uid: o.uid }, propagationPolicy: "Background" };
    const result = await kubectl(["delete", "--raw", PATHS[o.kind](o.namespace, o.name), "-f", "-"], { stdin: JSON.stringify(options), timeoutMs: 60_000 });
    // Gone already is fine. A UID conflict means something else has the name now: it isn't ours, so it stays.
    if (result.status !== 0 && !/NotFound|Conflict/.test(result.stderr)) throw new Error(`deleting ${o.namespace}/${o.kind}/${o.name} failed: ${result.stderr.trim().slice(0, 200)}`);
  }
  for (const o of sorted) await kubectl(["wait", "--for=delete", `${o.kind.toLowerCase()}/${o.name}`, "-n", o.namespace, "--timeout=120s"], { timeoutMs: 130_000 });
}

/** The latest deadline a run's own objects record, or null if none records one. */
export const runDeadline = (objects: readonly RunObject[]) => objects.reduce<number | null>((latest, o) => (o.deadline !== null && (latest === null || o.deadline > latest) ? o.deadline : latest), null);

export interface Reconciled {
  /** Runs past their deadline, whose objects were deleted. */
  deleted: string[];
  /** Runs whose objects record no deadline: reported, not deleted. */
  undated: string[];
  /** Labelled objects that aren't any run's: reported, not deleted. */
  foreign: string[];
}

/**
 * Deletes the runs past their deadline: what a runner that crashed, lost the
 * API or was killed left behind. The kubelet has already stopped those Pods at
 * their own deadline, and the proxy has sealed itself; this removes the objects.
 */
export async function reconcile(kubectl: Kubectl, nowMs: number): Promise<Reconciled> {
  const found = await census(kubectl);
  const out: Reconciled = { deleted: [], undated: [], foreign: found.foreign };
  for (const [id, objects] of [...found.runs].sort(([a], [b]) => a.localeCompare(b))) {
    const deadline = runDeadline(objects);
    if (deadline === null) out.undated.push(id);
    else if (deadline * 1000 <= nowMs) {
      await deleteObjects(kubectl, objects);
      out.deleted.push(id);
    }
  }
  return out;
}
