// node --test test/: the network tripwire (lib/files/tripwire.cjs) on Node's own
// network APIs, and in every child process and worker. Each case runs a Node
// process with it preloaded, as the smoke test does, and checks what was let
// through, what was refused and what reached the log. Nothing here reaches past
// loopback: every blocked attempt is stopped before it's made, and the local
// receivers (test/tripwire-fixtures.mjs) count anything that gets through.
// Network clients run as programs: test/build-tripwire-exec.test.mjs.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { TRIPWIRE, earlyPreload, receivers, tripped } from "./tripwire-fixtures.mjs";

/** Runs `source` (CommonJS, or ESM with `esm`) under the tripwire; returns { out (its JSON), attempts }. */
function underTripwire(source, { esm = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-tripwire-")));
  const script = path.join(dir, esm ? "probe.mjs" : "probe.cjs");
  const log = path.join(dir, "tripwire.jsonl");
  fs.writeFileSync(script, source);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: dir, NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}`, T3BLACKOUT_TRIPWIRE_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: JSON.parse(result.stdout.trim().split("\n").at(-1)), attempts };
}

const hostsOf = (attempts) => attempts.map((a) => a.host).sort();

test("TCP: loopback addresses connect; other addresses and look-alike names are refused and logged", () => {
  const { out, attempts } = underTripwire(`
    const net = require("node:net");
    const server = net.createServer((s) => s.on("error", () => {}).end("hi")).listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      const tryConnect = (opts) => new Promise((resolve) => {
        const socket = net.connect(opts);
        socket.once("connect", () => { socket.destroy(); resolve("connected"); });
        socket.once("error", (e) => resolve(e.code));
      });
      const results = {
        loopback: await tryConnect({ host: "127.0.0.1", port }),
        localhost: await tryConnect({ host: "localhost", port, family: 4 }),
        public: await tryConnect({ host: "192.0.2.1", port: 9 }),
        prefix127: await tryConnect({ host: "127.collector.attacker.tld", port: 9 }),
        mdns: await tryConnect({ host: "elsewhere.local", port: 9 }),
        // localhost, but resolving somewhere else: the resolved address is checked.
        rebound: await tryConnect({ host: "localhost", port: 9, lookup: (h, o, cb) => cb(null, "203.0.113.9", 4) }),
      };
      server.close();
      console.log(JSON.stringify(results));
    });
  `);
  assert.deepEqual(out, { loopback: "connected", localhost: "connected", public: "ECONNREFUSED", prefix127: "ECONNREFUSED", mdns: "ECONNREFUSED", rebound: "ENOTFOUND" });
  assert.deepEqual(hostsOf(attempts), ["127.collector.attacker.tld", "192.0.2.1", "elsewhere.local", "localhost -> 203.0.113.9"]);
});

test("DNS: every resolver query, promise or callback, Resolver instances, reverse lookups", () => {
  const { out, attempts } = underTripwire(`
    const dns = require("node:dns");
    const outcome = (p) => p.then(() => "resolved", (e) => e.code);
    const viaCallback = (fn) => new Promise((resolve) => fn((e) => resolve(e ? e.code : "resolved")));
    (async () => {
      const results = {
        promiseResolver: await outcome(new dns.promises.Resolver().resolve4("tracker.example.org")),
        promiseResolveTxt: await outcome(dns.promises.resolveTxt("txt.example.org")),
        promiseReverse: await outcome(dns.promises.reverse("192.0.2.7")),
        promiseLookupService: await outcome(dns.promises.lookupService("192.0.2.8", 443)),
        callbackResolver: await viaCallback((cb) => new dns.Resolver().resolveMx("mx.example.org", cb)),
        callbackResolveSrv: await viaCallback((cb) => dns.resolveSrv("_x._tcp.example.org", cb)),
        lookupOther: await viaCallback((cb) => dns.lookup("lookup.example.org", cb)),
        promiseLookupOther: await outcome(dns.promises.lookup("plookup.example.org")),
        lookupLocalhost: await viaCallback((cb) => dns.lookup("localhost", cb)),
        promiseLookupLocalhost: await outcome(dns.promises.lookup("localhost", { all: true })),
      };
      console.log(JSON.stringify(results));
    })();
  `);
  assert.deepEqual(out, {
    promiseResolver: "ENOTFOUND",
    promiseResolveTxt: "ENOTFOUND",
    promiseReverse: "ENOTFOUND",
    promiseLookupService: "ENOTFOUND",
    callbackResolver: "ENOTFOUND",
    callbackResolveSrv: "ENOTFOUND",
    lookupOther: "ENOTFOUND",
    promiseLookupOther: "ENOTFOUND",
    lookupLocalhost: "resolved",
    promiseLookupLocalhost: "resolved",
  });
  assert.deepEqual(hostsOf(attempts), ["192.0.2.7", "192.0.2.8", "_x._tcp.example.org", "lookup.example.org", "mx.example.org", "plookup.example.org", "tracker.example.org", "txt.example.org"]);
});

test("ESM named imports of node:dns get the guarded functions too", () => {
  const { out, attempts } = underTripwire(
    `
    import { lookup, promises } from "node:dns";
    const a = await new Promise((resolve) => lookup("esm.example.org", (e) => resolve(e ? e.code : "resolved")));
    const b = await promises.resolve4("esm2.example.org").then(() => "resolved", (e) => e.code);
    console.log(JSON.stringify({ a, b }));
  `,
    { esm: true },
  );
  assert.deepEqual(out, { a: "ENOTFOUND", b: "ENOTFOUND" });
  assert.deepEqual(hostsOf(attempts), ["esm.example.org", "esm2.example.org"]);
});

test("UDP: a connected socket is checked at connect, sends at send", () => {
  const { out, attempts } = underTripwire(`
    const dgram = require("node:dgram");
    const connected = dgram.createSocket("udp4");
    connected.once("error", (e) => {
      const unconnected = dgram.createSocket("udp4");
      unconnected.send("x", 53, "192.0.2.2", (err) => {
        unconnected.close();
        connected.close();
        console.log(JSON.stringify({ connect: e.code, send: err && err.code }));
      });
    });
    connected.connect(53, "192.0.2.1");
  `);
  assert.deepEqual(out, { connect: "ECONNREFUSED", send: "ECONNREFUSED" });
  assert.deepEqual(hostsOf(attempts), ["192.0.2.1", "192.0.2.2"]);
});

test("children and workers keep the tripwire even given env: {}, and the network clients they run are blocked", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-git-")));
  spawnSync("git", ["init", "-q", repo]);
  const { out, attempts } = underTripwire(`
    const { spawnSync, execFileSync, execSync, spawn } = require("node:child_process");
    const { Worker } = require("node:worker_threads");
    const connectFrom = 'require("node:net").connect({ host: "192.0.2.3", port: 9 }).on("error", () => {});';
    const child = spawnSync(process.execPath, ["-e", connectFrom], { env: {}, encoding: "utf8" });
    const curl = spawnSync("curl", ["-s", "https://upload.example.org/x"], { encoding: "utf8" });
    let fetchStatus;
    try { execFileSync("git", ["-C", ${JSON.stringify(repo)}, "fetch", "https://example.org/repo.git"], { stdio: "ignore" }); fetchStatus = 0; } catch (e) { fetchStatus = e.status; }
    let shellStatus;
    try { execSync("true && wget -q https://wget.example.org/", { stdio: "ignore" }); shellStatus = 0; } catch (e) { shellStatus = e.status; }
    const status = spawnSync("git", ["-C", ${JSON.stringify(repo)}, "status", "--short"], { encoding: "utf8" }).status;
    const asyncCurl = new Promise((resolve) => spawn("curl", ["https://async.example.org"]).on("exit", resolve));
    const worker = new Promise((resolve) => new Worker(connectFrom, { eval: true, env: {} }).on("exit", resolve));
    Promise.all([asyncCurl, worker]).then(([asyncStatus]) => {
      setTimeout(() => console.log(JSON.stringify({ child: child.status, curl: curl.status, fetchStatus, shellStatus, status, asyncStatus })), 200);
    });
  `);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(out, { child: 0, curl: 126, fetchStatus: 126, shellStatus: 126, status: 0, asyncStatus: 126 });
  const kinds = attempts.map((a) => `${a.kind} ${a.host}`).sort();
  assert.deepEqual(kinds, [
    "connect 192.0.2.3",
    "connect 192.0.2.3",
    "exec curl https://async.example.org",
    "exec curl https://upload.example.org/x",
    "exec git fetch https://example.org/repo.git",
    "exec wget https://wget.example.org/",
  ]);
  // The child process's attempt carries its own pid: it ran with the tripwire.
  assert.equal(new Set(attempts.filter((a) => a.kind === "connect").map((a) => a.pid)).size >= 1, true);
});

/** Code that asks the local DNS server for `name`. */
const lookup = (dnsPort, name) => `const r = new (require("node:dns").promises.Resolver)(); r.setServers(["127.0.0.1:${dnsPort}"]); r.resolve4(${JSON.stringify(name)}).catch(() => {});`;

test("a child runs the tripwire before anything its NODE_OPTIONS preloads, whatever it's given", async () => {
  const net = await receivers();
  try {
    const child = (nodeOptions, code = "setTimeout(() => {}, 200)") => `require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(code)}], { env: { NODE_OPTIONS: ${JSON.stringify(nodeOptions)} } });`;
    const first = earlyPreload(net.dnsPort, "child-first.invalid");
    const before = earlyPreload(net.dnsPort, "child-before.invalid");
    const esm = path.join(path.dirname(first), "early.mjs");
    fs.writeFileSync(esm, `import { promises } from "node:dns"; const r = new promises.Resolver(); r.setServers(["127.0.0.1:${net.dnsPort}"]); await r.resolve4("child-import.invalid").catch(() => {});\n`);
    // [code, options, the one name it looks up]
    const cases = [
      // NODE_OPTIONS that only mentions the tripwire's path still gets a real --require of it.
      [child(`--title=${TRIPWIRE}`, lookup(net.dnsPort, "child-title.invalid")), {}, "child-title.invalid"],
    ];
    for (const cli of [false, true]) {
      cases.push([child(`--require ${first}`), { cli }, "child-first.invalid"]);
      // The tripwire already there, but after another preload: moved to the front.
      cases.push([child(`-r ${before} --require ${JSON.stringify(TRIPWIRE)}`), { cli }, "child-before.invalid"]);
      cases.push([child(`--import ${esm}`), { cli }, "child-import.invalid"]);
    }
    const results = await Promise.all(cases.map(([code, options]) => tripped(code, options)));
    results.forEach((attempts, i) => assert.deepEqual(attempts.map((a) => a.host), [cases[i][2]], cases[i][0]));
    assert.deepEqual(net.seen.dns, []);
  } finally {
    await net.close();
  }
});

test("a worker keeps the tripwire, ahead of any preload, however it's started", async () => {
  const net = await receivers();
  try {
    const worker = (body, options, before = "") => `${before}const wt = require("node:worker_threads"); new wt.Worker(${JSON.stringify(body)}, { eval: true, ${options} });`;
    const idle = "setTimeout(() => {}, 200)";
    // [code, options, the one name it looks up]
    const cases = [
      // Its own code: execArgv: [], a cleared NODE_OPTIONS, the tripwire on the command line only, env: {}.
      [worker(lookup(net.dnsPort, "w-empty.invalid"), "execArgv: []"), {}, "w-empty.invalid"],
      [worker(lookup(net.dnsPort, "w-cleared.invalid"), "execArgv: []", "delete process.env.NODE_OPTIONS; "), {}, "w-cleared.invalid"],
      [worker(lookup(net.dnsPort, "w-cli.invalid"), "execArgv: []"), { cli: true }, "w-cli.invalid"],
      [worker(lookup(net.dnsPort, "w-own-env.invalid"), "env: {}, execArgv: []"), {}, "w-own-env.invalid"],
    ];
    // A preload in its execArgv, with the tripwire on the command line or in NODE_OPTIONS.
    const pre = earlyPreload(net.dnsPort, "worker-pre.invalid");
    for (const cli of [true, false]) {
      cases.push([worker(idle, `execArgv: ${JSON.stringify(["--require", pre])}`), { cli }, "worker-pre.invalid"]);
      cases.push([worker(idle, `execArgv: ${JSON.stringify([`--require=${pre}`, "--require", TRIPWIRE])}`), { cli }, "worker-pre.invalid"]);
    }
    // A NODE_OPTIONS preload this thread set, reaching the worker through its env or SHARE_ENV.
    const envPre = earlyPreload(net.dnsPort, "worker-env.invalid");
    for (const options of ["execArgv: []", "", "execArgv: [], env: wt.SHARE_ENV", "env: wt.SHARE_ENV", "env: process.env"]) {
      cases.push([worker(idle, options, `process.env.NODE_OPTIONS = ${JSON.stringify(`--require ${envPre}`)}; `), {}, "worker-env.invalid"]);
    }
    const results = await Promise.all(cases.map(([code, options]) => tripped(code, options)));
    results.forEach((attempts, i) => assert.deepEqual(attempts.map((a) => a.host), [cases[i][2]], cases[i][0]));
    assert.deepEqual(net.seen.dns, []);
  } finally {
    await net.close();
  }
});

test("the NODE_OPTIONS and execArgv a child or worker gets start with the tripwire; SHARE_ENV stays shared and an inherited env a copy", () => {
  const child = `require("node:child_process").spawnSync(process.execPath, ["-e", "console.log(process.env.NODE_OPTIONS)"], { env: { NODE_OPTIONS: "--max-old-space-size=64" }, stdio: "inherit" });`;
  const result = spawnSync(process.execPath, ["--require", TRIPWIRE, "-e", child], { cwd: os.tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `--require ${JSON.stringify(TRIPWIRE)} --max-old-space-size=64`);

  // A worker's own execArgv, not only the env it inherits: either alone keeps the tripwire first.
  const execArgv = `
    const wt = require("node:worker_threads");
    for (const execArgv of [[], ["--no-warnings"]]) new wt.Worker("require('node:worker_threads').parentPort.postMessage(process.execArgv)", { eval: true, execArgv }).on("message", (seen) => console.log(JSON.stringify(seen)));`;
  const workerArgs = spawnSync(process.execPath, ["--require", TRIPWIRE, "-e", execArgv], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(workerArgs.status, 0, workerArgs.stderr);
  assert.deepEqual(workerArgs.stdout.trim().split("\n").map((line) => JSON.parse(line)).sort((a, b) => a.length - b.length), [["--require", TRIPWIRE], ["--require", TRIPWIRE, "--no-warnings"]]);

  const workers = `
    const wt = require("node:worker_threads");
    const run = (env) => new Promise((resolve) => {
      const w = new wt.Worker("process.env.SET_BY_WORKER = 'yes'; require('node:worker_threads').parentPort.postMessage(process.env.NODE_OPTIONS)", { eval: true, ...(env ? { env } : {}) });
      w.on("message", (options) => w.on("exit", () => resolve(options)));
    });
    (async () => {
      process.env.NODE_OPTIONS = "--max-old-space-size=128";
      const inherited = await run();
      const afterInherited = process.env.SET_BY_WORKER ?? null;
      const parentOptions = process.env.NODE_OPTIONS;
      const shared = await run(wt.SHARE_ENV);
      console.log(JSON.stringify({ inherited, afterInherited, parentOptions, shared, afterShared: process.env.SET_BY_WORKER ?? null, parentShared: process.env.NODE_OPTIONS }));
    })();`;
  const ran = spawnSync(process.execPath, ["--require", TRIPWIRE, "-e", workers], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(ran.status, 0, ran.stderr);
  const seen = JSON.parse(ran.stdout);
  const first = `--require ${JSON.stringify(TRIPWIRE)} --max-old-space-size=128`;
  assert.equal(seen.inherited, first);
  assert.equal(seen.afterInherited, null, "an inherited env is the worker's own copy");
  assert.equal(seen.parentOptions, "--max-old-space-size=128", "an inherited env leaves this thread's alone");
  assert.equal(seen.shared, first);
  assert.equal(seen.afterShared, "yes", "SHARE_ENV is still shared");
  assert.equal(seen.parentShared, first);
});
