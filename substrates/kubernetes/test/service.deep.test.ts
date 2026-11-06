// Real TLS, process death and finite epoch timers belong in the deep tier.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { issueEpoch, prepareService, revokeEpoch, serviceEvidence, startService } from "../src/service.ts";
import { parseServiceConfig } from "../src/service-policy.ts";
import { certificate, credentialFixture, jwt, startResource } from "./fixtures/service-resource.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); } assert.fail("fixture did not reach the expected state"); }
function call(port: number, ca: string, token: string, target = "/intranet/plugin/v1/plugin", body: unknown = { actor: "expert-1", case: "case-1" }, extra: { method?: string; headers?: Record<string, string>; servername?: string; direct?: boolean } = {}): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const data = body === null ? "" : JSON.stringify(body);
    let finished = false;
    const done = (v: { status: number; body: string; error?: string }) => { if (!finished) { finished = true; resolve(v); } };
    const req = https.request({ host: "127.0.0.1", port, servername: extra.servername ?? "localhost", ca: fs.readFileSync(ca), path: target, method: extra.method ?? "POST", agent: false, headers: { host: extra.direct ? "localhost" : "proxy.test", authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(data), connection: "close", ...extra.headers } }, (res) => {
      let received = "";
      res.on("data", (b: Buffer) => { received += b.toString(); });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: received }));
      res.on("aborted", () => done({ status: res.statusCode ?? 0, body: received, error: "aborted" }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("fixture-timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => done({ status: 0, body: "", error: e.code ?? e.message }));
    req.end(data);
  });
}
async function harness(t: TestContext, options: { maxSegments?: number; record?: (line: string) => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-service-"));
  const tls = certificate(dir, "server");
  const wrongTls = certificate(dir, "wrong");
  const credentials = credentialFixture(dir);
  const idToken = jwt(credentials.privateKey, { ...credentials.base, aud: "fixture-client", nonce: "fixture-nonce" });
  const resource = await startResource({ key: tls.key, cert: tls.cert, public_key: path.join(dir, "issuer-public.pem"), client_secret: path.join(dir, "client-secret"), id_token: idToken, host: "127.0.0.1", port: 0 });
  const pluginBody = { fields: ["actor", "case"], required: ["actor", "case"], values: { actor: ["expert-1"] }, prefixes: {} };
  const endpoint = { name: "plugin", url: `https://localhost:${resource.port}/`, private: true, ca_file: tls.cert, auth: { kind: "bearer", token_file: path.join(dir, "plugin-token"), audience: "urn:fixture:plugin", issuer: "https://issuer.test/", subject: "eevie", scopes: ["plugin.call"] }, operations: ["plugin", "hold", "redirect", "echo", "escaped", "encoded", "malformed", "large"].map((n) => ({ id: n, method: "POST", path: `/v1/${n}`, body: pluginBody })) };
  const raw = { schema: "run.blacksand.service-proxy/1", service: "eevie", listen: { host: "127.0.0.1", port: 0, authority: "proxy.test", cert_file: tls.cert, key_file: tls.key }, control_file: path.join(dir, "epoch.json"), audit_dir: path.join(dir, "audit"), max_segments: options.maxSegments ?? 16, limits: { request_seconds: 2, response_bytes: 65536, request_bytes: 32768, requests_total: 100 }, models: [], endpoints: [endpoint, { ...endpoint, name: "source", auth: { ...endpoint.auth, token_file: path.join(dir, "source-token"), audience: "urn:fixture:source", scopes: ["source.write"] }, operations: [{ id: "write", method: "POST", path: "/v1/source", body: { fields: ["repository", "branch"], required: ["repository", "branch"], values: { repository: ["fixture/repository"] }, prefixes: { branch: "eitl/" } } }] }, { name: "idp", url: endpoint.url, private: true, ca_file: tls.cert, auth: { kind: "oidc", client_id: "fixture-client", client_secret_file: path.join(dir, "client-secret"), redirect_uri: "https://client.test/callback" }, operations: [{ id: "authorization-code", method: "POST", path: "/token" }] }, { name: "public-idp", url: endpoint.url, private: true, ca_file: tls.cert, auth: { kind: "public" }, operations: [{ id: "discovery", method: "GET", path: "/discovery" }, { id: "jwks", method: "GET", path: "/jwks" }] }] };
  const config = parseServiceConfig(raw);
  prepareService(config);
  const capabilityFile = path.join(dir, "capability.json");
  issueEpoch(config, capabilityFile, 60);
  const capability = () => (JSON.parse(fs.readFileSync(capabilityFile, "utf8")) as { token: string }).token;
  const service = await startService(config, { poll_ms: 50000, ...(options.record ? { record: options.record } : {}) });
  const request = (target?: string, body?: unknown, extra?: Parameters<typeof call>[5]) => call(service.status().port, tls.cert, capability(), target, body, extra);
  t.after(async () => { await service.close(); await resource.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, tls, wrongTls, credentials, idToken, resource, config, raw, service, request, capability, capabilityFile };
}

test("HTTPS resource authentication, closed operations, actor and source grants, credential isolation", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request()).status, 200);
  const success = await h.request("/intranet/source/v1/source", { repository: "fixture/repository", branch: "eitl/change" }, { headers: { cookie: "session=client", "x-api-key": "caller-key", "x-forwarded-host": "attacker.test", "proxy-authorization": "caller-auth" } });
  assert.equal(success.status, 200);
  const seen = h.resource.observed.at(-1)!;
  assert.equal(seen.headers.authorization, `Bearer ${h.credentials.source}`);
  for (const key of ["cookie", "x-api-key", "x-forwarded-host", "proxy-authorization"]) assert.equal(seen.headers[key], undefined);
  for (const target of ["/intranet/plugin/v1/plugin?x=1", "/intranet/plugin/v1/plugin?", "/intranet/plugin/v1/%70lugin", "/intranet/plugin/v1/../v1/plugin", "/intranet/plugin//v1/plugin", "/intranet/plugin/v1/plugin/extra", "/intranet/other/v1/plugin", "https://attacker.test/v1/plugin"]) assert.notEqual((await h.request(target)).status, 200, target);
  assert.equal((await h.request(undefined, undefined, { method: "PUT" })).status, 403);
  assert.equal((await h.request(undefined, undefined, { headers: { host: "attacker.test" } })).status, 400);
  assert.equal((await call(h.service.status().port, h.tls.cert, "wrong")).status, 401);
  for (const body of [{ actor: "expert-2", case: "case-1" }, { actor: "expert-1" }, { actor: "expert-1", case: "case-1", destination: "https://attacker.test" }]) assert.equal((await h.request(undefined, body)).status, 403);
  for (const body of [{ repository: "other/repository", branch: "eitl/change" }, { repository: "fixture/repository", branch: "main" }, { repository: "fixture/repository", branch: "eitl/../main" }]) assert.equal((await h.request("/intranet/source/v1/source", body)).status, 403);
  // The receiver, not just a proxy claim check, independently rejects signed
  // but insufficient authority (including a valid proxy hop with a bad case).
  assert.equal((await h.request(undefined, { actor: "expert-1", case: "case-2" })).status, 403);
  for (const body of [{ repository: "other/repository", branch: "eitl/change" }, { repository: "fixture/repository", branch: "main" }]) assert.equal((await call(h.resource.port, h.tls.cert, h.credentials.source, "/v1/source", body, { direct: true })).status, 403);
  const tokenFile = path.join(h.dir, "plugin-token");
  const claims = { ...h.credentials.base, aud: "urn:fixture:plugin", scope: "plugin.call", actors: ["expert-1"], cases: ["case-1"] };
  for (const patch of [{ exp: Math.floor(Date.now() / 1000) - 1 }, { aud: "wrong" }, { aud: ["urn:fixture:plugin", "another"] }, { iss: "wrong" }, { sub: "other" }, { scope: "unrelated" }, { nbf: Date.now() / 1000 + 100 }]) {
    fs.writeFileSync(tokenFile, jwt(h.credentials.privateKey, { ...claims, ...patch }));
    assert.equal((await h.request()).status, 502);
  }
  const other = credentialFixture(fs.mkdtempSync(path.join(h.dir, "issuer-")));
  fs.writeFileSync(tokenFile, jwt(other.privateKey, claims));
  assert.equal((await h.request()).status, 401, "receiver rejects a forged signature even though decoded claims pass proxy checks");
  const rotated = jwt(h.credentials.privateKey, { ...claims, jti: "rotated" });
  fs.writeFileSync(tokenFile, rotated);
  assert.equal((await h.request()).status, 200);
  assert.equal(h.resource.observed.at(-1)!.headers.authorization, `Bearer ${rotated}`);
  fs.unlinkSync(tokenFile);
  assert.equal((await h.request()).status, 502);
  await h.service.close();
  const log = fs.readdirSync(h.config.audit_dir).filter((n) => n.endsWith("jsonl")).map((n) => fs.readFileSync(path.join(h.config.audit_dir, n), "utf8")).join("");
  for (const secret of [h.capability(), h.credentials.plugin, h.credentials.source, h.credentials.secret, rotated, "caller-key", "case-1"]) assert.ok(!log.includes(secret));
  assert.ok(log.includes("plugin.plugin"));
  assert.ok(serviceEvidence(h.config).every((e) => e.complete));
});

