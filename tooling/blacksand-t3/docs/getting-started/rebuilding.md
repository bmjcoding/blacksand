# Before you wipe a machine you're rebuilding

> **Applies to:** every role, macOS and Linux. Skip this for a first install.

Moving from a legacy T3 Blackout install means rebuilding the machine. Blacksand
doesn't upgrade a legacy install in place. Its installer and setup scripts refuse to
run while one is present ([at the cutover](../security/keys-and-incidents.md#at-the-cutover)).

- **Your way back into your password manager.** Before wiping, check that you can
  sign in to it without this machine. Use another signed-in device, or its recovery
  kit and account password. Know where the second factors and recovery codes are for
  GitHub, your Apple Account and your Tailscale sign-in provider.
- **Back up what isn't pushed anywhere.** Each server keeps its threads in its own
  account's `~/.blacksand/t3`, tied to that server's identity
  (`userdata/environment-id`). Back up every account whose history you want. That
  means your own account for the desktop's Local environment, and each agent account
  for its SSH environment. Quit the app and stop the agent servers first, by
  switching their environments off. Restore each backup into the same kind of
  account it came from. Back up your dotfiles too (`~/.gitconfig`, `~/.ssh/config`,
  `~/.zprofile`, provider settings).
- **Record what to trust.** After your last push, write down two things somewhere
  off these machines. The first is the full `git rev-parse HEAD` of every repository
  you'll clone and run scripts from. The second is your commit-signing key's
  fingerprint. A fresh clone of a `main` that has moved runs whatever is there.
  [Cloning](../install/clone.md) puts the new clone at exactly the recorded commit.
- **The signing certificate (macOS).** If `blacksand t3 status` shows `signing:`
  with `(self-signed: …)` or `ad-hoc`, create the Apple Development certificate now.
  Then run `blacksand t3 signing adopt --vault Personal`
  ([signing](../install/signing-macos.md)). The rebuilt machines import it.
- **Tailnet Lock.** If it's on and this machine is a signing node, keep a
  disablement secret somewhere off these machines. Or keep another signing node
  running and rebuild one signing node at a time
  ([Tailnet Lock](../networking/tailscale.md#tailnet-lock-optional)).
- **macOS version.** Erase All Content and Settings keeps the installed macOS.
  Update macOS before erasing, so the fresh install doesn't start behind.
- **Tokens.** Revoke the old machine's GitHub CLI login after your last push from it.
  Revoke its provider tokens (`claude setup-token`, Codex) once the new machine is
  signed in ([keys and incidents](../security/keys-and-incidents.md)).
- **Host keys change.** A rebuilt host has new SSH host keys. Trust the new ones as
  [connecting](../accounts/connect.md#trust-the-hosts-key) describes.
