# Privacy

> **Applies to:** the T3 Code (blacksand) app and its servers, macOS and Linux.

This page lists what blacksand-t3 removes, what still leaves the machine and why, how
each part is enforced, and how you can check it yourself.

## What is removed

The [strip rules](../updates/upstream-rules.md) remove these from every build:

| Removed | Rules (in `tooling/blacksand-t3/lib/rules.mjs`) |
|---|---|
| PostHog analytics and OTLP export | `server/analytics-noop-layer`, `server/analytics-defaults` |
| T3 Connect, Clerk, the relay and its browser-side tracing (Axiom) | `server/cloud-public-config-off`, `server/cloud-reconcile-off`, `server/relay-awareness-off`, `web/build-defines-empty`, `server/build-defines-empty` |
| the model-manifest and LiteLLM pricing fetches | `server/model-manifest-bundled-only`, `server/litellm-rates-off` |
| the UI's 5-minute npm poll for new `t3` releases, and the server-side lookup that replaced it | `web/no-npm-release-poll`, `server/no-npm-release-lookup` |
| Google favicon lookups | `shared/no-google-favicons` |
| the GitHub star check (asking GitHub, with the server's account token, whether that account starred upstream, then asking for a star) | `web/no-github-star-check` |
| the Electron auto-updater, and upstream's stock app and server downloads | `desktop/updater-*`, `desktop/no-publish-feed`, `server/no-stock-runtime*`, `ssh/runner-installed-blacksand-only` |
| upstream's background service (`t3 up`, `t3 status`); a stock service's hidden launcher refuses to start | `server/no-t3-up*`, `server/no-stock-service-launcher`, `server/no-stock-service-install` |
| text that sends you to stock T3 (`npx t3 …`, t3.codes downloads, upstream's release pages) | the `web/no-stock-*` and `server/no-stock-commands-*` rules; `stock/no-stock-guidance` fails the build on any left |
| tracing headers (`b3`, `traceparent`, `tracestate`) on outgoing requests | `server/no-trace-headers`, `desktop/no-trace-headers` |

The app also gets its own name, bundle ID and data directory (`~/.blacksand/t3`). The
welcome screen and **Settings → About** say it collects no usage data.

Outbound requests carry no tracing headers. By default, Effect, the library T3 is
built on, adds `b3` and `traceparent` to every HTTP request. They hold random IDs, not
account data, but they're no use outside the app. The server and the desktop app
turn them off once, for every request they make. Tracing inside the app is
unchanged.

## The agent CLIs

The boot environment (`tooling/blacksand-t3/lib/files/boot-env.ts`, rule `desktop/boot-env`)
runs first in the app. It does three things:

- It switches T3's telemetry off a second time.
- It switches off the agent CLIs' own analytics and crash reporting where a switch
  exists. That covers Claude Code (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), Grok,
  Pi, Muse, and Bun's crash reporter, which OpenCode uses. Codex takes only launch
  flags, so rule `provider/codex-analytics-off` adds them to every Codex launch.
- On Linux and Windows, it turns off Electron's spellchecker, which would otherwise
  download dictionaries from Google.

A server started without the desktop app (on an SSH host) gets the same switches
(rule `server/headless-telemetry-env`).

## What the app can reach

**Content-Security-Policy.** The UI can talk only to loopback. Remote images, CDN
icons and anything else upstream adds to the page fail to load, and the UI shows the
fallbacks it already has. The page itself, the server's static responses and the
desktop's app protocol all apply one policy, `tooling/blacksand-t3/lib/files/blacksandCsp.ts`.
Files the server serves from your projects get the same policy. Agent-written HTML,
MCP apps, SVGs and downloads keep upstream's sandbox policy and also get a second
policy with the same loopback-only reach. Their inline scripts still run, but they
can't load anything from outside, such as a CDN or an external API. Inline PDFs get no
policy, because Chrome's PDF viewer breaks under one.

### WebRTC

A CSP doesn't cover WebRTC, so the boot environment closes that route too.

- Every web contents in the app may send WebRTC over UDP only through a proxy
  (`disable_non_proxied_udp`). Chromium never proxies UDP, so no web contents sends
  WebRTC over UDP.
- The app's own session goes through a proxy that refuses every connection. That
  session covers the app's windows and the requests the desktop process makes through
  Electron's network stack. The proxy listens on a loopback port the app holds itself,
  so nothing else can answer there. WebRTC's TCP path follows the proxy setting.
  Loopback traffic never goes through a proxy, so the app's windows still reach the
  local server and forwarded SSH ports, and reach nothing else. If the app can't set
  the proxy, it quits.
- The preview browser has sessions of its own. It loses WebRTC over UDP, but keeps
  everything else, TCP WebRTC included. Copy Image on a preview-browser page fetches
  the image again through that page's own session (rule
  `desktop/context-menu-image-session`).
- EAS Simulator, Expo's cloud simulator service, streams over WebRTC. For it, the top
  frame of the app's own page, and no other frame, may open one hidden window that
  belongs to the app (rules `desktop/webrtc-window*`). That window keeps Chromium's
  default WebRTC policy. It stays on `about:blank`, opens nothing, and closes with the
  page that opened it. The device viewer makes its peer connections in that window,
  directly to Expo's cloud over UDP. Anything else that asks for that window, such as
  an agent's preview or an MCP app, gets an ordinary blocked window. The hidden
  window's TCP traffic still goes to the refusing proxy, so TURN over TCP or TLS isn't
  available.
- Local and SSH simulators and emulators don't use WebRTC. Their video and input go
  over HTTP and WebSocket through T3's own server connection
  ([devices](../devices/overview.md)).

## What still leaves the machine, and why

| What | Where to | Why, and how to stop it |
|---|---|---|
| Agent CLI traffic | each provider's API | the agents' job. What they reach is up to their sandboxes or yours. Cursor's SDK runs inside T3's server and reports usage events to Cursor's API, the host it needs for everything else. Antigravity's telemetry is controlled only by your Google account's settings |
| Provider CLI version checks | npm registry; Meta's release channel for Muse; Anthropic's release channel (downloads.claude.ai) for a natively installed Claude Code | so Update can offer versions at least 3 days old. For a native Claude Code, the channel's version is only a ceiling: Update offers the newest npm release at or below it whose own npm publish date is at least 3 days old. The channel request names only the channel. On by default; **Settings → Maintenance → Provider update checks** turns them off ([provider updates](../updates/provider-updates.md)) |
| GitHub images in chat | github.com | the server fetches them so they render. Other remote images don't render |
| Updates | github.com (this repository, upstream), registry.npmjs.org, Electron's and native packages' prebuilt binaries, raw.githubusercontent.com (LiteLLM's pricing table, pinned to a commit), api.osv.dev, api.github.com, releases.electronjs.org, nodejs.org | building and checking a release. Only update checks you start, and the scheduled updater, touch the network ([how updates arrive](../updates/how-updates-arrive.md)) |
| Device tools | registry.npmjs.org, and one prebuilt WebRTC library from GitHub | installing the device hub, only when you turn device support on ([device tools](../building/device-tools.md)) |
| EAS Simulator video | Expo's cloud, over UDP | only if you use EAS Simulator |
| The preview browser | whatever you open in it | it's a browser |
| The stock phone app | upstream's telemetry | only if you pair a phone ([phone](../remote-access/phone.md)) |

## Trade-offs

- **Remote environments connect over SSH only.** T3 Connect is gone, along with relay
  and mobile pairing through T3's servers. The phone can pair directly with a host
  over Tailscale instead, without push notifications.
- **Remote images in chat don't render, except GitHub's.** Link favicons show a
  generic icon.
- **Agent previews can't load outside resources.** Agent-written HTML and MCP apps get
  the loopback-only CSP too.
- **The model list is the one bundled in each build.** Pinned rebuilds keep it at most
  as current as the pin.
- **Cost estimates keep working.** `update` downloads LiteLLM's pricing table, pinned
  to a commit, and seeds the app's cache. On a Mac with agent accounts, it also
  publishes the table in `/Users/Shared/blacksand` for them. The app never fetches it.
- **Updates take a few minutes.** Each one is a local build, not a download.

## How it's enforced

Every build, on every machine, runs these before installing
([build pipeline](../building/pipeline.md)):

1. **The host scan.** The scan checks URL literals in selected upstream app source
   against `tooling/blacksand-t3/lib/known-hosts.txt`, excluding reserved names and
   loopback. An unlisted host stops the update. Calls to listed hosts,
   runtime-assembled names and files outside the scan can escape it
   ([limits](../building/pipeline.md#limits)).
2. **Strict strip rules.** A privacy rule that no longer matches stops the update.
3. **The forbidden-endpoint scan.** It scans the build output and the packaged app.
4. **The network tripwire smoke test.** The built server must make zero non-loopback
   connections, DNS lookups or UDP sends in its first 20 seconds.

These tests cover the enforcement:

- `tooling/blacksand-t3/test/strip-rules.test.mjs`
- `tooling/blacksand-t3/test/build-strip-engine.test.mjs`
- `tooling/blacksand-t3/test/build-tripwire.test.mjs`
- `tooling/blacksand-t3/test/build-tripwire-exec.test.mjs`
- `tooling/blacksand-t3/test/app-webrtc.test.mjs`
- `tooling/blacksand-t3/test/app-stock-guidance.test.mjs`
- `tooling/blacksand-t3/test/privacy-text.test.mjs`
- `tooling/blacksand-t3/test/no-trace-headers.test.mjs`
- `tooling/blacksand-t3/test/stripped/blacksand*Csp.test.ts` and `blacksandTraceHeaders.test.ts`,
  which run inside the stripped checkout

## Check it yourself

- **Run the rules against a release.** `blacksand t3 check` applies them to the pinned
  release without building. `blacksand t3 check --build` also builds, scans and runs
  the smoke test, without installing.
- **Run the smoke test on your last build.** Use `blacksand t3 smoke`.
- **Watch the running app.** Use a per-process firewall or monitor (Little Snitch,
  LuLu, or `nettop -p <pid>` on macOS; `ss -tpn` on Linux). Then compare what the app
  and its servers connect to with the table above. Expect your providers, plus
  whatever you opened in the preview browser.
- **Read the rules.** Each rule in `tooling/blacksand-t3/lib/rules.mjs` has an id, the anchor
  it must match, and a `why`. `tooling/blacksand-t3/lib/known-hosts.txt` says why each listed
  host is fine.

## Limits

- **blacksand-t3 doesn't enforce network limits at runtime.** Every update checks T3's
  own code for calls home, within the limits of the
  [smoke test](../building/pipeline.md#limits).
  The agent CLIs talk to their providers directly. Sandbox the agents with your own
  tooling ([threat model](threat-model.md#non-goals)).
- **Electron timing.** The app sets its refusing proxy asynchronously at startup.
  Measured, it takes effect 27 to 32 ms after Electron is ready, long before an agent's
  preview or an MCP app can load. Nobody has measured whether such a frame's
  `<link rel=dns-prefetch>` makes Chromium resolve a name locally. A CSP doesn't cover
  it.
- **EAS Simulator video needs UDP.** On a network that blocks UDP, EAS devices show no
  video. Allowing TCP would mean letting the whole session, untrusted frames included,
  reach those relays.
