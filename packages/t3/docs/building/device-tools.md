# Device tools

> **Applies to:** every build, and the app wherever device support is on, macOS and
> Linux. Code: `packages/t3/lib/device-tools.mjs`, `packages/t3/lib/native-assets.mjs`,
> `packages/t3/lib/native-assets.json`, `packages/t3/lib/known-device-tools.txt`. Tests:
> `packages/t3/test/device-tools.test.mjs`, `packages/t3/test/native-assets.test.mjs`,
> `packages/t3/test/device-tool-overrides.test.mjs`.

The app npm-installs the device tools upstream pins
(`apps/server/src/device/deviceToolVersions.json`) when device support is on. Their
code never passes through the strip rules or the host scan, so each tool version gets
its own review. A version not listed in `packages/t3/lib/known-device-tools.txt`, or approved by
the evaluator after review, aborts the update until someone has read it.

## Frozen closures

Each tool version's dependency lockfile is kept in `pin.json` (`deviceToolLocks`,
with its SHA-256), resolved as of the tool's own publish date. Every machine checks it
before building:

- the root is the tool alone;
- every entry is a plain `node_modules/<name>` folder (nested ones allowed; no `..`,
  absolute or odd parts), holding npm's own tarball with npm's integrity, at least 3
  days old;
- each folder holds what npm installs there for the tool. Starting from the tool,
  every package's dependencies (optional, peer and `npm:` aliases included) are
  looked up as Node finds them, and must be that package in that range. An entry
  nothing asks for fails the check, so a lockfile can't slip in a decoy.

A kept lockfile never changes or disappears. The build bakes it into the app (rule
`server/device-tools-frozen`). The app installs it with `npm ci --ignore-scripts`,
locally and over SSH: exactly those versions and hashes, or nothing. Installed tools
carry a marker naming their closure and native files, so a build with a different
closure reinstalls them once.

## No install scripts

Which packages in a closure need native files is read from the packages themselves.
The build downloads every closure's tarballs, checks them against their integrity
hashes, and looks for an install script or a `binding.gyp`. The lockfile's own flags
can only add to that list.

Each one found must be listed in `packages/t3/lib/native-assets.json`, which the owner signs: the
prebuilt archive it needs per platform (URL and SHA-256, plus the SHA-256 of each file
taken from it), or none, with why. The app downloads the archive for its own platform,
checks both hashes, and writes only those files, only inside the tool's install
folder. It refuses a package path that isn't a plain `node_modules` one, and never
follows a link on the way. Nothing is built from source. An unlisted one holds the
build, and the message says what to add.

A platform with no listed archive can't install that tool. Today `node-datachannel`,
which `expo-device-hub` needs, is listed for darwin-arm64 and linux-x64 only.

## A version without a lockfile

This stops the build with "pin.json has no reviewed dependency lockfile for device
tool …". The evaluator proposes one when it clears a tool. For a version you reviewed
by hand (listed in `packages/t3/lib/known-device-tools.txt`), run `blacksand t3
device-tool-lock --tool name@version`, and commit `pin.json`, signed.

## Overrides

A vulnerable tool upstream still pins is raised by a security override
(`packages/t3/lib/overrides.json`, `deviceTools`). Rule `server/device-tool-overrides` rewrites
the app's `deviceToolVersions.json`. Today: `agent-device@0.21.31 → 0.21.35`, for
GHSA-6845-fcpx-jc45 and GHSA-xr68-vpwv-cgg9, which agent-device published only in its
own repository. An entry names its advisories, one per release line, and covers that
line below the fix.

The raised version goes through everything above: listed in `known-device-tools.txt`,
a reviewed lockfile, the native-asset list. Every count of what the app installs
(evaluator, `pin-check`, self-update, the build, the alerts) uses it. To add one:
the entry, the known-tools line with its review note, `blacksand t3
device-tool-lock --tool name@version`, then a commit the owner signs. Drop it once
upstream pins the fix and it's at least 3 days old.

## Limits

A fix to a device tool's dependency reaches you only when upstream pins a tool version
that includes it, or an owner-signed `deviceTools` override raises the tool itself,
because each version's closure is frozen.
