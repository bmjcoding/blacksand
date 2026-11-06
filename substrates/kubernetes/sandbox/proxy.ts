// One run's egress proxy, running in its own Pod beside the run's Sandbox.
//   node proxy.ts CONFIG.json
//
// - CONNECT listener: the run token (Proxy-Authorization), then the run's
//   allowlist (exact host and port). It resolves names itself (the sandbox has
//   no DNS) and refuses non-public addresses unless the entry says that host is
//   private. No TLS interception: it sees host, port and bytes.
// - Model listener: a fixed table of provider operations. The request target
//   must be exactly /<route><operation path>[allowed query]; the backend URL is
//   the route's configured origin and base path plus that operation's path,
//   never anything taken from the request. The body must name a granted model.
//   Only then is the backend credential added.
// - Limits: concurrent tunnels and requests, a request budget, absolute
//   lifetimes, and request, response, tunnel and audit byte caps. Past its
//   expiry, or on SIGTERM, it seals: refuses new work, ends what's open,
//   writes the closing marker and exits.
// - Audit: one JSON line per event on stdout, numbered from 1. Each accepted
//   tunnel or request has an `accept` and exactly one `end` (ok, error,
//   timeout, cancel or limit); a refusal is one `deny`. Only fixed operation
//   names, validated hosts and granted model ids are logged, never payloads.
//
// Self-contained (node:* only): it's shipped into the cluster as this one file.

import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, connect, isIP, type AddressInfo, type Socket } from "node:net";
import { Transform, type Duplex, type Writable } from "node:stream";

export interface Allow {
  host: string;
  port: number;
  /** The host is meant to be on a private network (it's refused otherwise). */
  private: boolean;
}

export type RouteName = "anthropic" | "openai";

/** Key prefixes that belong to the other provider: a route never sends one. */
const FOREIGN_KEY_PREFIXES: Record<RouteName, readonly string[]> = {
  anthropic: ["sk-proj-", "sk-svcacct-", "sk-admin-"],
  openai: ["sk-ant-"],
};

export interface Route {
  name: RouteName;
  /** scheme://host[:port] and nothing else, as `new URL(x).origin` writes it. */
  origin: string;
  /** "" or a path prefix such as /anthropic, with no trailing slash. */
  base_path: string;
  /** How the backend takes its credential: `x-api-key: K` or `authorization: Bearer K`. */
  header: "x-api-key" | "authorization";
  /** File holding the backend credential, mounted into this Pod only. */
  secret_file: string;
  /** The run's grant: the only model ids a request may name. */
  models: string[];
  /** Service-only transport constraints; run defaults are unchanged. */
  private?: boolean;
  ca_file?: string | null;
}

/** One call an intranet endpoint allows: a method, a path template (`*` one segment, a last `**` the rest), and whether a query string passes. */
export interface IntranetOperation {
  id: string;
  method: string;
  path: string;
  query: boolean;
  /** Closed JSON fields and value restrictions, checked before reading credentials. */
  body?: JsonGrant;
}

export interface IntranetEndpoint {
  name: string;
  /** scheme://host[:port], as for a route: https in a run (the tests use http on loopback). */
  origin: string;
  base_path: string;
  private: boolean;
  ca_file: string | null;
  auth: { kind: "public" } | { kind: "bearer"; token_file: string; audience: string; issuer: string; subject: string; scopes: string[] }
    | { kind: "oidc"; client_id: string; client_secret_file: string; redirect_uri: string };
  operations: IntranetOperation[];
}

/** A deliberately small JSON boundary; the receiver still authorizes every operation. */
export interface JsonGrant {
  fields: string[];
  required: string[];
  values: Record<string, string[]>;
  prefixes: Record<string, string>;
}

export interface Limits {
  tunnels: number;
  requests_inflight: number;
  requests_total: number;
  request_bytes: number;
  response_bytes: number;
  tunnel_bytes: number;
  tunnel_seconds: number;
  request_seconds: number;
  audit_bytes: number;
}

export interface ProxyConfig {
  run: string;
  /** Milliseconds since the epoch: from then the token is refused and the proxy seals. */
  expires_at: number;
  token_sha256: string;
  limits: Limits;
  connect: { port: number; allow: Allow[] };
  model: { port: number; routes: Route[] };
  intranet?: { endpoints: IntranetEndpoint[] };
}

/** The provider operations a grant can cover, one per route: method, path and the query strings accepted with it. */
export const OPERATIONS: Record<RouteName, { op: string; method: string; path: string; queries: readonly string[] }> = {
  anthropic: { op: "anthropic.messages", method: "POST", path: "/v1/messages", queries: ["", "?beta=true"] },
  openai: { op: "openai.responses", method: "POST", path: "/v1/responses", queries: [""] },
};

export type Result = "ok" | "error" | "timeout" | "cancel" | "limit";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
// Plain segments only: no empty, "." or ".." segment can move the path.
const BASE_PATH = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)*$/;
/** Request headers passed to the backend; every other one, credentials and provider org/project selectors included, is dropped. */
const FORWARDED = ["content-type", "accept", "user-agent", "anthropic-version", "anthropic-beta"];
/**
 * The Anthropic beta features a request may turn on: the ones Claude Code
 * 2.1.309 sends, none of which runs anything on the provider's side. Any other
 * beta (an MCP connector, files, code execution) refuses the request. Codex
 * sends no beta header, so the OpenAI route accepts none.
 */
export const ANTHROPIC_BETAS = new Set([
  "claude-code-20250219", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27",
  "per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "advanced-tool-use-2025-11-20", "effort-2025-11-24",
]);

// ---- The request body: checked field by field and rebuilt before the key is read ----
//
// A grant names an operation and models, but a body can still ask the provider
// to act for the run: search the web, call an MCP server, read stored files,
// continue someone else's conversation, keep working after the run. Those all
// run on the provider's side, out of reach of the allowlist and the audit. So
// each route accepts only the fields and content the two agents actually send,
// with local tools only, refuses everything else by name of its class (never
// dropping it silently), and forwards a body rebuilt from what it checked.

export type BodyVerdict = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; reason: string };

class Refusal extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
const refuseBody = (reason: string): never => {
  throw new Refusal(reason);
};
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (v: Json, allowed: ReadonlySet<string>, reason = "unsupported-field") => {
  for (const key of Object.keys(v)) if (!allowed.has(key)) refuseBody(reason);
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : refuseBody("unsupported-field"));

