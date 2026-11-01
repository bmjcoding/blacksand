# Raising the pnpm pin

> **Applies to:** maintainers, macOS and Linux. Code: `tooling/t3code/lib/pnpm.mjs`. Tests:
> `tooling/t3code/test/pinned-pnpm.test.mjs`, `tooling/t3code/test/build-tools.deep.test.mjs`.

Every pnpm a build runs is one file: the pinned version, run by absolute path, with
its bytes checked against `PNPM_BINARY_SHA256` right before each run. It's never a
`pnpm` found on `PATH`, Corepack, or a version manager. pnpm's own version switching
is turned off in the build's environment. So when upstream's `packageManager` moves to
another pnpm, the build stops with a message naming the version.

Raise the pin once that pnpm is at least 3 days old:

1. In `tooling/t3code/lib/pnpm.mjs`, set `PNPM_VERSION`, and `PNPM_TARBALL_SHA512` for the wrapper
   package and each platform's `@pnpm/exe.<platform>` tarball, as hex. The
   registry's `dist.integrity` for each tarball is that SHA-512, base64-encoded.
2. Run `node tooling/t3code/lib/pnpm-cli.mjs digests`. It downloads each platform's tarball, checks it
   against its pinned SHA-512, and prints the native binary's SHA-256 as JSON. Paste
   those into `PNPM_BINARY_SHA256`. (`install.sh` checks the wrapper's digest when it
   installs.)
3. Commit, signed by the owner. It's a repo file, so no machine takes it otherwise.
4. On each machine, rerun `tooling/t3code/install.sh`. It replaces root's build tools under their
   lock ([build account](../building/build-account.md)).

A pnpm whose bytes don't match the pin is refused the same way; rerunning
`tooling/t3code/install.sh` reinstalls it. To check the pinned digests online, run the test suite
with `BLACKSAND_T3_PNPM_DIGESTS_ONLINE=1` ([testing](../security/testing.md)).
