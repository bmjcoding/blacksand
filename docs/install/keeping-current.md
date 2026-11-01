# Keeping everything current

> **Applies to:** every role. macOS and Linux sections below.

The hourly updater keeps T3 Blackout itself current
([how updates arrive](../updates/how-updates-arrive.md)). `install.sh` installs only
what's missing or below a floor the code enforces: Node 24.22.1 or 26.12.1, git
2.55.0, and exactly the pinned pnpm. It doesn't upgrade anything else. The rest is
yours to keep current.

## macOS

- **macOS, the Command Line Tools and security responses:** **System Settings →
  General → Software Update** (`softwareupdate --list` shows what's pending). On a
  host, install at the Mac, so you can unlock FileVault after the restart.
- **Xcode:** the App Store. Then run `sudo xcodebuild -runFirstLaunch` and
  `xcodebuild -downloadPlatform iOS` for the matching simulator runtime.
- **Homebrew and what it installed** (git, Node, Rust, the 1Password CLI, the
  Android cask, the JDK, ffmpeg, `tailscale` on a host): run `brew update && brew
  upgrade` from your admin account. On a host, then redo
  [Tailscale's update steps](../networking/tailscale.md#updating-tailscaled).
- **npm itself.** Homebrew's Node bundles an older npm, and `brew upgrade node` can
  put it back. Upgrade it as your admin account only, never as an agent account
  (those keep their own npm prefix):

  ```sh
  npm install -g --ignore-scripts --prefix "$(brew --prefix)" npm@latest
  hash -r
  npm --version
  command -v npm
  ```

  It prints the latest npm, still at Homebrew's `bin`. The builds' pinned pnpm isn't
  affected.
- **Apps that update themselves:** 1Password, Chrome, the Tailscale app.
- **Provider CLIs in agent accounts:** use **Settings → Providers → Update** in the
  app, which waits until a version is 3 days old, or rerun the
  [`npm install -g` line](../accounts/providers.md#install-the-cli) in that account.
- **Android SDK, per account:** `sdkmanager --sdk_root="$ANDROID_HOME" --update`.

## Linux

- Your distribution's packages, with its own update tool. The git floor still applies.
- Node: if `install.sh` installed it (`~/.local/share/t3blackout/node`), it replaces
  it only when the Node on your `PATH` is below the floor. Rerun `./install.sh` after
  a release of T3 Blackout raises the floor.
