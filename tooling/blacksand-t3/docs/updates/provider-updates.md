# Provider CLI and agent updates

> **Applies to:** every account that runs a blacksand-t3 server, macOS and Linux.

The agent CLIs, such as Claude Code and Codex, aren't part of the blacksand-t3 build.
They update separately.

## From Settings → Providers

The app's Update button (rule `provider/updates-minimum-age`) waits until a version is
3 days old. It does this only where the installer can enforce that age on the whole
install:

- **npm and pnpm.** They install exactly the version the check reported, which is the
  newest version at least 3 days old. npm runs with `--before` set to 3 days ago.
  pnpm runs with its minimum release age and `strict`. So neither takes anything
  younger.
- **bun, yarn, Volta and Vite+.** These can't hold a provider's dependencies to a
  minimum age, so blacksand-t3 doesn't update a provider installed with them. Settings
  says so, and asks you to update the provider with npm or pnpm, or with its own
  updater.
- **Claude Code's native installer.** For a natively installed Claude Code
  (`~/.local/bin/claude`), Update runs `claude install <version>` with an exact
  version, never `claude update` (rule `provider/claude-native-updates-minimum-age`).
  That version is the newest npm release whose own npm publish date is at least 3
  days old, and no higher than the version on your Claude Code update channel. The
  channel only sets that ceiling. Native and npm releases share version numbers. If
  either lookup fails, or no npm release qualifies, Update offers nothing.
- **Installers that aren't held back.** The vendor's own updater updates a provider
  installed with another vendor installer, such as Codex's. `brew upgrade` updates a
  Homebrew install. Both install the newest build. So do the vendor updaters you run
  yourself (`claude update`, `codex update`) and the CLIs' own auto-updates.

So install CLIs with npm or pnpm ([providers](../accounts/providers.md)).

## The automatic version checks

To offer Update, each server checks for the newest version, at least 3 days old, of
each CLI it has installed. It asks npm's registry, and for Muse it asks Meta's release
channel. For a natively installed Claude Code it also asks Anthropic's release channel
(`downloads.claude.ai`), on the channel your Claude Code settings choose. That request
names only the channel and sends no trace headers. It never asks T3. Muse's channel
gives no publish date, so the server reports a Muse version only after it has seen
that version on the channel for 3 days. It records what it has seen in
`~/.blacksand/t3/userdata/blacksand-muse-first-seen.json`, in each account that runs a
server.

These checks are an accepted exception to the stripping of outbound calls. They stay
so that Update works. They're on by default. To stop them, turn off **Settings →
Maintenance → Provider update checks**. The bundled model list stays bundled either
way.

blacksand-t3 sets Claude Code's switch for nonessential traffic
([privacy](../security/privacy.md#the-agent-clis)). That switch also stops Claude
Code's background auto-updater while blacksand-t3 runs it.

## ACP Registry agents

ACP Registry agents install only as npm or PyPI packages, through `npx` or `uvx`. They
are held to the same 3 days. npm runs with `--before`, and uv with `--exclude-newer`
(rule `acp-registry/installs-minimum-age`). The app marks an agent that ships only a
prebuilt binary as "not supported in T3 Code (blacksand)". blacksand-t3 never downloads such
a binary, reuses one from an earlier download, or puts one on the terminal's `PATH`
(rule `acp-registry/no-prebuilt-binaries`).
