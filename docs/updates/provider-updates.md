# Provider CLI and agent updates

> **Applies to:** every account that runs a T3 Blackout server, macOS and Linux.

The agent CLIs (Claude Code, Codex, …) aren't part of the T3 Blackout build. They
update separately.

## From Settings → Providers

The app's Update (rule `provider/updates-minimum-age`) waits until a version is 3
days old, but only where the installer can enforce that on the whole install:

- **npm and pnpm** install exactly the version the check reported, the newest at
  least 3 days old. npm runs with `--before` set to 3 days ago, and pnpm with its
  minimum release age and `strict`, so neither takes anything younger.
- **bun, yarn, Volta and Vite+** can't hold a provider's dependencies to a minimum
  age, so T3 Blackout doesn't update a provider installed with them. Settings says
  so, and asks you to update it with npm or pnpm, or with its own updater.
- **Not held back:** a provider installed with its vendor's own installer is updated
  by that updater (a natively installed Claude Code: `claude update`). A Homebrew
  install is updated by `brew upgrade`. Both install the newest build. So do the
  vendors' updaters you run yourself (`claude update`, `codex update`), and the CLIs'
  own auto-updates.

So install CLIs with npm or pnpm ([providers](../accounts/providers.md)).

## The automatic version checks

To offer Update, each server checks for the newest version at least 3 days old of
each CLI it has installed. It asks npm's registry, and for Muse, Meta's release
channel; it never asks T3. Muse's channel gives no publish date, so a Muse version is
reported only once that server has seen it on the channel for 3 days. That's recorded
in `~/.t3blackout/userdata/blackout-muse-first-seen.json` in each account that runs a
server. These checks are an accepted exception to stripping outbound calls, kept so
Update works. They're on by default. Turn off **Settings → Maintenance → Provider
update checks** to stop them. The bundled model list stays bundled either way.

Claude Code's switch for nonessential traffic, which T3 Blackout sets
([privacy](../security/privacy.md#the-agent-clis)), also stops its background
auto-updater while T3 Blackout runs it.

## ACP Registry agents

ACP Registry agents install only as npm or PyPI packages (`npx`, `uvx`), held to the
same 3 days: npm with `--before`, uv with `--exclude-newer` (rule
`acp-registry/installs-minimum-age`). An agent that ships only a prebuilt binary is
"not supported in T3 Blackout". Binaries are never downloaded, reused from an earlier
download, or put on the terminal's `PATH` (rule `acp-registry/no-prebuilt-binaries`).