test("TLS verification, exact numeric destinations, no redirects or reflected/malformed/encoded credentials", async (t) => {
  const h = await harness(t);
  const request = () => h.request();
  assert.equal((await call(h.service.status().port, h.wrongTls.cert, h.capability())).status, 0);
  assert.equal((await call(h.service.status().port, h.tls.cert, h.capability(), undefined, undefined, { servername: "wrong.test" })).status, 0);
  for (const name of ["redirect", "echo", "escaped", "encoded", "malformed", "large"]) {
    const r = await h.request(`/intranet/plugin/v1/${name}`);
    assert.equal(r.status, 502, name);
    assert.ok(!r.body.includes(h.credentials.plugin));
  }
  const endpoint = h.config.endpoints[0]!;
  endpoint.ca_file = h.wrongTls.cert;
  assert.equal((await request()).status, 502);
  endpoint.ca_file = h.tls.cert;
  endpoint.origin = endpoint.origin.replace("localhost", "127.0.0.1");
  assert.equal((await request()).status, 502, "hostname mismatch even with trusted CA");
  endpoint.private = false;
  assert.equal((await request()).status, 403, "IP literals cannot bypass public-address filtering");
  endpoint.origin = endpoint.origin.replace("127.0.0.1", "localhost");
  assert.equal((await request()).status, 502, "DNS answers require explicit private entry");
  endpoint.private = true;
  endpoint.origin = "https://[::1]:8444";
  endpoint.private = false;
  assert.equal((await request()).status, 403, "IPv6 literals cannot bypass address filtering");
  endpoint.private = true;
  endpoint.origin = `https://localhost:${h.resource.port}`;
  const original = endpoint.origin;
  endpoint.origin = "https://localhost:1";
  assert.equal((await request()).status, 502, "no port fallback");
  endpoint.origin = original;
  assert.equal((await request()).status, 200);
});

