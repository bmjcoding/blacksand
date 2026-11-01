# Before you wipe a machine you're rebuilding

> **Applies to:** every role, macOS and Linux. Skip this for a first install.

- **Your way back into your password manager.** Before wiping, check that you can
  sign in to it without this machine: from another signed-in device, or with its
  recovery kit and account password. Know where the second factors and recovery
  codes are for GitHub, your Apple Account and your Tailscale sign-in provider.
- **Back up what isn't pushed anywhere.** Each server keeps its threads in its own
  account's `~/.t3blackout`, tied to that server's identity
  (`userdata/environment-id`). Back up every account whose history you want: your own
  account for the desktop's Local environment, and each agent account for its SSH
  environment. Do it with the app quit and the agent servers stopped (switch their
  environments off). Restore each into the same kind of account it came from. Back
  up your dotfiles too (`~/.gitconfig`, `~/.ssh/config`, `~/.zprofile`, provider
  settings).
- **Record what to trust.** After your last push, write down somewhere off these
  machines the full `git rev-parse HEAD` of every repository you'll clone and run
  scripts from, and your commit-signing key's fingerprint. A fresh clone of a `main`
  that has moved runs whatever is there; [cloning](../install/clone.md) puts the new
  clone at exactly the recorded commit.
- **The signing certificate (macOS).** If `bin/t3blackout status` shows `signing:`
  with `(self-signed: …)` or `ad-hoc`, create the Apple Development certificate now
  and run `bin/t3blackout signing adopt --vault Personal`
  ([signing](../install/signing-macos.md)). The rebuilt machines then import it.
- **Tailnet Lock.** If it's on and this machine is a signing node, hold a
  disablement secret somewhere that isn't on these machines. Or keep another signing
  node running and rebuild one signing node at a time
  ([Tailnet Lock](../networking/tailscale.md#tailnet-lock-optional)).
- **macOS version.** Erase All Content and Settings keeps the installed macOS.
  Update macOS before erasing, so the fresh install doesn't start behind.
- **Tokens.** Revoke the old machine's GitHub CLI login after your last push from it.
  Revoke its provider tokens (`claude setup-token`, Codex) once the new machine is
  signed in ([keys and incidents](../security/keys-and-incidents.md)).
- **Host keys change.** A rebuilt host has new SSH host keys. Trust the new ones as
  [connecting](../accounts/connect.md#trust-the-hosts-key) describes.
