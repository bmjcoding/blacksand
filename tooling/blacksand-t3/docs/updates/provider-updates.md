# Provider CLI and agent updates

> **Applies to:** every account that runs a blacksand-t3 server, macOS and Linux.

The agent CLIs, such as Claude Code and Codex, aren't part of the blacksand-t3 build.
They update separately.

## Automatic updates

blacksand-t3 updates each provider CLI by itself to the newest version that is at least
3 days old. This is on by default. It happens when the server next refreshes that
provider's status (every 5 minutes by default, while the app is connected) and finds a
3-day-old version newer than the one installed. It runs exactly the command Update now
runs, below, through the server's one update runner, so Settings shows its progress and
result, and it waits for any other update into the same place (rule
`provider/automatic-updates`).

It runs only while no session of that provider is starting, open (idle or mid-turn) or
still closing, and a session that starts while it runs waits for it to finish. So a CLI
is never replaced under a session. A busy provider waits for a refresh after its sessions
have closed (rule `provider/automatic-updates-idle`). Just before the command starts,
after any wait for another update, it checks again that both settings below are on, the
provider is still enabled, and the command is still one it runs by itself. If not, it
runs nothing (rule `provider/automatic-updates-last-check`). It tries each version it
runs once per server run, so a failing install doesn't repeat. An update the runner
turns down without running anything, such as a version the compatibility manifest marks
broken, isn't tried again until the provider's status changes at a later refresh.

Only installs whose updater can install an exact version update automatically: npm,
pnpm, and the vendor installers for Claude Code, Codex and OpenCode listed below.
Homebrew, Pi's self-updater, Muse's launcher, bun, yarn, Volta and Vite+ never do. Two
installs that Update now can pin don't update by themselves either; Update now and
Update to latest still work for both:

- **Grok installed with Grok's own installer.** A minimum version Grok's own config or
  environment requires (`required_minimum_version`, `GROK_REQUIRED_MINIMUM_VERSION`) wins
  over the one-version range the update sets, and nothing in the update's environment
  can lower it. Grok would then install that minimum, however new it is. Grok installed
  with npm or pnpm updates automatically.
- **Codex's standalone install, while an older Codex app-server daemon runs from it.**
  Codex keeps that daemon's state in `~/.codex/app-server-daemon/`. Installing a specific
  version deletes the marker that daemon needs to keep updating itself (below). The
  check reads Codex's own state files, in the install's own `CODEX_HOME`, as Codex does,
  and skips the update if it can't read them.

To turn automatic updates off, turn off **Settings → Maintenance → Automatic provider
updates**. Turning off **Provider update checks** stops them too, because nothing then
finds a newer version.

## Update now and Update all

The Update now button in Settings → Providers, and Update all, run the same update as
the automatic one, whenever you press them. They wait until a version is shown to be
3 days old, and then install exactly that version, except where a native Grok install
requires a newer minimum (below). For most installs npm's registry
shows it, with each release's publish date. For native Grok, whose channel gives no
dates, the server's own record of when it first saw the version shows it. If the
registry or channel can't be reached, or no release is 3 days old yet, nothing runs and
Settings says so. An installer that can't install a specific version gets no such
update: Settings shows its command and says why, and it keeps Update to latest (rules
`provider/updates-minimum-age` and `provider/updates-exact-version`):

- **npm and pnpm.** They install exactly the version the check reported, which is the
  newest version at least 3 days old, as `<package>@<version>`, never `@latest`. npm
  also runs with `--before` set to 3 days ago, and pnpm with its minimum release age
  and `strict`, so neither takes a younger dependency either.
- **bun, yarn, Volta and Vite+.** These can't hold a provider's dependencies to a
  minimum age, so they get no 3-day update. Settings says so. Update to latest still
  runs their own install, or you can install the provider with npm or pnpm to have it
  updated automatically.
- **The vendors' own installers.** For Claude Code, Codex and OpenCode, native and npm
  releases share version numbers, so the version is the newest npm release whose own
  npm publish date is at least 3 days old. The update passes it to the vendor's updater:
  - Claude Code (`~/.local/bin/claude`): `claude install <version>`, never
    `claude update`. The version is also no higher than the one on your Claude Code
    update channel, which only sets that ceiling (rule
    `provider/claude-native-updates-minimum-age`). If that lookup fails, nothing runs.
  - Codex's standalone install: `codex update` with `CODEX_RELEASE=<version>`, which
    Codex's installer installs.
  - OpenCode (`~/.opencode/bin/opencode`): `opencode upgrade <version>`.
