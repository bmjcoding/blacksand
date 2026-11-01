// A deterministic stand-in for a coding agent, used by the tests. It reads the
// prompt on stdin, edits one file in the repository, makes one allowed and one
// denied call through the proxy, tries CONNECT without the run token, tries to
// go around the proxy (direct connections and DNS), calls the model route with
// the run token, then attacks it: a model outside its grant, and a request
// target that names another host (the first direct target). It also tries to
// hide its edit by replacing the base commit in its own .git, and leaves a
// background process writing to the repository, which only the freeze stops.
// It prints one JSON line saying what happened, and exits 0 only if every call
// went the way the run's policy says it must.
//
// Environment: BLACKSAND_PROXY (the proxy's address), BLACKSAND_RUN_TOKEN,
// BLACKSAND_MODEL, BLACKSAND_FAKE_ALLOWED and BLACKSAND_FAKE_DENIED (host:port),
// BLACKSAND_FAKE_DIRECT (comma-separated ip:port to try without the proxy).
// Self-contained (node:* only): it's shipped into the sandbox as this one file.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { appendFileSync, existsSync, linkSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { connect } from "node:net";
import * as tls from "node:tls";

const env = (name: string) => process.env[name] ?? "";
const proxy = env("BLACKSAND_PROXY");
const CONNECT_PORT = 3128;
const MODEL_PORT = 8080;

function hostPort(text: string): [string, number] {
  const at = text.lastIndexOf(":");
  return [text.slice(0, at), Number(text.slice(at + 1))];
}

const proxyAuth = `Basic ${Buffer.from(`run:${env("BLACKSAND_RUN_TOKEN")}`).toString("base64")}`;

/** CONNECT through the proxy (with the run token unless `anonymous`); for a 200, a TLS GET / over the tunnel. */
function viaProxy(authority: string, anonymous = false): Promise<{ connect: number; https?: number; error?: string }> {
  const [host, port] = hostPort(authority);
  return new Promise((resolve) => {
    const headers = anonymous ? {} : { "proxy-authorization": proxyAuth };
    const req = http.request({ host: proxy, port: CONNECT_PORT, method: "CONNECT", path: `${host}:${port}`, headers, timeout: 15_000 });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ connect: 0, error: error.message }));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return (socket.destroy(), resolve({ connect: res.statusCode ?? 0 }));
      // write, not end: ending sends TLS close_notify, and servers hang up before answering.
      const secure = tls.connect({ socket, servername: host }, () => secure.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let head = "";
      secure.on("data", (chunk: Buffer) => (head += chunk.toString("latin1")));
      secure.on("error", (error) => resolve({ connect: 200, error: error.message }));
      secure.on("end", () => resolve({ connect: 200, https: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0) }));
    });
    req.end();
  });
}

/** A direct TCP connection, bypassing the proxy: the network policy must refuse it. */
function direct(authority: string): Promise<{ target: string; blocked: boolean; error?: string }> {
  const [host, port] = hostPort(authority);
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 3_000 });
    socket.on("connect", () => (socket.destroy(), resolve({ target: authority, blocked: false })));
    socket.on("timeout", () => (socket.destroy(), resolve({ target: authority, blocked: true, error: "timeout" })));
    socket.on("error", (error) => resolve({ target: authority, blocked: true, error: error.message }));
  });
}

async function dns(): Promise<{ blocked: boolean; error?: string }> {
  try {
    await new Resolver({ timeout: 2_000, tries: 1 }).resolve4("example.com");
    return { blocked: false };
  } catch (error) {
    return { blocked: true, error: (error as Error).message };
  }
}

function model(prompt: string, name = env("BLACKSAND_MODEL"), path = "/anthropic/v1/messages"): Promise<{ status: number; model: string | null; error?: string }> {
  const body = JSON.stringify({ model: name, max_tokens: 16, messages: [{ role: "user", content: prompt }] });
  return new Promise((resolve) => {
    const req = http.request({
      host: proxy,
      port: MODEL_PORT,
      method: "POST",
      path,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env("BLACKSAND_RUN_TOKEN") },
      timeout: 15_000,
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, model: null, error: error.message }));
    req.on("response", (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => {
        let id: string | null = null;
        try {
          id = (JSON.parse(text) as { model?: string }).model ?? null;
        } catch {}
        resolve({ status: res.statusCode ?? 0, model: id });
      });
    });
    req.end(body);
  });
}

const prompt = readFileSync(0, "utf8");
const markers = [`${env("HOME")}/.fake-agent-ran`, "/workspace/.fake-agent-ran", "/tmp/.fake-agent-ran"]; // every writable volume
const priorState = markers.filter((path) => existsSync(path));
for (const path of markers) writeFileSync(path, "ran\n");

const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
appendFileSync("FAKE_AGENT.md", `The fake agent ran for prompt ${digest}.\n`);
linkSync("FAKE_AGENT.md", "FAKE_AGENT_LINK.md"); // a second name for the same file: the export must carry its bytes under both

// Try to hide that edit: replace the base commit, in this repository's own .git, with one that already holds it.
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const base = git("rev-parse", "HEAD");
git("add", "--all");
git("replace", base, git("commit-tree", git("write-tree"), "-p", base, "-m", "forged"));
const hidden = git("diff", "--cached", base) === "";

// Leave something running that keeps changing the repository after this process exits.
spawn(process.execPath, ["-e", "setInterval(() => require('fs').appendFileSync('LATE.md', 'still here\\n'), 100)"], { detached: true, stdio: "ignore" }).unref();

const report = {
  edited: "FAKE_AGENT.md",
  prior_state: priorState,
  allowed: { authority: env("BLACKSAND_FAKE_ALLOWED"), ...(await viaProxy(env("BLACKSAND_FAKE_ALLOWED"))) },
  denied: { authority: env("BLACKSAND_FAKE_DENIED"), ...(await viaProxy(env("BLACKSAND_FAKE_DENIED"))) },
  anonymous: await viaProxy(env("BLACKSAND_FAKE_ALLOWED"), true),
  direct: await Promise.all(env("BLACKSAND_FAKE_DIRECT").split(",").filter(Boolean).map(direct)),
  dns: await dns(),
  model: await model(prompt),
  ungranted_model: await model(prompt, "a-model-outside-the-grant"),
  other_host: await model(prompt, env("BLACKSAND_MODEL"), `/anthropic//${env("BLACKSAND_FAKE_DIRECT").split(",")[0] ?? "1.1.1.1:443"}/v1/messages`),
  hid_from_own_git: hidden,
};
const ok =
  report.prior_state.length === 0 &&
  report.allowed.connect === 200 &&
  report.allowed.https !== undefined && report.allowed.https >= 200 && report.allowed.https < 400 &&
  report.denied.connect === 403 &&
  report.direct.length > 0 && report.direct.every((d) => d.blocked) &&
  report.dns.blocked &&
  report.anonymous.connect === 407 &&
  report.model.status === 200 &&
  report.ungranted_model.status === 403 &&
  report.other_host.status === 404;
process.stdout.write(`${JSON.stringify({ fake_agent: { ok, ...report } })}\n`);
process.exitCode = ok ? 0 : 1;
