# Troubleshooting

> **Applies to:** every role, macOS and Linux. Host, SSH, phone and Screen Sharing
> entries are macOS-only.

The log of the last update is `state/t3blackout.log` in the clone (readable only by
you). On a host, `state/update.out.log` has the scheduled job's output.

## When the app won't start

The app's startup error suggests these Terminal commands:

- **Go back a build:** `~/.t3blackout/bin/t3blackout rollback` swaps in the build that
  was installed before this one. When the startup dialog offers it, its **Copy rollback
  command** button copies that line.
- **Rebuild the release you're on:** quit the app, then run
  `~/.t3blackout/bin/t3blackout update --force`. Plain `update` builds only when
  there's a newer pin or a newer T3 Blackout commit. If the app is still running, the
  build waits; `packages/t3/bin/t3blackout launch` installs it and opens the app.

## When an update fails

You get a desktop notification, and the installed build is untouched. The update
button offers the release again.

- **A strict rule no longer matches:** upstream changed that code. `packages/t3/bin/t3blackout
  drift` shows how; update the anchor in `packages/t3/lib/rules.mjs` ([upstream rules](updates/upstream-rules.md#fixing-a-rule)).
  Feature rules never fail an update; they're left out instead.
- **The smoke test saw outbound traffic:** upstream added a network call. The host is
  in the error. Add a rule that disables it.
- **"The packaged server reached out while it was photographed":** the same, seen in
  the packaged app. Nothing was installed.
- **An unknown host in upstream's source:** look at what talks to it (the error names
  the file and line). Then add a rule, or list it in `packages/t3/lib/known-hosts.txt` with a note.
- **The typecheck failed outside a feature:** upstream changed an interface a strict
  file uses, such as the updater interface `packages/t3/lib/files/BlackoutUpdater.ts` implements.
  Update that file to match.
- **A device tool has no reviewed lockfile, or an unlisted install script:** the error
  says which ([device tools](building/device-tools.md)).
- **"The staged install in … isn't what was installed from its checked lockfile":**
  something changed, removed or added files in the packager's staged install after the
  guard installed it, beyond what packaging is known to add. If upstream changed how it
  packages, look at the files named and update `stageChanges` in
  `packages/t3/lib/stage-install.mjs`. "t3blackout refused … in the packager's stage" means
  upstream runs a new package-manager command there.
- **New stock-T3 wording** (`stock/no-stock-guidance`): add a rule that replaces it,
  before `brand/name` in `packages/t3/lib/rules.mjs`.
- **Upstream asks for another pnpm** (the build stops naming the version): raise the
  pin once that pnpm is at least 3 days old ([pnpm pin](updates/pnpm-pin.md)). A pnpm
  whose bytes don't match the pin is refused the same way; rerunning `packages/t3/install.sh`
  reinstalls it.
- **GitHub's API rate limit** ("… rate limit …" from an advisory check): this address
  used its 60 requests for the hour. The next hourly run tries again. A token in
  `state/github-token` lifts the limit ([advisory sources](updates/fast-lane.md#advisory-sources)).
- **A network error fetching a native package's headers or binary** (node-pty's, say,
  `ETIMEDOUT`): rerun; nothing was installed.
- **"Update not applied: the staged build was made with T3 Blackout …"** (or "staged
  build not installed" in the log after `launch`): the waiting build came from another
  T3 Blackout commit than this clone's. The installed build keeps running.
  `packages/t3/bin/t3blackout update`, or the next hourly run, rebuilds it.
- **Every git call fails, saying git is missing security fixes or is too old:** the
  `git` on this machine's `PATH` is older than 2.55.0 (Apple's came first, say). On
  macOS, `brew install git`, put Homebrew's `bin` first (the `eval` line in
  `~/.zprofile`), open a new Terminal window, check `git --version`, and rerun
  `packages/t3/install.sh --role …`, which reschedules with the current `PATH`.
- **Builds refused because this install builds only as its build account** (the
  `builds:` line in `status` says so): the build account is gone, sudo can't switch to
  it, or `state/install.json` is missing. Rerun `packages/t3/install.sh` (it needs sudo once).
- **A build gives up waiting for the build tools' lock:** `install.sh` was replacing
  the tools, or something else holds their lock. `sudo lsof` on the file the message
  names shows the holder. Rerun once it's gone. When the tools' checks say to rerun
  `packages/t3/install.sh`, do it: it puts them back or repairs them.
- **`status` shows `interrupted:`:** an install or rollback was cut off. The next
  update or rollback finishes it, or puts the previous build back, first. If that stops
  with "`state/activation.json` is damaged (…)" or "says its build went in, but nothing
  is installed", the journal is one this install can't trust. Compare the app folders
  (`T3 Blackout.app`, and the hidden `.T3 Blackout.previous`, `.outgoing`, `.new` and
  `.pending` copies beside it) with `state/current.json` by hand, so that `T3
  Blackout.app` is the build that file names. Then remove `state/activation.json`.
- **Every command stops with an error about `state/install.json`:** the file is
  unreadable or invalid. `packages/t3/bin/t3blackout configure --role ui` (or `host`, `both`)
  writes a new one.
- **Every command stops with "… is this clone (…) or inside it" or "… isn't an
  absolute path":** a location variable in the environment can't be used. Unset it, or
  set it to an absolute path outside the clone, and rerun `packages/t3/install.sh --role …`.

## Self-update

These appear in the log; only "refused" also notifies.

- **"self-update refused":** origin has a commit not signed by a key in
  `.allowed_signers`, or an evaluator pin the machine couldn't verify. The log names
  it ([self-update](updates/self-update.md)).
- **"self-update held":** the newest evaluator pin adds a dependency under 3 days old,
  or the clock is ahead. The machine keeps building the pin it has, and takes the new
  one once the dependency has aged. "this Mac's clock is ahead" means turn on **Set time
  automatically** (Linux: network time).
- **"self-update skipped: couldn't fetch (refusing to reach … its own git configuration
  sets …)":** the clone's `.git/config` sets something that decides how git connects.
  Remove what it names (`git config --unset-all <key>` in the clone).
