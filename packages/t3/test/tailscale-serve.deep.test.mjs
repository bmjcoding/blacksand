// node --test test/: the Tailscale part of scripts/host-common.sh, the Serve
// changes the phone and Screen Sharing setups make. It runs against a fake
// tailscaled LocalAPI on a real unix socket (GET serve-config with an ETag; POST
// honours If-Match with 412, as ipn/localapi/serve.go does), reached with the
// same curl calls the scripts make; the JSON work runs in macOS's own osascript.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { localApi } from "./fake-localapi.mjs";

const HELPER = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "scripts", "host-common.sh");
const mac = { skip: process.platform !== "darwin" && "osascript" };
const HOST = "t3b-host.tail0000.ts.net";
const PHONE = "http://127.0.0.1:4773";
const LIVE = "127.0.0.1:15900";
const PARKED = "127.0.0.1:15901";
const PROTECTED = "15900,15901";

/** bash with the helper sourced (as the setup scripts do), asynchronously: the fake LocalAPI lives in this process. */
function sourced(body, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `set -euo pipefail\nsource ${JSON.stringify(HELPER)}\nsay() { echo "SAY $*"; }\nwarn() { echo "WARN $*" >&2; }\ndie() { echo "DIE $*" >&2; exit 1; }\n${body}`], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
async function withApi(config, options, run) {
  const api = await localApi(config, options);
  try {
    return await run(api);
  } finally {
    await api.close();
  }
}

const web = (port, target) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`${HOST}:${port}`]: { Handlers: { "/": { Proxy: target } } } } });
const tcp = (port, target) => ({ TCP: { [port]: { TCPForward: target } } });
const merge = (...configs) => configs.reduce((a, b) => ({ ...a, ...b, TCP: { ...a.TCP, ...b.TCP }, Web: { ...a.Web, ...b.Web } }), {});
const jxaSource = () => spawnSync("bash", ["-c", `source ${JSON.stringify(HELPER)}\nprintf '%s' "$JXA_SERVE"`], { encoding: "utf8" }).stdout;

// --------------------------------------------------------- the phone's mapping --

test("a mapping goes onto a free port in one conditional write, everything else kept, and a rerun writes nothing", mac, () =>
  withApi(web(8443, "http://127.0.0.1:8080"), {}, async (api) => {
    const out = await sourced(`serve_add web ${HOST}:443 ${PHONE}`, api.env);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(api.posts.length, 1);
    assert.match(api.posts[0].ifMatch, /^"[0-9a-f]{64}"$/, "the write names the ETag it read");
    assert.deepEqual(api.config(), merge(web(8443, "http://127.0.0.1:8080"), web(443, PHONE)));
    assert.equal((await sourced(`serve_add web ${HOST}:443 ${PHONE}`, api.env)).status, 0);
    assert.equal(api.posts.length, 1, "already there");
    const port = await sourced(`serve_port_of web ${PHONE}`, api.env);
    assert.equal(port.stdout, "443\n");
  }));

test("another client writing between the read and the write: tailscaled refuses ours, theirs survives, and the script says so", mac, async () => {
  const theirs = web(443, "http://127.0.0.1:8080");
  await withApi({}, { afterGet: (n) => (n === 1 ? theirs : null) }, async (api) => {
    const out = await sourced(`serve_add web ${HOST}:443 ${PHONE}`, api.env);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /changed while this checked it \(another client wrote it\); tailscaled refused the write, nothing changed/);
    assert.deepEqual(api.config(), theirs);
  });
  await withApi(web(443, PHONE), { afterGet: (n, c) => (n === 1 ? merge(c, web(8443, "http://127.0.0.1:9")) : null) }, async (api) => {
    const out = await sourced(`serve_remove ${HOST} 4773`, api.env);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /changed while this checked it; nothing removed/);
    assert.deepEqual(api.config(), merge(web(443, PHONE), web(8443, "http://127.0.0.1:9")));
  });
});

