# Agent accounts

> **Applies to:** macOS, the host role and the standby lane. Not yet supported on
> Linux ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Agents and the CLIs they run are code you don't control. On a host, each set of
agents runs in its own standard macOS account, with its own T3 server. The desktop
reaches that server over SSH.

## The isolation model

| Boundary | What enforces it |
|---|---|
| An agent account can't read your files | your home is `chmod go-rwx` (`install.sh`); agent homes are `0700` with no ACL entries except macOS's own `everyone deny delete` |
| An agent account can't read another's | the same: each agent home is private to its owner |
| An agent account can't add SSH keys | its key is in root-owned `/etc/ssh/t3blackout/authorized_keys/<account>`; agent accounts' own `~/.ssh/authorized_keys` files are ignored |
| SSH gives an agent account only what T3 needs | key logins only, forwarding to this Mac's loopback only; no agent, X11, remote or socket forwarding, no tunnels |
| Only agent accounts log in over SSH | Remote Login's access list is exactly the members of `t3blackout-agents`; your admin account can't SSH in |
| No password logins at all | password and keyboard-interactive logins off for everyone, root login off |
| Logins only from tailnet addresses | sshd refuses every login whose source address isn't a tailnet address or this Mac's loopback (see below for the limits) |
| An agent account can't drive another account's server | each server requires pairing credentials, loopback clients included (upstream's server authentication) |
| An agent account can't change Tailscale | it gets no Tailscale rights; tailscaled's LocalAPI takes writes from root only |
| An agent account can't stall updates | the build tools' lock is `root:admin` 0640 plus one ACL entry for the build account ([build account](../building/build-account.md)) |

What isn't separated: everything that runs as one agent account (its agents, its
CLIs, their tools) can read that account's provider tokens and files. The agents'
network access is whatever their own sandboxes, or yours, allow. adb is one server
per Mac, shared by every account ([Android](../devices/android.md)).

## Your SSH key

Pick the key agent accounts will accept. Save its public half as
`~/.ssh/t3blackout.pub` on every machine that logs in: the desktop, and the host for
local checks. Create `~/.ssh` with `mkdir -m 700 ~/.ssh` if needed. With 1Password,
open the SSH key item and download its public key. 1Password syncs the private key,
so both machines can use it. Another agent, or a key file, works too.

Point OpenSSH at your agent and at that one key. Turning an agent on doesn't make
`ssh` use it. And sshd stops after six offered keys (`MaxAuthTries`), so with several
keys in the agent a login can fail before it reaches the right one. Put this in
`~/.ssh/config` before the first login. Use your host's name, and your agent's
socket if it isn't 1Password's:

```
# The key agent accounts accept, and only it, for the machines T3 Blackout logs in to.
Host t3b-host localhost 127.0.0.1 ::1
  IdentityFile ~/.ssh/t3blackout.pub
  IdentitiesOnly yes

Host *
  IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

`IdentityFile` names the public key; the agent offers the matching private key.
Check it:

```sh
SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ssh-add -l
ssh -G agent-claude@t3b-host | grep -E '^identit'
```

The first lists your keys. The second shows `identitiesonly yes` and `identityfile
~/.ssh/t3blackout.pub`. Whoever can use this key can log in to every agent account,
so treat it accordingly ([keys and incidents](../security/keys-and-incidents.md)).

## Create an agent account

On the host, from your admin account, in the clone:

```sh
sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/t3blackout.pub
```

macOS asks you to choose the new account's password. Keep it in your password
manager; it's only for logging in at the screen. A `### Error:-14120` line from
`sysadminctl` while it creates the account is harmless. The script:

- creates `agent-claude` as a standard account if it doesn't exist, puts it in the
  group `t3blackout-agents`, and locks its home and yours as the table above says.
  It stops if your account can still open that home;
- authorizes exactly that one public key, in root's file, rewritten on every run;
- writes `/etc/ssh/sshd_config.d/010-t3blackout.conf` with the SSH settings above,
  and the source filter. Before keeping the file, sshd itself checks it against two
  dozen sample addresses. If anything is off, the previous file goes back and the
  script stops;
- sets Remote Login's access list (`com.apple.access_ssh`) to exactly the members of
  `t3blackout-agents`, removing your admin account and nested groups such as
  "Administrators";
- installs the Claude token helper, root-owned, at
  `/usr/local/libexec/t3blackout/set-claude-token`, because agent accounts can't open
  your home or the clone in it;
- copies the pricing table the updater published, so cost estimates work in that
  account.

Rerun it any time; it puts everything back the way it describes.

