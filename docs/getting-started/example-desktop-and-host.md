# Example: a desktop Mac and an always-on host Mac

> **Applies to:** two Macs, one with `--role both` and one with `--role host`.

The **desktop Mac** runs the app you work in. Coding agents run on the **always-on
host Mac**, each in its own standard account with its own T3 server, which the desktop
reaches over SSH through Tailscale. Optional extras: a standby lane on the desktop,
your phone, and Screen Sharing of the host.

```
desktop Mac ──SSH over Tailscale, port 22────────▶ agent-claude@t3b-host     (host: T3 server + provider CLIs)
            ├─Screen Sharing over Tailscale, 5900─▶ t3b-host, admin account   (optional)
            └─SSH to 127.0.0.1, port 2222────────▶ agent-standby (same Mac)  (optional standby lane)
phone ──────HTTPS over Tailscale, 443────────────▶ agent-claude's server     (optional)
```

The names below are examples; use your own consistently.

| Name | What it is |
|---|---|
| `t3b-host`, `t3b-desktop` | the Macs' Tailscale machine names (MagicDNS) |
| `tag:t3b-host`, `tag:t3b-desktop`, `tag:t3b-phone` | their tags in your tailnet policy |
| `agent-claude` | an agent account on the host (add more the same way) |
| `agent-standby` | the standby lane's agent account on the desktop |
| your admin account | the account you set each Mac up from; on the desktop, your daily account |
| `~/.ssh/t3blackout.pub` | the public half of the SSH key agent accounts accept |

Steps marked **(you)** are ones only you can do: a sign-in, a consent dialog, or a
device in your hand.

## Steps, in order

Set up the host first, because the desktop's SSH steps need it running.

