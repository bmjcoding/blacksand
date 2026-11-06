// Durable run receipts: under a caller's key the output directory is the
// claim, the record is the receipt, and a key never launches twice: racing
// runner processes, a crash between the claim and the record, a changed
// request, and cleanup that must never touch a receipt.

import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { EXIT } from "../../../src/core/envelope.ts";
import { k8s, runSpec } from "../src/command.ts";
import { proxyObjects, runNames, sandboxObjects } from "../src/manifests.ts";
import { parseRoute, sha256 } from "../src/policy.ts";
import { provisionReceipts, readReceipt, receiptDir, receiptStatus, ReceiptError, takeClaim, type Claim } from "../src/receipt.ts";
import { hostBundle, reconcile, requestDigest, runOnce, type RunDeps, type RunSpec } from "../src/run.ts";
import { AGENT_IMAGE, PROXY_IMAGE, commandSpec, fakeCluster, workspaceTar } from "./fake-cluster.ts";

const WORKSPACE = workspaceTar({ "out/decision.json": "{}\n" });
const RUNNER = fileURLToPath(new URL("./fixtures/receipt-runner.ts", import.meta.url));

function receipt(key = "attempt/case-7/repeat-2", change: Partial<RunSpec> = {}) {
  const root = provisionReceipts(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-receipts-")));
  return { root, spec: commandSpec(receiptDir(root, key), { key, ...change }) };
}

function deps(cluster = fakeCluster("", WORKSPACE), start = Date.parse("2026-11-01T00:00:00Z")): RunDeps & { cluster: typeof cluster } {
  let time = start;
  let hex = 0;
  return { cluster, kubectl: cluster.kubectl, now: () => (time += 1000), randomHex: (bytes) => (hex++ % 2 ? "f".repeat(bytes * 2) : `abcdef0${String(hex).padStart(5, "0")}`), bundle: hostBundle, progress: () => {}, sleep: async () => {} };
}

/** Runs the receipt runner as its own process; resolves with what it printed and how it ended. */
function runner(spec: RunSpec, mode: "race" | "crash", startAt = 0): Promise<{ out: string; signal: NodeJS.Signals | null }> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-spec-")), "spec.json");
  const inputs = Object.fromEntries(Object.entries(spec.command?.inputs ?? {}).map(([name, data]) => [name, data.toString("base64")]));
  fs.writeFileSync(file, JSON.stringify({ ...spec, command: { argv: spec.command?.argv, inputs } }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, file, WORKSPACE, mode, String(startAt)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (_status, signal) => resolve({ out, signal }));
  });
}

const files = (dir: string) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();

/** A replay must not even construct a new run's identity or use its clock. */
function noDispatch(): RunDeps {
  const forbidden = (): never => { throw new Error("recovery called a dispatch dependency"); };
  return { kubectl: forbidden, now: forbidden, randomHex: forbidden, bundle: forbidden, progress: forbidden, sleep: forbidden };
}

test("replay-only reads successful and failed receipts without any dispatch dependency or disk write", async () => {
  for (const failed of [false, true]) {
    const { root, spec } = receipt(`replay/${failed}`);
    const cluster = failed ? fakeCluster("", WORKSPACE, { "exec observe": { status: 1, stderr: "no" } }) : fakeCluster("", WORKSPACE);
    const record = await runOnce(spec, deps(cluster));
    const snapshot = () => files(root).map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]);
    const before = snapshot();
    assert.deepEqual(await runOnce({ ...spec, replayOnly: true }, noDispatch()), record);
    await assert.rejects(runOnce({ ...spec, replayOnly: true, timeoutSeconds: 61 }, noDispatch()),
      (error: unknown) => error instanceof ReceiptError && error.code === "request-changed");
    assert.deepEqual(snapshot(), before);
  }
});

