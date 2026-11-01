# Tailscale

> **Applies to:** the host on macOS, and the desktop on macOS or Linux. A Linux
> desktop uses Tailscale's Linux package. A host, the phone and Screen Sharing need
> Tailscale.

The desktop reaches the host's agent accounts over SSH, through Tailscale. The
policy below allows exactly that path. The phone and Screen Sharing each get their
own narrow grant. The policy denies every other connection.

This page uses example names. The machine names are `t3b-host` and `t3b-desktop`,
and the tags are `tag:t3b-host`, `tag:t3b-desktop` and `tag:t3b-phone`. You can use
your own names, as long as you use them consistently.

## The policy (admin console, before any machine joins)

A new tailnet's policy lets every device reach every other device. Adding narrow
rules next to that rule changes nothing. So replace the whole policy file in **admin
console → Access controls** with this one. Delete every existing `acls`, `grants`
and `ssh` entry, including the default allow-all rule. Under this policy, any other
device in the tailnet gets no access until you add a grant for it.

```jsonc
{
  // blacksand-t3. No "ssh" section: T3's SSH environments use the host's own
  // OpenSSH, not Tailscale SSH.
  "tagOwners": {
    "tag:t3b-host":    ["autogroup:admin"],
    "tag:t3b-desktop": ["autogroup:admin"],
    "tag:t3b-phone":   ["autogroup:admin"]
  },
  "grants": [
    // The desktop may open SSH on the host.
    { "src": ["tag:t3b-desktop"], "dst": ["tag:t3b-host"], "ip": ["tcp:22"] },
    // Screen Sharing (tooling/t3code/scripts/enable-screen-sharing.sh --print-policy). Delete it, and its tests, if unused.
    { "src": ["tag:t3b-desktop"], "dst": ["tag:t3b-host"], "ip": ["tcp:5900"] },
    // The phone (tooling/t3code/scripts/add-phone-service.sh --print-policy). Delete it, and its tests, if unused.
    { "src": ["tag:t3b-phone"], "dst": ["tag:t3b-host"], "ip": ["tcp:443"] }
  ],
  "tests": [
    { "src": "tag:t3b-desktop", "proto": "tcp", "accept": ["tag:t3b-host:22"], "deny": ["tag:t3b-host:80", "tag:t3b-host:443", "tag:t3b-host:2222", "tag:t3b-host:5432"] },
    { "src": "tag:t3b-desktop", "proto": "udp", "deny": ["tag:t3b-host:22"] },
    { "src": "tag:t3b-host", "deny": ["tag:t3b-desktop:22", "tag:t3b-desktop:2222"] },
    // Screen Sharing's tests:
    { "src": "tag:t3b-desktop", "proto": "tcp", "accept": ["tag:t3b-host:5900"], "deny": ["tag:t3b-host:5901", "tag:t3b-host:3283"] },
    { "src": "tag:t3b-desktop", "proto": "udp", "deny": ["tag:t3b-host:5900", "tag:t3b-host:5901", "tag:t3b-host:5902"] },
    { "src": "tag:t3b-host", "deny": ["tag:t3b-desktop:5900"] },
    { "src": "tag:t3b-phone", "deny": ["tag:t3b-host:5900"] },
    // The phone's tests:
    { "src": "tag:t3b-phone", "proto": "tcp", "accept": ["tag:t3b-host:443"], "deny": ["tag:t3b-host:22", "tag:t3b-host:2222", "tag:t3b-host:4773", "tag:t3b-host:5900", "tag:t3b-desktop:22", "tag:t3b-desktop:443"] },
    { "src": "tag:t3b-phone", "proto": "udp", "deny": ["tag:t3b-host:443", "tag:t3b-host:5900"] },
    { "src": "tag:t3b-host", "deny": ["tag:t3b-phone:22", "tag:t3b-phone:443"] }
  ]
}
```

- The console refuses to save the policy if a test fails. A test without `"proto"`
  doesn't pin the protocol, so a UDP-only grant on port 22 would still pass it. That's
  why these tests name the protocol.
