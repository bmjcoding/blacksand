// Native: the substrate on a real cluster with agent-sandbox, gVisor, the
// egress floor and an enforcing NetworkPolicy controller. Deep because it
// starts a VM and pulls images; skipped unless a cluster is configured:
//   BLACKSAND_KUBECTL='["limactl","shell","lab","sudo","k3s","kubectl"]'   how to reach it
//   BLACKSAND_K8S_LIMA='["limactl","lab"]'   optional: start this Lima VM first (installing the floor
//     if its node lacks it), and stop it after
//   BLACKSAND_K8S_ALLOWED=example.com:443    optional: the public host the run may reach
//   BLACKSAND_K8S_DENIED=example.org:443     optional: one it may not
//   BLACKSAND_K8S_TOOLS_IMAGE=blacksand.local/agent-tools@sha256:…   optional: also run the real Claude Code and
//     Codex (from images/agent-tools.sh) at their default models against the fake model, each editing the repository
//     through its tools; Codex with apply_patch, then a probe it runs itself
// Evidence (records and artifacts) goes to BLACKSAND_K8S_EVIDENCE, else a temp dir.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { AGENTS } from "../src/agents.ts";
import { IMAGES } from "../src/command.ts";
import { getJson, must, type Kubectl, type KubectlOptions, type KubectlResult } from "../src/kubectl.ts";
import { LABEL, NS, list, setupObjects } from "../src/manifests.ts";
import { FLOOR, FLOOR_ID, nodeSetupScript } from "../src/node.ts";
import { parseAllow, parseRoute } from "../src/policy.ts";
import { recordProblems, type RunRecord } from "../src/record.ts";
import { processRunDeps, reconcile, runOnce, type RunSpec } from "../src/run.ts";
import { FAKE_MODEL, deployFakeModel, floorTargets, labKubectl, probePod, removeFakeModel, type ProbeResult } from "./fixtures/lab.ts";

const configured = Boolean(process.env.BLACKSAND_KUBECTL);
const lima = process.env.BLACKSAND_K8S_LIMA ? (JSON.parse(process.env.BLACKSAND_K8S_LIMA) as [string, string]) : null;
const allowed = process.env.BLACKSAND_K8S_ALLOWED ?? "example.com:443";
const denied = process.env.BLACKSAND_K8S_DENIED ?? "example.org:443";
const evidence = process.env.BLACKSAND_K8S_EVIDENCE ?? fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-journey-"));
const skip = configured ? false : "set BLACKSAND_KUBECTL to run against a cluster";
const toolsImage = process.env.BLACKSAND_K8S_TOOLS_IMAGE ?? null;
const skipReal = skip || (toolsImage ? false : "set BLACKSAND_K8S_TOOLS_IMAGE to run the real agents");
const FLOOR_TEST_NS = "blacksand-floortest";

let kubectl: Kubectl;
let model: { upstream: string; ipv6: string; key: string };
let repo: string;
let head: string;
const timings: Record<string, number> = {};
const save = (file: string, value: unknown) => fs.writeFileSync(path.join(evidence, file), `${JSON.stringify(value, null, 2)}\n`);

async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = Math.round(performance.now() - start);
  }
}

function makeRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args]).toString().trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "a repository for the journey\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return { dir, head: git("rev-parse", "HEAD") };
}

function spec(out: string, change: Partial<RunSpec> = {}): RunSpec {
  return {
    repo,
    prompt: "Add a note saying the fake agent ran.",
    agent: "fake",
    model: "claude-opus-5-5",
    models: ["claude-opus-5-5"],
    routes: [parseRoute(`anthropic=${model.upstream}@${FAKE_MODEL.secret}`)],
    allow: [parseAllow(allowed)],
    image: IMAGES.agent,
    toolsImage: null,
    proxyImage: IMAGES.proxy,
    timeoutSeconds: 120,
    key: `journey/${path.basename(out)}`,
    out: path.join(evidence, out),
    // The fake model's own addresses: reachable from its proxy, so a refusal here is the sandbox's boundary.
    fake: { allowed, denied, direct: [model.upstream.replace("http://", ""), "1.1.1.1:443", `${model.ipv6}:8080`] },
    ...change,
  };
}

