# Contributing

Issues and pull requests are welcome. Report vulnerabilities privately
([SECURITY.md](SECURITY.md)), not in issues.

## How changes reach `main`

Every machine running T3 Blackout fast-forwards to `main` only when every new
commit, on side branches too, carries an SSH signature from a key listed in
`.allowed_signers` ([self-update](docs/updates/self-update.md)). That list holds
the owner's key and the CI evaluator's key, which may sign only pin moves. So:

- **Pull requests aren't merged as they are.** A contributor's commits aren't
  signed by a listed key, and every machine would refuse history that contains
  them. The owner applies an accepted change as a new commit they sign, crediting
  you (`Co-authored-by:`).
- **Don't use GitHub's merge or squash buttons for `main`.** GitHub signs those
  commits with its own key (OpenPGP), and self-update refuses OpenPGP signatures.
- **No force-push or branch deletion.** The `main` ruleset blocks both.

## Changes that need extra evidence

These files decide what every machine trusts or what a build may contact. A change
to them needs a reason in the pull request, and the owner's signature to land:

| File | What it controls |
|---|---|
| `lib/rules.mjs`, `lib/features.mjs` | what is stripped and replaced, and which rules may be left out |
| `lib/known-hosts.txt` | hosts upstream's source may name without failing the update |
| `.allowed_signers` | who may sign commits machines take |
| `lib/native-assets.json`, `lib/known-device-tools.txt` | prebuilt files and device tool versions the app may install |
| `lib/overrides.json`, `lib/known-resolutions.txt` | security overrides, and non-registry dependency sources |
| `lib/pnpm.mjs` | the pinned pnpm and its digests |

For a rule change, include the output of `bin/t3blackout check` against the pinned
release, and say which upstream commit moved the code.

## Before you open a pull request

```sh
node --test test/*.test.mjs
shellcheck -S warning install.sh scripts/*.sh
```

Changes under `bin/`, `lib/` or `test/stripped/` also need a full build:
`T3BLACKOUT_UNISOLATED_BUILD=1 bin/t3blackout check --build` (in a checkout that
isn't an install), or let the `build.yml` workflow run. [Testing](docs/security/testing.md)
describes the suite.

- One change per pull request. A commit message describes the behaviour, not the
  process that led to it.
- Keep claims in docs precise. Say what a control does and what it doesn't.
- Add or update the test that would fail without your change.
- Never commit personal data, hostnames, tokens or keys. Use the placeholders the
  docs use (`t3b-host`, `agent-claude`, `<owner>`).
