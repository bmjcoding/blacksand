// Admin-only configuration, separate from RunSpec and its historical digests.
// The intranet primitive is adapted from signed feature 97722cd.
import { isAbsolute } from "node:path";
import { DEFAULT_LIMITS, PolicyError, assertModel } from "./policy.ts";
import type { IntranetEndpoint, IntranetOperation, JsonGrant, Limits, Route } from "../sandbox/proxy.ts";

export type IntranetSpec = IntranetEndpoint;
export interface ServiceConfig {
  schema: "run.blacksand.service-proxy/1";
  service: string;
  listen: { host: string; port: number; authority: string; cert_file: string; key_file: string };
  control_file: string;
  audit_dir: string;
  max_segments: number;
  serve_seconds: number;
  limits: Limits;
  endpoints: IntranetSpec[];
  models: Route[];
}
const fail = (): never => { throw new PolicyError("invalid service proxy configuration"); };
function fields(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some((k) => !keys.includes(k))) return fail();
  return v as Record<string, unknown>;
}
const text = (v: unknown, re = /^[\x21-\x7e]{1,256}$/): string => typeof v === "string" && re.test(v) ? v : fail();
const file = (v: unknown): string => { const s = text(v, /^[^\x00-\x1f]{1,1024}$/); return isAbsolute(s) ? s : fail(); };
const integer = (v: unknown, min: number, max: number): number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
function strings(v: unknown, max = 64): string[] {
  if (!Array.isArray(v) || v.length > max) return fail();
  const out = v.map((s) => text(s));
  if (new Set(out).size !== out.length) return fail();
  return out;
}
function url(v: unknown): URL {
  const raw = text(v, /^https:\/\/[^\s]{1,2048}$/);
  let u: URL;
  try { u = new URL(raw); } catch { return fail(); }
  if (u.username || u.password || u.search || u.hash || !/^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname) || u.href !== raw) return fail();
  return u;
}
function grant(v: unknown): JsonGrant {
  const g = fields(v, ["fields", "required", "values", "prefixes"]);
  const names = strings(g.fields);
  const required = strings(g.required);
  const values = fields(g.values, names);
  const prefixes = fields(g.prefixes, names);
  if (!required.every((k) => names.includes(k))) return fail();
  return { fields: names, required, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, strings(v)])), prefixes: Object.fromEntries(Object.entries(prefixes).map(([k, v]) => [k, text(v)])) };
}
function operation(v: unknown): IntranetOperation {
  const o = fields(v, ["id", "method", "path", "body"]);
  const method = text(o.method, /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/);
  const path = text(o.path, /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)+\/?$/);
  // Service operations are exact and query-free; wildcard routes are not needed.
  if (["GET", "HEAD"].includes(method) && o.body !== undefined) return fail();
  return { id: text(o.id, /^[a-z0-9][a-z0-9._-]{0,63}$/), method, path, query: false, ...(o.body === undefined ? {} : { body: grant(o.body) }) };
}
function endpoint(v: unknown): IntranetSpec {
  const e = fields(v, ["name", "url", "private", "ca_file", "auth", "operations"]);
  const u = url(e.url);
  if (typeof e.private !== "boolean" || !Array.isArray(e.operations) || e.operations.length < 1 || e.operations.length > 64) return fail();
  const operations = e.operations.map(operation);
  if (new Set(operations.map((o) => o.id)).size !== operations.length || new Set(operations.map((o) => `${o.method} ${o.path}`)).size !== operations.length) return fail();
  const a = fields(e.auth, ["kind", "token_file", "audience", "issuer", "subject", "scopes", "client_id", "client_secret_file", "redirect_uri"]);
  let auth: IntranetEndpoint["auth"];
  if (a.kind === "public") {
    fields(a, ["kind"]);
    if (operations.some((o) => !["GET", "HEAD"].includes(o.method))) return fail();
    auth = { kind: "public" };
  } else if (a.kind === "bearer") {
    fields(a, ["kind", "token_file", "audience", "issuer", "subject", "scopes"]);
    const scopes = strings(a.scopes);
    if (!scopes.length || operations.some((o) => !["GET", "HEAD"].includes(o.method) && !o.body)) return fail();
    auth = { kind: "bearer", token_file: file(a.token_file), audience: text(a.audience), issuer: text(a.issuer), subject: text(a.subject), scopes };
  } else if (a.kind === "oidc") {
    fields(a, ["kind", "client_id", "client_secret_file", "redirect_uri"]);
    if (operations.length !== 1 || operations[0]!.method !== "POST" || operations[0]!.body) return fail();
    auth = { kind: "oidc", client_id: text(a.client_id), client_secret_file: file(a.client_secret_file), redirect_uri: url(a.redirect_uri).href };
  } else return fail();
  return { name: text(e.name, /^[a-z][a-z0-9-]{0,30}$/), origin: u.origin, base_path: u.pathname.replace(/\/$/, ""), private: e.private, ca_file: e.ca_file === null ? null : file(e.ca_file), auth, operations };
}
/** Closed endpoint policy; CA and credentials remain file references, read per request. */
export function parseIntranet(value: unknown): IntranetSpec[] {
  if (!Array.isArray(value) || value.length > 16) return fail();
  const endpoints = value.map(endpoint);
  if (new Set(endpoints.map((e) => e.name)).size !== endpoints.length) return fail();
  return endpoints;
}
export function parseServiceConfig(value: unknown): ServiceConfig {
  const c = fields(value, ["schema", "service", "listen", "control_file", "audit_dir", "max_segments", "serve_seconds", "limits", "endpoints", "models"]);
  if (c.schema !== "run.blacksand.service-proxy/1") return fail();
  const l = fields(c.listen, ["host", "port", "authority", "cert_file", "key_file"]);
  const rawLimits = fields(c.limits, Object.keys(DEFAULT_LIMITS));
  // A finite whole-call bound, bounded memory, disk and admission in every epoch.
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, d]) => [k, integer(rawLimits[k] ?? (k === "request_seconds" ? 120 : d), 1, k === "request_seconds" ? 120 : k === "audit_bytes" ? 4 * 1024 * 1024 : d)])) as unknown as Limits;
  if (limits.audit_bytes < 4096) return fail();
  if (!Array.isArray(c.models) || c.models.length > 2) return fail();
  const models: Route[] = c.models.map((v) => {
    const m = fields(v, ["name", "url", "private", "ca_file", "secret_file", "models"]);
    const u = url(m.url);
    const name = text(m.name, /^(anthropic|openai)$/) as Route["name"];
    const models = strings(m.models).map(assertModel);
    if (!models.length || typeof m.private !== "boolean") return fail();
    return { name, origin: u.origin, base_path: u.pathname.replace(/\/$/, ""), header: name === "anthropic" ? "x-api-key" : "authorization", secret_file: file(m.secret_file), models, private: m.private, ca_file: m.ca_file === null ? null : file(m.ca_file) };
  });
  if (new Set(models.map((m) => m.name)).size !== models.length) return fail();
  return { schema: c.schema, service: text(c.service, /^[a-z][a-z0-9-]{0,62}$/), listen: { host: text(l.host), port: integer(l.port, 0, 65535), authority: text(l.authority, /^(?:[a-z0-9][a-z0-9.-]{0,252}|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/), cert_file: file(l.cert_file), key_file: file(l.key_file) }, control_file: file(c.control_file), audit_dir: file(c.audit_dir), max_segments: integer(c.max_segments, 1, 1024), serve_seconds: integer(c.serve_seconds ?? 900, 1, 900), limits, endpoints: parseIntranet(c.endpoints), models };
}