test("fixed confidential OIDC code exchange authenticates to IdP, preserves PKCE and filters tokens", async (t) => {
  const h = await harness(t);
  const input = { code: "code+with/special=values", code_verifier: "A".repeat(43) };
  const r = await h.request("/intranet/idp/token", input);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { id_token: h.idToken });
  const seen = h.resource.observed.at(-1)!;
  assert.equal(seen.body.code, input.code);
  assert.equal(seen.body.code_verifier, input.code_verifier);
  assert.equal(seen.body.client_id, "fixture-client");
  assert.equal(seen.body.redirect_uri, "https://client.test/callback");
  assert.equal(seen.body.grant_type, "authorization_code");
  assert.ok(!r.body.includes(h.credentials.secret) && !r.body.includes("unused-"));
  const before = h.resource.counts["/token"];
  for (const field of ["client_id", "redirect_uri", "grant_type", "client_secret", "audience", "resource", "token_endpoint", "scope"]) assert.equal((await h.request("/intranet/idp/token", { ...input, [field]: "caller-selected" })).status, 400);
  assert.equal((await h.request("/intranet/idp/token", { ...input, code_verifier: "short" })).status, 400);
  assert.equal(h.resource.counts["/token"], before);
  assert.equal((await h.request("/intranet/public-idp/discovery", null, { method: "GET" })).status, 200);
  assert.equal((await h.request("/intranet/public-idp/jwks", null, { method: "GET" })).status, 200);
  fs.writeFileSync(path.join(h.dir, "client-secret"), "rotated-client-secret");
  assert.equal((await h.request("/intranet/idp/token", input)).status, 200);
});

