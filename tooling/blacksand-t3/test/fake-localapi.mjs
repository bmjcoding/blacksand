// A fake tailscaled LocalAPI (serve-config and status) on a unix socket, for the
// tests of scripts/host-common.sh and its callers: GET returns the configuration with an ETag; POST
// writes it only if If-Match names the current one, else 412, as
// ipn/localapi/serve.go does. Requests with another Host, an Origin or a
// Referer are refused, as tailscaled refuses them.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A tailscaled LocalAPI with only serve-config. `afterGet(n, config)` may return
 * a new configuration right after the n-th GET (another client writing in
 * between), `afterPost(config)` one right after an accepted write; `failGet`,
 * `noEtag`, `body` fault the GET. `status` is what /localapi/v0/status answers;
 * `hang` accepts every connection and never answers.
 */
export async function localApi(initial, { afterGet, afterPost, failGet = false, noEtag = false, body, status = null, hang = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-lapi-"));
  const socket = path.join(dir, "tailscaled.socket");
  let config = initial;
  let gets = 0;
  const posts = [];
  const etag = () => `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
  const server = http.createServer((req, res) => {
    if (hang) return; // accepts, never answers: a stuck tailscaled
    if (req.headers.host !== "local-tailscaled.sock" || req.headers.origin || req.headers.referer) return res.writeHead(403).end("bad host");
    if (req.url === "/localapi/v0/status" && req.method === "GET") {
      if (!status) return res.writeHead(503).end("no status");
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(status));
    }
    if (req.url !== "/localapi/v0/serve-config") return res.writeHead(404).end();
    if (req.method === "GET") {
      gets++;
      if (failGet) return res.writeHead(500).end("tailscaled is starting");
      if (!noEtag) res.setHeader("Etag", etag());
      res.writeHead(200, { "Content-Type": "application/json" }).end(body ?? JSON.stringify(config));
      const next = afterGet?.(gets, config);
      if (next) config = next;
      return;
    }
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      posts.push({ ifMatch: req.headers["if-match"], body: data });
      if (req.headers["if-match"] !== etag()) return res.writeHead(412).end("etag mismatch");
      config = JSON.parse(data);
      config = afterPost?.(config) ?? config;
      res.writeHead(200).end();
    });
  });
  // A hung daemon's connections stay open: don't let them keep close() waiting.
  const sockets = new Set();
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise((resolve) => server.listen(socket, resolve));
  return { socket, env: { BLACKSAND_T3_TAILSCALED_SOCKET: socket }, config: () => config, posts, gets: () => gets, close: () => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(r))) };
}

