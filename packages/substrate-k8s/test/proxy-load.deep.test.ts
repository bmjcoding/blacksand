// Deep: a burst of concurrent requests and tunnels at one proxy, on loopback.
// Deep because it opens hundreds of sockets and runs for seconds.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";

import { readAudit } from "../src/audit.ts";
import { DEFAULT_LIMITS } from "../src/policy.ts";
import { startProxy } from "../sandbox/proxy.ts";

test("under a burst of 200 requests, the backend never sees more at once than the limit, and every request is accounted for", async () => {
  let inFlight = 0;
  let most = 0;
  const backend = http.createServer((req, res) => {
    inFlight++;
    most = Math.max(most, inFlight);
    req.resume();
    req.on("end", () => setTimeout(() => (inFlight--, res.end('{"model":"m"}')), 20));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "substrate-k8s-load-")), "key");
  fs.writeFileSync(keyFile, "k");
  const lines: string[] = [];
  const out = new Writable({ write: (chunk: Buffer, _e, done) => (lines.push(...chunk.toString().split("\n").filter(Boolean)), done()) });
  const port = (backend.address() as net.AddressInfo).port;
  const proxy = await startProxy(
    {
      run: "abcdef012345",
      expires_at: Date.now() + 600_000,
      token_sha256: createHash("sha256").update("t").digest("hex"),
      limits: { ...DEFAULT_LIMITS, requests_inflight: 8 },
      connect: { port: 0, allow: [] },
      model: { port: 0, routes: [{ name: "anthropic", origin: `http://127.0.0.1:${port}`, base_path: "", header: "x-api-key", secret_file: keyFile, models: ["m"] }] },
    },
    { host: "127.0.0.1", out },
  );
  // Under the OS's listen backlog (128 on macOS), so every connection reaches the proxy rather than being reset by the kernel.
  const agent = new http.Agent({ maxSockets: 100 });
  const send = () =>
    new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.ports.model, method: "POST", path: "/anthropic/v1/messages", agent, headers: { "content-type": "application/json", "x-api-key": "t" } }, (res) => (res.resume(), res.on("end", () => resolve(res.statusCode ?? 0))));
      req.on("error", () => resolve(0));
      req.end('{"model":"m","messages":[]}');
    });
  const statuses = await Promise.all(Array.from({ length: 200 }, send));
  await proxy.seal("stopped");
  backend.close();
  agent.destroy();
  assert.ok(most <= 8, `the backend saw ${most} at once`);
  assert.ok(statuses.filter((s) => s === 200).length >= 8);
  // 503: refused by the request limit; 0: a connection past the connection limit, closed as it arrived.
  assert.ok(statuses.every((s) => s === 200 || s === 503 || s === 0), [...new Set(statuses)].join());
  const audit = readAudit(lines.join("\n"), "abcdef012345");
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.model_calls.length + audit.denied, 200, "each request is one accepted call or one refusal");
});
