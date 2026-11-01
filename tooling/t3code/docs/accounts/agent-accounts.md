# Agent accounts

> **Applies to:** macOS, the host role and the standby lane. Not yet supported on
> Linux ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Agents and the CLIs they run are code you don't control. On a host, each set of
agents runs in its own standard macOS account, with its own T3 server. The desktop
reaches that server over SSH.

## The isolation model

| Boundary | What enforces it |
|---|---|
| An agent account can't read your files | `install.sh` makes your home `chmod go-rwx`. Agent homes are `0700`, with no ACL entries except macOS's own `everyone deny delete`. |
| An agent account can't read another's | the same permissions: each agent home is private to its owner |
| An agent account can't add SSH keys | sshd reads its key from root-owned `/etc/ssh/blacksand/authorized_keys/<account>` and ignores agent accounts' own `~/.ssh/authorized_keys` files |
| SSH gives an agent account only what T3 needs | sshd allows key logins only, and forwarding only to this Mac's loopback. It turns off agent, X11, remote and socket forwarding, and tunnels. |
| Only agent accounts log in over SSH | Remote Login's access list is exactly the members of `blacksand-agents`, so your admin account can't SSH in |
| Every login uses a key | sshd turns off password and keyboard-interactive logins for everyone, and root login |
| Logins come only from tailnet addresses | sshd refuses every login whose source address isn't a tailnet address or this Mac's loopback. Its limits are below. |
| An agent account can't drive another account's server | each server requires pairing credentials, from loopback clients too (upstream's server authentication) |
| An agent account can't change Tailscale | it gets no Tailscale rights, and tailscaled's LocalAPI takes writes from root only |
| An agent account can't stall updates | the build tools' lock is `root:admin` 0640 plus one ACL entry for the build account ([build account](../building/build-account.md)) |

Some things aren't separated. Everything that runs as one agent account, including
its agents, its CLIs and their tools, can read that account's provider tokens and
files. The agents' network access is whatever their own sandboxes, or yours, allow.
adb is one server per Mac, and every account shares it
([Android](../devices/android.md)).

## Your SSH key

Pick the key agent accounts will accept. Save its public half as
`~/.ssh/blacksand.pub` on every machine that logs in: the desktop, and the host for
local checks. Create `~/.ssh` with `mkdir -m 700 ~/.ssh` if needed. With 1Password,
open the SSH key item and download its public key. 1Password syncs the private key,
so both machines can use it. Another SSH agent, or a key file, works too.

Point OpenSSH at your agent and at that one key, because turning an agent on doesn't
make `ssh` use it. sshd also stops after six offered keys (`MaxAuthTries`). With
several keys in the agent, a login can fail before it reaches the right one. Put this
in `~/.ssh/config` before the first login, with your host's name, and your agent's
socket if it isn't 1Password's:

```
# The key agent accounts accept, and only it, for the machines blacksand-t3 logs in to.
Host t3b-host localhost 127.0.0.1 ::1
  IdentityFile ~/.ssh/blacksand.pub
  IdentitiesOnly yes

Host *
  IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

`IdentityFile` names the public key, and the agent offers the matching private key.
Check the setup:

```sh
SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ssh-add -l
ssh -G agent-claude@t3b-host | grep -E '^identit'
```

The first command lists your keys. The second shows `identitiesonly yes` and
`identityfile ~/.ssh/blacksand.pub`. Whoever can use this key can log in to every
agent account, so protect it ([keys and incidents](../security/keys-and-incidents.md)).

## Create an agent account

On the host, from your admin account, in the clone:

```sh
sudo tooling/t3code/scripts/add-agent-account.sh agent-claude --key ~/.ssh/blacksand.pub
```

macOS asks you to choose the new account's password. Keep it in your password
manager. You need it only to log in at the screen. `sysadminctl` may print a
`### Error:-14120` line while it creates the account, and that line is harmless.

The script does these things:

- It creates `agent-claude` as a standard account if it doesn't exist, and puts it in
  the group `blacksand-agents`. It locks the account's home and yours as the table
  above says, and it stops if your account can still open that home.
- It authorizes exactly that one public key, in root's file, and rewrites the file
  on every run.
- It writes `/etc/ssh/sshd_config.d/010-blacksand.conf` with the SSH settings above
  and the source filter. Before the script keeps the file, it has sshd check the
  file against two dozen sample addresses. If any result is wrong, the script puts
  the previous file back and stops.
- It sets Remote Login's access list (`com.apple.access_ssh`) to exactly the members
  of `blacksand-agents`. That removes your admin account and nested groups such as
  "Administrators".
- It installs the Claude token helper, root-owned, at
  `/usr/local/libexec/blacksand/set-claude-token`, because agent accounts can't open
  your home or the clone in it.
- It copies the pricing table the updater published, so cost estimates work in that
  account.

You can rerun it any time. It puts everything back the way this list describes.

## Turn on Remote Login

In **System Settings → General → Sharing → Remote Login**, open its ⓘ panel. Leave
**Allow full disk access for remote users** off, and choose **Allow access for: Only
these users**. Turning Remote Login on can change that list, so run the same
`add-agent-account.sh` command again afterwards. Then check the result:

```sh
dscl . -read /Groups/com.apple.access_ssh GroupMembership
dscl . -read /Groups/com.apple.access_ssh NestedGroups
sudo sshd -T -C user=agent-claude,host=localhost,addr=127.0.0.1 | grep -iE '^(authorizedkeysfile|passwordauthentication|allowtcpforwarding|permitopen) '
sudo sshd -T -C user=agent-claude,host=lan,addr=192.168.1.9 | grep -i '^denyusers'
sudo sshd -T -C user=agent-claude,host=tailnet,addr=100.101.1.1 | grep -i '^denyusers'
```

- `GroupMembership` lists only your agent accounts, and `NestedGroups` says `No such key`.
- The first `sshd -T` prints `AuthorizedKeysFile /etc/ssh/blacksand/authorized_keys/%u`,
  `PasswordAuthentication no`, `AllowTcpForwarding local` and `PermitOpen 127.0.0.1:*
  localhost:* [::1]:*`. Apple's sshd capitalizes the keywords.
- A LAN address (`192.168.1.9`) prints `DenyUsers *`. A tailnet address prints
  nothing.

Rerun the script whenever you've touched Remote Login's settings. It puts the list
back.

## Narrow logins to the desktop (optional)

Once the desktop is on the tailnet, `tailscale ip` on the desktop prints its IPv4 and
IPv6 tailnet addresses. On the host, run this at its keyboard or through
[Screen Sharing](../remote-access/screen-sharing.md), because your admin account
can't SSH in any more:

```sh
read -r "T3B_DESKTOP_IPV4?Paste the desktop's Tailscale IPv4 address: "
read -r "T3B_DESKTOP_IPV6?Paste the desktop's Tailscale IPv6 address: "
sudo tooling/t3code/scripts/add-agent-account.sh agent-claude --key ~/.ssh/blacksand.pub --allow-from "$T3B_DESKTOP_IPV4,$T3B_DESKTOP_IPV6"
sudo sshd -T -C "user=agent-claude,host=desktop,addr=$T3B_DESKTOP_IPV4" | grep -i '^denyusers'
sudo sshd -T -C user=agent-claude,host=other,addr=100.101.1.1 | grep -i '^denyusers'
```

The desktop's address prints no `DenyUsers`, and `100.101.1.1` now prints `DenyUsers
*`. The setting is global, and the script saves it in `/etc/ssh/blacksand/allow-from`.
Later runs keep it and say so. `--tailnet-only` goes back to the whole tailnet
ranges. `--allow-from` takes tailnet addresses only. A rebuilt desktop gets new
addresses, so run this again with them. `--allow-lan` also allows logins from your
local network, still with keys only. Give it on every run, because a run without it
closes the LAN again.

## What the source filter does and doesn't do

Remote Login listens on every interface, so machines on your local network can
connect to the host's sshd. The filter then refuses any login from an address that
isn't a tailnet address or the host's own. With `--allow-from`, the only tailnet
addresses it accepts are the desktop's. The filter checks the address a connection
claims, not the interface it arrived on. So a LAN peer that gives itself a tailnet
address and holds an authorized key gets in. A peer in a VM test did exactly that.
pf could tie SSH to Tailscale's interface. The scripts don't use it, because a pf
mistake can lock a remote host out for good. With Tailscale down, nothing can reach
the host over SSH. The [standby lane](../install/standby.md) covers that case. Before
FileVault is unlocked, Apple's unlock server answers on the same port
([host](../install/host.md#power-restarts-and-filevault)).

## Log in as the agent

From your admin account on the host:

```sh
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
ssh agent-claude@localhost
```

The loop lists the host's key fingerprints. On macOS 27 one of them is an
`MLDSA44-ED25519` hybrid key. On the first connection, accept the host's key only if
its fingerprint matches the line for the same key type. Your SSH agent may ask you to
approve the key's use. A password prompt or `Permission denied (publickey)` means the
key isn't reaching sshd ([troubleshooting](../troubleshooting.md#ssh)).

Next: [provider CLIs and sign-in](providers.md).

## More accounts

Repeat [create](#create-an-agent-account) for each account. Remote Login stays on.
Each run sets the access list to every agent account and keeps a saved
`--allow-from`. Then set up the new account's providers. Agent accounts don't need
to be logged in at the screen, because servers start over SSH and the updater needs
no login. The one possible exception is an account that runs simulators or emulators
([devices](../devices/overview.md)).
