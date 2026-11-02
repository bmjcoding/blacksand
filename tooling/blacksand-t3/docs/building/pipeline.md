# The build pipeline

> **Applies to:** every build, macOS and Linux, on each machine and in CI. Code:
> `tooling/blacksand-t3/lib/build.mjs`, `tooling/blacksand-t3/lib/strip-engine.mjs`,
> `tooling/blacksand-t3/lib/smoke.mjs`, `tooling/blacksand-t3/lib/files/tripwire.cjs`. Tests:
> `tooling/blacksand-t3/test/build-*.test.mjs`, `tooling/blacksand-t3/test/strip-rules.test.mjs`.

Each update builds the pinned upstream commit from source. It builds as the
[build account](build-account.md), in a private `TMPDIR`. If a step fails, the update
stops and the installed build stays.

1. **Host scan.** Before any rule runs, the build checks every host that upstream's
   app source writes in a URL against `tooling/blacksand-t3/lib/known-hosts.txt`. It reads
   hosts the way a URL parser does, in lowercase and punycode, without userinfo or a
   trailing dot. IP literals count as hosts. The scan skips names under the reserved
   `.invalid`, `.test`, `.localhost` and `.example` TLDs, and it skips loopback
   addresses. It doesn't skip `example.com`, `example.net` and `example.org`, because
   they resolve, so each use of them is listed. An unlisted host aborts the update. It
   may be a new phone-home that no rule targets and the smoke test never triggers.
   Look at what talks to the host, then add a rule or list the host with a note.
   Listing a host means someone looked at it, not that it's allowed.
2. **Strip rules.** The rules write only inside the checkout, and a symlink in the
   checkout never redirects a rule's write ([upstream rules](../updates/upstream-rules.md)).
3. **Dependency installs.** The build resolves and checks dependencies before it
   installs anything ([dependencies](dependencies.md)).
4. **Typecheck.** The build typechecks every package the rules edit, so the injected
   files still match upstream's interfaces. A type error in a file that a feature
   added or edited leaves that feature out. Any other type error stops the update.
5. **Package.** The build packages the app, with the staged production install
   guarded ([dependencies](dependencies.md#the-staged-production-install)).
6. **Forbidden-endpoint scan.** The build scans its output for known telemetry
   endpoints and keys. It scans the packaged app the same way, right after collecting
   it. The scan reads unpacked `node_modules` and binaries, matches any letter case,
   and also reads UTF-16.
7. **Smoke test.** See [the smoke test](#the-smoke-test) below.
8. **Screenshots and the build report.** On a machine with Chrome, the build takes
   screenshots and writes the build report
   ([build report](../updates/upstream-rules.md#the-build-report)).
9. **Sign and install.** The build account hands back an unsigned app. You scan it
   again, sign it and install it. Signing happens on macOS only.

`blacksand t3 check --build` runs steps 1 to 7 without installing.

## The smoke test

The build boots the newly built server with a network tripwire preloaded
(`tooling/blacksand-t3/lib/files/tripwire.cjs`). The server gets a minimal `PATH` and an
empty `HOME`, so it has no harness credentials.

- **What it catches.** The tripwire blocks and records every non-loopback connection,
  DNS lookup and UDP send from Node. It does this in the server, in its workers and in
  every Node process the server starts. The tripwire always loads first. It goes at
  the front of `NODE_OPTIONS` and of each worker's options, so nothing preloaded runs
  before it.
- **Network clients.** The tripwire blocks the network clients the server spawns, such
  as curl, ssh, nc, or a git command that talks to a remote. It lets a client run only
  to ask for its version or help. The tripwire recognises a client by the program that
  actually runs, whatever name it's started under, and it follows links to find that
  program. This holds for a client started directly or through wrappers (`env`,
  `env -S`, `exec`, `nohup`, `timeout` and others). It also holds in shell command
  lines, from sync calls and from `process.execve`. The tripwire looks up each command
  where the program that runs it would look.
- **Lines it can't read are failures.** The tripwire blocks a wrapper used in a form
  it can't read. It also blocks a shell line that changes how its commands are found
  (`cd`, a `PATH` change, `alias`, `hash`, `source`, `.`). It blocks a line that runs a
  command word that isn't plain, such as `$x`, `~`, a glob, or quotes or escapes inside
  a word. It logs each of these as `(unreadable)`, which fails the smoke test.
- **Pass condition.** The server answers with the CSP in place and makes zero network
  attempts in 20 seconds.
- **Control.** Unstripped upstream trips the tripwire within seconds, by contacting
  PostHog and GitHub.

The packaged server runs under the same tripwire when an update takes the build
report's screenshots. If the server tries to reach the network then, the update fails
and installs nothing.

## Limits

- **The smoke test covers startup only.** It runs the built server's first 20 seconds
  with an empty profile. It watches Node networking only, plus the known network
  clients the server starts. It runs the build's `apps/server` output under the
  build's Node, not the packaged Electron app. It doesn't exercise the desktop's main
  process, a stored configuration, a signed-in provider, anything you do in the app,
  or anything that starts later.
- **The tripwire can't see everything.** It can't see native code, interpreters such
  as python or perl, or a network client copied under another name rather than
  linked. It can't see any other program that opens its own sockets. The host scan,
  the forbidden-endpoint scan and the strip rules are the checks for those.
- **The tripwire reads shell lines heuristically.** It isn't a full shell parser. It
  follows the forms it knows and refuses a line it can't read. So a new upstream shell
  line can hold an update until the tripwire supports that form. It doesn't read a
  script file run without `-c`, or a login shell's startup files.
- **The packaged server boots only where Chrome is installed.** It boots while the
  update takes the screenshots. On a machine without Chrome, which is usually a host,
  the update doesn't boot the packaged server before installing it. CI never boots
  it.
- **The scans read literal text.** They can't see a name assembled at runtime. For
  `${region}.example.org`, the host scan checks only the domain written after the
  expression. They also can't see content inside compressed files.
