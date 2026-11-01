# Dependency installs

> **Applies to:** every build, macOS and Linux. Code: `packages/t3/lib/gates.mjs`,
> `packages/t3/lib/lockfile.mjs`, `packages/t3/lib/stage-install.mjs`, `packages/t3/lib/resolution.mjs`. Tests:
> `packages/t3/test/dependency-*.test.mjs`, `packages/t3/test/build-stage-install.test.mjs`,
> `packages/t3/test/build-artifact.test.mjs`.

A dependency is its name and version, plus where it was fetched from and its integrity
hash. So a swapped tarball is a substitution, and it fails.

## Resolve, check, then install

- Installs are resolved first, from the lockfile only, with scripts off. They're
  checked (minimum age, [security overrides](../updates/fast-lane.md#security-overrides),
  origin and integrity), and only then installed frozen.
- pnpm's own lockfile verification is forced on (`--no-trust-lockfile`), so upstream
  can't turn it off.
- A dependency must come from the npm registry or from upstream's own checkout. A
  tarball from anywhere else is refused unless that exact entry and its integrity are
  listed in `packages/t3/lib/known-resolutions.txt`, which the owner signs (empty today).
- A version upstream already had, given a different tarball or integrity, is refused.

## Install scripts

Install scripts run only for the packages the desktop build needs: esbuild,
msgpackr-extract, node-pty, sharp and @tsc-rs/typescript (rule
`deps/desktop-build-scripts-only`). Everything else in upstream's `allowBuilds` list
is switched off, the mobile app's included. New entries upstream adds start off.

## Local sources

Upstream's lockfile can install from the checkout itself: workspace projects, `link:`
targets, `file:` folders and `file:` tarballs.

- Each must name a path inside upstream's checkout and outside every `node_modules`
  folder, and only workspace projects may link. The lockfile check refuses anything
  else.
- Before the install, the build checks each one on disk against the pinned commit's
  file list (`git ls-tree`). After symlinks are followed, it must be inside the
  checkout, and be a folder (or, for a tarball, a file) that the commit tracks.
- A `file:` folder, whose files pnpm copies, may hold only files the commit tracks
  (its `node_modules` aside), and no symlinks.

## The staged production install

Upstream's packager runs a production install in a scratch stage while it builds the
app, with no lockfile of its own. Rule `desktop/stage-install-guarded` routes both of
upstream's `vp install --prod` calls through the same guard; a third call stops the
build.

- The stage is no commit's tree, so its lockfile may install nothing from local
  folders. A workspace project, link or `file:` source other than the stage itself
  stops the build.
- While the packager runs, `vp`, `pnpm`, `npm` and `yarn` on its `PATH` are shims.
  They refuse every command aimed at the stage, except reading what's installed
  (`list`, `why`, a version).
- The guard records every file it installed (path, mode, SHA-256). After packaging,
  every installed package must be in the lockfile that was checked, and every
  recorded file must be there, unchanged.
- Packaging may add only what it was seen to add: a `*.node` copy whose bytes match an
  installed file, and, for a package with a `binding.gyp`, files in its `build/`
  folder or node-gyp's scratch folder. Anything else (a changed, missing or new file, a
  new package or link) fails the build: "the staged install in … isn't what was
  installed from its checked lockfile".

## Limits

- **An install script can still run inside the build account.** The shims see
  package managers started through `PATH`. One the packager starts by its absolute
  path still runs, lifecycle scripts included. The build then refuses the result
  (the staged files no longer match what the guard installed), so nothing is
  installed, but the script has run as the build account. Stopping that needs an OS
  sandbox around the packager.
- **The staged-install check has edges.** The guard's record lives in the build's
  private temp folder, where the packager runs, so a deliberately malicious packager
  could rewrite the record along with the files. It checks the stage folders after
  packaging, not the packed `app.asar` (which the forbidden-endpoint scan reads).
  What node-gyp writes into `build/` and scratch folders isn't byte-checked; it's
  compiler output, different on every build.
- **The local-source check reads contents only for `file:` folders.** A linked
  workspace folder may hold untracked files (build output, the files the strip rules
  inject), and tracked files' bytes aren't hashed against the commit. That rests on
  the build checking out the pinned commit with `--force`, and cleaning the checkout
  first.
- **Prebuilt pieces still come from upstream's build:** Electron's runtime, and the
  native binaries some npm packages fetch. Their versions are pinned by upstream's
  lockfile; they aren't built here. Upstream's managed Codex install downloads a Codex
  release whose version and SHA-256 upstream's source pins.