test("replay-only never creates a missing root or key, including a receipt removed after completed status", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-replay-missing-"));
  const missing = path.join(parent, "new", "receipts");
  const spec = commandSpec(receiptDir(missing, "missing"), { key: "missing", replayOnly: true });
  await assert.rejects(runOnce(spec, noDispatch()), (error: unknown) => error instanceof ReceiptError && error.code === "claimed");
  assert.deepEqual(fs.readdirSync(parent), []);
  provisionReceipts(missing);
  await assert.rejects(runOnce(spec, noDispatch()), ReceiptError);
  assert.deepEqual(fs.readdirSync(missing), ["READY"]);
  const completed = await runOnce({ ...spec, replayOnly: false }, deps());
  assert.equal((await receiptStatus(missing, "missing", noDispatch().kubectl, Date.now())).record?.run.id, completed.run.id);
  fs.rmSync(spec.out, { recursive: true }); // remove this isolated fixture between status and recovery
  await assert.rejects(runOnce(spec, noDispatch()), ReceiptError);
  assert.deepEqual(fs.readdirSync(missing), ["READY"], "the read never reclaims the vanished receipt");
});

test("replay-only refuses incomplete, malformed and misbound receipts without changing them", async () => {
  const corruptions: [string, (dir: string) => void][] = [
    ["no claim", (dir) => fs.unlinkSync(path.join(dir, "claim.json"))],
    ["no record", (dir) => fs.unlinkSync(path.join(dir, "record.json"))],
    ["claim JSON", (dir) => fs.writeFileSync(path.join(dir, "claim.json"), "{")],
    ["record JSON", (dir) => fs.writeFileSync(path.join(dir, "record.json"), "{")],
    ["record shape", (dir) => fs.writeFileSync(path.join(dir, "record.json"), "{}")],
    ["claim identity", (dir) => {
      const claim = JSON.parse(fs.readFileSync(path.join(dir, "claim.json"), "utf8")) as Claim;
      fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({ ...claim, key: "another-key" }));
    }],
    ["record identity", (dir) => {
      const record = JSON.parse(fs.readFileSync(path.join(dir, "record.json"), "utf8"));
      record.run.id = "111111111111";
      fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify(record));
    }],
  ];
  for (const [name, damage] of corruptions) {
    const { root, spec } = receipt(`replay-corrupt/${name}`);
    await runOnce(spec, deps());
    damage(spec.out);
    const before = files(root).map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]);
    await assert.rejects(runOnce({ ...spec, replayOnly: true }, noDispatch()),
      (error: unknown) => error instanceof ReceiptError && error.code === "claimed", name);
    assert.deepEqual(files(root).map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]), before, name);
  }
});

