# Supply chain

> **Applies to:** this repository, its CI, and every machine's updates, macOS and Linux.

What runs on a machine comes from four places: this repository, upstream T3 Code, the
npm registry, and the tools that build them. Each has its own control, and each
machine re-checks what CI proposes.

## This repository: signed commits

- **Machines take only signed history.** Self-update fast-forwards to `main` only
  when every new commit, side branches included, has exactly one SSH signature from a
  principal in `.allowed_signers`. The list is read **from each commit's first
  parent**, so a commit can't add the key that signs it. OpenPGP and X.509 signatures,
  unsigned commits and commits with no parent are refused
  ([self-update](../updates/self-update.md)).
- **Two principals.** The owner's SSH key may sign anything. The evaluator's key
  (`t3blackout-evaluator`) may sign only single-parent commits that change `pin.json`
  alone and move a channel forward to a real upstream release.
- **A fresh clone gets the same rule.** It's verified from its first commit forward,
  by the same code. A shallow clone is refused.
- **GitHub's role is transport.** Someone who gets into the GitHub account can push,
  but machines refuse what the allowed keys didn't sign. The `main` ruleset blocks
  force-push and deletion, with no bypass actors. Secret scanning and push protection
  are on.

## Upstream releases: the evaluator, re-checked locally

- CI's `evaluate` job builds candidates with a read-only token and no secrets. Its
  output is only a proposal.
- The `commit` job re-derives the gates on a fresh runner that runs no upstream or npm
  code, before the key is in reach ([evaluator](../updates/evaluator.md)).
- **Each machine is the authority.** It re-derives the gates from upstream's git, npm,
  the advisory sources and this repository, then strips, typechecks, scans and
  smoke-tests the release itself. A forged CI result or a stolen evaluator key can at
  worst hold an update or make it fail, or pin a real newer release that passes the
  machine's own gates.
- **Strict strip rules** stop a release when their required anchors drift. The host
  scan stops unlisted, non-reserved hosts found in URL literals in the scanned app
  source. Neither audits arbitrary new code or proves that a release has no new
  outbound behaviour ([limits](../building/pipeline.md#limits)).

## npm dependencies

- **A 3-day minimum age** for every dependency version a release adds. Upstream's own
  code isn't held, only new third-party packages, which is where a hijacked release
  does its damage. The **security fast lane** waives the wait only for a fix to an
  advisory open against the pinned release, or a same-major Electron that takes a
  Node.js security release or a new Chromium, and only from the usual publisher. A
  publisher change never gets it ([fast lane](../updates/fast-lane.md)).
- **Identity is bytes.** A dependency is name, version, source and integrity. A changed
  tarball for an existing version is refused, and a non-registry source needs an
  owner-signed entry ([dependencies](../building/dependencies.md)).
- **Install scripts run for five packages only,** the ones the desktop build needs. The
  packager's own production install is guarded and verified file by file.
- **Device tools** install from frozen, reviewed lockfiles, with no install scripts.
  Native files come from an owner-signed list of archives checked by SHA-256
  ([device tools](../building/device-tools.md)).
- **Builds run as an unprivileged account** that can't read your home, with tools
  only root can change ([build account](../building/build-account.md)).

## Build tools

| Tool | How it's trusted |
|---|---|
| pnpm | pinned version; registry tarballs pinned by SHA-512; the binary checked by SHA-256 before every run; never Corepack or `PATH` ([pnpm pin](../updates/pnpm-pin.md)) |
| Rust on Linux | rustup-init 1.29.2 pinned by SHA-256; toolchain 1.99.1 |
| git | 2.55.0 or later, checked before every call; run with the machine's git configuration ignored, HTTPS only |
| Node on Linux | the latest 24.x from nodejs.org, checked against the `SHASUMS256.txt` published beside it. That's integrity in transit, not a pinned digest or signature |
| Homebrew packages (macOS: git, Node, Rust, the 1Password CLI) | Homebrew's own trust; not pinned or age-gated |
| Electron and native prebuilt binaries | versions pinned by upstream's lockfile; not built here |
| actionlint (CI) | a release download checked against a pinned SHA-256 |

## GitHub Actions

- **Only GitHub-owned actions, pinned to full commit SHAs.** The repository allows
  GitHub-owned actions only, and GitHub enforces SHA pinning. `ci.yml` checks every
  `uses:` in every workflow, parsed as YAML; one the check can't read fails it.
- **Why third-party actions are refused:** an action runs with the job's token, and in
  the `commit` job, next to the signing key. A tag can be moved to new code, and a
  third-party publisher can be compromised. GitHub-owned actions pinned by SHA leave
  one publisher, and fixed code.
- **Least privilege.** The default workflow token is read-only, and workflows can't
  approve pull requests. `evaluate.yml` starts from `permissions: {}`, and each job
  asks only for what it needs (see the [evaluator](../updates/evaluator.md#the-three-jobs-evaluateyml-hourly)).
  `actions/checkout` runs with `persist-credentials: false`. The evaluator key is a
  repository Actions secret, read only in the final sign-and-push step. That step
  writes it to a mode-600 file and deletes it after signing.
- **Anyone who can push a workflow can read the evaluator's key.** So no token with
  `workflow` scope lives in an agent account
  ([keys and incidents](keys-and-incidents.md)).

## Advisories and alerts

The alert job checks everything a build of the pinned release installs: the resolved
lockfile, each device tool's frozen closure, and the staged production install. It
reads OSV, GitHub's Advisory Database and the device tools' own repositories, and
fails closed on a partial answer. High, critical, unrated and malicious-package
advisories open an issue per package, which GitHub emails and pushes. Moderate and low
ones are listed in one rolling issue that never notifies
([alerts](../updates/evaluator.md#alerts)).

## Not done yet

- No SBOM is published. The inventory is `pin.json` (the release and device tool
  lockfiles), upstream's lockfile at the pinned commit, and the alert job's stage
  records.
- npm provenance is read, never verified. It can take a version out of the fast lane,
  never put one in.
- The evaluator key isn't in a GitHub environment with required reviewers. It's a
  repository secret, so a workflow pushed to the repository could read it. Machines
  would refuse that unsigned commit, but the key would be exposed. Its damage is then
  bounded by what the evaluator key may sign, and you rotate it
  ([keys and incidents](keys-and-incidents.md#the-evaluator-key-leaked)). Pull
  requests from forks don't get secrets.

The residual risks are listed in the [threat model](threat-model.md#residual-risks).
