# How updates arrive

> **Applies to:** every role, macOS and Linux (host updates: macOS).

Every update is a full rebuild from upstream source through the
[build pipeline](../building/pipeline.md). No prebuilt T3 app or server is downloaded.
The build still downloads what upstream's build does: Electron's prebuilt runtime and
npm packages, some of which fetch prebuilt native binaries.

## Which release: `pin.json`

The CI [evaluator](evaluator.md) runs hourly. It proposes the newest upstream nightly
release that passes every gate, and signs `pin.json` with its own key. Every machine
builds exactly the pinned release for its track, so a desktop and its hosts converge
on the same version. Each installs on its own schedule, so for a while they can be a
build apart. Upstream's protocol check refuses only versions that can't talk to each
other, and says to update.

CI is advisory. A machine takes a signed pin only after it works out the gates again
itself ([self-update](self-update.md)), and it strips, typechecks, scans and
smoke-tests the release before installing it.

## Tracks

Only nightly is pinned and evaluated today. A track `pin.json` doesn't pin (preview,
stable) is refused unless you pass `--unpinned`. That builds the track's newest
release at least 48 hours old (`--soak-hours`, `BLACKSAND_T3_SOAK_HOURS`), with none of
the evaluator's gates. `--unpinned` never bypasses a pin: a pinned track always builds
its pinned release. `--ref` builds anything you name. **Settings → Update track** in
the app doesn't switch tracks; it explains this.

## The hourly check

Each machine's updater runs hourly. It builds only when the pin moved or this
repository did. A build is the upstream commit plus the Blacksand T3 commit that
stripped it, so a signed commit here, even one that only changes docs, rebuilds the
same release with it. Before building, it takes new signed commits from `main`
([self-update](self-update.md)).

- If the app is closed, the new build installs right away.
- If it's open, the build waits, and the update button offers a restart into it.
- To change the schedule, run `blacksand t3 schedule --day daily` (or a weekday, and
  `--hour`). `blacksand t3 unschedule` stops scheduled updates.

The app's automatic checks (at startup and every 4 minutes) only read local state:
a build waiting from the scheduled run, or a newer tag that run already fetched. Only
checks you start touch the network. The one exception is the automatic provider CLI
version checks ([provider updates](provider-updates.md)).

## The update button

The button is in the sidebar, the app menu, and **Settings → About**.

1. **Check for updates** first takes any newer signed `pin.json`, and code, from
   `main`. Then it fetches upstream's tags. If there's a newer release, the button
   shows it, with upstream's commit titles as release notes.
2. **Download** builds exactly the commit the check offered (`update --expect-sha`).
   If the approved release has moved since, it refuses and asks you to check again. A
   progress ring tracks the build.
3. **Restart** installs only the build the app announced (`apply --expect-sha
   --expect-blacksand`). A different build staged meanwhile stays staged.

A waiting build made by a different Blacksand T3 commit than this clone's is offered
as a download, which rebuilds it, not as a restart. That happens, for example, when a
self-update landed and its rebuild failed. Neither a restart nor `blacksand t3
launch` installs it.

## Review before you restart

While a build waits, the version stamp's hover card offers **Preview** and **What
changed**.

- **Preview** (`blacksand t3 preview`) opens the waiting build in a Chrome window of
  its own, against a copy of your profile: your projects, threads and settings,
  without your secrets. Chrome or Chromium must be installed. On macOS, its server
  runs in a `sandbox-exec` sandbox:
  - it can reach localhost and nothing else, not even DNS;
  - it can write only to its copy. It can read your projects' files, but not change them;
  - the agent CLIs show as installed but have no credentials, so nothing can be sent;
  - closing the window stops it and deletes the copy.

  Linux has no sandbox for it yet, so there the preview gets an empty profile.
- **What changed** opens the [build report](upstream-rules.md#the-build-report).
  `blacksand t3 review` gathers the report and every upstream commit since your
  build, for an agent to read. Ask it what you'd notice and where to look in the
  preview, and, for each feature left out, whether to re-hook it, retire it or wait.

## Hosts

- **Hourly,** like any machine, through a LaunchDaemon that needs no login.
- **Update everything** in the desktop app drops a request into each SSH host's
  `/Users/Shared/blacksand/update-requests`. That starts the host's updater; the
  build usually takes 15 to 20 minutes. The app shows the host as "update requested",
  not updated. Nobody uses the app on the host, so the new build installs as soon as
  it's built.
- **A running server keeps its build** until the next connection. To move to the new
  one, let running turns finish, then switch the environment off and on (**Settings →
  Connections → Environments**). Switching off stops the remote server, work in
  progress included, and the next start runs the installed build. A server from a
  replaced build is also stopped when a connection starts (SIGTERM, then SIGKILL after
  5 seconds). An automatic reconnect can reuse a live tunnel and stay on the old
  server, though. If pairing fails (an HTTP 500) right after a host update, an old
  server is still running: switch the environment off and on.
- A [phone service](../remote-access/phone.md) restarts its server on the new build
  within seconds, by itself.
- By hand, as the admin account that installed it: `blacksand t3 update`.

## When a build fails or leaves something out

- **A failed build** leaves the installed app alone. You get a notification with the
  reason, and the full log is in `state/blacksand-t3.log` (readable only by you). The
  update button offers the release again. A build that's verified but can't be
  swapped in (for example, if macOS's App Management protection blocks the swap)
  stays staged, and the installed one keeps running. Causes and fixes are in
  [troubleshooting](../troubleshooting.md#when-an-update-fails).
- **A build with features left out** installs like any other. The notification and
  the release notes name what was left out, and the version stamp shows a hollow dot
  until a build has everything again ([upstream rules](upstream-rules.md)).
