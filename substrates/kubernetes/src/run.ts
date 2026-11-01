// Per-run mode: one task in a fresh Sandbox, start to finish.
//
//   [claim] -> preflight (reconcile, floor, policies) -> bundle (outside) -> proxy Pod
//   -> Sandbox (tripwire) -> clone -> agent -> freeze -> export
//   -> seal the proxy -> its audit -> teardown (always) -> patch (outside) -> record
//
// The command adapter runs the same way without a repository: no bundle or
// clone, its argv run in /workspace with its input files read-only there, and
// the files it wrote collected outside instead of a patch. Under a caller's key,
// the output directory is the key's durable receipt (receipt.ts).
//
// Every object a run creates carries its run label and deadline, so teardown
// is one delete per namespace, its check one list per namespace, and a run
// whose runner was lost is deleted by the next `setup` or `run`. Teardown runs
// whatever happened before it, cancellation included, and its result is
// recorded separately from the run's.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAsset, isSea } from "node:sea";

import { blacksandInfo } from "../../../src/core/envelope.ts";
import { agentEnv, agentNamed, type AgentName } from "./agents.ts";
import { readAudit } from "./audit.ts";
import { census, deleteObjects, reconcile } from "./lifecycle.ts";
import { collectFiles, collectPatch } from "./collect.ts";
import { getJson, must, type Kubectl, type KubectlOptions, type KubectlResult } from "./kubectl.ts";
import { COMMAND_INPUTS, LABEL, NS, assertPinned, list, proxyObjects, runNames, sandboxObjects } from "./manifests.ts";
import { FLOOR, FLOOR_ID } from "./node.ts";
import { assertModel, canonical, DEFAULT_LIMITS, proxyConfig, sha256, type Allow, type Limits, type RouteSpec } from "./policy.ts";
import { answerFromReceipt, CLAIM_SCHEMA, publishDurable, takeClaim, writeDurable } from "./receipt.ts";
import { recordProblems, RUN_SCHEMA, type Artifact, type RunRecord } from "./record.ts";

const SANDBOX_DIR = new URL("../sandbox/", import.meta.url);
/** A file from sandbox/: on disk beside this module, or, in a single binary, the copy scripts/build-sea.ts embedded as `sandbox/NAME`. */
export const sandboxFile = (name: string) => (isSea() ? getAsset(`sandbox/${name}`, "utf8") : fs.readFileSync(new URL(name, SANDBOX_DIR), "utf8"));

/** What the command adapter runs: an argument list (never a shell line) and its input files by relative path. */
export interface CommandSpec {
  argv: string[];
  inputs: Record<string, Buffer>;
}

export interface RunSpec {
  /** A local git repository (its committed HEAD) or an https URL, cloned here, outside the sandbox; null for a command. */
  repo: string | null;
  /** The agent's prompt; "" for a command. */
  prompt: string;
  agent: AgentName;
  /** Null only for a command with no model route. */
  model: string | null;
  /** The models the run may name; the agent's model is always among them. */
  models: string[];
  routes: RouteSpec[];
  allow: Allow[];
  image: string;
  /** An image holding the agent's binaries, mounted read-only; null when the agent image has them. */
  toolsImage: string | null;
  proxyImage: string;
  timeoutSeconds: number;
  /** The proxy's request budget for the run (DEFAULT_LIMITS.requests_total when not given). */
  maxModelRequests?: number;
  /** Time the run may take beyond the agent's own (start, clone, collect) before everything of it expires. */
  slackSeconds?: number;
  /** The caller's own id for the run, recorded as given. With a key, `out` is its receipt (receiptDir): claimed with one mkdir, and a claim already there is answered from, never run again. */
  key: string | null;
  /** Directory for the record and artifacts: with a key, receiptDir(root, key); without one, a directory that doesn't exist yet. */
  out: string;
  /** For the command adapter. */
  command?: CommandSpec;
  /** For the fake agent: where its allowed, denied and direct calls go. */
  fake?: { allowed: string; denied: string; direct: string[] };
}

