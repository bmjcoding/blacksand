// The rule and its condition, together: agents run with full access inside
// the sandbox (no inner sandbox, no approval prompts, no harness permission
// modes) because the sandbox is the boundary. So every registered adapter
// must render full access, and the Pod every adapter's run creates must stay
// locked down. A new adapter without a check here, or a change to either
// half, fails this file.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { AGENTS, type Agent, type AgentName } from "../src/agents.ts";
import { COMMAND_INPUTS, NS, SANDBOX_API, setupObjects } from "../src/manifests.ts";
import { FLOOR, FLOOR_ID } from "../src/node.ts";
import { parseRoute } from "../src/policy.ts";
import { hostBundle, runOnce, type RunSpec } from "../src/run.ts";
import { AGENT_IMAGE, PROXY_IMAGE, fakeCluster, fakeRepo } from "./fake-cluster.ts";

type Any = Record<string, any>;

const ctx = { proxyIp: "10.247.1.9" };
const rendered = (agent: Agent) => ({ script: agent.script, files: agent.files(ctx) });

/** How each adapter shows full access, no approvals, in what it renders. */
const FULL_ACCESS: Record<AgentName, (r: ReturnType<typeof rendered>, agent: Agent) => void> = {
  // No harness at all: the runner's own script, nothing that could prompt or sandbox.
  fake: (r, agent) => {
    assert.equal(r.script, "exec node /run/blacksand/inputs/fake-agent.ts\n");
    assert.deepEqual(r.files, {});
    assert.deepEqual(agent.settings, {});
  },
  claude: (r, agent) => {
    assert.equal(agent.settings.permission_mode, "bypassPermissions");
    assert.deepEqual(r.script.match(/--permission-mode \S+/g), ["--permission-mode bypassPermissions"], "one permission mode, bypassPermissions");
    assert.doesNotMatch(r.script, /--(?:allowed|disallowed)Tools|--permission-prompt-tool|--settings/, "no tool limits or permission prompts");
  },
  codex: (r, agent) => {
    assert.equal(agent.settings.sandbox_mode, "danger-full-access");
    assert.equal(agent.settings.approval_policy, "never");
    const config = r.files["codex-config.toml"] ?? "";
    assert.deepEqual(config.match(/^(?:sandbox_mode|approval_policy) = .*$/gm), ['approval_policy = "never"', 'sandbox_mode = "danger-full-access"']);
    assert.doesNotMatch(config, /\[sandbox_workspace_write\]|workspace-write|read-only|on-request|untrusted/, "no inner sandbox settings left");
    assert.doesNotMatch(r.script, /--sandbox|\s-s\s|--ask-for-approval|\s-a\s|--full-auto|--dangerously|-c\s/, "set in config.toml, never by flags");
  },
  // No harness: the runner's fixed script, which rebuilds the caller's argv from read-only files and execs it, as data.
  command: (r, agent) => {
    assert.deepEqual(r.files, {});
    assert.deepEqual(agent.settings, {});
    assert.equal(agent.route, null, "a model route only if the caller gives one");
    assert.doesNotMatch(r.script, /\beval\b|\$\(\s*\$|\bsh -c\b/, "nothing the caller gives is run as shell code");
    assert.deepEqual(r.script.match(/^exec .*$/gm), ['exec "$@"']);
  },
};

test("every registered adapter runs with full access and no approvals", () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    const check = FULL_ACCESS[name as AgentName];
    assert.ok(check, `adapter ${name} has no full-access check: add one to FULL_ACCESS`);
    check(rendered(agent), agent);
  }
});

/** The Pod each adapter's run actually creates, through the runner against a scripted cluster, and its record. */
async function runPod(name: AgentName) {
  const repo = fakeRepo();
  const cluster = fakeCluster(repo.head, repo.exportTar);
  const agent = AGENTS[name];
  const model = agent.route === "openai" ? "gpt-6.1-sol" : agent.route ? "claude-opus-5-5" : null;
  const spec: RunSpec = {
    repo: agent.route ? repo.repo : null,
    prompt: agent.route ? "p" : "",
    agent: name,
    model,
    models: model ? [model] : [],
    routes: agent.route ? [parseRoute(`${agent.route}=https://model.test@model-key`)] : [],
    allow: [],
    image: AGENT_IMAGE,
    toolsImage: name === "fake" ? null : `blacksand.local/agent-tools@sha256:${"b".repeat(64)}`,
    proxyImage: PROXY_IMAGE,
    timeoutSeconds: 60,
    key: null,
    out: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-access-")), "out"),
    ...(name === "fake" ? { fake: { allowed: "", denied: "example.org:443", direct: [] } } : {}),
    ...(name === "command" ? { command: { argv: ["python3", "-I", "inputs/attempt.py"], inputs: { "attempt.py": Buffer.from("print(1)\n") } } } : {}),
  };
  let hex = 0;
  const record = await runOnce(spec, { kubectl: cluster.kubectl, now: () => Date.parse("2026-11-01T00:00:00Z") + hex * 1000, randomHex: (bytes) => (hex++ ? "f".repeat(bytes * 2) : "abcdef012345"), bundle: hostBundle, progress: () => {}, sleep: async () => {} });
  const created = cluster.calls.filter((c) => c.args[0] === "create").flatMap((c) => (JSON.parse(c.stdin) as { items: Any[] }).items);
  const sandboxes = created.filter((o) => o.kind === "Sandbox");
  assert.equal(sandboxes.length, 1);
  return { record, sandbox: sandboxes[0] as Any, inRuns: created.filter((o) => o.metadata.namespace === NS.runs), proxyPod: created.find((o) => o.kind === "Pod" && o.metadata.namespace === NS.egress) as Any };
}

