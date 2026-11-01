# Prerequisites

> **Applies to:** every role. macOS and Linux sections below.

Install these before you clone. `install.sh` checks git again, but by then an old git
has already made the clone.

**Copying commands.** Code blocks hold only commands. What they should print is in
the text after them. macOS's Terminal runs zsh, and zsh doesn't treat a pasted `#`
as a comment, so a trailing note would become arguments.

## Minimum versions

| What | Minimum | Why |
|---|---|---|
| git | 2.55.0 | The first release that filters a server's terminal control codes (CVE-2024-52005). It includes every earlier fix. `install.sh` and every git call blacksand-t3 makes refuse older versions. Apple's git (2.54.0, Apple Git-157) counts as 2.54.0. |
| Node | 24.22.1 on 24.x, or 26.12.1 | Fixes a Brotli decoder RCE (CVE-2026-111497) and TLS hostname bypasses from the October 2026 security release. `install.sh` refuses older versions. |
| pnpm | exactly 12.14.0 | Pinned by digest. `install.sh` installs it. Don't install it yourself ([raising the pin](../updates/pnpm-pin.md)). |
| Tailscale | 1.104.4 | 1.104.2 rejects the compromised eMudhra intermediate CAs (TS-2026-013). 1.104.4 fixes TS-2026-014, -016 and -017. You need it only if you use Tailscale. |

## macOS

These steps work on Apple silicon or Intel. Run them from your admin account.

1. **Xcode Command Line Tools.** Run `xcode-select --install` and confirm the
   dialog. blacksand-t3 itself doesn't need full Xcode. You need it to create the
   Apple Development signing certificate ([signing](../install/signing-macos.md)),
   and on any Mac that runs iOS Simulators ([iOS](../devices/ios.md)). With Xcode 26
   or later, the app icon also gets its Liquid Glass rendering.
2. **Homebrew.** Use the installer command on <https://brew.sh>, or the signed
   package from <https://github.com/Homebrew/brew/releases/latest>. To check the
   package before you open it:

   ```sh
   pkgutil --check-signature ~/Downloads/Homebrew-*.pkg
   spctl --assess --type install -v ~/Downloads/Homebrew-*.pkg
   ```

   The first command names a `Developer ID Installer` certificate of Homebrew's team
   `927JGANW46`. The second prints `accepted` and `source=Notarized Developer ID`.
   Then put Homebrew first on your `PATH`. On Intel, use `/usr/local/bin/brew` in
   place of `/opt/homebrew/bin/brew`.

   ```sh
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
   exec zsh -l
   brew --version
   ```

   `echo $PATH` now starts with `/opt/homebrew/bin`. The scheduled updater keeps the
   `PATH` that `install.sh` ran with.
3. **Git and Node.** Install both from Homebrew.

   ```sh
   brew update
   brew install git node
   git --version
   command -v git node npm
   ```

   Git reports 2.55.0 or later and runs from `/opt/homebrew/bin/git`, not
   `/usr/bin/git`. On Intel it runs from `/usr/local/bin/git`. Node meets the floor
   above. `npm` is Homebrew's. Builds, the evaluator and self-update call it, so it
   must be on the same `PATH`.
4. **1Password app.** Sign in, and turn on **Settings → Developer → Integrate with
   1Password CLI**. On macOS, `install.sh` keeps the shared code-signing certificate
   in 1Password, and it stops if the app is missing
   ([signing](../install/signing-macos.md)). It installs the 1Password CLI itself.
   If 1Password is also your SSH agent, turn on **Use the SSH agent**
   ([your SSH key](../accounts/agent-accounts.md#your-ssh-key)). Don't use
   `op whoami` as a check. Under app integration it can say "not signed in" while
   every command works.
5. **Google Chrome or Chromium.** Install it in `/Applications` on the desktop. A
   host doesn't need it. Preview and the before/after screenshots in each build
   report use it, and Safari can't take its place. Without it, builds still install,
   but with no screenshots.
6. **GitHub CLI, optional.** Run `brew install gh`, then `gh auth login`. Use it in
   your own account only, never in an agent account. Cloning needs no login.
7. **uv, optional.** Run `brew install uv` if you use ACP Registry agents published
   on PyPI. They run with `uvx`.
8. **No HTTPS-inspecting security software.** The app's runtime doesn't trust
   system-installed root certificates. A tool that decrypts and re-signs HTTPS
   breaks npm checks, the preview browser and provider traffic. Trusting its root
   would only hide the interception.

`install.sh` uses Homebrew to install git, Node, Rust and the 1Password CLI when
they're missing or below a floor. It also installs the pinned pnpm. It doesn't
upgrade anything else ([keeping current](../install/keeping-current.md)). Rust from
Homebrew brings about 2 GB of LLVM.

## Linux

The desktop role runs on Omarchy or Arch, Ubuntu or Debian, and Fedora or RHEL, on
x64 or arm64. Linux supports no other role yet.

- **git 2.55.0 or later.** Arch's rolling git qualifies. In October 2026 the
  others ship older ones: Fedora 44 and Ubuntu 26.04 ship 2.53, Rocky 9 ships 2.52,
  Debian 13 ships 2.47, Ubuntu 24.04 ships 2.43 and Debian 12 ships 2.39. Install a
  newer git first, for example from the git-core PPA on Ubuntu. Otherwise
  `install.sh` stops after the system packages and Node and says what to do. Then
  you rerun it.
- **sudo for your account.** `install.sh` uses pacman, apt or dnf to install system
  packages (build tools, libsecret, pkg-config, ImageMagick, Python), and it creates
  the build account.
- **Node.** You don't need to install it first. If no Node on your `PATH` meets the
  floor, `install.sh` installs Node 24 from nodejs.org into
  `~/.local/share/blacksand/t3/node`. It checks the download against the
  `SHASUMS256.txt` that nodejs.org publishes beside it.
- **Network time.** Turn it on so the clock is right
  ([cloning](../install/clone.md#the-clock)).

## Accounts you'll use

| Account | For | Needed when |
|---|---|---|
| GitHub | Cloning needs no account. You need a login only to push, and a token with no permissions only to raise the advisory API's rate limit ([fast lane](../updates/fast-lane.md#advisory-sources)). | optional |
| Apple Account (free) | the Apple Development signing certificate; Xcode downloads | macOS |
| 1Password | the shared signing certificate (macOS); your SSH key, if you use its agent | macOS |
| Tailscale | the network between desktop, host and phone | host, phone, Screen Sharing |
| Provider accounts (Anthropic, OpenAI and others) | signing the agent CLIs in | wherever agents run |
