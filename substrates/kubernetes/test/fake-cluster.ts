// A scripted stand-in for kubectl: answers the calls a run makes, records
// every argv and stdin, and lets a test change any answer. The repository,
// its bundle and the workspace export are real, so the patch is made by the
// real collector.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Kubectl, KubectlOptions, KubectlResult } from "../src/kubectl.ts";
import { DEADLINE, LABEL, NS } from "../src/manifests.ts";
import { FLOOR, FLOOR_ID } from "../src/node.ts";

export const AGENT_IMAGE = "docker.io/library/node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413";
export const PROXY_IMAGE = "docker.io/library/node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85";

export interface Call {
  args: string[];
  stdin: string;
}

type Answer = Partial<KubectlResult> | ((call: Call, options: KubectlOptions) => Partial<KubectlResult> | Promise<Partial<KubectlResult>>);

const json = (value: unknown): Partial<KubectlResult> => ({ stdout: Buffer.from(JSON.stringify(value)) });
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", COPYFILE_DISABLE: "1" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { env: gitEnv }).toString().trim();

/** A real repository with one commit, and the workspace an agent left: one new file. */
export function fakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-fake-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  const ws = path.join(root, "ws");
  git(root, "clone", "-q", repo, ws);
  fs.writeFileSync(path.join(ws, "FAKE_AGENT.md"), "the fake agent ran\n");
  const exportTar = path.join(root, "export.tar");
  execFileSync("tar", ["-C", ws, "--format", "pax", "--exclude", ".git", "-cf", exportTar, "."], { env: gitEnv });
  return { root, repo, head, exportTar };
}

/** The audit a sealed proxy writes for one allowed tunnel, one denied host and one model call. */
export function sealedAudit(run: string): string {
  const entries: Record<string, unknown>[] = [
    { event: "start" },
    { kind: "connect", op: "connect", authority: "example.com:443", id: 1, event: "accept" },
    { kind: "connect", op: "connect", authority: "example.com:443", id: 1, event: "end", result: "ok" },
    { kind: "connect", op: "connect", authority: "example.org:443", id: 2, event: "deny", reason: "not-allowlisted", status: 403 },
    { kind: "model", op: "anthropic.messages", model: "claude-opus-5-5", destination: "https://model.test", id: 3, event: "accept" },
    { kind: "model", op: "anthropic.messages", model: "claude-opus-5-5", destination: "https://model.test", id: 3, event: "end", result: "ok", status: 200, returned_model: "claude-opus-5-5-20261001" },
  ];
  const lines = entries.map((e, i) => JSON.stringify({ seq: i + 1, t: "2026-11-01T00:00:00.000Z", run, ...e }));
  lines.push(JSON.stringify({ seq: lines.length + 1, t: "2026-11-01T00:00:01.000Z", run, event: "sealed", reason: "stopped", entries: lines.length + 1, audit_full: false, unfinished: 0 }));
  return `${lines.join("\n")}\n`;
}

type Obj = Record<string, any>;
let uids = 0;

/** As the API server stores it: a UID, and for a Sandbox, the Pod its controller makes from the template (owner reference included). */
export function stored(object: Obj): Obj[] {
  const metadata = { ...object.metadata, uid: object.metadata.uid ?? `uid-${++uids}` };
  const kept = { ...object, metadata };
  if (object.kind !== "Sandbox") return [kept];
  const template = object.spec.podTemplate.metadata;
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: metadata.name,
      namespace: metadata.namespace,
      uid: `uid-${++uids}`,
      labels: { ...template.labels, "agents.x-k8s.io/sandbox-name-hash": "f41f7908" },
      annotations: { ...template.annotations, "agents.x-k8s.io/propagated-labels": "" },
      ownerReferences: [{ apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox", name: metadata.name, uid: metadata.uid, controller: true }],
    },
  };
  return [kept, pod];
}