test("the condition: every adapter's sandbox Pod is locked down, so full access inside it stays inside it", async () => {
  const classes = (setupObjects() as Any[]).filter((o) => o.kind === "RuntimeClass");
  const sandboxClass = classes.find((c) => c.metadata.name === FLOOR.runtimes.sandbox);
  assert.deepEqual(sandboxClass?.scheduling.nodeSelector, { [FLOOR.label]: FLOOR_ID }, "the sandbox RuntimeClass schedules only onto nodes with this floor");
  for (const name of Object.keys(AGENTS) as AgentName[]) {
    const { record, sandbox, inRuns, proxyPod } = await runPod(name);
    const pod = sandbox.spec.podTemplate.spec as Any;
    const at = `adapter ${name}`;
    assert.equal(sandbox.apiVersion, SANDBOX_API);
    assert.equal(pod.runtimeClassName, FLOOR.runtimes.sandbox, at);
    // Non-root, no privilege escalation, every capability dropped: the Pod and each container, the tripwire included.
    assert.equal(pod.securityContext.runAsNonRoot, true, at);
    assert.notEqual(pod.securityContext.runAsUser, 0, at);
    for (const c of [...pod.initContainers, ...pod.containers]) {
      const sc = c.securityContext as Any;
      assert.equal(sc.runAsNonRoot, true, `${at}: ${c.name}`);
      assert.ok(Number.isInteger(sc.runAsUser) && sc.runAsUser > 0, `${at}: ${c.name}`);
      assert.equal(sc.allowPrivilegeEscalation, false, `${at}: ${c.name}`);
      assert.notEqual(sc.privileged, true, `${at}: ${c.name}`);
      assert.deepEqual(sc.capabilities, { drop: ["ALL"] }, `${at}: ${c.name} adds no capability`);
    }
    // No service-account token, no host paths or host namespaces.
    assert.equal(pod.automountServiceAccountToken, false, at);
    for (const field of ["hostNetwork", "hostPID", "hostIPC"]) assert.notEqual(pod[field], true, `${at}: ${field}`);
    for (const v of pod.volumes as Any[]) {
      const kinds = Object.keys(v).filter((k) => k !== "name");
      assert.ok(kinds.length === 1 && ["emptyDir", "configMap", "image"].includes(kinds[0] ?? ""), `${at}: volume ${v.name} is ${kinds.join(",")}`);
    }
    // No provider key: no Secret by volume or environment in anything sent to the runs namespace; the key lives only in the proxy's Pod.
    for (const c of [...pod.initContainers, ...pod.containers]) {
      assert.equal(c.envFrom, undefined, `${at}: ${c.name}`);
      for (const e of (c.env ?? []) as Any[]) assert.equal(e.valueFrom, undefined, `${at}: ${c.name} ${e.name}`);
    }
    assert.doesNotMatch(JSON.stringify(inRuns), /model-key|secretKeyRef|"secret"|projected|hostPath/, at);
    // Every mount but the workspace, scratch and HOME is read-only: the inputs, a command's input files, the tools image.
    for (const m of pod.containers[0].volumeMounts as Any[]) assert.ok(["/workspace", "/tmp", "/home/agent"].includes(m.mountPath) || m.readOnly === true, `${at}: ${m.mountPath} is read-only`);
    // A run with no model route gets no credential, even in its proxy, and no grant.
    if (!record.agent.route) {
      assert.deepEqual(proxyPod.spec.volumes.map((v: Any) => v.name), ["proxy"], at);
      assert.deepEqual(record.policy.models, [], at);
      assert.ok(pod.containers[0].volumeMounts.some((m: Any) => m.mountPath === COMMAND_INPUTS && m.readOnly), at);
    }
    // And the record says how the harness ran.
    assert.deepEqual(record.agent.settings, AGENTS[name].settings, at);
    assert.equal(record.run.complete, true, `${at}: ${record.run.error}`);
  }
});
