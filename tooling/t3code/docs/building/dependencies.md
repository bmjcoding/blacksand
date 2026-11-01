# Dependency installs

> **Applies to:** every build, macOS and Linux. Code: `tooling/t3code/lib/gates.mjs`,
> `tooling/t3code/lib/lockfile.mjs`, `tooling/t3code/lib/stage-install.mjs`,
> `tooling/t3code/lib/resolution.mjs`. Tests: `tooling/t3code/test/dependency-*.test.mjs`,
> `tooling/t3code/test/build-stage-install.test.mjs`,
> `tooling/t3code/test/build-artifact.test.mjs`.

The build identifies a dependency by its name, its version, where it was fetched from,
and its integrity hash. So a swapped tarball counts as a substitution, and it fails.

## Resolve, check, then install

- The build first resolves installs from the lockfile only, with scripts off. It then
  checks them for minimum age,
  [security overrides](../updates/fast-lane.md#security-overrides), origin and
  integrity. Only then does it install them, with the lockfile frozen.
- The build forces pnpm's own lockfile verification on (`--no-trust-lockfile`), so
  upstream can't turn it off.
- A dependency must come from the npm registry or from upstream's own checkout. The
  build refuses a tarball from anywhere else, unless
  `tooling/t3code/lib/known-resolutions.txt` lists that exact entry and its integrity.
  The owner signs that file, and it's empty today.
- The build refuses a version upstream already had if it now comes with a different
  tarball or integrity.

## Install scripts

Install scripts run only for the packages the desktop build needs: esbuild,
msgpackr-extract, node-pty, sharp and @tsc-rs/typescript. Rule
`deps/desktop-build-scripts-only` switches off everything else in upstream's
`allowBuilds` list, the mobile app's entries included. New entries that upstream adds
start switched off.

## Local sources

Upstream's lockfile can install from the checkout itself. It can name workspace
projects, `link:` targets, `file:` folders and `file:` tarballs.

- Each must name a path inside upstream's checkout and outside every `node_modules`
  folder. Only workspace projects may link. The lockfile check refuses anything else.
- Before the install, the build checks each source on disk against the pinned
  commit's file list (`git ls-tree`). After the build follows symlinks, the source
  must be inside the checkout. It must be a folder that the commit tracks or, for a
  tarball, a file that the commit tracks.
- pnpm copies the files of a `file:` folder. So a `file:` folder may hold only files
  the commit tracks, apart from its `node_modules`, and it may hold no symlinks.

## The staged production install

While upstream's packager builds the app, it runs a production install in a scratch
stage that has no lockfile of its own. Rule `desktop/stage-install-guarded` routes both
of upstream's `vp install --prod` calls through the same guard. A third call stops the
build.

- The stage isn't any commit's tree, so its lockfile may install nothing from local
  folders. A workspace project, link or `file:` source other than the stage itself
  stops the build.
- While the packager runs, the `vp`, `pnpm`, `npm` and `yarn` on its `PATH` are shims.
  They refuse every command aimed at the stage, except commands that read what's
  installed (`list`, `why`, or a version query).
- The guard records every file it installed, with its path, mode and SHA-256. After
  packaging, every installed package must be in the lockfile that the build checked.
  Every recorded file must still be there, unchanged.
- Packaging may add only the kinds of file it was seen to add. Those are a `*.node`
  copy whose bytes match an installed file and, for a package with a `binding.gyp`,
  files in its `build/` folder or in node-gyp's scratch folder. Anything else fails the
  build, whether it's a changed, missing or new file, or a new package or link. The
  error reads "the staged install in … isn't what was installed from its checked
  lockfile".

## Limits

- **An install script can still run inside the build account.** The shims catch
  package managers started through `PATH`. A package manager that the packager starts
  by its absolute path still runs, lifecycle scripts included. The build then refuses
  the result, because the staged files no longer match what the guard installed. So
  nothing is installed, but the script has already run as the build account. Stopping
  that needs an OS sandbox around the packager.
- **The staged-install check has gaps.** The guard keeps its record in the build's
  private temp folder, where the packager runs. So a deliberately malicious packager
  could rewrite the record along with the files. The guard checks the stage folders
  after packaging, not the packed `app.asar`. The forbidden-endpoint scan reads
  `app.asar`. The guard doesn't byte-check what node-gyp writes into `build/` and
  scratch folders, because that's compiler output and differs on every build.
- **The local-source check reads contents only for `file:` folders.** A linked
  workspace folder may hold untracked files, such as build output or the files the
  strip rules inject. The check also doesn't hash tracked files' bytes against the
  commit. For those, it relies on the build cleaning the checkout first and then
  checking out the pinned commit with `--force`.
- **Prebuilt pieces still come from upstream's build.** These are Electron's runtime
  and the native binaries that some npm packages fetch. Upstream's lockfile pins their
  versions, and blacksand-t3 doesn't build them. Upstream's managed Codex install
  downloads a Codex release whose version and SHA-256 upstream's source pins.
