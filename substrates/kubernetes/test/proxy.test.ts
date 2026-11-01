// The proxy on loopback, with real sockets: TCP echo servers stand in for
// allowed hosts, an HTTP server for the model backend, and another for an
// attacker's server that would echo back any credential it's sent.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";

import { readAudit } from "../src/audit.ts";
import { DEFAULT_LIMITS } from "../src/policy.ts";
import { backendUrl, isPublic, matchOperation, parseAuthority, startProxy, type Limits, type ProxyConfig, type Route } from "../sandbox/proxy.ts";

const TOKEN = "run-token-0123456789";
const CREDENTIAL = "sk-backend-credential";
const PROMPT = "a prompt the log must never hold";
const RUN = "abcdef012345";

const listen = (server: net.Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
const servers: net.Server[] = [];
const proxies: { seal(reason: string): Promise<void> }[] = [];

/** The backend: records each request, and answers after `hold` resolves (so tests can keep requests in flight). */
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; readonly body: string }[] = [];
let hold: Promise<void> = Promise.resolve();
let backendPort = 0;
/** The attacker: echoes the credential back in a header and the body. */
const stolen: string[] = [];
let attackerPort = 0;
let echoPort = 0;
let publicOnlyPort = 0;
let keyFile = "";

before(async () => {
  const backend = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, get body() { return text; } });
    req.on("end", () => void hold.then(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", model: "fake-model-20261101", content: [] }))));
  });
  const attacker = http.createServer((req, res) => {
    stolen.push(String(req.headers["x-api-key"] ?? req.headers.authorization ?? ""));
    res.writeHead(200, { "x-echo": String(req.headers["x-api-key"] ?? "") }).end(String(req.headers["x-api-key"] ?? ""));
  });
  const echo = net.createServer((socket) => socket.on("error", () => {}).pipe(socket));
  const echo2 = net.createServer((socket) => socket.on("error", () => {}).pipe(socket));
  servers.push(backend, attacker, echo, echo2);
  [backendPort, attackerPort, echoPort, publicOnlyPort] = await Promise.all([listen(backend), listen(attacker), listen(echo), listen(echo2)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-proxy-"));
  keyFile = path.join(dir, "key");
  fs.writeFileSync(keyFile, `${CREDENTIAL}\n`);
});

after(async () => {
  await Promise.all(proxies.map((p) => p.seal("test")));
  for (const s of servers) s.close();
});

/** A proxy with its audit captured; `limits` and `now` override the defaults. */
async function proxy(limits: Partial<Limits> = {}, now?: () => number) {
  const lines: string[] = [];
  const out = new Writable({ write: (chunk: Buffer, _enc, done) => (lines.push(...chunk.toString().split("\n").filter(Boolean)), done()) });
  const routes: Route[] = [
    { name: "anthropic", origin: `http://127.0.0.1:${backendPort}`, base_path: "/base", header: "x-api-key", secret_file: keyFile, models: ["claude-opus-5-5"] },
    { name: "openai", origin: `http://127.0.0.1:${backendPort}`, base_path: "", header: "authorization", secret_file: keyFile, models: ["gpt-6.1-sol"] },
  ];
  const config: ProxyConfig = {
    run: RUN,
    expires_at: Date.now() + 3_600_000,
    token_sha256: createHash("sha256").update(TOKEN).digest("hex"),
    limits: { ...DEFAULT_LIMITS, ...limits },
    connect: { port: 0, allow: [{ host: "localhost", port: echoPort, private: true }, { host: "localhost", port: publicOnlyPort, private: false }] },
    model: { port: 0, routes },
  };
  const started = await startProxy(config, { host: "127.0.0.1", out, ...(now ? { now } : {}) });
  proxies.push(started);
  const audit = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ...started, lines, audit, log: () => lines.join("\n") };
}

type Proxy = Awaited<ReturnType<typeof proxy>>;