/** Everything a sandbox can read that could hold a credential: its environment, its inputs, its writable files. */
async function sandboxContents(exec: (args: readonly string[], options?: KubectlOptions) => Promise<KubectlResult>): Promise<string> {
  // The script goes on stdin: kubectl gets plain words only.
  const shown = await exec(["sh", "-s"], { stdin: "env; cat /proc/self/environ; cat /run/blacksand/inputs/*; find /tmp /workspace /home/agent -type f -size -2M -exec cat {} +\n" });
  return shown.stdout.toString("latin1");
}

/** What the fake agent said it saw, in a run's evidence directory. */
const fakeReport = (run: string) => (JSON.parse(fs.readFileSync(path.join(evidence, run, "agent.stdout"), "utf8")) as { fake_agent: Record<string, any> }).fake_agent;

before(async () => {
  if (!configured) return;
  if (lima) await timed("vm_start_ms", async () => void execFileSync(lima[0], ["start", lima[1]], { stdio: "ignore" }));
  kubectl = labKubectl();
  const nodes = await getJson<{ items: unknown[] }>(kubectl, ["get", "nodes", "-l", `${FLOOR.label}=${FLOOR_ID}`]);
  if (!nodes.items.length) {
    if (!lima) throw new Error(`no node has egress floor ${FLOOR_ID}: install it with blacksand k8s node-setup`);
    await timed("floor_install_ms", async () => void execFileSync(lima[0], ["shell", lima[1], "sudo", "sh", "-s"], { input: nodeSetupScript(), stdio: ["pipe", "ignore", "inherit"] }));
  }
  await timed("setup_ms", () => must(kubectl, ["apply", "-f", "-"], { stdin: JSON.stringify(list(setupObjects())) }));
  model = await timed("fake_model_ms", () => deployFakeModel(kubectl, IMAGES.proxy));
  ({ dir: repo, head } = makeRepo());
});

after(async () => {
  if (!configured) return;
  await removeFakeModel(kubectl).catch(() => {});
  await must(kubectl, ["delete", "namespace", FLOOR_TEST_NS, "--ignore-not-found", "--wait=true"]).catch(() => {});
  save("timings.json", timings);
  if (lima) execFileSync(lima[0], ["stop", lima[1]], { stdio: "ignore" });
});

const records: RunRecord[] = [];
const insides: string[] = [];

test("the egress floor alone, with no NetworkPolicy at all, holds a sandbox Pod from its first instruction", { skip }, async () => {
  const ns = { apiVersion: "v1", kind: "Namespace", metadata: { name: FLOOR_TEST_NS, labels: { "pod-security.kubernetes.io/enforce": "restricted" } } };
  await must(kubectl, ["apply", "-f", "-"], { stdin: JSON.stringify(ns) });
  const policies = await getJson<{ items: unknown[] }>(kubectl, ["get", "networkpolicy", "-n", FLOOR_TEST_NS]);
  assert.deepEqual(policies.items, [], "nothing but the floor stands between these Pods and the network");
  const { proxyNet: target, plainV4, plainV6 } = await floorTargets(kubectl, FLOOR_TEST_NS, IMAGES.proxy);
  const nodeIp = (await getJson<{ items: { status: { addresses: { type: string; address: string }[] } }[] }>(kubectl, ["get", "nodes"])).items[0]?.status.addresses.find((a) => a.type === "InternalIP")?.address ?? "";
  const dns = (await getJson<{ spec: { clusterIP: string } }>(kubectl, ["get", "service", "kube-dns", "-n", "kube-system"])).spec.clusterIP;
  const admitted = [`${target}:3128`, `${target}:8080`];
  const blocked = [`${target}:9090`, "1.1.1.1:443", `${dns}:53`, "10.43.0.1:443", `${nodeIp}:22`, `${nodeIp}:10250`, `${nodeIp}:6443`, "10.247.0.1:22", `${plainV4}:8080`, `${plainV6}:8080`, `${plainV4}:3128`];
  const sandboxes: ProbeResult[][] = [];
  for (let i = 0; i < 3; i++) sandboxes.push(await probePod(kubectl, { name: `floorprobe${i}`, namespace: FLOOR_TEST_NS, image: IMAGES.proxy, runtimeClass: FLOOR.runtimes.sandbox, targets: [...admitted, ...blocked], durationMs: 3000 }));
  const control = await probePod(kubectl, { name: "floorcontrol", namespace: FLOOR_TEST_NS, image: IMAGES.proxy, targets: blocked, durationMs: 3000 });
  save("floor-alone.json", { floor: FLOOR_ID, sandboxes, control });
  for (const probe of sandboxes) {
    for (const r of probe) {
      if (admitted.includes(r.target)) assert.ok(r.connected > 0, `${r.target}: the floor admits the proxy ports`);
      else assert.equal(r.connected, 0, `${r.target}: ${r.connected} of ${r.tries} got through, first at ${r.first_ms} ms`);
    }
  }
  for (const r of control) assert.ok(r.connected > 0, `control ${r.target}: ${r.last_error}`);
});

