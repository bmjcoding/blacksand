# Install an always-on host

> **Applies to:** macOS, host role (`--role host`). Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Coding agents run on the host, each in its own standard account, and the desktop
reaches them over SSH. Set the host up before the desktop: the desktop's SSH steps
need it running. Do the [prerequisites](../getting-started/prerequisites.md#macos)
and [base system](base-system.md) first, and
[Tailscale's host daemon](../networking/tailscale.md#the-host-tailscaled-as-a-system-daemon).

## Power, restarts and FileVault

- **Never sleep:**

  ```sh
  sudo pmset -a sleep 0 disksleep 0
  sudo pmset -a autorestart 1
  pmset -g
  ```

  `pmset -g` shows `sleep 0`. `autorestart` (start after a power failure) is for a
  desktop Mac. A laptop host stays on power with its lid open, because a closed lid
  sleeps it. The display may sleep.
- **FileVault restarts.** After any restart, the disk stays locked until someone
  unlocks it. Neither Tailscale nor your SSH setup runs until then. For a restart you
  start yourself, use `sudo fdesetup authrestart`, which unlocks the next boot once.
  Otherwise, plan to unlock it at the Mac.
- **FileVault unlock over SSH** (macOS 26 or later, Apple silicon). With Remote Login
  on, a locked Mac runs a minimal SSH server of Apple's at startup
  (`man apple_ssh_and_filevault`). It only unlocks the disk, then disconnects; it
  opens no shell. It isn't the SSH server [agent accounts](../accounts/agent-accounts.md)
  configure, though:
  - it takes a **password** for **any account that can unlock the disk**, never a
    key. The key-only settings, the access list and the source filter live on the
    locked disk, so they don't apply;
  - it's reachable from your **local network** only, because Tailscale isn't running yet.

  Apple documents no switch for it apart from turning Remote Login off, which a host
  can't do. So keep the accounts that can unlock the disk to your admin account, with
  a strong password. `sudo fdesetup list` shows them. If an agent account is listed,
  `sudo fdesetup remove -user agent-claude` takes it off. Agent accounts never need
  to unlock the disk. Repeated wrong passwords lock the unlock out for a while.

## macOS updates

Set updates to download but not install automatically: **System Settings → General
→ Software Update → Automatic updates**. Keep **Install Security Responses and system
files** on. Install the rest yourself, about monthly, at the Mac, so you're there to
unlock FileVault after the restart.

## Network settings the tailnet relies on

```sh
sysctl net.inet.ip.forwarding net.inet6.ip6.forwarding net.inet.ip.check_interface net.inet6.ip6.check_interface
```

This prints `0`, `0`, `1`, `1`, which are macOS's defaults (`2` is fine for the last
two). With forwarding on (Internet Sharing, some VM software), machines on your local
network could reach the listeners the [phone service](../remote-access/phone.md) and
[Screen Sharing](../remote-access/screen-sharing.md) add on the host's tailnet
addresses. Those scripts refuse to set them up while it's on.

## Install

[Clone and check the clone](clone.md) outside `~/Documents`, `~/Desktop` and
`~/Downloads`, then:

```sh
packages/t3/install.sh --role host
```

The host role needs an admin account, because the app goes in `/Applications`, where
agent accounts find it. It also needs the default locations: it stops if
`BLACKSAND_T3_APPS` or `BLACKSAND_T3_UPDATE_REQUESTS` point anywhere else. Beyond what
[the desktop install](desktop.md#what-it-does) does, it:

- installs the app to `/Applications/Blacksand T3.app`, without opening it;
- installs the updater as a LaunchDaemon (`dev.blacksand.update`). It runs as you
  with nobody logged in, hourly, and whenever a server here asks for an update
  through `/Users/Shared/blacksand/update-requests`
  ([host updates](../updates/how-updates-arrive.md#hosts)).

Check it:

```sh
blacksand t3 status
git --version
```

`status` shows `role: host`, `schedule: hourly, and on update requests (LaunchDaemon:
runs with nobody logged in)`, `builds: as _blacksand-build`, `app: /Applications/Blacksand
T3.app`, `signing: Apple Development: …` and the pinned release. Run `git
--version` in a new Terminal window; it shows 2.55.0 or later.

## Next

1. [Screen Sharing](../remote-access/screen-sharing.md) (optional). If you want it,
   do it now, before any agent account exists.
2. [Agent accounts](../accounts/agent-accounts.md), then
   [provider CLIs and sign-in](../accounts/providers.md).
3. [Your phone](../remote-access/phone.md) (optional).
4. A restart test, once everything is connected
   ([the worked example](../getting-started/example-desktop-and-host.md#restart-test)).
