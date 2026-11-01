# Cloning and checking the clone

> **Applies to:** every role, macOS and Linux.

## Where to clone

Any path works, except that on a host the clone must be outside `~/Documents`,
`~/Desktop` and `~/Downloads`. The host's updater is a LaunchDaemon, and macOS
privacy controls block daemons from those folders.

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
```

That URL is this repository. Use your fork's URL if you run one. Clone in full,
never with `--depth`. The first build checks the whole history, and it refuses a
shallow clone with "make a full clone (git fetch --unshallow)".

## Put it at the commit you trust

A fresh clone is at whatever commit `main` points to when you clone it. Before you
run any script from it, put it at the full commit SHA you recorded from a machine you
trust ([rebuilding](../getting-started/rebuilding.md)), or from another source you
trust. Don't judge a commit by its author, subject or changed files, because anyone
can write those. Run this in the fresh clone only, never in a development clone you
work in:

```sh
(
  set -euo pipefail
  read -r "T3B_RECORDED_HEAD?Paste the full recorded blacksand HEAD: "
  [[ "$T3B_RECORDED_HEAD" =~ ^[0-9a-f]{40}$ ]]
  test -z "$(git status --porcelain)"
  git switch -C main "$T3B_RECORDED_HEAD"
  git rev-parse HEAD
)
```

That's zsh syntax, for macOS. In bash, use `read -r -p "…" T3B_RECORDED_HEAD`. The
printed SHA must equal the recorded one. Stop on any error. From then on, the
updater verifies newer signed commits and moves to them itself
([self-update](../updates/self-update.md)).

## The clock

blacksand-t3 measures dependency ages by this machine's clock. Before an update
relies on an age, it compares the clock with the `Date` header of an HTTPS response
from the npm registry. A clock more than 10 minutes ahead holds the update. On
macOS, keep **System Settings → General → Date & Time → Set time automatically** on.
On Linux, keep network time on.

## What the first run checks

Before its first build, `install.sh` verifies the clone's history itself. It checks
every commit's signature, starting from the clone's first commit. It also checks
the gates of every evaluator pin ([self-update](../updates/self-update.md#a-fresh-clone)).
That takes about 13 ms per commit on a recent Apple-silicon Mac, roughly two minutes
per 10,000 commits. Later runs start from the recorded result. If the check stops
the run, `install.sh` builds and schedules nothing, and it names one of these cases:

- `held` means a dependency is under 3 days old, or the clock is ahead. Fix the
  clock, or wait until the named dependency is old enough. Then rerun
  `tooling/t3code/install.sh --role …`.
- `skipped` means npm, GitHub or upstream wasn't reachable. Rerun.
- `refused` means the check found a problem. For a shallow clone, run
  `git fetch --unshallow` and rerun. Otherwise stop, and treat it like a clone that
  doesn't match what you recorded.

## Origin and pushing

Keep `origin` a github.com URL, in one of the forms `https://github.com/…`,
`git@github.com:…` or `ssh://git@github.com/…`. Self-update fetches only that
repository, over HTTPS, without logging in. It never fetches an origin that's an SSH
host alias, such as `git@github-work:…`. A machine with that kind of origin never
takes new commits or pins.

To push from a clone over SSH, set a push URL. You can use your SSH host alias in
place of `github.com`.

```sh
git remote set-url --push origin git@github.com:<owner>/blacksand.git
```

Don't add `url.*.insteadOf`, `pushInsteadOf`, `http.*`, `credential.*`, proxy or
transport settings to the clone's own `.git/config`. Self-update refuses to fetch
while any are set ([self-update](../updates/self-update.md#fetching)). It ignores
rewrites in your global `~/.gitconfig` rather than refusing them.
