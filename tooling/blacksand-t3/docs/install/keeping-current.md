# Keeping everything current

> **Applies to:** every role. macOS and Linux sections below.

The hourly updater keeps blacksand-t3 itself current
([how updates arrive](../updates/how-updates-arrive.md)). `install.sh` installs only
what's missing or below a floor the code enforces: Node 24.22.1 or 26.12.1, git
2.55.0, and exactly the pinned pnpm. It doesn't upgrade anything else. You keep the
rest current.

## macOS

- **macOS, the Command Line Tools and security responses.** Update them in **System
  Settings → General → Software Update**. `softwareupdate --list` shows what's
  pending. On a host, install them at the Mac, so you can unlock FileVault after the
  restart.
- **Xcode.** Update it from the App Store. Then run `sudo xcodebuild -runFirstLaunch`,
  and `xcodebuild -downloadPlatform iOS` for the matching simulator runtime.
- **Homebrew and what it installed.** That's git, Node, Rust, the 1Password CLI, the
  Android cask, the JDK, ffmpeg, and `tailscale` on a host. Run
  `brew update && brew upgrade` from your admin account. On a host, then redo
  [Tailscale's update steps](../networking/tailscale.md#updating-tailscaled).
- **npm itself.** Homebrew's Node bundles an older npm, and `brew upgrade node` can
  put it back. Agent accounts keep their own npm prefix, so never upgrade npm from
  one. From your admin account, run:

  ```sh
  npm install -g --ignore-scripts --prefix "$(brew --prefix)" npm@latest
  hash -r
  npm --version
  command -v npm
  ```

  It prints the latest npm version, and `command -v npm` still points into
  Homebrew's `bin`. This doesn't change the builds' pinned pnpm.
- **Apps that update themselves.** These are 1Password, Chrome and the Tailscale app.
- **Provider CLIs in agent accounts.** In the app, use **Settings → Providers →
  Update**, which waits until a version is 3 days old. Or rerun the
  [`npm install -g` line](../accounts/providers.md#install-the-cli) in that account.
- **Android SDK, per account.** Run `sdkmanager --sdk_root="$ANDROID_HOME" --update`
  in each account.

## Linux

- Update your distribution's packages with its own update tool. The git floor still
  applies.
- If `install.sh` installed Node (`~/.local/share/blacksand/t3/node`), it replaces
  that Node only when the Node on your `PATH` is below the floor. Rerun
  `tooling/blacksand-t3/install.sh` after a blacksand-t3 release raises the floor.