test("the CLI's replay-only path reads without a working kubectl and refuses a vanished receipt", async () => {
  const root = provisionReceipts(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-cli-replay-")));
  const args = ["--agent", "command", "--argv", '["true"]', "--key", "cli-replay", "--receipts", root];
  const spec = runSpec(args) as RunSpec;
  const record = await runOnce(spec, deps());
  const output: string[] = [];
  const ctx = { json: true, io: { out: (text: string) => output.push(text), err: () => {} } } as unknown as Parameters<typeof k8s.run>[1];
  const previousKubectl = process.env.BLACKSAND_KUBECTL;
  process.env.BLACKSAND_KUBECTL = JSON.stringify(["/a/kubectl/that/does/not/exist"]);
  try {
    assert.equal(await k8s.run(["run", ...args, "--replay-only"], ctx), 0);
    assert.deepEqual(JSON.parse(output.pop() ?? ""), record);
    fs.rmSync(spec.out, { recursive: true });
    assert.equal(await k8s.run(["run", ...args, "--replay-only"], ctx), EXIT.refused);
    assert.equal(JSON.parse(output.pop() ?? "").error.code, "claimed");
    assert.deepEqual(fs.readdirSync(root), ["READY"]);
  } finally {
    if (previousKubectl === undefined) delete process.env.BLACKSAND_KUBECTL;
    else process.env.BLACKSAND_KUBECTL = previousKubectl;
  }
});

test("racing runner processes: exactly one claims the key and launches; every other is answered or refused, none launches", async () => {
  const { root, spec } = receipt();
  const startAt = Date.now() + 700;
  const results = await Promise.all(Array.from({ length: 6 }, () => runner(spec, "race", startAt)));
  const outcomes = results.map((r) => JSON.parse(r.out) as { outcome: string; run?: string; code?: string });
  const launched = outcomes.filter((o) => o.outcome === "launched");
  assert.equal(launched.length, 1, JSON.stringify(outcomes));
  for (const o of outcomes.filter((x) => x.outcome !== "launched")) {
    assert.ok((o.outcome === "refused" && o.code === "claimed") || (o.outcome === "answered" && o.run === launched[0]?.run), JSON.stringify(o));
  }
  const after = readReceipt(receiptDir(root, spec.key as string));
  assert.equal(after.state, "completed");
  assert.equal(after.record?.run.id, launched[0]?.run);
  assert.equal(after.claim?.run_id, launched[0]?.run);
});

test("a runner that dies between its claim and its record leaves the key claimed: unknown, and never launched again", async () => {
  const { root, spec } = receipt();
  const crashed = await runner(spec, "crash");
  assert.equal(crashed.signal, "SIGKILL");
  const dir = receiptDir(root, spec.key as string);
  const left = readReceipt(dir);
  assert.equal(left.state, "claimed");
  assert.equal(left.record, null);
  assert.ok(left.claim && /^[0-9a-f]{12}$/.test(left.claim.run_id) && !Number.isNaN(Date.parse(left.claim.deadline)));
  assert.deepEqual(files(dir), ["claim.json"]);
  // Same request: refused as unknown, before the cluster is touched.
  const again = deps();
  await assert.rejects(runOnce(spec, again), (e: unknown) => e instanceof ReceiptError && e.code === "claimed" && /outcome is unknown/.test(e.message));
  assert.equal(again.cluster.calls.length, 0);
  // A changed request under the same key: refused as changed.
  const changed = deps();
  await assert.rejects(runOnce({ ...spec, timeoutSeconds: 61 }, changed), (e: unknown) => e instanceof ReceiptError && e.code === "request-changed");
  assert.equal(changed.cluster.calls.length, 0);
});

test("the same key and request returns the completed record without launching; a changed request is refused", async () => {
  const { spec } = receipt();
  const first = deps();
  const record = await runOnce(spec, first);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  const claim = JSON.parse(fs.readFileSync(path.join(spec.out, "claim.json"), "utf8")) as Claim;
  assert.deepEqual([claim.request_sha256, claim.run_id, claim.deadline, claim.key], [record.run.request_sha256, record.run.id, record.times.deadline, spec.key]);
  const second = deps();
  assert.deepEqual(await runOnce(spec, second), record);
  assert.equal(second.cluster.calls.length, 0, "not launched");
  for (const change of [{ command: { argv: ["python3", "other.py"], inputs: {} } }, { image: AGENT_IMAGE.replace(/.$/, "0") }, { routes: [parseRoute("openai=https://m.test@k")], model: "m", models: ["m"] }] as Partial<RunSpec>[]) {
    const third = deps();
    await assert.rejects(runOnce({ ...spec, ...change }, third), (e: unknown) => e instanceof ReceiptError && e.code === "request-changed");
    assert.equal(third.cluster.calls.length, 0);
  }
});

test("the claim is on disk before the cluster is touched, and the record is the last thing written, whole", async () => {
  const { spec } = receipt();
  const d = deps();
  let claimFirst: boolean | null = null;
  const record = await runOnce(spec, {
    ...d,
    kubectl: (args, options) => {
      claimFirst ??= fs.existsSync(path.join(spec.out, "claim.json")) && !fs.existsSync(path.join(spec.out, "record.json"));
      return d.cluster.kubectl(args, options);
    },
  });
  assert.equal(claimFirst, true);
  assert.ok(!files(spec.out).some((f) => f.endsWith(".partial")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spec.out, "record.json"), "utf8")), record);
});

test("a failed run's record is its receipt too: completed, returned again, never rerun", async () => {
  const { root, spec } = receipt();
  const record = await runOnce(spec, deps(fakeCluster("", WORKSPACE, { "exec observe": { status: 1, stderr: "no" } })));
  assert.equal(record.run.status, "failed");
  assert.equal(readReceipt(receiptDir(root, spec.key as string)).state, "completed");
  const again = deps();
  assert.deepEqual(await runOnce(spec, again), record);
  assert.equal(again.cluster.calls.length, 0);
});