- Tagging a device replaces its user ownership with the tag. To keep the desktop as
  your own user device, replace `tag:t3b-desktop` in the grants and tests with your
  login name. Then every device you sign in can reach the host's port 22. SSH still
  accepts only an authorized key.
- A second phone-enabled agent account gets its own HTTPS port. Add `"tcp:8443"` to
  the phone grant's `ip`, and copy the phone's tests for port 8443.
- With `--print-policy`, both scripts print their own policy fragment. Both take
  `--host-tag`, `--desktop-tag` and `--phone-tag` if your tags differ.
- Don't add a Funnel `nodeAttrs` entry. Funnel publishes a Serve port to the
  Internet, and the scripts refuse to work on a node with Funnel on.

**HTTPS certificates.** Only the phone needs them. Turn them on in **admin console →
DNS → HTTPS Certificates → Enable**, and keep MagicDNS on. A certificate puts the
host's name, `t3b-host.<tailnet>.ts.net`, in public Certificate Transparency logs. If that
matters, give the host a neutral machine name. The tailnet part of the name is random.

## The host: `tailscaled` as a system daemon

The host runs Tailscale's open-source daemon, which starts at boot before anyone logs
in. Tailscale's GUI app variants don't work for an unattended host. The phone service
and Screen Sharing need this daemon's LocalAPI socket, `/var/run/tailscaled.socket`.

First, delete any old machine with the same name on the admin console's Machines
page. Otherwise Tailscale names the new one `t3b-host-1`. Then run this on the host.
The paths are for Apple silicon. On Intel, use `/usr/local/bin`.

```sh
brew install tailscale
sudo /opt/homebrew/bin/tailscaled install-system-daemon
```

That copies `tailscaled` to `/usr/local/bin` and adds a LaunchDaemon. Next, opt out
of client log uploads. Tailscale's documented switch for this variant is
`--no-logs-no-support`. `install-system-daemon` takes no flags, so add the switch to
the LaunchDaemon it wrote. Then let the daemon through the firewall. Otherwise the
unsigned Homebrew binary can't accept direct connections, and traffic falls back to
Tailscale's relays.

```sh
sudo /usr/libexec/PlistBuddy -c 'Add :ProgramArguments: string --no-logs-no-support' /Library/LaunchDaemons/com.tailscale.tailscaled.plist
sudo launchctl bootout system/com.tailscale.tailscaled
sudo launchctl bootstrap system /Library/LaunchDaemons/com.tailscale.tailscaled.plist
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/tailscaled
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /usr/local/bin/tailscaled
ps -ax -o args= | grep '[t]ailscaled'
tailscale version
```

`ps` shows `/usr/local/bin/tailscaled --no-logs-no-support`, and `tailscale version`
shows 1.104.4 or later. Join the tailnet with the tag and the name you want:

```sh
sudo /opt/homebrew/bin/tailscale up --advertise-tags=tag:t3b-host --hostname=t3b-host
```

Open the URL it prints and approve the device. Tailscale disables key expiry for a
device whose first sign-in is tagged. Check it anyway. In **admin console →
Machines**, `t3b-host` must show **Expiry disabled**. If it doesn't, choose **… →
Disable key expiry**. An expired key would disconnect the unattended host from the
tailnet. Changing tags later doesn't change expiry until the device re-authenticates.

This daemon doesn't change the host's DNS settings, so the host doesn't resolve
MagicDNS names itself. It doesn't need to, because other machines connect to the
host and it never connects to them.

### Updating tailscaled

Run `brew upgrade tailscale`, then rerun `install-system-daemon`, which rewrites the
plist. Then repeat the PlistBuddy line, the `bootout` and `bootstrap` lines, and the
two `socketfilterfw` lines above.

## The desktop: the Tailscale app

Install the Tailscale app from tailscale.com/download, with `brew install --cask
tailscale-app`, or from the Mac App Store. Allow its system extension when macOS
asks, and sign in. In the admin console, rename the machine `t3b-desktop` with **… →
Edit machine name**, and apply `tag:t3b-desktop` with **… → Edit tags**. On the DNS
page, check that MagicDNS is on. Key expiry on a laptop you use every day is fine
either way. An expired key only asks you to sign in again.

