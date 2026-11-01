import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENTS } from "../src/agents.ts";
import { runSpec } from "../src/command.ts";
import type { RunSpec } from "../src/run.ts";

const TOOLS = `blacksand.local/agent-tools@sha256:${"c".repeat(64)}`;
const args = (agent: "claude" | "codex" | "fake", route: string) => ["--repo", "/repo", "--prompt", "p", "--agent", agent, "--route", route, "--tools-image", TOOLS, "--out", "/tmp/never-made"];
const codex = args("codex", "openai=https://api.openai.com@openai-key");
const claude = args("claude", "anthropic=https://api.anthropic.com@anthropic-key");
const spec = (a: string[]) => {
  const parsed = runSpec(a);
  assert.ok(!("error" in parsed), "error" in parsed ? String(parsed.error) : "");
  return parsed as RunSpec;
};
const error = (a: string[]) => {
  const parsed = runSpec(a);
  return "error" in parsed ? parsed.error : null;
};

test("each adapter renders its defaults: codex gpt-6.1-sol at medium reasoning effort, claude claude-sonnet-5-5 at medium effort", () => {
  assert.deepEqual([spec(codex).model, spec(codex).models], ["gpt-6.1-sol", ["gpt-6.1-sol"]]);
  assert.match(AGENTS.codex.files({ proxyIp: "10.247.1.9" })["codex-config.toml"] ?? "", /^model_reasoning_effort = "medium"$/m);
  assert.deepEqual([spec(claude).model, spec(claude).models], ["claude-sonnet-5-5", ["claude-sonnet-5-5"]]);
  assert.match(AGENTS.claude.script, /^export CLAUDE_CODE_EFFORT_LEVEL=medium$/m);
  assert.doesNotMatch(AGENTS.claude.script, /--effort/, "one effort setting, the one that wins");
  assert.equal(AGENTS.claude.settings.effort_level, "medium");
  assert.equal(AGENTS.codex.settings.model_reasoning_effort, "medium");
  // A model given, and the grant, are the caller's; the fake agent has no default.
  assert.equal(spec([...codex, "--model", "gpt-5.5"]).model, "gpt-5.5");
  assert.deepEqual(spec([...claude, "--grant-model", "claude-opus-5-5"]).models, ["claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.equal(error(args("fake", "anthropic=https://model.test@k")), "--agent fake needs --model ID");
});

test("--max-model-requests sets the run's request budget: 2000 when not given, whole numbers 1 to 100000", () => {
  assert.equal(spec(codex).maxModelRequests, 2000);
  assert.equal(spec([...codex, "--max-model-requests", "20"]).maxModelRequests, 20);
  for (const bad of ["0", "-1", "1.5", "2e3", "x", "100001"]) assert.match(error([...codex, `--max-model-requests=${bad}`]) ?? "", /--max-model-requests must be a whole number from 1 to 100000/, bad);
});
