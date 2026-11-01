import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { DEADLINE, LABEL, NS, proxyObjects, runNames, sandboxObjects } from "../src/manifests.ts";
import { FLOOR } from "../src/node.ts";
import { parseAllow, parseRoute } from "../src/policy.ts";
import { provisionReceipts, receiptDir } from "../src/receipt.ts";
import { recordProblems } from "../src/record.ts";
import { hostBundle, reconcile, runOnce, type RunDeps, type RunSpec } from "../src/run.ts";
import { AGENT_IMAGE, PROXY_IMAGE, fakeCluster, fakeRepo, labelled, sealedAudit, type Call } from "./fake-cluster.ts";

const SECRET_VALUE = "sk-backend-credential-never-in-the-sandbox";

/** One real repository for the file; each run gets its own output directory. */
const repo = fakeRepo();

function setup(overrides: Parameters<typeof fakeCluster>[2] = {}, extra: Partial<RunDeps> = {}, existing: Record<string, any>[] = []) {
  const cluster = fakeCluster(repo.head, repo.exportTar, overrides, existing);
  let time = Date.parse("2026-11-01T00:00:00Z");
  let hex = 0;
  const deps: RunDeps = {
    kubectl: cluster.kubectl,
    now: () => (time += 1000),
    randomHex: (bytes) => (hex++ ? "f".repeat(bytes * 2) : "abcdef012345"),
    bundle: hostBundle,
    progress: () => {},
    sleep: async () => {},
    ...extra,
  };
  const spec: RunSpec = {
    repo: repo.repo,
    prompt: "add a file",
    agent: "fake",
    model: "claude-opus-5-5",
    models: ["claude-opus-5-5"],
    routes: [parseRoute("anthropic=https://model.test@model-key")],
    allow: [parseAllow("example.com:443")],
    image: AGENT_IMAGE,
    toolsImage: null,
    proxyImage: PROXY_IMAGE,
    timeoutSeconds: 60,
    key: "case-7/repeat-2",
    out: receiptDir(provisionReceipts(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-run-"))), "case-7/repeat-2"),
    fake: { allowed: "example.com:443", denied: "example.org:443", direct: ["1.1.1.1:443"] },
  };
  return { cluster, deps, spec };
}

const index = (calls: Call[], match: (c: Call) => boolean) => calls.findIndex(match);
const deletes = (calls: Call[]) => calls.filter((c) => c.args[0] === "delete");
/** What each delete named, and the UID it required. */
const deleted = (calls: Call[]) => deletes(calls).map((c) => [c.args[c.args.indexOf("--raw") + 1], (JSON.parse(c.stdin) as { preconditions: { uid: string } }).preconditions.uid]);
const NOW = Date.parse("2026-11-01T00:00:00Z") / 1000;

/** Every object a live run has, as the runner creates them (the controller adds the Pod). */
function runObjects(id: string, deadline: number | null) {
  const names = runNames(id);
  const route = parseRoute("anthropic=https://model.test@model-key");
  const made = [
    ...proxyObjects({ names, image: PROXY_IMAGE, files: { "proxy.ts": "", "config.json": "{}" }, route, deadlineSeconds: 600, deadline: deadline ?? 0 }),
    ...sandboxObjects({ names, image: AGENT_IMAGE, toolsImage: null, tripwire: { image: PROXY_IMAGE, canary: { host: "10.43.0.10", port: 53 } }, inputs: {}, env: {}, deadlineSeconds: 600, shutdownTime: "2026-11-01T00:10:00.000Z", deadline: deadline ?? 0 }),
  ] as Record<string, any>[];
  if (deadline === null) for (const o of made) (delete o.metadata.annotations[DEADLINE], o.spec?.podTemplate && delete o.spec.podTemplate.metadata.annotations[DEADLINE]);
  return made;
}
const of = (cluster: { objects: Record<string, any>[] }, id: string) => cluster.objects.filter((o) => o.metadata.labels?.[LABEL.run] === id).map((o) => `${o.metadata.namespace}/${o.kind}/${o.metadata.name}`).sort();
const created = (calls: Call[]) => calls.some((c) => c.args[0] === "create");

test("a run records what the cluster ran, makes its patch outside the sandbox, and tears everything down", async () => {
  const { cluster, deps, spec } = setup();
  const record = await runOnce(spec, deps);
  assert.deepEqual(recordProblems(record), []);
  assert.equal(record.run.status, "completed", record.run.error ?? "");
  assert.equal(record.run.complete, true);
  assert.equal(record.run.key, "case-7/repeat-2");
  assert.equal(record.sandbox.name, "sabcdef012345");
  assert.equal(record.sandbox.runtime_class, FLOOR.runtimes.sandbox);
  assert.equal(record.sandbox.floor.canary_reached, false);
  assert.equal(record.sandbox.left_running, 0);
  assert.equal(record.image.matches, true);
  assert.equal(record.proxy.matches, true);
  assert.equal(record.source.base, repo.head);
  assert.deepEqual(record.policy.models, ["claude-opus-5-5"]);
  assert.deepEqual(record.egress.audit, { entries: 7, sealed: true, problems: [] });
  assert.deepEqual(record.egress.denied_hosts, { "example.org:443": 1 });
  assert.deepEqual(record.egress.model_calls, [{ op: "anthropic.messages", model: "claude-opus-5-5", destination: "https://model.test", result: "ok", status: 200, returned_model: "claude-opus-5-5-20261001" }]);
  assert.match(fs.readFileSync(path.join(spec.out, "patch.diff"), "utf8"), /^\+the fake agent ran$/m);
  assert.equal(record.result.patch_files, 1);
  assert.deepEqual(record.cleanup, { status: "verified-absent", remaining: [], foreign: [] });
  for (const file of ["record.json", "patch.diff", "agent.stdout", "agent.stderr", "egress.jsonl", "policies.json", "prepare.txt", "workspace.tar"]) assert.ok(fs.existsSync(path.join(spec.out, file)), file);
  assert.equal(fs.statSync(path.join(spec.out, "record.json")).mode & 0o777, 0o600);
  assert.equal(record.policy.effective_sha256, record.artifacts.find((a) => a.file === "policies.json")?.sha256, "the policy digest is the file's");
  // Exactly its seven objects, the controller's Pod among them, each deleted by the UID it was found with.
  assert.deepEqual(deleted(cluster.calls).map(([p]) => p).sort(), [
    "/api/v1/namespaces/blacksand-egress/configmaps/pabcdef012345",
    "/api/v1/namespaces/blacksand-egress/pods/pabcdef012345",
    "/api/v1/namespaces/blacksand-runs/configmaps/sabcdef012345",
    "/api/v1/namespaces/blacksand-runs/pods/sabcdef012345",
    "/apis/agents.x-k8s.io/v1beta1/namespaces/blacksand-runs/sandboxes/sabcdef012345",
    "/apis/networking.k8s.io/v1/namespaces/blacksand-egress/networkpolicies/pabcdef012345",
    "/apis/networking.k8s.io/v1/namespaces/blacksand-runs/networkpolicies/sabcdef012345",
  ]);
  assert.ok(deleted(cluster.calls).every(([, uid]) => /^uid-\d+$/.test(uid ?? "")));
  assert.deepEqual(of(cluster, "abcdef012345"), []);
});

test("the agent is frozen before its workspace is exported, and the proxy sealed before its audit is read", async () => {
  const { cluster, deps, spec } = setup();
  await runOnce(spec, deps);
  const at = (step: string) => index(cluster.calls, (c) => c.args[0] === "exec" && c.args.includes(step));
  assert.ok(at("agent") < at("freeze") && at("freeze") < at("export"), "agent, freeze, export");
  const seal = index(cluster.calls, (c) => c.args.includes("kill") && c.args.includes(NS.egress));
  const read = index(cluster.calls, (c) => c.args[0] === "logs" && c.args.includes("proxy"));
  assert.ok(at("export") < seal && seal < read, "export, seal, then the audit");
});

test("the run token is in the sandbox's spec but the backend credential is never in anything sent to the sandbox", async () => {
  const { cluster, deps, spec } = setup();
  await runOnce(spec, deps);
  const sandboxCreate = cluster.calls.find((c) => c.args[0] === "create" && c.stdin.includes('"kind":"Sandbox"'));
  assert.ok(sandboxCreate);
  assert.ok(sandboxCreate.stdin.includes("f".repeat(64)), "the run token");
  assert.ok(!sandboxCreate.stdin.includes(SECRET_VALUE));
  assert.ok(!sandboxCreate.stdin.includes("model-key"), "not even the Secret's name");
  const proxyCreate = cluster.calls.find((c) => c.args[0] === "create" && c.stdin.includes("proxy.ts"));
  assert.ok(proxyCreate && !proxyCreate.stdin.includes("f".repeat(64)), "the proxy holds only the token's digest");
  assert.ok(!fs.readFileSync(path.join(spec.out, "record.json"), "utf8").includes("f".repeat(64)), "the record holds env names, not the token");
});

test("without the egress floor nothing is created: a RuntimeClass that doesn't require it, or no node that has it", async () => {
  for (const override of [{ "get runtimeclass": { stdout: Buffer.from(JSON.stringify({ handler: FLOOR.runtimes.sandbox })) } }, { "get nodes": { stdout: Buffer.from('{"items":[]}') } }]) {
    const { cluster, deps, spec } = setup(override);
    const record = await runOnce(spec, deps);
    assert.equal(record.run.status, "failed");
    assert.match(record.run.error ?? "", /egress floor/);
    assert.equal(created(cluster.calls), false);
  }
});

test("a sandbox that reaches the canary directly is stopped before the agent runs: the floor isn't in effect", async () => {
  const { cluster, deps, spec } = setup({ "logs tripwire": { stdout: Buffer.from('{"canary":"10.43.0.10:53","reached":true}\n') } });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "failed");
  assert.match(record.run.error ?? "", /floor isn't in effect/);
  assert.ok(!cluster.calls.some((c) => c.args[c.args.indexOf(STEP_PATH) + 1] === "agent"), "the agent never ran");
  assert.equal(record.cleanup.status, "verified-absent");
});

const STEP_PATH = "/run/blacksand/inputs/steps.sh";

test("a NetworkPolicy blacksand didn't create stops the run before anything is created", async () => {
  const { cluster, deps, spec } = setup({
    "get networkpolicy": { stdout: Buffer.from(JSON.stringify({ items: [{ metadata: { name: "default-deny" } }, { metadata: { name: "allow-all-egress" } }] })) },
  });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "failed");
  assert.match(record.run.error ?? "", /allow-all-egress/);
  assert.equal(created(cluster.calls), false);
  assert.equal(record.cleanup.status, "not-run");
});

test("a proxy that isn't running its pinned image stops the run before the sandbox exists", async () => {
  const other = "docker.io/library/node@sha256:" + "1".repeat(64);
  const { cluster, deps, spec } = setup({
    "get pod": { stdout: Buffer.from(JSON.stringify({ metadata: { uid: "u" }, spec: {}, status: { podIPs: [{ ip: "10.247.1.9" }], containerStatuses: [{ imageID: other }] } })) },
  });
  const record = await runOnce(spec, deps);
  assert.match(record.run.error ?? "", /proxy Pod isn't running its pinned image/);
  assert.ok(!cluster.calls.some((c) => c.stdin.includes('"kind":"Sandbox"')));
});

test("an audit that isn't whole and sealed makes the run incomplete", async () => {
  for (const log of ["", (run: string) => sealedAudit(run).split("\n").slice(0, -2).join("\n"), (run: string) => sealedAudit(run).replace('"seq":3', '"seq":9')]) {
    const { deps, spec } = setup({ "logs proxy": (call) => ({ stdout: Buffer.from(typeof log === "string" ? log : log(String(call.args[1]).slice(1))) }) });
    const record = await runOnce(spec, deps);
    assert.equal(record.run.complete, false);
    assert.match(record.run.error ?? "", /sealed audit/);
    assert.ok(record.egress.audit === null || record.egress.audit.problems.length > 0);
  }
});

test("a process still running after the freeze fails the run before the export", async () => {
  const { cluster, deps, spec } = setup({ "exec freeze": { stdout: Buffer.from("running=42\n") } });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "failed");
  assert.match(record.run.error ?? "", /still running after the freeze/);
  assert.ok(!cluster.calls.some((c) => c.args.includes("export")));
});

test("a failed step still seals the proxy, reads its audit and tears down, and the record says it's incomplete", async () => {
  const { cluster, deps, spec } = setup({ "exec prepare": { status: 128, stderr: "fatal: not a git repository" } });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "failed");
  assert.equal(record.run.complete, false);
  assert.match(record.run.error ?? "", /prepare failed.*not a git repository/);
  assert.ok(cluster.calls.some((c) => c.args.includes("freeze")), "the sandbox is frozen anyway");
  assert.equal(deletes(cluster.calls).length, 7);
  assert.equal(record.cleanup.status, "verified-absent");
  assert.ok(fs.existsSync(path.join(spec.out, "egress.jsonl")));
  assert.deepEqual(recordProblems(record), []);
});