const MESSAGES_TOP = new Set(["model", "max_tokens", "messages", "system", "tools", "tool_choice", "metadata", "stream", "temperature", "top_p", "top_k", "stop_sequences", "thinking", "context_management", "output_config"]);
const MESSAGES_PROVIDER = new Set(["mcp_servers", "container"]);
const MESSAGES_TOOL = new Set(["name", "description", "input_schema", "cache_control", "defer_loading", "type"]);
/** Content a Messages request may carry: text, tool calls and results, thinking, and images or documents given inline. */
const MESSAGES_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result", "tool_reference", "thinking", "redacted_thinking"]);
/** Content only the provider's own tools produce: it means a provider tool ran, or is being asked to. */
const MESSAGES_PROVIDER_BLOCKS = /^(server_tool_use|mcp_tool_use|mcp_tool_result|container_upload|.*_tool_result)$/;

function messagesBlock(block: unknown): void {
  if (typeof block === "string") return;
  if (!isObject(block) || typeof block.type !== "string") return refuseBody("unsupported-content");
  if (block.type === "tool_result") return void (typeof block.content === "string" || block.content === undefined || list(block.content).forEach(messagesBlock));
  if (MESSAGES_PROVIDER_BLOCKS.test(block.type)) return refuseBody("provider-tool");
  if (!MESSAGES_BLOCKS.has(block.type)) return refuseBody("unsupported-content");
  if (block.type === "image" || block.type === "document") {
    const source = block.source;
    if (!isObject(source) || !["base64", "text", "content"].includes(String(source.type))) return refuseBody("remote-input"); // url and file sources make the provider fetch
    if (source.type === "content") list(source.content).forEach(messagesBlock);
  }
}

function checkMessages(body: Json): Json {
  for (const key of Object.keys(body)) if (MESSAGES_PROVIDER.has(key)) refuseBody("provider-tool");
  onlyKeys(body, MESSAGES_TOP);
  for (const tool of body.tools === undefined ? [] : list(body.tools)) {
    if (!isObject(tool)) return refuseBody("unsupported-field");
    if (tool.type !== undefined && tool.type !== "custom") return refuseBody("provider-tool"); // web search, code execution, MCP toolsets, server-side tool search
    onlyKeys(tool, MESSAGES_TOOL);
  }
  if (body.tool_choice !== undefined && (!isObject(body.tool_choice) || !["auto", "any", "tool", "none"].includes(String(body.tool_choice.type)))) refuseBody("unsupported-field");
  if (body.context_management !== undefined) {
    if (!isObject(body.context_management)) return refuseBody("unsupported-field");
    onlyKeys(body.context_management, new Set(["edits"]));
    for (const edit of list(body.context_management.edits ?? [])) if (!isObject(edit) || !/^clear_/.test(String(edit.type))) refuseBody("unsupported-field");
  }
  if (typeof body.system !== "string" && body.system !== undefined) list(body.system).forEach(messagesBlock);
  for (const message of body.messages === undefined ? [] : list(body.messages)) {
    if (!isObject(message) || !["user", "assistant", "system"].includes(String(message.role))) return refuseBody("unsupported-content");
    onlyKeys(message, new Set(["role", "content", "output_config"]));
    if (typeof message.content !== "string") list(message.content).forEach(messagesBlock);
  }
  return body;
}

const RESPONSES_TOP = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream", "include", "prompt_cache_key", "text", "client_metadata", "metadata", "max_output_tokens", "temperature", "top_p", "truncation", "service_tier", "user", "safety_identifier", "background"]);
const RESPONSES_STATE = new Set(["previous_response_id", "conversation", "prompt"]);
const RESPONSES_INCLUDE = new Set(["reasoning.encrypted_content"]);
/** Input items a Responses request may carry: messages, the run's own local tool calls and results, its reasoning, and more local tools (additional_tools: how Codex offers its tools to gpt-6.1-sol). */
const RESPONSES_ITEMS = new Set(["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning", "tool_search_call", "tool_search_output", "additional_tools"]);
const RESPONSES_PROVIDER_ITEMS = /(^|_)(web_search|file_search|mcp|code_interpreter|image_generation|computer|local_shell|shell)(_|$)/;
const RESPONSES_PARTS = new Set(["input_text", "output_text", "refusal", "input_image", "input_file", "summary_text", "reasoning_text"]);

/** A local tool: a function or a custom tool, tool search the client itself runs, or a namespace of functions and custom tools. Every provider-run tool is refused. */
function localTool(tool: unknown, nested = false): void {
  if (!isObject(tool)) return refuseBody("unsupported-field");
  if (tool.type === "namespace" && !nested) {
    onlyKeys(tool, new Set(["type", "name", "description", "tools"]));
    for (const inner of list(tool.tools)) {
      if (!isObject(inner) || !["function", "custom"].includes(String(inner.type))) return refuseBody("provider-tool");
      localTool(inner, true);
    }
    return;
  }
  if (tool.type === "function") return onlyKeys(tool, new Set(["type", "name", "description", "parameters", "strict", "defer_loading"]));
  if (tool.type === "custom") return onlyKeys(tool, new Set(["type", "name", "description", "format", "defer_loading"]));
  if (tool.type === "tool_search" && tool.execution === "client") return onlyKeys(tool, new Set(["type", "execution", "description", "parameters"]));
  refuseBody("provider-tool");
}

function responsesPart(part: unknown): void {
  if (typeof part === "string") return;
  if (!isObject(part) || !RESPONSES_PARTS.has(String(part.type))) return refuseBody("unsupported-content");
  if (part.file_id !== undefined || part.file_url !== undefined) return refuseBody("remote-input"); // files stored with the provider, or fetched by it
  if (part.type === "input_image" && (typeof part.image_url !== "string" || !part.image_url.startsWith("data:"))) refuseBody("remote-input");
}

