// A fake model backend for native tests: it answers the Anthropic Messages
// and OpenAI Responses calls only when the request carries the credential in
// KEY_FILE, which the proxy must have added (the sandbox never holds it).
// When the agent offers a file-writing tool and hasn't used one yet, the
// first answer is one tool call that writes AGENT_WAS_HERE.md; after the
// tool's result comes back, it answers "Done.". So a real agent edits the
// repository in the sandbox, end to end, without a real model. For Codex the
// prompt can script the calls instead, in order: "APPLY_PATCH" makes two
// apply_patch calls (one creating PATCHED.md, one updating README.md), and a
// prompt ending "RUN: <command>" then runs the command. Where Codex offers
// code mode (its one `exec` tool, for gpt-6.1-sol), each call is an `exec`
// script calling the same tool.
//   node fake-model.ts KEY_FILE
// Self-contained (node:* only): it's shipped into the cluster as one file.

import { readFileSync } from "node:fs";
import * as http from "node:http";

const key = readFileSync(process.argv[2] ?? "", "utf8").trim();
export const MODEL_ID = "fake-model-20261101";

const PATCHES = [
  "*** Begin Patch\n*** Add File: PATCHED.md\n+Codex created this with apply_patch.\n*** End Patch\n",
  "*** Begin Patch\n*** Update File: README.md\n@@\n+Codex updated this with apply_patch.\n*** End Patch\n",
];

type Tool = { name?: string; type?: string; tools?: Tool[] };
type Call = { id: string; type: "function_call" | "custom_tool_call"; status: string; call_id: string; name: string; arguments?: string; input?: string };

/** Every tool offered, top-level or in additional_tools items, namespaces opened. */
const offeredTools = (request: { tools?: Tool[]; input?: unknown }): Tool[] => {
  const extra = Array.isArray(request.input) ? (request.input as { type?: string; tools?: Tool[] }[]).filter((i) => i.type === "additional_tools").flatMap((i) => i.tools ?? []) : [];
  return [...(request.tools ?? []), ...extra].flatMap((t) => (t.type === "namespace" ? (t.tools ?? []) : [t]));
};

/** The tool calls the prompt scripts, in order (see the header). Each goes as the agent offers it: a function, a custom (freeform) tool, or a code-mode script. */
function responsesCalls(body: string, offered: Tool[]): Call[] {
  const calls: Call[] = [];
  const call = (name: string, payload: { arguments: string } | { input: string }): Call => ({ id: `fc_fake_${calls.length}`, type: "input" in payload ? "custom_tool_call" : "function_call", status: "completed", call_id: `call_fake_${calls.length}`, name, ...payload });
  const codeMode = offered.some((t) => t.name === "exec" && t.type === "custom");
  const patchTool = offered.find((t) => t.name === "apply_patch");
  const patch = (text: string) => (codeMode ? call("exec", { input: `text(JSON.stringify(await tools.apply_patch(${JSON.stringify(text)})));\n` }) : patchTool?.type === "custom" ? call("apply_patch", { input: text }) : call("apply_patch", { arguments: JSON.stringify({ input: text }) }));
  const command = (cmd: string) => (codeMode ? call("exec", { input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd })})));\n` }) : call("exec_command", { arguments: JSON.stringify({ cmd }) }));
  if (body.includes("APPLY_PATCH") && (codeMode || patchTool)) for (const text of PATCHES) calls.push(patch(text));
  // The command is the rest of the prompt's JSON string, unescaped.
  const run = /RUN: ((?:[^"\\]|\\.){1,4000})"/.exec(body)?.[1];
  const scripted = body.includes("APPLY_PATCH") || run;
  if ((codeMode || offered.some((t) => t.name === "exec_command")) && (run || !scripted)) calls.push(command(run ? (JSON.parse(`"${run}"`) as string) : "printf 'Codex wrote this in the sandbox.\\n' > AGENT_WAS_HERE.md"));
  return calls;
}

const sse = (res: http.ServerResponse, events: [string, unknown][]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let request: { stream?: boolean; tools?: Tool[]; input?: unknown } = {};
      try {
        request = JSON.parse(body) as typeof request;
      } catch {}
      const path = (req.url ?? "").split("?")[0];
      const tools = offeredTools(request).map((t) => t.name ?? t.type ?? "?");
      // What the agent's tool reported back, so a test can see why a tool call failed.
      const at = Math.max(body.lastIndexOf('"function_call_output"'), body.lastIndexOf('"custom_tool_call_output"'), body.indexOf('"tool_result"'));
      const toolOutput = at < 0 ? null : body.slice(Math.max(0, at - 200), at + 400);
      const log = (status: number, answer = "text") =>
        process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), path, status, stream: Boolean(request.stream), tools, answer, tool_output: toolOutput, ...(process.env.FAKE_MODEL_BODIES ? { headers: req.headers, body: request } : {}) })}\n`);
      if (req.method === "POST" && path === "/v1/messages") {
        if (req.headers["x-api-key"] !== key) return (log(401), res.writeHead(401).end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'));
        const message = { id: "msg_fake", type: "message", role: "assistant", model: MODEL_ID, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (tools.includes("Write") && !body.includes('"tool_result"')) {
          log(200, "tool_use Write");
          const input = { file_path: "/workspace/repo/AGENT_WAS_HERE.md", content: "Claude Code wrote this in the sandbox.\n" };
          const call = { ...message, content: [{ type: "tool_use", id: "toolu_fake_1", name: "Write", input }], stop_reason: "tool_use" };
          if (!request.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(call));
          return sse(res, [
            ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fake_1", name: "Write", input: {} } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
            ["message_stop", { type: "message_stop" }],
          ]);
        }
        log(200);
        if (!request.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
        return sse(res, [
          ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }
      if (req.method === "POST" && path === "/v1/responses") {
        if (req.headers.authorization !== `Bearer ${key}`) return (log(401), res.writeHead(401).end('{"error":{"message":"bad key"}}'));
        const calls = responsesCalls(body, offeredTools(request));
        const done = (body.match(/"(?:function|custom_tool)_call_output"/g) ?? []).length;
        const call = calls[done];
        if (call) {
          log(200, `${call.type} ${call.name}`);
          const response = { id: `resp_fake_${done}`, object: "response", created_at: 0, status: "completed", model: MODEL_ID, output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
          if (!request.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
          const started = call.type === "custom_tool_call" ? { ...call, status: "in_progress", input: "" } : { ...call, status: "in_progress", arguments: "" };
          return sse(res, [
            ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
            ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: started }],
            ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: call }],
            ["response.completed", { type: "response.completed", response }],
          ]);
        }
        log(200);
        const item = { id: "msg_fake", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
        const response = { id: "resp_fake", object: "response", created_at: 0, status: "completed", model: MODEL_ID, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        if (!request.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
        return sse(res, [
          ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
          ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
          ["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_fake", output_index: 0, content_index: 0, delta: "Done." }],
          ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
          ["response.completed", { type: "response.completed", response }],
        ]);
      }
      log(404);
      res.writeHead(404).end();
    });
  })
  .listen(8080, "::");
