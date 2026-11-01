# Self-update and commit trust

> **Applies to:** every role, macOS and Linux. Code: `packages/t3/lib/selfupdate.mjs`,
> `packages/t3/lib/git.mjs`, `packages/t3/lib/pin.mjs`. Tests: `packages/t3/test/self-update.deep.test.mjs`,
> `packages/t3/test/commit-trust.deep.test.mjs`, `packages/t3/test/pin-trust.deep.test.mjs`, `packages/t3/test/git-isolation.deep.test.mjs`.

Before building, every update fast-forwards the clone to origin's `main`, under the
update lock. That's how a rule fix pushed from one machine reaches the others,
without letting someone who gets into the GitHub account push code that every machine
runs.

## Which commits are taken

Every new commit, side branches included, must carry exactly one SSH signature from a
principal listed in `.allowed_signers` **as that commit's first parent has it**,
never as the commit itself would have it.

- So only a commit the owner signs changes who may sign, and only from the commit
  after it. A key it removes signs nothing later, even in the same update. A key it
  adds can sign the next commit.
- A commit with no parent (another history merged in) is refused.
- OpenPGP and X.509 signatures are refused outright. git would check those against
  whatever keyring the machine has, not against the list.
- It reads the fetched commit once, and fast-forwards to exactly that commit. Another
  fetch can't swap in commits nobody verified.
- Unsigned or rewritten history is refused, with a notification.

`.allowed_signers` lists two principals: the owner's SSH commit-signing key, and the
evaluator's (`t3blackout-evaluator`), held as a GitHub Actions secret
([keys](../security/keys-and-incidents.md)).

## What an evaluator commit may do

An evaluator-signed commit is accepted only if it:

- has one parent, and changes `pin.json` and nothing else;
- follows an existing pin. It can't write the first pin, or a channel's first pin;
- leaves a valid pin of canonical release tags, and moves no channel back;
- approves device tools or their lockfiles only alongside a forward move.

Then the machine works out the gates again itself, against the pin the update rests
on along `main`'s first parents. That's the one this clone already trusts, or a later
one the owner signed. It checks that:

- each channel it moves names the commit its tag points at upstream (`git
  ls-remote`, annotated tags resolved);
- every device tool it approves is pinned by the release it moves to, and passes
  review here, with its reviewed lockfile and dependency closure
  ([device tools](../building/device-tools.md));
- every dependency version the new release adds over the trusted release is at least
  3 days old, keeps its bytes and has the registry's integrity. The exception is the
  [security fast lane](fast-lane.md), worked out from the trusted release's own
  lockfile, the owner's overrides, OSV and npm.

The trusted release is fetched by its commit, not its tag, so upstream moving or
deleting that old tag later doesn't hold anything. Only the releases being moved to
are checked by tag.

An evaluator commit that breaks a shape rule (a merge, a change outside `pin.json`,
an invalid or backward pin, a first pin, approvals without a forward move) is refused
outright. Self-update stays refused until that commit is no longer on `main`.

## Held, skipped, refused

- **Held:** a dependency is too young, or the clock is ahead. `state/t3blackout.log`
  says "self-update held" and names it. There's no notification. The update continues
  on the pin this clone already has, and the next run tries again. Nothing later on
  `main`, owner commits included, is taken until it has aged, unless the owner
  replaces the pin.
- **Skipped:** something wasn't reachable. Checking evaluator commits needs
  github.com and the npm registry; the fast lane also needs OSV.dev and
  api.github.com, and a young Electron needs Electron's and Node.js's release lists.
  Without github.com, npm or those lists, self-update skips that run. Without an
  advisory source, a young dependency is held rather than waived.
- **Refused:** a commit isn't signed by a listed key, or an evaluator commit breaks a
  shape rule. You get a notification, and the log names the commit.

**The clock.** Ages are measured by the machine's clock. Before an age is relied on,
that clock is checked against the npm registry's (the `Date` header of its HTTPS
answer). More than 10 minutes ahead holds the update ("this Mac's clock is ahead; turn
on Set time automatically"; on Linux, network time).

## The owner can always override the evaluator

A later commit the owner signs on `main`'s first-parent line, which changes `pin.json`
over its own first parent, vouches for the evaluator commits before it. So it
unblocks any pin that's held or refused by those gates. A merge that takes another
branch's pin counts. An owner pin on a side branch that's merged in vouches for
nothing on `main`: if the merge keeps `main`'s evaluator pin, that pin still goes
through the gates. The pin is authoritative up or down, so an owner commit can also
move every machine back to an older release.

## A fresh clone

A pin that self-update didn't bring gets the same checks before `update` builds or
installs from it (`verifyHead`). That covers a fresh clone, whose evaluator commits
came with the clone, and a pin pulled by hand. Trust comes from the history, never from
HEAD. Starting from the last commit verified on this machine, or else from the
clone's first commit (which the owner must have signed, by its own
`.allowed_signers`), every commit up to HEAD is taken by the same code and the same
rule as self-update.

