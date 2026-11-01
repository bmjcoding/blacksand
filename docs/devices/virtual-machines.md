# What works in a virtual machine

> **Applies to:** running a Blacksand T3 role inside a VM, for example a macOS VM on
> Apple silicon (Tart, UTM, Virtualization.framework) or a Linux VM.

These come from testing in macOS 27.2 VMs (Tart, on Apple silicon) and Linux
containers.

| Works in a macOS VM | Needs real hardware |
|---|---|
| `install.sh --role host` and `--role ui`: build, checks, install, scheduling | Android Emulators: macOS VMs have no nested virtualization (`kern.hv_support: 0`), and the emulator needs Hypervisor.framework |
| agent accounts, Remote Login, the source filter, the standby sshd | physical iPhones and Android phones over USB |
| the phone service with a packed build | Screen Sharing with a picture: in the VMs, macOS didn't grant screen capture, and frames were black |
| Screen Sharing's install, ports and checks | FileVault unlock over SSH at boot (the guests didn't use FileVault) |
| iOS Simulators booted over SSH, in an account nobody was logged in to (with Xcode installed in the VM) | the owner's Apple Development signing identity and Keychain behaviour; tests used ad-hoc signing |

- Downloading full Xcode needs an Apple sign-in, in a VM too.
- A VM's network is usually NAT. Tailscale works inside a VM, but LAN-exposure checks
  (what a machine on your network can reach) only mean something with bridged
  networking.
- Linux: the desktop role has run in containers only
  ([roles](../getting-started/roles.md#linux-today)). An Android Emulator in a Linux VM
  needs nested KVM from the hypervisor.
