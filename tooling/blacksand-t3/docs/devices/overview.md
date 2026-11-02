# Simulators, emulators and devices

> **Applies to:** host, standby and Local environments. iOS needs macOS. Android
> emulators need a real Mac (Apple silicon images) or a Linux machine with hardware
> virtualization.

In a project thread, the Device panel shows a live iOS Simulator or Android Emulator
beside the thread. Open it from **Device** in the right panel. Agents drive the same
device. Upstream's `docs/user/devices.md` describes the panel in full.

## Where a device runs

A simulator runs on the machine of the thread's environment, in that environment's
account. For a thread in the host's environment, that's the host's agent account. For
a Local thread, it's your own account. So run devices where the project and its agent
are:

- **Projects on the host run devices on the host, in the agent account.** This is the
  usual case. The agent builds the app and installs it on a simulator it can see. The
  simulator reaches Metro, or any other dev server, on the host's `localhost`. You
  watch and tap the simulator in the desktop's Device panel. Video and input travel
  over HTTP and WebSocket, through the host's T3 server and the SSH environment's
  forwarded loopback port. So blacksand-t3's WebRTC block doesn't affect them, and
  only port 22 has to be open.
- **Projects in the Local environment run devices on the desktop.** They work the same
  way, through the desktop's local server. A standby-lane thread runs its devices in
  `agent-standby`, which you set up like a host account.
- **Devices don't work across machines.** A simulator on the desktop can't reach a dev
  server on the host through `localhost`. Upstream offers SSH device hosts, which you
  add in **Settings → Devices → Add source → Machine over SSH**. An SSH device host
  would have the host's server SSH back into the desktop, and the [Tailscale
  policy](../networking/tailscale.md) refuses that on purpose.
- **EAS Simulator streams over WebRTC.** EAS Simulator is Expo's cloud simulator
  service, and it's the one source that uses WebRTC. blacksand-t3 lets only a hidden
  window of the app's own use UDP for it, and that traffic goes straight to Expo's
  cloud. TURN over TCP or TLS isn't available. So on a network that blocks UDP, an EAS
  device shows no video ([privacy](../security/privacy.md#webrtc)).

## The device hub

The panel's first-use setup starts the device hub and asks whether agents may control
devices. You can change both later in **Settings**, under **Devices**, with
**Use devices** and **Agents can use devices**. At that point the app installs the
hub's pinned, reviewed tools into the account from npm. It also installs one prebuilt
WebRTC library from GitHub, which is listed for darwin-arm64 and linux-x64 only
([device tools](../building/device-tools.md)).

## Setup per platform

- [iOS Simulators and iPhones](ios.md) (macOS)
- [Android Emulators and phones](android.md)
- [What works in a virtual machine](virtual-machines.md)

Physical devices connect by USB to the machine whose environment uses them. For host
threads, that's the host. A phone plugged into the desktop isn't a device of the
host's environment. Physical devices haven't been tried with blacksand-t3 yet.