/** CONNECT through the proxy with the run token (or `auth`); for a 200, sends "ping" and resolves with what came back. */
function tunnel(p: Proxy, authority: string, auth: string | null = TOKEN): Promise<{ status: number; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const headers = auth === null ? {} : { "proxy-authorization": `Basic ${Buffer.from(`run:${auth}`).toString("base64")}` };
    const req = http.request({ host: "127.0.0.1", port: p.ports.connect, method: "CONNECT", path: authority, headers });
    req.on("error", reject);
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return (socket.destroy(), resolve({ status: res.statusCode ?? 0 }));
      socket.once("data", (data: Buffer) => (socket.destroy(), resolve({ status: 200, echoed: data.toString() })));
      socket.write("ping");
    });
    req.end();
  });
}

/** A raw HTTP/1.1 request to the model listener, so any request target can be sent exactly as written. */
function raw(p: Proxy, target: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  const body = options.body ?? JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: PROMPT }] });
  // A header given as "" isn't sent at all.
  const headers = Object.fromEntries(Object.entries({ host: "proxy", "content-type": "application/json", "x-api-key": TOKEN, "content-length": String(Buffer.byteLength(body)), connection: "close", ...options.headers }).filter(([, v]) => v !== ""));
  return new Promise((resolve, reject) => {
    const socket = net.connect(p.ports.model, "127.0.0.1", () => {
      socket.write(`${options.method ?? "POST"} ${target} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`);
    });
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), body: text.slice(text.indexOf("\r\n\r\n") + 4) }));
  });
}

test("a request target that names another host is refused, and the key never leaves for it", async () => {
  const p = await proxy();
  const before = seen.length;
  const attacker = `127.0.0.1:${attackerPort}`;
  for (const target of [
    `/anthropic//${attacker}/steal`,
    `/anthropic//${attacker}/v1/messages`,
    `/anthropic/\\\\${attacker}/v1/messages`,
    `/anthropic\\..\\..\\${attacker}`,
    `http://${attacker}/v1/messages`,
    `//${attacker}/anthropic/v1/messages`,
    `/anthropic/%2F%2F${attacker}/v1/messages`,
    `/anthropic/v1/messages/../../..//${attacker}/x`,
    `/anthropic/v1/messages?redirect=http://${attacker}/`,
    `/anthropic/v1/messages#@${attacker}`,
    `/openai/v1/files`,
  ]) {
    const res = await raw(p, target);
    assert.ok([400, 404].includes(res.status), `${target}: ${res.status}`);
    assert.ok(!res.body.includes(CREDENTIAL), target);
  }
  assert.deepEqual(stolen, [], "the attacker's server never received a request");
  assert.equal(seen.length, before, "nor did the backend");
  assert.ok(!p.log().includes(attacker), "and the attacker's address isn't in the audit");
});

test("the backend URL is the configured origin and the operation's own path, whatever the request said", async () => {
  const p = await proxy();
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 200);
  assert.equal(seen.at(-1)?.url, "/base/v1/messages");
  assert.equal(seen.at(-1)?.headers["x-api-key"], CREDENTIAL);
  assert.equal((await raw(p, "/anthropic/v1/messages?beta=true")).status, 200);
  assert.equal(seen.at(-1)?.url, "/base/v1/messages?beta=true");
  const end = p.audit().filter((e) => e.event === "end").at(-1);
  assert.equal(end?.destination, `http://127.0.0.1:${backendPort}`, "the audit names where the request actually went");
  const route: Route = { name: "anthropic", origin: "https://api.anthropic.com", base_path: "", header: "x-api-key", secret_file: "", models: [] };
  assert.equal(backendUrl(route, "").href, "https://api.anthropic.com/v1/messages");
  for (const bad of [{ origin: "https://api.anthropic.com/" }, { origin: "https://user@api.anthropic.com" }, { base_path: "//evil.example" }, { base_path: "/a/../b" }, { base_path: "/.." }, { base_path: "/./x" }]) {
    assert.throws(() => backendUrl({ ...route, ...bad }, ""), /origin|base path/, JSON.stringify(bad));
  }
  assert.equal(matchOperation("/anthropic/v1/messages/", [route]), null);
});

