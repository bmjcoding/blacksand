// The command adapter: a fixed argv, given as data, run in the sandbox with
// frozen input files mounted read-only and no agent or prompt; the files it
// wrote collected outside, from the export, with their digests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { AGENTS } from "../src/agents.ts";
import { COMMAND_INPUTS, NS } from "../src/manifests.ts";
import { parseRoute, sha256 } from "../src/policy.ts";
import { recordProblems } from "../src/record.ts";
import { hostBundle, requestDigest, runOnce, type RunDeps, type RunSpec } from "../src/run.ts";
import { AGENT_IMAGE, ATTEMPT, CASE, commandSpec, fakeCluster, workspaceTar, type Call } from "./fake-cluster.ts";

type Any = Record<string, any>;

const outDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-command-")), "out");
const WORKSPACE = workspaceTar({ "out/decision.json": '{"refund":true}\n', "outbox/refunds.jsonl": "{}\n", "inputs/refunds/attempt.py": "the read-only inputs, not output\n", ".git/config": "[core]\n" }, (ws) => {
  fs.symlinkSync("/etc/passwd", path.join(ws, "out", "link"));
});

function setup(exportTar = WORKSPACE, overrides: Parameters<typeof fakeCluster>[2] = {}) {
  const cluster = fakeCluster("", exportTar, overrides);
  let time = Date.parse("2026-11-01T00:00:00Z");
  let hex = 0;
  const deps: RunDeps = { kubectl: cluster.kubectl, now: () => (time += 1000), randomHex: (bytes) => (hex++ ? "f".repeat(bytes * 2) : "abcdef012345"), bundle: hostBundle, progress: () => {}, sleep: async () => {} };
  return { cluster, deps };
}

const created = (calls: Call[]): Any[] => calls.filter((c) => c.args[0] === "create").flatMap((c) => (JSON.parse(c.stdin) as { items: Any[] }).items);
const steps = (calls: Call[]) => calls.filter((c) => c.args[0] === "exec" && c.args.includes("/run/blacksand/inputs/steps.sh")).map((c) => c.args.at(-1));

