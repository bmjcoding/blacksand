# Simulators, emulators and devices

> **Applies to:** macOS for iOS. Android emulators need a real Mac (Apple silicon
> images) or a Linux machine with hardware virtualization. Host, standby and Local
> environments.

The Device panel (in a project thread, **right panel → Device**) shows a live iOS
Simulator or Android Emulator beside the thread, and agents drive the same device.
Upstream's `docs/user/devices.md` has the full tour.

## Where a device runs

**A simulator runs on the machine of the environment the thread is in, in that
environment's account.** That's the host's agent account for a thread in the host's
environment, and your own account for a Local thread. So run devices where the
project and its agent are:

- **Projects on the host (the usual case): on the host, in the agent account.** The
  agent builds and installs the app on a simulator it can see. The simulator reaches
  Metro or any other dev server on the host's `localhost`. You watch and tap it in the
  desktop's Device panel. Video and input travel over HTTP and WebSocket through the
  host's T3 server and the SSH environment's forwarded loopback port. So Blacksand
  T3's WebRTC block doesn't touch them, and nothing but port 22 has to be open.
- **Projects in the Local environment: on the desktop,** the same way through its
  local server. A standby-lane thread runs its devices in `agent-standby`, set up
  like a host account.
- **Not across machines.** A simulator on the desktop can't reach a dev server on the
  host through `localhost`. Upstream's SSH device hosts (**Settings → Devices → Add
  source → Machine over SSH**) would have the host's server SSH back into the
  desktop, which the [Tailscale policy](../networking/tailscale.md) refuses on purpose.
- **EAS Simulator** (Expo's cloud simulators) is the one source that streams over
  WebRTC. Blacksand T3 lets only a hidden window of the app's own use UDP for it,
  straight to Expo's cloud. TURN over TCP or TLS isn't available, so on a network that
  blocks UDP an EAS device shows no video ([privacy](../security/privacy.md#webrtc)).

## The device hub

The panel's first-use setup starts the device hub and asks whether agents may control
devices. You can change this later in **Settings → Devices** (**Use devices**,
**Agents can use devices**). The hub's pinned, reviewed tools install into the account
then, from npm, plus one prebuilt WebRTC library from GitHub, which is listed for
darwin-arm64 and linux-x64 only ([device tools](../building/device-tools.md)).

## Setup per platform

- [iOS Simulators and iPhones](ios.md) (macOS)
- [Android Emulators and phones](android.md)
- [What works in a virtual machine](virtual-machines.md)

Physical devices connect by USB to the machine whose environment uses them: the host,
for host threads. A phone plugged into the desktop isn't a device of the host's
environment. Physical devices haven't been tried with Blacksand T3 yet.
