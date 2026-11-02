# Install the desktop

> **Applies to:** the desktop role (`--role ui`) on macOS and Linux, and the desktop
> half of `--role both` on macOS.

Finish the [prerequisites](../getting-started/prerequisites.md), the
[base system](base-system.md) steps on macOS, and [cloning](clone.md). Then run:

```sh
tooling/blacksand-t3/install.sh
```

Run it as yourself, not with sudo. It refuses to run as root, and it asks for your
password when it needs it. It's safe to rerun. Run it in a terminal at the machine,
not over SSH. On macOS, 1Password asks for approval in a dialog, and so does Keychain
for a self-signed certificate. With a standby lane on a Mac, use
`tooling/blacksand-t3/install.sh --role both` ([standby](standby.md)).

## What it does

On both platforms, it:

- Installs any tool that's missing or below its version floor. It also installs the
  pinned pnpm and checks it by digest.
- Creates the unprivileged build account `_blacksand-build`. If that account could
  read your home, it makes your home private with `chmod go-rwx`
  ([build account](../building/build-account.md)). This step needs sudo. Without
  sudo, the install stops before any upstream code runs. `--unisolated-build` builds
  as you instead. It's for machines with no sudo at all, and with it, upstream's
  scripts run with your files and credentials.
- Verifies the clone's history ([cloning](clone.md#what-the-first-run-checks)). Then
  it builds, verifies, smoke-tests and installs the pinned release. The first build
  takes a while.
- Saves the role and install locations in `state/install.json`.
- Schedules the hourly update check
  ([how updates arrive](../updates/how-updates-arrive.md)).

On macOS, it also:

- Installs git, Node, Rust and the 1Password CLI with Homebrew where they're missing.
- Sets up the shared code-signing certificate from 1Password
  ([signing](signing-macos.md)).
- Installs the app in `/Applications/T3 Code (blacksand).app` when you're an admin, and in
  `~/Applications` otherwise. It runs the updater as a LaunchAgent, which runs while
  you're logged in.

On Linux, it also:

- Installs system packages with pacman, apt or dnf. Unless a Node on your `PATH`
  meets the floor, it installs Node 24 into `~/.local/share/blacksand/t3/node`. The
  build account gets its own Node, the pinned pnpm, and Rust 1.99.1. rustup 1.29.2
  installs that Rust, and the installer checks rustup by digest.
- On Ubuntu 23.10 and later, adds a one-line AppArmor profile so Electron's sandbox
  can start under Ubuntu's user-namespace restriction.
- Extracts the app to `~/.local/share/blacksand/t3/app`, which needs no FUSE, and
  adds "T3 Code (blacksand)" to your launcher. It runs the updater as a systemd user timer.
  The timer runs while your user manager does. That's while you're logged in, or
  always after `loginctl enable-linger`.
- Does no signing, because Linux keyrings don't tie access to an app's signature.

To change when updates run, set `BLACKSAND_T3_UPDATE_DAY=daily` or a weekday, and
`BLACKSAND_T3_UPDATE_HOUR=6`, before you run `tooling/blacksand-t3/install.sh`. To change
it later, run `blacksand t3 schedule --day daily --hour 6`.

## Check it

```sh
blacksand t3 status
```

It shows the installed pinned release, `role: ui` or `both`, and
`builds: as _blacksand-build`. On macOS, the schedule line ends in
`(LaunchAgent: while you're logged in)`, and `signing:` names an Apple Development
certificate.

## Before the first launch: your own threads (optional)

If you backed up your own `~/.blacksand/t3`, restore it now. Do it before you open
the app for the first time, and before a standby server ever runs. Then run
`blacksand t3 status` once, which rewrites `~/.blacksand/t3/bin/t3` for this clone.
The restored threads belong to the Local environment.

## Open the app

Run `blacksand t3 launch`, or open T3 Code (blacksand) from Applications or your launcher.
On macOS, after the first build signed with the shared certificate, macOS asks twice
for the app's Keychain item. Click **Always Allow** both times.

The Local environment runs agents as you, with access to your home. If this desktop
should run no agents of its own, turn the Local environment off in **Settings →
Connections**. While it's off, the app hides your restored threads.

## Changing role or locations

- **Role.** Rerun `tooling/blacksand-t3/install.sh --role <role>`.
  `blacksand t3 configure --role` only saves the role. The scheduled job changes at
  the next `blacksand t3 schedule`, which `install.sh` runs.
- **Locations.** Set `BLACKSAND_T3_HOME`, `BLACKSAND_T3_APPS`,
  `BLACKSAND_T3_UPDATE_REQUESTS`, `XDG_DATA_HOME` and `XDG_CONFIG_HOME`. An empty
  value counts as unset. A relative path, or a `BLACKSAND_T3_HOME` inside the clone,
  stops every command, and the message says why. `host` and `both` refuse anything
  but the default app and update-request locations, because agent accounts use
  those paths.
- **State.** Only you can read `state/` in the clone (mode 700). It holds the log,
  the install records, the update lock and `state/install.json`.

The app keeps its data in `~/.blacksand/t3`, never in upstream's `~/.t3`. It has its
own bundle ID, Chromium profile, Keychain item and runtime name, so you can install
it beside the official app. Both apps register `t3code://` links. With both
installed, the system picks which one opens them.
