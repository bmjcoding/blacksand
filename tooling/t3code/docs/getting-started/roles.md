# Roles and platforms

> **Applies to:** every role, macOS and Linux.

Each machine gets one role. You pick it when you run
`tooling/t3code/install.sh --role …`. Every machine builds and checks its own copy of
the pinned release. A machine never installs another machine's build.

| Role | Command | What it sets up | macOS | Linux |
|---|---|---|---|---|
| Desktop | `tooling/t3code/install.sh` (`--role ui`) | the app you work in; an hourly updater that runs while you're logged in | Yes | Yes |
| Always-on host | `tooling/t3code/install.sh --role host` | the app in `/Applications` for agent accounts; an hourly updater that runs with nobody logged in | Yes | Not yet |
| Desktop with standby | `tooling/t3code/install.sh --role both` | the desktop app, plus one agent account behind a loopback-only SSH server | Yes | Not yet |

## Desktop

This is the T3 Code (blacksand) app. Its Local environment runs agents in your own account.
It can also reach agent accounts on other machines as SSH environments, using
upstream's remote-environment feature.

Next: [install the desktop](../install/desktop.md).

## Always-on host

Agents run in standard (non-admin) macOS accounts, one per purpose. Each account
runs its own T3 server and provider CLIs. Agent accounts can't read your files, and
they log in over SSH with your key only. The desktop reaches each account over
Tailscale. Optional extras:

- [your phone](../remote-access/phone.md), talking to one agent account's server
  over Tailscale
- [Screen Sharing](../remote-access/screen-sharing.md) of the host, from the desktop

Next: [install a host](../install/host.md), then
[add agent accounts](../accounts/agent-accounts.md).

## Standby

This is a desktop that also has one agent account, for when the host is down. The
desktop reaches it over SSH on its own loopback, port 2222. Remote Login stays off.

Next: [set up standby](../install/standby.md).

## Linux today

- `install.sh` accepts only `--role ui` on Linux. It refuses `host` and `both`
  before changing anything.
- The desktop role has run in containers: Ubuntu 24.04, Rocky 9 and Fedora 44 on
  arm64, and Arch on x86-64 under emulation. No one has tested it on real hardware.
  These remain unverified: opening the app, the systemd timer firing, Ubuntu's
  AppArmor profile, and RHEL's `subscription-manager` step.
- Most distributions ship a git older than 2.55.0, so `install.sh` stops until you
  install a newer one ([prerequisites](prerequisites.md#linux)).
- `expo-device-hub` needs the device hub's prebuilt WebRTC library,
  `node-datachannel`, which is listed for darwin-arm64 and linux-x64 only. So you
  can't install that tool on linux-arm64 or on Intel Macs.

### Not yet supported on Linux

The host role, agent accounts, the standby lane, the phone service and Screen
Sharing are macOS-only. Supporting them on Linux would need:

- for the host updater, a systemd system service that runs as the installing user
  with nobody logged in, plus a shared update-request folder the agent accounts can
  write;
- for agent accounts, `useradd` accounts in a group, an sshd drop-in like the one
  `tooling/t3code/scripts/add-agent-account.sh` writes (root-owned keys,
  loopback-only forwarding, a source filter), and the app installed where every
  account can read it. The SSH runner already finds a Linux install in the
  connecting account's own data folder, but nothing installs one there for an agent
  account;
- for standby, a loopback-only sshd as a systemd unit;
- for the phone service, a systemd unit per account, and support for tailscaled's
  Linux LocalAPI socket in `tooling/t3code/scripts/host-common.sh`;
- for Screen Sharing, a VNC or RDP server bound to loopback, with the same hold,
  park and check design as `tooling/t3code/scripts/enable-screen-sharing.sh`.