test("a claim whose runner stopped before writing its details is claimed, with no details, and refused", async () => {
  const { root, spec } = receipt();
  fs.mkdirSync(receiptDir(root, spec.key as string), { recursive: true });
  assert.deepEqual(readReceipt(spec.out), { state: "claimed", claim: null, record: null });
  const d = deps();
  await assert.rejects(runOnce(spec, d), (e: unknown) => e instanceof ReceiptError && e.code === "claimed");
  assert.equal(d.cluster.calls.length, 0);
  const status = await receiptStatus(root, spec.key as string, d.kubectl, Date.now());
  assert.equal(status.authority, null);
});

test("status reports a claimed run's deadline and its objects left, and never claims its authority ended", async () => {
  const { root, spec } = receipt();
  const dir = receiptDir(root, spec.key as string);
  const deadline = Date.parse("2026-11-01T00:30:00Z");
  const claim: Claim = { schema: "blacksand.claim/1", key: spec.key as string, request_sha256: "0".repeat(64), run_id: "aaaaaaaaaaaa", claimed_at: "2026-11-01T00:00:00.000Z", deadline: new Date(deadline).toISOString() };
  assert.equal(takeClaim(dir, claim), true);
  assert.equal(takeClaim(dir, claim), false, "a second claim of the same key loses");
  const names = runNames("aaaaaaaaaaaa");
  const live = [
    ...proxyObjects({ names, image: PROXY_IMAGE, files: { "proxy.ts": "", "config.json": "{}" }, route: null, deadlineSeconds: 600, deadline: deadline / 1000 }),
    ...sandboxObjects({ names, image: AGENT_IMAGE, toolsImage: null, tripwire: { image: PROXY_IMAGE, canary: { host: "10.43.0.10", port: 53 } }, inputs: {}, env: {}, deadlineSeconds: 600, shutdownTime: claim.deadline, deadline: deadline / 1000 }),
  ] as Record<string, any>[];
  const withObjects = fakeCluster("", WORKSPACE, {}, live);
  const before = await receiptStatus(root, spec.key as string, withObjects.kubectl, deadline + 1000);
  assert.equal(before.state, "claimed");
  assert.equal(before.authority?.past_deadline, true);
  assert.equal(before.authority?.objects?.length, 7, "past its deadline, but its objects are still there");
  assert.equal("ended" in (before.authority ?? {}), false, "status never asserts the run can no longer act");
  const empty = fakeCluster("", WORKSPACE);
  assert.equal((await receiptStatus(root, spec.key as string, empty.kubectl, deadline - 1000)).authority?.past_deadline, false, "gone, but its deadline hasn't passed");
  const after = await receiptStatus(root, spec.key as string, empty.kubectl, deadline + 1000);
  assert.deepEqual(after.authority, { deadline: claim.deadline, past_deadline: true, objects: [], foreign: [], error: null });
  const unreachable = await receiptStatus(root, spec.key as string, async () => ({ status: 1, stdout: Buffer.alloc(0), stderr: "connection refused" }), deadline + 1000);
  assert.equal(unreachable.authority?.objects, null);
  assert.match(unreachable.authority?.error ?? "", /connection refused/);
});

test("run teardown and reconcile never delete a receipt", async () => {
  const { root, spec } = receipt();
  const d = deps();
  const record = await runOnce(spec, d);
  const dir = receiptDir(root, spec.key as string);
  const snapshot = () => files(dir).map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))]);
  const kept = snapshot();
  assert.ok(kept.some(([f]) => f === "record.json") && kept.some(([f]) => f === "files/out/decision.json"));
  // The same run's objects left behind and expired: reconcile deletes them, and nothing on disk.
  const names = runNames(record.run.id);
  const leftover = sandboxObjects({ names, image: AGENT_IMAGE, toolsImage: null, tripwire: { image: PROXY_IMAGE, canary: { host: "10.43.0.10", port: 53 } }, inputs: {}, env: {}, deadlineSeconds: 600, shutdownTime: record.times.deadline, deadline: 1 }) as Record<string, any>[];
  const cluster = fakeCluster("", WORKSPACE, {}, leftover);
  assert.deepEqual((await reconcile(cluster.kubectl, Date.now())).deleted, [record.run.id]);
  assert.deepEqual(snapshot(), kept);
  assert.equal(readReceipt(dir).state, "completed");
});