test("a configuration that can't be read, comes without an ETag, or isn't JSON is never written over", mac, async () => {
  for (const fault of [{ failGet: true }, { noEtag: true }, { body: "not json" }]) {
    await withApi(web(443, "http://127.0.0.1:8080"), fault, async (api) => {
      const out = await sourced(`serve_add web ${HOST}:443 ${PHONE}`, api.env);
      assert.equal(out.status, 1, JSON.stringify(fault));
      assert.match(out.stderr, /couldn't read Tailscale Serve's configuration .*nothing changed/);
      assert.equal(api.posts.length, 0);
    });
  }
  const missing = await sourced(`serve_add web ${HOST}:443 ${PHONE}`, { BLACKSAND_T3_TAILSCALED_SOCKET: path.join(os.tmpdir(), "no-such.socket") });
  assert.match(missing.stderr, /couldn't read/);
});

test("a port in use, a foreground session on it, or Funnel anywhere on the node: refused before anything is written", mac, async () => {
  const fg = (config) => ({ Foreground: { "session-1": config } });
  for (const [config, why] of [
    [web(443, "http://127.0.0.1:8080"), /port 443 is in use/],
    [fg(web(443, PHONE)), /in use \(\{"foregroundSession":"session-1"\}\)/],
    [{ TCP: { 443: { TCPForward: "127.0.0.1:22" } } }, /in use/],
    [{ AllowFunnel: { [`${HOST}:10000`]: true } }, /Funnel is on/],
    [fg({ TCP: { 8443: { HTTPS: true } }, AllowFunnel: { [`${HOST}:8443`]: true } }), /Funnel is on/],
  ]) {
    await withApi(config, {}, async (api) => {
      const out = await sourced(`serve_add web ${HOST}:443 ${PHONE}`, api.env);
      assert.equal(out.status, 1, JSON.stringify(config));
      assert.match(out.stderr, why);
      assert.equal(api.posts.length, 0);
    });
  }
});

test("a mapping that isn't in effect after the write is reported, not called success", mac, () =>
  withApi({}, { afterPost: (c) => ({ ...c, Foreground: { s: { TCP: { 443: { HTTPS: true } } } } }) }, async (api) => {
    const out = await sourced(`serve_add web ${HOST}:443 ${PHONE}`, api.env);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /doesn't show the mapping in effect after the change/);
  }));

// ----------------------------------------------------------- tailscaled itself --

test("this Mac's name, HTTPS capability and tailnet addresses come from tailscaled's LocalAPI status, never the tailscale command", mac, async () => {
  await withApi({}, { status: { Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.75.232.118", "FD7A:115C:A1E0::1234"], CapMap: { https: null } } } }, async (api) => {
    const out = await sourced("tailnet_name https; tailnet_ips", { ...api.env, PATH: "/usr/bin:/bin" });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${HOST}\n100.75.232.118\nfd7a:115c:a1e0::1234\n`);
  });
  await withApi({}, { status: { Self: { DNSName: `${HOST}.`, CapMap: {} } } }, async (api) => {
    const out = await sourced("tailnet_name https || echo REFUSED", api.env);
    assert.match(out.stderr, /can't issue HTTPS certificates yet/);
    assert.match(out.stdout, /REFUSED/);
  });
  const fields = await sourced(`jxa status '{"Self":{}}' https; jxa status 'x' dns`);
  assert.equal(fields.stdout, "unknown\ninvalid\n");
  const down = await sourced("tailnet_name || echo DOWN", { BLACKSAND_T3_TAILSCALED_SOCKET: path.join(os.tmpdir(), "no-such.socket") });
  assert.match(down.stdout, /DOWN/);
});

test("every LocalAPI request has a deadline: a tailscaled that accepts and never answers fails in seconds, and nothing is written", mac, () =>
  withApi({}, { hang: true }, async (api) => {
    for (const body of [`serve_add web ${HOST}:443 ${PHONE}`, "tailnet_name https", "tailnet_ips || echo FAILED", `serve_inventory 5900 ${PROTECTED} || echo FAILED`, `serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} || echo FAILED`]) {
      const started = Date.now();
      const out = await sourced(body, { ...api.env, BLACKSAND_T3_TAILSCALE_TIMEOUT: "1" });
      assert.ok(Date.now() - started < 8_000, `${body}: bounded`);
      assert.ok(out.status !== 0 || /FAILED/.test(out.stdout), body);
    }
  }));

test("forwarding_problem reads the four settings and never writes them: 0/0 and 1 or 2 pass, anything else says why", () => {
  const run = (values) =>
    spawnSync("bash", ["-c", `source ${JSON.stringify(HELPER)}\nsysctl() { [[ $1 == -n ]] || { echo WRITE >&2; return 9; }; case "$2" in ${Object.entries(values).map(([k, v]) => `${k}) ${v === "fail" ? "return 1" : `echo ${v}`} ;;`).join(" ")} esac; }\nif why="$(forwarding_problem)"; then echo "PROBLEM $why"; else echo SAFE; fi`], { encoding: "utf8" });
  const safe = { "net.inet.ip.forwarding": 0, "net.inet6.ip6.forwarding": 0, "net.inet.ip.check_interface": 1, "net.inet6.ip6.check_interface": 1 };
  assert.equal(run(safe).stdout.trim(), "SAFE");
  assert.equal(run({ ...safe, "net.inet.ip.check_interface": 2, "net.inet6.ip6.check_interface": 2 }).stdout.trim(), "SAFE");
  assert.match(run({ ...safe, "net.inet6.ip6.forwarding": 1 }).stdout, /PROBLEM net\.inet6\.ip6\.forwarding is 1, not 0 \(forwarding on\)/);
  assert.match(run({ ...safe, "net.inet.ip.check_interface": 0 }).stdout, /PROBLEM .* is 0 \(weak host model\)/);
  assert.match(run({ ...safe, "net.inet.ip.forwarding": "fail" }).stdout, /PROBLEM net\.inet\.ip\.forwarding is unreadable/);
  assert.doesNotMatch(run(safe).stderr, /WRITE/);
});

// ------------------------------------------------ Screen Sharing's forward --

test("the inventory names TCP 5900's own handler and every other handler, in any scope or kind, that mentions 15900 or 15901", mac, async () => {
  const funnel443 = merge(web(443, PHONE), { AllowFunnel: { [`${HOST}:443`]: true } });
  for (const [config, main, others] of [
    [{}, "none", ""],
    [tcp(5900, LIVE), `tcp ${LIVE}`, ""],
    [tcp(5900, "localhost:15900"), "tcp localhost:15900", ""],
    [merge(tcp(5900, PARKED), funnel443), `tcp ${PARKED}`, ""],
    [{ TCP: { 5900: { TCPForward: LIVE, TerminateTLS: HOST } } }, `other {"tcp":{"TCPForward":"${LIVE}","TerminateTLS":"${HOST}"},"web":[]}`, ""],
    [{ Foreground: { s1: tcp(5900, LIVE) } }, "none", `foreground session s1: TCP 5900 to ${LIVE}`],
    [merge(tcp(5900, PARKED), tcp(8443, PARKED)), `tcp ${PARKED}`, `TCP 8443 to ${PARKED}`],
    [merge(tcp(5900, PARKED), web(8443, "http://localhost:15900/x")), `tcp ${PARKED}`, `${HOST}:8443/ to http://localhost:15900/x`],
    [merge(tcp(5900, PARKED), { Services: { "svc:x": tcp(80, "127.0.0.2:15900") } }), `tcp ${PARKED}`, "service svc:x: TCP 80 to 127.0.0.2:15900"],
    [merge(tcp(5900, PARKED), tcp(7001, "somewhere"), web(443, "http://127.0.0.1:4773/?next=/x")), `tcp ${PARKED}`, ""],
  ]) {
    await withApi(config, {}, async (api) => {
      const out = await sourced(`serve_inventory 5900 ${PROTECTED}`, api.env);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, `${main}\n${others}\n`, JSON.stringify(config));
    });
  }
});

