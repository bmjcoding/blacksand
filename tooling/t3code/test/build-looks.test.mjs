// node --test test/: the before/after screenshots (lib/looks.mjs). The new build's
// packaged server runs under the tripwire for them, and any outbound attempt it
// makes fails the update even when the screenshots themselves fail. No DevTools
// request can wait forever, a server's start and stop leave no timers behind, and
// the theme they pick is one upstream accepts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

import { PREFERENCES, THEME_APPLIED, bootServer, captureLooks, cdpClient, launchChrome, packagedEgress } from "../lib/looks.mjs";

/** A stand-in WebSocket: records what's sent; `reply`, `close` and `error` drive it. */
function fakeSocket() {
  const ws = {
    sent: [],
    send(text) {
      ws.sent.push(JSON.parse(text));
    },
    reply: (message) => ws.onmessage({ data: JSON.stringify(message) }),
    close: () => ws.onclose?.(),
    error: () => ws.onerror?.(),
  };
  return ws;
}

test("a DevTools request answers, times out, or fails when the connection or Chrome goes", async () => {
  const ws = fakeSocket();
  const events = [];
  const cdp = cdpClient(ws, { timeoutMs: 100 });
  cdp.listeners.add((event) => events.push(event.method));
  const answered = cdp.send("Target.getTargets");
  ws.reply({ method: "Target.targetCreated" });
  ws.reply({ id: ws.sent[0].id, result: { targetInfos: [] } });
  assert.deepEqual(await answered, { targetInfos: [] });
  assert.deepEqual(events, ["Target.targetCreated"]);

  await assert.rejects(cdp.send("Page.navigate"), /didn't answer Page.navigate within 0.1 s/);
  assert.equal(cdp.pending.size, 0);

  const waiting = cdp.send("Runtime.evaluate");
  ws.close();
  await assert.rejects(waiting, /connection closed/);
  await assert.rejects(cdp.send("Browser.close"), /connection closed/);

  let exit;
  const gone = new Promise((resolve) => (exit = resolve));
  const other = cdpClient(fakeSocket(), { timeoutMs: 60_000, gone });
  const pending = other.send("Target.getTargets");
  exit();
  await assert.rejects(pending, /Chrome exited/);
  assert.equal(other.pending.size, 0);
});

test("a Chrome that exits before it starts DevTools fails fast", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-looks-"));
  const fake = path.join(dir, "chrome");
  fs.writeFileSync(fake, "#!/bin/sh\necho 'no devtools here' >&2\nexit 7\n", { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(launchChrome(fake, path.join(dir, "profile")), /Chrome exited \(7\)/);
  assert.ok(Date.now() - started < 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});

const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

test("booting and stopping a server leaves no timer running", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-looks-"));
  const entry = path.join(home, "server.cjs");
  fs.writeFileSync(entry, "console.log('pairingUrl: http://localhost:1/pair#token=x'); setInterval(() => {}, 1000);");
  const before = timers();
  const server = await bootServer({ exec: process.execPath, entry, electron: false }, home);
  assert.equal(server.pairingUrl, "http://127.0.0.1:1/pair#token=x");
  await server.stop();
  assert.equal(timers(), before);

  // One that dies at once is reported, with its timers cleared too.
  fs.writeFileSync(entry, "process.exit(5)");
  await assert.rejects(bootServer({ exec: process.execPath, entry, electron: false }, home), /server exited with 5/);
  assert.equal(timers(), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the screenshots' theme is one upstream accepts, set explicitly", () => {
  const store = new Map();
  const localStorage = { setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), getItem: (k) => store.get(k) ?? null };
  assert.equal(vm.runInNewContext(PREFERENCES, { localStorage }), true);
  // apps/web/src/hooks/useTheme.ts: light, dark, system or a defined theme's id; and an explicit appearance mode.
  assert.ok(["light", "dark", "system"].includes(store.get("t3code:theme")));
  assert.equal(store.get("t3code:theme-appearance-mode"), "dark");
  assert.equal(store.get("t3code:theme-follow-system"), "false");
  const html = { classList: new Set(["dark"]) };
  html.classList.contains = html.classList.has;
  assert.equal(vm.runInNewContext(THEME_APPLIED, { document: { documentElement: html } }), true);
});

/** A stand-in server: tries `host` (if any) through the tripwire, then prints its pairing URL and waits. */
function server(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-looks-"));
  const entry = path.join(dir, "server.cjs");
  const attempt = host ? `require("node:net").connect(443, ${JSON.stringify(host)}).on("error", () => {});` : "";
  fs.writeFileSync(entry, `${attempt}\nconsole.log("pairingUrl: http://localhost:1/pair#token=x");\nsetInterval(() => {}, 1000);`);
  return { exec: process.execPath, entry, electron: false };
}

test("the new build's outbound attempts are read and fail the update, though the screenshots failed", async () => {
  const looks = await captureLooks({ before: server("installed.example.org"), after: server("phone-home.example.org") }, { chromeBinary: "/usr/bin/false" });
  assert.match(looks.note, /Screenshots failed/);
  assert.deepEqual(looks.attempts.after.map((a) => `${a.kind} ${a.host}:${a.port}`), ["connect phone-home.example.org:443"]);
  assert.deepEqual(looks.attempts.before.map((a) => a.host), ["installed.example.org"]);
  assert.match(looks.note, /The new build's server tried to reach the network: phone-home\.example\.org:443 \(connect\)/);
  assert.match(packagedEgress(looks), /packaged server tried to reach the network.*phone-home\.example\.org:443.*Nothing was installed/);
});

test("a quiet new build passes, and the installed build's own attempts don't hold the update", async () => {
  const looks = await captureLooks({ before: server("installed.example.org"), after: server(null) }, { chromeBinary: "/usr/bin/false" });
  assert.deepEqual(looks.attempts.after, []);
  assert.equal(packagedEgress(looks), null);
  assert.equal(packagedEgress({ screens: [], note: "No Chrome or Chromium found, so there are no screenshots." }), null);
});
