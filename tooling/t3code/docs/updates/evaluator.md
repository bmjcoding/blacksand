# The CI evaluator and alerts

> **Applies to:** the repository's GitHub Actions. Code:
> `.github/workflows/evaluate.yml`, `tooling/t3code/lib/evaluate.mjs`,
> `tooling/t3code/lib/pincheck.mjs`, `tooling/t3code/ci/reconcile.mjs`. Tests:
> `tooling/t3code/test/pipeline-*.test.mjs`,
> `tooling/t3code/test/dependency-inventory.test.mjs`,
> `tooling/t3code/test/alerts-*.test.mjs`.

Every CI result is advisory. Each machine checks and builds a pin itself before it
installs that pin ([self-update](self-update.md)).

## The three jobs (`evaluate.yml`, hourly)

The workflow splits the work so that the signing key never shares a runner with
upstream code.

| Job | What it runs | Token and secrets | Output |
|---|---|---|---|
| `evaluate` | `blacksand t3 evaluate` on each new upstream nightly release, newest first. It builds and smoke-tests each one. | Read-only `contents`, and `actions: read` to fetch the last run's stage records. No secrets. | A proposed `pin.json`, a report, resolved lockfiles and stage records. The job uploads them as an artifact on every run, pass or fail. |
| `commit` | It starts on a fresh runner that runs no upstream or npm code. `blacksand t3 pin-check --candidate` re-derives every gate it can from git, npm and the advisory sources. The job then signs and pushes the pin. | `contents: write`. The evaluator key is available only in the final sign-and-push step. | An evaluator-signed commit that changes `pin.json`. |
| `alerts` | It checks advisories against the pin that is on `main`. | `contents: read` and `issues: write`. | GitHub issues. |

## What holds a release back

The evaluator pins the newest release that passes every gate. It holds back a
release that does any of the following:

- It adds a dependency version published less than 3 days ago.
  `BLACKSAND_T3_MIN_AGE_DAYS` sets the age. A value that isn't a non-negative number
  stops the CLI instead of switching the gate off. The gate holds back only new
  third-party packages, not upstream's own code, because new third-party packages are
  where a hijacked release does its damage. The [fast lane](fast-lane.md) waives the
  wait for vetted security fixes.
- It resolves a dependency from somewhere other than the npm registry or upstream's
  own checkout. The one exception is an exact entry and integrity listed in
  `tooling/t3code/lib/known-resolutions.txt`, a file the owner signs. That file is
  empty today ([dependencies](../building/dependencies.md)).
- It assigns a different tarball or integrity to a version upstream already had
  ([dependencies](../building/dependencies.md)).
- It pins a device tool version that hasn't passed review
  ([device tools](../building/device-tools.md)).
- It breaks a strict rule, names an unknown network host, fails to typecheck, leaks a
  forbidden endpoint, or makes any network call in the offline smoke test
  ([build pipeline](../building/pipeline.md)).

Before it signs anything, the `commit` job checks the following:

- The pin is valid. It moves only the evaluated channel, and only forward.
- Each tag points at its pinned commit upstream. The job asks with `git ls-remote`.
- The release pins every newly approved device tool. Each of those tools has a
  reviewed lockfile that checks out, and passes review. The pin holds no lockfile for
  a tool the release doesn't pin.
- The release passes the dependency age gate, with the same fast lane.
- The resolved lockfile is consistent with upstream's own.
- The strip rules, applied to upstream's source as text, leave out exactly what the
  evaluation reported.

`evaluate --ref <tag>` evaluates one release by hand. Use it for a hotfix worth taking
now.

Another track needs its first pin in a commit the owner signs. The owner writes that
pin locally with `blacksand t3 evaluate --channel stable --baseline <tag> --write`.
Until that commit exists, every machine refuses the track.

## Alerts

