// node --test test/*.test.mjs: Content-Security-Policy doesn't cover WebRTC, so the desktop's
// boot block (lib/files/boot-env.ts, rule desktop/boot-env) keeps it off the network: no web
// contents sends WebRTC over UDP, and the app's session sends TURN and ICE over TCP to a proxy
// that refuses them. That left WebRTC-only device streams (EAS Simulator) without video, so the
// app window's top frame, and only it, may open one hidden window by BLACKOUT_WEBRTC_WINDOW's
// name (lib/files/blackoutWebRtcWindow.ts, rules desktop/webrtc-window*): it alone gets the
// default policy back, never leaves about:blank, and closes with its page.
// With T3BLACKOUT_TEST_ELECTRON=<an Electron binary> it also runs a real probe: an agent's HTML
// preview (a sandboxed, opaque-origin frame under T3 Blackout's sandbox CSP) aims STUN, TURN and
// ICE at local UDP and TCP listeners while the app page beside it receives a device-style
// WebRTC video stream from a separate process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as dgram from "node:dgram";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";

const FILES = new URL("../lib/files/", import.meta.url);
const BOOT = new URL("boot-env.ts", FILES);
const { BLACKOUT_WEBRTC_WINDOW, blackoutWebRtcWindows } = await import(new URL("blackoutWebRtcWindow.ts", FILES));
const realm = await import(new URL("blackoutWebRtcRealm.ts", FILES));

const bootBlock = () => {
  const match = /^\{\n[\s\S]*^\}\n/m.exec(fs.readFileSync(BOOT, "utf8"));
  assert.ok(match, "lib/files/boot-env.ts must be one { ... } block");
  return stripTypeScriptTypes(match[0]);
};

/** Runs the boot block in an Electron main process faked here; returns the fake and what the block set up. */
function boot({ runAsNode = false, failProxy = false } = {}) {
  const listeners = new Map();
  const proxies = [];
  const exits = [];
  const on = (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  const electron = {
    app: { on, once: on, exit: (code) => exits.push(code) },
    session: {
      defaultSession: {
        setProxy: async (config) => {
          proxies.push(config);
          if (failProxy) throw new Error("no proxy for you");
        },
      },
    },
    WebContentsView: class {
      constructor({ webContents }) {
        this.webContents = webContents;
      }
    },
  };
  const real = createRequire(import.meta.url);
  vm.runInNewContext(bootBlock(), {
    require: (id) => (id === "electron" ? electron : real(id)),
    process: { ...(runAsNode ? {} : { type: "browser" }), platform: "darwin", env: {} },
    console: { error: () => {} },
  });
  const emit = (name, ...args) => (listeners.get(name) ?? []).forEach((listener) => listener(...args));
  return { electron, emit, proxies, exits, listens: (name) => listeners.has(name) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("every web contents gets the WebRTC policy that sends no UDP", () => {
  const app = boot();
  const policies = [];
  for (let i = 0; i < 3; i++) app.emit("web-contents-created", {}, { setWebRTCIPHandlingPolicy: (policy) => policies.push(policy) });
  assert.deepEqual(policies, ["disable_non_proxied_udp", "disable_non_proxied_udp", "disable_non_proxied_udp"]);
});

test("the app's session proxies to a loopback port this process holds, which refuses every connection", async () => {
  const app = boot();
  app.emit("ready");
  await settle();
  assert.equal(app.proxies.length, 1);
  const [{ mode, proxyRules, ...rest }] = app.proxies;
  assert.equal(mode, "fixed_servers");
  assert.deepEqual(rest, {}, "no bypass list beyond Chromium's own for loopback");
  const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(proxyRules)?.[1]);
  assert.ok(port > 0, proxyRules);
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.write("CONNECT 192.0.2.1:3478 HTTP/1.1\r\nHost: 192.0.2.1:3478\r\n\r\n");
    socket.on("error", () => {});
    socket.on("close", () => resolve(data));
    setTimeout(() => reject(new Error("the refusing proxy kept the connection open")), 2000).unref();
  });
  assert.equal(received, "", "nothing tunnels through it");
  assert.deepEqual(app.exits, []);
});

test("an app whose session can't take the proxy doesn't run", async () => {
  const app = boot({ failProxy: true });
  app.emit("ready");
  await settle();
  assert.deepEqual(app.exits, [1]);
});

test("outside the Electron main process (ELECTRON_RUN_AS_NODE) it sets nothing up", () => {
  const app = boot({ runAsNode: true });
  assert.equal(app.listens("web-contents-created"), false);
  assert.equal(app.listens("ready"), false);
});

