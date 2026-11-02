# How updates arrive

> **Applies to:** every role, macOS and Linux. Host updates apply to macOS.

Every update is a full rebuild from upstream source through the
[build pipeline](../building/pipeline.md). blacksand-t3 never downloads a prebuilt T3
app or server. The build still downloads what upstream's build does, which is
Electron's prebuilt runtime and npm packages. Some of those packages fetch prebuilt
native binaries.

## Which release: `pin.json`

The CI [evaluator](evaluator.md) runs hourly. It proposes the newest upstream nightly
release that passes every gate, and signs `pin.json` with its own key. Every machine
builds exactly the pinned release for its track, so a desktop and its hosts converge
on the same version. Each machine installs on its own schedule, so for a while two
machines can be a build apart. Upstream's protocol check refuses only versions that
can't talk to each other, and tells you to update.

CI is advisory. A machine takes a signed pin only after it works out the gates again
itself ([self-update](self-update.md)). It also strips, typechecks, scans and
smoke-tests the release before installing it.

## Tracks

Today the evaluator pins and evaluates only the nightly track. blacksand-t3 refuses a
track that `pin.json` doesn't pin, such as preview or stable, unless you pass
`--unpinned`. With `--unpinned`, it builds the track's newest release that is at least
48 hours old, with none of the evaluator's gates. `--soak-hours` or
`BLACKSAND_T3_SOAK_HOURS` changes that age. `--unpinned` never bypasses a pin, so a
pinned track always builds its pinned release. `--ref` builds any release you name.
**Settings → Update track** in the app doesn't switch tracks. It only explains how
tracks work.

## The hourly check

Each machine's updater runs hourly. It builds only when the pin moved or when this
repository did. A build is the upstream commit plus the blacksand-t3 commit that
stripped it. So any signed commit here, even one that changes only docs, rebuilds the
same release with that commit. Before it builds, the updater takes new signed commits
from `main` ([self-update](self-update.md)).

- If the app is closed, the new build installs right away.
- If the app is open, the build waits, and the update button offers a restart into it.
- To change the schedule, run `blacksand t3 schedule --day daily`, or pass a weekday
  and `--hour`. `blacksand t3 unschedule` stops scheduled updates.

The app checks for updates automatically at startup and every 4 minutes. These checks
only read local state. They look for a build that the scheduled run left waiting, or a
newer tag that run already fetched. Only checks you start use the network. The one
exception is the automatic version check for provider CLIs
([provider updates](provider-updates.md)).

## The update button

The button is in the sidebar, the app menu, and **Settings → About**.

1. **Check for updates** first takes any newer signed `pin.json` and code from `main`.
   Then it fetches upstream's tags. If there's a newer release, the button shows it,
   with upstream's commit titles as release notes.
2. **Download** builds exactly the commit the check offered (`update --expect-sha`).
   If the approved release has moved since the check, it refuses and asks you to check
   again. A progress ring tracks the build.
3. **Restart** installs only the build the app announced (`apply --expect-sha
   --expect-blacksand`). If a different build was staged in the meantime, it stays
   staged.

The app offers a waiting build as a download, not a restart, if a different blacksand-t3
commit than this clone's made it. The download rebuilds it. That happens, for
example, when a self-update landed and its rebuild failed. Neither a restart nor
`blacksand t3 launch` installs that build.

## Review before you restart

While a build waits, the version stamp's hover card offers **Preview** and **What
changed**.

- **Preview** (`blacksand t3 preview`) opens the waiting build in its own Chrome
  window. It runs against a copy of your profile, which has your projects, threads
  and settings but not your secrets. Chrome or Chromium must be installed. On macOS,
  the preview's server runs in a `sandbox-exec` sandbox:
  - It can reach localhost and nothing else, not even DNS.
  - It can write only to its copy of the profile. It can read your projects' files but
    can't change them.
  - The agent CLIs show as installed but have no credentials, so they can't send
    anything.
  - Closing the window stops the server and deletes the copy.

  Linux has no sandbox for the preview yet, so on Linux it gets an empty profile.
- **What changed** opens the [build report](upstream-rules.md#the-build-report).
  `blacksand t3 review` gathers the report and every upstream commit since your build
  for an agent to read. Ask the agent what you'd notice and where to look in the
  preview. For each feature the build left out, ask whether to re-hook it, retire it
  or wait.

## Hosts

- **Hourly.** A host updates hourly like any machine, through a LaunchDaemon that
  needs no login.
- **Update everything.** This button in the desktop app drops a request into each SSH
  host's `/Users/Shared/blacksand/update-requests`. The request starts the host's
  updater, and the build usually takes 15 to 20 minutes. The app shows the host as
  "update requested", not updated. Nobody uses the app on the host, so the new build
  installs as soon as it's built.
- **A running server keeps its build until the next connection.** To move to the new
  build, let running turns finish. Then switch the environment off and on in
  **Settings → Connections → Environments**. Switching off stops the remote server,
  including work in progress, and the next start runs the installed build. Starting a
  connection also stops any server from a replaced build, with SIGTERM and then SIGKILL
  after 5 seconds. An automatic reconnect can reuse a live tunnel and stay
  on the old server, though. If pairing fails with an HTTP 500 right after a host
  update, an old server is still running. Switch the environment off and on.
- A [phone service](../remote-access/phone.md) restarts its server on the new build
  by itself, within seconds.
- To update by hand, run `blacksand t3 update` as the admin account that installed
  blacksand-t3.

## When a build fails or leaves something out

- **A failed build leaves the installed app alone.** You get a notification with the
  reason. The full log is in `state/blacksand-t3.log`, which only you can read. The
  update button offers the release again. Sometimes a build passes verification but
  can't be swapped in, for example when macOS's App Management protection blocks the
  swap. That build stays staged, and the installed one keeps running. Causes and fixes
  are in [troubleshooting](../troubleshooting.md#when-an-update-fails).
- **A build with features left out installs like any other.** The notification and
  the release notes name what was left out. The version stamp shows a hollow dot until
  a build has everything again ([upstream rules](upstream-rules.md)).
