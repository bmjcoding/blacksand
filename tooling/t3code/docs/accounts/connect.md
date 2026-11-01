# Connecting the desktop to an agent account

> **Applies to:** a desktop (macOS, or Linux for a host it can reach) connecting to a
> macOS agent account on a host or the standby lane.

## Trust the host's key

The app runs `ssh` in batch mode, so it can't accept a host key it hasn't seen. On
the host, list its fingerprints:

```sh
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
```

On the desktop, connect once by hand to the exact name you'll give the app:

```sh
ssh agent-claude@t3b-host true
```

Accept the key only if its fingerprint matches the host's line for the same key type.
The `Host t3b-host …` block from [your SSH key](agent-accounts.md#your-ssh-key) makes
`ssh` offer only the agent accounts' key. The app reads the same `~/.ssh/config`.
The standby lane's script records its key for you.

## Add the environment

In T3 Code (blacksand), open **Settings → Connections → Environments → Add environment →
SSH**.

| Environment | SSH host or alias | Username | Port |
|---|---|---|---|
| Host | `t3b-host` | `agent-claude` | (empty, for 22) |
| Standby lane | `127.0.0.1` | `agent-standby` | `2222` |

Adding the environment is the first pairing, so there's no link to copy. The
desktop does three things:

1. It connects over SSH. In the agent account, it starts the installed blacksand-t3
   server on the host's `127.0.0.1`, or finds the one the
   [phone service](../remote-access/phone.md) runs.
2. It forwards the server's port to a local loopback port.
3. It runs a second SSH command that creates a one-time pairing credential, and
   exchanges that credential for the one it keeps.

Your SSH agent may ask you to approve T3 Code (blacksand)'s use of the key the first time.

- **Only the installed build runs.** Rule `ssh/runner-installed-blacksand-only`
  enforces this. The remote never downloads a server. It looks for
  `BLACKSAND_T3_APP`, then `/Applications/T3 Code (blacksand).app`, then
  `~/Applications/T3 Code (blacksand).app`.
- **Data stays separate.** Each account's server keeps its data in its own
  `~/.blacksand/t3`, never `~/.t3` (rule `ssh/blacksand-home`). The launch folder is
  `0700`, because its log holds a one-time pairing link.
- **The server always asks for credentials.** It doesn't trust loopback clients, so
  another account on the same Mac can't drive it.

Start a thread in each environment, with each provider you installed.

## When the host updates

A running server keeps its build until the next connection. To move to a new one,
let running turns finish, then switch the environment off and on
([host updates](../updates/how-updates-arrive.md#hosts)).
