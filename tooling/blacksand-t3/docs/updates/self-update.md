# Self-update and commit trust

> **Applies to:** every role, macOS and Linux. Code:
> `tooling/blacksand-t3/lib/selfupdate.mjs`, `tooling/blacksand-t3/lib/git.mjs`,
> `tooling/blacksand-t3/lib/pin.mjs`. Tests:
> `tooling/blacksand-t3/test/self-update.deep.test.mjs`,
> `tooling/blacksand-t3/test/commit-trust.deep.test.mjs`,
> `tooling/blacksand-t3/test/pin-trust.deep.test.mjs`,
> `tooling/blacksand-t3/test/git-isolation.deep.test.mjs`.

Before it builds, every update fast-forwards the clone to origin's `main` while holding
the update lock. That's how a rule fix pushed from one machine reaches the others.
Signature checks stop someone who gets into the GitHub account from pushing code that
every machine runs.

## Shared verifier and records

Both the production updater and direct pre-build `verifyHead` call
`src/trust/check.ts`. T3's pin gates live in `lib/pin-gates.mjs` and are adapted
by `lib/trust-gates.mjs`. There is no second active history verifier.

Current checks use `.git/blacksand-trust-v1-verified`. The old
`t3blackout-verified` file is never read, even for an identical HEAD, an offline
update or a timestamp in the past or future. Without a current record on the
first-parent chain, verification starts from the root. An unverified clone's
HEAD cannot supply a trusted pin basis. A HEAD changed during verification is
refused and not recorded. Isolated build snapshots preserve the component and
`src/trust` directory layout so the same runtime imports work in the worker.

The layout-aware verifier retains root, `packages/t3`, `tooling/t3code`, and
`tooling/blacksand-t3` histories. It reads each commit against its first parent's
pin path and signer list, refuses multiple component folders, and permits only an
owner-signed folder move. Old commits keep their original bytes and paths.

## Which commits are taken

Every new commit, side branches included, must carry exactly one SSH signature. The
signer must be a principal listed in `.allowed_signers` **as that commit's first
parent has the file**, never as the commit itself would have it.

- So only a commit the owner signs can change who may sign, and the change applies
  from the next commit on. A key that a commit removes can't sign any later commit,
  even in the same update. A key that a commit adds can sign the next commit.
- Self-update refuses a commit with no parent, which is how another history gets
  merged in.
- It refuses OpenPGP and X.509 signatures outright. git would check those against
  whatever keyring the machine has, not against the list.
- It reads the fetched commit once, and fast-forwards to exactly that commit. Another
  fetch can't swap in commits that nobody verified.
- It refuses unsigned or rewritten history, and sends a notification.

`.allowed_signers` lists two principals. One is the owner's SSH commit-signing key.
The other is the evaluator's key (`blacksand-evaluator`), which is held as a GitHub
Actions secret ([keys](../security/keys-and-incidents.md)).

An owner-signed commit may rename the historical `t3blackout-evaluator` label to
`blacksand-evaluator`. Both exact labels stay pin-only in both active verifiers;
the first parent's signer list determines the role of the migration commit itself.
The owner label is now `blacksand-owner`; its authority still comes from the key
in the first parent's list.

## What an evaluator commit may do

Self-update accepts an evaluator-signed commit only if the commit meets all of these
conditions:

- It has one parent, and it changes `pin.json` and nothing else.
- It follows an existing pin. It can't write the first pin, or a channel's first pin.
- It leaves a valid pin of canonical release tags, and moves no channel back.
- It approves device tools or their lockfiles only alongside a forward move.

The machine then works out the gates again itself. It checks against the pin that the
update builds on, found along `main`'s first parents. That pin is the one this clone
already trusts, or a later one the owner signed. The machine checks the following:

- Each channel the commit moves names the commit that its tag points at upstream. The
  machine asks with `git ls-remote` and resolves annotated tags.
- The release the commit moves to pins every device tool the commit approves. Each of
  those tools passes review here, with its reviewed lockfile and dependency closure
  ([device tools](../building/device-tools.md)).
- Every dependency version that the new release adds over the trusted release is at
  least 3 days old, keeps its bytes and has the registry's integrity. The exception is
  the [security fast lane](fast-lane.md). The machine works out the fast lane from the
  trusted release's own lockfile, the owner's overrides, OSV and npm.

The machine fetches the trusted release by its commit, not its tag. So if upstream
later moves or deletes that old tag, nothing is held up. The machine checks only the
releases being moved to by tag.

Self-update refuses outright an evaluator commit that breaks a shape rule. The shape
rules forbid a merge, a change outside `pin.json`, an invalid or backward pin, a first
pin, and approvals without a forward move. Self-update stays refused until that commit
is no longer on `main`.

## Held, skipped, refused

- **Held.** A dependency is too young, or the clock is ahead. `state/blacksand-t3.log`
  says "self-update held" and names the cause. There's no notification. The update
  continues on the pin this clone already has, and the next run tries again. The
  machine takes nothing later on `main`, owner commits included, until the dependency
  has aged, unless the owner replaces the pin.
- **Skipped.** Something wasn't reachable. Checking evaluator commits needs github.com
  and the npm registry. The fast lane also needs OSV.dev and api.github.com. A young
  Electron also needs the release lists of Electron and Node.js. Without github.com,
  npm or those lists, self-update skips that run. Without an advisory source, the
  machine holds a young dependency instead of waiving the wait.
- **Refused.** A commit isn't signed by a listed key, or an evaluator commit breaks a
  shape rule. You get a notification, and the log names the commit.