function checkResponses(body: Json): Json {
  for (const key of Object.keys(body)) if (RESPONSES_STATE.has(key)) refuseBody("stored-state"); // another response, conversation or stored prompt
  onlyKeys(body, RESPONSES_TOP);
  if (body.background !== undefined && body.background !== false) refuseBody("background");
  if (body.store !== undefined && body.store !== false) refuseBody("retention");
  for (const item of body.include === undefined ? [] : list(body.include)) if (!RESPONSES_INCLUDE.has(String(item))) refuseBody("unsupported-field");
  for (const tool of body.tools === undefined ? [] : list(body.tools)) localTool(tool);
  const choice = body.tool_choice;
  if (choice !== undefined && !["auto", "none", "required"].includes(String(choice)) && !(isObject(choice) && ["function", "custom"].includes(String(choice.type)))) refuseBody("provider-tool");
  if (typeof body.input !== "string") {
    for (const item of body.input === undefined ? [] : list(body.input)) {
      if (!isObject(item)) return refuseBody("unsupported-content");
      const type = item.type === undefined && item.role !== undefined ? "message" : String(item.type);
      if (type === "item_reference") return refuseBody("stored-state");
      if (RESPONSES_PROVIDER_ITEMS.test(type)) return refuseBody("provider-tool");
      if (!RESPONSES_ITEMS.has(type)) return refuseBody("unsupported-content");
      if (type === "additional_tools") {
        onlyKeys(item, new Set(["type", "id", "role", "tools"]));
        for (const tool of list(item.tools)) localTool(tool);
      }
      for (const field of ["content", "output", "summary"]) if (Array.isArray(item[field])) (item[field] as unknown[]).forEach(responsesPart);
    }
  }
  return { ...body, store: false, background: false };
}

/** The checked, rebuilt body for a route, or the refusal and its fixed reason. */
export function checkBody(route: RouteName, body: unknown): BodyVerdict {
  try {
    if (!isObject(body)) return { ok: false, status: 400, reason: "not-an-object" };
    return { ok: true, body: route === "anthropic" ? checkMessages(body) : checkResponses(body) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, status: 403, reason: error.reason };
    throw error;
  }
}

/** Beta headers: Anthropic's from the list above, OpenAI's none. Null when they're fine, else the refusal reason. */
export function checkBetas(route: RouteName, headers: http.IncomingHttpHeaders): string | null {
  if (headers["openai-beta"] !== undefined) return "unsupported-beta";
  const betas = headers["anthropic-beta"];
  if (betas === undefined) return null;
  if (route !== "anthropic" || typeof betas !== "string") return "unsupported-beta";
  return betas.split(",").every((b) => ANTHROPIC_BETAS.has(b.trim())) ? null : "unsupported-beta";
}

// One list per family: a single BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so ::ffff:0:0/96 would block every IPv4 address.
const NON_PUBLIC_V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_V4.addSubnet(net, bits, "ipv4");
// IPv6, including the forms that embed an IPv4 address (mapped, NAT64, 6to4, Teredo).
const NON_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_V6.addSubnet(net, bits, "ipv6");

export function isPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC_V6.check(address, "ipv6");
  return false;
}

/** `host:port` or `[v6]:port` from a CONNECT request, host lowercased; null if malformed. */
export function parseAuthority(text: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]{1,253})):([0-9]{1,5})$/.exec(text);
  if (!m) return null;
  const host = (m[1] ?? m[2] ?? "").toLowerCase().replace(/\.$/, "");
  const port = Number(m[3]);
  return host && port >= 1 && port <= 65535 ? { host, port } : null;
}

/** The route and operation a request target names, compared as exact strings: nothing in it is ever resolved as a URL. */
export function matchOperation(target: string, routes: readonly Route[]): { route: Route; query: string } | null {
  for (const route of routes) {
    const op = OPERATIONS[route.name];
    for (const query of op.queries) if (target === `/${route.name}${op.path}${query}`) return { route, query };
  }
  return null;
}

/** The backend URL for an operation, from the configured origin and paths only. Throws rather than leave that origin. */
export function backendUrl(route: Route, query: string): URL {
  const url = new URL(route.origin);
  if (url.origin !== route.origin || url.username || url.password || !BASE_PATH.test(route.base_path)) throw new Error("route isn't a bare origin and plain base path");
  url.pathname = `${route.base_path}${OPERATIONS[route.name].path}`;
  url.search = query;
  if (url.origin !== route.origin || !url.href.startsWith(`${route.origin}/`)) throw new Error("backend URL left the configured origin");
  return url;
}

// ---- Intranet targets: an endpoint, a path of plain segments, a query ----
//
// A segment is plain RFC 3986 pchar characters: no "." or ".." segment, no
// empty one but a trailing slash, no ";" (servlet servers drop path
// parameters, so "..;" reads as ".."), and no percent-encoding at all. Any
// escape is something a server, or a proxy in front of it, decodes before it
// routes ("%3b", "%2e", "%2f", "%25"…), so the path it acts on wouldn't be the
// one checked here. A path that needs one isn't supported. The query is RFC
// 3986 query characters, escapes included: what it means is the endpoint's.
const SEGMENT = "(?!\\.\\.?(?:[/?]|$))[A-Za-z0-9._~!$&'()*+,=:@-]+";
const INTRANET_TARGET = new RegExp(`^/intranet/([a-z][a-z0-9-]{0,30})((?:/${SEGMENT})+/?|/)(?:\\?((?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*))?$`);

/** The endpoint, path and query (null without a "?") an intranet request target names; null unless it has exactly that form. */
export function intranetTarget(target: string): { name: string; path: string; query: string | null } | null {
  const m = INTRANET_TARGET.exec(target);
  return m ? { name: m[1] ?? "", path: m[2] ?? "", query: m[3] ?? null } : null;
}

/** Whether a checked path fits a template: literal segments, `*` one non-empty segment, a last `**` whatever remains; a trailing slash is literal. */
export function matchTemplate(template: string, path: string): boolean {
  const want = template.split("/");
  const got = path.split("/");
  for (const [i, part] of want.entries()) {
    if (part === "**" && i === want.length - 1) return true;
    if (i >= got.length || (part === "*" ? got[i] === "" : part !== got[i])) return false;
  }
  return want.length === got.length;
}

/** The backend URL for an intranet call: the endpoint's configured origin and base path, then the checked path and query. */
export const intranetUrl = (endpoint: IntranetEndpoint, path: string, query: string | null): URL => {
  const url = new URL(endpoint.origin);
  const expected = `${endpoint.base_path}${path}`;
  url.pathname = expected;
  url.search = query === null ? "" : `?${query}`;
  if (url.protocol !== "https:" || url.origin !== endpoint.origin || url.pathname !== expected || !BASE_PATH.test(endpoint.base_path)) throw new Error("invalid-backend");
  return url;
};