test("the grant covers one method, one operation and the granted models: anything else is refused before the key is added", async () => {
  const p = await proxy();
  const before = seen.length;
  assert.equal((await raw(p, "/anthropic/v1/messages", { method: "DELETE" })).status, 405);
  assert.equal((await raw(p, "/anthropic/v1/messages", { body: JSON.stringify({ model: "claude-mythos-5" }) })).status, 403);
  assert.equal((await raw(p, "/anthropic/v1/messages", { body: JSON.stringify({ model: ["claude-opus-5-5"] }) })).status, 403);
  assert.equal((await raw(p, "/anthropic/v1/messages", { body: "{not json" })).status, 400);
  assert.equal((await raw(p, "/anthropic/v1/messages", { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await raw(p, "/openai/v1/responses", { body: JSON.stringify({ model: "claude-opus-5-5" }) })).status, 403, "each route has its own grant");
  assert.equal(seen.length, before, "none of them reached the backend");
});

test("a key in the other provider's format is never sent: it's refused before the request leaves", async () => {
  const p = await proxy();
  const before = seen.length;
  try {
    fs.writeFileSync(keyFile, "sk-ant-api03-not-an-openai-key\n");
    const openai = await raw(p, "/openai/v1/responses", { body: JSON.stringify({ model: "gpt-6.1-sol", input: "hi" }), headers: { "x-api-key": "", authorization: `Bearer ${TOKEN}` } });
    assert.equal(openai.status, 502);
    assert.equal(p.audit().at(-1)?.reason, "key-for-another-provider");
    fs.writeFileSync(keyFile, "sk-proj-not-an-anthropic-key\n");
    const anthropic = await raw(p, "/anthropic/v1/messages");
    assert.equal(anthropic.status, 502);
    assert.equal(p.audit().at(-1)?.reason, "key-for-another-provider");
  } finally {
    fs.writeFileSync(keyFile, `${CREDENTIAL}\n`);
  }
  assert.equal(seen.length, before, "nothing reached the backend");
  assert.ok(!p.log().includes("not-an-"), "the key isn't in the audit");
});

test("only listed request headers reach the backend: no client credential, no provider org or project selector", async () => {
  const p = await proxy();
  await raw(p, "/openai/v1/responses", { body: JSON.stringify({ model: "gpt-6.1-sol", input: "hi" }), headers: { "x-api-key": "", authorization: `Bearer ${TOKEN}`, "openai-organization": "org-other", "openai-project": "proj-other", cookie: "c=1" } });
  const headers = seen.at(-1)?.headers ?? {};
  assert.equal(headers.authorization, `Bearer ${CREDENTIAL}`);
  assert.equal(headers["openai-organization"], undefined);
  assert.equal(headers["openai-project"], undefined);
  assert.equal(headers.cookie, undefined);
});

test("a body asking for provider-side work is refused at the proxy, and what reaches the backend is the rebuilt body", async () => {
  const p = await proxy();
  const before = seen.length;
  const asked = await raw(p, "/openai/v1/responses", { body: JSON.stringify({ model: "gpt-6.1-sol", input: "hi", tools: [{ type: "web_search" }] }) });
  assert.equal(asked.status, 403);
  assert.equal(seen.length, before, "it never reached the backend");
  assert.equal(p.audit().at(-1)?.reason, "provider-tool");
  // A duplicated key reads one way here and might read another way upstream: the backend gets this proxy's reading, re-serialised.
  assert.equal((await raw(p, "/openai/v1/responses", { body: '{"model":"gpt-6.1-sol","input":"hi","store":false,"model":"gpt-6.1-sol"}' })).status, 200);
  assert.deepEqual(JSON.parse(seen.at(-1)?.body ?? "{}"), { model: "gpt-6.1-sol", input: "hi", store: false, background: false });
  assert.equal((await raw(p, "/anthropic/v1/messages", { headers: { "anthropic-beta": "mcp-client-2025-11-20" } })).status, 403);
});

test("a wrong or missing run token is refused before anything reaches the backend", async () => {
  const p = await proxy();
  const before = seen.length;
  assert.equal((await raw(p, "/anthropic/v1/messages", { headers: { "x-api-key": "guess" } })).status, 401);
  assert.equal((await raw(p, "/anthropic/v1/messages", { headers: { "x-api-key": "" } })).status, 401);
  assert.equal(seen.length, before);
});

test("the audit holds fixed operation names and granted model ids, never paths, prompts, tokens or credentials", async () => {
  const p = await proxy();
  await raw(p, "/anthropic/v1/messages");
  await raw(p, "/anthropic/attacker-chosen-text/v1/messages");
  await raw(p, "/anthropic/v1/messages", { body: JSON.stringify({ model: "attacker-chosen-model" }) });
  const text = p.log();
  for (const secret of [PROMPT, TOKEN, CREDENTIAL, "attacker-chosen-text", "attacker-chosen-model"]) assert.ok(!text.includes(secret), secret);
  const ops = new Set(p.audit().map((e) => e.op).filter(Boolean));
  assert.deepEqual([...ops].sort(), ["anthropic.messages", "unknown"]);
  assert.equal(p.audit().find((e) => e.event === "end")?.model, "claude-opus-5-5");
});

test("a malformed request target gets a bounded 400 and the proxy keeps serving", async () => {
  const p = await proxy();
  assert.equal((await raw(p, "http://[")).status, 400);
  assert.equal((await raw(p, "*")).status, 400);
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 200);
});

test("CONNECT needs the run token, then an exact allowlist entry, then a public address unless marked private", async () => {
  const p = await proxy();
  assert.deepEqual(await tunnel(p, `localhost:${echoPort}`), { status: 200, echoed: "ping" });
  assert.equal((await tunnel(p, `localhost:${echoPort}`, null)).status, 407);
  assert.equal((await tunnel(p, `localhost:${echoPort}`, "guess")).status, 407);
  assert.equal((await tunnel(p, `example.org:${echoPort}`)).status, 403);
  assert.equal((await tunnel(p, "localhost:1")).status, 403, "the right host on another port");
  assert.equal((await tunnel(p, `127.0.0.1:${echoPort}`)).status, 403, "an IP literal the allowlist doesn't name");
  assert.equal((await tunnel(p, `localhost:${publicOnlyPort}`)).status, 403, "localhost isn't public");
  for (const bad of ["localhost", "localhost:0", "localhost:99999", "[localhost]:443"]) assert.equal((await tunnel(p, bad)).status, 400, bad);
  const denials = p.audit().filter((e) => e.event === "deny").map((e) => e.reason);
  assert.deepEqual(denials.slice(0, 6), ["bad-run-token", "bad-run-token", "not-allowlisted", "not-allowlisted", "not-allowlisted", "non-public-address"]);
});

test("plain HTTP proxying is refused: only CONNECT goes out", async () => {
  const p = await proxy();
  const status = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port: p.ports.connect, path: "http://example.com/" }, (res) => (res.resume(), resolve(res.statusCode ?? 0))));
  assert.equal(status, 405);
});

