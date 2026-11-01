// A run's network policy as data: the egress allowlist, the model route and
// grant, the proxy's limits and config, and the digests the run record pins.

import { createHash } from "node:crypto";

import type { Allow, Limits, ProxyConfig, Route, RouteName } from "../sandbox/proxy.ts";

export type { Allow, Limits, ProxyConfig, Route };

export const PORTS = { connect: 3128, model: 8080 } as const;

export type RouteKind = RouteName;

/** A model route as the caller gives it: which API, the backend, and the Secret holding its credential. */
export interface RouteSpec {
  kind: RouteKind;
  /** The backend's bare origin, e.g. https://api.anthropic.com. */
  origin: string;
  /** "" or a path prefix the provider's API sits under. */
  basePath: string;
  /** Secret (in the egress namespace) whose `key` entry is the backend credential. */
  secret: string;
}

const MiB = 1024 * 1024;

/** Per-run proxy limits. Generous for one coding task; each is a ceiling the proxy enforces, recorded in the run's policy. */
export const DEFAULT_LIMITS: Limits = {
  tunnels: 32,
  requests_inflight: 8,
  requests_total: 2000,
  request_bytes: 16 * MiB,
  response_bytes: 64 * MiB,
  tunnel_bytes: 512 * MiB,
  tunnel_seconds: 1800,
  request_seconds: 1200,
  // Below the kubelet's default 10 MiB log rotation, so `kubectl logs` always has all of it.
  audit_bytes: 4 * MiB,
};

export class PolicyError extends Error {}

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Plain segments only: no empty, "." or ".." segment can move the path.
const BASE_PATH = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)*$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/** `host:port`, a DNS name (no wildcards, no IP literals) and a port. `private` marks a host meant to be on a private network. */
export function parseAllow(text: string, isPrivate = false): Allow {
  const at = text.lastIndexOf(":");
  const host = text.slice(0, at).toLowerCase();
  const port = Number(text.slice(at + 1));
  if (at < 1 || !HOST.test(host) || /^[0-9.]+$/.test(host)) throw new PolicyError(`allow ${JSON.stringify(text)}: needs host:port with a DNS name`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PolicyError(`allow ${JSON.stringify(text)}: port must be 1-65535`);
  return { host, port, private: isPrivate };
}

/** `KIND=URL@SECRET`, e.g. `anthropic=https://api.anthropic.com@anthropic-key`. The URL is an origin and an optional plain path prefix. */
export function parseRoute(text: string): RouteSpec {
  const m = /^(anthropic|openai)=([^@\s]+)@([a-z0-9-]+)$/.exec(text);
  if (!m) throw new PolicyError(`route ${JSON.stringify(text)}: needs KIND=URL@SECRET, KIND anthropic or openai`);
  const [, kind, upstream = "", secret = ""] = m;
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new PolicyError(`route ${kind}: ${JSON.stringify(upstream)} isn't a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new PolicyError(`route ${kind}: the URL must be http(s)`);
  if (url.username || url.password || url.search || url.hash) throw new PolicyError(`route ${kind}: the URL can't carry credentials, a query or a fragment`);
  const basePath = url.pathname.replace(/\/$/, "");
  if (!BASE_PATH.test(basePath)) throw new PolicyError(`route ${kind}: the path must be plain segments`);
  if (!NAME.test(secret)) throw new PolicyError(`route ${kind}: ${JSON.stringify(secret)} isn't a Secret name`);
  return { kind: kind as RouteKind, origin: url.origin, basePath, secret };
}

export function assertModel(model: string): string {
  if (!MODEL.test(model)) throw new PolicyError(`model ${JSON.stringify(model)} isn't a model id`);
  return model;
}

export const secretMount = (kind: RouteKind) => `/secrets/${kind}`;

export interface ProxyInputs {
  run: string;
  allow: readonly Allow[];
  /** The one route the run's agent uses; the proxy has no other. */
  route: RouteSpec;
  /** The model ids the run may name. */
  models: readonly string[];
  tokenSha256: string;
  expiresAt: number;
  limits?: Limits;
}

export function proxyConfig(p: ProxyInputs): ProxyConfig {
  if (!p.models.length) throw new PolicyError("a run needs at least one granted model");
  return {
    run: p.run,
    expires_at: p.expiresAt,
    token_sha256: p.tokenSha256,
    limits: p.limits ?? DEFAULT_LIMITS,
    connect: { port: PORTS.connect, allow: [...p.allow].sort((a, b) => `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`)) },
    model: {
      port: PORTS.model,
      routes: [
        {
          name: p.route.kind,
          origin: p.route.origin,
          base_path: p.route.basePath,
          header: p.route.kind === "anthropic" ? "x-api-key" : "authorization",
          secret_file: `${secretMount(p.route.kind)}/key`,
          models: [...new Set(p.models.map(assertModel))].sort(),
        },
      ],
    },
  };
}

/** JSON with keys sorted at every level, so equal objects have equal digests. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
