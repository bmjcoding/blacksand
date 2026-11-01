# Base system hardening

> **Applies to:** macOS, every role. Linux: see the note at the end.

Do this on each Mac, from your admin account, before installing anything else.
[Host hardening and the CIS Benchmark](../security/hardening-cis.md) maps each step
to the CIS Apple macOS Benchmark.

1. **Updates.** Finish the setup assistant, then bring macOS up to date in **System
   Settings → General → Software Update**. `softwareupdate --list` shows what's
   pending. Click ⓘ next to **Automatic updates**. Keep **Install Security Responses
   and system files** on, and turn on **Download new updates when available**. On a
   desktop, also turn on **Install macOS updates**. On a host, you install macOS
   updates by hand ([host](host.md#macos-updates)). Check these before counting the
   CIS update rows as met.
2. **FileVault.** Turn it on in **System Settings → Privacy & Security → FileVault**.
   Keep the recovery key in your password manager.
3. **Firewall, stealth mode and screen lock.** Turn these on, then check SIP and
   Gatekeeper:

   ```sh
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on
   sysadminctl -screenLock immediate -password -
   csrutil status
   spctl --status
   ```

   The first two commands turn on the firewall and stealth mode. macOS's own
   services, Remote Login included, still accept connections. A test in a macOS VM
   confirmed this. The screen locks as soon as the screen saver or sleep starts.
   `csrutil` says `enabled`, and `spctl` says `assessments enabled`. Don't choose
   "Block all incoming connections". Expect a one-time "Allow incoming connections"
   dialog for a program that serves your network, such as a dev server.
4. **Sharing off.** In **System Settings → General → Sharing**, leave every service
   off. A host turns on Remote Login later ([agent accounts](../accounts/agent-accounts.md)).
   Screen Sharing only ever comes on through its script
   ([Screen Sharing](../remote-access/screen-sharing.md)), never through its switch
   here. Leave Internet Sharing off, because its IP forwarding would let your local
   network reach the host's tailnet listeners.
5. **AirPlay Receiver off.** Turn it off in **System Settings → General → AirDrop &
   Handoff**.
6. **Time.** Turn on **Set time automatically** in **System Settings → General → Date
   & Time**. blacksand-t3 measures dependency ages by this clock.
7. **No HTTPS interception.** Remove any security software that decrypts and
   re-signs HTTPS ([prerequisites](../getting-started/prerequisites.md#macos)).

To check these later, use the verification rows in
[the worked example](../getting-started/example-desktop-and-host.md#verification).

## Linux

This page doesn't cover base hardening on Linux. Apply your distribution's own
guidance for disk encryption, a firewall, automatic security updates and network
time. blacksand-t3 itself needs only network time, sudo for the installer, and a
network without HTTPS interception.
