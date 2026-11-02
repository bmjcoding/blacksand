# Your phone

> **Applies to:** macOS, host role. Optional. Not yet supported on Linux
> ([what it would need](../getting-started/roles.md#not-yet-supported-on-linux)).

blacksand-t3 removes T3 Connect, the relay the phone app normally uses. Instead, the
phone reaches one agent account's server directly over Tailscale. Tailscale Serve
publishes HTTPS on the host's MagicDNS name, and the policy allows `tcp:443` from the
phone's tag only. Serve forwards it to that account's server on the host's loopback.

- A launchd job (`dev.blacksand.phone.<account>`) starts the server at boot, as the
  agent account, whether or not anyone is logged in. The server listens on
  `127.0.0.1` only.
- The desktop's SSH connection to the same account shares that server, so the phone
  and the desktop see the same threads.
- An update restarts the server on the new build within seconds, which stops a turn
  in progress.
- You configure Serve as the admin. The agent account gets no Tailscale rights.
- The server still requires pairing: one-time codes that expire in minutes, and
  sessions you can revoke.

## Set it up

1. Add the phone grant and tests to your policy, and turn on HTTPS certificates
   ([Tailscale](../networking/tailscale.md)).
2. On the host, from your admin account, in the clone:

   ```sh
   sudo tooling/blacksand-t3/scripts/add-phone-service.sh agent-claude
   ```

   It installs the job and checks that the server listens on 127.0.0.1 only. A first
   start can take up to 90 seconds. Then it maps `https://t3b-host.<tailnet>.ts.net`
   to the server. It changes nothing, and says why, in any of these cases:
   - it would have to replace another Serve mapping;
   - Funnel is on;
   - it can't read Serve's configuration;
   - IP forwarding or the host model is unsafe.

   Without a working tailnet, it installs the server for the desktop and asks you to
   rerun it once Tailscale is up.
3. Install the Tailscale app on the phone and sign in. In the admin console, go to
   **Machines →** the phone **→ … → Edit ACL tags → `tag:t3b-phone`**.
4. Pair the phone. This prints a one-time code that's valid for 5 minutes:

   ```sh
   sudo tooling/blacksand-t3/scripts/add-phone-service.sh agent-claude --pair
   ```

   Use `--ttl 10m` for longer, up to 60m. You can also make a code in the desktop
   app, at this environment's **Settings → Sharing & access → Create link**. In the
   T3 Code app on the phone, choose **Add environment**, enter
   `t3b-host.<tailnet>.ts.net` as the Address, then enter the code. If you retry,
   clear the Address field first.

Use the app, not the phone's browser. blacksand-t3's web UI connects only to loopback.

| Option | What it does |
|---|---|
| `--https-port 8443` | gives a second account its own HTTPS port. Add that port to the policy too |
| `--port N` | sets the server's loopback port: 4773 by default, or the next free one. A rerun keeps the port. To change it, run `--remove` first |
| `--no-serve` | leaves Serve alone, and prints the command to map it later |
| `--remove` | removes the account's Serve mapping and reads Serve back. Only when nothing in Serve can still reach the server's port does it stop and delete the job. It needs tailscaled running. If anything else in Serve reaches that port, it stops, changes nothing and names what's in the way. A rerun finishes the removal. The desktop then starts the account's server over SSH again |
| `--print-policy` | prints the Tailscale grant and tests. It doesn't need sudo |

The server may still be starting when the desktop connects, on a first start or just
after an update. The desktop then waits up to 90 seconds, and asks you to connect
again. It never starts a second server. The server's log is in that account's
`~/.blacksand/t3/phone/`. Only that account can read the log, because it holds pairing
links.

**If you lose the phone.** Revoke its session in the desktop app, at this environment's
**Settings → Sharing & access → Authorized clients → Revoke**. Also remove the device
in the admin console.

## Tested so far

Tests in macOS VMs with a real packed build covered the job and its privilege
boundary, a boot with nobody logged in, sharing with SSH connections, updates,
crashes, a slow start, and pairing and session checks against the real server. Not
yet tested: a real tailnet's Serve, or a real phone.

## What this doesn't protect

- The phone app is upstream's stock T3 Code. It pairs directly as above, but keeps
  its own telemetry and offers T3 Connect sign-in. It gets no push notifications,
  because they need T3 Connect. A blacksand-t3 phone build is planned.
- Setup adds an HTTPS listener in tailscaled for the devices your policy allows. The
  listener's certificate puts the host's MagicDNS name in public Certificate
  Transparency logs.
- A paired phone holds a session with that agent account's powers until you revoke it.
- Setup checks IP forwarding and the host model once. If someone turns forwarding on
  later, the listener can be reachable from your local network until you notice. The
  server still requires pairing.