After the `commit` job, the `alerts` job checks the pin on `main` against the
[advisory sources](fast-lane.md#advisory-sources). It also checks Electron's embedded
Node and Chromium. The check covers everything a build of that pin installs:

- The lockfile the evaluate job resolved, checked the way the commit job checks it. If
  that lockfile is missing or fails the check, the job uses upstream's lockfile with
  the overrides applied instead.
- Each device tool's frozen closure from `pin.json`.
- The staged production install, read from a stage record. The record is bound to the
  upstream commit, the platform and this repository's build code, which is every file
  under `tooling/t3code/lib/` and `tooling/t3code/bin/`. A record counts only if it
  stages exactly what upstream's packager stages at that commit. The next hourly run
  reuses the last record if it passes the same check. Otherwise, the run builds the
  pinned release again.

If an evaluation fails or times out, the job still runs an advisory check. It lists
what that check couldn't cover.

**Issues.** A high, critical, unrated or malicious-package advisory opens one issue per
package and channel. The issue is titled `[security] <package> (<channel>)` and
labeled `security`. GitHub sends it as an email and a push notification.

- The job rewrites the issue's text from each complete check. The text lists every
  advisory id that names the package, including moderate and low ones. Each id links to
  the source that published it and shows that record's own rating.
- **Each change gets one comment.** The job posts a numbered comment when an id that
  is high, critical or unrated is new to the issue, or when one of those ids gets a new
  rating. The comment names what's new. It also names what no longer alerts: the ids
  now rated lower and, on a complete check, how many ids are no longer named. A lower
  rating on its own posts no comment.
- **No announcement is lost.** The issue's record of what it last announced is a
  hidden marker in its latest comment. Before the job posts a comment, it saves what
  the comment will say in the issue's own marker. If the comment doesn't go out, the
  next run posts it, whatever that run's own check finds. The numbers stop a lost API
  response from being mistaken for the comment before it.
- **Closing.** Once a check that covered everything finds nothing high, critical or
  unrated, the job closes the issue. It says "Fixed" if no advisory names the package
  any more. It says "No longer high or critical" if moderate or low ones still do, and
  never "Fixed" in that case. If a closed package alerts again, the job announces it
  again.
- One issue, `[security] Moderate and low advisories (<channel>)`, lists the packages
  that only moderate and low advisories name. The job rewrites it each hour and never
  comments on it.
- A check that couldn't cover everything closes nothing. It leaves each package
  issue's text as the last complete check wrote it. It still opens issues and
  announces what's new. The issue `[security] Advisory coverage incomplete (<channel>)`
  says what's missing.
- The issue `Upstream <channel> releases held` says why every newer release is held.
  It closes only when the pin the `commit` job pushed is on `main`, or when upstream
  has nothing newer. The evaluate job's exit code can open this issue but never close
  it, because that job ran upstream code.

The automation changes only the issues its bot opened with its hidden marker. It keeps
any notes you add above or below its text, whole. If your notes leave no room within
GitHub's 65,536-character limit, the job leaves the issue as it is, and the run fails
and names the issue. The job puts text from outside sources in code spans and code
blocks. That text includes advisory ids, summaries and the evaluate job's report. In
code formatting, it can't mention anyone, link anywhere or change the issue's
formatting. If GitHub refuses to update one issue, the job still updates the others.
The run still fails and names that issue.

## Checks on every change

- **`ci.yml`** runs on every push and pull request. It runs the repository's tests,
  and `bash -n`, `sh -n` and shellcheck on the scripts. It also runs those checks on
  the SSH runner in the form the remote shell receives it. It runs actionlint, which
  it downloads and checks against a pinned SHA-256. It checks that every action is
  pinned to a full commit SHA, and that `pin.json` and
  `tooling/t3code/lib/overrides.json` are valid. It runs `pin-check`, and applies the
  strip rules to the pinned commit.
- **`build.yml`** runs on changes under `tooling/t3code/bin/`, `tooling/t3code/lib/` or
  `tooling/t3code/test/stripped/`, and on changes to `pin.json`. It builds each pinned
  channel the change affects with `check --build`. It runs the tests in
  `tooling/t3code/test/stripped/` inside the stripped checkout, and syntax-checks the
  SSH runner as upstream renders it. It has a read-only token and no secrets.

The evaluator's own pin commits start neither `build.yml` nor `ci.yml`. The workflow
pushes them with its own token, and GitHub starts no workflows for pushes made with
that token.

The jobs that build install `libsecret-1-dev` and `imagemagick` with apt, because
upstream's Linux packager checks for them. They get pnpm through `install.sh`'s
`install_pnpm`, from tarballs pinned by digest, never through Corepack. They build as
the runner's user with `BLACKSAND_T3_UNISOLATED_BUILD=1`, because CI has no build
account.

## Limits

- The job reads advisories that a package's maintainers publish only in their own
  repository for the device tools alone. For every other package, an advisory counts
  only once OSV or GitHub's database has it.
- A forged stage record that is consistent in every respect, but picks other versions
  inside the allowed ranges, passes. Only resolving again would catch it, and the alert
  job doesn't run npm's resolver.
- The alert job checks the linux-x64 staged install that CI builds. Macs install a
  darwin one, whose native packages differ, so the job doesn't check those packages for
  advisories. Each Mac still checks its own staged install when it builds.
- An issue's record keeps up to 1,000 announced ids. Past that, the job lists the rest
  in the issue and logs them. It doesn't comment on a change among them, so that it
  doesn't comment every hour.
- If creating a package's first issue fails, the next run that sees the package opens
  it. The failed run is red.
