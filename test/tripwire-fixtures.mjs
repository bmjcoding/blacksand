// Shared by the tripwire tests: local receivers that count what reaches them, and
// node processes run with lib/files/tripwire.cjs preloaded as the smoke test does.
import { spawn } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export const TRIPWIRE = fs.realpathSync(new URL("../lib/files/tripwire.cjs", import.meta.url));
export const CURL = ["/usr/bin/curl", "/opt/homebrew/bin/curl", "/usr/local/bin/curl"].find((file) => fs.existsSync(file));

/** A DNS server that answers NXDOMAIN and an HTTP receiver, recording what reaches them. */
export async function receivers() {
  const seen = { dns: [], http: [] };
  const dns = dgram.createSocket("udp4");
  dns.on("message", (message, remote) => {
    seen.dns.push(message.subarray(12).toString("latin1"));
    const answer = Buffer.from(message);
    answer[2] = 0x81;
    answer[3] = 0x83;
    dns.send(answer, remote.port, remote.address);
  });
  const web = http.createServer((req, res) => {
    seen.http.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    dnsPort: dns.address().port,
    url: (name) => `http://127.0.0.1:${web.address().port}/${name}`,
    close: () => Promise.all([new Promise((r) => dns.close(r)), new Promise((r) => web.close(r))]),
  };
}

export const scratch = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `t3b-tripwire-${name}-`));

/**
 * Runs `code` in a node with the tripwire in NODE_OPTIONS (or, with `cli`, on the
 * command line only), in `cwd`; resolves the attempts it logged.
 */
export async function tripped(code, { cli = false, cwd = scratch("run"), home = cwd, PATH = process.env.PATH } = {}) {
  const logDir = scratch("log");
  const log = path.join(logDir, "tripwire.jsonl");
  const child = spawn(process.execPath, [...(cli ? ["--require", TRIPWIRE] : []), "-e", code], {
    cwd,
    env: { PATH, HOME: home, ...(cli ? {} : { NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}` }), T3BLACKOUT_TRIPWIRE_LOG: log },
    stdio: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  fs.rmSync(logDir, { recursive: true, force: true });
  return attempts;
}

/** A preload that asks the local DNS server for `name` as soon as it's loaded. */
export function earlyPreload(dnsPort, name) {
  const file = path.join(scratch("pre"), "early.cjs");
  fs.writeFileSync(file, `const r = new (require("node:dns").promises.Resolver)(); r.setServers(["127.0.0.1:${dnsPort}"]); r.resolve4(${JSON.stringify(name)}).catch(() => {});\n`);
  return file;
}