// ------------------------------------------------------- the WebRTC window --

class FakeContents extends EventEmitter {
  constructor({ type = "window", opener = null, mainFrame = { parent: null } } = {}) {
    super();
    Object.assign(this, { type, opener, mainFrame, destroyed: false, policies: [], scripts: [], openHandler: null });
  }
  getType() { return this.type; }
  isDestroyed() { return this.destroyed; }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit("destroyed"); } }
  setWebRTCIPHandlingPolicy(policy) { this.policies.push(policy); }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  executeJavaScript(code) { this.scripts.push(code); return Promise.resolve(); }
}

/** The app as boot-env.ts and the rule set it up; open() is window.open from `frame` in the app's window. */
function app() {
  const { electron, emit } = boot();
  const windows = blackoutWebRtcWindows(electron);
  const owner = new FakeContents();
  const open = (frame, details = {}) => {
    const answer = windows.open(owner, { frameName: `${BLACKOUT_WEBRTC_WINDOW}-0f8c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b`, url: "about:blank", features: "", disposition: "new-window", referrer: { url: "", policy: "default" }, ...details });
    if (answer?.action !== "allow") return { answer };
    const child = new FakeContents({ opener: frame });
    emit("web-contents-created", {}, child);
    const returned = answer.createWindow({ webContents: child, webPreferences: {} });
    assert.equal(returned, child, "createWindow hands back the web contents Electron made");
    return { answer, child };
  };
  return { owner, open };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const navigation = (url, extra = {}) => ({ url, isSameDocument: false, isMainFrame: true, preventDefault() { this.prevented = true; }, ...extra });

test("only the page's own name for it, at about:blank, is the WebRTC window; every other window.open goes to upstream's handler", () => {
  const { owner, open } = app();
  assert.equal(open(owner.mainFrame, { frameName: "other" }).answer, null);
  // The fixed name alone, which any frame can give itself, isn't the helper.
  assert.equal(open(owner.mainFrame, { frameName: BLACKOUT_WEBRTC_WINDOW }).answer, null);
  assert.equal(open(owner.mainFrame, { frameName: `${BLACKOUT_WEBRTC_WINDOW}-not-a-uuid` }).answer, null);
  assert.deepEqual(open(owner.mainFrame, { url: "https://example.com/" }).answer, { action: "deny" });
  const { answer } = open(owner.mainFrame);
  assert.equal(answer.action, "allow");
  assert.equal(answer.outlivesOpener, false);
});

test("the app's top frame gets a window with the default policy back, marked once it has it", async () => {
  const { owner, open } = app();
  const { child } = open(owner.mainFrame);
  assert.deepEqual(child.policies, ["disable_non_proxied_udp", "default"], "boot-env.ts first, then the exception");
  assert.deepEqual(child.scripts, ["window.t3blackoutWebRtc = true;"]);
  await tick();
  assert.equal(child.isDestroyed(), false);
  assert.deepEqual(child.openHandler(), { action: "deny" }, "it opens nothing");
  const attach = { preventDefault() { this.prevented = true; } };
  child.emit("will-attach-webview", attach);
  assert.equal(attach.prevented, true);
});

test("a subframe (an agent's HTML preview, an MCP app) asking for it gets the app's policy and no window", async () => {
  const { owner, open } = app();
  const { child } = open({ parent: owner.mainFrame });
  assert.deepEqual(child.policies, ["disable_non_proxied_udp"]);
  assert.deepEqual(child.scripts, []);
  await tick();
  assert.equal(child.isDestroyed(), true);
  // Nor the top frame of a window other than the one whose handler asked.
  const other = open({ parent: null });
  assert.deepEqual(other.child.policies, ["disable_non_proxied_udp"]);
  await tick();
  assert.equal(other.child.isDestroyed(), true);
});

test("it never leaves about:blank: any navigation but its own first commit and in-page ones closes it", () => {
  const { owner, open } = app();
  const { child } = open(owner.mainFrame);
  child.emit("did-start-navigation", navigation("about:blank"));
  child.emit("did-start-navigation", navigation("about:blank#x", { isSameDocument: true }));
  assert.equal(child.isDestroyed(), false);
  child.emit("did-start-navigation", navigation("about:blank"));
  assert.equal(child.isDestroyed(), true, "a second about:blank would take the navigator's origin");

  const second = open(owner.mainFrame).child;
  const event = navigation("https://evil.example/");
  second.emit("will-frame-navigate", event);
  assert.equal(event.prevented, true);
  assert.equal(second.isDestroyed(), true);
});

test("it closes with the page that opened it, and lets go of the page's events when it does", () => {
  const { owner, open } = app();
  const first = open(owner.mainFrame).child;
  owner.emit("did-start-navigation", navigation("t3code://app/", { isMainFrame: false }));
  owner.emit("did-start-navigation", navigation("t3code://app/#thread", { isSameDocument: true }));
  assert.equal(first.isDestroyed(), false);
  owner.emit("did-start-navigation", navigation("t3code://app/"));
  assert.equal(first.isDestroyed(), true, "a reload or navigation of the app page");
  for (const event of ["render-process-gone", "destroyed"]) {
    const child = open(owner.mainFrame).child;
    owner.emit(event);
    assert.equal(child.isDestroyed(), true, event);
  }
  for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) assert.equal(owner.listenerCount(event), 0, event);
});