- The first time, that means every commit in the history: about 13 ms each on a
  recent Apple-silicon Mac. Later runs start from the record.
- The newest commit the owner signed that sets `pin.json` is trusted as it stands.
  Past it, the pin HEAD builds must pass the gates above.
- A shallow or incomplete clone is refused ("make a full clone (git fetch
  --unshallow)").
- What passes is recorded in the clone's git directory, with the time. It's checked
  again if the clock later reads earlier than that.
- Until it passes, `update` builds nothing and says why. On a first install,
  `install.sh` stops there ([cloning](../install/clone.md#what-the-first-run-checks)).
- An explicit `--ref` is your choice, and isn't checked.

## Fetching

- origin must be one github.com repository URL (`https://github.com/…`,
  `git@github.com:…` or `ssh://git@github.com/…`). Whatever its form, it's fetched
  over HTTPS, without credentials, so it never waits on an SSH-agent prompt.
  Anything else, an SSH host alias included, makes self-update skip every run.
- The URL is read as the clone's own `.git/config` writes it, so no `insteadOf`
  rule, global, local or in the environment, can change which repository is fetched.
- Every git call against github.com, for this repository or upstream, goes through
  `packages/t3/lib/git.mjs`:
  - HTTPS only (`GIT_ALLOW_PROTOCOL`, which a repository's own `protocol.*.allow`
    can't widen);
  - the machine's global and system git configuration ignored (rewrites, credential
    helpers, `core.sshCommand`, proxies, `includeIf`), and every `GIT_*` variable
    dropped;
  - nothing that can prompt;
  - a deadline on each call: listing 1 minute, reading the mirror 5, fetching 15,
    cloning 30.
- The clone's own `.git/config` can't be switched off the same way, so it's checked
  before each fetch. It must not set URL rewrites, `http.*`, `credential.*`, proxies,
  transport programs (`core.sshCommand`, `remote.*.uploadpack`, …),
  `protocol.*.allow` or a partial clone. If it does, self-update is skipped every
  run, and the log names the key ([troubleshooting](../troubleshooting.md#self-update)).
- The upstream mirror belongs to the build account. Only that account fetches into it
  or reads file contents from it. Every other read of the mirror (tags, versions,
  commit titles) runs with lazy fetching off (`git --no-lazy-fetch`), so a mirror the
  build account controls can't make your account fetch or start a transport program.
  Its `origin` must be exactly upstream, and its only remote.

## Limits

- **A leaked evaluator key** can at most pin a real, newer upstream release whose new
  dependencies have aged, or are accepted by the machine's own fast lane. For
  Electron, that includes any same-major release that changes Chromium, however new.
  Every machine still strips, typechecks, scans and smoke-tests it.
- **A refused commit stops updates.** Someone who can push to `main` can push a
  commit machines refuse: unsigned, or an evaluator commit that breaks a shape rule.
  Machines keep building the pin they have and notify "self-update refused", but take
  nothing newer until that commit is off `main`. A later owner commit doesn't help,
  because every commit must pass. Removing it takes a force-push, with the ruleset's
  block lifted for that push.
- **A leaked owner key** can sign anything. It's the root of trust
  ([keys and incidents](../security/keys-and-incidents.md#the-owner-key-leaked)).
- **Self-update needs GitHub to still serve the trusted pin's commit,** which it
  fetches by commit id. If upstream's history ever loses it, self-update skips every
  run that brings an evaluator pin, until the owner signs a commit that rewrites
  `pin.json`.
- **The update lock's handoff** to the rerun after a self-update is on fd 3, named by
  `T3BLACKOUT_LOCK_FD`. On macOS, the rerun can check only that the descriptor it's
  handed is the lock file and that the lock is held, not that this descriptor holds
  it; only a process of yours could forge that. On Linux, if the rerun crashes, a
  process it started that inherited the descriptor holds the lock until it exits.
