// Generated-credential HTTPS resource and IdP fixture, also used in the native lab.
// These receivers VERIFY signatures and grants independently of the proxy.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";

export function certificate(dir: string, name: string, names = ["localhost", "proxy.test"]) {
  const key = path.join(dir, `${name}.key`), cert = path.join(dir, `${name}.pem`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=fixture", "-addext", `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`], { stdio: "ignore" });
  return { key, cert };
}
export function jwt(privateKey: string | Buffer, claims: Record<string, unknown>) {
  const data = [Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url")].join(".");
  return `${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`;
}
export function credentialFixture(dir: string) {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  fs.writeFileSync(path.join(dir, "issuer-public.pem"), publicKey);
  const secret = randomBytes(32).toString("base64url");
  fs.writeFileSync(path.join(dir, "client-secret"), secret, { mode: 0o600 });
  const base = { iss: "https://issuer.test/", sub: "eevie", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, jti: randomBytes(12).toString("hex") };
  const plugin = jwt(privateKey, { ...base, aud: "urn:fixture:plugin", scope: "plugin.call", actors: ["expert-1"], cases: ["case-1"] });
  const source = jwt(privateKey, { ...base, aud: "urn:fixture:source", scope: "source.write", repositories: ["fixture/repository"], branches: ["eitl/"] });
  fs.writeFileSync(path.join(dir, "plugin-token"), plugin, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "source-token"), source, { mode: 0o600 });
  return { privateKey, publicKey, secret, plugin, source, base };
}
export interface ResourceConfig { key: string; cert: string; public_key: string; client_secret: string; id_token: string; host: string; port: number }
export async function startResource(config: ResourceConfig) {
  const counts: Record<string, number> = {};
  const observed: { headers: import("node:http").IncomingHttpHeaders; body: Record<string, unknown>; path: string }[] = [];
  const held: (() => void)[] = [];
  const publicKey = fs.readFileSync(config.public_key);
  const server = https.createServer({ key: fs.readFileSync(config.key), cert: fs.readFileSync(config.cert) }, (req, res) => {
    const target = req.url ?? "";
    counts[target] = (counts[target] ?? 0) + 1;
    const answer = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    let raw = "";
    req.on("data", (b: Buffer) => { raw += b.toString(); if (raw.length > 65536) req.destroy(); });
    req.once("end", () => {
      if (target === "/discovery" || target === "/jwks") return void answer(200, { issuer: "https://issuer.test/", keys: [] });
      if (target === "/token") {
        const secret = fs.readFileSync(config.client_secret, "utf8").trim();
        const basic = Buffer.from(`fixture-client:${secret}`).toString("base64");
        const form = Object.fromEntries(new URLSearchParams(raw));
        observed.push({ headers: req.headers, body: form, path: target });
        if (req.method !== "POST" || req.headers.authorization !== `Basic ${basic}` || form.client_id !== "fixture-client" || form.redirect_uri !== "https://client.test/callback" || form.grant_type !== "authorization_code" || !form.code || !form.code_verifier || Object.keys(form).length !== 5) return void answer(401, { error: "invalid_client" });
        return void answer(200, { id_token: config.id_token, access_token: "unused-access-canary", refresh_token: "unused-refresh-canary", token_type: "Bearer" });
      }
      let claims: Record<string, unknown>;
      const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      try {
        const [header = "", payload = "", signature = ""] = token.split(".");
        if (token.split(".").length !== 3 || JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "EdDSA" || !verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) throw new Error();
        claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (claims.iss !== "https://issuer.test/" || claims.sub !== "eevie" || typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 || (claims.nbf !== undefined && Number(claims.nbf) > Date.now() / 1000)) throw new Error();
      } catch { return void answer(401, { error: "invalid_token" }); }
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { return void answer(400, { error: "body" }); }
      observed.push({ headers: req.headers, body, path: target });
      const scopes = String(claims.scope).split(" ");
      if (target === "/v1/source") {
        if (claims.aud !== "urn:fixture:source" || !scopes.includes("source.write") || !Array.isArray(claims.repositories) || !claims.repositories.includes(body.repository) || !Array.isArray(claims.branches) || !claims.branches.some((p) => typeof body.branch === "string" && body.branch.startsWith(String(p)))) return void answer(403, { error: "source_grant" });
      } else if (claims.aud !== "urn:fixture:plugin" || !scopes.includes("plugin.call") || !Array.isArray(claims.actors) || !claims.actors.includes(body.actor) || !Array.isArray(claims.cases) || !claims.cases.includes(body.case)) return void answer(403, { error: "plugin_grant" });
      if (target === "/v1/hold") { held.push(() => answer(200, { ok: true })); return; }
      if (target === "/v1/redirect") { res.writeHead(302, { location: "https://attacker.test/", "content-type": "application/json" }).end("{}"); return; }
      if (target === "/v1/echo") { res.writeHead(200, { "content-type": "application/json", etag: token }).end(JSON.stringify({ echo: token })); return; }
      if (target === "/v1/escaped") return void answer(200, { echo: token });
      if (target === "/v1/encoded") { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end("{}"); return; }
      if (target === "/v1/malformed") { res.writeHead(200, { "content-type": "application/json" }).end("{"); return; }
      if (target === "/v1/large") return void answer(200, { data: "x".repeat(131072) });
      return void answer(200, { ok: true, authorization: "verified", headers: Object.keys(req.headers).sort() });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  return { server, counts, observed, port: (server.address() as net.AddressInfo).port, release: () => held.splice(0).forEach((r) => r()), close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); } };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  const resource = await startResource(JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as ResourceConfig);
  process.once("SIGTERM", () => void resource.close());
}