test("a target mentions a port when the number appears in it with no digit beside it, leading zeros allowed: every spelling, scope and kind of handler is caught, and other ports aren't", mac, () => {
  const names = (port) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `[::ffff:127.0.0.1]:${port}`, `100.75.232.118:${port}`, `[fd7a:115c:a1e0::1234]:${port}`, `:${port}`, `0.0.0.0:${port}`, `localhost:0${port}`, `tcp://localhost:${port}`, `${port}`];
  const proxies = (port) => [...names(port), `http://localhost:${port}`, `https://[::1]:${port}/path`, `https+insecure://[::1]:${port}/path`, `http://u:p@localhost:${port}/path`, `http://[::1]:${port}?x=:80`, `http://[::1]:${port}#x=:80`, `http://127.0.0.1:${port}/?x=:80`, `http://127.0.0.1:4773/?next=${port}`];
  /** Every target, in every scope, handler kind and listening port, through the real JXA inventory: whether it counts as parked. */
  const parkedFor = (targets, webTargets) => {
    const cases = [];
    for (const scope of ["background", "foreground", "service"])
      for (const port of [1, 443, 5900, 15900, 15901])
        for (const kind of ["tcp", "tls", "proxy"])
          for (const target of kind === "proxy" ? webTargets : targets) {
            const handler = kind === "proxy"
              ? { TCP: { [port]: { HTTPS: true } }, Web: { [`${HOST}:${port}`]: { Handlers: { "/": { Proxy: target } } } } }
              : { TCP: { [port]: { TCPForward: target, ...(kind === "tls" ? { TerminateTLS: HOST } : {}) } } };
            cases.push({ label: `${scope} ${kind} on ${port} → ${target}`, own: scope === "background" && kind === "tcp" && port === 5900 && target === PARKED, config: scope === "background" ? handler : scope === "foreground" ? { Foreground: { s1: handler } } : { Services: { "svc:x": handler } } });
          }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-matrix-")), "cases.json");
    fs.writeFileSync(file, JSON.stringify(cases.map((c) => c.config)));
    const script = `${jxaSource()}\nfunction run(argv) { const cases = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js); return JSON.stringify(cases.map(function (c) { return inventory(c, "5900", "${PROTECTED}"); })); }`;
    const out = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-", file], { input: script, encoding: "utf8", maxBuffer: 50_000_000 });
    assert.equal(out.status, 0, out.stderr);
    // Parked, as Screen Sharing reads it: TCP 5900 none or exactly the parking forward, and nothing else mentioning either port.
    return JSON.parse(out.stdout).map((result, i) => {
      const [main, others, end] = result.split("\n");
      assert.equal(end, "end");
      return [cases[i], (main === "none" || main === `tcp ${PARKED}`) && others === ""];
    });
  };
  for (const port of [15900, 15901]) {
    const results = parkedFor(names(port), proxies(port));
    assert.deepEqual(results.filter(([c, parked]) => parked && !c.own).map(([c]) => c.label), [], `${port}: ${results.length} cases`);
  }
  const quiet = parkedFor(["127.0.0.1:4773", "localhost:8080", "[::1]:3000", "127.0.0.1:159000", "127.0.0.1:1590"], ["http://127.0.0.1:4773", "http://localhost:8080/x?y=1", "https://[::1]:3000/#z"]);
  assert.deepEqual(quiet.filter(([c, parked]) => !parked && !(c.label.includes("on 5900") && c.label.startsWith("background"))).map(([c]) => c.label), [], "ports beside them aren't mentions");
});

