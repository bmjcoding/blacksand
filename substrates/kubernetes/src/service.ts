// Admin/operator entrypoint. Stable service identity, finite proxy epochs.
// No Kubernetes client, token broker, agent lifetime or client-facing admin API.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { startProxy } from "../sandbox/proxy.ts";
import { readAudit } from "./audit.ts";
import { canonical, sha256 } from "./policy.ts";
import { parseServiceConfig, type ServiceConfig } from "./service-policy.ts";

const CONTROL = "run.blacksand.service-epoch/1";
const STATE = "run.blacksand.service-state/1";
export const MAX_EPOCH_SECONDS = 900;
export interface Epoch {
  schema: typeof CONTROL;
  service: string;
  epoch: number;
  expires_at: number;
  token_sha256: string | null;
}
const error = (code: string): never => { throw new Error(code); };
function readJson(file: string, max = 65536): unknown {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) return error("invalid-file");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function syncDir(dir: string) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** Atomic replacement, restrictive permissions, contents and directory synced. */
function publish(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${canonical(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    syncDir(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}
export function prepareService(config: ServiceConfig) {
  fs.mkdirSync(config.audit_dir, { recursive: true, mode: 0o700 });
  const marker = path.join(config.audit_dir, "SERVICE.json");
  if (fs.existsSync(marker)) {
    const old = readJson(marker) as { schema?: unknown; service?: unknown };
    if (old.schema !== STATE || old.service !== config.service) error("audit-service-mismatch");
  } else {
    if (fs.readdirSync(config.audit_dir).length) error("audit-not-empty");
    publish(marker, { schema: STATE, service: config.service });
    syncDir(path.dirname(config.audit_dir));
  }
  const counter = path.join(config.audit_dir, "segments.json");
  if (!fs.existsSync(counter)) {
    if (fs.readdirSync(config.audit_dir).some((n) => n.endsWith(".jsonl"))) error("audit-order");
    publish(counter, { allocated: 0 });
  }
}
function epoch(value: unknown, config: ServiceConfig, now: number): Epoch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return error("invalid-epoch");
  const v = value as Epoch;
  if (Object.keys(v).sort().join(",") !== "epoch,expires_at,schema,service,token_sha256" || v.schema !== CONTROL || v.service !== config.service || !Number.isSafeInteger(v.epoch) || v.epoch < 1 || !Number.isSafeInteger(v.expires_at) || v.expires_at > now + MAX_EPOCH_SECONDS * 1000 || (v.token_sha256 !== null && !/^[0-9a-f]{64}$/.test(v.token_sha256))) return error("invalid-epoch");
  return v;
}
/** Operator-only: client capability is delivered independently of proxy credentials.
 * Single operator writer; publish to a client volume, then activate its hash. */
export function issueEpoch(config: ServiceConfig, capabilityFile: string, seconds: number, now = Date.now()): Epoch {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_EPOCH_SECONDS || !path.isAbsolute(capabilityFile) || capabilityFile === config.control_file) return error("invalid-issue");
  const old = fs.existsSync(config.control_file) ? epoch(readJson(config.control_file), config, now) : null;
  const state = highwater(config);
  const n = Math.max(old?.epoch ?? 0, state?.epoch ?? 0) + 1;
  const token = randomBytes(32).toString("base64url");
  const next: Epoch = { schema: CONTROL, service: config.service, epoch: n, expires_at: now + seconds * 1000, token_sha256: sha256(token) };
  publish(capabilityFile, { schema: "run.blacksand.service-capability/1", service: config.service, epoch: n, expires_at: next.expires_at, token });
  publish(config.control_file, next);
  return next;
}
export function revokeEpoch(config: ServiceConfig, now = Date.now()) {
  const old = epoch(readJson(config.control_file), config, now);
  const state = highwater(config);
  const next: Epoch = { schema: CONTROL, service: config.service, epoch: Math.max(old.epoch, state?.epoch ?? 0) + 1, expires_at: now, token_sha256: null };
  publish(config.control_file, next);
}
function highwater(config: ServiceConfig): { epoch: number; hash: string } | null {
  const file = path.join(config.audit_dir, "epoch.json");
  if (!fs.existsSync(file)) return null;
  const v = readJson(file) as { epoch: number; hash: string };
  if (!Number.isSafeInteger(v.epoch) || v.epoch < 1 || !/^[0-9a-f]{64}$/.test(v.hash)) return error("invalid-epoch-state");
  return v;
}
export interface SegmentEvidence {
  segment: number;
  epoch: number | null;
  sha256: string;
  complete: boolean;
  problems: string[];
}
/** Same sealed-audit verifier as runs, plus disk/order/service/hash linkage.
 * A missing seal after a crash is evidence of incompleteness, never repaired. */
export function serviceEvidence(config: ServiceConfig): SegmentEvidence[] {
  const marker = readJson(path.join(config.audit_dir, "SERVICE.json")) as { schema: string; service: string };
  if (marker.schema !== STATE || marker.service !== config.service) return error("audit-service-mismatch");
  const names = fs.readdirSync(config.audit_dir).filter((n) => /^\d{10}\.jsonl$/.test(n)).sort();
  if (names.length > config.max_segments) return error("audit-capacity");
  const counter = readJson(path.join(config.audit_dir, "segments.json")) as { allocated: number };
  if (!Number.isSafeInteger(counter.allocated) || counter.allocated < 0 || counter.allocated > config.max_segments || counter.allocated > names.length) return error("audit-order");
  let previous: string | null = null;
  return names.map((name, index) => {
    const file = path.join(config.audit_dir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > config.limits.audit_bytes) return error("audit-size");
    const raw = fs.readFileSync(file, "utf8");
    let first: Record<string, unknown> = {};
    try { first = JSON.parse(raw.split("\n")[0] ?? ""); } catch {}
    const audit = readAudit(raw, String(first.run));
    const problems = [...audit.problems];
    if (index >= counter.allocated) problems.push("segment-allocation-incomplete");
    if (Number(name.slice(0, 10)) !== index + 1 || first.segment !== index + 1) problems.push("segment-order");
    if (first.service !== config.service || first.previous_sha256 !== previous || typeof first.epoch !== "number") problems.push("segment-linkage");
    const digest = sha256(raw);
    previous = digest;
    return { segment: index + 1, epoch: typeof first.epoch === "number" ? first.epoch : null, sha256: digest, complete: audit.sealed && !problems.length, problems };
  });
}
export async function startService(config: ServiceConfig, options: { poll_ms?: number; now?: () => number; record?: (line: string) => void } = {}) {
  const now = options.now ?? Date.now;
  // Recreate/single operator process. A live listener owns the port; O_EXCL
  // segment creation also refuses competing writers without overwriting evidence.
  serviceEvidence(config);
  let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;
  let current: string | null = null;
  let stopped = false;
  let fatal: string | null = null;
  let refreshing: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let port = 0;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  async function refreshOnce() {
    if (stopped) return;
    if (fatal) return error(fatal);
    const value = epoch(readJson(config.control_file), config, now());
    const digest = sha256(canonical(value));
    const state = highwater(config);
    if (state && (value.epoch < state.epoch || (value.epoch === state.epoch && digest !== state.hash))) return error("epoch-rollback");
    if (digest === current) {
      if (value.expires_at <= now()) await proxy?.seal("expired");
      return;
    }
    // Revoke first, including active sockets. There is no overlapping grant.
    if (proxy) { await proxy.seal(value.token_sha256 === null ? "revoked" : "rotated"); proxy = null; }
    if (fatal) return error(fatal);
    publish(path.join(config.audit_dir, "epoch.json"), { epoch: value.epoch, hash: digest });
    current = digest;
    if (value.token_sha256 === null || value.expires_at <= now()) return;
    const evidence = serviceEvidence(config);
    if (evidence.length >= config.max_segments) return error("audit-capacity");
    const segment = evidence.length + 1;
    const run = `service/${config.service}/${value.epoch}/${segment}`;
    const fd = fs.openSync(path.join(config.audit_dir, `${String(segment).padStart(10, "0")}.jsonl`), "wx", 0o600);
    syncDir(config.audit_dir);
    let bytes = 0;
    let closed = false;
    const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
    const record = (line: string) => {
      try {
        const data = Buffer.from(line);
        if (closed || bytes + data.length > config.limits.audit_bytes) return error("audit-capacity");
        options.record?.(line); // failure injection exercises the actual admission boundary
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
        bytes += data.length;
      } catch { fatal = "audit-failed"; throw new Error("audit-failed"); }
    };
    try {
      publish(path.join(config.audit_dir, "segments.json"), { allocated: segment });
      proxy = await startProxy({ run, expires_at: value.expires_at, token_sha256: value.token_sha256, limits: config.limits, connect: { port: 0, allow: [] }, model: { port: config.listen.port, routes: config.models }, intranet: { endpoints: config.endpoints } }, {
        host: config.listen.host, now, record,
        service: { authority: config.listen.authority, tls: { key: fs.readFileSync(config.listen.key_file), cert: fs.readFileSync(config.listen.cert_file) }, context: { config_sha256: sha256(canonical(config)), service: config.service, epoch: value.epoch, segment, previous_sha256: evidence.at(-1)?.sha256 ?? null } },
        onSealed: close,
      });
      port = proxy.ports.model;
    } catch { close(); return error("service-start-failed"); }
    if (fatal) return error(fatal);
  }
  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { await refreshOnce(); } catch (e) {
        fatal = e instanceof Error && ["audit-failed", "audit-capacity", "epoch-rollback"].includes(e.message) ? e.message : "service-unavailable";
        stopped = true;
        if (timer) clearInterval(timer);
        clearTimeout(lifetime);
        await proxy?.seal(fatal);
      }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  async function close() { stopped = true; clearInterval(timer); clearTimeout(lifetime); await refreshing; await proxy?.seal("stopped"); }
  await refresh();
  if (fatal) throw new Error(fatal);
  timer = setInterval(() => void refresh(), options.poll_ms ?? 250);
  lifetime = setTimeout(() => void close(), config.serve_seconds * 1000);
  return { refresh, status: () => ({ service: config.service, port, stopped, error: fatal }), close };

}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    const [command, file, capability, ttl] = process.argv.slice(2);
    const config = parseServiceConfig(readJson(file ?? ""));
    if (command === "prepare") prepareService(config);
    else if (command === "issue") issueEpoch(config, capability ?? "", Number(ttl));
    else if (command === "revoke") revokeEpoch(config);
    else if (command === "audit") {
      const evidence = serviceEvidence(config);
      process.stdout.write(`${JSON.stringify({ service: config.service, segments: evidence, complete: evidence.every((e) => e.complete) })}\n`);
      if (evidence.some((e) => !e.complete)) process.exitCode = 1;
    } else if (command === "serve") {
      const service = await startService(config);
      const stop = () => { void service.close().then(() => { process.exitCode = service.status().error ? 1 : 0; }); };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      // A fatal sink/control failure stops the supervisor and listeners. It must
      // also end the process so a Pod cannot remain falsely healthy.
      const health = setInterval(() => { if (service.status().stopped || service.status().error) { clearInterval(health); stop(); } }, 250);
      process.once("SIGTERM", () => clearInterval(health));
      process.once("SIGINT", () => clearInterval(health));
    } else error("service-command");
  } catch { process.stderr.write("service proxy refused\n"); process.exitCode = 1; }
}
