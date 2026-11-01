# Code signing and Keychain prompts

> **Applies to:** macOS, every role. Linux needs no signing: its keyrings don't tie
> access to an app's signature.

Blacksand T3 keeps its encryption key ("blacksand Safe Storage") in your Keychain.
macOS lets the app read it without asking only when both of these match what you
approved:

- **The app's code requirement.** This stays the same for any build signed with the
  same certificate.
- **Its partition.** For an Apple-issued certificate, this is your team ID, which
  stays the same across builds. For anything else, it's that build's exact hash, so
  every update asks again.

So builds are signed with an **Apple Development certificate**. It's free with any
Apple Account, and only the first Mac needs Xcode. Signing never contacts Apple,
because no timestamp is requested.

## Set it up

1. In Xcode: **Settings → Accounts →** add your Apple Account → select "(Personal
   Team)" → **Manage Certificates → + → Apple Development**.
2. Run `blacksand t3 signing adopt --vault Personal`. It exports the certificate
   (macOS asks you to allow that) and adds Apple's intermediate certificate. It
   stores both in 1Password as the item "Blacksand T3 code signing", in the vault
   `--vault` names, replacing an existing item. It also installs them into
   `state/signing.keychain-db`. That keychain is separate from your login keychain;
   its random password is in `state/signing.keychain-pass` (mode 600).
3. On other Macs, `install.sh` (or `blacksand t3 signing import --vault
   Personal`) fetches it from 1Password.
4. After the first build signed with it, click **Always Allow** on both prompts, one
   for the app and one for its helper. That's once per Mac.

`install.sh` does this for you on each Mac. It imports the certificate if 1Password
has it, adopts an Apple Development certificate from your login keychain if there's
one, and otherwise creates a self-signed fallback. It reads the vault from
`BLACKSAND_T3_VAULT` (default `Personal`) and passes it on as `--vault`. Without
`--vault`, `signing adopt`, `import` and `init` name no vault, and the 1Password CLI
picks your built-in vault.

## Renewal

The certificate expires after a year. Renew it in Xcode and run `signing adopt
--vault Personal` again. Then run `blacksand t3 signing import --vault Personal`
on every other Mac, in its installing account: adopting on one Mac doesn't update
another Mac's keychain. `blacksand t3 signing status` shows the identity and its
hash on each.

## The self-signed fallback

`signing init` creates a self-signed certificate. It works, but Keychain asks after
every update, and `blacksand t3 status` says `(self-signed: Keychain prompts after
each update)`. Trusting that certificate asks for your password in a dialog, so run
it (and `install.sh`, which may run it) in Terminal at the Mac. Over SSH it fails
with "The authorization was denied since no user interaction was possible".