test("serve_tcp_set changes TCP 5900's own handler only from exactly what it was, while nothing else mentions the ports, in one conditional write that keeps the rest; read back, and never a die", mac, async () => {
  const funnel = merge(web(443, PHONE), { AllowFunnel: { [`${HOST}:443`]: true } });
  await withApi(merge(tcp(5900, LIVE), funnel), {}, async (api) => {
    const parked = await sourced(`serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} && echo PARKED`, api.env);
    assert.match(parked.stdout, /PARKED/, parked.stdout + parked.stderr);
    assert.deepEqual(api.config(), merge(tcp(5900, PARKED), funnel), "only 5900 changed");
    assert.equal(api.posts.length, 1);
    const stale = await sourced(`serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} || echo FAILED`, api.env);
    assert.match(stale.stdout, /TCP 5900 is tcp 127\.0\.0\.1:15901, not tcp 127\.0\.0\.1:15900 alone; left as it is\nFAILED/);
    assert.match((await sourced(`serve_tcp_set 5900 ${PARKED} none ${PROTECTED} && echo REMOVED`, api.env)).stdout, /REMOVED/);
    assert.deepEqual(api.config(), funnel);
    assert.match((await sourced(`serve_tcp_set 5900 none ${LIVE} ${PROTECTED} && echo ADDED`, api.env)).stdout, /ADDED/);
    assert.deepEqual(api.config().TCP[5900], { TCPForward: LIVE });
  });
  for (const [config, why] of [
    [tcp(5900, "127.0.0.1:9"), /TCP 5900 is tcp 127\.0\.0\.1:9, not tcp 127\.0\.0\.1:15900 alone; left as it is/],
    [web(5900, "http://127.0.0.1:1"), /TCP 5900 is other .*; left as it is/],
    [merge(tcp(5900, LIVE), tcp(8443, PARKED)), /TCP 5900 is tcp 127\.0\.0\.1:15900, and these mention TCP 15900,15901: TCP 8443 to 127\.0\.0\.1:15901, not tcp 127\.0\.0\.1:15900 alone/],
  ]) {
    await withApi(config, {}, async (api) => {
      const out = await sourced(`serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} || echo "FAILED $?"`, api.env);
      assert.match(out.stdout, why, JSON.stringify(config));
      assert.match(out.stdout, /FAILED 1/);
      assert.equal(api.posts.length, 0);
    });
  }
});

