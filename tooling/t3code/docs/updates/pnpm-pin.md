# Raising the pnpm pin

> **Applies to:** maintainers, macOS and Linux. Code: `tooling/t3code/lib/pnpm.mjs`.
> Tests: `tooling/t3code/test/pinned-pnpm.test.mjs`,
> `tooling/t3code/test/build-tools.deep.test.mjs`.

Every pnpm a build runs is one file. It is the pinned version, run by absolute path,
and the build checks its bytes against `PNPM_BINARY_SHA256` right before each run. The
build never uses a `pnpm` found on `PATH`, Corepack or a version manager, and it turns
off pnpm's own version switching in its environment. So when upstream's
`packageManager` moves to another pnpm, the build stops with a message that names the
version.

Raise the pin once that pnpm is at least 3 days old:

1. In `tooling/t3code/lib/pnpm.mjs`, set `PNPM_VERSION`. Set `PNPM_TARBALL_SHA512`, as
   hex, for the wrapper package and for each platform's `@pnpm/exe.<platform>`
   tarball. The registry's `dist.integrity` for each tarball is that SHA-512,
   base64-encoded.
2. Run `node tooling/t3code/lib/pnpm-cli.mjs digests`. It downloads each platform's
   tarball, checks it against its pinned SHA-512, and prints the native binary's
   SHA-256 as JSON. Paste those digests into `PNPM_BINARY_SHA256`. `install.sh` checks
   the wrapper's digest when it installs.
3. Commit the change, signed by the owner. `pnpm.mjs` is a repository file, so no
   machine takes the change without that signature.
4. On each machine, rerun `tooling/t3code/install.sh`. It replaces root's build tools
   while holding their lock ([build account](../building/build-account.md)).

A pnpm whose bytes don't match the pin stops the build the same way. Rerunning
`tooling/t3code/install.sh` reinstalls it. To check the pinned digests online, run
the test suite with `BLACKSAND_T3_PNPM_DIGESTS_ONLINE=1`
([testing](../security/testing.md)).