test("a clone that isn't the repository's HEAD fails the run", async () => {
  const { deps, spec } = setup({ "exec prepare": { stdout: Buffer.from(`base=${"9".repeat(40)}\n`) } });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "failed");
  assert.match(record.run.error ?? "", /not the repository's HEAD/);
});

test("cancelling a run still tears it down, and the record says cancelled", async () => {
  const abort = new AbortController();
  const { cluster, deps, spec } = setup({
    "exec agent": () => {
      abort.abort(new Error("cancelled"));
      throw new Error("killed");
    },
  });
  const record = await runOnce(spec, { ...deps, signal: abort.signal });
  assert.equal(record.run.status, "cancelled");
  assert.equal(record.run.complete, false);
  assert.equal(deletes(cluster.calls).length, 7);
  assert.equal(record.cleanup.status, "verified-absent");
});

test("an object left after teardown is reported, and the run doesn't pass for it", async () => {
  // The API refuses this one delete (its UID no longer matches): it's still there afterwards, so cleanup isn't verified.
  const { cluster, deps, spec } = setup();
  const kubectl = cluster.kubectl;
  const record = await runOnce(spec, { ...deps, kubectl: (args, o) => (args.includes("/api/v1/namespaces/blacksand-runs/configmaps/sabcdef012345") ? Promise.resolve({ status: 1, stdout: Buffer.alloc(0), stderr: "Error from server (Conflict)" }) : kubectl(args, o)) });
  assert.equal(record.cleanup.status, "incomplete");
  assert.deepEqual(record.cleanup.remaining, [`${NS.runs}/ConfigMap/sabcdef012345`]);
});

