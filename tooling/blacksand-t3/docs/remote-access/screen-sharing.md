# Screen Sharing of the host

> **Applies to:** macOS, host role. Optional. Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Use this to see or control the host's screen from the desktop: an agent's simulator,
a GUI login after a restart, or admin work now that your admin account can't SSH in.
Set it up right after [installing the host](../install/host.md), before any agent
account exists.

```sh
sudo tooling/blacksand-t3/scripts/enable-screen-sharing.sh
```

## How it stays off your local network

macOS's own Screen Sharing listens on every interface, your local network included.
The Tailscale policy can't filter that. The script doesn't rely on a firewall, because
a firewall the host depends on is one more way to lock yourself out. Instead, the
script does this:

- It normally keeps macOS's Screen Sharing switch off. A crash at one moment, described
  below, can leave Apple's every-interface job enabled for the next boot. The script
  runs the same `screensharingd` from a plist of its own, whose only socket is port
  15900 on the host's loopback (127.0.0.1 and ::1).
- It has Tailscale Serve forward the tailnet's TCP 5900 to 15900, but only while it
  has verified that Screen Sharing holds 15900. Otherwise a program on the host, such
  as an agent's, could listen on 15900 and fake a sign-in prompt. Two small root jobs
  hold 15900 while Screen Sharing is off, and hold 15901 at all times. While Screen
  Sharing is off, the forward points at 15901. The script calls this "parked". It
  reads the forward back from tailscaled each time, and never assumes it.
- It touches no firewall, pf or sshd, so it can't block SSH.
- It allows sign-in only by your admin account, with that account's macOS password.
  It turns off VNC passwords and "Anyone may request permission".

Setup succeeds once `screensharingd` answers on loopback. If its check-in line says
macOS denies it screen capture or input, setup fails and names the System Settings step
that grants it. If there's no check-in line to go by, setup warns and still succeeds. If setup fails after it starts Screen Sharing, it
turns Screen Sharing off again and says whether that worked. If Tailscale isn't up
yet, Screen Sharing works on loopback, and the forward is set up once tailscaled is up.

## The check

A root check (`dev.blacksand.screen-sharing-check`) runs at boot and every minute.
Within about a minute, it undoes or stops what's wrong:

- If Apple's version is loaded or its switch is on, which System Settings can do, the
  check unloads Apple's version, switches it off, and loads its own again.
- If a sign-in rule is broken, it turns Screen Sharing off and ends any session.
  Another account allowed, a VNC password, or Remote Management on each break a rule.
- If anything but root's tailscaled is on 5900, or anything but its own jobs is on
  15900 or 15901, or IP forwarding or the host model is unsafe
  ([host](../install/host.md#network-settings-the-tailnet-relies-on)), it turns Screen
  Sharing off and says why.
- If tailscaled isn't answering when Screen Sharing must go off, the check can't read
  the forward back as parked. Screen Sharing then stays on and keeps its port, and the
  next check tries again.

When a check fails or times out, it tries to shut Screen Sharing down within a time
limit. If it can't verify the forward as parked, the backend can stay loaded, and the
check reports the failure. The script moves only its own TCP 5900 forward. If you made
Serve rules by hand that could reach 15900 or 15901, the script changes nothing until
you remove them. `--status` names them.

## The one-time capture step

No one has confirmed this step on a real Mac yet. Setup may say that macOS hasn't
granted screen capture and control. You'd see a black screen that takes no input. If
so, do this at the Mac:

1. Open **System Settings → General → Sharing**, and turn Screen Sharing on.
2. Wait until it shows as on, then turn it off again.
3. Rerun the script.

While the switch is on, Apple's version listens on your local network. It's
password-protected, and only your account can sign in. So do this before any agent
account exists, with the firewall on ([base system](../install/base-system.md)) or
with the Mac off your network.

## Connect

On the desktop, open **Finder → Go → Connect to Server**, enter `vnc://t3b-host`, and
sign in as the host's admin account. Use Standard mode only. Serve forwards TCP, and
High Performance mode needs UDP. **System Settings shows Screen Sharing as off while it
runs.** Leave the switch off.

| Command (`sudo tooling/blacksand-t3/scripts/enable-screen-sharing.sh …`) | What it does |
|---|---|
| `--status` | shows whether it's on, whether macOS granted capture, who holds each port, where the forward points, the switch, and any problem |
| `--off` / `--on` | turns it off, leaving the forward parked, or on again. Each reports success only once it has verified the state. Otherwise it names what remains |
| `--no-serve` | sets it up for the host's loopback only, which you reach through an SSH tunnel. Switching an existing Serve setup to this needs tailscaled running |
| `--uninstall` | parks the forward, turns Screen Sharing off, removes the forward, and checks that nothing in Serve still reaches 15900 or 15901. Only then does it remove the check and the jobs. Without tailscaled, it stops before the forward and leaves everything that holds a port in place. Rerun it once tailscaled is back. Then remove the `tcp:5900` grant from your policy |
| `--print-policy` | prints the Tailscale grant and tests. It doesn't need sudo |

If it ever reports a state it doesn't recognize, run `--uninstall`, then set it up
again. After a restart, Screen Sharing is available only once FileVault is unlocked.

## Tested so far

In macOS 27.2 VMs, macOS refused all 96 bind variants while the live or holding jobs
held the ports. During swaps, an agent took port 15900 on both address families. The
checks detected it, and refused transitions until the agent released the port. Tests
also exercised admin-only sign-in, the checks, `--off`, `--uninstall` and a sample of
ordinary reboots. Setup refuses when macOS denies capture or input. No session with a
usable picture and control has been accepted yet.

Three things remain unverified: a real tailnet's Serve forwarding, what happens to an
existing session during a swap, and the System Settings consent step. The
[verification rows](../getting-started/example-desktop-and-host.md#verification)
check them on your host.

## What this doesn't protect

- It adds a password-authenticated service. Any local account can connect to it on
  the host's loopback, including agent accounts and their SSH forwards, but only your
  account can sign in. Through Serve, the devices your policy allows can reach it.
- The check polls once a minute. So for up to about a minute after a change, the old
  state stays in effect. Such a change could be Apple's version turned on in System
  Settings, a broken sign-in rule, Remote Management turned on, or forwarding turned
  on.
- If the check job is removed or broken, a running Screen Sharing stays up until the
  next restart, and doesn't start after it.
- If a sign-in rule breaks while tailscaled doesn't answer, Screen Sharing stays
  loaded until the check can read the forward back as parked. The check records that
  Screen Sharing "could NOT be turned off", in its log and in `--status`'s "last
  failed check".
- **A crash or power loss in the moment the check loads it.** Loading turns the
  switch on for one `launchctl bootstrap`, which took 8 to 12 ms on test Macs, then
  off again. The check catches a signal, but not a SIGKILL or a power loss. After
  one, the next boot starts Apple's every-interface version until the boot-time
  check, which runs first, unloads it. That version is password-protected, and only
  your account can sign in. On test Macs, it was reachable from the local network for
  about 2 s.
- The check doesn't detect a tailnet address that's also on a physical interface.
- The script doesn't handle failures of root filesystem operations specially, except
  a full disk. These operations write or remove files in `/var/db`, `/var/run` or
  `/Library`.
- Root on the host can undo all of it.
