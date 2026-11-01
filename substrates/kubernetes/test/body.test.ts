// The request body the proxy forwards: only what the two agents send, local
// tools only, nothing that makes the provider act, store or fetch for the run.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ANTHROPIC_BETAS, checkBetas, checkBody } from "../sandbox/proxy.ts";

/** The shape of a real Claude Code 2.1.309 request (structure as sent; texts shortened). */
const claudeCode = () => ({
  model: "claude-opus-5-5",
  max_tokens: 128000,
  stream: true,
  metadata: { user_id: '{"session_id":"s"}' },
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  output_config: { effort: "medium" },
  system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
  tools: [
    { name: "Write", description: "Write a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "DeferredToolPlaceholder", description: "d", input_schema: { type: "object" }, defer_loading: true },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "Write a file.", cache_control: { type: "ephemeral" } }] },
    { role: "system", content: "reminder", output_config: { effort: "medium" } },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/workspace/repo/x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "File created" }] },
  ],
});

/** The shape of a real Codex 0.165.0 request to gpt-5.5 with web search disabled (structure as sent; texts shortened). */
const codex = () => ({
  model: "gpt-5.5",
  stream: true,
  store: false,
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "medium" },
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "01a196dd",
  text: { verbosity: "low" },
  client_metadata: { thread_id: "t", session_id: "s" },
  tools: [
    { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object" }, strict: false },
    { type: "custom", name: "apply_patch", description: "Patch files", format: { type: "grammar" } },
    { type: "tool_search", execution: "client", description: "Search deferred tools", parameters: { type: "object" } },
  ],
  input: [
    { type: "message", id: "msg_1", role: "developer", content: [{ type: "input_text", text: "rules" }] },
    { type: "message", id: "msg_2", role: "user", content: [{ type: "input_text", text: "Write a file." }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: "{}", status: "completed" },
    { type: "function_call_output", id: "fco_1", call_id: "call_1", output: "done" },
  ],
});

/** The shape of a real Codex 0.165.0 request to gpt-6.1-sol, its default here: code mode, its tools in an additional_tools item (structure as sent; texts shortened). */
const codexSol = () => ({
  model: "gpt-6.1-sol",
  stream: true,
  store: false,
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "medium", context: "all_turns" },
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "01a1972f",
  text: { verbosity: "low" },
  client_metadata: { thread_id: "t", session_id: "s" },
  input: [
    {
      type: "additional_tools",
      id: "at_1",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: [
            { type: "custom", name: "exec", description: "Run JavaScript code to orchestrate tool calls", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
            { type: "function", name: "wait", description: "Wait", parameters: { type: "object" }, strict: false },
          ],
        },
        { type: "namespace", name: "clock", description: "", tools: [{ type: "function", name: "sleep", description: "Sleep", parameters: { type: "object" }, strict: false }] },
      ],
    },
    { type: "message", id: "msg_1", role: "developer", content: [{ type: "input_text", text: "rules" }] },
    { type: "message", id: "msg_2", role: "user", content: [{ type: "input_text", text: "Write a file." }] },
    { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "await tools.apply_patch('*** Begin Patch')", status: "completed" },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1", output: "done" },
  ],
});

const CLAUDE_BETAS = "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24";

const refused = (route: "anthropic" | "openai", body: unknown) => {
  const verdict = checkBody(route, body);
  return verdict.ok ? "accepted" : verdict.reason;
};

test("the bodies Claude Code and Codex actually send pass, and are forwarded as rebuilt", () => {
  const claude = checkBody("anthropic", claudeCode());
  assert.ok(claude.ok);
  assert.deepEqual(claude.body, claudeCode(), "nothing of Claude Code's request is changed or dropped");
  const responses = checkBody("openai", codex());
  assert.ok(responses.ok);
  assert.deepEqual(responses.body, { ...codex(), store: false, background: false });
  const sol = checkBody("openai", codexSol());
  assert.ok(sol.ok, sol.ok ? "" : sol.reason);
  assert.deepEqual(sol.body, { ...codexSol(), store: false, background: false });
  assert.equal(checkBetas("anthropic", { "anthropic-beta": CLAUDE_BETAS }), null);
  assert.equal(checkBetas("openai", {}), null);
});

test("the review's seven Responses probes are refused before the key is read: provider tools, stored state, background work, remote files", () => {
  const probes: [Record<string, unknown>, string][] = [
    [{ tools: [{ type: "web_search" }] }, "provider-tool"],
    [{ tools: [{ type: "mcp", server_label: "ungranted", server_url: "https://attacker.example/mcp", require_approval: "never" }] }, "provider-tool"],
    [{ tools: [{ type: "file_search", vector_store_ids: ["vs_other_run"] }] }, "provider-tool"],
    [{ previous_response_id: "resp_other_run", store: true }, "stored-state"],
    [{ conversation: "conv_other_run", store: true }, "stored-state"],
    [{ background: true, store: true }, "background"],
    [{ input: [{ role: "user", content: [{ type: "input_file", file_id: "file_other_run" }] }] }, "remote-input"],
  ];
  for (const [body, reason] of probes) assert.equal(refused("openai", { model: "gpt-6.1-sol", ...body }), reason, JSON.stringify(body));
});

test("Codex's own web_search tool is provider-run, so it's refused: the adapter turns it off instead", () => {
  const withSearch = codex();
  withSearch.tools.push({ type: "web_search", external_web_access: false, search_content_types: ["text", "image"] } as never);
  assert.equal(refused("openai", withSearch), "provider-tool");
});

