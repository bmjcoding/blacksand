# Your phone

> **Applies to:** macOS, host role. Optional. Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

Blacksand T3 removes T3 Connect, the relay the phone app normally uses. Instead, the
phone reaches one agent account's server directly over Tailscale. Tailscale Serve
publishes HTTPS on the host's MagicDNS name, and the policy allows `tcp:443` from the
phone's tag only. Serve forwards it to that account's server on the host's loopback.

- A launchd job (`dev.blacksand.phone.<account>`) runs the server at boot, as the
  agent account, logged in or not, on `127.0.0.1` only.
- The desktop's SSH connection to the same account shares that server, so the phone
  and the desktop see the same threads.
- An update restarts it on the new build within seconds, which stops a turn in progress.
- You (the admin) configure Serve. The agent account gets no Tailscale rights.
- The server still requires pairing: one-time codes that expire in minutes, and
  sessions you can revoke.

## Set it up

1. Add the phone grant and tests to your policy, and turn on HTTPS certificates
   ([Tailscale](../networking/tailscale.md)).
2. On the host, from your admin account, in the clone:

   ```sh
   sudo tooling/t3code/scripts/add-phone-service.sh agent-claude
   ```

   It installs the job, checks the server listens on 127.0.0.1 only (a first start
   can take up to 90 seconds), then maps `https://t3b-host.<tailnet>.ts.net` to it.
   It changes nothing, and says why, when it would have to replace another Serve
   mapping, when Funnel is on, when it can't read Serve's configuration, or while IP
   forwarding or the host model is unsafe. Without a working tailnet, it installs the
   server for the desktop and asks you to rerun once Tailscale is up.
3. Install the Tailscale app on the phone and sign in. In the admin console:
   **Machines →** the phone **→ … → Edit ACL tags → `tag:t3b-phone`**.
4. Pair. `sudo tooling/t3code/scripts/add-phone-service.sh agent-claude --pair` prints a one-time
   code, valid for 5 minutes (`--ttl 10m` for longer, at most 60m). Or make one in the
   desktop app: this environment **→ Settings → Sharing & access → Create link**. In
   the T3 Code app on the phone: **Add environment →** Address
   `t3b-host.<tailnet>.ts.net` → the code. If you retry, clear the Address field first.

Use the app, not the phone's browser: Blacksand T3's web UI only connects to loopback.

| Option | What it does |
|---|---|
| `--https-port 8443` | a second account's own HTTPS port (add it to the policy too) |
| `--port N` | the server's loopback port (default 4773, or the next free one). A rerun keeps the port; to change it, `--remove` first |
| `--no-serve` | leave Serve alone, and print the command to map it later |
| `--remove` | remove the account's Serve mapping, read Serve back, and only when nothing in Serve can still reach the server's port, stop and delete the job. It needs tailscaled running, and stops (changing nothing, naming what's in the way) if anything else in Serve reaches that port; a rerun finishes it. The desktop then starts the account's server over SSH again |
| `--print-policy` | the Tailscale grant and tests (no sudo) |

If the server is starting when the desktop connects (a first start, or just after an
update), the desktop waits up to 90 seconds, then asks you to connect again. It never
starts a second server. The server's log is in that account's
`~/.blacksand/t3/phone/`, readable by that account only, because it holds pairing links.

**Lost phone:** revoke its session (desktop → this environment **→ Settings → Sharing &
access → Authorized clients → Revoke**), and remove the device in the admin console.

## Tested so far

Tested in macOS VMs with a real packed build: the job and its privilege boundary, a
boot with nobody logged in, sharing with SSH connections, updates, crashes, a slow
start, and pairing and session checks against the real server. Not yet tested: a real
tailnet's Serve, or a real phone.

## What this doesn't protect

- **The phone app is upstream's** stock T3 Code. It pairs directly as above, but
  keeps its own telemetry and offers T3 Connect sign-in. There are no push
  notifications, because they need T3 Connect. A Blacksand T3 phone build is planned.
- It adds an HTTPS listener in tailscaled for the devices your policy allows. Its
  certificate puts the host's MagicDNS name in public CT logs.
- A paired phone holds a session with that agent account's powers until you revoke it.
- Setup checks IP forwarding and the host model once. If forwarding is turned on
  later, that listener can be reachable from your local network until you notice.
  The server still requires pairing.
