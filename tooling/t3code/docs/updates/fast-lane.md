# Security fast lane, advisories and overrides

> **Applies to:** the evaluator, self-update and every build, macOS and Linux. Code:
> `tooling/t3code/lib/fastlane.mjs`, `tooling/t3code/lib/advisories.mjs`,
> `tooling/t3code/lib/overrides.mjs`, `tooling/t3code/lib/overrides.json`. Tests:
> `tooling/t3code/test/advisories.test.mjs`,
> `tooling/t3code/test/trust-supply.test.mjs`,
> `tooling/t3code/test/trust-runtime.test.mjs`,
> `tooling/t3code/test/dependency-identity.test.mjs`,
> `tooling/t3code/test/device-tool-overrides.test.mjs`.

New dependency versions wait 3 days. A security fix shouldn't have to wait, so two
mechanisms let one through. The fast lane takes a fix upstream already ships.
Overrides apply a fix upstream hasn't taken yet.

## Advisory sources

blacksand-t3 reads every package's advisories from all of these sources and merges
them by id and alias:

- OSV.dev.
- GitHub's Advisory Database, at api.github.com. It has reviewed, unreviewed and
  malware advisories, and an advisory can reach it before OSV has it.
- The advisories each device tool publishes in its own GitHub repository. The two
  October 2026 advisories for agent-device reached neither database.

If a source can't be read, or an answer doesn't cover every package, the check fails.
blacksand-t3 never fast-lanes a version, closes an issue or calls a release clean on a
partial list.

GitHub's API allows 60 unauthenticated requests an hour per address. A scan of a whole
release takes about 20 requests, and a fast-lane check of one version takes 2 or 3. CI
passes the job's read-only token. On a machine, you can raise the limit with a
fine-grained GitHub token that has no permissions. Put it in `state/github-token`, with
mode 600 and owned by you. blacksand-t3 sends the token only to api.github.com. It
passes the token to the build account and to its own reruns through one-shot files
(`BLACKSAND_T3_GITHUB_TOKEN_FILE`), never through an environment variable, and no
program it starts inherits the token. Code running as the same account can still read
it, which is why the token must have no permissions. When a run goes over the limit, it
holds or skips, and the next hourly run tries again.

## The fast lane

A young dependency version skips the 3-day wait in either of two cases:

- **It fixes an advisory open against the pinned release.** A curated source, OSV or
  GitHub's database, names a fix in the release line of both the vulnerable version
  and the candidate. The candidate is at or past that fix, and no source still flags
  the candidate. An advisory that only a device tool's own repository published counts
  only for the exact version and advisory ids that an owner-signed `deviceTools`
  override names. Nobody curates those advisories, and the maintainer can edit one.
- **It's a newer Electron of the same major version.** Its embedded Node crosses a
  Node.js security release, or its Chromium version changes at all. This case needs no
  advisory.

In both cases, the candidate must look like the usual publisher shipped it. blacksand-t3
judges that against the versions of the package that the pinned release already uses
and that are at least 3 days old. If there are none, the fast lane is closed. Those
versions come only from the pinned release's own lockfile and the owner's overrides,
never from anything CI hands over.

- The npm account that published the candidate must have published one of those
  versions. The candidate must declare the same repository they declare.
- **A change of publisher never gets the fast lane.** That includes a switch to npm
  trusted publishing. The new version waits the 3 days like any other.
- If those versions carried npm provenance, the candidate's provenance must name this
  exact tarball by package URL and SHA-512. It must also come from that repository,
  built at a tag, the default branch or a `vN.x` branch.
- blacksand-t3 reads provenance but never verifies it, and doesn't check its Sigstore
  signatures. So provenance can take a version out of the fast lane, but never put one
  in. Verified provenance wouldn't be enough anyway. In October 2026, a modified
  workflow published malware with valid provenance.
- The candidate must stay in the vulnerable version's release line. For a 0.x package,
  it must also stay in the same 0.x minor version.

Device tools and their frozen closures get the same fast lane. blacksand-t3 measures
them against the closure of the previous reviewed version.

## Security overrides

For an advisory upstream hasn't fixed, `tooling/t3code/lib/overrides.json` replaces an
exact vulnerable version with the lowest version in the same major line that fixes it
(rule `deps/security-overrides`). Each replacement is vetted for publisher and
provenance. Every build applies the overrides through pnpm's `overrides` and raises
matching catalog entries. It then resolves the lockfile with scripts off, and checks
the result against upstream's own lockfile:

- The importers are the same.
- Every package that no override touches has the same version, dependencies and bytes.
- No overridden version is left.
- Every override's fix is present wherever the build still reaches the version it
  replaces. A version that only an overridden parent pulled in goes away with that
  parent, and the parent's fix decides what it needs instead.
- Anything else the new resolution added is at least 3 days old, and within the ranges
  npm declares for it.

Only after these checks does the build install. An override is a repository file, so
it needs the owner's signature. Remove an entry once upstream ships the fix. An
advisory with no fix in the same major line stays open as an
[issue](evaluator.md#alerts).

**Device tool overrides.** The `deviceTools` list in the same file raises a vulnerable
device tool that upstream still pins. Today it raises `agent-device` from 0.21.31 to
0.21.35, for GHSA-6845-fcpx-jc45 and GHSA-xr68-vpwv-cgg9. See
[device tools](../building/device-tools.md#overrides).

## Limits

- **The fast lane trusts npm's registry metadata, and the release lists of Electron
  and Node.js.** The registry reports, unverified, who published a version, the
  repository it declares and whether it has attestations. A registry that lies, for
  example by stripping attestations from both the earlier versions and the candidate,
  passes that part of the check. Which Node and Chromium an Electron release embeds,
  and which Node releases were security releases, come from releases.electronjs.org
  and nodejs.org as published.
- **The fast lane waives the wait for a same-publisher Electron that is an hour old
  and moves Chromium.** Every other gate still applies, and every machine still builds,
  scans and smoke-tests it.
