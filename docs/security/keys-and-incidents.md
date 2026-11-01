# Keys, tokens and incident playbooks

> **Applies to:** the repository's maintainer, and every machine's owner. macOS
> details where noted.

## Keys and tokens

| Secret | What it can do | Where it lives | Rotation |
|---|---|---|---|
| **Owner SSH signing key** | sign any commit every machine takes: the root of trust | your SSH agent or hardware key; its public half in `.allowed_signers` | add the new key in a commit the old key signs; sign the next commit with the new key, removing the old one ([below](#rotating-the-owner-key)) |
| **Evaluator key** (`t3blackout-evaluator`) | sign `pin.json`-only, forward moves to real upstream releases, which machines re-check | the `T3BLACKOUT_EVALUATOR_SIGNING_KEY` repository Actions secret; its public half in `.allowed_signers` | new key pair; replace the secret; replace its line in `.allowed_signers` in an owner-signed commit |
| **SSH key agent accounts accept** | log in to every agent account | your SSH agent; its public half in root's `/etc/ssh/t3blackout/authorized_keys/<account>` on each machine | rerun `sudo packages/t3/scripts/add-agent-account.sh <account> --key <new.pub>` for every account; the file is rewritten |
| **Claude Code token** (`claude setup-token`) | use your Claude subscription from that agent account | `~/.t3blackout/server.env` in the agent account (owner only) | yearly: `claude setup-token`, then `/usr/local/libexec/t3blackout/set-claude-token`; switch the environment off and on; revoke the old token |
| **Codex login** | use your OpenAI account from that agent account | `~/.codex/auth.json` in the agent account | `codex logout`, `codex login` |
| **GitHub CLI login** (yours) | push; with `workflow` scope, change workflows (and so read the evaluator key) | your account only, never an agent account | revoke at GitHub → Settings → Applications when you rebuild a machine |
| **`state/github-token`** (optional) | nothing: a fine-grained token with no permissions, only for the advisory API's rate limit | the clone's `state/`, mode 600 | replace the file |
| **Apple Development certificate** (macOS) | sign apps that your Keychain treats as T3 Blackout | 1Password item "T3 Blackout code signing"; `state/signing.keychain-db` on each Mac | yearly ([signing](../install/signing-macos.md#renewal)) |
| **Tailscale node keys** | be a device in your tailnet | each machine; the host's has key expiry disabled | remove the device in the admin console and re-join |
| **Tailnet Lock keys and disablement secrets** | sign devices in; turn the lock off | each signing node; secrets in your password manager | `tailscale lock revoke-keys` ([Tailscale](../networking/tailscale.md#tailnet-lock-optional)) |
| **Phone sessions** | act as that agent account's server | the paired phone | revoke in the desktop app: the environment → **Settings → Sharing & access → Authorized clients** |
| **Admin passwords, FileVault recovery keys** | everything on that Mac | your password manager | change in System Settings |

Rules that apply to all of them:

- No GitHub token with `workflow` scope on an agent account. Stolen GitHub CLI tokens
  built LiteLLM's malicious release, and GhostAction used stolen tokens to push
  workflows that read repository secrets. Your own account may keep `workflow` scope
  (not `delete_repo`); rotate it when you rebuild a machine.
- Secrets stay out of command arguments and logs. `set-claude-token` reads a hidden
  prompt and stores an owner-only file; the server exports its Claude token to the
  processes that need it. The advisory token uses one-shot file handoffs. CI supplies
  credentials through step environment variables. Code running as the receiving
  account can read its credentials.

### Rotating the owner key

Machines read `.allowed_signers` from each commit's first parent:

1. Commit A, signed with the **old** key, adds the new key's line.
2. Commit B, signed with the **new** key, removes the old key's line.
3. Push both. Every machine takes A (signed by a key A's parent lists), then B
   (signed by a key B's parent, A, lists). After B, nothing the old key signs is
   taken.

Update your GitHub account's signing keys too, so commits show as verified there.
That's display only; machines don't use it.

## Playbooks

### The evaluator key leaked

What it can do: pin a real, newer upstream release whose new dependencies have aged,
or pass the machines' own fast lane. Every machine still checks the tag against
upstream, re-derives the gates, and builds, scans and smoke-tests the release.

1. Generate a new key pair (`ssh-keygen -t ed25519 -C t3blackout-evaluator -f
   <scratch path>`), and replace the `T3BLACKOUT_EVALUATOR_SIGNING_KEY` secret
   (**Settings → Secrets and variables → Actions**). Delete the private key file.
2. In an owner-signed commit, replace the `t3blackout-evaluator` line in
   `.allowed_signers` with the new public key. From the next commit on, the old key
   signs nothing machines take.
3. Review the `Pin … to …` commits since the leak could have happened. If a pin looks
   wrong, sign a commit that sets `pin.json` to a release you trust; an owner pin
   replaces whatever the evaluator pinned, and machines build it, up or down. An
   evaluator commit that breaks the commit-shape rules blocks later commits too: follow
   [refused-history recovery](../updates/self-update.md#limits) (temporarily allow the
   force-push, remove the refused history, restore the ruleset, then check each
   machine's trusted history before restarting updates).
4. Find how it leaked. Check recent workflow changes and runs, and who had push
   access or `workflow`-scope tokens.

### The owner key leaked

This is the root of trust. Someone holding it, who can also push to `main`, can ship
code every machine runs at its next update.

1. **Stop machines taking new commits.** Self-update runs whenever `update` or
   `poll` does: the scheduled job (and a host's update requests), the update button,
   **Update everything**, or by hand. On each machine, run `packages/t3/bin/t3blackout
   unschedule`, and use none of the others.
2. **Secure the GitHub account:** change its password, revoke tokens, check its SSH
   and signing keys, sessions and deploy keys. The ruleset already blocks force-push
   and deletion.
3. **Review `main`.** Any commit since the leak, signed by the old key, is suspect.
4. **Rotate** as above. Commit A must be signed by the old key, because that's what
   machines trust; push it before anyone else can. If a hostile commit already landed,
   revert it in owner-signed commits (history can't be rewritten on `main`). If the
   attacker changed the trusted signers, machines refuse an ordinary revert: repair
   `main`'s history in a controlled way, restore its protections, and set each machine
   up again from a reviewed commit whose full SHA you checked independently.
5. **Machines that may have taken a hostile commit:** treat them as compromised. A
   commit runs as the installing account at the next update. Rebuild from a fresh
   clone at a reviewed commit ([cloning](../install/clone.md)).
6. Reschedule (`packages/t3/bin/t3blackout schedule`) once `main` is clean.

### A machine was lost or stolen

FileVault protects the encrypted volume until it's unlocked at boot. A screen lock
restricts interactive access but doesn't relock the mounted volume, and running
processes keep access. Revoke credentials promptly even if the stolen Mac was
screen-locked.

1. Remove it from your tailnet (**admin console → Machines → … → Remove**). With
   Tailnet Lock, if it was a signing node, run `tailscale lock revoke-keys` from
   another signing node.
2. Revoke the GitHub CLI login and any tokens it held. If it had the owner signing
   key in a file (not a hardware key or a synced agent you can lock), follow
   [the owner key leaked](#the-owner-key-leaked).
3. Revoke its provider tokens (Claude, Codex) and its phone sessions.
4. If it held the SSH key agent accounts accept, rotate it on every remaining machine.
5. If it was a desktop with an `--allow-from` entry on the host, rerun
   `add-agent-account.sh` with the replacement's addresses, or with `--tailnet-only`.
6. Lock it or erase it remotely through Find My, if it's enrolled.

### An upstream release or npm package is compromised

The 3-day age gate is there for this: it gives the registry and security researchers
time to find and pull a hijacked version before any machine installs it. It doesn't
guarantee they will, so the alert job keeps checking what's already pinned.

1. **Stop update activity if the bad version may be pinned:** run `packages/t3/bin/t3blackout
   unschedule` on each machine, and don't run `update` or `poll`, press the update
   button or **Update everything** until the pin is clean. Unscheduling alone doesn't
   disable those.
2. **Check what's pinned.** `pin.json`, and the release's lockfile at the pinned
   commit. The alert job opens a `[security]` issue for a malicious-package
   advisory, once OSV or GitHub's database lists it.
3. **Pin away from it.** For a bad upstream release, sign a commit that sets
   `pin.json` to the last good release; machines build it even though it's older. For
   a bad dependency that upstream still uses, add a security override to a fixed
   version ([fast lane](../updates/fast-lane.md#security-overrides)), or hold the pin
   where it is.
4. **A machine that installed it:** run `~/.t3blackout/bin/t3blackout rollback` to go
   back one build. Then treat that machine's account (and the build account, for a
   malicious install script) as exposed: rotate the tokens it could read.
5. Reschedule once a clean pin is on `main`.

### A vulnerability report arrives

Reports come through GitHub's private vulnerability reporting ([SECURITY.md](../../SECURITY.md)).

1. Acknowledge within 7 days.
2. Reproduce it on the current `main`. Decide severity by what an attacker needs
   beforehand, against the [threat model](threat-model.md).
3. Fix it in a private fork from the advisory, with a test that fails without the
   fix. Land it as an owner-signed commit.
4. Online machines take the fix at their next scheduled check, once it verifies and builds. Publish the advisory once it's on `main`,
   crediting the reporter if they want that.
5. If it's upstream's bug, not T3 Blackout's, help the reporter take it to upstream.