test("outside the desktop app's top frame the device stream uses the page's own RTCPeerConnection", async () => {
  const saved = { window: globalThis.window, RTCPeerConnection: globalThis.RTCPeerConnection };
  class PagePeer {}
  try {
    globalThis.RTCPeerConnection = PagePeer;
    delete globalThis.window;
    assert.equal(await realm.blackoutPeerConnection(), PagePeer);
    let opened = 0;
    globalThis.window = { open: () => opened++, top: {} };
    assert.equal(await realm.blackoutPeerConnection(), PagePeer);
    globalThis.window = { desktopBridge: {}, open: () => opened++, top: {} };
    assert.equal(await realm.blackoutPeerConnection(), PagePeer, "a subframe");
    assert.equal(opened, 0);
    assert.equal(realm.BLACKOUT_WEBRTC_WINDOW, BLACKOUT_WEBRTC_WINDOW, "both halves use one name");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

// ------------------------------------------------------------------ real probe --

// The app's main process: no boot block ("none"), the boot block ("boot"), or the boot block
// and the WebRTC window ("window"), as the rules wire them.
const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const [mode, url, bootFile, dir] = process.argv.slice(-4);
app.setPath("userData", path.join(dir, "user-data-" + mode));
if (mode !== "none") eval(require("node:module").stripTypeScriptTypes(/^\\{\\n[\\s\\S]*^\\}\\n/m.exec(require("node:fs").readFileSync(bootFile, "utf8"))[0]));
app.whenReady().then(async () => {
  const windows = mode === "window" ? (await import(path.join(dir, "window.mjs"))).blackoutWebRtcWindows(require("electron")) : null;
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(dir, "preload.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  // Upstream's handler denies every window; the rule asks blackoutWebRtc.open() first.
  win.webContents.setWindowOpenHandler((details) => windows?.open(win.webContents, details) ?? { action: "deny" });
  win.webContents.on("console-message", (event) => {
    const text = event.message;
    if (!text?.startsWith("PROBE ")) return;
    console.log(text);
    if (text === "PROBE done") setTimeout(() => app.quit(), 500);
  });
  win.loadURL(url);
  setTimeout(() => app.quit(), 90000);
});
`;
const PRELOAD = `require("electron").contextBridge.exposeInMainWorld("desktopBridge", {});`;
const DEVICE_MAIN = `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } }).loadURL(process.argv[process.argv.length - 1]));
`;
// The device: answers each offer with a test-pattern video track, like serve-emu's WebRTC publisher.
const DEVICE = `
const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 120;
const g = canvas.getContext("2d"); let n = 0;
setInterval(() => { g.fillStyle = "#123"; g.fillRect(0, 0, 160, 120); g.fillStyle = "#f80"; g.fillRect(n++ % 140, 40, 20, 40); }, 33);
const stream = canvas.captureStream(30);
(async function serve() {
  for (;;) {
    const offer = await fetch("/device/next").then((r) => r.text());
    const pc = new RTCPeerConnection({ iceServers: [] });
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    for (const t of pc.getTransceivers()) { t.direction = "sendonly"; await t.sender.replaceTrack(stream.getVideoTracks()[0]); }
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 3000); });
    await fetch("/device/answer", { method: "POST", body: pc.localDescription.sdp });
  }
})();
`;
// The app page: readWebRtc()'s steps, with the constructor blackoutWebRtcRealm.ts gives it.
const PAGE = `
import { blackoutPeerConnection } from "/realm.mjs";
const log = (...p) => console.log(["PROBE", ...p].join(" "));
const frame = document.createElement("iframe");
frame.src = "http://localhost:" + location.port + "/frame" + location.search;
document.body.append(frame);
let frames = 0;
try {
  const Peer = await blackoutPeerConnection();
  const pc = new Peer({ iceTransportPolicy: "all" });
  pc.addTransceiver("video", { direction: "recvonly" });
  const video = document.createElement("video");
  video.muted = true;
  document.body.append(video);
  pc.ontrack = (event) => {
    video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    video.play().catch(() => {});
    const count = () => { frames++; video.requestVideoFrameCallback(count); };
    video.requestVideoFrameCallback(count);
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 2000); });
  log("candidates", String((pc.localDescription.sdp.match(/^a=candidate/gm) ?? []).length));
  const answer = await fetch("/offer", { method: "POST", body: pc.localDescription.sdp }).then((r) => r.text());
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
} catch (error) {
  log("error", String(error));
}
setTimeout(() => { log("frames", String(frames)); log("done"); }, 30000);
`;
// An agent's HTML preview: STUN, TURN and ICE at this machine's LAN address, from its own peer
// connections and from any window it can get by the WebRTC window's name; then a fetch to
// loopback, which the app's window needs.
const FRAME = `
const q = new URLSearchParams(location.search);
const ip = q.get("ip"), udp = q.get("udp"), tcp = q.get("tcp"), web = q.get("web");
const log = (...p) => console.log(["PROBE", "untrusted", ...p].join(" "));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function gather(Peer, iceServers) {
  const pc = new Peer({ iceServers }); pc.createDataChannel("x");
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 4000); });
  pc.close();
}
async function remote(Peer, candidate) {
  const pc = new Peer(); pc.createDataChannel("x");
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await pc.setRemoteDescription({ type: "answer", sdp: offer.sdp.replace(/a=setup:actpass/g, "a=setup:active").replace(/a=ice-ufrag:.*/g, "a=ice-ufrag:abcd").replace(/a=ice-pwd:.*/g, "a=ice-pwd:abcdefghijklmnopqrstuvwx") });
  await pc.addIceCandidate({ candidate, sdpMid: "0", sdpMLineIndex: 0 });
  await wait(4000); pc.close();
}
async function all(Peer) {
  await gather(Peer, [{ urls: "stun:" + ip + ":" + udp }]);
  await gather(Peer, [{ urls: "turn:" + ip + ":" + udp + "?transport=udp", username: "u", credential: "p" }]);
  await gather(Peer, [{ urls: "turn:" + ip + ":" + tcp + "?transport=tcp", username: "u", credential: "p" }]);
  await remote(Peer, "candidate:1 1 udp 2122260223 " + ip + " " + udp + " typ host generation 0");
  await remote(Peer, "candidate:2 1 tcp 1518280447 " + ip + " " + tcp + " typ host tcptype passive generation 0");
}
(async () => {
  log("origin", String(origin));
  try {
    await all(RTCPeerConnection);
    let Peer = null;
    try { Peer = window.open("", ${JSON.stringify(BLACKOUT_WEBRTC_WINDOW)})?.RTCPeerConnection ?? null; } catch (error) { log("window", error.name); }
    if (Peer) { log("window", "reachable"); await all(Peer); }
  } catch (error) {
    log("error", String(error));
  }
  const ping = await fetch("http://127.0.0.1:" + web + "/ping").then((r) => r.status, () => "failed");
  log("loopback", String(ping));
  log("finished");
})();
`;

const electron = process.env.T3BLACKOUT_TEST_ELECTRON;
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

test("a real Electron app: the agent's frame reaches nothing over WebRTC, and the device stream gets video only through the WebRTC window", { skip: !electron ? "set T3BLACKOUT_TEST_ELECTRON to an Electron binary" : !lan ? "no non-loopback IPv4 address" : false, timeout: 400_000 }, async () => {
  const { T3BLACKOUT_SANDBOXED_CSP } = await import(new URL("t3blackoutCsp.ts", FILES));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-webrtc-"));
  const strip = (name) => stripTypeScriptTypes(fs.readFileSync(new URL(name, FILES), "utf8"));
  fs.writeFileSync(path.join(dir, "main.cjs"), MAIN);
  fs.writeFileSync(path.join(dir, "preload.cjs"), PRELOAD);
  fs.writeFileSync(path.join(dir, "device.cjs"), DEVICE_MAIN);
  fs.writeFileSync(path.join(dir, "window.mjs"), strip("blackoutWebRtcWindow.ts"));
  let udpHits = 0;
  let tcpHits = 0;
  let pings = 0;
  const udp = dgram.createSocket("udp4").on("message", () => udpHits++);
  await new Promise((resolve) => udp.bind(0, "0.0.0.0", resolve));
  const tcp = net.createServer((socket) => {
    tcpHits++;
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve) => tcp.listen(0, "0.0.0.0", resolve));
  // Signalling: the page's offer waits for the device's next poll, its answer for the device's reply.
  let offers = [];
  let answers = [];
  const polls = [];
  const pair = () => { while (offers.length && polls.length) polls.shift()(offers.shift()); };
  const read = (req) => new Promise((resolve) => { let body = ""; req.on("data", (chunk) => (body += chunk)); req.on("end", () => resolve(body)); });
  const web = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/ping") { pings++; return res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end(); }
    if (url.pathname === "/device/next") { polls.push((sdp) => res.end(sdp)); return pair(); }
    if (url.pathname === "/device/answer") { const sdp = await read(req); answers.shift()?.(sdp); return res.end(); }
    if (url.pathname === "/offer") { offers.push(await read(req)); answers.push((sdp) => res.end(sdp)); return pair(); }
    if (url.pathname === "/device") return res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><script>${DEVICE}</script>`);
    if (url.pathname === "/realm.mjs") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(strip("blackoutWebRtcRealm.ts"));
    if (url.pathname === "/frame") {
      // The headers the server gives an agent's HTML preview (t3blackoutGrantedFileCsp).
      res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-popups allow-downloads, ${T3BLACKOUT_SANDBOXED_CSP}` });
      return res.end(`<!doctype html><script>${FRAME}</script>`);
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><body><script type="module">${PAGE}</script>`);
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ELECTRON_")));
  const device = spawn(electron, [path.join(dir, "device.cjs"), `http://127.0.0.1:${web.address().port}/device`], { env, stdio: "ignore" });
  const query = new URLSearchParams({ ip: lan, udp: String(udp.address().port), tcp: String(tcp.address().port), web: String(web.address().port) });
  const run = async (mode) => {
    udpHits = 0;
    tcpHits = 0;
    pings = 0;
    offers = [];
    answers = [];
    const lines = await new Promise((resolve) => {
      const out = [];
      const child = spawn(electron, [path.join(dir, "main.cjs"), mode, `http://127.0.0.1:${web.address().port}/?${query}`, BOOT.pathname, dir], { env, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (chunk) => out.push(...String(chunk).split("\n").filter((line) => line.startsWith("PROBE"))));
      child.on("close", () => resolve(out));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const value = (name) => lines.find((line) => line.startsWith(`PROBE ${name} `))?.slice(name.length + 7);
    const shown = lines.join(" | ");
    assert.ok(lines.includes("PROBE untrusted origin null") && lines.includes("PROBE untrusted finished"), `${mode}: the agent's frame ran with an opaque origin: ${shown}`);
    assert.ok(!lines.includes("PROBE untrusted window reachable"), `${mode}: the agent's frame can't use the WebRTC window: ${shown}`);
    assert.ok(lines.includes("PROBE untrusted loopback 204") && pings === 1, `${mode}: loopback, all the app's window talks to, still works: ${shown}`);
    return { udp: udpHits, tcp: tcpHits, frames: Number(value("frames") ?? 0), candidates: Number(value("candidates") ?? 0), shown };
  };
  try {
    // Without the boot block the probe reaches the listeners and the stream gets video: both
    // measurements can see what they look for.
    const none = await run("none");
    assert.ok(none.udp > 0 && none.tcp > 0, `the agent's frame reaches the listeners without the boot block: ${none.shown}`);
    assert.ok(none.frames > 0, `the device stream has video without the boot block: ${none.shown}`);
    const blocked = await run("boot");
    assert.deepEqual({ udp: blocked.udp, tcp: blocked.tcp }, { udp: 0, tcp: 0 }, `nothing leaves the agent's frame over WebRTC: ${blocked.shown}`);
    assert.equal(blocked.frames, 0, `the boot block alone leaves the device stream without video: ${blocked.shown}`);
    const windowed = await run("window");
    assert.deepEqual({ udp: windowed.udp, tcp: windowed.tcp }, { udp: 0, tcp: 0 }, `nothing leaves the agent's frame over WebRTC: ${windowed.shown}`);
    assert.ok(windowed.candidates > 0 && windowed.frames > 0, `the device stream connects from the app's WebRTC window: ${windowed.shown}`);
  } finally {
    device.kill();
    udp.close();
    tcp.close();
    web.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
