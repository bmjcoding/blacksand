# Host hardening and the CIS Benchmark

> **Applies to:** macOS, every role. Linux hardening isn't covered.

This page maps the setup's macOS steps to recommendations in the CIS Apple macOS 26.0
Tahoe Benchmark v1.1.0. The table names each recommendation by title, because section
numbers change between benchmark versions. This isn't a full CIS assessment. For that,
run a CIS-based tool such as the
[macOS Security Compliance Project](https://github.com/usnistgov/macos_security)'s
`cis_lvl1` baseline.

| Setup step | CIS recommendation (title) | Desktop | Host |
|---|---|---|---|
| Install macOS updates ([base system](../install/base-system.md)) | Ensure Apple-provided Software Updates Are Installed | Meets | Meets, installed by hand monthly |
| Download updates automatically; install security responses | Ensure Download New Updates When Available Is Enabled; Ensure Install Security Responses and System Files Is Enabled | Meets | Meets |
| Host installs macOS updates by hand ([host](../install/host.md#macos-updates)) | Ensure Install of macOS Updates Is Enabled | Meets | **Deviation.** Someone must be at the Mac to unlock FileVault after the restart |
| FileVault on | Ensure FileVault Is Enabled | Meets | Meets |
| Firewall on | Ensure Firewall Is Enabled | Meets | Meets |
| Stealth mode on | Ensure Firewall Stealth Mode Is Enabled | Meets | Meets |
| Screen locks immediately | Ensure Require Password After Screen Saver Begins or Display Is Turned Off Is Enabled for 5 Seconds or Immediately | Meets | Meets |
| SIP check (`csrutil status`) | Ensure System Integrity Protection Status (SIP) Is Enabled | Checked | Checked |
| Gatekeeper check (`spctl --status`) | Ensure Gatekeeper Is Enabled | Checked | Checked |
| Sharing services off | Ensure File Sharing Is Disabled; Ensure Printer Sharing Is Disabled; Ensure Remote Apple Events Is Disabled; Ensure Bluetooth Sharing Is Disabled | Meets | Meets |
| Remote Login | Ensure Remote Login Is Disabled | Meets. Remote Login stays off, and the standby lane uses a loopback-only sshd | **Deviation.** Agent accounts need SSH. The mitigations are key-only login, an access list of agent accounts only, and a tailnet source filter ([agent accounts](../accounts/agent-accounts.md)) |
| Screen Sharing | Ensure Screen Sharing Is Disabled | Meets | Meets without the optional [Screen Sharing](../remote-access/screen-sharing.md). **Deviation with it.** macOS's switch stays off, but `screensharingd` runs on loopback and Tailscale Serve makes it reachable |
| Remote Management | Ensure Remote Management Is Disabled | Meets | Meets; the Screen Sharing check turns Screen Sharing off if it's on |
| Internet Sharing off | Ensure Internet Sharing Is Disabled | Meets | Meets; the phone and Screen Sharing scripts refuse to run with IP forwarding on |
| AirPlay Receiver off | Ensure AirPlay Receiver Is Disabled | Meets | Meets |
| Set time automatically | Ensure Set Time and Date Automatically Is Enabled | Meets | Meets; self-update also checks the clock against the npm registry's |
| FileVault rules out automatic login | Ensure Automatic Login Is Disabled | Meets | Meets |

"Checked" means the setup tells you to check the setting. blacksand-t3 doesn't change
it.

## Beyond the benchmark

These host-isolation measures go beyond the table. Private home permissions also
implement the benchmark's home-folder recommendation. The rest are specific to this
setup, and they limit what the host's untrusted accounts can do:

- agent accounts are standard accounts with private homes, and your home is closed to
  them;
- the build account is unprivileged, with root-owned tools;
- `fdesetup list` is kept to the admin account, so the FileVault unlock over SSH
  accepts no agent account's password;
- the machines run no HTTPS-inspecting software, so the app's certificate checks see
  the real servers' certificates.

## Not covered

The rest of the benchmark is left to you. That includes the screen saver inactivity
interval, password hints, the guest account, sudo's timeout, Siri and analytics
sharing, the login window, and Time Machine encryption. None of them conflicts with
blacksand-t3.