export function fakeCluster(head: string, exportTar: string, overrides: Record<string, Answer> = {}, existing: Obj[] = []) {
  const calls: Call[] = [];
  /** Everything in the cluster, as the API server would list it. */
  const objects: Obj[] = existing.flatMap(stored);
  let run = "";
  const PATH = /^\/apis?\/[^/]+(?:\/[^/]+)?\/namespaces\/([^/]+)\/(sandboxes|pods|configmaps|networkpolicies)\/([^/]+)$/;
  const KINDS: Record<string, string> = { sandboxes: "Sandbox", pods: "Pod", configmaps: "ConfigMap", networkpolicies: "NetworkPolicy" };
  const answers: Record<string, Answer> = {
    version: json({ serverVersion: { gitVersion: "v1.37.1+k3s1" } }),
    "get runtimeclass": (call) => json({ handler: call.args[2], scheduling: { nodeSelector: { [FLOOR.label]: FLOOR_ID } } }),
    "get nodes": json({ items: [{ metadata: { name: "node-a" } }] }),
    "get deployment": { status: 1, stderr: "not found" },
    "get networkpolicy": (call) => {
      const ns = call.args[call.args.indexOf("-n") + 1];
      const items = [...(ns === NS.runs ? [{ metadata: { name: "default-deny" }, spec: { podSelector: {} } }] : []), ...objects.filter((o) => o.kind === "NetworkPolicy" && o.metadata.namespace === ns)];
      return json({ items });
    },
    "get service": json({ spec: { clusterIP: "10.43.0.10" } }),
    create: (call) => {
      const items = (JSON.parse(call.stdin) as { items: Obj[] }).items;
      objects.push(...items.flatMap(stored));
      run = String(items[0]?.metadata?.labels?.[LABEL.run] ?? run);
      return {};
    },
    wait: {},
    "get pod": (call) => {
      const proxy = (call.args[2] ?? "").startsWith("p");
      const sandbox = objects.find((o) => o.kind === "Sandbox" && o.metadata.name === call.args[2]);
      return json({
        metadata: { uid: proxy ? "proxy-pod-uid" : "sandbox-pod-uid", ownerReferences: proxy ? [] : [{ kind: "Sandbox", uid: sandbox?.metadata.uid ?? "sandbox-uid" }] },
        spec: { nodeName: "node-a" },
        status: { podIPs: [{ ip: "10.247.1.9" }], containerStatuses: [{ imageID: proxy ? PROXY_IMAGE : AGENT_IMAGE, ...(proxy ? { state: { terminated: { exitCode: 0 } } } : {}) }] },
      });
    },
    "get sandbox": (call) => json({ metadata: { uid: objects.find((o) => o.kind === "Sandbox" && o.metadata.name === call.args[2])?.metadata.uid ?? "sandbox-uid" } }),
    "get node": json({ metadata: { labels: { [FLOOR.label]: FLOOR_ID } }, status: { nodeInfo: { osImage: "Ubuntu 24.04", kernelVersion: "6.8.0", containerRuntimeVersion: "containerd://2.3", architecture: "arm64" } } }),
    "logs tripwire": { stdout: Buffer.from('{"canary":"10.43.0.10:53","reached":false,"error":"timeout"}\n') },
    "logs proxy": () => ({ stdout: Buffer.from(sealedAudit(run)) }),
    "exec receive": {},
    "exec prepare": { stdout: Buffer.from(`base=${head}\nuid=1000\nkernel=4.19.0-gvisor\ndmesg=[   0.000000] Starting gVisor...\n`) },
    "exec agent": { stdout: Buffer.from('{"done":true}\n'), stderr: "working\n" },
    "exec freeze": {},
    "exec export": (_call, options) => {
      if (options.stdoutFile) fs.copyFileSync(exportTar, options.stdoutFile);
      return {};
    },
    "exec kill": {},
    "list runs": (call) => {
      const ns = call.args[call.args.indexOf("-n") + 1];
      const [key, value] = (call.args[call.args.indexOf("-l") + 1] ?? "").split("=");
      return json({ items: objects.filter((o) => o.metadata.namespace === ns && key && o.metadata.labels?.[key] !== undefined && (value === undefined || o.metadata.labels[key] === value)) });
    },
    delete: (call) => {
      // Only `delete --raw PATH -f -` with a UID precondition, as the runner sends it.
      const m = PATH.exec(call.args[call.args.indexOf("--raw") + 1] ?? "");
      if (!m) return { status: 1, stderr: "unscripted delete" };
      const [, ns, plural, name] = m;
      const at = objects.findIndex((o) => o.metadata.namespace === ns && o.kind === KINDS[plural ?? ""] && o.metadata.name === name);
      if (at < 0) return { status: 1, stderr: `Error from server (NotFound): ${plural} "${name}" not found` };
      const precondition = (JSON.parse(call.stdin) as { preconditions?: { uid?: string } }).preconditions?.uid;
      if (precondition !== objects[at]?.metadata.uid) return { status: 1, stderr: "Error from server (Conflict): the UID in the precondition does not match" };
      objects.splice(at, 1);
      return {};
    },
    ...overrides,
  };
  const keyOf = (args: string[]) => {
    if (args[0] === "exec") {
      const after = args.slice(args.indexOf("--") + 1);
      return after[0] === "sh" ? `exec ${after[2]}` : `exec ${after[0]}`;
    }
    if (args[0] === "logs") return `logs ${args[args.indexOf("-c") + 1]}`;
    if (args[0] === "get" && args[1] === "sandbox,pod,configmap,networkpolicy") return "list runs";
    if (args[0] === "get") return `get ${args[1]}`;
    return args[0] ?? "";
  };
  const kubectl: Kubectl = async (args, options = {}) => {
    const call = { args: [...args], stdin: options.stdin?.toString() ?? "" };
    calls.push(call);
    if (options.signal?.aborted) throw options.signal.reason;
    const answer = answers[keyOf(call.args)];
    if (answer === undefined) return { status: 1, stdout: Buffer.alloc(0), stderr: `unscripted: ${args.join(" ")}` };
    const result = typeof answer === "function" ? await answer(call, options) : answer;
    return { status: 0, stdout: Buffer.alloc(0), stderr: "", ...result };
  };
  return { kubectl, calls, objects };
}

/** A labelled object as a test puts it in the cluster: one of a run's, or a foreign one. */
export const labelled = (kind: string, namespace: string, name: string, labels: Record<string, string>, deadline: number | null): Obj => ({
  apiVersion: "v1",
  kind,
  metadata: { name, namespace, labels, annotations: deadline === null ? {} : { [DEADLINE]: String(deadline) } },
  ...(kind === "Sandbox" ? { spec: { podTemplate: { metadata: { labels, annotations: deadline === null ? {} : { [DEADLINE]: String(deadline) } } } } } : {}),
});
