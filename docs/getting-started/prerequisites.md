# Prerequisites

> **Applies to:** every role. macOS and Linux sections below.

Install these before you clone. `install.sh` checks git again, but it can't protect
a clone that has already happened with an old git.

**Copying commands.** Code blocks hold only commands. What they should print is in
the text after them. macOS's Terminal runs zsh, and zsh doesn't treat a pasted `#`
as a comment, so a trailing note would become arguments.

## Minimum versions

| What | Minimum | Why |
|---|---|---|
| git | 2.55.0 | The first release that filters a server's terminal control codes (CVE-2024-52005). It includes every earlier fix. `install.sh` and every git call Blacksand T3 makes refuse older versions. Apple's git (2.54.0, Apple Git-157) counts as 2.54.0. |
| Node | 24.22.1 on 24.x, or 26.12.1 | Fixes a Brotli decoder RCE (CVE-2026-111497) and TLS hostname bypasses from the October 2026 security release. `install.sh` refuses older versions. |
| pnpm | exactly 12.14.0 | Pinned by digest. `install.sh` installs it. Don't install it yourself ([raising the pin](../updates/pnpm-pin.md)). |
| Tailscale | 1.104.4 | 1.104.2 rejects the compromised eMudhra intermediate CAs (TS-2026-013). 1.104.4 fixes TS-2026-014, -016 and -017. Only needed if you use Tailscale. |

## macOS

Apple silicon or Intel, from your admin account.

1. **Xcode Command Line Tools:** `xcode-select --install` (you confirm the dialog).
   Full Xcode is optional for Blacksand T3 itself. You need it to create the Apple
   Development signing certificate ([signing](../install/signing-macos.md)), and to
   run iOS Simulators on the Mac that runs them ([iOS](../devices/ios.md)). Xcode 26
   or later also gives the app icon its Liquid Glass rendering.
2. **Homebrew.** Use the installer command on <https://brew.sh>, or the signed
   package from <https://github.com/Homebrew/brew/releases/latest>. To check the
   package before you open it:

   ```sh
   pkgutil --check-signature ~/Downloads/Homebrew-*.pkg
   spctl --assess --type install -v ~/Downloads/Homebrew-*.pkg
   ```

   The first names a `Developer ID Installer` certificate of Homebrew's team
   `927JGANW46`. The second says `accepted` and `source=Notarized Developer ID`.
   Then put Homebrew first on your `PATH`. On Intel, use `/usr/local/bin/brew`.

   ```sh
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
   exec zsh -l
   brew --version
   ```

   `echo $PATH` starts with `/opt/homebrew/bin`. The scheduled updater keeps the
   `PATH` that `install.sh` ran with.
3. **Git and Node:**

   ```sh
   brew update
   brew install git node
   git --version
   command -v git node npm
   ```

   Git is 2.55.0 or later at `/opt/homebrew/bin/git` (Intel: `/usr/local/bin/git`),
   not `/usr/bin/git`. Node meets the floor above. `npm` is Homebrew's: builds,
   the evaluator and self-update call it, so it must be on the same `PATH`.
4. **1Password app,** signed in, with **Settings → Developer → Integrate with
   1Password CLI** turned on. On macOS, `install.sh` keeps the shared code-signing
   certificate in 1Password and stops if the app is missing
   ([signing](../install/signing-macos.md)). It installs the 1Password CLI itself.
   If 1Password is also your SSH agent, turn on **Use the SSH agent**
   ([your SSH key](../accounts/agent-accounts.md#your-ssh-key)). Don't use
   `op whoami` as a check: under app integration it can say "not signed in" while
   every command works.
5. **Google Chrome or Chromium** in `/Applications`, desktop only. Preview and the
   before/after screenshots in each build report use it; Safari can't. Without it,
   builds still install, with no screenshots. A host doesn't need it.
6. **Optional:** the GitHub CLI (`brew install gh`, then `gh auth login`), in your
   own account only, never in an agent account. Cloning needs no login.
7. **Optional:** `brew install uv`, for ACP Registry agents published on PyPI (they
   run with `uvx`).
8. **No HTTPS-inspecting security software.** The app's runtime doesn't trust
   system-installed root certificates. A tool that decrypts and re-signs HTTPS
   breaks npm checks, the preview browser and provider traffic. Trusting its root
   would only hide the interception.

`install.sh` installs whatever is missing or below a floor (git, Node, Rust, the
1Password CLI) with Homebrew, plus the pinned pnpm. Rust from Homebrew brings about
2 GB of LLVM. It doesn't upgrade anything else ([keeping current](../install/keeping-current.md)).

## Linux

Omarchy/Arch, Ubuntu/Debian or Fedora/RHEL, on x64 or arm64, desktop role only.

- **git 2.55.0 or later.** Arch's rolling git qualifies. In October 2026 the
  others ship older ones: Fedora 44 and Ubuntu 26.04 ship 2.53, Rocky 9 ships 2.52,
  Debian 13 ships 2.47, Ubuntu 24.04 ships 2.43 and Debian 12 ships 2.39. Install a
  newer git first (on Ubuntu, for example, the git-core PPA). Otherwise `install.sh`
  stops after the system packages and Node, says what to do, and you rerun it.
- **sudo** for your account. `install.sh` installs system packages (build tools,
  libsecret, pkg-config, ImageMagick, Python) with pacman, apt or dnf, and creates
  the build account.
- **Node** doesn't need to be preinstalled. Unless a Node on your `PATH` already
  meets the floor, `install.sh` installs Node 24 from nodejs.org into
  `~/.local/share/blacksand/t3/node`, checked against the `SHASUMS256.txt` published
  beside it.
- **Network time** on, so the clock is right ([cloning](../install/clone.md#the-clock)).

## Accounts you'll use

| Account | For | Needed when |
|---|---|---|
| GitHub | nothing to clone; a login only to push, and a token with no permissions only to raise the advisory API's rate limit ([fast lane](../updates/fast-lane.md#advisory-sources)) | optional |
| Apple Account (free) | the Apple Development signing certificate; Xcode downloads | macOS |
| 1Password | the shared signing certificate (macOS); your SSH key, if you use its agent | macOS |
| Tailscale | the network between desktop, host and phone | host, phone, Screen Sharing |
| Provider accounts (Anthropic, OpenAI, …) | signing the agent CLIs in | wherever agents run |
