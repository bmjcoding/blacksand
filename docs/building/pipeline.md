# The build pipeline

> **Applies to:** every build, macOS and Linux, on each machine and in CI. Code:
> `packages/t3/lib/build.mjs`, `packages/t3/lib/strip-engine.mjs`, `packages/t3/lib/smoke.mjs`, `packages/t3/lib/files/tripwire.cjs`.
> Tests: `packages/t3/test/build-*.test.mjs`, `packages/t3/test/strip-rules.test.mjs`.

Each update builds the pinned upstream commit from source, as the
[build account](build-account.md), in a private `TMPDIR`. A step that fails stops the
update, and the installed build stays.

1. **Host scan.** Before any rule runs, every host that upstream's app source writes
   in a URL is checked against `packages/t3/lib/known-hosts.txt`. Hosts are read the way a URL
   parser reads them (lowercase, punycode, no userinfo or trailing dot), IP literals
   included. Names under the reserved `.invalid`, `.test`, `.localhost` and `.example`
   TLDs, and loopback addresses, are skipped. `example.com`, `example.net` and
   `example.org` aren't skipped, because they resolve, so each use is listed. An
   unlisted host aborts the update: it may be a new phone-home that no rule targets
   and the smoke test never triggers. Look at what talks to it, then add a rule, or
   list the host with a note. Being listed means looked at, not allowed.
2. **Strip rules** ([upstream rules](../updates/upstream-rules.md)). Rule writes stay
   inside the checkout; a symlink in the checkout never redirects one.
3. **Dependency installs,** resolved and checked before anything is installed
   ([dependencies](dependencies.md)).
4. **Typecheck.** Every package the rules edit is typechecked, so the injected files
   still match upstream's interfaces. A type error in a file a feature added or edited
   leaves that feature out; any other type error stops the update.
5. **Package,** with the staged production install guarded
   ([dependencies](dependencies.md#the-staged-production-install)).
6. **Forbidden-endpoint scan.** The build output, and the packaged app right after
   it's collected, are scanned for known telemetry endpoints and keys. The scan reads
   unpacked `node_modules`, binaries, any letter case, and UTF-16.
7. **Smoke test** (below).
8. **Screenshots and the build report,** on a machine with Chrome
   ([build report](../updates/upstream-rules.md#the-build-report)).
9. **Sign and install** (signing on macOS only). The build account hands back an
   unsigned app; you scan it again, sign it and install it.

`packages/t3/bin/t3blackout check --build` runs steps 1–7 without installing.

## The smoke test

The newly built server boots with a network tripwire preloaded
(`packages/t3/lib/files/tripwire.cjs`), an empty `HOME` (no harness credentials) and a minimal
`PATH`.

- **What it catches:** the tripwire blocks and records every non-loopback
  connection, DNS lookup and UDP send from Node, in the server, its workers and every
  Node process it starts. It always loads first: it goes at the front of
  `NODE_OPTIONS` and of each worker's options, so nothing preloaded runs before it.
- **Network clients it spawns** (curl, ssh, nc, a git command that talks to a
  remote, …) are blocked unless they only ask for their version or help. A client is
  recognised by the program that really runs, whatever name it's started under (links
  followed). That holds directly, through wrappers (`env`, `env -S`, `exec`, `nohup`,
  `timeout`, …), in shell command lines, from sync calls and from `process.execve`.
  Each command is looked up where whatever runs it would look.
- **Lines it can't read are failures.** A wrapper used in a form the tripwire can't
  read is blocked. So is a shell line that changes how its commands are found (`cd`, a
  `PATH` change, `alias`, `hash`, `source`, `.`), or runs a command word that isn't
  plain (`$x`, `~`, a glob, quotes or escapes inside a word). Each is logged as
  `(unreadable)`, which fails the smoke test.
- **Pass condition:** the server answers with the CSP in place, and makes **zero**
  attempts in 20 seconds.
- **Control:** unstripped upstream trips it within seconds (PostHog, GitHub).

The packaged server runs under the same tripwire when an update takes the build
report's screenshots. If it tries to reach the network then, the update fails and
nothing is installed.

## Limits

- **The smoke test covers startup only.** It runs the built server's first 20 seconds
  with an empty profile, Node networking only (plus the known network clients it
  starts). It runs the build's `apps/server` output under the build's Node, not the
  packaged Electron app. It doesn't exercise the desktop's main process, a stored
  configuration, a signed-in provider, anything you do in the app, or anything that
  starts later.
- **The tripwire can't see** native code, interpreters such as python or perl, a
  network client copied (not linked) under another name, or any other program that
  opens its own sockets. The host scan, the forbidden-string scan and the strip rules
  are the checks for those.
- **The tripwire reads shell lines heuristically.** It isn't a full shell parser. It
  follows the forms it knows and refuses a line it can't read, so a new upstream shell
  line can hold an update until the tripwire learns it. It doesn't read a script file
  run without `-c`, or a login shell's startup files.
- **The packaged server is booted only where Chrome is installed,** while the
  screenshots are taken. On a machine without Chrome (a host, usually), the packaged
  server isn't booted before it's installed, and CI never boots it.
- **The scans read literal text.** They can't see a name assembled at runtime (for
  `${region}.example.org`, the host scan checks only the domain written after the
  expression), or content inside compressed files.
