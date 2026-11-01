import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { AGENTS } from "../src/agents.ts";
import { runSpec } from "../src/command.ts";
import { sha256 } from "../src/policy.ts";
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

test("--agent command: --argv is one JSON list, kept whole (an argument like --json included); --input reads PATH=FILE", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-cli-"));
  fs.writeFileSync(path.join(dir, "attempt.py"), "print(1)\n");
  const base = ["--agent", "command", "--argv", '["python3","-I","inputs/attempt.py","--json"]', "--input", `attempt.py=${path.join(dir, "attempt.py")}`];
  const parsed = spec([...base, "--out", "/tmp/never-made"]);
  assert.deepEqual(parsed.command?.argv, ["python3", "-I", "inputs/attempt.py", "--json"]);
  assert.deepEqual({ ...parsed.command?.inputs }, { "attempt.py": Buffer.from("print(1)\n") });
  assert.deepEqual([parsed.repo, parsed.prompt, parsed.model, parsed.models, parsed.routes, parsed.toolsImage, parsed.key], [null, "", null, [], [], null, null]);
  const routed = spec([...base, "--route", "openai=https://api.openai.com@openai-key", "--model", "gpt-6.1-sol", "--out", "/tmp/never-made"]);
  assert.deepEqual([routed.model, routed.models], ["gpt-6.1-sol", ["gpt-6.1-sol"]]);
  // --key: the output directory is the key's receipt, under --receipts or BLACKSAND_RECEIPTS.
  const keyed = runSpec([...base, "--key", "attempt/7", "--receipts", dir]) as RunSpec;
  assert.deepEqual([keyed.out, keyed.key], [path.join(dir, sha256("attempt/7")), "attempt/7"]);
  assert.equal((runSpec([...base, "--key", "k"], { BLACKSAND_RECEIPTS: "/srv/receipts" }) as RunSpec).out, path.join("/srv/receipts", sha256("k")));
  const refusals: [string[], RegExp][] = [
    [[...base, "--key", "k", "--out", "/tmp/x"], /--key or --out, not both/],
    [[...base, "--out", "/tmp/x", "--receipts", dir], /--receipts needs --key/],
    [["--agent", "command", "--argv", "[]", "--out", "/tmp/x"], /JSON list of one or more strings/],
    [["--agent", "command", "--argv", "python3 x.py", "--out", "/tmp/x"], /JSON list/],
    [["--agent", "command", "--argv", '["a",1]', "--out", "/tmp/x"], /JSON list/],
    [["--agent", "command", "--out", "/tmp/x"], /needs --argv/],
    [[...base, "--repo", "/repo", "--out", "/tmp/x"], /not --repo or a prompt/],
    [[...base, "--model", "m", "--out", "/tmp/x"], /need a --route/],
    [[...base, "--route", "openai=https://a.test@k", "--out", "/tmp/x"], /needs --model/],
    [[...base, "--input", `attempt.py=${path.join(dir, "attempt.py")}`, "--out", "/tmp/x"], /given twice/],
    [[...base, "--input", "nofile", "--out", "/tmp/x"], /PATH=FILE/],
    [[...codex, "--argv", '["x"]'], /only --agent command/],
    [["--repo", "/repo", "--prompt", "p", "--key", "k", "--out", "/tmp/x"], /not both/],
  ];
  for (const [a, e] of refusals) assert.match(error(a) ?? "", e, a.join(" "));
  assert.equal(error(["--repo", "/repo", "--prompt", "p", "--out", "/tmp/x"]), null, "no --agent: just the usage");
  assert.equal(error(["--agent", "codex", "--repo", "/repo", "--prompt", "p"]), null, "neither --out nor --key: just the usage");
});