test("serve_tcp_set retries a write refused because someone else wrote in between, only while TCP 5900 is still what it was, and gives up after three", mac, async () => {
  await withApi(tcp(5900, LIVE), { afterGet: (n, c) => (n === 1 ? merge(c, web(443, PHONE)) : null) }, async (api) => {
    assert.match((await sourced(`serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} && echo DONE`, api.env)).stdout, /DONE/);
    assert.deepEqual(api.config(), merge(tcp(5900, PARKED), web(443, PHONE)), "theirs kept, ours written");
    assert.equal(api.posts.length, 2);
  });
  await withApi(tcp(5900, LIVE), { afterGet: (n) => (n === 1 ? tcp(5900, "127.0.0.1:9") : null) }, async (api) => {
    const out = await sourced(`serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} || echo FAILED`, api.env);
    assert.match(out.stdout, /TCP 5900 is tcp 127\.0\.0\.1:9, not tcp 127\.0\.0\.1:15900 alone; left as it is\nFAILED/, "someone else's change isn't overwritten");
    assert.equal(api.config().TCP[5900].TCPForward, "127.0.0.1:9");
  });
  let n = 0;
  await withApi(tcp(5900, LIVE), { afterGet: (_, c) => ({ ...c, Web: { [`x${n++}:1`]: {} } }) }, async (api) => {
    assert.match((await sourced(`serve_tcp_set 5900 ${LIVE} ${PARKED} ${PROTECTED} || echo FAILED`, api.env)).stdout, /kept changing under this \(refused 3 times\); TCP 5900 left as it was\nFAILED/);
    assert.equal(api.posts.length, 3);
  });
});

// ------------------------------------------------------- the parser's answers --

test("a parser run that fails or is cut short is never an answer: every use refuses, and nothing is written", mac, async () => {
  const status = { Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.75.232.118"], CapMap: { https: null } } };
  /** jxa with `mode`'s run killed (the real osascript, SIGKILLed: no output), or cut short (`partial`). */
  const faulty = (mode, how) => `jxa() {
  if [[ $1 == ${mode} ]]; then
    ${how === "partial" ? "printf 'none\\\\n'; return 0" : '/usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE" & local parser=$!; kill -KILL "$parser" 2>/dev/null || true; wait "$parser"; return'}
  fi
  /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE"
}`;
  for (const [mode, how, body, why] of [
    ["inventory", "killed", `serve_inventory 5900 ${PROTECTED}`, /the parser failed/],
    ["inventory", "partial", `serve_inventory 5900 ${PROTECTED}`, /the parser failed/],
    ["inventory", "killed", `serve_tcp_set 5900 ${PARKED} none ${PROTECTED}`, /the parser failed\); TCP 5900 left as it is/],
    ["without", "killed", `serve_tcp_set 5900 ${PARKED} none ${PROTECTED}`, /couldn't work out Tailscale Serve's new configuration; TCP 5900 left as it is/],
    ["with", "killed", `serve_add tcp x:5901 127.0.0.1:9`, /DIE couldn't work out Tailscale Serve's new configuration; nothing changed/],
    ["check", "killed", `serve_add tcp x:5901 127.0.0.1:9`, /DIE couldn't read Tailscale Serve's configuration \(the parser failed\); nothing changed/],
    ["release", "killed", `serve_remove ${HOST} 15901`, /DIE couldn't work out Tailscale Serve's new configuration; nothing was removed/],
    ["inventory", "killed", `serve_remove ${HOST} 15901`, /DIE couldn't read Tailscale Serve's configuration \(the parser failed\); nothing was removed/],
    ["port", "killed", `serve_port_of tcp ${PARKED}`, /REFUSED 1/],
    ["status", "killed", "tailnet_ips", /REFUSED 1/],
    ["status", "killed", "tailnet_name", /couldn't read this Mac's tailnet status/],
  ]) {
    await withApi(tcp(5900, PARKED), { status }, async (api) => {
      const out = await sourced(`${faulty(mode, how)}\nif ${body}; then echo "ACCEPTED"; else echo "REFUSED $?"; fi`, api.env);
      const label = `${mode} ${how}: ${body}`;
      assert.doesNotMatch(out.stdout, /ACCEPTED/, `${label}\n${out.stdout}${out.stderr}`);
      assert.match(out.stdout + out.stderr, why, label);
      assert.equal(api.posts.length, 0, `${label}: nothing written`);
    });
  }
});