test("an agent that runs past its timeout is recorded as timed out, with its patch", async () => {
  const { deps, spec } = setup({ "exec agent": { status: null, killed: "timeout" } });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "timed_out");
  assert.equal(record.run.complete, false);
  assert.ok(record.result.patch);
});

test("an agent that floods its output is stopped and the run fails, rather than passing as a timeout", async () => {
  const { deps, spec } = setup({ "exec agent": { status: null, killed: "output-limit" } });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.status, "failed");
  assert.match(record.run.error ?? "", /64 MiB/);
});

test("a resolved agent image that isn't the pinned one makes the run incomplete", async () => {
  const other = "docker.io/library/node@sha256:" + "1".repeat(64);
  const { deps, spec } = setup({
    "get sandbox": { stdout: Buffer.from('{"metadata":{"uid":"sandbox-uid"}}') },
    "get pod": (call) => {
      const proxy = (call.args[2] ?? "").startsWith("p");
      return { stdout: Buffer.from(JSON.stringify({ metadata: { uid: "u", ownerReferences: [{ kind: "Sandbox", uid: "sandbox-uid" }] }, spec: { nodeName: "node-a" }, status: { podIPs: [{ ip: "10.247.1.9" }], containerStatuses: [{ imageID: proxy ? PROXY_IMAGE : other, state: { terminated: {} } }] } })) };
    },
  });
  const record = await runOnce(spec, deps);
  assert.equal(record.run.complete, false);
  assert.match(record.run.error ?? "", /agent image/);
});

