# Security fast lane, advisories and overrides

> **Applies to:** the evaluator, self-update and every build, macOS and Linux. Code:
> `packages/t3/lib/fastlane.mjs`, `packages/t3/lib/advisories.mjs`, `packages/t3/lib/overrides.mjs`, `packages/t3/lib/overrides.json`.
> Tests: `packages/t3/test/advisories.test.mjs`, `packages/t3/test/trust-supply.test.mjs`,
> `packages/t3/test/trust-runtime.test.mjs`, `packages/t3/test/dependency-identity.test.mjs`,
> `packages/t3/test/device-tool-overrides.test.mjs`.

New dependency versions wait 3 days. A security fix shouldn't, so two mechanisms let
one through: the fast lane, for a fix upstream already ships, and overrides, for a fix
upstream hasn't taken yet.

## Advisory sources

Every package is read from all of these, merged by id and alias:

- OSV.dev;
- GitHub's Advisory Database (api.github.com): reviewed, unreviewed and malware
  advisories, which can reach it before OSV has them;
- each device tool's own GitHub repository's published advisories. agent-device's two
  October 2026 advisories reached neither database.

A source that can't be read, or an answer that doesn't cover every package, fails the
check. Nothing is fast-laned, closed or called clean on a partial list.

GitHub's API allows 60 unauthenticated requests an hour per address. A whole-release
scan takes about 20, and a fast-lane check of one version takes 2 or 3. CI passes the
job's read-only token. On a machine, put a fine-grained GitHub token **with no
permissions** in `state/github-token` (mode 600, owned by you) to raise the limit. T3
Blackout sends it only to api.github.com. It reaches the build account and its own
reruns through one-shot files (`T3BLACKOUT_GITHUB_TOKEN_FILE`), never an environment
variable, and no program it starts inherits it. Code running as the same account can
still read it, so give it no permissions. Over the limit, a run holds or skips, and the
next hour tries again.

## The fast lane

A young dependency version skips the 3 days when either:

- **it fixes an advisory open against the pinned release.** A curated source (OSV or
  GitHub's database) names a fix in the release line of both the vulnerable version
  and the candidate, the candidate is at or past it, and no source still flags the
  candidate. An advisory only a device tool's own repository published counts only for
  the exact version and advisory ids an owner-signed `deviceTools` override names:
  nobody curates those, and the maintainer can edit one;
- **it's a newer Electron of the same major** whose embedded Node crosses a Node.js
  security release, or whose Chromium version changes at all. This needs no advisory.

Either way, it must look like the usual publisher shipped it. That's judged against
the versions of the package the pinned release already uses that are at least 3 days
old; with none, there's no fast lane. Those versions come only from the pinned
release's own lockfile and the owner's overrides, never from what CI hands over.

- The npm account that published the candidate must have published one of those, and
  it must declare the repository they declare.
- **A publisher change never gets the fast lane,** a switch to npm trusted publishing
  included. That version waits the 3 days like any other.
- If those versions carried npm provenance, the candidate's must name this exact
  tarball (package URL and SHA-512), and come from that repository, at a tag, the
  default branch or a `vN.x` branch.
- Provenance is only read, never verified (its Sigstore signatures aren't checked).
  So it can take a version out of the fast lane, but never put one in. Verified
  provenance wouldn't be enough anyway: in October 2026, a modified workflow
  published malware with valid provenance.
- The candidate must stay in the vulnerable version's release line, and in its 0.x
  minor for a 0.x package.

Device tools and their frozen closures get the same lane, measured against the
previous reviewed version's closure.

## Security overrides

For an advisory upstream hasn't fixed, `packages/t3/lib/overrides.json` replaces an exact
vulnerable version with the lowest same-major version that fixes it, vetted for
publisher and provenance (rule `deps/security-overrides`). Every build applies the
overrides through pnpm's `overrides`, raises matching catalog entries, and resolves
the lockfile with scripts off. Then it checks the result against upstream's own
lockfile:

- the same importers;
- the same version, dependencies and bytes for every package no override touches;
- no overridden version left;
- every override's fix present wherever the build still reaches the version it
  replaces (a version only an overridden parent pulled in goes with that parent,
  whose fix decides what it needs instead);
- anything else the re-resolution added at least 3 days old, and within the ranges
  npm declares for it.

Only then does it install. An override is a repo file, so it needs the owner's
signature. Drop an entry once upstream ships the fix. Advisories with no same-major
fix stay open as [issues](evaluator.md#alerts).

**Device tool overrides** (`deviceTools` in the same file) raise a vulnerable device
tool upstream still pins. Today: `agent-device@0.21.31 → 0.21.35`, for
GHSA-6845-fcpx-jc45 and GHSA-xr68-vpwv-cgg9. See [device tools](../building/device-tools.md#overrides).

## Limits

- **The fast lane trusts npm's registry metadata, and Electron's and Node.js's release
  lists.** Who published a version, the repository it declares and whether it has
  attestations come from the registry, unverified. So a registry that lies (stripping
  attestations from the earlier versions and the candidate alike) passes that part.
  Which Node and Chromium an Electron embeds, and which Node releases were security
  releases, come from releases.electronjs.org and nodejs.org as published.
- **A same-publisher Electron an hour old that moves Chromium is waived.** Every other
  gate still applies, and every machine still builds, scans and smoke-tests it.