test("a fake-agent run: allowed host works, every bypass and attack fails and is logged, the record is complete", { skip }, async () => {
  const deps = { ...processRunDeps(kubectl, () => {}), inspect: async (exec: Parameters<NonNullable<ReturnType<typeof processRunDeps>["inspect"]>>[0]) => void insides.push(await sandboxContents(exec)) };
  const record = await timed("run_1_ms", () => runOnce(spec("run-1"), deps));
  records.push(record);
  assert.deepEqual(recordProblems(record), []);
  assert.equal(record.run.status, "completed", record.run.error ?? "");
  assert.equal(record.run.complete, true, record.run.error ?? "");
  assert.equal(record.agent.exit_status, 0, fs.readFileSync(path.join(evidence, "run-1", "agent.stdout"), "utf8"));
  assert.equal(record.source.base, head);
  assert.equal(record.image.matches && record.proxy.matches, true);
  assert.equal(record.sandbox.floor.node_label, FLOOR_ID);
  assert.equal(record.sandbox.floor.canary_reached, false);
  assert.match(record.sandbox.observed.dmesg ?? "", /gVisor/, "the sandbox's own kernel is gVisor's");
  assert.equal(record.sandbox.left_running, 0, "the background writer was stopped before the export");

  const report = fakeReport("run-1");
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.allowed.https, 200, "the allowed host answered over verified TLS");
  assert.equal(report.denied.connect, 403);
  assert.equal(report.anonymous.connect, 407, "CONNECT without the run token");
  for (const d of report.direct) assert.equal(d.blocked, true, `direct ${d.target}`);
  assert.equal(report.dns.blocked, true, "no DNS from the sandbox");
  assert.equal(report.model.model, "fake-model-20261101");
  assert.equal(report.ungranted_model.status, 403);
  assert.equal(report.other_host.status, 404, "a request target naming another host");
  assert.equal(report.hid_from_own_git, true, "the agent's own git was fooled");

  const patch = fs.readFileSync(path.join(evidence, "run-1", "patch.diff"), "utf8");
  assert.match(patch, /^\+\+\+ b\/FAKE_AGENT\.md$/m, "but the patch, made outside, still has the edit");
  assert.match(patch, /^\+\+\+ b\/FAKE_AGENT_LINK\.md\n@@ [^\n]*\n\+The fake agent ran/m, "a hard link's second name arrives with its own bytes");
  assert.equal(record.egress.audit?.sealed, true);
  assert.deepEqual(record.egress.audit?.problems, []);
  assert.equal(record.egress.denied_hosts[denied], 1);
  assert.deepEqual(record.egress.model_calls.map((c) => [c.op, c.model, c.result, c.status, c.destination]), [["anthropic.messages", "claude-opus-5-5", "ok", 200, model.upstream]]);
  assert.equal(record.cleanup.status, "verified-absent");
});

test("the backend credential never reaches the sandbox: not in its environment, inputs or files", { skip }, () => {
  assert.equal(insides.length, 1);
  assert.ok((insides[0] ?? "").includes("BLACKSAND_RUN_TOKEN="), "the look inside worked");
  assert.ok(!(insides[0] ?? "").includes(model.key));
});

test("the next run starts clean: new Sandbox, Pods and token, no files from the last run", { skip }, async () => {
  const record = await timed("run_2_ms", () => runOnce(spec("run-2"), processRunDeps(kubectl, () => {})));
  records.push(record);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  assert.deepEqual(fakeReport("run-2").prior_state, [], "no marker from run 1 in HOME, /workspace or /tmp");
  const [first, second] = records;
  assert.notEqual(second?.sandbox.uid, first?.sandbox.uid);
  assert.notEqual(second?.sandbox.pod_uid, first?.sandbox.pod_uid);
  assert.notEqual(second?.proxy.pod_uid, first?.proxy.pod_uid);
});