test("two runs live at once: starting one leaves the other alone, its controller-made Pod included", async () => {
  const { cluster, deps, spec } = setup({}, {}, runObjects("aaaaaaaaaaaa", NOW + 600));
  const live = of(cluster, "aaaaaaaaaaaa");
  assert.ok(live.includes("blacksand-runs/Pod/saaaaaaaaaaaa"), "the controller's Pod is in the list reconcile sees");
  assert.equal(cluster.objects.find((o) => o.kind === "Pod" && o.metadata.name === "saaaaaaaaaaaa")?.metadata.annotations[DEADLINE], String(NOW + 600), "and it carries the deadline");
  const record = await runOnce(spec, deps);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  assert.deepEqual(of(cluster, "aaaaaaaaaaaa"), live, "every object of the other run is still there");
  assert.ok(!deletes(cluster.calls).some((c) => c.args.some((a) => a.includes("aaaaaaaaaaaa"))));
});

test("a live run whose Pod lacks the deadline (a controller that didn't copy it) still isn't deleted", async () => {
  const objects = runObjects("aaaaaaaaaaaa", NOW + 600);
  const { cluster } = setup({}, {}, objects);
  for (const o of cluster.objects) if (o.kind === "Pod" && o.metadata.name === "saaaaaaaaaaaa") delete o.metadata.annotations[DEADLINE];
  assert.deepEqual(await reconcile(cluster.kubectl, NOW * 1000), { deleted: [], undated: [], foreign: [] });
  assert.equal(of(cluster, "aaaaaaaaaaaa").length, 7);
});