test("limits: concurrent requests, the request budget, body and response sizes, and tunnels", async () => {
  const p = await proxy({ requests_inflight: 1, requests_total: 3, request_bytes: 1024, tunnels: 1 });
  let release!: () => void;
  hold = new Promise<void>((resolve) => (release = resolve));
  const first = raw(p, "/anthropic/v1/messages");
  for (let i = 0; i < 50 && !p.audit().some((e) => e.event === "accept"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 503, "a second request while one is in flight");
  release();
  hold = Promise.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await raw(p, "/anthropic/v1/messages", { body: JSON.stringify({ model: "claude-opus-5-5", pad: "x".repeat(2048) }) })).status, 413);
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 200);
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 429, "the run's request budget is spent");
  // One tunnel at a time.
  const held = await new Promise<net.Socket>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: p.ports.connect, method: "CONNECT", path: `localhost:${echoPort}`, headers: { "proxy-authorization": `Basic ${Buffer.from(`run:${TOKEN}`).toString("base64")}` } });
    req.on("connect", (_res, socket) => resolve(socket));
    req.end();
  });
  assert.equal((await tunnel(p, `localhost:${echoPort}`)).status, 503);
  held.destroy();
  const small = await proxy({ response_bytes: 10 });
  await raw(small, "/anthropic/v1/messages");
  assert.equal(small.audit().find((e) => e.event === "end")?.result, "limit", "a response over its cap is cut, and says so");
});