export interface RunDeps {
  kubectl: Kubectl;
  now(): number;
  randomHex(bytes: number): string;
  /** The repository's HEAD as a git bundle. */
  bundle(repo: string): Promise<{ data: Buffer; head: string }>;
  progress(text: string): void;
  /** Waits between polls (tests pass one that doesn't). */
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
  /** Called after the agent's step and before the freeze, with an exec into the sandbox (tests look around). */
  inspect?(exec: (args: readonly string[], options?: KubectlOptions) => Promise<KubectlResult>): Promise<void>;
}

export const processRunDeps = (kubectl: Kubectl, progress: (text: string) => void, signal?: AbortSignal): RunDeps => ({
  kubectl,
  now: () => Date.now(),
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  bundle: hostBundle,
  progress,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...(signal ? { signal } : {}),
});

const isUrl = (repo: string) => /^https:\/\//.test(repo);

function git(args: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git: ${err.trim().slice(0, 300)}`))));
  });
}

/** The repository's HEAD as a bundle, and the commit it holds. A URL is cloned bare first (no checkout, so no filters or hooks run). */
export async function hostBundle(repo: string): Promise<{ data: Buffer; head: string }> {
  let dir = repo;
  let tmp: string | null = null;
  try {
    if (isUrl(repo)) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-clone-"));
      dir = path.join(tmp, "repo.git");
      await git(["clone", "--quiet", "--bare", "--no-tags", "--", repo, dir]);
    }
    const head = (await git(["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
    return { data: await git(["-C", dir, "bundle", "create", "--quiet", "-", "HEAD"]), head };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

function hashFile(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n; (n = fs.readSync(fd, chunk)) > 0; ) hash.update(chunk.subarray(0, n));
    fs.fsyncSync(fd); // on disk before the record that names it
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
const STEPS = "/run/blacksand/inputs/steps.sh";
/** A command's limits: what fits in its inputs ConfigMap (1 MiB in all) with room for the rest. */
const MAX_ARGV_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 768 * 1024;
const MAX_INPUT_FILES = 1000;
/** An input path: relative, plain segments, none starting with a dot. */
const INPUT_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const READY_TIMEOUT_S = 300;
const EXPORT_MAX = 1024 * 1024 * 1024;

interface PodJson {
  metadata: { uid: string; ownerReferences?: { uid: string; kind: string }[] };
  spec: { nodeName?: string };
  status: { podIPs?: { ip: string }[]; containerStatuses?: { imageID?: string; state?: { terminated?: unknown } }[] };
}

const resolvedImage = (pod: PodJson) => pod.status.containerStatuses?.[0]?.imageID ?? null;
const digestOf = (image: string | null) => /@(sha256:[0-9a-f]{64})$/.exec(image ?? "")?.[1] ?? null;
const sameDigest = (resolved: string | null, pinned: string) => digestOf(resolved) !== null && digestOf(resolved) === digestOf(pinned);

/** The highest request budget a run may ask for. */
export const MAX_MODEL_REQUESTS = 100_000;

/** The run's model route: the agent's own kind, or for the command adapter, the one the caller gave, if any. */
function routeOf(spec: RunSpec): RouteSpec | null {
  const agent = agentNamed(spec.agent);
  return (agent.route ? spec.routes.find((r) => r.kind === agent.route) : spec.routes[0]) ?? null;
}

function checkCommand(spec: RunSpec): void {
  const command = spec.command;
  if (!command || spec.repo !== null || spec.prompt !== "") throw new Error("the command adapter takes an argv and input files, not a repository or a prompt");
  if (spec.routes.length > 1) throw new Error("a command takes at most one model route");
  if (!command.argv.length || command.argv.some((a) => typeof a !== "string" || a.includes("\0"))) throw new Error("a command needs an argv: one or more arguments, none with a NUL");
  if (Buffer.byteLength(command.argv.join("")) > MAX_ARGV_BYTES) throw new Error(`a command's argv is over ${MAX_ARGV_BYTES} bytes`);
  const names = Object.keys(command.inputs);
  if (names.length > MAX_INPUT_FILES) throw new Error(`a command takes at most ${MAX_INPUT_FILES} input files`);
  if (Object.values(command.inputs).reduce((n, data) => n + data.length, 0) > MAX_INPUT_BYTES) throw new Error(`a command's input files are over ${MAX_INPUT_BYTES} bytes in all`);
  for (const name of names) {
    if (name.length > 255 || !name.split("/").every((part) => INPUT_SEGMENT.test(part))) throw new Error(`input ${JSON.stringify(name)}: a relative path of plain segments, none starting with a dot`);
    if (names.some((other) => other.startsWith(`${name}/`))) throw new Error(`input ${JSON.stringify(name)} is both a file and a directory`);
  }
}