0. **Rebuilding?** [Before you wipe](rebuilding.md).
1. **Both Macs:** [prerequisites](prerequisites.md#macos) **(you: Apple Account,
   1Password sign-in)**, [base system](../install/base-system.md), and
   [your SSH key](../accounts/agent-accounts.md#your-ssh-key).
2. **Tailscale:**
   1. [the policy](../networking/tailscale.md#the-policy-admin-console-before-any-machine-joins)
      **(you: admin console)**;
   2. on the host, [`tailscaled` as a system daemon](../networking/tailscale.md#the-host-tailscaled-as-a-system-daemon)
      **(you: approve the device)**;
   3. on the desktop, [the Tailscale app](../networking/tailscale.md#the-desktop-the-tailscale-app)
      **(you: sign in)**.
3. **The host:**
   1. [power, FileVault and network settings](../install/host.md), then
      [clone and check the clone](../install/clone.md), then `packages/t3/install.sh --role
      host` **(you: approve 1Password and sudo)**;
   2. optional: [Screen Sharing](../remote-access/screen-sharing.md), now, before any
      agent account;
   3. [create `agent-claude` and turn on Remote Login](../accounts/agent-accounts.md#create-an-agent-account)
      **(you: the account's password, the Remote Login switch)**;
   4. [log in as the agent](../accounts/agent-accounts.md#log-in-as-the-agent), then
      [provider CLIs and sign-in](../accounts/providers.md) **(you: provider sign-ins)**;
   5. more accounts, the same way;
   6. optional: [your phone](../remote-access/phone.md) **(you: the phone)**.
4. **The desktop:**
   1. [clone and check the clone](../install/clone.md), then `packages/t3/install.sh --role
      both` ([desktop](../install/desktop.md));
   2. optional: [restore your own threads](../install/desktop.md#before-the-first-launch-your-own-threads-optional),
      before the first launch;
   3. optional: [the standby lane](../install/standby.md);
   4. [open the app](../install/desktop.md#open-the-app) **(you: Always Allow, twice)**.
5. **Connect:** [trust the host's key and add the environments](../accounts/connect.md).
   Optionally [narrow logins to the desktop](../accounts/agent-accounts.md#narrow-logins-to-the-desktop-optional).
6. **Mobile development** (optional): [devices](../devices/overview.md).
7. **Tailnet Lock** (optional): [Tailnet Lock](../networking/tailscale.md#tailnet-lock-optional).
8. **Verify:** the table below, then the restart test.

## Verification

| Where | Check | Expected |
|---|---|---|
| Both | `packages/t3/bin/t3blackout status` | the pinned release installed, `builds: as _t3blackout`, `signing: Apple Development: …`, the schedule line for the role |
| Both | `git --version` (new Terminal window) | 2.55.0 or later, Homebrew's |
| Both | `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`; `csrutil status`; `spctl --status` | firewall enabled; SIP enabled; assessments enabled |
| Host | `pmset -g` | `sleep 0` |
| Host | admin console → Machines | `t3b-host` tagged, Expiry disabled |
| Host | `ps -ax -o args= \| grep '[t]ailscaled'`; `tailscale version` | `--no-logs-no-support`; 1.104.4 or later |
| Host | `sysctl net.inet.ip.forwarding net.inet6.ip6.forwarding net.inet.ip.check_interface net.inet6.ip6.check_interface` | `0`, `0`, `1` (or `2`), `1` (or `2`) |
| Host | `dscl . -read /Groups/com.apple.access_ssh GroupMembership` | only agent accounts |
| Host | the `sshd -T` lines in [agent accounts](../accounts/agent-accounts.md#turn-on-remote-login) | a LAN address gets `DenyUsers *` |
| Host | `ssh agent-claude@localhost 'zsh -ilc "claude --version; codex --version"'` | both print a version |
| Host | `stat -f '%Sp' ~ /Users/agent-claude` (from your admin account) | `drwx------` for both |
| Host | `sudo ls -led /Users/agent-claude` | no ACL line but `0: group:everyone deny delete` |
| Host | `sudo fdesetup list` | your admin account; no agent accounts |
| Host | phone: `sudo lsof -nP -iTCP:4773 -sTCP:LISTEN`; `tailscale serve status` | `127.0.0.1:4773` only; your HTTPS name → `http://127.0.0.1:4773`, nothing on Funnel |
| Host | Screen Sharing: `sudo packages/t3/scripts/enable-screen-sharing.sh --status` | on, from the script's own plist; answers on loopback; capture granted; 15900 held by launchd (or screensharingd during a session) on 127.0.0.1 and ::1 only; the parking job on 15901; 5900 by tailscaled; the forward to 15900; the switch off; no problem. After `--off`: the forward parked on 15901 |
| LAN device | Screen Sharing: `nc -z -G 3 <host's LAN address> 5900` | refused or times out |
| Desktop | `nc -z -G 2 127.0.0.1 22` | refused (Remote Login off) |
| Desktop | `sudo lsof -nP -iTCP:2222 -sTCP:LISTEN` | loopback only |
| Desktop | `ssh -p 2222 agent-standby@127.0.0.1 'zsh -ilc "claude --version; codex --version"'` | both print a version |
| Desktop | **Settings → Connections → Environments** | both environments Connected |
| Desktop | a thread per environment, with each provider | answers |
| Desktop | Screen Sharing: `vnc://t3b-host`, as the host's admin account | the host's screen, not black, and it takes your mouse and keyboard |
| Host | the [Android check](../devices/android.md#check), for the account that runs emulators | `BOOTED emulator-5584` |
| Desktop | in a host thread, **Device**: a simulator started and tapped | streams and answers |
| Phone | the T3 Code app, a thread in the paired environment | answers |
| Both | `tailscale lock status` | enabled, if you turned it on |
| Both | the admin console's policy tests | pass |

## Restart test

Once, while you're at the host, run `sudo fdesetup authrestart` there.

- From the desktop, `nc -z -G 5 t3b-host 22` succeeds again within a few minutes.
- The host's environment reconnects. Switch it off and on if it doesn't on its own.
- The host's `packages/t3/bin/t3blackout status` still shows the LaunchDaemon schedule line.
- With the phone service, its server is back within seconds of boot, with nobody
  logged in.