test("an expired run is deleted object by object, each by its UID, in both namespaces, while a live one stays", async () => {
  const { cluster } = setup({}, {}, [...runObjects("aaaaaaaaaaaa", NOW - 1), ...runObjects("bbbbbbbbbbbb", NOW + 600)]);
  const uids = new Map(cluster.objects.map((o) => [`${o.metadata.namespace}/${o.kind}/${o.metadata.name}`, o.metadata.uid]));
  assert.deepEqual(await reconcile(cluster.kubectl, NOW * 1000), { deleted: ["aaaaaaaaaaaa"], undated: [], foreign: [] });
  assert.deepEqual(of(cluster, "aaaaaaaaaaaa"), []);
  assert.equal(of(cluster, "bbbbbbbbbbbb").length, 7);
  assert.equal(deleted(cluster.calls).length, 7);
  for (const [p, uid] of deleted(cluster.calls)) assert.ok([...uids.values()].includes(uid ?? ""), `${p} named the UID it was found with`);
});

test("a foreign labelled object survives reconcile and teardown, and is reported", async () => {
  const foreign = [
    labelled("ConfigMap", NS.runs, "foreign-owner-config", { [LABEL.run]: "feedfeedfeed" }, null),
    labelled("ConfigMap", NS.runs, "sabcdef012345-extra", { [LABEL.run]: "abcdef012345", [LABEL.role]: "sandbox" }, NOW - 1),
    labelled("Pod", NS.egress, "pabcdef012345", { [LABEL.run]: "abcdef012345", [LABEL.role]: "sandbox" }, NOW - 1),
  ];
  const { cluster, deps, spec } = setup({}, {}, foreign);
  assert.deepEqual((await reconcile(cluster.kubectl, NOW * 1000)).foreign, ["blacksand-egress/Pod/pabcdef012345", "blacksand-runs/ConfigMap/foreign-owner-config", "blacksand-runs/ConfigMap/sabcdef012345-extra"]);
  assert.equal(deletes(cluster.calls).length, 0, "nothing is deleted for them");
  const record = await runOnce(spec, deps);
  assert.ok(record.cleanup.foreign.includes("blacksand-runs/ConfigMap/sabcdef012345-extra"));
  for (const name of ["foreign-owner-config", "sabcdef012345-extra"]) assert.ok(cluster.objects.some((o) => o.metadata.name === name), name);
});