**The clock.** The machine measures ages by its own clock. Before it relies on an age,
it checks that clock against the npm registry's clock, read from the `Date` header of
the registry's HTTPS response. If the machine's clock is more than 10 minutes ahead,
the update is held. On a Mac, the message says "this Mac's clock is ahead; turn on Set
time automatically". On Linux, it asks you to turn on network time.

## The owner can always override the evaluator

An owner-signed commit can vouch for the evaluator commits before it. It must be later
on `main`'s first-parent line, and it must change `pin.json` relative to its own first
parent. That commit unblocks any pin that those gates hold or refuse. A merge that
takes another branch's pin counts. An owner pin on a side branch that is merged in
vouches for nothing on `main`. If the merge keeps `main`'s evaluator pin, that pin
still goes through the gates. The pin is authoritative in both directions, so an owner
commit can also move every machine back to an older release.

## A fresh clone

If self-update didn't bring a pin, `update` runs the same checks on it (`verifyHead`)
before it builds or installs from that pin. That covers a fresh clone, whose evaluator
commits came with the clone, and a pin pulled by hand. Trust comes from the history,
never from HEAD. The check starts from the last commit this machine verified. If there
is none, it starts from the clone's first commit, which the owner must have signed
according to that commit's own `.allowed_signers`. It then takes every commit up to
HEAD with the same code and the same rule as self-update.

- The first time, that means every commit in the history. Each takes about 13 ms on a
  recent Apple-silicon Mac. Later runs start from the record.
- The newest owner-signed commit that sets `pin.json` is trusted as it stands. Past
  that commit, the pin that HEAD builds must pass the gates above.
- `update` refuses a shallow or incomplete clone, with the message "make a full clone
  (git fetch --unshallow)".
- The machine records what passes in the clone's git directory, with the time. It
  checks again if the clock later reads earlier than that time.
- Until the check passes, `update` builds nothing and says why. On a first install,
  `install.sh` stops there ([cloning](../install/clone.md#what-the-first-run-checks)).
- An explicit `--ref` is your choice, and the check doesn't cover it.

## Fetching

- origin must be one github.com repository URL, in the form `https://github.com/…`,
  `git@github.com:…` or `ssh://git@github.com/…`. Whatever its form, self-update
  fetches it over HTTPS without credentials, so it never waits on an SSH-agent prompt.
  Any other origin, including an SSH host alias, makes self-update skip every run.
- Self-update reads the URL as the clone's own `.git/config` writes it. So no
  `insteadOf` rule, whether global, local or in the environment, can change which
  repository it fetches.
- Every git call against github.com, for this repository or upstream, goes through
  `tooling/blacksand-t3/lib/git.mjs`, which sets these limits:
  - HTTPS only, through `GIT_ALLOW_PROTOCOL`. A repository's own `protocol.*.allow`
    can't widen it.
  - git ignores the machine's global and system configuration, including rewrites,
    credential helpers, `core.sshCommand`, proxies and `includeIf`. `git.mjs` also
    drops every `GIT_*` variable.
  - Nothing can prompt.
  - Each call has a deadline: 1 minute for listing, 5 for reading the mirror, 15 for
    fetching and 30 for cloning.
- `git.mjs` can't switch off the clone's own `.git/config` the same way, so
  self-update checks that file before each fetch. The file must not set URL rewrites,
  `http.*`, `credential.*`, proxies, transport programs (`core.sshCommand`,
  `remote.*.uploadpack` and the like), `protocol.*.allow` or a partial clone. If it
  does, self-update skips every run, and the log names the key
  ([troubleshooting](../troubleshooting.md#self-update)).
- The upstream mirror belongs to the build account. Only that account fetches into the
  mirror or reads file contents from it. Every other read of the mirror, such as tags,
  versions and commit titles, runs with lazy fetching off (`git --no-lazy-fetch`). So a
  mirror that the build account controls can't make your account fetch or start a
  transport program. The mirror's `origin` must be exactly upstream, and must be its
  only remote.

## Limits

- **A leaked evaluator key can pin at most a real, newer upstream release.** That
  release's new dependencies must have aged, or the machine's own fast lane must accept
  them. For Electron, that includes any same-major release that changes Chromium,
  however new. Every machine still strips, typechecks, scans and smoke-tests the
  release.
- **A refused commit stops updates.** Someone who can push to `main` can push a commit
  that machines refuse, either unsigned or an evaluator commit that breaks a shape
  rule. Machines keep building the pin they have and notify "self-update refused". They
  take nothing newer until that commit is off `main`. A later owner commit doesn't
  help, because every commit must pass. Removing the commit takes a force-push, with
  the ruleset's block lifted for that push.
- **A leaked owner key can sign anything.** The owner key is the root of trust
  ([keys and incidents](../security/keys-and-incidents.md#the-owner-key-leaked)).
- **Self-update needs GitHub to keep serving the trusted pin's commit.** It fetches
  that commit by id. If upstream's history ever loses that commit, self-update skips
  every run that brings an evaluator pin. It does so until the owner signs a commit
  that rewrites `pin.json`.
- **The update lock passes to the rerun after a self-update on fd 3.**
  `BLACKSAND_T3_LOCK_FD` names that descriptor. On macOS, the rerun can check only that
  the descriptor it's handed is the lock file and that the lock is held. It can't check
  that this descriptor holds the lock. Only a process of yours could forge that. On
  Linux, if the rerun crashes, a process it started that inherited the descriptor holds
  the lock until that process exits.