test("the CLI: --key makes the output directory the key's receipt; status answers for it", async () => {
  const { root, spec } = receipt("cli-key");
  const out: string[] = [];
  const ctx = { json: true, io: { out: (t: string) => out.push(t), err: () => {} }, clock: { now: () => new Date() }, run: () => ({ status: 0, signal: null }) } as unknown as Parameters<typeof k8s.run>[1];
  assert.equal(await k8s.run(["status", "--key", "cli-key", "--receipts", root], ctx), 0);
  assert.equal(JSON.parse(out.pop() ?? "").state, "unclaimed");
  const record = await runOnce(spec, deps());
  assert.equal(await k8s.run(["status", "--key", "cli-key", "--receipts", root], ctx), 0);
  const answer = JSON.parse(out.pop() ?? "");
  assert.deepEqual([answer.schema, answer.state, answer.record.run.id, answer.receipt, answer.authority], ["blacksand.receipt/1", "completed", record.run.id, path.join(root, sha256("cli-key")), null]);
});

// Fixes after review: the receipts root, short writes, and input names.

test("a claim never creates the receipts root: missing, the run is refused before anything is made or launched", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-noroot-"));
  const root = path.join(parent, "new-state", "receipts");
  const claim: Claim = { schema: "blacksand.claim/1", key: "k", request_sha256: "a".repeat(64), run_id: "abcdef012345", claimed_at: "2026-11-01T00:00:00Z", deadline: "2026-11-01T00:06:00Z" };
  assert.throws(() => takeClaim(receiptDir(root, "k"), claim), /isn't provisioned .*blacksand k8s setup --receipts/);
  assert.deepEqual(fs.readdirSync(parent), [], "nothing made, so nothing a crash could half-keep");
  const d = deps();
  await assert.rejects(runOnce(commandSpec(receiptDir(root, "k"), { key: "k" }), d), /isn't provisioned/);
  assert.equal(d.cluster.calls.length, 0);
});

/** Records which paths each fsync and write went to, and can make chosen writes short (fewer bytes than asked, as write(2) may). */
function faults(short: (file: string) => boolean = () => false) {
  const real = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, writeSync: fs.writeSync };
  const names = new Map<number, string>();
  const synced: string[] = [];
  let shortened = 0;
  Object.assign(fs, {
    openSync: (file: fs.PathLike, ...rest: unknown[]) => {
      const fd = (real.openSync as (...a: unknown[]) => number)(file, ...rest);
      names.set(fd, String(file));
      return fd;
    },
    closeSync: (fd: number) => (names.delete(fd), real.closeSync(fd)),
    fsyncSync: (fd: number) => (synced.push(names.get(fd) ?? "?"), real.fsyncSync(fd)),
    writeSync: (fd: number, buffer: unknown, ...args: unknown[]) => {
      if (Buffer.isBuffer(buffer) && short(names.get(fd) ?? "")) {
        const offset = typeof args[0] === "number" ? args[0] : 0;
        const length = typeof args[1] === "number" ? args[1] : buffer.length - offset;
        shortened++;
        return real.writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), null);
      }
      return (real.writeSync as (...a: unknown[]) => number)(fd, buffer, ...args);
    },
  });
  syncBuiltinESMExports();
  return {
    synced,
    shortened: () => shortened,
    restore: () => (Object.assign(fs, real), syncBuiltinESMExports()),
  };
}

test("provisioning the receipts root syncs each new directory's name into its parent, and is safe to repeat", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-provision-"));
  const root = path.join(parent, "new-state", "receipts");
  const trace = faults();
  try {
    assert.equal(provisionReceipts(root), root);
  } finally {
    trace.restore();
  }
  for (const dir of [parent, path.join(parent, "new-state"), root]) assert.ok(trace.synced.includes(dir), `${dir} synced`);
  assert.ok(fs.existsSync(path.join(root, "READY")), "the marker, last");
  assert.equal(provisionReceipts(root), root, "again: nothing to make");
  assert.equal(takeClaim(receiptDir(root, "k"), { schema: "blacksand.claim/1", key: "k", request_sha256: "a".repeat(64), run_id: "abcdef012345", claimed_at: "2026-11-01T00:00:00Z", deadline: "2026-11-01T00:06:00Z" }), true);
});

