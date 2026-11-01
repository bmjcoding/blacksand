# Base system hardening

> **Applies to:** macOS, every role. Linux: see the note at the end.

Do this on each Mac, from your admin account, before installing anything else.
[Host hardening and the CIS Benchmark](../security/hardening-cis.md) maps each step
to the CIS Apple macOS Benchmark.

1. **Updates.** Finish the setup assistant, then bring macOS up to date: **System
   Settings → General → Software Update**, or `softwareupdate --list`. Under
   **Automatic updates** (ⓘ), keep **Install Security Responses and system files**
   on, and turn on **Download new updates when available**. On a desktop, also turn on
   **Install macOS updates**; a host installs macOS updates by hand
   ([host](host.md#macos-updates)). Check these before counting the CIS update rows as
   met.
2. **FileVault:** **System Settings → Privacy & Security → FileVault** on. Keep the
   recovery key in your password manager.
3. **Firewall, stealth mode, screen lock.** Then check SIP and Gatekeeper:

   ```sh
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on
   sysadminctl -screenLock immediate -password -
   csrutil status
   spctl --status
   ```

   The firewall and stealth mode come on. macOS's own services, Remote Login
   included, still accept connections; this was checked in a macOS VM. The screen
   locks as soon as the screen saver or sleep starts. `csrutil` says `enabled`, and
   `spctl` says `assessments enabled`. Don't choose "Block all incoming connections".
   Expect a one-time "Allow incoming connections" dialog for a program that serves
   your network (a dev server, say).
4. **Sharing off.** In **System Settings → General → Sharing**, leave every service
   off. A host turns on Remote Login later ([agent accounts](../accounts/agent-accounts.md)).
   Screen Sharing only ever comes on through its script
   ([Screen Sharing](../remote-access/screen-sharing.md)), never through its switch
   here. Leave Internet Sharing off: IP forwarding would let your local network reach
   the host's tailnet listeners.
5. **AirPlay Receiver off:** **System Settings → General → AirDrop & Handoff**.
6. **Time:** **System Settings → General → Date & Time → Set time automatically**
   on. Dependency ages are measured by this clock.
7. **No HTTPS interception.** Remove any security software that decrypts and
   re-signs HTTPS ([prerequisites](../getting-started/prerequisites.md#macos)).

Check later with the verification rows in
[the worked example](../getting-started/example-desktop-and-host.md#verification).

## Linux

Base hardening isn't covered here. Apply your distribution's own guidance (disk
encryption, a firewall, automatic security updates, network time). Blacksand T3 itself
needs only network time, sudo for the installer, and no HTTPS interception.