test("each accepted request has exactly one end, a cancelled stream included, and the sealed audit reads back whole", async () => {
  const p = await proxy();
  await raw(p, "/anthropic/v1/messages");
  // The client hangs up while the backend is still answering.
  let release!: () => void;
  hold = new Promise<void>((resolve) => (release = resolve));
  const socket = net.connect(p.ports.model, "127.0.0.1");
  socket.on("error", () => {});
  const body = JSON.stringify({ model: "claude-opus-5-5", messages: [] });
  socket.write(`POST /anthropic/v1/messages HTTP/1.1\r\nhost: p\r\ncontent-type: application/json\r\nx-api-key: ${TOKEN}\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
  for (let i = 0; i < 50 && p.audit().filter((e) => e.event === "accept").length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  socket.destroy();
  for (let i = 0; i < 50 && p.audit().filter((e) => e.event === "end").length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  release();
  hold = Promise.resolve();
  assert.deepEqual(p.audit().filter((e) => e.event === "end").map((e) => e.result), ["ok", "cancel"]);
  await p.seal("stopped");
  const audit = readAudit(p.log(), RUN);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.sealed, true);
  assert.equal(audit.model_calls.length, 2);
  assert.notEqual((await raw(p, "/anthropic/v1/messages").catch(() => ({ status: 0 }))).status, 200, "nothing is served after the seal");
});

test("an audit that's cut short, reordered, or full is reported, never taken as whole", async () => {
  const p = await proxy({ audit_bytes: 4000 });
  for (let i = 0; i < 6; i++) await raw(p, "/anthropic/v1/messages");
  assert.equal(p.audit().some((e) => e.event === "audit-full"), true);
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 503, "no new work once the audit can't record it");
  await p.seal("stopped");
  assert.match(readAudit(p.log(), RUN).problems.join(), /budget/);
  const whole = await proxy();
  await raw(whole, "/anthropic/v1/messages");
  await whole.seal("stopped");
  const lines = whole.log().split("\n");
  assert.deepEqual(readAudit(lines.join("\n"), RUN).problems, []);
  assert.match(readAudit(lines.slice(0, -1).join("\n"), RUN).problems.join(), /no closing marker/, "a cut-off tail");
  assert.match(readAudit([lines[0], ...lines.slice(2)].join("\n"), RUN).problems.join(), /expected 2/, "a missing line");
  assert.match(readAudit("", RUN).problems.join(), /no closing marker/, "an empty log");
  assert.match(readAudit(lines.join("\n"), "fedcba987654").problems.join(), /another run/);
});

test("sealing finishes promptly even with a refused CONNECT client still holding its socket open", async () => {
  const p = await proxy();
  const lingering = net.connect(p.ports.connect, "127.0.0.1", () => lingering.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\nhost: x\r\n\r\n`));
  lingering.on("error", () => {});
  lingering.setTimeout(0);
  for (let i = 0; i < 50 && !p.audit().some((e) => e.reason === "bad-run-token"); i++) await new Promise((r) => setTimeout(r, 5));
  const started = Date.now();
  await p.seal("stopped");
  assert.ok(Date.now() - started < 1000, `sealing took ${Date.now() - started} ms`);
  lingering.destroy();
});

test("past its expiry the token is refused and the proxy seals itself", async () => {
  let clock = Date.now();
  const p = await proxy({}, () => clock);
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 200);
  clock += 2 * 3_600_000;
  assert.equal((await raw(p, "/anthropic/v1/messages")).status, 503);
  assert.equal((await tunnel(p, `localhost:${echoPort}`)).status, 503);
  assert.equal(p.audit().filter((e) => e.event === "deny").every((e) => e.reason === "expired"), true);
});

test("non-public addresses are told apart from public ones, IPv4 and IPv6", () => {
  for (const address of ["10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "0.0.0.0", "::1", "::", "fd00:ec2::23", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::"]) {
    assert.equal(isPublic(address), false, address);
  }
  for (const address of ["1.1.1.1", "93.184.215.14", "2606:4700::1111"]) assert.equal(isPublic(address), true, address);
});

test("CONNECT authorities parse to a lowercase host and a port", () => {
  assert.deepEqual(parseAuthority("Example.COM.:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseAuthority("[2606:4700::1111]:443"), { host: "2606:4700::1111", port: 443 });
  assert.equal(parseAuthority("example.com"), null);
  assert.equal(parseAuthority("user@example.com:443"), null);
});