test("tools offered in an additional_tools item or a namespace must be local too: functions and custom tools, one level deep", () => {
  const offering = (tools: unknown[], extra: Record<string, unknown> = {}) => refused("openai", { model: "gpt-6.1-sol", input: [{ type: "additional_tools", id: "at_1", role: "developer", tools, ...extra }] });
  const fn = { type: "function", name: "f", description: "", parameters: { type: "object" } };
  assert.equal(offering([fn]), "accepted");
  assert.equal(offering([{ type: "web_search" }]), "provider-tool");
  assert.equal(offering([{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" }]), "provider-tool");
  assert.equal(offering([{ type: "namespace", name: "n", description: "", tools: [{ type: "web_search" }] }]), "provider-tool");
  assert.equal(offering([{ type: "namespace", name: "n", description: "", tools: [{ type: "tool_search", execution: "server" }] }]), "provider-tool");
  assert.equal(offering([{ type: "namespace", name: "n", description: "", tools: [{ type: "namespace", name: "m", description: "", tools: [fn] }] }]), "provider-tool", "no namespace inside a namespace");
  assert.equal(offering([{ type: "namespace", name: "n", description: "", tools: [{ ...fn, server_url: "https://attacker.example" }] }]), "unsupported-field");
  assert.equal(offering([{ type: "namespace", name: "n", tools: [fn], server_url: "https://attacker.example" }]), "unsupported-field");
  assert.equal(offering([fn], { server_url: "https://attacker.example" }), "unsupported-field");
  assert.equal(offering("tools" as never), "unsupported-field");
  assert.equal(refused("openai", { model: "gpt-6.1-sol", input: "hi", tools: [{ type: "namespace", name: "n", description: "", tools: [{ type: "file_search", vector_store_ids: ["vs"] }] }] }), "provider-tool");
});

test("retention and the rest of the provider's Responses features are refused, never quietly dropped", () => {
  for (const [body, reason] of [
    [{ store: true }, "retention"],
    [{ prompt: { id: "pmpt_other" } }, "stored-state"],
    [{ input: [{ type: "item_reference", id: "msg_other" }] }, "stored-state"],
    [{ input: [{ type: "web_search_call", id: "ws_1" }] }, "provider-tool"],
    [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://attacker.example/x.png" }] }] }, "remote-input"],
    [{ input: [{ role: "user", content: [{ type: "input_file", file_url: "https://attacker.example/x.pdf" }] }] }, "remote-input"],
    [{ input: [{ type: "function_call_output", call_id: "c", output: [{ type: "input_file", file_id: "file_x" }] }] }, "remote-input"],
    [{ tools: [{ type: "tool_search", execution: "server" }] }, "provider-tool"],
    [{ tools: [{ type: "code_interpreter", container: { type: "auto" } }] }, "provider-tool"],
    [{ tool_choice: { type: "web_search" } }, "provider-tool"],
    [{ include: ["file_search_call.results"] }, "unsupported-field"],
    [{ an_unknown_field: 1 }, "unsupported-field"],
  ] as [Record<string, unknown>, string][]) {
    assert.equal(refused("openai", { model: "gpt-6.1-sol", input: "hi", ...body }), reason, JSON.stringify(body));
  }
  const inline = checkBody("openai", { model: "gpt-6.1-sol", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] });
  assert.ok(inline.ok, "an image given inline stays local");
});

test("Messages requests can't turn on MCP servers, provider tools, containers or remote documents", () => {
  const base = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  for (const [body, reason] of [
    [{ mcp_servers: [{ type: "url", url: "https://attacker.example/mcp", name: "x" }] }, "provider-tool"],
    [{ container: "container_other" }, "provider-tool"],
    [{ tools: [{ type: "web_search_20250305", name: "web_search" }] }, "provider-tool"],
    [{ tools: [{ type: "mcp_toolset", mcp_server_name: "x" }] }, "provider-tool"],
    [{ tools: [{ type: "code_execution_20250825", name: "code_execution" }] }, "provider-tool"],
    [{ messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://attacker.example/a.pdf" } }] }] }, "remote-input"],
    [{ messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file_other" } }] }] }, "remote-input"],
    [{ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "document", source: { type: "url", url: "https://x" } }] }] }] }, "remote-input"],
    [{ messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] }] }, "provider-tool"],
    [{ messages: [{ role: "assistant", content: [{ type: "web_fetch_tool_result", tool_use_id: "s" }] }] }, "provider-tool"],
    [{ an_unknown_field: 1 }, "unsupported-field"],
  ] as [Record<string, unknown>, string][]) {
    assert.equal(refused("anthropic", { ...base, ...body }), reason, JSON.stringify(body).slice(0, 80));
  }
});

test("only Claude Code's own beta features are accepted; an MCP or files beta refuses the request, and the OpenAI route takes none", () => {
  assert.equal(ANTHROPIC_BETAS.size, 8);
  assert.equal(checkBetas("anthropic", { "anthropic-beta": `${CLAUDE_BETAS},mcp-client-2025-11-20` }), "unsupported-beta");
  assert.equal(checkBetas("anthropic", { "anthropic-beta": "files-api-2025-04-14" }), "unsupported-beta");
  assert.equal(checkBetas("openai", { "openai-beta": "responses=v1" }), "unsupported-beta");
  assert.equal(checkBetas("openai", { "anthropic-beta": "claude-code-20250219" }), "unsupported-beta");
});
