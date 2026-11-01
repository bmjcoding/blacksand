import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_LIMITS } from "../src/policy.ts";
import { recordProblems, RUN_SCHEMA, type RunRecord } from "../src/record.ts";

const digest = "a".repeat(64);
const image = `docker.io/library/node@sha256:${digest}`;
const complete: RunRecord = {
  schema: RUN_SCHEMA,
  blacksand: { version: "0.1.0", commit: null },
  run: { id: "abcdef012345", key: null, status: "completed", complete: true, error: null },
  substrate: { kind: "kubernetes", adapter: "substrate-k8s", mode: "per-run" },
  times: { started: "2026-11-01T00:00:00.000Z", sandbox_ready: "2026-11-01T00:00:02.000Z", agent_started: "2026-11-01T00:00:03.000Z", agent_ended: "2026-11-01T00:00:09.000Z", ended: "2026-11-01T00:00:12.000Z", deadline: "2026-11-01T00:10:00.000Z" },
  cluster: { server_version: "v1.37.1+k3s1", node: { name: "n", os_image: "Ubuntu", kernel: "6.8", container_runtime: "containerd", architecture: "arm64" } },
  sandbox: { namespace: "blacksand-runs", name: "sabcdef012345", uid: "u1", pod_uid: "u2", runtime_class: "blacksand-sandbox", runtime_handler: "blacksand-sandbox", observed: { uid: "1000", kernel: "4.19.0-gvisor", dmesg: "Starting gVisor..." }, controller_image: null, floor: { node_label: "0123456789abcdef", canary: "10.43.0.10:53", canary_reached: false }, left_running: 0 },
  image: { requested: image, resolved: image, matches: true, tools: null },
  proxy: { pod: "pabcdef012345", pod_uid: "u3", image, resolved: image, matches: true, source_sha256: digest },
  policy: { allow: [{ host: "example.com", port: 443, private: false }], route: { kind: "anthropic", origin: "https://api.anthropic.com", base_path: "", secret: "k" }, models: ["m"], limits: DEFAULT_LIMITS, effective_sha256: digest, inputs_sha256: digest },
  source: { repo: "/repo", kind: "local", base: "0".repeat(40) },
  agent: { name: "codex", model: "gpt-6.1-sol", route: "openai", settings: { sandbox_mode: "danger-full-access", approval_policy: "never", model_reasoning_effort: "medium" }, exit_status: 0, env_names: ["HOME"] },
  egress: { allowed: 1, denied: 1, denied_hosts: {}, model_calls: [], audit: { entries: 4, sealed: true, problems: [] } },
  result: { patch: { file: "patch.diff", sha256: digest, bytes: 10 }, patch_files: 1, ignored_files: 0, skipped_entries: 0 },
  artifacts: [{ file: "patch.diff", sha256: digest, bytes: 10 }],
  cleanup: { status: "verified-absent", remaining: [], foreign: [] },
};

test("a complete record with all its evidence has no problems", () => {
  assert.deepEqual(recordProblems(complete), []);
});

test("a record can't claim to be complete without the evidence that earns it", () => {
  const cases: [Partial<RunRecord>, RegExp][] = [
    [{ sandbox: { ...complete.sandbox, pod_uid: null } }, /UIDs/],
    [{ image: { ...complete.image, matches: false } }, /agent image/],
    [{ proxy: { ...complete.proxy, matches: false } }, /proxy image/],
    [{ sandbox: { ...complete.sandbox, floor: { ...complete.sandbox.floor, canary_reached: true } } }, /egress floor/],
    [{ sandbox: { ...complete.sandbox, floor: { ...complete.sandbox.floor, node_label: null } } }, /egress floor/],
    [{ sandbox: { ...complete.sandbox, left_running: 1 } }, /frozen/],
    [{ policy: { ...complete.policy, effective_sha256: null } }, /effective policy/],
    [{ source: { ...complete.source, base: null } }, /base commit/],
    [{ result: { ...complete.result, patch: null } }, /patch/],
    [{ egress: { ...complete.egress, audit: null } }, /sealed audit/],
    [{ egress: { ...complete.egress, audit: { entries: 3, sealed: false, problems: [] } } }, /sealed audit/],
    [{ egress: { ...complete.egress, audit: { entries: 3, sealed: true, problems: ["a gap"] } } }, /sealed audit/],
    [{ run: { ...complete.run, status: "timed_out", error: "late" } }, /didn't complete/],
  ];
  for (const [change, problem] of cases) assert.match(recordProblems({ ...complete, ...change }).join("; "), problem, JSON.stringify(change).slice(0, 80));
});

test("a run that didn't complete must say why", () => {
  const failed = { ...complete, run: { ...complete.run, status: "failed" as const, complete: false, error: null } };
  assert.match(recordProblems(failed).join("; "), /says why/);
  assert.deepEqual(recordProblems({ ...failed, run: { ...failed.run, error: "the proxy never became ready" } }), []);
});

test("an unpinned image or malformed digest is a problem in any record", () => {
  assert.match(recordProblems({ ...complete, image: { ...complete.image, requested: "node:24" } }).join(), /pinned/);
  assert.match(recordProblems({ ...complete, proxy: { ...complete.proxy, image: "node:24" } }).join(), /pinned/);
  assert.match(recordProblems({ ...complete, artifacts: [{ file: "x", sha256: "nope", bytes: 1 }] }).join(), /malformed digest/);
  assert.match(recordProblems({ ...complete, times: { ...complete.times, ended: "2025-01-01T00:00:00Z" } }).join(), /ended before/);
  const { settings: _, ...unsettled } = complete.agent;
  assert.match(recordProblems({ ...complete, agent: unsettled as RunRecord["agent"] }).join(), /agent\.settings/);
});