test("a run whose objects record no deadline is reported, never deleted", async () => {
  const { cluster } = setup({}, {}, runObjects("aaaaaaaaaaaa", null));
  assert.deepEqual(await reconcile(cluster.kubectl, NOW * 1000), { deleted: [], undated: ["aaaaaaaaaaaa"], foreign: [] });
  assert.equal(of(cluster, "aaaaaaaaaaaa").length, 7);
});

test("a Pod with the sandbox's name but another Sandbox as its owner isn't the run's", async () => {
  const objects = runObjects("aaaaaaaaaaaa", NOW - 1);
  const { cluster } = setup({}, {}, objects);
  const pod = cluster.objects.find((o) => o.kind === "Pod" && o.metadata.name === "saaaaaaaaaaaa");
  pod!.metadata.ownerReferences[0].uid = "some-other-sandbox";
  const result = await reconcile(cluster.kubectl, NOW * 1000);
  assert.deepEqual(result.foreign, ["blacksand-runs/Pod/saaaaaaaaaaaa"]);
  assert.deepEqual(of(cluster, "aaaaaaaaaaaa"), ["blacksand-runs/Pod/saaaaaaaaaaaa"], "the rest of the expired run went; that Pod stayed");
});

test("every run starts by deleting expired runs, before it creates anything", async () => {
  const { cluster, deps, spec } = setup({}, {}, runObjects("aaaaaaaaaaaa", NOW - 600));
  await runOnce(spec, deps);
  const firstDelete = index(cluster.calls, (c) => c.args[0] === "delete");
  assert.ok(firstDelete >= 0 && firstDelete < index(cluster.calls, (c) => c.args[0] === "create"));
  assert.deepEqual(of(cluster, "aaaaaaaaaaaa"), []);
});

test("specs that can't run safely are refused before the cluster is touched", async () => {
  const cases: [Partial<RunSpec>, RegExp][] = [
    [{ image: "docker.io/library/node:24" }, /pinned by digest/],
    [{ routes: [] }, /needs a anthropic route/],
    [{ repo: "https://user:token@github.com/example/repo.git" }, /credentials/],
    [{ model: "m; rm -rf /" }, /isn't a model id/],
    [{ models: ["claude-sonnet-5-5"] }, /must be among the granted models/],
    [{ timeoutSeconds: 0 }, /timeout/],
    [{ maxModelRequests: 0 }, /request budget/],
    [{ maxModelRequests: 1.5 }, /request budget/],
    [{ maxModelRequests: 100_001 }, /request budget/],
  ];
  for (const [change, error] of cases) {
    const { cluster, deps, spec } = setup();
    await assert.rejects(runOnce({ ...spec, ...change }, deps), error);
    assert.equal(cluster.calls.length, 0);
  }
});

test("the model request budget reaches the proxy's config and the record; 2000 when not given", async () => {
  const configOf = (calls: Call[]) => {
    const proxyMap = calls.filter((c) => c.args[0] === "create").flatMap((c) => (JSON.parse(c.stdin) as { items: Record<string, any>[] }).items).find((o) => o.kind === "ConfigMap" && o.metadata.namespace === NS.egress);
    return JSON.parse(proxyMap?.data["config.json"] ?? "{}") as { limits: { requests_total: number } };
  };
  for (const [budget, expected] of [[undefined, 2000], [20, 20]] as const) {
    const { cluster, deps, spec } = setup();
    const record = await runOnce({ ...spec, ...(budget === undefined ? {} : { maxModelRequests: budget }) }, deps);
    assert.equal(record.run.complete, true, record.run.error ?? "");
    assert.equal(configOf(cluster.calls).limits.requests_total, expected);
    assert.equal(record.policy.limits.requests_total, expected);
  }
});
