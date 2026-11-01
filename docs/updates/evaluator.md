# The CI evaluator and alerts

> **Applies to:** the repository's GitHub Actions. Code:
> `.github/workflows/evaluate.yml`, `packages/t3/lib/evaluate.mjs`, `packages/t3/lib/pincheck.mjs`,
> `packages/t3/ci/reconcile.mjs`. Tests: `packages/t3/test/pipeline-*.test.mjs`,
> `packages/t3/test/dependency-inventory.test.mjs`, `packages/t3/test/alerts-*.test.mjs`.

Every CI result is advisory. Each machine checks and builds a pin itself before
installing it ([self-update](self-update.md)).

## The three jobs (`evaluate.yml`, hourly)

The work is split so the signing key never shares a runner with upstream code.

| Job | Runs | Token and secrets | Output |
|---|---|---|---|
| `evaluate` | `packages/t3/bin/t3blackout evaluate` on each new upstream nightly release, newest first: builds and smoke-tests them | read-only `contents`, plus `actions: read` for the last run's stage records; no secrets | a proposed `pin.json`, a report, resolved lockfiles and stage records, uploaded as an artifact whatever happens |
| `commit` | on a fresh runner that runs no upstream or npm code: `packages/t3/bin/t3blackout pin-check --candidate` re-derives every gate it can from git, npm and the advisory sources, then signs and pushes the pin | `contents: write`; the evaluator key, only in the final sign-and-push step | an evaluator-signed commit changing `pin.json` |
| `alerts` | advisories against the pin actually on `main` | `contents: read`, `issues: write` | GitHub issues |

## What holds a release back

The evaluator pins the newest release that passes every gate. A release is held when
it:

- adds a dependency version published less than **3 days** ago
  (`T3BLACKOUT_MIN_AGE_DAYS`; a value that isn't a non-negative number stops the CLI
  rather than switching the gate off). Upstream's own code isn't held back, only new
  third-party packages, which is where a hijacked release does its damage. The
  [fast lane](fast-lane.md) waives the wait for vetted security fixes;
- resolves a dependency from anywhere but the npm registry or upstream's own
  checkout, unless that exact entry and its integrity are listed in
  `packages/t3/lib/known-resolutions.txt` (owner-signed; empty today). It's also held if it gives
  a version it already had a different tarball or integrity
  ([dependencies](../building/dependencies.md));
- pins a device tool version that hasn't passed review ([device tools](../building/device-tools.md));
- breaks a strict rule, names an unknown network host, fails to typecheck, leaks a
  forbidden endpoint, or makes any network call in the offline smoke test
  ([build pipeline](../building/pipeline.md)).

The `commit` job checks, before anything is signed:

- the pin is valid, only the evaluated channel moves, and only forward;
- each tag names its pinned commit upstream (`git ls-remote`);
- every newly approved device tool is pinned by that release, has a reviewed lockfile
  that checks out, and passes review. There's no lockfile for a tool the release
  doesn't pin;
- the dependency age gate and the same fast lane;
- the resolved lockfile fits upstream's own;
- the strip rules, applied to upstream's source as text, leave out what the evaluation
  said.

`evaluate --ref <tag>` evaluates one release by hand, for a hotfix worth taking now.
Another track needs a first pin in a commit the owner signs
(`packages/t3/bin/t3blackout evaluate --channel stable --baseline <tag> --write`, run locally).
Until then, every machine refuses it.

## Alerts

