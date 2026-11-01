# Troubleshooting

> **Applies to:** every role, macOS and Linux. Host, SSH, phone and Screen Sharing
> entries are macOS-only.

The log of the last update is `state/blacksand-t3.log` in the clone. Only you can read
it. On a host, `state/update.out.log` has the scheduled job's output.

## When the app won't start

The app's startup error suggests these Terminal commands:

- **Go back a build.** `blacksand t3 rollback` swaps in the build that was installed
  before this one. When the startup dialog offers it, its **Copy rollback command**
  button copies that line.
- **Rebuild the release you're on.** Quit the app, then run
  `blacksand t3 update --force`. Plain `update` builds only when there's a newer pin
  or a newer blacksand-t3 commit. If the app is still running, the build waits.
  `blacksand t3 launch` then installs it and opens the app.

## When an update fails

You get a desktop notification, and the installed build is untouched. The update
button offers the release again.

- **A strict rule no longer matches.** Upstream changed that code. `blacksand t3
  drift` shows how. Update the anchor in `tooling/t3code/lib/rules.mjs`
  ([upstream rules](updates/upstream-rules.md#fixing-a-rule)). Feature rules never
  fail an update. The build leaves them out instead.
- **The smoke test saw outbound traffic.** Upstream added a network call. The error
  names the host. Add a rule that disables the call.
- **The error says "The packaged server reached out while it was photographed".**
  Upstream added a network call, seen this time in the packaged app. Nothing was
  installed.
- **An unknown host in upstream's source.** Look at what talks to it. The error names
  the file and line. Then add a rule, or list the host in
  `tooling/t3code/lib/known-hosts.txt` with a note.
- **The typecheck failed outside a feature.** Upstream changed an interface that a
  strict file uses, such as the updater interface that
  `tooling/t3code/lib/files/BlacksandUpdater.ts` implements. Update that file to
  match.
- **A device tool has no reviewed lockfile, or has an unlisted install script.** The
  error says which ([device tools](building/device-tools.md)).
- **The error says "The staged install in … isn't what was installed from its checked
  lockfile".** Something changed, removed or added files in the packager's staged
  install after the guard installed it, beyond what packaging is known to add. If
  upstream changed how it packages, look at the files named and update `stageChanges`
  in `tooling/t3code/lib/stage-install.mjs`. The message "blacksand refused … in the
  packager's stage" means upstream runs a new package-manager command there.
- **New stock-T3 wording (`stock/no-stock-guidance`).** Add a rule that replaces it,
  before `brand/name` in `tooling/t3code/lib/rules.mjs`.
- **Upstream asks for another pnpm, and the build stops naming the version.** Raise
  the pin once that pnpm is at least 3 days old ([pnpm pin](updates/pnpm-pin.md)). The
  build refuses a pnpm whose bytes don't match the pin the same way. Rerunning
  `tooling/t3code/install.sh` reinstalls it.
- **An advisory check hits GitHub's API rate limit ("… rate limit …").** This address
  used its 60 requests for the hour. The next hourly run tries again. A token in
  `state/github-token` lifts the limit
  ([advisory sources](updates/fast-lane.md#advisory-sources)).
- **A network error fetching a native package's headers or binary, such as
  `ETIMEDOUT` for node-pty's.** Rerun. Nothing was installed.
- **"Update not applied: the staged build was made with Blacksand T3 …", or "staged
  build not installed" in the log after `launch`.** The waiting build came from a
  different blacksand-t3 commit than this clone's. The installed build keeps running.
  `blacksand t3 update`, or the next hourly run, rebuilds it.
- **Every git call fails, saying git is missing security fixes or is too old.** The
  `git` on this machine's `PATH` is older than 2.55.0. Apple's git may come first, for
  example. On macOS, run `brew install git`, put Homebrew's `bin` first (the `eval`
  line in `~/.zprofile`), and open a new Terminal window. Check `git --version`, then
  rerun `tooling/t3code/install.sh --role …`, which reschedules with the current
  `PATH`.
- **Builds refused because this install builds only as its build account.** The
  `builds:` line in `status` says so. The build account is gone, sudo can't switch to
  it, or `state/install.json` is missing. Rerun `tooling/t3code/install.sh`. It needs
  sudo once.
- **A build gives up waiting for the build tools' lock.** `install.sh` was replacing
  the tools, or something else holds their lock. `sudo lsof` on the file the message
  names shows the holder. Rerun once it's gone. When the tools' checks say to rerun
  `tooling/t3code/install.sh`, do it. It puts the tools back or repairs them.
- **`status` shows `interrupted:`.** An install or rollback was cut off. The next
  update or rollback first finishes it, or puts the previous build back. It may stop
  with "`state/activation.json` is damaged (…)" or "says its build went in, but
  nothing is installed". Then the journal is one this install can't trust. Compare
  the app folders with `state/current.json` by hand, and make sure `T3 Code (blacksand).app`
  is the build that file names. The app folders are `T3 Code (blacksand).app` and the hidden
  `.T3 Code (blacksand).previous`, `.outgoing`, `.new` and `.pending` copies beside it. Then
  remove `state/activation.json`.
- **Every command stops with an error about `state/install.json`.** The file is
  unreadable or invalid. `blacksand t3 configure --role ui` (or `host`, `both`)
  writes a new one.
- **Every command stops with "… is this clone (…) or inside it" or "… isn't an
  absolute path".** A location variable in the environment can't be used. Unset it,
  or set it to an absolute path outside the clone, and rerun
  `tooling/t3code/install.sh --role …`.

## Self-update

These messages appear in the log. Only "refused" also sends a notification.

- **The log says "self-update refused".** Origin has a commit that no key in
  `.allowed_signers` signed, or an evaluator pin the machine couldn't verify. The log
  names it ([self-update](updates/self-update.md)).
- **The log says "self-update held".** The newest evaluator pin adds a dependency
  under 3 days old, or the clock is ahead. The machine keeps building the pin it has,
  and takes the new one once the dependency has aged. "this Mac's clock is ahead"
  means you should turn on **Set time automatically**, or network time on Linux.
- **The log says "self-update skipped: couldn't fetch (refusing to reach … its own
  git configuration sets …)".** The clone's `.git/config` sets something that decides
  how git connects. Remove what it names with `git config --unset-all <key>` in the
  clone.
- **The log says "self-update skipped: couldn't fetch (origin isn't a github.com
  repository URL, …)".** Origin is an SSH host alias or another non-GitHub URL. Run
  `git remote set-url origin https://github.com/<owner>/blacksand.git`, and keep an
  alias in the push URL ([cloning](install/clone.md#origin-and-pushing)).
- **Other "self-update skipped: couldn't …" lines.** github.com, the npm registry,
  OSV.dev or api.github.com wasn't reachable that run.
- **An update, or `install.sh`'s first build, says it's not building because
  `pin.json` can't be verified yet.** A pin in this clone hasn't passed this machine's
  own checks. If it's held, wait until the named dependency is old enough, or fix the
  clock. If it's skipped, a source wasn't reachable. On a first install, rerun
  `tooling/t3code/install.sh --role …`. Later, the hourly run retries. If it's
  refused and the clone is shallow, run `git fetch --unshallow`. Otherwise, don't
  build it. A commit you sign that sets `pin.json` replaces the pin.

## Install

- **`install.sh` stops because sudo didn't authorize you.** Run it from an admin
  account, in a terminal at the machine, and approve the sudo prompt.
  `--unisolated-build` is for machines with no sudo at all
  ([build account](building/build-account.md)).
- **`install.sh` stops on Linux and asks for a newer git.** Install git 2.55.0 or
  later ([prerequisites](getting-started/prerequisites.md#linux)), then rerun it.
- **`signing init` fails over SSH with "The authorization was denied since no user
  interaction was possible".** Run `install.sh`, or `signing init`, in Terminal at
  the Mac.
- **You see "Blacksand T3 is not installed on this host".** Run
  `tooling/t3code/install.sh --role host` on that host. The app must be in
  `/Applications`.
- **The host doesn't update.** Check `blacksand t3 status` (the schedule line),
  `sudo launchctl print system/dev.blacksand.update`, and the two logs. The daemon
  can't reach a clone inside `~/Documents`, `~/Desktop` or `~/Downloads`. Move the
  clone and rerun `tooling/t3code/install.sh --role host`.
- **You see "This host has no Blacksand T3 update agent".** The host's request folder
  is missing. Run `blacksand t3 schedule` on the host, as the admin who installed it.

## SSH

- **`Permission denied (publickey)` or `Too many authentication failures`.**
  `ssh -v agent-claude@t3b-host` shows which keys ssh offered. The usual causes are
  these: `~/.ssh/config` lacks the `IdentityAgent` line or the
  `Host t3b-host localhost 127.0.0.1 ::1` block, your SSH agent is locked, or the
  account script authorized a different key. Rerun the script with
  `--key ~/.ssh/blacksand.pub` ([your SSH key](accounts/agent-accounts.md#your-ssh-key)).
- **`WARNING: UNPROTECTED PRIVATE KEY FILE!` … `blacksand.pub` … `bad permissions`,
  then `Permission denied`.** ssh couldn't reach your SSH agent, so it tried the
  `.pub` file as a private key. Unlock the agent, and check the config.
- **Logins refused for a while after several failures.** sshd's per-source penalties
  (`PerSourcePenalties`) block an address that kept failing, for seconds to minutes.
  Fix the key problem, wait, and retry.
- **`Host key verification failed` in the app, or `REMOTE HOST IDENTIFICATION HAS
  CHANGED` in Terminal.** The host was rebuilt, or this is the first connection.
  Remove the old entry with `ssh-keygen -R t3b-host`, and its `100.x` address too if
  you used it. Then trust the key again
  ([connecting](accounts/connect.md#trust-the-hosts-key)). For the standby lane,
  rerun its account script.
- **`Connection refused` on port 22.** Remote Login is off, or the account isn't
  allowed. Rerun the account script and check the access list.
- **`Permission denied`, or the connection closes, from a machine whose key is
  right.** The source filter may have refused its address. On the host, this command
  says so:
  `sudo sshd -T -C user=agent-claude,host=x,addr=<its address> | grep -i '^denyusers'`.
  Connect by the host's Tailscale name, never its LAN address or `.local` name. Or
  fix `--allow-from`.
- **Timeouts.** The machine isn't on the tailnet, or the policy doesn't allow it. Run
  `tailscale status` on the desktop, and try the `100.x` address. Check the policy
  tests, and check that both machines carry their tags.
- **The host is `t3b-host-1`.** The old machine still existed. Delete it in the admin
  console and rename the new one.
- **The host dropped off after weeks.** Its key expired. Disable key expiry and
  re-authenticate it
  ([Tailscale](networking/tailscale.md#the-host-tailscaled-as-a-system-daemon)).
- **The standby sshd isn't listening.** Read `/var/log/dev.blacksand.sshd.log`, and
  rerun its account script.

## Agent accounts and providers

- **You see "Blacksand T3 sets up no background service, so remove this one with
  `t3 service uninstall`".** An upstream `t3` background service is still installed
  in that account. Do what the message says, as that account.
- **You see "…server.env must belong to you and be readable only by you".** Run
  `/usr/local/libexec/blacksand/set-claude-token` again as that account.
- **Claude says it isn't logged in over SSH.** `server.env` has no token. A Keychain
  login doesn't work over SSH ([providers](accounts/providers.md#sign-in)).
- **A provider shows as not installed.** Its CLI isn't on the login shell's `PATH`.
  Check with the `zsh -ilc` command in
  [providers](accounts/providers.md#install-the-cli), fix `~/.zprofile`, then switch
  the environment off and on.
- **`Error: claude native binary not installed.`** npm skipped Claude Code's install
  script. Rerun the `npm install -g …` line as that account. It includes
  `--allow-scripts=@anthropic-ai/claude-code`.
- **Settings won't update a provider, saying "…installed with bun/yarn/Volta/Vite+,
  which can't hold its dependencies to the 3-day minimum release age".** Reinstall
  that CLI with npm.
- **An ACP Registry agent "isn't supported in Blacksand T3".** It ships only a
  prebuilt binary. blacksand-t3 installs agents only from npm or PyPI packages,
  through `npx` or `uvx`. `brew install uv` provides `uvx`.
- **The desktop says the account's server is still starting.** The phone service's
  server is starting, or restarting after an update. Wait a minute and reconnect. Its
  log is in that account's `~/.blacksand/t3/phone/`.
- **You see "Blacksand T3 server … still runs a build this host has replaced and did
  not stop; stop it (kill -9 …) and connect again".** A server from the old build
  didn't stop when the connection tried to stop it, with SIGTERM and then SIGKILL
  after 5 seconds. Do what the message says, as that agent account, then connect
  again. Each account keeps one record per server in `~/.blacksand/t3/ssh-servers/`,
  with its pid, start time, build and command line. A connection finds the server
  through that record.
- **Pairing fails with an HTTP 500 right after a host update.** An old server is still
  running. Switch the environment off and on.

## Devices

- **A simulator won't boot in a host account, or the Device panel never shows one.**
  Run the SSH boot check in [iOS](devices/ios.md#simulators) as that account. If the
  simulator works only while the account is logged in at the host's screen, keep the
  account logged in.
- **You see "Android SDK was not found…" or "…missing from…" for an account whose SDK
  is installed.** The server never sees `ANDROID_HOME`. Install the SDK in
  `~/Library/Android/sdk` ([Android](devices/android.md#install)), then switch the
  environment off and on.
- **You see "JAVA_HOME is not set and no 'java' command could be found", or "Failed to
  run `avdmanager list avd`".** `openjdk@17` isn't installed, or that account's
  `~/.zprofile` lacks the `JAVA_HOME` and `PATH` lines.
- **An Android emulator shows "No video received from the device".** Start the
  emulator from the Device panel. The panel doesn't stream one you started by hand.
- **An agent's iOS taps fail with a Developer Tools authorization error.** See
  [iOS](devices/ios.md#simulators).
- **An EAS Simulator device shows no video.** The network blocks UDP. Use a network
  that allows UDP. Local and host simulators don't depend on it.

## Phone and Screen Sharing

- **`--pair` says Tailscale isn't ready for HTTPS.** The host isn't signed in to the
  tailnet, or HTTPS certificates aren't on.
- **The phone service won't change its port, or `--remove` stops.** A rerun keeps the
  port. Run `--remove` first, then add the service again with the new `--port`.
  `--remove` needs tailscaled running, and nothing else in Serve reaching the server's
  port.
- **Screen Sharing setup says screensharingd didn't answer.** This macOS won't run it
  the script's way, and Screen Sharing stays off. The crash report it names says why.
  For a public issue, share only the macOS version, the error and the relevant lines.
  Remove names, hostnames, home paths and UUIDs from them first.
- **Screen Sharing setup says macOS hasn't granted screen capture and control.** Do
  the [one-time capture step](remote-access/screen-sharing.md#the-one-time-capture-step)
  at the Mac, then rerun.
- **Screen Sharing won't change state, or `--off` or `--uninstall` exits naming what
  remains.** Usually tailscaled isn't answering, a Serve rule you made by hand reaches
  15900 or 15901, or Funnel is on. `--status` names the cause. Fix it and rerun. Until
  then, the check that runs every minute stays in force.