test("a NetworkPolicy blacksand didn't create in the runs namespace stops a run before it starts", { skip }, async () => {
  const widen = { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "allow-everything", namespace: NS.runs }, spec: { podSelector: {}, policyTypes: ["Egress"], egress: [{}] } };
  await must(kubectl, ["create", "-f", "-"], { stdin: JSON.stringify(widen) });
  try {
    const record = await runOnce(spec("refused"), processRunDeps(kubectl, () => {}));
    assert.equal(record.run.status, "failed");
    assert.match(record.run.error ?? "", /allow-everything/);
    assert.equal(record.cleanup.status, "not-run");
  } finally {
    await must(kubectl, ["delete", "networkpolicy", "allow-everything", "-n", NS.runs, "--wait=true"]);
  }
});

/** A probe Codex runs itself, through its own shell tool: one connection to each target; the results land in probe.json, so they come back in the trusted patch. */
const PROBE = 'const n=require("net");Promise.all(process.argv.slice(1).map(a=>new Promise(r=>{const i=a.lastIndexOf(":");const s=n.connect({host:a.slice(0,i).replace(/^\\[|\\]$/g,""),port:+a.slice(i+1),timeout:2000});s.on("connect",()=>{s.destroy();r([a,"connected"])});s.on("timeout",()=>{s.destroy();r([a,"timeout"])});s.on("error",e=>r([a,e.code]))}))).then(x=>require("fs").writeFileSync("probe.json",JSON.stringify(Object.fromEntries(x),null,1)+"\\n"))';

// Each at its adapter's default model; the fake model answers whatever it's asked.
for (const [agent, model_, route] of [
  ["claude", "claude-sonnet-5-5", "anthropic"],
  ["codex", "gpt-6.1-sol", "openai"],
] as const) {
  test(`the real ${agent} runs in the sandbox with full access, edits the repository through its tools, and never holds the credential`, { skip: skipReal }, async () => {
    const seen: string[] = [];
    const deps = { ...processRunDeps(kubectl, () => {}), inspect: async (exec: Parameters<NonNullable<ReturnType<typeof processRunDeps>["inspect"]>>[0]) => void seen.push(await sandboxContents(exec)) };
    const run = `real-${agent}`;
    // Codex: two apply_patch edits (a create and an update), then the probe, from inside its own run.
    const node = (await getJson<{ items: { status: { addresses: { type: string; address: string }[] } }[] }>(kubectl, ["get", "nodes"])).items[0]?.status.addresses.find((a) => a.type === "InternalIP")?.address;
    const targets = ["$BLACKSAND_PROXY:3128", "$BLACKSAND_PROXY:8080", "$BLACKSAND_PROXY:9090", "10.43.0.10:53", "10.43.0.1:443", `${node}:6443`, `${node}:10250`, "10.247.0.1:22", model.upstream.replace("http://", ""), `[${model.ipv6}]:8080`, "1.1.1.1:443"];
    const prompt = agent === "codex" ? `APPLY_PATCH\nRUN: node -e '${PROBE}' ${targets.join(" ")}` : "Write a file saying you were here.";
    const { fake: _, ...base } = spec(run, { agent, model: model_, models: [model_], routes: [parseRoute(`${route}=${model.upstream}@${FAKE_MODEL.secret}`)], allow: [], toolsImage, prompt });
    const record = await timed(`${run}_ms`, () => runOnce(base, deps));
    records.push(record);
    const stderr = fs.readFileSync(path.join(evidence, run, "agent.stderr"), "utf8");
    assert.equal(record.run.complete, true, record.run.error ?? "");
    assert.equal(record.agent.exit_status, 0, stderr.slice(-2000));
    assert.equal(record.image.tools, toolsImage);
    assert.deepEqual(record.agent.settings, AGENTS[agent].settings);
    assert.ok(record.egress.model_calls.every((c) => c.status === 200 && c.result === "ok" && c.model === model_));
    assert.ok(!(seen[0] ?? "").includes(model.key), "the backend credential never reached the sandbox");
    const patch = fs.readFileSync(path.join(evidence, run, "patch.diff"), "utf8");
    if (agent === "claude") {
      assert.match(patch, /^\+Claude Code wrote this in the sandbox\.$/m);
      assert.equal(record.egress.model_calls.length, 2, "the tool call, then the answer after its result");
      return;
    }
    assert.doesNotMatch(stderr, /bubblewrap|user namespaces/, "no inner sandbox");
    assert.match(stderr, /^sandbox: danger-full-access$/m);
    assert.match(patch, /^\+\+\+ b\/PATCHED\.md\n@@ -0,0 \+1 @@\n\+Codex created this with apply_patch\.$/m, "apply_patch created a file");
    assert.match(patch, /^\+\+\+ b\/README\.md\n@@ [^\n]+\n a repository for the journey\n\+Codex updated this with apply_patch\.$/m, "apply_patch updated one");
    assert.equal(record.egress.model_calls.length, 4, "two patches, the probe, then the answer");
    const probe = JSON.parse(/^\+\+\+ b\/probe\.json\n@@[^\n]+\n((?:\+.*\n)+)/m.exec(patch)?.[1]?.replace(/^\+/gm, "") ?? "{}") as Record<string, string>;
    save(`${run}-probe.json`, probe);
    const reached = Object.entries(probe).filter(([, result]) => result === "connected").map(([target]) => target.replace(/:\d+$/, ""));
    assert.equal(Object.keys(probe).length, targets.length, JSON.stringify(probe));
    assert.deepEqual(Object.entries(probe).filter(([, result]) => result === "connected").map(([target]) => target.slice(target.lastIndexOf(":") + 1)), ["3128", "8080"], JSON.stringify(probe));
    assert.equal(new Set(reached).size, 1, "both on the run's own proxy");
  });
}

