import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENTS, agentEnv, agentNamed } from "../src/agents.ts";
import { assertPlain, kubectlPrefix } from "../src/kubectl.ts";
import { canonical, DEFAULT_LIMITS, parseAllow, parseRoute, proxyConfig } from "../src/policy.ts";

test("allowlist entries are exact DNS names and ports: no wildcards, IP literals or bad ports", () => {
  assert.deepEqual(parseAllow("Example.COM:443"), { host: "example.com", port: 443, private: false });
  assert.deepEqual(parseAllow("git.internal:8443", true), { host: "git.internal", port: 8443, private: true });
  for (const bad of ["example.com", "*.example.com:443", "1.1.1.1:443", "[::1]:443", "example.com:0", "example.com:70000", ":443", "exa mple.com:443"]) {
    assert.throws(() => parseAllow(bad), /allow/, bad);
  }
});

test("a model route is a bare origin and a plain path prefix, with the Secret holding its key", () => {
  assert.deepEqual(parseRoute("anthropic=https://api.anthropic.com/@anthropic-key"), { kind: "anthropic", origin: "https://api.anthropic.com", basePath: "", secret: "anthropic-key" });
  assert.deepEqual(parseRoute("openai=http://10.43.0.20:8080/v0@fake-key"), { kind: "openai", origin: "http://10.43.0.20:8080", basePath: "/v0", secret: "fake-key" });
  assert.deepEqual(parseRoute("anthropic=https://api.example:443/anthropic@k"), { kind: "anthropic", origin: "https://api.example", basePath: "/anthropic", secret: "k" });
  for (const bad of ["bedrock=https://x@k", "anthropic=https://user:pw@host@k", "anthropic=https://host/?key=1@k", "anthropic=ftp://host@k", "anthropic=https://host@Bad_Name", "anthropic=https://host", "anthropic=https://host/a%2Fb@k"]) {
    assert.throws(() => parseRoute(bad), /route/, bad);
  }
});

test("the proxy config has one route, the agent's, with its grant, expiry and limits", () => {
  const config = proxyConfig({ run: "abcdef012345", allow: [parseAllow("b.example:443"), parseAllow("a.example:443")], route: parseRoute("openai=https://o.test@ok"), models: ["gpt-6.1-sol", "gpt-6.1-sol"], tokenSha256: "0".repeat(64), expiresAt: 5 });
  assert.deepEqual(config.connect.allow.map((a) => a.host), ["a.example", "b.example"]);
  assert.deepEqual(config.model.routes, [{ name: "openai", origin: "https://o.test", base_path: "", header: "authorization", secret_file: "/secrets/openai/key", models: ["gpt-6.1-sol"] }]);
  assert.equal(config.expires_at, 5);
  assert.deepEqual(config.limits, DEFAULT_LIMITS);
  assert.ok(DEFAULT_LIMITS.audit_bytes < 10 * 1024 * 1024, "the audit stays under the kubelet's log rotation");
  assert.throws(() => proxyConfig({ run: "abcdef012345", allow: [], route: parseRoute("openai=https://o.test@ok"), models: [], tokenSha256: "0".repeat(64), expiresAt: 5 }), /granted model/);
  const budget = proxyConfig({ run: "abcdef012345", allow: [], route: parseRoute("openai=https://o.test@ok"), models: ["gpt-6.1-sol"], tokenSha256: "0".repeat(64), expiresAt: 5, limits: { ...DEFAULT_LIMITS, requests_total: 20 } });
  assert.equal(budget.limits.requests_total, 20);
});