After the `commit` job, `alerts` checks the pin on `main` against the
[advisory sources](fast-lane.md#advisory-sources), plus Electron's embedded Node and
Chromium. It covers everything a build of that pin installs:

- **the lockfile the evaluate job resolved,** checked as the commit job checks it. If
  it's missing or doesn't check out, upstream's lockfile with the overrides applied
  stands in;
- **each device tool's frozen closure** from `pin.json`;
- **the staged production install,** from a stage record bound to the upstream
  commit, this repository's build code (every file under `packages/t3/lib/` and `packages/t3/bin/`) and the
  platform. A record counts only if it stages exactly what upstream's packager stages
  at that commit. The next hourly run reuses the last record if it passes the same
  check, and otherwise builds the pinned release again.

An evaluation that fails or times out still gets an advisory check, with what it
couldn't cover listed.

**Issues.** High, critical, unrated and malicious-package advisories open one issue
per package and channel, `[security] <package> (<channel>)`, labeled `security`.
GitHub emails and pushes it.

- The issue's text is redone from each complete check. It lists every advisory id
  naming the package, moderate and low ones included, each linked to the source that
  published it, with that record's own rating.
- **What changed is a comment, said once.** A high, critical or unrated id new to the
  issue, or a new rating for one, gets a numbered comment. It names what's new, and
  also what no longer alerts: what's rated lower now, and on a complete check, how
  many ids are no longer named. A lower rating on its own says nothing.
- **Nothing told is lost.** What the issue last announced is its record, kept in the
  latest comment's hidden marker. Before a comment is posted, what it's to say is
  kept in the issue's marker; if the comment doesn't go out, the next run says it,
  whatever that run's check can see. Numbering keeps a lost response from being
  mistaken for the comment before it.
- **Closing.** Once a check that covered everything finds nothing high, critical or
  unrated, the issue closes. It says "Fixed" if nothing names the package any more, or
  "No longer high or critical" if moderate or low ones still do (never "Fixed"). If a
  closed package alerts again, it's said again.
- Packages named only by moderate and low advisories are listed in one issue,
  `[security] Moderate and low advisories (<channel>)`, redone each hour and never
  commented on.
- A check that couldn't cover everything closes nothing, and leaves package issues'
  text as the last complete check left it. It still opens issues and says what's new.
  `[security] Advisory coverage incomplete (<channel>)` says what's missing.
- `Upstream <channel> releases held` says why every newer release is held. It closes
  only when the pin the `commit` job pushed is on `main`, or upstream has nothing
  newer. The evaluate job's exit code can open it, never close it, because that job
  ran upstream code.

The automation touches only issues its bot opened with its hidden marker. Notes you
add above or below its text are kept, whole. Where they leave no room within
GitHub's 65,536-character limit, the issue is left as it is and the run fails,
naming it. Text from outside (advisory ids, summaries, the evaluate job's report) is
put in code spans and blocks, so it can't mention anyone, link anywhere or format the
issue. One issue GitHub won't update doesn't hold up the others; the run still fails,
naming it.

## Checks on every change

- **`ci.yml`** (every push and pull request): the repo's tests; `bash -n`/`sh -n` and
  shellcheck on the scripts and on the SSH runner as the remote shell gets it;
  actionlint (downloaded and checked against a pinned SHA-256); every action pinned to
  a full commit SHA; `pin.json` and `packages/t3/lib/overrides.json` valid; `pin-check`; and the
  strip rules applied to the pinned commit.
- **`build.yml`** (changes under `packages/t3/bin/`, `packages/t3/lib/`, `packages/t3/test/stripped/` or to `pin.json`):
  builds each pinned channel the change affects with `check --build`, runs the tests
  in `packages/t3/test/stripped/` inside the stripped checkout, and syntax-checks the SSH runner
  as upstream renders it. Read-only token, no secrets. The evaluator's own pin commits
  don't start it, or `ci.yml`: they're pushed with the workflow's token, and GitHub
  starts no workflows for those pushes.

The jobs that build install `libsecret-1-dev` and `imagemagick` with apt (upstream's
Linux packager checks for them). They get pnpm through `install.sh`'s
`install_pnpm`, from tarballs pinned by digest, never through Corepack. They build as
the runner's user with `T3BLACKOUT_UNISOLATED_BUILD=1`, because CI has no build account.

## Limits

- Advisories a package's maintainers publish only in their own repository are read
  for the device tools alone. For every other package, an advisory counts once OSV or
  GitHub's database has it.
- A forged stage record that is consistent in every respect, but picks other versions
  inside the allowed ranges, passes. Only resolving again could tell, and the alert
  job doesn't run npm's resolver.
- The alert job checks the linux-x64 staged install CI builds. Macs install a darwin
  one, whose native packages differ, so those aren't checked for advisories. Each Mac
  still checks its own staged install when it builds.
- An issue's record keeps up to 1,000 announced ids. Past that, the rest are listed
  in the issue and logged, but a change among them isn't commented on (rather than
  commenting every hour).
- A package's first issue whose creation fails is opened by the next run that sees
  it. The failed run is red.
