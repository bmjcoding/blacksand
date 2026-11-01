# Blacksand T3 documentation

Each page starts with the platforms and roles it applies to.

## Getting started

- [Roles and platforms](getting-started/roles.md): desktop, always-on host, standby;
  what macOS and Linux support today
- [Prerequisites](getting-started/prerequisites.md): tools, minimum versions, accounts
- [Example: a desktop Mac and an always-on host Mac](getting-started/example-desktop-and-host.md):
  every step in order, with the verification checklist
- [Before you wipe a machine you're rebuilding](getting-started/rebuilding.md)

## Install

- [Base system hardening](install/base-system.md) (macOS)
- [Cloning and checking the clone](install/clone.md)
- [Install the desktop](install/desktop.md) (macOS, Linux)
- [Install an always-on host](install/host.md) (macOS)
- [The standby lane](install/standby.md) (macOS)
- [Code signing and Keychain prompts](install/signing-macos.md) (macOS)
- [Keeping everything current](install/keeping-current.md)

## Network, accounts and remote access

- [Tailscale](networking/tailscale.md): the policy, the host daemon, the desktop app,
  Serve, Tailnet Lock
- [Agent accounts](accounts/agent-accounts.md): the isolation model, SSH, the source filter
- [Provider CLIs and sign-in](accounts/providers.md): installs, logins, tokens
- [Connecting the desktop to an agent account](accounts/connect.md)
- [Screen Sharing of the host](remote-access/screen-sharing.md)
- [Your phone](remote-access/phone.md)
- [Recording or streaming the host's screen](remote-access/recording-streaming.md)

## Devices

- [Simulators, emulators and devices](devices/overview.md): where they run
- [iOS](devices/ios.md) · [Android](devices/android.md) ·
  [What works in a virtual machine](devices/virtual-machines.md)

## Updates

- [How updates arrive](updates/how-updates-arrive.md): pins, the hourly check, the
  update button, hosts
- [Self-update and commit trust](updates/self-update.md)
- [The CI evaluator and alerts](updates/evaluator.md)
- [Upstream rules and drift](updates/upstream-rules.md)
- [Security fast lane, advisories and overrides](updates/fast-lane.md)
- [Provider CLI and agent updates](updates/provider-updates.md)
- [Raising the pnpm pin](updates/pnpm-pin.md)

## How a build is checked

- [The build pipeline](building/pipeline.md): host scan, rules, typecheck, scans, the
  smoke test
- [Dependency installs](building/dependencies.md)
- [Device tools](building/device-tools.md)
- [The build account](building/build-account.md)

## Security

- [Threat model](security/threat-model.md): assets, adversaries, controls and their
  tests, non-goals, residual risks
- [Privacy](security/privacy.md): what's removed, what still connects out, how to check
- [Supply chain](security/supply-chain.md)
- [Keys, tokens and incident playbooks](security/keys-and-incidents.md)
- [Host hardening and the CIS Benchmark](security/hardening-cis.md)
- [Testing](security/testing.md)
- [Reporting a vulnerability](../../../SECURITY.md)

## Reference

- [Commands, files and variables](commands.md)
- [Troubleshooting](troubleshooting.md)