// ---- The user's token: never verified here (the endpoint does that), only checked to be worth sending ----

/** A JWT's claims: three base64url parts, the middle one a JSON object. Null for anything else. */
export function jwtClaims(token: string): Json | null {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return isObject(claims) ? claims : null;
  } catch {
    return null;
  }
}
/** `exp` in milliseconds, when it's a number of seconds a Date can hold; else null. */
export const expiresMs = (claims: Json): number | null => (typeof claims.exp === "number" && claims.exp > 0 && claims.exp < 253_402_300_800 ? claims.exp * 1000 : null);
/** Whether `aud`, a string or a list, names exactly this audience. */
export const forAudience = (claims: Json, audience: string): boolean => (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience);
/** A claim fit to log or record: printable ASCII, 1 to 256 characters; else null. */
export const claimText = (value: unknown): string | null => (typeof value === "string" && /^[\x20-\x7e]{1,256}$/.test(value) ? value : null);

/** Resolve once, check every answer, and hand the numeric address to TLS while
 * keeping the configured URL hostname for certificate verification and SNI. */
function checkedLookup(privateAllowed: boolean): NonNullable<https.RequestOptions["lookup"]> {
  return (hostname, options, callback) => {
    void lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!addresses.length || (!privateAllowed && !addresses.every((a) => isPublic(a.address)))) return callback(new Error("non-public-address"), "", 4);
      const selected = addresses.find((a) => a.family === 4) ?? addresses[0]!;
      if (typeof options === "object" && options.all) callback(null, [{ address: selected.address, family: selected.family }]);
      else callback(null, selected.address, selected.family);
    }, () => callback(new Error("no-address"), "", 4));
  };
}