test("a run without a model route gets a proxy whose model listener grants nothing, and no model in its environment", () => {
  const config = proxyConfig({ run: "abcdef012345", allow: [], route: null, models: [], tokenSha256: "0".repeat(64), expiresAt: 5 });
  assert.deepEqual(config.model.routes, []);
  assert.throws(() => proxyConfig({ run: "abcdef012345", allow: [], route: null, models: ["gpt-6.1-sol"], tokenSha256: "0".repeat(64), expiresAt: 5 }), /can't grant models/);
  const env = agentEnv(null, { proxyIp: "10.247.1.9" }, null, "t0k3n");
  assert.equal(env.BLACKSAND_MODEL_URL, undefined);
  assert.equal(env.BLACKSAND_MODEL, undefined);
  assert.equal(env.HTTPS_PROXY, "http://run:t0k3n@10.247.1.9:3128", "the allowlist still goes through its proxy");
});

test("canonical JSON doesn't depend on key order", () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("kubectl gets only plain words, so a prefix through SSH can't be turned into a shell command", () => {
  assertPlain(["exec", "-i", "-n", "blacksand-runs", "sabcdef012345", "--", "sh", "/run/blacksand/inputs/steps.sh", "export"]);
  for (const bad of ["a b", "$(id)", "x;y", "'q'", "", "a\nb", "--for=jsonpath={.x}"]) assert.throws(() => assertPlain([bad]), /plain word/, JSON.stringify(bad));
});

test("the kubectl prefix comes from BLACKSAND_KUBECTL as a JSON list, else plain kubectl", () => {
  assert.deepEqual(kubectlPrefix(undefined), ["kubectl"]);
  assert.deepEqual(kubectlPrefix('["limactl","shell","lab","sudo","k3s","kubectl"]'), ["limactl", "shell", "lab", "sudo", "k3s", "kubectl"]);
  for (const bad of ['"kubectl"', "[]", '[""]', "[1]"]) assert.throws(() => kubectlPrefix(bad), /JSON list/, bad);
});

test("agent scripts are fixed text: the prompt and model reach them only through stdin and the environment", () => {
  for (const agent of Object.values(AGENTS)) assert.match(agent.script, /exec /, agent.name);
  assert.match(AGENTS.claude.script, /claude -p .*--model "\$BLACKSAND_MODEL"/);
  assert.match(AGENTS.claude.script, /ANTHROPIC_SMALL_FAST_MODEL="\$BLACKSAND_MODEL"/, "Claude Code's own model picks are the granted model");
  assert.match(AGENTS.codex.script, /codex exec .*--model "\$BLACKSAND_MODEL" -$/m);
});

test("each agent's traffic goes to its own proxy with the run token: as the API key, and as the CONNECT password", () => {
  const env = agentEnv(AGENTS.claude.route, { proxyIp: "10.247.1.9" }, "claude-opus-5-5", "t0k3n");
  assert.equal(env.BLACKSAND_MODEL_URL, "http://10.247.1.9:8080/anthropic");
  assert.equal(env.HTTPS_PROXY, "http://run:t0k3n@10.247.1.9:3128");
  assert.equal(env.NO_PROXY, "10.247.1.9");
  assert.match(AGENTS.claude.script, /ANTHROPIC_BASE_URL="\$BLACKSAND_MODEL_URL" ANTHROPIC_API_KEY="\$BLACKSAND_RUN_TOKEN"/);
  const codex = AGENTS.codex.files({ proxyIp: "10.247.1.9" })["codex-config.toml"] ?? "";
  assert.match(codex, /base_url = "http:\/\/10\.247\.1\.9:8080\/openai\/v1"/);
  assert.match(codex, /env_key = "BLACKSAND_RUN_TOKEN"/);
  assert.equal(env.HOME, "/home/agent");
});

test("unknown agents and models are refused, including names that exist on every object", () => {
  for (const name of ["aider", "constructor", "__proto__", "toString"]) assert.throws(() => agentNamed(name), /unknown agent/, name);
  for (const model of ["", "m odel", "m;x", "$(id)", "a".repeat(200)]) assert.throws(() => agentEnv(AGENTS.fake.route, { proxyIp: "10.0.0.1" }, model, "t"), /model id/, model);
});
