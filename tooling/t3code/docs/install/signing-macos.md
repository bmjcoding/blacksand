# Code signing and Keychain prompts

> **Applies to:** macOS, every role. Linux needs no signing, because its keyrings
> don't tie access to an app's signature.

Blacksand T3 keeps its encryption key in your Keychain, as the item "blacksand Safe
Storage". macOS lets the app read it without asking only when both of these match
what you approved:

- **The app's code requirement.** This stays the same for any build signed with the
  same certificate.
- **Its partition.** For an Apple-issued certificate, this is your team ID, which
  stays the same across builds. For any other certificate, it's the build's exact
  hash, so macOS asks again after every update.

So blacksand-t3 signs its builds with an Apple Development certificate. It's free
with any Apple Account. Only the first Mac needs Xcode. Signing never contacts Apple,
because it requests no timestamp.

## Set it up

1. In Xcode, open **Settings → Accounts** and add your Apple Account. Select
   "(Personal Team)", then choose **Manage Certificates → + → Apple Development**.
2. Run `blacksand t3 signing adopt --vault Personal`. It exports the certificate,
   which macOS asks you to allow, and adds Apple's intermediate certificate. It
   stores both in 1Password as the item "Blacksand T3 code signing", in the vault
   that `--vault` names. It replaces any existing item. It also installs both
   certificates into `state/signing.keychain-db`. That keychain is separate from
   your login keychain. Its random password is in `state/signing.keychain-pass`
   (mode 600).
3. On other Macs, `install.sh` fetches the certificate from 1Password. So does
   `blacksand t3 signing import --vault Personal`.
4. After the first build signed with it, click **Always Allow** on both prompts, one
   for the app and one for its helper. You do this once per Mac.

`install.sh` does this for you on each Mac. It imports the certificate if 1Password
has it. If not, it adopts an Apple Development certificate from your login keychain
if there's one. Otherwise, it creates a self-signed fallback. It reads the vault
from `BLACKSAND_T3_VAULT`, which defaults to `Personal`, and passes it on as
`--vault`. Without `--vault`, `signing adopt`, `import` and `init` name no vault,
and the 1Password CLI picks your built-in vault.

## Renewal

The certificate expires after a year. Renew it in Xcode and run `signing adopt
--vault Personal` again. Then run `blacksand t3 signing import --vault Personal` on
every other Mac, in the account that installed blacksand-t3 there. Adopting on one
Mac doesn't update another Mac's keychain. `blacksand t3 signing status` shows the
identity and its hash on each Mac.

## The self-signed fallback

`signing init` creates a self-signed certificate. It works, but Keychain asks again
after every update. `blacksand t3 status` then says `(self-signed: Keychain prompts
after each update)`. Trusting that certificate asks for your password in a dialog.
So run `signing init` in Terminal at the Mac, and do the same for `install.sh`,
which may run it. Over SSH, it fails with "The authorization was denied since no
user interaction was possible".
