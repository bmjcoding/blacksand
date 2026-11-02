# Provider CLIs and sign-in

> **Applies to:** macOS agent accounts (host and standby lane). On a desktop's Local
> environment, install and sign in to the CLIs in your own account as usual.

Do this inside each agent account. From your admin account on the host, run
`ssh agent-claude@localhost`. For the standby lane, run
`ssh -p 2222 agent-standby@127.0.0.1` instead.

## The account's PATH

The agent account has none of your shell setup, and it can't write Homebrew's global
npm folder. Put Homebrew's tools and its own npm folder on its `PATH` in
`~/.zprofile`. The server reads `PATH` from the account's login shell.

```sh
cat >> ~/.zprofile <<'EOF'
# blacksand-t3 agent account: Homebrew's tools (read-only) and this account's own npm installs.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
EOF
exec zsh -l
```

## Install the CLI

Point npm's global installs at that folder, so the app's provider updates use it
too. Then install with a 3-day minimum age:

```sh
npm config set prefix "$HOME/.npm-global"
npm install -g --before="$(node -p 'new Date(Date.now() - 3 * 86400000).toISOString()')" --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
```

- `--before` takes the newest versions at least 72 hours old, the same minimum age
  the app's own provider updates use.
- `--allow-scripts=@anthropic-ai/claude-code` lets Claude Code's install script run,
  and no other. That script puts the native `claude` binary in place. npm 12 blocks
  install scripts it hasn't been told to allow. Without the flag, `claude` only
  prints `Error: claude native binary not installed.` Codex has no install script.
- **Other providers.** Cursor needs no CLI. T3 uses its bundled SDK, and you sign in
  from T3. T3 manages Antigravity's runtime itself. Install other CLIs the same way
  where they publish on npm. Add `--allow-scripts=<package>` for one that has an
  install script, such as Grok's `@xai-official/grok`. The 3-day minimum doesn't
  apply to curl installers (Muse, fx, Cursor's own CLI).
- **Projects.** Keep them in a folder like `~/src`, not `~/Desktop`, `~/Documents`
  or `~/Downloads`. With "Allow full disk access for remote users" off, macOS
  privacy controls block SSH sessions from those folders.

Install only the CLIs this account should run, and use npm or pnpm. The app's Update
keeps those installs to the 3-day minimum
([provider updates](../updates/provider-updates.md)).

Check from a fresh session, from your admin account:

```sh
ssh agent-claude@localhost 'zsh -ilc "command -v node npm claude codex; claude --version; codex --version"'
```

`command -v` finds each command, with `claude` and `codex` under
`~/.npm-global/bin`. Both print a version.

## Sign in

- **Codex.** Run `codex login`. Open the URL it prints in the browser of your admin
  session on the same Mac, because its callback goes to this Mac's loopback. If that
  doesn't complete, `codex login --device-auth` signs in with a code instead. Your
  ChatGPT account's or workspace's security settings must allow device code sign-in.
  `codex login status` confirms the login. Codex keeps its login in
  `~/.codex/auth.json`, which works over SSH.
- **Claude Code.** Claude Code normally keeps its login in the login Keychain, which
  an SSH session can't unlock (`security` error 36). Run `claude setup-token` and
  approve it in the browser. Then run `/usr/local/libexec/blacksand/set-claude-token`
  and paste the token at its hidden prompt. The helper stores it as
  `CLAUDE_CODE_OAUTH_TOKEN` in `~/.blacksand/t3/server.env`, readable by the owner
  only, with no ACL entries. The SSH runner loads that file, and refuses it if anyone
  else could read or replace it. The helper reads the token only from its prompt,
  never from arguments or the environment. Clear the terminal afterwards (⌘K), and
  don't paste the token anywhere else. Then switch that environment off and on in
  the app.
- **GitHub.** Don't log in to `gh` in agent accounts. At most, use a fine-grained
  token limited to the repositories that agent works on, with no `workflow`
  permission. To publish an agent's work without a token, fetch it into your own
  clone over SSH, review it there, and push from your account:
  `git fetch agent-claude@t3b-host:src/<project> <branch>`.

To check the token file, run `ls -le ~/.blacksand/t3/server.env`. It shows
`-rw-------`, owned by the agent, with no ACL lines.

The Claude token lasts a year. To replace it, run both commands again, then switch
the environment off and on. [Keys and incidents](../security/keys-and-incidents.md)
covers rotation and revocation for every token.