- **Grok.** How Grok updates depends on how it was installed:
  - Installed with npm or pnpm: it updates through npm or pnpm, as above (rule
    `provider/grok-npm-updates`).
  - Installed with Grok's own installer (`~/.grok/bin/grok`, linked to a build in
    `~/.grok/downloads/`): `grok update`, with `GROK_INSTALLER=internal` and Grok's own
    version range narrowed to that one version (`GROK_MINIMUM_VERSION` and
    `GROK_MAXIMUM_VERSION` set to it). Grok then downloads its own build of exactly
    that version (from `x.ai`, or by the same name from Grok's storage mirror), or
    installs nothing if its channel has moved below it, short of the required minimum
    below. The version is the newest one
    this server first saw on Grok's stable channel at least 3 days ago, and no newer
    than the version the channel names now (rule `provider/grok-native-updates`). A
    version that existed when the server first saw it is at least as old as that. Grok
    usually releases daily, so the server keeps when it first saw each version, in
    `~/.blacksand/t3/userdata/blacksand-first-seen.json`. It's in the account that runs
    the server, and it outlasts restarts. If the channel can't be read, or no version
    has been seen there for 3 days, nothing runs. If the channel moves back to an older
    version, nothing above it is offered. A version it names again later waits 3 days
    from then. A minimum version Grok's config or environment requires
    (`required_minimum_version`) wins over that range: Grok then installs the required
    minimum, which may be newer. That's why native Grok never updates by itself.
  - Installed any other way, or with a Homebrew cask: Update to latest only.
- **Installers that can't install a specific version.** `brew upgrade` takes whatever
  Homebrew's tap names, Pi's `pi update --self` whatever Pi's site names, and Muse's
  launcher whatever Muse's channel names. So does any updater a later T3 Code release
  adds, until blacksand-t3 knows how to give it a version. These get no 3-day update.
  Settings shows the command and says why. For a provider on npm, it also says that an
  npm or pnpm install updates automatically. Update to latest runs them when you press
  it. Why they get no 3-day update:
  - Homebrew: `brew upgrade` has no version argument, and installing an older formula
    would mean maintaining a tap. Install the provider with npm or pnpm, or its own
    installer where one is listed above, to have it updated automatically.
  - Pi: `pi update --self` always asks `pi.dev` for the latest version. Pi's own
    installer has no version argument T3 could pass it. Install Pi with npm or pnpm to
    have it updated automatically.
  - Muse: the launcher installs whatever Muse's channel names when it runs, and takes
    no version. Installing an exact Muse build would mean T3 doing the launcher's work
    itself: its Meta sign-in, release manifest, checksum and install layout. That's
    too much code to keep in step safely.

## Update to latest

Each provider's page in Settings → Providers has **Update to latest**. It installs the
newest release now, without the 3-day wait. It runs only when you press it: never on
its own, and never from Update all. It's a deliberate exception to the 3-day rule, so
you can take a release the day it ships when you choose to (rule
`provider/update-to-latest`). It runs the vendor's own update:

| Install | Update to latest runs |
|---|---|
| npm | `npm install -g <package>@latest`, without `--before` |
| pnpm | `pnpm add -g <package>@latest`, without the minimum release age (your own pnpm settings still apply) |
| bun, yarn, Volta, Vite+ | their own global install of the package |
| Claude Code (native) | `claude update` |
| Codex (standalone) | `codex update` |
| OpenCode (native) | `opencode upgrade` |
| Grok (Grok's installer, or any other install it updates itself) | `grok update` |
| Homebrew | `brew upgrade <formula>`, or `brew upgrade --cask <cask>` |
| Pi | `pi update --self` |
| Muse | its launcher, with `MUSE_SYNC_UPDATE=1`, as upstream runs it |

The background switches below stay set for these commands, and none of them stops an
explicit update. Anthropic's documentation says `DISABLE_AUTOUPDATER` "only stops the
background check; `claude update` and `claude install` still work" (only
`DISABLE_UPDATES` blocks them), and Claude Code's update command doesn't read
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Grok reads `GROK_DISABLE_AUTOUPDATER`, and
OpenCode `OPENCODE_DISABLE_AUTOUPDATE`, only for their background checks. Muse's update
command sets `MUSE_NO_AUTO_UPDATE=0` for that one run, as upstream's does.

## The vendors' own auto-update settings

No update blacksand-t3 runs changes a vendor's auto-update setting:

- **Grok.** `grok update --version <version>` also writes `cli.auto_update = false` to
  your Grok config, so blacksand-t3 never runs it. Its 3-day update narrows Grok's
  version range in that one command's environment instead, and Update to latest runs
  plain `grok update`. Neither branch writes `auto_update`. Both write your Grok config
  another way, as any `grok update` does: a successful install by Grok's own installer
  always saves `installer = "internal"`, even over another installer named there. That's
  which installer Grok uses, not whether it updates itself.
- **Claude Code.** `claude install <version>` saves `autoUpdatesChannel` only when given
  a channel name (`latest` or `stable`), never a version. blacksand-t3 only gives it a
  version.
- **OpenCode.** `opencode upgrade` writes no configuration.
- **Codex.** Codex writes no setting either, but its installer keeps a marker of a
  standalone install that follows its latest channel
  (`~/.codex/packages/standalone/auto-update-version`). Installing a specific version
  deletes it, and `codex update` or Update to latest writes it again. Codex's
  app-server daemon only updates itself while that marker names its release. A daemon
  in its own package (`~/.codex/packages/app-server-daemon`) isn't affected. A daemon
  still running from the standalone package, an older layout, would stop updating
  itself after a 3-day Codex update, so the automatic update skips that install. Update
  now there is your choice, and Update to latest writes the marker again.

## Background auto-updates

A CLI that updates itself in the background installs its channel's newest build,
however young, with no Update pressed. Every Claude Code, Grok, OpenCode and Muse
process blacksand-t3 starts runs with that CLI's switch turned off, set after the
instance's environment, so an instance's own environment can't turn it back on:

- Claude Code: `DISABLE_AUTOUPDATER=1` (rule `provider/claude-autoupdater-off`), as well
  as the switch for nonessential traffic
  ([privacy](../security/privacy.md#the-agent-clis)).
- Grok: `GROK_DISABLE_AUTOUPDATER=1`, for sessions, text generation and probes alike
  (rule `provider/grok-autoupdater-off`).
- OpenCode: `OPENCODE_DISABLE_AUTOUPDATE=1`, for its server, its version probe and
  `opencode upgrade` (rule `provider/opencode-autoupdate-off`). OpenCode's server mode
  doesn't update itself today; this keeps it that way.
- Muse: `MUSE_NO_AUTO_UPDATE=1` (rule `provider/muse-autoupdate-off`). Its launcher
  otherwise updates itself and Muse on any launch. Upstream sets it too, but an
  instance's environment could turn it back on.

These switches are what keep the 3-day wait inside blacksand-t3: the CLIs it starts
update only through the automatic updates and buttons above. They're set on each
process and nothing else. They change no setting of the vendor's, and a CLI you start
yourself, outside blacksand-t3, still updates the way its own settings say.

Codex and Pi, as T3 Code runs them, only say that an update is out. Kiro updates itself
in the background unless its `app.disableAutoupdates` setting is on. That's a setting in
Kiro's own files, not a switch blacksand-t3 can set on the process, and blacksand-t3
doesn't edit your settings. To turn it off, run
`kiro-cli settings app.disableAutoupdates true` in each account that runs Kiro.

## The automatic version checks

For the automatic updates and Update now, each server checks for the newest version, at
least 3 days old, of each CLI it has installed. It asks npm's registry. For a natively installed Claude Code
it also asks Anthropic's release channel (`downloads.claude.ai`), on the channel your
Claude Code settings choose. For a Grok installed with Grok's own installer it asks
Grok's stable channel (`https://x.ai/cli/stable`) instead of npm, and notes when it
first saw each version there. Each of these requests names only the channel and sends
no trace headers. It never asks T3. With the checks turned off, pressing Update still
asks, so a Grok version's 3 days then start from the first press. Muse's channel gives no publish date, so nothing shows a
Muse version is 3 days old: the server doesn't ask it, and reports no Muse version
(rule `provider/muse-version-check-off`). An earlier build kept a record in
`~/.blacksand/t3/userdata/blacksand-muse-first-seen.json`; nothing reads it now, and
you can delete it.

These checks are an accepted exception to the stripping of outbound calls. They stay
so that the automatic updates and Update now work. They're on by default. To stop them, turn off **Settings →
Maintenance → Provider update checks**. The bundled model list stays bundled either
way.

## ACP Registry agents

ACP Registry agents install only as npm or PyPI packages, through `npx` or `uvx`. They
are held to the same 3 days. npm runs with `--before`, and uv with `--exclude-newer`
(rule `acp-registry/installs-minimum-age`). The app marks an agent that ships only a
prebuilt binary as "not supported in T3 Code (blacksand)". blacksand-t3 never downloads such
a binary, reuses one from an earlier download, or puts one on the terminal's `PATH`
(rule `acp-registry/no-prebuilt-binaries`).