test("short writes can't truncate a command's output or the record: every byte written, the digests the bytes on disk", async () => {
  for (const target of ["/files/out/decision.json", "/record.json.partial"]) {
    const { root, spec } = receipt(`short${target}`);
    const trace = faults((file) => file.endsWith(target));
    let record;
    try {
      record = await runOnce(spec, deps(fakeCluster("", workspaceTar({ "out/decision.json": '{"performed":true}\n' }))));
    } finally {
      trace.restore();
    }
    assert.ok(trace.shortened() > 0, `${target}: the fault was injected`);
    assert.equal(record.run.complete, true, record.run.error ?? "");
    const output = fs.readFileSync(path.join(spec.out, "files", "out", "decision.json"));
    assert.deepEqual(record.result.files, [{ path: "out/decision.json", sha256: sha256(output), bytes: output.length }]);
    assert.equal(output.toString(), '{"performed":true}\n', target);
    assert.deepEqual(readReceipt(receiptDir(root, spec.key as string)).record, record, `${target}: the whole record, readable`);
  }
});

test("an input named __proto__ is an input like any other: mounted, hashed, a duplicate refused, changed bytes a changed request", async () => {
  const dir = provisionReceipts(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-proto-")));
  const [a, b] = [path.join(dir, "a"), path.join(dir, "b")];
  fs.writeFileSync(a, "first input");
  fs.writeFileSync(b, "changed input");
  const parse = (...inputs: string[]) => runSpec(["--agent", "command", "--argv", '["true"]', ...inputs.flatMap((i) => ["--input", i]), "--key", "known-key", "--receipts", dir]);
  const one = parse(`__proto__=${a}`) as RunSpec;
  const two = parse(`__proto__=${b}`) as RunSpec;
  assert.deepEqual(Object.keys(one.command?.inputs ?? {}), ["__proto__"]);
  assert.notEqual(requestDigest(one), requestDigest(two));
  assert.match((parse(`__proto__=${a}`, `__proto__=${b}`) as { error: string }).error, /given twice/);
  const first = deps();
  const record = await runOnce(one, first);
  assert.deepEqual(record.command?.inputs, { ["__proto__"]: sha256("first input") });
  const sandbox = first.cluster.calls.filter((c) => c.args[0] === "create").flatMap((c) => (JSON.parse(c.stdin) as { items: Record<string, any>[] }).items).find((o) => o.kind === "Sandbox");
  assert.deepEqual(sandbox?.spec.podTemplate.spec.volumes.find((v: Record<string, any>) => v.name === "files").configMap.items, [{ key: "file.0", path: "__proto__" }]);
  const second = deps();
  await assert.rejects(runOnce(two, second), (e: unknown) => e instanceof ReceiptError && e.code === "request-changed");
  assert.equal(second.cluster.calls.length, 0);
});

test("a receipts root a setup is still making (or died making) is refused until setup finishes; then it's accepted", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-halfsetup-"));
  const root = path.join(parent, "new-state", "receipts");
  const setup = fork(fileURLToPath(new URL("./fixtures/provision-paused.ts", import.meta.url)), [root], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const gone = new Promise((resolve) => setup.once("exit", resolve));
  try {
    assert.deepEqual(await new Promise((resolve, reject) => (setup.once("message", resolve), setup.once("exit", () => reject(new Error("setup exited before its pause"))))), { phase: "root-visible-before-parent-sync" });
    assert.ok(fs.statSync(root).isDirectory(), "the root is there, its name not yet synced");
    const early = deps();
    await assert.rejects(runOnce(commandSpec(receiptDir(root, "race"), { key: "race" }), early), /isn't provisioned .*k8s setup --receipts/);
    assert.equal(early.cluster.calls.length, 0, "nothing launched");
    assert.deepEqual(fs.readdirSync(root), [], "and nothing claimed");
  } finally {
    setup.kill("SIGKILL");
    await gone;
  }
  // The setup died there: running it again completes the root, and the same run is accepted.
  provisionReceipts(root);
  const later = deps();
  const record = await runOnce(commandSpec(receiptDir(root, "race"), { key: "race" }), later);
  assert.equal(record.run.complete, true, record.run.error ?? "");
  assert.equal(readReceipt(receiptDir(root, "race")).state, "completed");
});