test("the command's argv reaches it exactly, every argument as data: no shell parses any of it", () => {
  // The adapter's own script, run here by sh against the argv files the runner writes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-argv-"));
  const nasty = ["$(touch pwned)", "`touch pwned`", "; touch pwned", "a b", "*", "'", '"', "", "-n", " lead and trail ", "two\nlines\n\n", "\\", "$HOME", "ünïcode", "x".repeat(10_000)];
  const argv = [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...nasty];
  fs.writeFileSync(path.join(dir, "argc"), String(argv.length));
  argv.forEach((arg, i) => fs.writeFileSync(path.join(dir, `argv.${i}`), arg));
  const script = AGENTS.command.script.replaceAll("/run/blacksand/inputs", dir);
  // sh here, and dash (Debian's sh, as in the default image) where there is one.
  for (const shell of ["sh", ...(fs.existsSync("/bin/dash") ? ["/bin/dash"] : [])]) {
    const got = execFileSync(shell, ["-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }).toString();
    assert.deepEqual(JSON.parse(got), nasty, shell);
  }
  assert.ok(!fs.existsSync(path.join(dir, "pwned")), "nothing in an argument ran");
});

test("a command run: argv and input files read-only in the sandbox, no repository, prompt or agent, its files collected outside", async () => {
  const { cluster, deps } = setup();
  const spec = commandSpec(outDir());
  const record = await runOnce(spec, deps);
  assert.deepEqual(recordProblems(record), []);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  // What ran: no bundle or clone, the command in /workspace, the workspace exported.
  assert.deepEqual(steps(cluster.calls), ["observe", "run", "freeze", "export-workspace"]);
  assert.ok(!cluster.calls.some((c) => c.args.includes("receive") || c.args.includes("prepare")));
  const objects = created(cluster.calls);
  const map = objects.find((o) => o.kind === "ConfigMap" && o.metadata.namespace === NS.runs) as Any;
  assert.deepEqual(Object.keys(map.data).sort(), ["agent.sh", "argc", "argv.0", "argv.1", "argv.2", "steps.sh"], "no prompt");
  assert.deepEqual([map.data.argc, map.data["argv.0"], map.data["argv.2"]], ["3", "python3", "inputs/refunds/attempt.py"]);
  assert.deepEqual(Buffer.from(map.binaryData["file.0"], "base64"), CASE, "input bytes exactly, binary included");
  const pod = (objects.find((o) => o.kind === "Sandbox") as Any).spec.podTemplate.spec;
  assert.deepEqual(pod.containers[0].volumeMounts.find((m: Any) => m.name === "files"), { name: "files", mountPath: COMMAND_INPUTS, readOnly: true });
  assert.deepEqual(pod.volumes.find((v: Any) => v.name === "files").configMap.items, [{ key: "file.0", path: "case.bin" }, { key: "file.1", path: "refunds/attempt.py" }]);
  assert.ok(!pod.volumes.find((v: Any) => v.name === "inputs").configMap.items.some((i: Any) => i.key.startsWith("file.")), "input files appear only under the workspace");
  // No model route: no model in its environment, no grant at its proxy.
  const env = Object.fromEntries(pod.containers[0].env.map((e: Any) => [e.name, e.value]));
  assert.equal(env.BLACKSAND_MODEL_URL, undefined);
  const proxyMap = objects.find((o) => o.kind === "ConfigMap" && o.metadata.namespace === NS.egress) as Any;
  assert.deepEqual(JSON.parse(proxyMap.data["config.json"]).model.routes, []);
  // The record says what ran.
  assert.deepEqual(record.command, { argv_sha256: sha256(JSON.stringify(spec.command?.argv)), argc: 3, inputs: { "case.bin": sha256(CASE), "refunds/attempt.py": sha256(ATTEMPT) } });
  assert.deepEqual([record.agent.name, record.agent.route, record.policy.route, record.source.kind], ["command", null, null, "none"]);
  assert.equal(record.run.request_sha256, requestDigest(spec));
  assert.equal(record.image.requested, AGENT_IMAGE);
  assert.ok(record.image.matches && record.sandbox.uid && record.sandbox.runtime_class);
  // Its files: regular files only, copied out with their digests; its inputs, links and any .git are not output.
  assert.deepEqual(record.result.files, [
    { path: "out/decision.json", sha256: sha256('{"refund":true}\n'), bytes: 16 },
    { path: "outbox/refunds.jsonl", sha256: sha256("{}\n"), bytes: 3 },
  ]);
  assert.equal(record.result.skipped_entries, 2, "the symlink and .git/config");
  assert.equal(record.result.patch, null);
  assert.equal(fs.readFileSync(path.join(spec.out, "files", "out", "decision.json"), "utf8"), '{"refund":true}\n');
  assert.ok(!fs.existsSync(path.join(spec.out, "files", "inputs")) && !fs.existsSync(path.join(spec.out, "files", "out", "link")));
});

test("a command given a route gets that route and its model, and only those", async () => {
  const { cluster, deps } = setup();
  const record = await runOnce(commandSpec(outDir(), { routes: [parseRoute("openai=https://model.test@model-key")], model: "gpt-6.1-sol", models: ["gpt-6.1-sol"] }), deps);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  const objects = created(cluster.calls);
  const proxyMap = objects.find((o) => o.kind === "ConfigMap" && o.metadata.namespace === NS.egress) as Any;
  assert.deepEqual(JSON.parse(proxyMap.data["config.json"]).model.routes.map((r: Any) => [r.name, r.models]), [["openai", ["gpt-6.1-sol"]]]);
  const env = Object.fromEntries((objects.find((o) => o.kind === "Sandbox") as Any).spec.podTemplate.spec.containers[0].env.map((e: Any) => [e.name, e.value]));
  assert.deepEqual([env.BLACKSAND_MODEL_URL, env.BLACKSAND_MODEL], ["http://10.247.1.9:8080/openai", "gpt-6.1-sol"]);
  assert.equal(record.agent.route, "openai");
});

/** A copy of `tar` with one entry renamed (to a name of the same length), its header checksum fixed: names this disk couldn't hold side by side. */
function renamed(tar: string, from: string, to: string): string {
  const raw = fs.readFileSync(tar);
  const at = raw.indexOf(Buffer.from(`${from}\0`, "latin1"));
  assert.ok(at >= 0 && at % 512 === 0 && from.length === to.length);
  raw.write(to, at, "latin1");
  raw.fill(0x20, at + 148, at + 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += raw[at + i] ?? 0;
  raw.write(`${sum.toString(8).padStart(6, "0")}\0 `, at + 148, "latin1");
  const out = `${tar}.renamed`;
  fs.writeFileSync(out, raw);
  return out;
}

test("an export that didn't come from the exporter, or files that would be one file on a case-insensitive disk, fail the run", async () => {
  const hardlink = workspaceTar({ "a.txt": "a" }, (ws) => fs.linkSync(path.join(ws, "a.txt"), path.join(ws, "b.txt")));
  const folded = renamed(workspaceTar({ "d/R.txt": "1", "d/x.txt": "2" }), "./d/x.txt", "./d/r.txt");
  for (const [tar, error] of [[hardlink, /hard-link/], [folded, /case-insensitive/]] as const) {
    const { deps } = setup(tar);
    const record = await runOnce(commandSpec(outDir()), deps);
    assert.equal(record.run.status, "failed");
    assert.match(record.run.error ?? "", error);
    assert.equal(record.cleanup.status, "verified-absent");
    assert.deepEqual(recordProblems(record), []);
  }
});

test("command specs that can't run safely are refused before the cluster is touched", async () => {
  const cases = [
    [{ command: { argv: [], inputs: {} } }, /needs an argv/],
    [{ command: { argv: ["a\0b"], inputs: {} } }, /NUL/],
    [{ command: { argv: ["x".repeat(70_000)], inputs: {} } }, /argv is over/],
    ...["../x", ".hidden", "a//b", "/abs", "a/./b", "a b", ""].map((name): [Partial<RunSpec>, RegExp] => [{ command: { argv: ["a"], inputs: { [name]: Buffer.from("") } } }, /plain segments/]),
    [{ command: { argv: ["a"], inputs: { a: Buffer.from(""), "a/b": Buffer.from("") } } }, /both a file and a directory/],
    [{ command: { argv: ["a"], inputs: { big: Buffer.alloc(800 * 1024) } } }, /over 786432 bytes/],
    [{ repo: "/repo" }, /not a repository or a prompt/],
    [{ prompt: "do it" }, /not a repository or a prompt/],
    [{ routes: [parseRoute("openai=https://a.test@k"), parseRoute("anthropic=https://b.test@k")], model: "m", models: ["m"] }, /at most one model route/],
    [{ model: "m", models: ["m"] }, /can't be granted models/],
    [{ routes: [parseRoute("openai=https://a.test@k")] }, /needs a model/],
    [{ agent: "fake", command: undefined }, /takes a repository/],
  ] as [Partial<RunSpec>, RegExp][];
  for (const [change, error] of cases) {
    const { cluster, deps } = setup();
    await assert.rejects(runOnce(commandSpec(outDir(), change), deps), error, JSON.stringify(change).slice(0, 80));
    assert.equal(cluster.calls.length, 0);
  }
  await assert.rejects(runOnce({ ...commandSpec(outDir()), agent: "codex", command: { argv: ["a"], inputs: {} }, repo: "/r", prompt: "p" }, setup().deps), /not a command/);
});

test("the request digest covers what the run does and nothing else", () => {
  const base = commandSpec("/a");
  const d = requestDigest(base);
  assert.equal(requestDigest({ ...base, out: "/b", key: "k" }), d, "not where it's written or under which key");
  assert.equal(requestDigest({ ...base, maxModelRequests: 2000, slackSeconds: 300 }), d, "defaults count as given");
  for (const change of [
    { command: { argv: ["python3", "-I", "inputs/other.py"], inputs: base.command!.inputs } },
    { command: { argv: base.command!.argv, inputs: { ...base.command!.inputs, "case.bin": Buffer.from([0, 1, 2, 254]) } } },
    { image: AGENT_IMAGE.replace(/.$/, "0") },
    { timeoutSeconds: 61 },
    { allow: [{ host: "a.test", port: 443, private: false }] },
  ] as Partial<RunSpec>[]) {
    assert.notEqual(requestDigest({ ...base, ...change }), d, JSON.stringify(change).slice(0, 60));
  }
});

test("a command with no input files still gets inputs/ as a read-only mount, so nothing it writes is left out as input", async () => {
  // The reviewer's case: a no-input command that writes inputs/decision.json. With inputs/ always mounted read-only, it can't.
  const tar = workspaceTar({ "kept.json": "{}\n" });
  const { cluster, deps } = setup(tar);
  const record = await runOnce(commandSpec(outDir(), { command: { argv: ["node", "-e", "/* writes inputs/decision.json */"], inputs: {} } }), deps);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  const pod = (created(cluster.calls).find((o) => o.kind === "Sandbox") as Any).spec.podTemplate.spec;
  assert.deepEqual(pod.containers[0].volumeMounts.find((m: Any) => m.mountPath === COMMAND_INPUTS), { name: "files", mountPath: COMMAND_INPUTS, readOnly: true });
  assert.deepEqual(pod.volumes.find((v: Any) => v.name === "files"), { name: "files", emptyDir: { sizeLimit: "1Mi" } });
  assert.deepEqual(record.result.files?.map((f) => f.path), ["kept.json"]);
});