The app doesn't put a `tailscale` command on your `PATH`. To add one:

- **Standalone app.** In the app, choose **Settings → CLI integration → Show me how
  → Install Now**, and enter your admin password. This installs
  `/usr/local/bin/tailscale`.
- **Mac App Store app.** Add
  `alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"` to
  `~/.zshrc`, and open a new Terminal window.

`tailscale status` lists this machine. Tailscale documents no log opt-out for its
app variants yet, so the desktop's client keeps uploading its diagnostic logs.

Once the host's SSH is on ([agent accounts](../accounts/agent-accounts.md)), check
the route from the desktop. `nc -z -G 5 t3b-host 22` must succeed. If it fails,
`tailscale status` shows the host's `100.x` address. If
`nc -z -G 5 <100.x address> 22` succeeds, only name resolution is wrong.

## Tailscale Serve on the host

Tailscale Serve lets a tailnet device reach a service that listens only on the
host's loopback. Two optional features use it, and only through their scripts:

| Feature | Serve mapping | Behind it |
|---|---|---|
| [Phone](../remote-access/phone.md) | HTTPS on the host's MagicDNS name, port 443 (8443 for a second account) | one agent account's server on `127.0.0.1:4773` |
| [Screen Sharing](../remote-access/screen-sharing.md) | TCP 5900 on the host's tailnet addresses | `screensharingd` on `localhost:15900`, or the parking port 15901 while it's off |

- Your admin account configures Serve through tailscaled's LocalAPI, which accepts
  writes only from root. Agent accounts get no Tailscale rights.
- Each change is atomic. The script reads the configuration with its ETag, changes
  only its own mapping, and writes it back with `If-Match`. If anyone else wrote in
  between, tailscaled refuses the write. After writing, the script reads the
  configuration back to confirm the change.
- The scripts refuse a node with Funnel on, and they never replace another mapping.
  They also refuse to map anything while IP forwarding or the host model would let
  your local network reach Serve's listeners ([host](../install/host.md#network-settings-the-tailnet-relies-on)).
- `tailscale serve status` shows the mappings. Serve rules you make by hand on these
  ports block the scripts until you remove them.

The policy decides which devices can reach each mapping. Serve itself does no
filtering.

## Tailnet Lock (optional)

With Tailnet Lock on, every new device needs a signature from one of your signing
nodes. So a compromised Tailscale account or coordination server can't add a device.
The cost is a signing step for every new device, the phone included, and care when
you rebuild a signing node. Turn it on once both machines are set up.

1. On each machine, `tailscale lock status` shows its Tailnet Lock key. In the app,
   **Settings → Tailnet Lock** shows it too.
2. In **admin console → Settings → Device management → Tailnet Lock**, choose at
   least two machines as signing nodes. Copy the `tailscale lock init` command it
   gives you.
3. Run that command on one signing node. It prints ten disablement secrets, shown
   only once. Store them in your password manager, not only on these machines.
   Without a secret or a surviving signer, a locked tailnet can't be recovered.
4. Check that `tailscale lock status` on both machines says Tailnet Lock is enabled,
   and that `nc -z -G 5 t3b-host 22` still succeeds from the desktop.

**Rebuilding a signing node.** After the rebuilt machine joins, sign it from the
other node. Use the `tailscale lock sign nodekey:…` command that `tailscale lock
status` prints on the new machine. Make the new machine a signing node and remove the
old one's key, as Tailscale's Tailnet Lock docs describe. Only then rebuild the other
node. A lost or compromised signing node needs a different procedure. Follow
Tailscale's procedure for revoking a compromised signing node
(`tailscale lock revoke-keys`), which also invalidates what that node signed.

## What this doesn't protect

- Without Tailnet Lock, the coordination server could add a device to your tailnet.
- The policy doesn't apply to your local network. The host's SSH listens there too.
  [Agent accounts](../accounts/agent-accounts.md#what-the-source-filter-does-and-doesnt-do)
  describes what limits it.
