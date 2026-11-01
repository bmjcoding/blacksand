# Cloning and checking the clone

> **Applies to:** every role, macOS and Linux.

## Where to clone

Any path works, except that on a host the clone must be outside `~/Documents`,
`~/Desktop` and `~/Downloads`. The host's updater is a LaunchDaemon, and macOS
privacy controls block daemons from those folders.

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/bmjcoding/t3blackout.git
cd t3blackout
```

That URL is this repository; use your fork's if you run one. Clone in full, never
with `--depth`. The first build checks the whole history and refuses a shallow
clone ("make a full clone (git fetch --unshallow)").

## Put it at the commit you trust

A fresh clone holds whatever `main` holds right now. Before you run any script from
it, put it at the full commit SHA you recorded from a machine you trust
([rebuilding](../getting-started/rebuilding.md)), or from another source you trust.
Don't judge a commit by its author, subject or changed files; anyone can write
those. In the fresh clone only (never a working development clone), run:

```sh
(
  set -euo pipefail
  read -r "T3B_RECORDED_HEAD?Paste the full recorded t3blackout HEAD: "
  [[ "$T3B_RECORDED_HEAD" =~ ^[0-9a-f]{40}$ ]]
  test -z "$(git status --porcelain)"
  git switch -C main "$T3B_RECORDED_HEAD"
  git rev-parse HEAD
)
```

That's zsh syntax (macOS). In bash, use `read -r -p "…" T3B_RECORDED_HEAD`. The
printed SHA must equal the recorded one. Stop on any error. From then on, the
updater verifies and takes newer signed commits itself
([self-update](../updates/self-update.md)).

## The clock

Dependency ages are measured by this machine's clock. Before an update relies on
an age, it checks the clock against the npm registry's (the `Date` header of its
HTTPS answer). A clock more than 10 minutes ahead holds the update. Keep **System
Settings → General → Date & Time → Set time automatically** on (macOS), or network
time on (Linux).

## What the first run checks

Before its first build, `install.sh` verifies the clone's history itself. It checks
every commit's signature, starting from the clone's first commit, and the gates of
every evaluator pin ([self-update](../updates/self-update.md#a-fresh-clone)). That
takes about 13 ms per commit on a recent Apple-silicon Mac, roughly two minutes per
10,000 commits. Later runs start from the recorded result. If it stops there,
nothing is built or scheduled, and it says which case it is:

- **held:** a dependency is under 3 days old, or the clock is ahead. Fix the clock,
  or wait until the named dependency is old enough. Then rerun
  `packages/t3/install.sh --role …`.
- **skipped:** npm, GitHub or upstream wasn't reachable. Rerun.
- **refused:** for a shallow clone, run `git fetch --unshallow` and rerun.
  Otherwise stop, and treat it like a clone that doesn't match what you recorded.

## Origin and pushing

Keep `origin` a github.com URL (`https://github.com/…`, `git@github.com:…` or
`ssh://git@github.com/…`). Self-update fetches only that repository, over HTTPS,
without logging in. An origin that's an SSH host alias (`git@github-work:…`) is
never fetched, so the machine never takes new commits or pins.

To push from a clone over SSH, set a push URL. You can use your SSH host alias in
place of `github.com`.

```sh
git remote set-url --push origin git@github.com:<owner>/t3blackout.git
```

Don't add `url.*.insteadOf`, `pushInsteadOf`, `http.*`, `credential.*`, proxy or
transport settings to the clone's own `.git/config`. Self-update refuses to fetch
while any are set ([self-update](../updates/self-update.md#fetching)). Rewrites in your
global `~/.gitconfig` are ignored, not refused.