test("a runner killed mid-run: its proxy stops serving at its own deadline, and the next setup deletes everything it left", { skip }, async () => {
  const out = "lost";
  const file = path.join(evidence, "lost-spec.json");
  fs.writeFileSync(file, JSON.stringify({ ...spec(out), timeoutSeconds: 10, slackSeconds: 20 }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/lost-runner.ts", import.meta.url)), file], { stdio: "ignore", env: process.env });
  const started = Date.now();
  let id = "";
  while (!id && Date.now() - started < 120_000) {
    const found = await getJson<{ items: { metadata: { labels: Record<string, string> } }[] }>(kubectl, ["get", "sandbox", "-n", NS.runs, "-l", LABEL.run]);
    id = found.items[0]?.metadata.labels[LABEL.run] ?? "";
    if (!id) await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGKILL");
  assert.match(id, /^[0-9a-f]{12}$/, "the lost runner created a Sandbox");
  const left = async () => {
    const all = [];
    for (const ns of [NS.runs, NS.egress]) all.push(...(await getJson<{ items: { kind: string; metadata: { name: string } }[] }>(kubectl, ["get", "sandbox,pod,configmap,networkpolicy", "-n", ns, "-l", `${LABEL.run}=${id}`])).items.map((i) => `${ns}/${i.kind}/${i.metadata.name}`));
    return all;
  };
  const orphaned = await left();
  assert.ok(orphaned.some((o) => o.includes("/Pod/p")), "the runner left its proxy behind");
  // Without any runner, the proxy's own expiry and the kubelet's deadline end the credential-serving process.
  let proxyState = "";
  for (let i = 0; i < 120 && !/terminated|Failed/.test(proxyState); i++) {
    const pod = await getJson<{ status: { phase: string; reason?: string; containerStatuses?: { state: Record<string, unknown> }[] } }>(kubectl, ["get", "pod", `p${id}`, "-n", NS.egress]).catch(() => null);
    proxyState = pod ? `${pod.status.phase} ${pod.status.reason ?? ""} ${Object.keys(pod.status.containerStatuses?.[0]?.state ?? {}).join(",")}` : "gone";
    if (!/terminated|Failed|gone/.test(proxyState)) await new Promise((r) => setTimeout(r, 1000));
  }
  timings.lost_proxy_stopped_ms = Date.now() - started;
  assert.match(proxyState, /terminated|Failed|gone/, `the proxy is still serving: ${proxyState}`);
  const expired = await reconcile(kubectl, Date.now());
  assert.ok(expired.deleted.includes(id));
  assert.deepEqual(await left(), [], "nothing of the lost run is left");
  save("lost-runner.json", { id, orphaned, proxy_state_before_reconcile: proxyState, reconciled: expired });
});

test("nothing from any run is left in the cluster", { skip }, async () => {
  for (const ns of [NS.runs, NS.egress]) {
    const leftovers = await getJson<{ items: unknown[] }>(kubectl, ["get", "sandbox,pod,configmap,networkpolicy,secret", "-n", ns, "-l", LABEL.run]);
    assert.deepEqual(leftovers.items, [], ns);
  }
  save("records.json", records);
});