/** Checks a spec before anything is created; throws saying what's wrong. */
export function checkSpec(spec: RunSpec): void {
  const agent = agentNamed(spec.agent);
  if (agent.name === "command") checkCommand(spec);
  else if (spec.command || spec.repo === null) throw new Error(`agent ${agent.name} takes a repository and a prompt, not a command`);
  const route = routeOf(spec);
  spec.models.forEach(assertModel);
  if (route || agent.route) {
    if (spec.model === null) throw new Error(`a run with a model route needs a model`);
    assertModel(spec.model);
    if (!spec.models.includes(spec.model)) throw new Error(`the agent's model ${spec.model} must be among the granted models`);
  } else if (spec.model !== null || spec.models.length) throw new Error("a command with no model route can't be granted models");
  assertPinned(spec.image);
  assertPinned(spec.proxyImage);
  if (spec.toolsImage) assertPinned(spec.toolsImage);
  if (agent.route && !route) throw new Error(`agent ${agent.name} needs a ${agent.route} route (--route ${agent.route}=URL@SECRET)`);
  if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 10 || spec.timeoutSeconds > 24 * 3600) throw new Error("timeout must be 10 s to 24 h");
  const budget = spec.maxModelRequests ?? DEFAULT_LIMITS.requests_total;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_MODEL_REQUESTS) throw new Error(`the model request budget must be 1 to ${MAX_MODEL_REQUESTS}`);
  if (spec.key !== null && path.basename(spec.out) !== sha256(spec.key)) throw new Error("with a key, the output directory is the key's receipt: receiptDir(root, key)");
  if (spec.key === null && fs.existsSync(spec.out)) throw new Error(`${spec.out} already exists: give each run a new --out`);
  if (spec.repo === null) return;
  if (isUrl(spec.repo)) {
    const url = new URL(spec.repo);
    if (url.username || url.password) throw new Error("the repository URL can't carry credentials");
  } else if (!fs.existsSync(spec.repo)) throw new Error(`no repository at ${spec.repo}`);
}

/**
 * The digest of everything that decides what a run does: the whole spec but
 * its output directory and key, with the prompt and input files by digest.
 * (A local repository counts by its path: the record's source.base says
 * which commit it was.)
 */
export function requestDigest(spec: RunSpec): string {
  const { out: _out, key: _key, prompt, command, ...rest } = spec;
  const request = {
    ...rest,
    maxModelRequests: spec.maxModelRequests ?? DEFAULT_LIMITS.requests_total,
    slackSeconds: spec.slackSeconds ?? 300,
    prompt_sha256: sha256(prompt),
    command: command ? { argv: command.argv, inputs: Object.fromEntries(Object.entries(command.inputs).map(([name, data]) => [name, sha256(data)])) } : null,
  };
  return sha256(canonical(JSON.parse(JSON.stringify(request))));
}

type Listed = { items: { metadata: { name: string; labels?: Record<string, string> } }[] };

export { reconcile };

