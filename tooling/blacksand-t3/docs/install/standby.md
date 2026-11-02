# The standby lane

> **Applies to:** macOS, `--role both`. Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

A standby lane is one agent account on the desktop Mac, for when the host is down.
The desktop app reaches it over SSH on the Mac's own loopback. macOS's Remote Login
can't be limited to loopback, because launchd owns its listening socket. So the
standby lane gets its own SSH server, and Remote Login stays off on the desktop Mac.

Install the desktop with `tooling/blacksand-t3/install.sh --role both`
([desktop](desktop.md)). That puts the app in `/Applications`, so the standby
account uses the same app. Then run:

```sh
sudo tooling/blacksand-t3/scripts/add-agent-account.sh agent-standby --loopback-only --key ~/.ssh/blacksand.pub
```

macOS asks you to choose the account's password. The script does everything
[agent accounts](../accounts/agent-accounts.md#create-an-agent-account) describes.
`--loopback-only` also makes it:

- Install the LaunchDaemon `dev.blacksand.sshd`, which runs Apple's
  `sshd -D -f /etc/ssh/blacksand/sshd_config`. That sshd listens only on port 2222
  of `127.0.0.1` and `::1`. It admits only members of `blacksand-agents`, accepts
  only keys, and has its own host key.
- Check, after starting it, that nothing else listens on port 2222.
- Restrict the key to `from="127.0.0.1,::1"`.
- Record that sshd's host key in your `~/.ssh/known_hosts` for `[127.0.0.1]:2222`,
  `[localhost]:2222` and `[::1]:2222`. The app connects in batch mode and can't
  accept an unknown key.
- Warn if Remote Login is on.

## Check it

```sh
sudo lsof -nP -iTCP:2222 -sTCP:LISTEN
nc -z -G 2 127.0.0.1 22
ssh -p 2222 agent-standby@127.0.0.1 true
```

- `lsof` shows sshd on `127.0.0.1:2222` and `[::1]:2222` only.
- `nc` fails, because Remote Login is off.
- `ssh` doesn't ask about the host key or for a password.

From another machine, port 2222 on this Mac's local network or tailnet address must
refuse connections.

Then set up [provider CLIs and sign-in](../accounts/providers.md) for
`agent-standby`. Log in with `ssh -p 2222 agent-standby@127.0.0.1`, not on
`localhost` port 22. Open sign-in URLs in your browser on this Mac. Add the
environment as [connecting](../accounts/connect.md#add-the-environment) describes,
with host `127.0.0.1`, user `agent-standby` and port `2222`.

## Notes

- With Remote Login off, the desktop Mac has no FileVault unlock over SSH.
- Turn Remote Login off in System Settings. Don't use
  `systemsetup -setremotelogin`, because it needs Full Disk Access.
- The standby lane is a separate account, not a copy of the host's. It has its own
  clones, logins and threads, and nothing copies between them automatically.
- The standby lane runs the desktop's app. It moves to a new build once the app has
  restarted into that build and you switch the standby environment off and on.
- If the standby sshd isn't listening, read `/var/log/dev.blacksand.sshd.log` and
  rerun the account script.
