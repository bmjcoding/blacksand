# Install the desktop

> **Applies to:** the desktop role (`--role ui`) on macOS and Linux, and the desktop
> half of `--role both` on macOS.

After the [prerequisites](../getting-started/prerequisites.md), the
[base system](base-system.md) (macOS) and [cloning](clone.md):

```sh
packages/t3/install.sh
```

Run it as yourself, not with sudo. It refuses root and asks for your password when
it needs it, and it's safe to rerun. Run it in a terminal at the machine, not over
SSH: on macOS, 1Password and, for a self-signed certificate, Keychain ask in
dialogs. With a standby lane on a Mac, use `packages/t3/install.sh --role both`
([standby](standby.md)).

## What it does

On both platforms:

- installs what's missing or below a floor, and the pinned pnpm, checked by digest;
- creates the unprivileged build account `_blacksand-build`, and makes your home private
  (`chmod go-rwx`) if that account could read it ([build account](../building/build-account.md)).
  sudo must succeed here. Without it, the install stops before any upstream code
  runs. `--unisolated-build` builds as you instead; it's for machines with no sudo
  at all, and upstream's scripts then run with your files and credentials;
- verifies the clone's history ([cloning](clone.md#what-the-first-run-checks)),
  then builds, verifies, smoke-tests and installs the pinned release (the first
  build takes a while);
- saves the role and install locations in `state/install.json`;
- schedules the hourly update check
  ([how updates arrive](../updates/how-updates-arrive.md)).

**macOS** also:

- installs git, Node, Rust and the 1Password CLI with Homebrew where missing;
- sets up the shared code-signing certificate from 1Password
  ([signing](signing-macos.md));
- installs the app in `/Applications/Blacksand T3.app` when you're an admin (else
  `~/Applications`), and runs the updater as a LaunchAgent, which runs while you're
  logged in.

**Linux** also:

- installs system packages with pacman, apt or dnf, and, unless a Node on your
  `PATH` meets the floor, Node 24 into `~/.local/share/blacksand/t3/node`. The build
  account gets its own Node, the pinned pnpm and Rust 1.99.1, from rustup 1.29.2
  checked by digest;
- on Ubuntu 23.10 and later, adds a one-line AppArmor profile so Electron's sandbox
  can start under Ubuntu's user-namespace restriction;
- extracts the app to `~/.local/share/blacksand/t3/app` (no FUSE needed), adds "Blacksand
  T3" to your launcher, and runs the updater as a systemd user timer. That
  runs while your user manager does: while you're logged in, or always after
  `loginctl enable-linger`;
- does no signing, because Linux keyrings don't tie access to an app's signature.

To change when updates run: `BLACKSAND_T3_UPDATE_DAY=daily` (or a weekday) and
`BLACKSAND_T3_UPDATE_HOUR=6` before `packages/t3/install.sh`, or later with `blacksand t3
schedule --day daily --hour 6`.

## Check it

```sh
blacksand t3 status
```

It shows the installed pinned release, `role: ui` (or `both`), `builds: as
_blacksand-build`, and a schedule line ending in `(LaunchAgent: while you're logged in)`
on macOS. On a Mac, `signing:` names an Apple Development certificate.

## Before the first launch: your own threads (optional)

If you backed up your own `~/.blacksand/t3`, restore it now, before you open the app
for the first time and before a standby server ever runs. Then run
`blacksand t3 status` once; it rewrites `~/.blacksand/t3/bin/t3` for this
clone. Those threads belong to the Local environment.

## Open the app

Run `blacksand t3 launch`, or open Blacksand T3 from Applications or your launcher.
On macOS, after the first build signed with the shared certificate, macOS asks twice
for the app's Keychain item. Click **Always Allow** both times.

The Local environment runs agents as you, with access to your home. If this desktop
should run no agents of its own, turn it off in **Settings → Connections** (your
restored threads are hidden while it's off).

## Changing role or locations

- **Role:** rerun `packages/t3/install.sh --role <role>`. `blacksand t3 configure --role`
  only saves the role; the scheduled job changes at the next `blacksand t3
  schedule`, which `install.sh` runs.
- **Locations:** `BLACKSAND_T3_HOME`, `BLACKSAND_T3_APPS`, `BLACKSAND_T3_UPDATE_REQUESTS`,
  `XDG_DATA_HOME` and `XDG_CONFIG_HOME`. An empty value counts as unset. A relative
  path, or a `BLACKSAND_T3_HOME` inside the clone, stops every command; the message
  says why. `host` and `both` refuse anything but the default app and update-request
  locations, because agent accounts use those paths.
- `state/` in the clone is readable only by you (mode 700). It holds the log, the
  install records, the update lock and `state/install.json`.

The app keeps its data in `~/.blacksand/t3`, never upstream's `~/.t3`. It has its own
bundle ID, Chromium profile, Keychain item and runtime name, so it can sit beside
the official app. Both register `t3code://` links, so with both installed the system
picks one.
