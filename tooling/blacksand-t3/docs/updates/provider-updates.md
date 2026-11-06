# Provider CLI and agent updates

> **Applies to:** every account that runs a blacksand-t3 server, macOS and Linux.

The agent CLIs, such as Claude Code and Codex, aren't part of the blacksand-t3 build.
They update separately.

## From Settings → Providers

The app's Update button waits until npm's registry shows a version is 3 days old, and
then installs exactly that version. If the registry can't be reached, or no release is 3
days old yet, Update runs nothing and says so. An installer that can't install a
specific version isn't run: Settings shows its command and says why (rules
`provider/updates-minimum-age` and `provider/updates-exact-version`):

- **npm and pnpm.** They install exactly the version the check reported, which is the
  newest version at least 3 days old, as `<package>@<version>`, never `@latest`. npm
  also runs with `--before` set to 3 days ago, and pnpm with its minimum release age
  and `strict`, so neither takes a younger dependency either.
- **bun, yarn, Volta and Vite+.** These can't hold a provider's dependencies to a
  minimum age, so blacksand-t3 doesn't update a provider installed with them. Settings
  says so, and asks you to update the provider with npm or pnpm, or with its own
  updater.
- **The vendors' own installers.** Native and npm releases share version numbers, so
  the version is the newest npm release whose own npm publish date is at least 3 days
  old. Update passes it to the vendor's updater:
  - Claude Code (`~/.local/bin/claude`): `claude install <version>`, never
    `claude update`. The version is also no higher than the one on your Claude Code
    update channel, which only sets that ceiling (rule
    `provider/claude-native-updates-minimum-age`). If that lookup fails, Update offers
    nothing.
  - Codex's standalone install: `codex update` with `CODEX_RELEASE=<version>`, which
    Codex's installer installs.
  - OpenCode (`~/.opencode/bin/opencode`): `opencode upgrade <version>`.
- **Installers that can't install a specific version.** `brew upgrade` takes whatever
  Homebrew's tap names, Pi's `pi update --self` whatever Pi's site names, and Muse's
  launcher whatever Muse's channel names. So does any updater a later T3 Code release
  adds, until blacksand-t3 knows how to give it a version. Update doesn't run these.
  Settings shows the command and says why. Run it yourself when you choose to.
- **Grok.** `grok update --version <version>` does install that version, but nothing
  yet shows that the native build it downloads is the release npm dates. So Update
  leaves Grok to you too, the same way.

Updaters you run yourself (`claude update`, `codex update`, `grok update`) still install
the newest build. So install CLIs with npm or pnpm, or a vendor installer listed above
([providers](../accounts/providers.md)).

## Background auto-updates

A CLI that updates itself installs its channel's newest build, however young, with no
Update pressed. Every Claude Code, Grok, OpenCode and Muse process blacksand-t3 starts runs
with that CLI's switch turned off, set after the instance's environment, so an
instance's own environment can't turn it back on:

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

Codex and Pi, as T3 Code runs
them, only say that an update is out. A CLI you start yourself, outside blacksand-t3,
still updates the way its own settings say.

## The automatic version checks

To offer Update, each server checks for the newest version, at least 3 days old, of
each CLI it has installed. It asks npm's registry. For a natively installed Claude Code
it also asks Anthropic's release channel (`downloads.claude.ai`), on the channel your
Claude Code settings choose. That request names only the channel and sends no trace
headers. It never asks T3. Muse's channel gives no publish date, so nothing shows a
Muse version is 3 days old: the server doesn't ask it, and reports no Muse version
(rule `provider/muse-version-check-off`). An earlier build kept a record in
`~/.blacksand/t3/userdata/blacksand-muse-first-seen.json`; nothing reads it now, and
you can delete it.

These checks are an accepted exception to the stripping of outbound calls. They stay
so that Update works. They're on by default. To stop them, turn off **Settings →
Maintenance → Provider update checks**. The bundled model list stays bundled either
way.

## ACP Registry agents

ACP Registry agents install only as npm or PyPI packages, through `npx` or `uvx`. They
are held to the same 3 days. npm runs with `--before`, and uv with `--exclude-newer`
(rule `acp-registry/installs-minimum-age`). The app marks an agent that ships only a
prebuilt binary as "not supported in T3 Code (blacksand)". blacksand-t3 never downloads such
a binary, reuses one from an earlier download, or puts one on the terminal's `PATH`
(rule `acp-registry/no-prebuilt-binaries`).
