# Device tools

> **Applies to:** every build, and the app wherever device support is on, macOS and
> Linux. Code: `tooling/t3code/lib/device-tools.mjs`, `tooling/t3code/lib/native-assets.mjs`,
> `tooling/t3code/lib/native-assets.json`, `tooling/t3code/lib/known-device-tools.txt`.
> Tests: `tooling/t3code/test/device-tools.test.mjs`,
> `tooling/t3code/test/native-assets.test.mjs`,
> `tooling/t3code/test/device-tool-overrides.test.mjs`.

When device support is on, the app npm-installs the device tools that upstream pins
(`apps/server/src/device/deviceToolVersions.json`). Their code never passes through the
strip rules or the host scan, so each tool version gets its own review. A version that
isn't listed in `tooling/t3code/lib/known-device-tools.txt`, and that the evaluator
hasn't approved after review, aborts the update until someone has read it.

## Frozen closures

`pin.json` keeps each tool version's dependency lockfile, with its SHA-256, under
`deviceToolLocks`. The lockfile resolves dependencies as of the tool's own publish date.
Every machine checks the lockfile before building:

- The root is the tool alone.
- Every entry is a plain `node_modules/<name>` folder. Nested folders are allowed, but
  `..`, absolute paths and other odd parts aren't. Each entry holds npm's own tarball,
  with npm's integrity, and the tarball is at least 3 days old.
- Each folder holds what npm installs there for the tool. Starting from the tool, the
  check looks up every package's dependencies the way Node finds them, including
  optional and peer dependencies and `npm:` aliases. Each must be that package, in that
  range. An entry that nothing asks for fails the check, so a lockfile can't add a
  decoy package.

Once kept, a lockfile never changes or disappears. Rule `server/device-tools-frozen`
bakes it into the app at build time. The app installs it with
`npm ci --ignore-scripts`, both locally and over SSH. The install gets exactly those
versions and hashes, or nothing. Installed tools carry a marker that names their
closure and native files. So a build with a different closure reinstalls them once.

## No install scripts

The build reads which packages in a closure need native files from the packages
themselves. It downloads every closure's tarballs, checks them against their integrity
hashes, and looks for an install script or a `binding.gyp`. The lockfile's own flags
can only add packages to that list.

`tooling/t3code/lib/native-assets.json`, which the owner signs, must list each package
found. Its entry gives the prebuilt archive the package needs on each platform, with
the archive's URL and SHA-256 and the SHA-256 of each file taken from it. Or the entry
says the package needs no archive, and why. The app downloads the archive for its own
platform and checks both hashes. It writes only the listed files, and only inside the
tool's install folder. It refuses a package path that isn't a plain `node_modules`
path, and it never follows a link along the way. Nothing is built from source. A
package that isn't listed holds the build, and the error message says what to add.

A platform with no listed archive can't install that tool. Today `native-assets.json`
lists `node-datachannel`, which `expo-device-hub` needs, for darwin-arm64 and
linux-x64 only.

## A version without a lockfile

A tool version with no kept lockfile stops the build with "pin.json has no reviewed
dependency lockfile for device tool …". The evaluator proposes a lockfile when it
clears a tool. For a version you reviewed by hand and listed in
`tooling/t3code/lib/known-device-tools.txt`, run
`blacksand t3 device-tool-lock --tool name@version`. Then commit `pin.json`, signed.

## Overrides

A security override raises a vulnerable tool version that upstream still pins. The
override lives in `tooling/t3code/lib/overrides.json`, under `deviceTools`. Rule
`server/device-tool-overrides` applies it by rewriting the app's
`deviceToolVersions.json`. Today one override raises `agent-device` from 0.21.31 to
0.21.35, for GHSA-6845-fcpx-jc45 and GHSA-xr68-vpwv-cgg9. agent-device published those
advisories only in its own repository. An entry names its advisories, one per release
line, and covers that line below the fix.

The raised version goes through every check above. It must be listed in
`known-device-tools.txt`, have a reviewed lockfile, and be covered by the native-asset
list. Everything that counts what the app installs uses the raised version: the
evaluator, `pin-check`, self-update, the build and the alerts. To add an override,
write the entry and the known-tools line with its review note. Then run
`blacksand t3 device-tool-lock --tool name@version`, and have the owner sign the
commit. Drop the override once upstream pins the fix and the fix is at least 3 days
old.

## Limits

Each version's closure is frozen. So a fix to a device tool's dependency reaches you
only in two ways. Upstream pins a tool version that includes the fix, or an
owner-signed `deviceTools` override raises the tool itself.