test("rotation kills active requests/sockets, revocation persists, restart and rollback fence epochs", async (t) => {
  const h = await harness(t);
  h.config.limits.request_seconds = 10; // Cancellation must beat the whole-request timeout.
  const original = h.capability();
  const held = h.request("/intranet/plugin/v1/hold");
  await until(() => h.resource.counts["/v1/hold"] === 1);
  issueEpoch(h.config, h.capabilityFile, 60);
  await h.service.refresh();
  assert.equal((await held).status, 0);
  assert.equal((await call(h.service.status().port, h.tls.cert, original)).status, 401);
  assert.equal((await h.request()).status, 200);
  const oldControl = fs.readFileSync(h.config.control_file);
  revokeEpoch(h.config);
  await h.service.refresh();
  assert.equal((await h.request()).status, 0);
  fs.writeFileSync(h.config.control_file, oldControl);
  await h.service.refresh();
  assert.equal(h.service.status().error, "epoch-rollback");
  await h.service.close();
  issueEpoch(h.config, h.capabilityFile, 60);
  const restarted = await startService(h.config);
  assert.equal((await call(restarted.status().port, h.tls.cert, h.capability())).status, 200);
  await restarted.close();
  const evidence = serviceEvidence(h.config);
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((e) => e.complete));
  const file = path.join(h.config.audit_dir, "0000000002.jsonl");
  const old = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, old.replace('"service":"eevie"', '"service":"other"'));
  assert.ok(serviceEvidence(h.config).some((e) => !e.complete));
});

test("audit sink failure stops admission before forwarding; finite segment capacity refuses new epochs", async (t) => {
  let fail = false;
  const h = await harness(t, { record: (line) => { if (fail && line.includes('"event":"accept"')) throw new Error("private diagnostic must not escape"); } });
  fail = true;
  const r = await h.request();
  assert.equal(r.status, 0);
  assert.equal(h.resource.counts["/v1/plugin"], undefined);
  await h.service.close();
  assert.ok(serviceEvidence(h.config).some((e) => !e.complete));
  const capacity = await harness(t, { maxSegments: 1 });
  assert.equal((await capacity.request()).status, 200);
  issueEpoch(capacity.config, capacity.capabilityFile, 60);
  await capacity.service.refresh();
  assert.equal(capacity.service.status().error, "audit-capacity");
  assert.equal((await capacity.request()).status, 0);
});

test("whole-call deadline, request budget and audit byte exhaustion remain finite", async (t) => {
  const h = await harness(t);
  const at = performance.now();
  assert.equal((await h.request("/intranet/plugin/v1/hold")).status, 0);
  assert.ok(performance.now() - at < 2900);
  h.config.limits.requests_total = 1;
  assert.equal((await h.request()).status, 429);
  h.config.limits.requests_total = 100;
  h.config.limits.audit_bytes = 4096;
  for (let i = 0; i < 40; i++) { if ((await h.request()).status === 0) break; }
  await h.service.close();
  const raw = fs.readFileSync(path.join(h.config.audit_dir, "0000000001.jsonl"), "utf8");
  assert.ok(Buffer.byteLength(raw) <= 4096);
  assert.ok(raw.includes("audit-full"));
  assert.ok(serviceEvidence(h.config).some((e) => !e.complete));
});