export async function runOnce(spec: RunSpec, deps: RunDeps): Promise<RunRecord> {
  checkSpec(spec);
  const agent = agentNamed(spec.agent);
  const route = routeOf(spec);
  const request = requestDigest(spec);
  const command = spec.command ?? null;
  const names = runNames(deps.randomHex(6));
  const token = deps.randomHex(32);
  const startedMs = deps.now();
  const lifetime = spec.timeoutSeconds + (spec.slackSeconds ?? 300);
  const deadlineMs = startedMs + lifetime * 1000;
  const k = (args: readonly string[], options: KubectlOptions = {}) => deps.kubectl(args, { ...(deps.signal ? { signal: deps.signal } : {}), ...options });
  const kMust = (args: readonly string[], options: KubectlOptions = {}) => must(k, args, options);
  const kJson = <T>(args: readonly string[]) => getJson<T>(k, args);
  const exec = (args: readonly string[], options: KubectlOptions = {}) => k(["exec", "-i", "-n", NS.runs, names.sandbox, "-c", "agent", "--", ...args], options);
  const step = async (name: string, options: KubectlOptions = {}) => {
    const result = await exec(["sh", STEPS, name], options);
    if (result.status !== 0) throw new Error(`step ${name} failed (${result.status ?? result.killed ?? "killed"}): ${result.stderr.trim().slice(0, 500)}`);
    return result.stdout;
  };

  const files = new Map<string, Buffer>();
  const proxySource = sandboxFile("proxy.ts");
  const inputs: Record<string, string> = { "steps.sh": sandboxFile("steps.sh"), "agent.sh": agent.script };
  if (command) Object.assign(inputs, { argc: String(command.argv.length) }, Object.fromEntries(command.argv.map((arg, i) => [`argv.${i}`, arg])));
  else inputs.prompt = spec.prompt;
  const models = [...new Set(spec.models)].sort();
  const limits: Limits = { ...DEFAULT_LIMITS, requests_total: spec.maxModelRequests ?? DEFAULT_LIMITS.requests_total };
  const r: RunRecord = {
    schema: RUN_SCHEMA,
    blacksand: blacksandInfo(),
    run: { id: names.id, key: spec.key, request_sha256: request, status: "failed", complete: false, error: null },
    substrate: { kind: "kubernetes", adapter: "substrate-k8s", mode: "per-run" },
    times: { started: iso(startedMs), sandbox_ready: null, agent_started: null, agent_ended: null, ended: "", deadline: iso(deadlineMs) },
    cluster: { server_version: null, node: { name: null, os_image: null, kernel: null, container_runtime: null, architecture: null } },
    sandbox: {
      namespace: NS.runs,
      name: names.sandbox,
      uid: null,
      pod_uid: null,
      runtime_class: FLOOR.runtimes.sandbox,
      runtime_handler: null,
      observed: { uid: null, kernel: null, dmesg: null },
      controller_image: null,
      floor: { node_label: null, canary: null, canary_reached: null },
      left_running: null,
    },
    image: { requested: spec.image, resolved: null, matches: false, tools: spec.toolsImage },
    proxy: { pod: names.proxy, pod_uid: null, image: spec.proxyImage, resolved: null, matches: false, source_sha256: sha256(proxySource) },
    policy: { allow: spec.allow, route: route ? { kind: route.kind, origin: route.origin, base_path: route.basePath, secret: route.secret } : null, models, limits, effective_sha256: null, inputs_sha256: "" },
    source: { repo: spec.repo, kind: spec.repo === null ? "none" : isUrl(spec.repo) ? "url" : "local", base: null },
    agent: { name: agent.name, model: spec.model, route: route?.kind ?? null, settings: { ...agent.settings }, exit_status: null, env_names: [] },
    command: command ? { argv_sha256: sha256(JSON.stringify(command.argv)), argc: command.argv.length, inputs: Object.fromEntries(Object.keys(command.inputs).sort().map((name) => [name, sha256(command.inputs[name] as Buffer)])) } : null,
    egress: { allowed: 0, denied: 0, denied_hosts: {}, model_calls: [], audit: null },
    result: { patch: null, patch_files: null, ignored_files: null, skipped_entries: null, files: null },
    artifacts: [],
    cleanup: { status: "not-run", remaining: [], foreign: [] },
  };

  if (spec.key !== null) {
    // The receipt: one mkdir decides which runner process owns the key; the claim is on disk before the cluster is touched.
    const claim = { schema: CLAIM_SCHEMA, key: spec.key, request_sha256: request, run_id: names.id, claimed_at: iso(startedMs), deadline: iso(deadlineMs) } as const;
    if (!takeClaim(spec.out, claim)) {
      const prior = answerFromReceipt(spec.out, spec.key, request);
      deps.progress(`key ${spec.key}: already completed as run ${prior.run.id}; not launched again`);
      return prior;
    }
  } else fs.mkdirSync(spec.out, { recursive: true, mode: 0o700 });
  const exportFile = path.join(spec.out, "workspace.tar");
  let bundle: { data: Buffer; head: string } | null = null;
  let exported = false;
  let created = false;
  let sandboxUp = false;
  try {
    // Preflight: what the cluster says it is, before anything is created.
    const version = await kJson<{ serverVersion?: { gitVersion?: string } }>(["version"]);
    r.cluster.server_version = version.serverVersion?.gitVersion ?? null;
    const cleared = await reconcile(k, deps.now());
    if (cleared.deleted.length) deps.progress(`deleted ${cleared.deleted.length} expired run(s): ${cleared.deleted.join(", ")}`);
    for (const object of cleared.foreign) deps.progress(`left alone, not created by blacksand: ${object}`);
    // The floor: both RuntimeClasses must schedule only onto nodes labelled with this floor, and such a node must exist.
    for (const name of [FLOOR.runtimes.sandbox, FLOOR.runtimes.proxy]) {
      const rc = await kJson<{ handler: string; scheduling?: { nodeSelector?: Record<string, string> } }>(["get", "runtimeclass", name]);
      if (rc.handler !== name || rc.scheduling?.nodeSelector?.[FLOOR.label] !== FLOOR_ID) throw new Error(`RuntimeClass ${name} doesn't require egress floor ${FLOOR_ID}: run blacksand k8s setup`);
    }
    r.sandbox.runtime_handler = FLOOR.runtimes.sandbox;
    const floorNodes = await kJson<{ items: unknown[] }>(["get", "nodes", "-l", `${FLOOR.label}=${FLOOR_ID}`]);
    if (!floorNodes.items.length) throw new Error(`no node has egress floor ${FLOOR_ID}: install it with blacksand k8s node-setup`);
    const controller = await k(["get", "deployment", "agent-sandbox-controller", "-n", "agent-sandbox-system", "-o", "json"]);
    if (controller.status === 0) r.sandbox.controller_image = (JSON.parse(controller.stdout.toString()) as { spec: { template: { spec: { containers: { image: string }[] } } } }).spec.template.spec.containers[0]?.image ?? null;
    // Policies add up: another policy in the runs namespace could allow what this run's doesn't, so refuse to run beside one.
    const existing = await kJson<Listed>(["get", "networkpolicy", "-n", NS.runs]);
    const foreign = existing.items.filter((p) => p.metadata.name !== "default-deny" && !p.metadata.labels?.[LABEL.run]).map((p) => p.metadata.name);
    if (foreign.length) throw new Error(`the ${NS.runs} namespace has NetworkPolicies blacksand didn't create (${foreign.join(", ")}): they could widen this run's egress`);
    if (!existing.items.some((p) => p.metadata.name === "default-deny")) throw new Error(`the ${NS.runs} namespace has no default-deny policy: run blacksand k8s setup`);
    const dns = await kJson<{ spec: { clusterIP?: string } }>(["get", "service", "kube-dns", "-n", "kube-system"]);
    if (!dns.spec.clusterIP || dns.spec.clusterIP.includes(":")) throw new Error("no IPv4 cluster DNS Service (kube-system/kube-dns) for the tripwire's canary");
    const canary = { host: dns.spec.clusterIP, port: 53 };
    if (spec.repo !== null) bundle = await deps.bundle(spec.repo);

    // The proxy first: the sandbox is given its address, and nothing else.
    deps.progress(`run ${names.id}: starting the proxy`);
    const config = proxyConfig({ run: names.id, allow: spec.allow, route, models, tokenSha256: sha256(token), expiresAt: deadlineMs, limits });
    const deadline = Math.ceil(deadlineMs / 1000);
    created = true;
    await kMust(["create", "-f", "-"], { stdin: JSON.stringify(list(proxyObjects({ names, image: spec.proxyImage, files: { "proxy.ts": proxySource, "config.json": `${JSON.stringify(config, null, 2)}\n` }, route, deadlineSeconds: lifetime, deadline }))) });
    await kMust(["wait", "--for=condition=Ready", `pod/${names.proxy}`, "-n", NS.egress, `--timeout=${READY_TIMEOUT_S}s`], { timeoutMs: (READY_TIMEOUT_S + 10) * 1000 });
    const proxyPod = await kJson<PodJson>(["get", "pod", names.proxy, "-n", NS.egress]);
    const proxyIp = proxyPod.status.podIPs?.map((p) => p.ip).find((ip) => !ip.includes(":"));
    if (!proxyIp) throw new Error("the proxy Pod has no IPv4 address");
    r.proxy.pod_uid = proxyPod.metadata.uid;
    r.proxy.resolved = resolvedImage(proxyPod);
    r.proxy.matches = sameDigest(r.proxy.resolved, spec.proxyImage);
    if (!r.proxy.matches) throw new Error("the proxy Pod isn't running its pinned image");

    deps.progress(`run ${names.id}: starting the sandbox`);
    const ctx = { proxyIp };
    Object.assign(inputs, agent.files(ctx));
    if (agent.name === "fake") inputs["fake-agent.ts"] = sandboxFile("fake-agent.ts");
    const fakeEnv: Record<string, string> = spec.fake ? { BLACKSAND_FAKE_ALLOWED: spec.fake.allowed, BLACKSAND_FAKE_DENIED: spec.fake.denied, BLACKSAND_FAKE_DIRECT: spec.fake.direct.join(",") } : {};
    const env = agentEnv(route?.kind ?? null, ctx, spec.model, token, fakeEnv);
    r.agent.env_names = Object.keys(env).sort();
    await kMust(["create", "-f", "-"], {
      stdin: JSON.stringify(list(sandboxObjects({ names, image: spec.image, toolsImage: spec.toolsImage, tripwire: { image: spec.proxyImage, canary }, inputs, ...(command ? { files: command.inputs } : {}), env, deadlineSeconds: lifetime, shutdownTime: iso(deadlineMs), deadline }))),
    });
    sandboxUp = true;
    await kMust(["wait", "--for=condition=Ready", `sandbox/${names.sandbox}`, "-n", NS.runs, `--timeout=${READY_TIMEOUT_S}s`], { timeoutMs: (READY_TIMEOUT_S + 10) * 1000 });
    r.times.sandbox_ready = iso(deps.now());

    // What actually runs: the Sandbox, the Pod it owns, the image it resolved, its node's floor and the policies in effect.
    const sandbox = await kJson<{ metadata: { uid: string } }>(["get", "sandbox", names.sandbox, "-n", NS.runs]);
    const pod = await kJson<PodJson>(["get", "pod", names.sandbox, "-n", NS.runs]);
    if (!pod.metadata.ownerReferences?.some((o) => o.kind === "Sandbox" && o.uid === sandbox.metadata.uid)) throw new Error("the sandbox Pod isn't owned by the run's Sandbox");
    r.sandbox.uid = sandbox.metadata.uid;
    r.sandbox.pod_uid = pod.metadata.uid;
    r.image.resolved = resolvedImage(pod);
    r.image.matches = sameDigest(r.image.resolved, spec.image);
    if (pod.spec.nodeName) {
      const node = await kJson<{ metadata: { labels?: Record<string, string> }; status: { nodeInfo: Record<string, string> } }>(["get", "node", pod.spec.nodeName]);
      const info = node.status.nodeInfo;
      r.cluster.node = { name: pod.spec.nodeName, os_image: info.osImage ?? null, kernel: info.kernelVersion ?? null, container_runtime: info.containerRuntimeVersion ?? null, architecture: info.architecture ?? null };
      r.sandbox.floor.node_label = node.metadata.labels?.[FLOOR.label] ?? null;
    }
    if (r.sandbox.floor.node_label !== FLOOR_ID) throw new Error(`the sandbox's node doesn't carry egress floor ${FLOOR_ID}`);
    const trip = await kMust(["logs", names.sandbox, "-n", NS.runs, "-c", "tripwire"]);
    let tripped: { canary?: string; reached?: boolean } = {};
    try {
      tripped = JSON.parse(trip.toString().trim().split("\n").at(-1) ?? "") as typeof tripped;
    } catch {}
    r.sandbox.floor.canary = tripped.canary ?? null;
    r.sandbox.floor.canary_reached = typeof tripped.reached === "boolean" ? tripped.reached : null;
    if (r.sandbox.floor.canary_reached !== false) throw new Error(r.sandbox.floor.canary_reached ? "the sandbox reached cluster DNS directly: the node's egress floor isn't in effect" : "the tripwire didn't report");
    const effective = [];
    for (const ns of [NS.runs, NS.egress]) {
      const items = (await kJson<{ items: { metadata: { name: string }; spec: unknown }[] }>(["get", "networkpolicy", "-n", ns])).items;
      effective.push(...items.map((p) => ({ namespace: ns, name: p.metadata.name, spec: p.spec })));
    }
    // Canonical JSON, so the record's digest is the file's own: shasum policies.json checks it.
    const policies = Buffer.from(`${canonical(effective)}\n`);
    files.set("policies.json", policies);
    r.policy.effective_sha256 = sha256(policies);

    if (bundle) {
      deps.progress(`run ${names.id}: cloning`);
      await step("receive", { stdin: bundle.data, timeoutMs: 300_000 });
    }
    const prepared = (await step(bundle ? "prepare" : "observe", { timeoutMs: 600_000 })).toString();
    files.set("prepare.txt", Buffer.from(prepared));
    const seen = Object.fromEntries(prepared.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    r.sandbox.observed = { uid: seen.uid ?? null, kernel: seen.kernel ?? null, dmesg: seen.dmesg || null };
    if (bundle) {
      if (seen.base !== bundle.head) throw new Error(`the sandbox cloned ${seen.base ?? "nothing"}, not the repository's HEAD ${bundle.head}`);
      r.source.base = bundle.head;
    }

    deps.progress(`run ${names.id}: running ${agent.name}`);
    r.times.agent_started = iso(deps.now());
    const ran = await exec(["sh", STEPS, bundle ? "agent" : "run"], { timeoutMs: spec.timeoutSeconds * 1000 });
    r.times.agent_ended = iso(deps.now());
    r.agent.exit_status = ran.status;
    files.set("agent.stdout", ran.stdout);
    files.set("agent.stderr", Buffer.from(ran.stderr));
    if (ran.killed === "output-limit") throw new Error("the agent printed more than 64 MiB");
    if (deps.inspect) await deps.inspect(exec);

    // Freeze, then export: nothing the agent started can change the workspace after this.
    const frozen = (await step("freeze", { timeoutMs: 60_000 })).toString();
    r.sandbox.left_running = (frozen.match(/^running=/gm) ?? []).length;
    if (r.sandbox.left_running) throw new Error(`${r.sandbox.left_running} process(es) still running after the freeze`);
    const tar = await exec(["sh", STEPS, bundle ? "export" : "export-workspace"], { stdoutFile: exportFile, maxOutput: EXPORT_MAX, timeoutMs: 600_000 });
    if (tar.status !== 0) throw new Error(tar.killed === "output-limit" ? "the workspace is over 1 GiB" : `step export failed (${tar.status ?? tar.killed ?? "killed"}): ${tar.stderr.trim().slice(0, 300)}`);
    exported = true;
    if (ran.killed === "timeout") {
      r.run.status = "timed_out";
      r.run.error = `the agent ran past ${spec.timeoutSeconds} s`;
    } else r.run.status = "completed";
  } catch (error) {
    r.run.status = deps.signal?.aborted ? "cancelled" : "failed";
    r.run.error = error instanceof Error ? error.message : String(error);
  } finally {
    // No signal from here on: cancelling a run doesn't cancel its cleanup.
    const quiet = (args: readonly string[], timeoutMs = 60_000) => deps.kubectl(args, { timeoutMs }).catch(() => null);
    if (sandboxUp && r.sandbox.left_running === null) await quiet(["exec", "-n", NS.runs, names.sandbox, "-c", "agent", "--", "sh", STEPS, "freeze"]);
    if (created) {
      // Seal the proxy (it ends what's open, writes its closing marker and exits), then read its audit.
      await quiet(["exec", "-n", NS.egress, names.proxy, "-c", "proxy", "--", "kill", "-TERM", "1"]);
      for (let i = 0; i < 30; i++) {
        const got = await quiet(["get", "pod", names.proxy, "-n", NS.egress, "-o", "json"]);
        if (got?.status !== 0 || (JSON.parse(got.stdout.toString()) as PodJson).status.containerStatuses?.[0]?.state?.terminated) break;
        await deps.sleep(1000);
      }
      const logs = await quiet(["logs", names.proxy, "-n", NS.egress, "-c", "proxy"]);
      if (logs?.status === 0) files.set("egress.jsonl", logs.stdout);
      deps.progress(`run ${names.id}: tearing down`);
      // Exactly this run's objects, each by its UID; anything else wearing its label is reported, not touched.
      const plain = (args: readonly string[], options: KubectlOptions = {}) => deps.kubectl(args, { timeoutMs: 60_000, ...options });
      let foreign: string[] = [];
      let remaining: string[];
      try {
        const before = await census(plain, names.id);
        await deleteObjects(plain, before.runs.get(names.id) ?? []);
        const after = await census(plain, names.id);
        remaining = (after.runs.get(names.id) ?? []).map((o) => `${o.namespace}/${o.kind}/${o.name}`);
        foreign = after.foreign;
      } catch (error) {
        remaining = [`couldn't finish: ${(error as Error).message.slice(0, 200)}`];
      }
      r.cleanup = { status: remaining.length ? "incomplete" : "verified-absent", remaining, foreign };
    }
  }

  // The audit and the patch, both judged here, outside the cluster.
  const egress = files.get("egress.jsonl");
  if (egress) {
    const audit = readAudit(egress.toString("utf8"), names.id);
    r.egress = { allowed: audit.allowed, denied: audit.denied, denied_hosts: audit.denied_hosts, model_calls: audit.model_calls, audit: { entries: audit.entries, sealed: audit.sealed, problems: audit.problems } };
  }
  if (exported && bundle && r.source.base) {
    try {
      const collected = collectPatch(bundle.data, r.source.base, exportFile);
      files.set("patch.diff", collected.patch);
      r.result.patch_files = collected.files;
      r.result.ignored_files = collected.ignored;
      r.result.skipped_entries = collected.skipped;
    } catch (error) {
      if (r.run.status === "completed") r.run.status = "failed";
      r.run.error ??= `the patch couldn't be made: ${(error as Error).message}`;
    }
  }
  if (exported && command) {
    // The command's files, read from the export here, outside; its read-only inputs aren't its output.
    try {
      const collected = collectFiles(exportFile, path.join(spec.out, "files"), path.posix.relative("/workspace", COMMAND_INPUTS));
      r.result.files = collected.files;
      r.result.skipped_entries = collected.skipped;
    } catch (error) {
      if (r.run.status === "completed") r.run.status = "failed";
      r.run.error ??= `the command's files couldn't be collected: ${(error as Error).message}`;
    }
  }
  r.policy.inputs_sha256 = sha256(canonical(inputs));
  r.times.ended = iso(deps.now());
  for (const [file, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    writeDurable(path.join(spec.out, file), data);
    const artifact: Artifact = { file, sha256: sha256(data), bytes: data.length };
    r.artifacts.push(artifact);
    if (file === "patch.diff") r.result.patch = artifact;
  }
  if (fs.existsSync(exportFile)) r.artifacts.push({ file: "workspace.tar", sha256: hashFile(exportFile), bytes: fs.statSync(exportFile).size });
  const missing = recordProblems({ ...r, run: { ...r.run, complete: true } });
  r.run.complete = r.run.status === "completed" && missing.length === 0;
  if (r.run.status === "completed" && missing.length) r.run.error = `incomplete evidence: ${missing.join("; ")}`;
  const problems = recordProblems(r);
  if (problems.length) throw new Error(`run ${names.id} produced a malformed record: ${problems.join("; ")}`);
  // Last, whole or not at all: a receipt with this file is completed, and one without it is unknown.
  publishDurable(path.join(spec.out, "record.json"), `${JSON.stringify(r, null, 2)}\n`);
  return r;
}