- **"self-update skipped: couldn't fetch (origin isn't a github.com repository URL,
  …)":** origin is an SSH host alias or another non-GitHub URL. Run `git remote set-url
  origin https://github.com/<owner>/t3blackout.git`, and keep an alias in the push URL
  ([cloning](install/clone.md#origin-and-pushing)).
- **Other "self-update skipped: couldn't …" lines:** github.com, the npm registry,
  OSV.dev or api.github.com wasn't reachable that run.
- **An update (or `install.sh`'s first build) says it's not building because `pin.json`
  can't be verified yet:** a pin in this clone hasn't passed this machine's own checks.
  Held: wait until the named dependency is old enough, or fix the clock. Skipped: a
  source wasn't reachable. On a first install, rerun `packages/t3/install.sh --role …`; later,
  the hourly run retries. Refused: a shallow clone needs `git fetch --unshallow`;
  otherwise don't build it. A commit you sign that sets `pin.json` replaces the pin.

## Install

- **`install.sh` stops because sudo didn't authorize you:** run it from an admin
  account, in a terminal at the machine, and approve the sudo prompt.
  `--unisolated-build` is for machines with no sudo at all ([build account](building/build-account.md)).
- **`install.sh` stops on Linux asking for a newer git:** install git 2.55.0 or later
  ([prerequisites](getting-started/prerequisites.md#linux)), then rerun it.
- **`signing init` fails over SSH with "The authorization was denied since no user
  interaction was possible":** run `install.sh` (or `signing init`) in Terminal at the Mac.
- **"T3 Blackout is not installed on this host":** run `packages/t3/install.sh --role host`
  there. The app must be in `/Applications`.
- **The host doesn't update:** check `packages/t3/bin/t3blackout status` (the schedule line),
  `sudo launchctl print system/dev.t3blackout.update`, and the two logs. A clone inside
  `~/Documents`, `~/Desktop` or `~/Downloads` is blocked for the daemon: move it and
  rerun `packages/t3/install.sh --role host`.
- **"This host has no T3 Blackout update agent":** the host's request folder is
  missing. Run `packages/t3/bin/t3blackout schedule` as the installing admin there.

## SSH

- **`Permission denied (publickey)` or `Too many authentication failures`:** `ssh -v
  agent-claude@t3b-host` shows which keys were offered. Usually `~/.ssh/config` lacks
  the `IdentityAgent` line or the `Host t3b-host localhost 127.0.0.1 ::1` block, your
  agent is locked, or the account script authorized a different key. Rerun it with
  `--key ~/.ssh/t3blackout.pub` ([your SSH key](accounts/agent-accounts.md#your-ssh-key)).
- **`WARNING: UNPROTECTED PRIVATE KEY FILE!` … `t3blackout.pub` … `bad permissions`,
  then `Permission denied`:** ssh couldn't reach your agent, so it tried the `.pub`
  file as a private key. Unlock the agent, and check the config.
- **Logins refused for a while after several failures:** sshd's per-source penalties
  (`PerSourcePenalties`) block an address that kept failing, for seconds to minutes.
  Fix the key problem, wait, and retry.
- **`Host key verification failed` in the app, or `REMOTE HOST IDENTIFICATION HAS
  CHANGED` in Terminal:** the host was rebuilt, or this is the first connection. Remove
  the old entry (`ssh-keygen -R t3b-host`, plus its `100.x` address if you used it),
  then trust the key again ([connecting](accounts/connect.md#trust-the-hosts-key)). For
  the standby lane, rerun its account script.
- **`Connection refused` on port 22:** Remote Login is off, or the account isn't
  allowed. Rerun the account script and check the access list.
- **`Permission denied` (or the connection closes) from a machine whose key is
  right:** the source filter may have refused its address. `sudo sshd -T -C
  user=agent-claude,host=x,addr=<its address> | grep -i '^denyusers'` on the host says
  so. Connect by the host's Tailscale name (never its LAN address or `.local` name), or
  fix `--allow-from`.
- **Timeouts:** the machine isn't on the tailnet, or the policy doesn't allow it. Run
  `tailscale status` on the desktop, try the `100.x` address, and check the policy
  tests and that both machines carry their tags.
- **The host is `t3b-host-1`:** the old machine still existed. Delete it in the admin
  console and rename the new one.
- **The host dropped off after weeks:** its key expired. Disable key expiry and
  re-authenticate it ([Tailscale](networking/tailscale.md#the-host-tailscaled-as-a-system-daemon)).
- **The standby sshd isn't listening:** read `/var/log/dev.t3blackout.sshd.log`, and
  rerun its account script.

## Agent accounts and providers

- **"T3 Blackout sets up no background service, so remove this one with `t3 service
  uninstall`":** an upstream `t3` background service is still installed in that
  account. Do what it says, as that account.
- **"…server.env must belong to you and be readable only by you":** run
  `/usr/local/libexec/t3blackout/set-claude-token` again as that account.
- **Claude says it isn't logged in over SSH:** there's no token in `server.env`. A
  Keychain login doesn't work over SSH ([providers](accounts/providers.md#sign-in)).
- **A provider shows as not installed:** its CLI isn't on the login shell's `PATH`.
  Check with the `zsh -ilc` command in [providers](accounts/providers.md#install-the-cli),
  fix `~/.zprofile`, then switch the environment off and on.
- **`Error: claude native binary not installed.`:** npm skipped Claude Code's install
  script. Rerun the `npm install -g …` line as that account; it includes
  `--allow-scripts=@anthropic-ai/claude-code`.
- **Settings won't update a provider, "…installed with bun/yarn/Volta/Vite+, which
  can't hold its dependencies to the 3-day minimum release age":** reinstall that CLI
  with npm.
- **An ACP Registry agent "isn't supported in T3 Blackout":** it ships only a prebuilt
  binary. T3 Blackout installs agents only from npm or PyPI packages (`npx`, `uvx`;
  `brew install uv` for the latter).
- **The desktop says the account's server is still starting:** the phone service's
  server is starting or restarting after an update. Wait a minute and reconnect; its
  log is in that account's `~/.t3blackout/phone/`.
- **"T3 Blackout server … still runs a build this host has replaced and did not stop;
  stop it (kill -9 …) and connect again":** a server from the old build didn't stop
  when the connection tried (SIGTERM, then SIGKILL after 5 seconds). Do what it says,
  as that agent account, then connect again. Each account keeps one record per server in `~/.t3blackout/ssh-servers/`
  (its pid, start time, build and command line), which is how a connection finds it.
- **Pairing fails with an HTTP 500 right after a host update:** an old server is still
  running. Switch the environment off and on.

## Devices

- **A simulator won't boot in a host account, or the Device panel never shows one:**
  run the SSH boot check in [iOS](devices/ios.md#simulators) as that account. If it
  works only while the account is logged in at the host's screen, keep it logged in.
- **"Android SDK was not found…" or "…missing from…"** for an account whose SDK is
  installed: the server never sees `ANDROID_HOME`. Install the SDK in
  `~/Library/Android/sdk` ([Android](devices/android.md#install)), then switch the
  environment off and on.
- **"JAVA_HOME is not set and no 'java' command could be found"**, or "Failed to run
  `avdmanager list avd`": `openjdk@17` isn't installed, or that account's `~/.zprofile`
  lacks the `JAVA_HOME` and `PATH` lines.
- **"No video received from the device"** for an Android emulator: start it from the
  Device panel; one started by hand isn't streamed.
- **An agent's iOS taps fail with a Developer Tools authorization error:** see
  [iOS](devices/ios.md#simulators).
- **An EAS Simulator device shows no video:** the network blocks UDP. Use a network
  that allows UDP. Local and host simulators don't depend on it.

## Phone and Screen Sharing

- **`--pair` says Tailscale isn't ready for HTTPS:** the host isn't signed in to the
  tailnet, or HTTPS certificates aren't on.
- **The phone service won't change its port, or `--remove` stops:** a rerun keeps the
  port; run `--remove` first, then add it with the new `--port`. `--remove` needs
  tailscaled running, and nothing else in Serve reaching the server's port.
- **Screen Sharing setup says screensharingd didn't answer:** this macOS won't run it
  the script's way, and Screen Sharing stays off. The crash report it names says why.
  For a public issue, share only the macOS version, the error and the relevant lines,
  with names, hostnames, home paths and UUIDs removed.
- **Screen Sharing setup says macOS hasn't granted screen capture and control:** do
  the [one-time capture step](remote-access/screen-sharing.md#the-one-time-capture-step)
  at the Mac, then rerun.
- **Screen Sharing won't change state, or `--off` / `--uninstall` exits naming what
  remains:** usually tailscaled isn't answering, a Serve rule you made by hand reaches
  15900 or 15901, or Funnel is on. `--status` names it. Fix that and rerun. Until then,
  the minute's check stays in force.