test("actual serve process crash leaves incomplete evidence; restart preserves chain and old finite capability", async (t) => {
  const h = await harness(t);
  await h.service.close();
  // Choose a fixed free port for the actual process.
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  h.raw.listen.port = port;
  const file = path.join(h.dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(h.raw));
  let output = "";
  const launch = () => {
    const child = spawn(process.execPath, [new URL("../src/service.ts", import.meta.url).pathname, "serve", file], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => { output += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { output += b.toString(); });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    return child;
  };
  let child = launch();
  for (let i = 0; ; i++) { if ((await call(port, h.tls.cert, h.capability())).status === 200) break; assert.ok(i < 100); await pause(10); }
  const died = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL"); await died;
  assert.ok(serviceEvidence(h.config).some((e) => !e.complete));
  child = launch();
  for (let i = 0; ; i++) { if ((await call(port, h.tls.cert, h.capability())).status === 200) break; assert.ok(i < 100); await pause(10); }
  const stopped = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM"); await stopped;
  const evidence = serviceEvidence(h.config);
  assert.equal(evidence.length, 3);
  assert.equal(evidence[1]!.complete, false);
  assert.equal(evidence[2]!.complete, true);
  assert.ok(!output.includes(h.capability()) && !output.includes(h.credentials.secret));
  assert.equal(output, "");
});

test("capability expiry is finite, rejects extension of an epoch and closes idle TLS sockets", async (t) => {
  const h = await harness(t);
  const old = h.capability();
  issueEpoch(h.config, h.capabilityFile, 1);
  await h.service.refresh();
  const current = h.capability();
  assert.equal((await call(h.service.status().port, h.tls.cert, old)).status, 401);
  assert.equal((await call(h.service.status().port, h.tls.cert, current)).status, 200);
  const tls = await import("node:tls");
  const idle = tls.connect({ host: "127.0.0.1", port: h.service.status().port, servername: "localhost", ca: fs.readFileSync(h.tls.cert) });
  idle.on("error", () => {});
  const closed = new Promise<void>((r) => idle.once("close", () => r()));
  await closed;
  assert.equal((await call(h.service.status().port, h.tls.cert, current)).status, 0);
  const control = JSON.parse(fs.readFileSync(h.config.control_file, "utf8"));
  control.expires_at = Date.now() + 60000;
  fs.writeFileSync(h.config.control_file, JSON.stringify(control));
  await h.service.refresh();
  assert.equal(h.service.status().error, "epoch-rollback");
});

test("service model listener retains explicit model/body grants, TLS, key rotation and no CONNECT default", async (t) => {
  const h = await harness(t);
  const keyFile = path.join(h.dir, "model-key");
  const key = "generated-model-credential-canary-0123456789";
  fs.writeFileSync(keyFile, key);
  const seen: { auth: string; body: any }[] = [];
  let mode = "normal";
  const backend = https.createServer({ key: fs.readFileSync(h.tls.key), cert: fs.readFileSync(h.tls.cert) }, (req, res) => {
    let raw = "";
    req.on("data", (b: Buffer) => { raw += b.toString(); });
    req.on("end", () => {
      seen.push({ auth: String(req.headers.authorization), body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json", ...(mode === "encoded" ? { "content-encoding": "gzip" } : {}) }).end(JSON.stringify({ model: "fixture-model", output: mode === "reflect" ? [String(req.headers.authorization)] : [] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  await h.service.close();
  h.config.models = [{ name: "openai", origin: `https://localhost:${(backend.address() as import("node:net").AddressInfo).port}`, base_path: "", header: "authorization", secret_file: keyFile, models: ["fixture-model"], ca_file: h.tls.cert, private: true }];
  issueEpoch(h.config, h.capabilityFile, 60);
  const service = await startService(h.config);
  t.after(() => service.close());
  const modelCall = (body: unknown) => call(service.status().port, h.tls.cert, h.capability(), "/openai/v1/responses", body);
  assert.equal((await modelCall({ model: "fixture-model", input: "hello" })).status, 200);
  assert.equal(seen[0]!.auth, `Bearer ${key}`);
  assert.equal(seen[0]!.body.store, false);
  assert.equal((await modelCall({ model: "other-model", input: "hello" })).status, 403);
  assert.equal((await modelCall({ model: "fixture-model", input: "hello", tools: [{ type: "web_search" }] })).status, 403);
  fs.writeFileSync(keyFile, "rotated-model-key");
  assert.equal((await modelCall({ model: "fixture-model", input: "hello" })).status, 200);
  assert.equal(seen.at(-1)!.auth, "Bearer rotated-model-key");
  for (const bad of ["reflect", "encoded"]) {
    mode = bad;
    const answer = await modelCall({ model: "fixture-model", input: "hello" });
    assert.ok(answer.status === 0 || answer.error === "aborted");
    assert.ok(!answer.body.includes("rotated-model-key"));
  }
  assert.equal((await call(service.status().port, h.tls.cert, h.capability(), "localhost:443", null, { method: "CONNECT" })).status, 0);
});

test("service model credentials cannot escape through transfer coding, JSON escapes or audit metadata", async (t) => {
  const h = await harness(t);
  await h.service.close();
  const keyFile = path.join(h.dir, "model-key");
  let secret = "fixture-model-credential-0123456789";
  let mode = "normal";
  let reflected = "";
  const secrets: string[] = [];
  const backend = https.createServer({ key: fs.readFileSync(h.tls.key), cert: fs.readFileSync(h.tls.cert) }, (req, res) => {
    req.resume();
    req.on("end", () => {
      assert.ok(req.headers.authorization === `Bearer ${secret}`);
      if (mode === "transfer-gzip") {
        res.writeHead(401, { "content-type": "application/json", "transfer-encoding": "gzip, chunked" }).end(gzipSync(JSON.stringify({ error: secret })));
        return;
      }
      if (mode === "header-percent") {
        res.writeHead(200, { "content-type": "application/json", "request-id": encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (triplet) => triplet.toLowerCase()) }).end(JSON.stringify({ model: "fixture-model", output: [] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (mode === "normal") { res.end(JSON.stringify({ model: "fixture-model", output: [] })); return; }
      if (mode === "near-percent" || mode === "near-case") { res.end(JSON.stringify({ model: "fixture-model", output: [mode === "near-percent" ? secret.replace("%2f", "%2F") : encodeURIComponent(secret).replace("AbC", "abc")] })); return; }
      if (mode === "audit-model") { reflected = secret; res.end(JSON.stringify({ model: secret, output: [] })); return; }
      let text = mode.startsWith("url") ? encodeURIComponent(secret) : mode.startsWith("form") ? new URLSearchParams({ v: secret }).toString().slice(2) : mode === "base64" ? Buffer.from(secret).toString("base64") : secret;
      if (mode.includes("lower")) text = text.replace(/%[0-9A-F]{2}/g, (triplet) => triplet.toLowerCase());
      if (mode.includes("mixed")) { let at = 0; text = text.replace(/%[0-9A-F]{2}/g, (triplet) => triplet.replace(/[A-F]/g, (hex) => at++ % 2 ? hex : hex.toLowerCase())); }
      let encoded = JSON.stringify(text).slice(1, -1);
      if (mode === "slash") encoded = encoded.replaceAll("/", "\\/");
      if (mode === "unicode" || mode === "mixed" || mode.endsWith("-json")) encoded = [...text].map((ch, i) => mode === "unicode" || i % 2 === 0 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}` : JSON.stringify(ch).slice(1, -1)).join("");
      reflected = encoded;
      // Forward a long harmless prefix before the key: a guard that only checks
      // one chunk or waits for an ordinary serializer spelling cannot pass.
      res.write(`{"model":"fixture-model","padding":"${"x".repeat(4096)}","error":"`);
      void (async () => {
        for (let at = 0; at < encoded.length; at += 3) { if (res.destroyed) return; res.write(encoded.slice(at, at + 3)); await pause(1); }
        res.end('"}');
      })();
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  h.config.models = [{ name: "openai", origin: `https://localhost:${(backend.address() as import("node:net").AddressInfo).port}`, base_path: "", header: "authorization", secret_file: keyFile, models: ["fixture-model"], ca_file: h.tls.cert, private: true }];
  fs.writeFileSync(keyFile, secret);
  issueEpoch(h.config, h.capabilityFile, 60);
  const service = await startService(h.config);
  const request = () => call(service.status().port, h.tls.cert, h.capability(), "/openai/v1/responses", { model: "fixture-model", input: "hello" });
  try {
    assert.equal((await request()).status, 200);
    for (const variant of ["transfer-gzip", "json", "slash", "unicode", "mixed", "url", "form", "base64", "audit-model", "url-lower", "form-lower", "url-mixed", "form-mixed", "url-lower-json", "form-mixed-json", "header-percent"]) {
      mode = variant;
      secret = variant === "audit-model" ? "fixture-audit-credential-0123456789" : 'Fixture/Credential-0123+"\\%2fTail';
      secrets.push(secret);
      fs.writeFileSync(keyFile, secret);
      reflected = "";
      const answer = await request();
      assert.ok(answer.status === 0 || answer.error === "aborted", variant);
      assert.ok(!answer.body.includes(secret), variant);
      if (reflected) assert.ok(!answer.body.includes(reflected.slice(0, Math.ceil(reflected.length / 2))), variant);
      if (variant !== "transfer-gzip" && variant !== "audit-model" && variant !== "header-percent") assert.ok(answer.body.includes("x".repeat(1024)), "a harmless prefix still streams before the later refusal");
    }
    for (const positive of ["near-percent", "near-case"]) {
      mode = positive;
      secret = "Fixture/%2f+AbC";
      fs.writeFileSync(keyFile, secret);
      const answer = await request();
      assert.equal(answer.status, 200, "literal credential case stays significant");
      assert.deepEqual(JSON.parse(answer.body), { model: "fixture-model", output: [positive === "near-percent" ? "Fixture/%2F+AbC" : encodeURIComponent(secret).replace("AbC", "abc")] });
    }
    // A clean reply after every refused representation still delivers metadata.
    mode = "normal";
    assert.deepEqual(JSON.parse((await request()).body), { model: "fixture-model", output: [] });
  } finally { await service.close(); }
  const log = fs.readdirSync(h.config.audit_dir).filter((n) => n.endsWith("jsonl")).map((n) => fs.readFileSync(path.join(h.config.audit_dir, n), "utf8")).join("");
  for (const key of secrets) assert.ok(!log.includes(key) && !log.includes(JSON.stringify(key).slice(1, -1)));
  const events = log.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((e) => e.event === "end" && e.result === "ok" && e.returned_model === "fixture-model"));
  assert.ok(events.some((e) => e.event === "end" && e.result === "error" && e.returned_model === null));
  assert.ok(serviceEvidence(h.config).every((e) => e.complete));
});

test("public and authenticated HEAD operations accept bodyless replies and check reflected headers", async (t) => {
  const h = await harness(t);
  await h.service.close();
  let reflect = false;
  const backend = https.createServer({ key: fs.readFileSync(h.tls.key), cert: fs.readFileSync(h.tls.cert) }, (req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { etag: reflect ? String(req.headers.authorization) : "fixture-etag" }).end());
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  for (const kind of ["public", "bearer"]) h.config.endpoints.push({ ...h.config.endpoints[0]!, name: `head-${kind}`, origin: `https://localhost:${(backend.address() as import("node:net").AddressInfo).port}`, auth: kind === "public" ? { kind: "public" } : h.config.endpoints[0]!.auth, operations: [{ id: "head", method: "HEAD", path: "/health", query: false }] });
  issueEpoch(h.config, h.capabilityFile, 60);
  const service = await startService(h.config);
  try {
    for (const kind of ["public", "bearer"]) {
      const answer = await call(service.status().port, h.tls.cert, h.capability(), `/intranet/head-${kind}/health`, null, { method: "HEAD" });
      assert.equal(answer.status, 200);
      assert.equal(answer.body, "");
    }
    reflect = true;
    const refused = await call(service.status().port, h.tls.cert, h.capability(), "/intranet/head-bearer/health", null, { method: "HEAD" });
    assert.equal(refused.status, 502);
    assert.equal(refused.body, "");
  } finally { await service.close(); }
  const log = fs.readdirSync(h.config.audit_dir).filter((n) => n.endsWith("jsonl")).map((n) => fs.readFileSync(path.join(h.config.audit_dir, n), "utf8")).join("");
  assert.ok(!log.includes(h.credentials.plugin));
  assert.ok(serviceEvidence(h.config).every((e) => e.complete));
});


test("the supervisor itself has a finite serve lifetime", async (t) => {
  const h = await harness(t);
  await h.service.close();
  h.config.serve_seconds = 1;
  const finite = await startService(h.config);
  t.after(() => finite.close());
  await until(() => finite.status().stopped);
  assert.equal((await call(finite.status().port, h.tls.cert, h.capability())).status, 0);
  await finite.close();
  assert.ok(serviceEvidence(h.config).every((e) => e.complete));
});


test("audit tail loss and partial allocation cannot be reported as complete or silently reused", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request()).status, 200);
  await h.service.close();
  const file = path.join(h.config.audit_dir, "0000000001.jsonl");
  const raw = fs.readFileSync(file);
  fs.unlinkSync(file);
  assert.throws(() => serviceEvidence(h.config), /audit-order/);
  await assert.rejects(startService(h.config), /audit-order/);
  fs.writeFileSync(file, raw);
  assert.ok(serviceEvidence(h.config).every((e) => e.complete));
  fs.writeFileSync(path.join(h.config.audit_dir, "segments.json"), JSON.stringify({ allocated: 0 }));
  assert.ok(serviceEvidence(h.config).some((e) => !e.complete));
});

test("service admission bounds concurrent body/request work and oversized JSON before credentials", async (t) => {
  const h = await harness(t);
  h.config.limits.requests_inflight = 1;
  const held = h.request("/intranet/plugin/v1/hold");
  await until(() => h.resource.counts["/v1/hold"] === 1);
  assert.equal((await h.request()).status, 503);
  h.resource.release();
  assert.equal((await held).status, 200);
  const before = h.resource.counts["/v1/plugin"] ?? 0;
  assert.equal((await h.request(undefined, { actor: "expert-1", case: "x".repeat(40000) })).status, 413);
  assert.equal(h.resource.counts["/v1/plugin"] ?? 0, before);
});
