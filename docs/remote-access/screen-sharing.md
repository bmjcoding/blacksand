# Screen Sharing of the host

> **Applies to:** macOS, host role. Optional. Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Use this to see or control the host's screen from the desktop: an agent's simulator,
a GUI login after a restart, or admin work now that your admin account can't SSH in.
Set it up right after [installing the host](../install/host.md), before any agent
account exists.

```sh
sudo packages/t3/scripts/enable-screen-sharing.sh
```

## How it stays off your local network

macOS's own Screen Sharing listens on every interface, your local network included,
and the Tailscale policy can't filter that. The script doesn't use a firewall the host
would depend on, since that's one more way to lock yourself out. Instead it:

- normally keeps macOS's Screen Sharing switch off (the crash window below can leave
  Apple's every-interface job enabled for the next boot). It runs the same `screensharingd` from a
  plist of its own, whose only socket is port 15900 on the host's loopback (127.0.0.1
  and ::1);
- has Tailscale Serve forward the tailnet's TCP 5900 there, but only while Screen
  Sharing is verified to hold 15900. Otherwise a program on the host (an agent's)
  could listen on 15900 and fake a sign-in prompt. Two small root jobs hold 15900
  while Screen Sharing is off, and 15901 always. While it's off, the forward points at
  15901 ("parked"). That's read back from tailscaled each time, never assumed;
- touches no firewall, pf or sshd, so it can't block SSH;
- limits sign-in to exactly your admin account (its macOS password), and turns off
  VNC passwords and "Anyone may request permission".

Setup succeeds only once `screensharingd` answers on loopback and macOS lets it
capture the screen and take input. If setup fails after starting Screen Sharing, it
turns it off again and says whether that worked. If Tailscale isn't up yet, Screen
Sharing works on loopback, and the forward follows once tailscaled is up.

## The check

A root check (`dev.t3blackout.screen-sharing-check`) runs at boot and every minute.
Within about a minute, it undoes or stops what's wrong:

- Apple's version loaded or its switch on (System Settings can do that): it unloads
  Apple's version, switches it off, and loads its own again;
- a sign-in rule broken (another account allowed, a VNC password, Remote Management
  on): it turns Screen Sharing off, ending any session;
- anything but root's tailscaled on 5900, or anything but its own jobs on 15900 or
  15901, or IP forwarding or the host model unsafe ([host](../install/host.md#network-settings-the-tailnet-relies-on)):
  it turns Screen Sharing off and says why;
- tailscaled not answering when Screen Sharing must go off: it can't read the forward
  back as parked, so Screen Sharing stays on and keeps its port, and the next check
  tries again.

A failed or timed-out check attempts a bounded shutdown; if the forward can't be verified as parked, the backend can stay loaded and the failure is reported. The script
moves only its own TCP 5900 forward. Serve rules you made by hand that could reach
15900 or 15901 stop it from changing anything until you remove them (`--status`
names them).

## The one-time capture step

This hasn't yet been confirmed on a real Mac. If setup says macOS hasn't granted
screen capture and control (you'd see a black screen that takes no input), do this at
the Mac:

1. Open **System Settings → General → Sharing**, and turn Screen Sharing on.
2. Wait until it shows as on, then turn it off again.
3. Rerun the script.

While it's on, Apple's version listens on your local network (password-protected,
your account only). So do this with the firewall on ([base system](../install/base-system.md)),
or with the Mac off your network, before any agent account exists.

## Connect

On the desktop: **Finder → Go → Connect to Server → `vnc://t3b-host`**, and sign in as
the host's admin account. Use Standard mode only: Serve forwards TCP, and High
Performance mode needs UDP. **System Settings shows Screen Sharing as off while it
runs.** Leave it so.

| Command (`sudo packages/t3/scripts/enable-screen-sharing.sh …`) | What it does |
|---|---|
| `--status` | whether it's on, whether macOS granted capture, who holds each port, where the forward points, the switch, and any problem |
| `--off` / `--on` | turn it off (the forward stays parked) or on again. Each reports success only when the state is verified; otherwise it names what remains |
| `--no-serve` | set up for the host's loopback only; reach it through an SSH tunnel. Switching an existing Serve setup to this needs tailscaled running |
| `--uninstall` | park the forward and turn Screen Sharing off, remove the forward, check nothing in Serve still reaches 15900 or 15901, and only then remove the check and the jobs. Without tailscaled, it stops before the forward and keeps everything holding its ports; rerun once tailscaled is back. Then remove the `tcp:5900` grant from your policy |
| `--print-policy` | the Tailscale grant and tests (no sudo) |

If it ever reports a state it doesn't recognize, run `--uninstall`, then set it up
again. Screen Sharing isn't available until FileVault is unlocked after a restart.

## Tested so far

In macOS 27.2 VMs, all 96 bind variants were refused while the ports were held by the
live or holding jobs. During swaps, an agent captured both families of port 15900;
checks detected it and refused transitions until the agent released the port. Admin-only
sign-in, the checks, `--off`/`--uninstall` and sampled ordinary reboots were exercised.
Setup refuses when macOS denies capture or input; a session with a usable picture and
control hasn't been accepted yet. A real tailnet's Serve forwarding, what happens to an
existing session during a swap, and the System Settings consent step remain unverified. The [verification rows](../getting-started/example-desktop-and-host.md#verification)
check them on your host.

## What this doesn't protect

- It adds a password-authenticated service. It's reachable from the host's loopback,
  where any local account can connect (agent accounts and their SSH forwards
  included), but only your account can sign in. Through Serve, it's reachable from
  the devices your policy allows.
- The check polls once a minute. For up to about a minute after a change (Apple's
  version turned on in System Settings, a sign-in rule broken, Remote Management on,
  forwarding on), the old state stands.
- If the check job is removed or broken, a running Screen Sharing stays up until the
  next restart, and isn't started after it.
- A sign-in rule broken while tailscaled doesn't answer leaves Screen Sharing loaded
  until the forward can be read back as parked. The check records that it could NOT
  be turned off, in its log and in `--status`'s "last failed check".
- **A crash or power loss in the moment the check loads it.** Loading switches the
  switch on for one `launchctl bootstrap` (8–12 ms on test Macs), then off again. A
  signal is caught; a SIGKILL or power loss isn't. The next boot then starts Apple's
  every-interface version (password-protected, your account only) until the
  boot-time check, which runs first, unloads it. That was measured at about 2 s of
  reach from the local network on test Macs.
- A tailnet address also present on a physical interface isn't detected.
- Failures of root filesystem operations other than a full disk (writing or removing
  files in `/var/db`, `/var/run` or `/Library`) aren't handled specially.
- Root on the host can undo all of it.