function grantedJson(value: Json, grant: JsonGrant): boolean {
  return Object.keys(value).every((k) => grant.fields.includes(k)) && grant.required.every((k) => Object.hasOwn(value, k))
    && Object.entries(grant.values).every(([k, choices]) => typeof value[k] === "string" && choices.includes(value[k]))
    && Object.entries(grant.prefixes).every(([k, prefix]) => typeof value[k] === "string" && value[k].startsWith(prefix) && /^[A-Za-z0-9._/-]{1,256}$/.test(value[k]) && !value[k].split("/").some((p) => p === "." || p === ".." || p === ""));
}
const exactAudience = (claims: Json, audience: string) => claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === audience);
const formComponent = (text: string) => new URLSearchParams({ v: text }).toString().slice(2);
const tlsHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
function readBoundedSecret(file: string, max: number): string {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > max) throw new Error("credential-unusable");
  const buffer = readFileSync(file);
  const text = buffer.toString("utf8").trim();
  if (buffer.length > max || !/^[\x21-\x7e]+$/.test(text)) throw new Error("credential-unusable");
  return text;
}
// Hex case varies only inside an encoded triplet; the credential's literal
// letters (including text after an encoded percent sign) remain case-sensitive.
function percentSpellings(secret: string): RegExp[] {
  return [encodeURIComponent(secret), formComponent(secret)].map((value) => new RegExp(value
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%[0-9A-F]{2}/g, (triplet) => triplet.replace(/[A-F]/g, (hex) => `[${hex}${hex.toLowerCase()}]`))));
}
// Streaming model replies keep only a bounded possible-credential suffix.
// JSON can spell each ASCII byte as six bytes (\u00XX). Normalize escapes
// across chunks for matching, while forwarding only the original checked bytes.
function credentialScan(secret: string): Transform {
  const values = [secret, encodeURIComponent(secret), formComponent(secret), Buffer.from(secret).toString("base64")];
  const needles = values.map((s) => Buffer.from(s));
  const percent = percentSpellings(secret);
  const longest = Math.max(...needles.map((n) => n.length));
  const keep = longest * 6 + 5;
  const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  let held = Buffer.alloc(0);
  let escaped = "";
  let tail = "";
  const reflected = (text: string, final = false) => {
    let decoded = "";
    for (const ch of text) {
      if (!escaped) {
        if (ch === "\\") escaped = ch;
        else decoded += ch;
      } else if (escaped === "\\") {
        if (ch === "u") escaped += ch;
        else { decoded += escapes[ch] ?? `\\${ch}`; escaped = ""; }
      } else if (/^[0-9a-f]$/i.test(ch)) {
        escaped += ch;
        if (escaped.length === 6) { decoded += String.fromCharCode(parseInt(escaped.slice(2), 16)); escaped = ""; }
      } else {
        decoded += escaped;
        escaped = ch === "\\" ? ch : "";
        if (!escaped) decoded += ch;
      }
    }
    if (final) { decoded += escaped; escaped = ""; }
    const joined = tail + decoded;
    if (values.some((v) => joined.includes(v)) || percent.some((pattern) => pattern.test(joined))) return true;
    tail = joined.slice(Math.max(0, joined.length - longest + 1));
    return false;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const joined = Buffer.concat([held, chunk]);
      const raw = joined.toString("latin1");
      if (needles.some((n) => joined.includes(n)) || percent.some((pattern) => pattern.test(raw)) || reflected(chunk.toString("latin1"))) return done(new Error("credential-reflected"));
      const at = Math.max(0, joined.length - keep);
      held = joined.subarray(at);
      done(null, joined.subarray(0, at));
    },
    flush(done) { if (reflected("", true)) return done(new Error("credential-reflected")); done(null, held); },
  });
}
function reflects(text: string, secrets: string[]): boolean {
  return secrets.some((s) => [s, JSON.stringify(s).slice(1, -1)].some((v) => text.includes(v)) || percentSpellings(s).some((pattern) => pattern.test(text)));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** The run token: x-api-key or Authorization: Bearer on the model listener, Proxy-Authorization: Basic (any user) on CONNECT. */
function presentedToken(req: http.IncomingMessage, listener: "model" | "connect"): string | null {
  if (listener === "connect") {
    const basic = /^Basic ([A-Za-z0-9+/=]{1,700})$/.exec(req.headers["proxy-authorization"] ?? "")?.[1];
    if (!basic) return null;
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    return decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : null;
  }
  const key = req.headers["x-api-key"];
  if (typeof key === "string") return key;
  return /^Bearer (\S{1,512})$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
}

export interface ProxyOptions {
  host?: string;
  /** Where audit lines go (stdout in the cluster). */
  out?: Writable;
  now?: () => number;
  /** Called once the closing marker is written. */
  onSealed?: () => void;
  /** Service mode uses this synchronous durable sink, never stdout. A throw closes admission. */
  record?: (line: string) => void;
  service?: { authority: string; tls: { key: Buffer; cert: Buffer }; context: Record<string, unknown> };

}

export async function startProxy(config: ProxyConfig, options: ProxyOptions = {}) {
  const host = options.host ?? "::";
  const out = options.out ?? process.stdout;
  const now = options.now ?? Date.now;
  const limits = config.limits;
  const expected = Buffer.from(config.token_sha256, "hex");
  const tokenOk = (token: string | null) => token !== null && timingSafeEqual(sha256(token), expected);

  // The audit: numbered lines, a byte budget with room kept for the closing
  // marker, and no new work while the output can't keep up.
  const ENTRY_MAX = 600;
  let auditFailed = false;
  let seq = 0;
  let auditBytes = 0;
  let auditFull = false;
  let unlogged = 0;
  let waiting = false;
  const write = (entry: Record<string, unknown>) => {
    const line = `${JSON.stringify({ seq: ++seq, t: new Date(now()).toISOString(), run: config.run, ...entry })}\n`;
    auditBytes += Buffer.byteLength(line);
    if (options.record) {
      try { options.record(line); } catch { auditFailed = true; queueMicrotask(() => void seal("audit-failed")); }
      return;
    }
    if (!out.write(line) && !waiting) {
      waiting = true;
      out.once("drain", () => (waiting = false));
    }
  };
  const log = (entry: Record<string, unknown>) => {
    if (auditFailed) return;
    if (auditFull) { unlogged++; return; }
    if (auditBytes + 2 * ENTRY_MAX > limits.audit_bytes) {
      auditFull = true;
      write({ event: "audit-full" });
      if (options.service) queueMicrotask(() => void seal("audit-full"));
    } else write(entry);
  };

  let ids = 0;
  let requestsTotal = 0;
  let sealing: Promise<void> | null = null;
  const inUse = { connect: 0, model: 0 };
  const active = new Map<number, () => void>();
  /** Why new work is refused right now, or null. */
  const closedReason = () => (sealing ? "sealed" : now() >= config.expires_at ? "expired" : auditFailed ? "audit-failed" : auditFull ? "audit-full" : waiting ? "audit-backpressure" : null);

  /** One admitted unit of work. `end` logs its one terminal result and frees its slot, however it finishes; `drop` frees a slot never used. */
  function admit(kind: "connect" | "model", id: number) {
    inUse[kind]++;
    let done = false;
    const free = () => {
      if (done) return false;
      done = true;
      inUse[kind]--;
      active.delete(id);
      return true;
    };
    return {
      drop: free,
      /** Starts the tracked part: `cleanup` runs on any ending but ok. */
      accept(base: Record<string, unknown>, cleanup: () => void) {
        log({ ...base, id, event: "accept" });
        const end = (result: Result, extra: Record<string, unknown> = {}) => {
          if (!free()) return;
          log({ ...base, id, event: "end", result, ...extra });
          if (result !== "ok") cleanup();
        };
        active.set(id, () => end("cancel"));
        if (auditFailed || auditFull) end("error");
        return end;
      },
    };
  }

  const tunnel = http.createServer((_req, res) => res.writeHead(405, { allow: "CONNECT" }).end());
  tunnel.maxConnections = limits.tunnels * 2;
  tunnel.on("drop", () => log({ kind: "connect", op: "connect", id: ++ids, event: "deny", reason: "too-many-connections", status: 0 }));
  tunnel.on("connect", async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const id = ++ids;
    const target = parseAuthority(req.url ?? "");
    const base: Record<string, unknown> = { kind: "connect", op: "connect", ...(target ? { authority: `${target.host}:${target.port}` } : {}) };
    client.on("error", () => client.destroy());
    const deny = (reason: string, status: number) => {
      log({ ...base, id, event: "deny", reason, status });
      const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="blacksand"\r\n' : "";
      client.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${challenge}Content-Length: 0\r\n\r\n`, () => client.destroy());
    };
    const closed = closedReason();
    if (closed) return deny(closed, 503);
    if (!target) return deny("malformed", 400);
    if (!tokenOk(presentedToken(req, "connect"))) return deny("bad-run-token", 407);
    const allow = config.connect.allow.find((a) => a.host === target.host && a.port === target.port);
    if (!allow) return deny("not-allowlisted", 403);
    if (inUse.connect >= limits.tunnels) return deny("too-many-tunnels", 503);
    const slot = admit("connect", id);
    const refuse = (reason: string, status: number) => (slot.drop(), deny(reason, status));
    let addresses: string[];
    try {
      addresses = isIP(target.host) ? [target.host] : (await lookup(target.host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return refuse("no-address", 502);
    }
    if (!allow.private && !addresses.every(isPublic)) return refuse("non-public-address", 403);
    // Connect only to addresses that were checked, never a second lookup's answer; IPv4 first, then the rest in turn.
    let upstream: Socket | null = null;
    for (const address of [...addresses.filter((a) => isIP(a) === 4), ...addresses.filter((a) => isIP(a) === 6)]) {
      upstream = await open(address, target.port).catch(() => null);
      if (upstream) {
        base.address = address;
        break;
      }
    }
    if (!upstream) return refuse("upstream-unreachable", 502);
    const socket = upstream;
    if (client.destroyed || sealing) return void (socket.destroy(), slot.drop()); // the client gave up, or the proxy sealed, while this connected
    const started = now();
    const end = slot.accept(base, () => (socket.destroy(), client.destroy()));
    const finish = (result: Result) => () => {
      clearTimeout(lifetime);
      end(result, { bytes_up: socket.bytesWritten, bytes_down: socket.bytesRead, ms: now() - started });
    };
    const lifetime = setTimeout(finish("timeout"), limits.tunnel_seconds * 1000);
    socket.setTimeout(300_000, finish("timeout"));
    const capped = () => socket.bytesRead + socket.bytesWritten > limits.tunnel_bytes && finish("limit")();
    socket.on("data", capped);
    client.on("data", capped);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.write(head);
    client.pipe(socket).pipe(client);
    socket.on("error", finish("error"));
    socket.once("close", finish("ok"));
    client.once("close", () => (socket.destroy(), finish("ok")()));
  });

  const handle: http.RequestListener = (req, res) => {
    if (options.service && (req.headers.host !== options.service.authority || req.headersDistinct.host?.length !== 1)) {
      log({ kind: "intranet", op: "unknown", id: ++ids, event: "deny", reason: "bad-host", status: 400 });
      return void res.writeHead(400, { connection: "close" }).end();
    }
    if ((req.url ?? "").startsWith("/intranet/")) return intranet(req, res);

    const id = ++ids;
    const matched = matchOperation(req.url ?? "", config.model.routes);
    const op = matched ? OPERATIONS[matched.route.name] : null;
    const base: Record<string, unknown> = { kind: "model", op: op?.op ?? "unknown" };
    const deny = (status: number, reason: string) => {
      log({ ...base, id, event: "deny", reason, status });
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: { type: "blacksand_proxy", message: reason } }));
    };
    const closed = closedReason();
    if (closed) return deny(503, closed);
    if (!(req.url ?? "").startsWith("/")) return deny(400, "bad-target");
    if (!matched || !op) return deny(404, "unknown-operation");
    if (req.method !== op.method) return deny(405, "method-not-allowed");
    if (!tokenOk(presentedToken(req, "model"))) return deny(401, "bad-run-token");
    if (inUse.model >= limits.requests_inflight) return deny(503, "too-many-requests");
    if (requestsTotal >= limits.requests_total) return deny(429, "request-budget-spent");
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return deny(415, "not-json");
    requestsTotal++;
    const slot = admit("model", id);
    const refuse = (status: number, reason: string) => (slot.drop(), deny(status, reason));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      const was = size;
      size += chunk.length;
      if (size <= limits.request_bytes) return void chunks.push(chunk);
      if (was <= limits.request_bytes) refuse(413, "request-too-large");
      req.destroy();
    });
    req.on("error", () => slot.drop());
    req.on("close", () => void (req.complete || slot.drop())); // the client went away mid-body
    req.on("end", () => {
      if (size > limits.request_bytes) return;
      if (sealing) return refuse(503, "sealed");
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return refuse(400, "bad-json");
      }
      const requested = isObject(parsed) ? parsed.model : undefined;
      if (typeof requested !== "string" || !matched.route.models.includes(requested)) return refuse(403, "model-not-granted");
      const beta = checkBetas(matched.route.name, req.headers);
      if (beta) return refuse(403, beta);
      const checked = checkBody(matched.route.name, parsed);
      if (!checked.ok) return refuse(checked.status, checked.reason);
      // What goes on is the checked object, serialised again: never the client's bytes, so no duplicate key or odd encoding reads differently upstream.
      const body = Buffer.from(JSON.stringify(checked.body));
      let target: URL;
      let credential: string;
      try {
        target = backendUrl(matched.route, matched.query);
        credential = options.service ? readBoundedSecret(matched.route.secret_file, 4096) : readFileSync(matched.route.secret_file, "utf8").trim();
        if (options.service && isIP(tlsHost(target)) && !matched.route.private && !isPublic(tlsHost(target))) return refuse(403, "non-public-address");
      } catch {
        return refuse(502, "no-backend");
      }
      // A key in another provider's format was put in the wrong Secret: sending it would hand it to the wrong company.
      if (FOREIGN_KEY_PREFIXES[matched.route.name].some((prefix) => credential.startsWith(prefix))) return refuse(502, "key-for-another-provider");
      const headers: http.OutgoingHttpHeaders = { host: target.host, "content-length": body.length, "accept-encoding": "identity" };
      for (const name of FORWARDED) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
      headers[matched.route.header] = matched.route.header === "authorization" ? `Bearer ${credential}` : credential;
      const started = now();
      let bytesDown = 0;
      let returned: string | null = null;
      let sniffed = "";
      let transport: https.RequestOptions = {};
      try {
        if (options.service) transport = { lookup: checkedLookup(matched.route.private === true), ...(matched.route.ca_file ? { ca: readFileSync(matched.route.ca_file) } : {}) };
      } catch { return refuse(502, "no-backend"); }
      const upstream = (target.protocol === "https:" ? https : http).request(target, { method: op.method, headers, ...transport, agent: false });
      const end = slot.accept({ ...base, model: requested, destination: target.origin }, () => (upstream.destroy(), res.destroy()));
      const finish = (result: Result, status: number | null = null) => {
        clearTimeout(lifetime);
        end(result, { status, returned_model: returned, bytes_up: body.length, bytes_down: bytesDown, ms: now() - started });
      };
      const lifetime = setTimeout(() => finish("timeout"), limits.request_seconds * 1000);
      upstream.on("response", (answer) => {
        const back: http.OutgoingHttpHeaders = {};
        for (const name of ["content-type", "request-id", "x-request-id"]) if (answer.headers[name] !== undefined) back[name] = answer.headers[name];
        if (options.service && (!/^(identity)?$/i.test(String(answer.headers["content-encoding"] ?? "")) || !/^(chunked)?$/i.test(String(answer.headers["transfer-encoding"] ?? "")) || /charset/i.test(String(answer.headers["content-type"] ?? "")) && !/;\s*charset\s*=\s*"?utf-8"?\s*(;|$)/i.test(String(answer.headers["content-type"])))) return finish("error", answer.statusCode ?? null);
        if (options.service && ((answer.statusCode ?? 502) >= 300 && (answer.statusCode ?? 502) < 400 || reflects(JSON.stringify(back), [credential]))) return finish("error", answer.statusCode ?? null);
        res.writeHead(answer.statusCode ?? 502, back);
        answer.on("data", (chunk: Buffer) => {
          bytesDown += chunk.length;
          if (bytesDown > limits.response_bytes) return finish("limit", answer.statusCode ?? null);
        });
        const sample = (chunk: Buffer) => {
          if (sniffed.length < 65_536) {
            sniffed += chunk.subarray(0, 65_536 - sniffed.length).toString("latin1");
            const named = /"model"\s*:\s*"([^"\\]{1,128})"/.exec(sniffed)?.[1];
            if (named && MODEL_ID.test(named)) returned = named;
          }
        };
        if (options.service) {
          const scan = credentialScan(credential);
          scan.on("data", sample);
          scan.on("error", () => finish("error"));
          answer.pipe(scan).pipe(res);
          scan.on("end", () => finish("ok", answer.statusCode ?? null));
        } else {
          answer.on("data", sample);
          answer.pipe(res);
          answer.on("end", () => finish("ok", answer.statusCode ?? null));
        }
        answer.on("error", () => finish("error", answer.statusCode ?? null));
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end('{"error":{"type":"blacksand_proxy","message":"upstream"}}');
        finish("error");
      });
      res.once("close", () => finish("cancel")); // after a finished response the end is already logged, so this does nothing
      if (auditFailed || auditFull) return void upstream.destroy();
      upstream.end(body);
    });
  };
  const model = options.service ? https.createServer({ ...options.service.tls, minVersion: "TLSv1.2", handshakeTimeout: 5000 }, handle) : http.createServer(handle);
  // Shared terminating route: the configured operation chooses the upstream;
  // caller headers, credentials and unvalidated bodies never choose authority.
  function intranet(req: http.IncomingMessage, res: http.ServerResponse) {
    const id = ++ids;
    const target = intranetTarget(req.url ?? "");
    const endpoint = config.intranet?.endpoints.find((e) => e.name === target?.name);
    const op = target && endpoint?.operations.find((o) => o.method === req.method && matchTemplate(o.path, target.path) && (target.query === null || o.query));
    const base = { kind: "intranet", op: endpoint && op ? `${endpoint.name}.${op.id}` : "unknown" };
    const deny = (status: number, reason: string) => {
      log({ ...base, id, event: "deny", status, reason });
      if (!res.destroyed) res.writeHead(status, { "content-type": "application/json", connection: "close", "cache-control": "no-store" }).end(JSON.stringify({ error: { type: "blacksand_proxy", message: reason } }));
    };
    const closed = closedReason();
    if (closed) return deny(503, closed);
    if (!target || !endpoint || !op) return deny(403, "operation-not-allowed");
    if (!tokenOk(/^Bearer (\S{1,512})$/.exec(req.headers.authorization ?? "")?.[1] ?? null) || req.headersDistinct.authorization?.length !== 1) return deny(401, "bad-run-token");
    if (inUse.model >= limits.requests_inflight) return deny(503, "too-many-requests");
    if (requestsTotal >= limits.requests_total) return deny(429, "request-budget-spent");
    requestsTotal++;
    const slot = admit("model", id);
    let upstream: http.ClientRequest | undefined;
    let stopped = false;
    const started = now();
    const end = slot.accept(base, () => { stopped = true; upstream?.destroy(); res.destroy(); req.destroy(); });
    const timer = setTimeout(() => end("timeout"), limits.request_seconds * 1000);
    const finish = (result: Result, extra: Record<string, unknown> = {}) => { clearTimeout(timer); stopped = true; end(result, { ms: now() - started, ...extra }); };
    const refuse = (status: number, reason: string) => {
      if (stopped) return;
      // An admitted request has accept/end, never an extra deny for the same id.
      res.writeHead(status, { "content-type": "application/json", connection: "close", "cache-control": "no-store" }).end(JSON.stringify({ error: { type: "blacksand_proxy", message: reason } }));
      finish("ok", { status, reason });
    };
    res.once("close", () => finish("cancel"));
    req.once("error", () => finish("error"));
    if (auditFailed || auditFull) return finish("error");
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.request_bytes) return refuse(413, "request-too-large");
      if (!stopped) chunks.push(chunk);
    });
    req.once("end", () => {
      if (stopped) return;
      let body = Buffer.concat(chunks);
      if (["GET", "HEAD"].includes(op.method)) {
        if (body.length) return refuse(400, "body-not-allowed");
      } else {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) return refuse(415, "not-json");
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { return refuse(400, "bad-json"); }
        if (!isObject(parsed)) return refuse(400, "not-an-object");
        if (endpoint.auth.kind === "oidc") {
          if (Object.keys(parsed).some((k) => !["code", "code_verifier"].includes(k)) || typeof parsed.code !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(parsed.code) || typeof parsed.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(parsed.code_verifier)) return refuse(400, "exchange-input");
        } else if (!op.body || !grantedJson(parsed, op.body)) return refuse(403, "body-not-granted");
        body = Buffer.from(JSON.stringify(parsed));
      }
      let url: URL;
      let ca: Buffer | undefined;
      const secrets: string[] = [];
      const headers: http.OutgoingHttpHeaders = { "accept-encoding": "identity", accept: "application/json" };
      try {
        url = intranetUrl(endpoint, target.path, target.query);
        if (isIP(tlsHost(url)) && !endpoint.private && !isPublic(tlsHost(url))) return refuse(403, "non-public-address");
        ca = endpoint.ca_file ? readFileSync(endpoint.ca_file) : undefined;
        if (endpoint.auth.kind === "bearer") {
          const token = readBoundedSecret(endpoint.auth.token_file, 16384);
          const claims = jwtClaims(token);
          const exp = claims && expiresMs(claims);
          if (!claims || !exp || exp <= now() + 1000 || exp > now() + 3600_000 || claims.iss !== endpoint.auth.issuer || claims.sub !== endpoint.auth.subject || !exactAudience(claims, endpoint.auth.audience) || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 > now())) || typeof claims.scope !== "string" || !endpoint.auth.scopes.every((s) => (claims.scope as string).split(" ").includes(s))) return refuse(502, "token-unusable");
          headers.authorization = `Bearer ${token}`;
          secrets.push(token);
        } else if (endpoint.auth.kind === "oidc") {
          const parsed = JSON.parse(body.toString()) as { code: string; code_verifier: string };
          const secret = readBoundedSecret(endpoint.auth.client_secret_file, 4096);
          const basic = Buffer.from(`${formComponent(endpoint.auth.client_id)}:${formComponent(secret)}`).toString("base64");
          headers.authorization = `Basic ${basic}`;
          headers["content-type"] = "application/x-www-form-urlencoded";
          body = Buffer.from(new URLSearchParams({ grant_type: "authorization_code", client_id: endpoint.auth.client_id, redirect_uri: endpoint.auth.redirect_uri, code: parsed.code, code_verifier: parsed.code_verifier }).toString());
          secrets.push(secret, basic);
        }
      } catch { return refuse(502, "no-backend"); }
      if (endpoint.auth.kind !== "oidc") {
        // Deliberately narrower than the original intranet header allowlist:
        // JSON operations need negotiation and conditional writes only.
        for (const name of ["content-type", "if-match", "if-none-match"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
      }
      headers.host = url.host;
      headers["content-length"] = body.length;
      try {
        upstream = https.request(url, { method: op.method, headers, agent: false, lookup: checkedLookup(endpoint.private), ...(ca ? { ca } : {}) });
      } catch { return refuse(502, "upstream"); }
      upstream.on("error", () => { if (!stopped) refuse(502, "upstream"); });
      upstream.once("response", (answer) => {
        const status = answer.statusCode ?? 502;
        if (status >= 300 && status < 400) { answer.destroy(); return refuse(502, "upstream-redirect"); }
        // No compressed/non-ASCII response can bypass reflection checking.
        const type = String(answer.headers["content-type"] ?? "");
        if ((op.method !== "HEAD" && !/^application\/json(?:\s*;\s*charset="?utf-8"?)?$/i.test(type)) || !/^(identity)?$/i.test(String(answer.headers["content-encoding"] ?? "")) || !/^(chunked)?$/i.test(String(answer.headers["transfer-encoding"] ?? ""))) { answer.destroy(); return refuse(502, "encoded-response"); }
        const back: http.OutgoingHttpHeaders = { "content-type": "application/json", "cache-control": "no-store" };
        for (const name of ["etag", "request-id", "x-request-id"]) if (answer.headers[name] !== undefined) back[name] = answer.headers[name];
        if (op.method === "HEAD") {
          if (reflects(JSON.stringify(back), secrets)) { answer.destroy(); return refuse(502, "credential-reflected"); }
          answer.once("error", () => { if (!stopped) refuse(502, "upstream"); });
          answer.once("end", () => {
            if (stopped) return;
            res.writeHead(status, back).end();
            finish("ok", { status, bytes_up: body.length, bytes_down: 0 });
          });
          answer.resume();
          return;
        }
        const received: Buffer[] = [];
        let bytes = 0;
        answer.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.response_bytes) { answer.destroy(); return refuse(502, "response-too-large"); }
          if (!stopped) received.push(chunk);
        });
        answer.once("error", () => { if (!stopped) refuse(502, "upstream"); });
        answer.once("end", () => {
          if (stopped) return;
          const raw = Buffer.concat(received).toString("utf8");
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { return refuse(502, "upstream-json"); }
          if (reflects(raw, secrets) || reflects(JSON.stringify(parsed), secrets) || reflects(JSON.stringify(back), secrets)) return refuse(502, "credential-reflected");
          if (endpoint.auth.kind === "oidc") {
            if (status !== 200 || !isObject(parsed) || typeof parsed.id_token !== "string" || parsed.id_token.length > 16384 || !jwtClaims(parsed.id_token)) return refuse(502, "exchange-rejected");
            parsed = { id_token: parsed.id_token };
          }
          // Buffering makes the reflection/body-size decision before ANY response bytes leave.
          res.writeHead(status, back).end(JSON.stringify(parsed));
          finish("ok", { status, bytes_up: body.length, bytes_down: bytes });
        });
      });
      if (closedReason()) { upstream.destroy(); return finish("cancel"); }
      upstream.end(body);
    });
  }

  model.maxConnections = limits.requests_inflight * 4;
  // Past that, a connection is closed as it arrives; it's still one refusal in the audit.
  model.on("drop", () => log({ kind: "model", op: "unknown", id: ++ids, event: "deny", reason: "too-many-connections", status: 0 }));
  for (const [server, kind] of [[tunnel, "connect"], [model, "model"]] as const) {
    // A request Node can't parse never reaches a handler: answer it, and audit it as a refusal (a reset idle socket isn't a request).
    server.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
      if (error.code !== "ECONNRESET") log({ kind, op: kind === "connect" ? "connect" : "unknown", id: ++ids, event: "deny", reason: "bad-request", status: 400 });
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      else socket.destroy();
    });
  }
  model.requestTimeout = options.service ? limits.request_seconds * 1000 : 120_000;
  if (options.service) {
    model.headersTimeout = Math.min(5000, limits.request_seconds * 1000);
    model.on("connection", (socket) => { const timer = setTimeout(() => socket.destroy(), limits.request_seconds * 1000); socket.once("close", () => clearTimeout(timer)); });
    model.on("connect", (_req, socket) => socket.destroy());
  }

  /** Refuses new work, ends what's open (each logs its end), then writes the closing marker. */
  function seal(reason: string): Promise<void> {
    sealing ??= (async () => {
      for (const cancel of [...active.values()]) cancel();
      for (let i = 0; (inUse.connect || inUse.model) && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
      write({ event: "sealed", reason, entries: seq + 1, audit_full: auditFull, ...(options.service ? { unlogged, audit_failed: auditFailed } : {}), unfinished: inUse.connect + inUse.model });
      for (const socket of sockets) socket.destroy(); // CONNECT sockets included, which closeAllConnections doesn't reach
      await Promise.all([tunnel, model].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      clearTimeout(expiry);
      options.onSealed?.();
    })();
    return sealing;
  }

  // Every socket either listener holds, so sealing can close them all.
  const sockets = new Set<Socket>();
  for (const server of [tunnel, model]) server.on("connection", (socket: Socket) => (sockets.add(socket), socket.once("close", () => sockets.delete(socket))));

  const listen = (server: http.Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
    });
  const ports = { connect: options.service ? 0 : await listen(tunnel, config.connect.port), model: 0 };
  try { ports.model = await listen(model, config.model.port); } catch (error) { tunnel.close(); throw error; }
  const expiry = setTimeout(() => void seal("expired"), Math.min(2 ** 31 - 1, Math.max(0, config.expires_at - now())));
  write({ event: "start", ...(options.service?.context ?? {}), ports, expires_at: new Date(config.expires_at).toISOString(), limits });
  return { ports, seal };
}

function open(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 10_000 });
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeAllListeners("error");
      socket.removeAllListeners("timeout");
      resolve(socket);
    });
    socket.once("timeout", () => socket.destroy(new Error("connect timeout")));
    socket.once("error", reject);
  });
}

// A ConfigMap mount is a symlink, and Node runs the file it points to.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const config = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as ProxyConfig;
  const proxy = await startProxy(config, { onSealed: () => process.stdout.write("", () => process.exit(0)) });
  process.once("SIGTERM", () => void proxy.seal("stopped"));
}
