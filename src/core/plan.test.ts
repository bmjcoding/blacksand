import assert from "node:assert/strict";
import { test } from "node:test";

import { PlanError, parsePlan, type Plan } from "./plan.ts";

const SHA = "a".repeat(64);

const plan = (): Plan => ({
  schema: "blacksand.plan/1",
  blacksand: { version: "0.1.0", commit: "b".repeat(40) },
  machine: { id: "host-1", role: "host", platform: "darwin-arm64" },
  config_sha256: SHA,
  observed_sha256: SHA,
  steps: [{ id: "account/agent-work", action: "create", widens_access: true, summary: "standard account agent-work", after: { shell: "/bin/zsh" }, reason: "listed in agents" }],
  warnings: [{ code: "terms/anthropic-oauth", text: "subscription sign-in" }],
});

/** `plan()` changed by `edit`, through JSON as apply reads it. */
const edited = (edit: (p: Record<string, any>) => void) => {
  const p = JSON.parse(JSON.stringify(plan()));
  edit(p);
  return p;
};

test("a well-formed plan reads back as it was written", () => {
  assert.deepEqual(parsePlan(JSON.parse(JSON.stringify(plan()))), plan());
  const unconfigured = edited((p) => Object.assign(p, { config_sha256: null, machine: { id: null, role: null, platform: "linux-x64" }, steps: [] }));
  assert.deepEqual(parsePlan(unconfigured).machine, { id: null, role: null, platform: "linux-x64" });
});

test("anything apply would have to guess about is refused, saying where", () => {
  const cases: [(p: Record<string, any>) => void, RegExp][] = [
    [(p) => (p.schema = "blacksand.plan/2"), /plan schema: is "blacksand.plan\/2"/],
    [(p) => (p.extra = 1), /plan : has unknown field extra/],
    [(p) => delete p.warnings, /has no warnings/],
    [(p) => (p.steps[0].action = "chmod"), /steps\[0\]\.action: isn't one of/],
    [(p) => (p.steps[0].widens_access = "no"), /steps\[0\]\.widens_access/],
    [(p) => (p.steps[0].after = []), /steps\[0\]\.after: isn't an object/],
    [(p) => (p.steps[0].sudo = true), /steps\[0\]: has unknown field sudo/],
    [(p) => p.steps.push(p.steps[0]), /lists account\/agent-work twice/],
    [(p) => (p.observed_sha256 = "abc"), /observed_sha256: isn't a SHA-256/],
    [(p) => (p.observed_sha256 = null), /observed_sha256: isn't a SHA-256/],
    [(p) => (p.machine.role = "root"), /machine\.role: isn't one of/],
    [(p) => (p.machine.platform = "win32-x64"), /machine\.platform/],
    [(p) => (p.blacksand.commit = "main"), /blacksand\.commit: isn't a full commit id/],
    [(p) => (p.warnings[0].code = ""), /warnings\[0\]\.code/],
  ];
  for (const [edit, message] of cases) assert.throws(() => parsePlan(edited(edit)), (error: unknown) => error instanceof PlanError && message.test(error.message), String(message));
  for (const value of [null, [], "plan", 1]) assert.throws(() => parsePlan(value), PlanError);
});
