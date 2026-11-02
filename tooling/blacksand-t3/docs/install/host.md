# Install an always-on host

> **Applies to:** macOS, host role (`--role host`). Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Coding agents run on the host, each in its own standard account. The desktop reaches
them over SSH. Set up the host before the desktop, because the desktop's SSH steps
need the host running. First do the
[prerequisites](../getting-started/prerequisites.md#macos), the
[base system](base-system.md) steps and
[Tailscale's host daemon](../networking/tailscale.md#the-host-tailscaled-as-a-system-daemon).

## Power, restarts and FileVault

- **Never sleep.** Turn off system and disk sleep:

  ```sh
  sudo pmset -a sleep 0 disksleep 0
  sudo pmset -a autorestart 1
  pmset -g
  ```

  `pmset -g` shows `sleep 0`. `autorestart`, which starts the Mac after a power
  failure, is for a desktop Mac. Keep a laptop host on power with its lid open,
  because closing the lid puts it to sleep. The display may sleep.
- **FileVault restarts.** After any restart, the disk stays locked until someone
  unlocks it. Neither Tailscale nor your SSH setup runs until then. For a restart you
  start yourself, use `sudo fdesetup authrestart`, which unlocks the next boot once.
  Otherwise, plan to unlock it at the Mac.
- **FileVault unlock over SSH.** On macOS 26 or later on Apple silicon, with Remote
  Login on, a locked Mac runs a minimal SSH server of Apple's at startup
  (`man apple_ssh_and_filevault`). It only unlocks the disk, then disconnects. It
  never opens a shell. It's a different SSH server from the one
  [agent accounts](../accounts/agent-accounts.md) configures:
  - It takes a password for any account that can unlock the disk, never a key. The
    key-only settings, the access list and the source filter live on the locked
    disk, so they don't apply.
  - Only your local network can reach it, because Tailscale isn't running yet.

  Apple documents no way to turn it off except turning Remote Login off, which a host
  can't do. So let only your admin account unlock the disk, and give it a strong
  password. `sudo fdesetup list` shows the accounts that can unlock it. If an agent
  account is listed, `sudo fdesetup remove -user agent-claude` takes it off. Agent
  accounts never need to unlock the disk. Repeated wrong passwords lock out further
  unlock attempts for a while.

## macOS updates

In **System Settings → General → Software Update → Automatic updates**, set updates
to download automatically but not install. Keep **Install Security Responses and
system files** on. Install the rest yourself at the Mac, about monthly, so you're
there to unlock FileVault after the restart.

## Network settings the tailnet relies on

```sh
sysctl net.inet.ip.forwarding net.inet6.ip6.forwarding net.inet.ip.check_interface net.inet6.ip6.check_interface
```

This prints `0`, `0`, `1`, `1`, which are macOS's defaults. `2` is also fine for the
last two. Internet Sharing and some VM software turn forwarding on. With forwarding
on, machines on your local network could reach the listeners that the
[phone service](../remote-access/phone.md) and
[Screen Sharing](../remote-access/screen-sharing.md) add on the host's tailnet
addresses. Those scripts refuse to set up their listeners while forwarding is on.

## Install

[Clone and check the clone](clone.md) outside `~/Documents`, `~/Desktop` and
`~/Downloads`, then run:

```sh
tooling/blacksand-t3/install.sh --role host
```

The host role needs an admin account, because the app goes in `/Applications`, where
agent accounts find it. It also needs the default locations, and it stops if
`BLACKSAND_T3_APPS` or `BLACKSAND_T3_UPDATE_REQUESTS` points anywhere else. Beyond
what [the desktop install](desktop.md#what-it-does) does, it:

- Installs the app to `/Applications/T3 Code (blacksand).app`, without opening it.
- Installs the updater as the LaunchDaemon `run.blacksand.update`. The updater runs
  as you, even with nobody logged in. It runs hourly, and whenever a server on this
  host asks for an update through `/Users/Shared/blacksand/update-requests`
  ([host updates](../updates/how-updates-arrive.md#hosts)).

Check it:

```sh
blacksand t3 status
git --version
```

`status` shows these lines and the pinned release:

- `role: host`
- `schedule: hourly, and on update requests (LaunchDaemon: runs with nobody logged in)`
- `builds: as _blacksand-build`
- `app: /Applications/T3 Code (blacksand).app`
- `signing: Apple Development: …`

Run `git --version` in a new Terminal window. It shows 2.55.0 or later.

## Next

1. [Screen Sharing](../remote-access/screen-sharing.md) (optional). If you want it,
   do it now, before any agent account exists.
2. [Agent accounts](../accounts/agent-accounts.md), then
   [provider CLIs and sign-in](../accounts/providers.md).
3. [Your phone](../remote-access/phone.md) (optional).
4. A restart test, once everything is connected
   ([the worked example](../getting-started/example-desktop-and-host.md#restart-test)).