## Turn on Remote Login

In **System Settings → General → Sharing → Remote Login**, open its ⓘ panel. Leave
**Allow full disk access for remote users** off, and choose **Allow access for: Only
these users**. Turning Remote Login on can change that list, so run the same
`add-agent-account.sh` command again afterwards. Then check:

```sh
dscl . -read /Groups/com.apple.access_ssh GroupMembership
dscl . -read /Groups/com.apple.access_ssh NestedGroups
sudo sshd -T -C user=agent-claude,host=localhost,addr=127.0.0.1 | grep -iE '^(authorizedkeysfile|passwordauthentication|allowtcpforwarding|permitopen) '
sudo sshd -T -C user=agent-claude,host=lan,addr=192.168.1.9 | grep -i '^denyusers'
sudo sshd -T -C user=agent-claude,host=tailnet,addr=100.101.1.1 | grep -i '^denyusers'
```

- `GroupMembership` lists only your agent accounts, and `NestedGroups` says `No such key`.
- The first `sshd -T` prints `AuthorizedKeysFile /etc/ssh/t3blackout/authorized_keys/%u`,
  `PasswordAuthentication no`, `AllowTcpForwarding local` and `PermitOpen 127.0.0.1:*
  localhost:* [::1]:*`. Apple's sshd capitalizes the keywords.
- A LAN address (`192.168.1.9`) prints `DenyUsers *`; a tailnet address prints nothing.

Rerun the script whenever you've touched Remote Login's settings; it puts the list
back.

## Narrow logins to the desktop (optional)

Once the desktop is on the tailnet, `tailscale ip` on the desktop prints its IPv4 and
IPv6 tailnet addresses. On the host, run this at its keyboard or through
[Screen Sharing](../remote-access/screen-sharing.md), since your admin account can't
SSH in any more:

```sh
read -r "T3B_DESKTOP_IPV4?Paste the desktop's Tailscale IPv4 address: "
read -r "T3B_DESKTOP_IPV6?Paste the desktop's Tailscale IPv6 address: "
sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/t3blackout.pub --allow-from "$T3B_DESKTOP_IPV4,$T3B_DESKTOP_IPV6"
sudo sshd -T -C "user=agent-claude,host=desktop,addr=$T3B_DESKTOP_IPV4" | grep -i '^denyusers'
sudo sshd -T -C user=agent-claude,host=other,addr=100.101.1.1 | grep -i '^denyusers'
```

The desktop's address prints no `DenyUsers`, and `100.101.1.1` now prints `DenyUsers
*`. The setting is global and saved in `/etc/ssh/t3blackout/allow-from`. Later runs
keep it and say so. `--tailnet-only` goes back to the whole tailnet ranges.
`--allow-from` takes tailnet addresses only. A rebuilt desktop gets new addresses, so
run this again with them. `--allow-lan` also allows your local network (key-only);
give it on every run, because a run without it closes the LAN again.

## What the source filter does and doesn't do

Remote Login listens on every interface, so machines on your local network reach the
host's sshd before login. The filter refuses any login from an address that isn't a
tailnet address or the host's own (or, with `--allow-from`, the desktop's). It checks
the address a connection claims, not the interface it arrived on. So a LAN peer that
gives itself a tailnet address and holds an authorized key gets in; a VM test did
exactly that. pf could tie SSH to Tailscale's interface, but a pf mistake can lock a
remote host out for good, so the scripts don't use it. With Tailscale down, the host
can't be reached over SSH at all; the [standby lane](../install/standby.md) covers
that. Before FileVault is unlocked, Apple's unlock server answers on the same port
([host](../install/host.md#power-restarts-and-filevault)).

## Log in as the agent

From your admin account on the host:

```sh
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
ssh agent-claude@localhost
```

The loop lists the host's key fingerprints; on macOS 27 one of them is an
`MLDSA44-ED25519` hybrid key. On the first connection, accept the key only if its
fingerprint matches the line for the same key type. Your SSH agent may ask you to
approve the key's use. A password prompt or `Permission denied (publickey)` means the
key isn't reaching sshd ([troubleshooting](../troubleshooting.md#ssh)).

Next: [provider CLIs and sign-in](providers.md).

## More accounts

Repeat [create](#create-an-agent-account) for each account (Remote Login stays on;
each run reconciles the access list to every agent account and keeps a saved
`--allow-from`). Then set up its providers. Agent accounts don't need to be logged in
at the screen: servers start over SSH, and the updater needs no login. The one
possible exception is an account that runs simulators or emulators
([devices](../devices/overview.md)).
