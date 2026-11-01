# Contributing

Issues and pull requests are welcome. Report vulnerabilities privately, as
[SECURITY.md](SECURITY.md) describes, not in issues.

## How changes reach `main`

A machine running Blacksand T3 fast-forwards to `main` only when every new commit
carries an SSH signature from a key in `.allowed_signers`. That includes commits on
side branches. [Self-update](packages/t3/docs/updates/self-update.md) has the details.

The list holds two keys: the owner's, and the CI evaluator's, which may sign only pin
moves. So:

- **Pull requests aren't merged as they are.** A contributor's commits aren't signed by
  a listed key, and every machine would refuse history that contains them. The owner
  applies an accepted change as a new commit they sign, and credits you with
  `Co-authored-by:`.
- **Don't use GitHub's merge or squash buttons for `main`.** GitHub signs those commits
  with its own OpenPGP key, and self-update refuses OpenPGP signatures.
- **No force-push or branch deletion.** The `main` ruleset blocks both.

## Changes that need extra evidence

These files decide what every machine trusts, what a build may contact, or what a
sandbox may do. A change to them needs a reason in the pull request, and the owner's
signature to land:

| File | What it controls |
|---|---|
| `.allowed_signers` | who may sign commits machines take |
| `src/trust/` | how a machine checks those signatures |
| `package.json`, `package-lock.json`, `.npmrc` | the dev dependencies (TypeScript, Node's types and fast-check), pinned with integrity hashes |
| `packages/substrate-k8s/sandbox/proxy.ts` | what a sandbox may reach, and which model requests it may send |
| `packages/substrate-k8s/src/node.ts` | the node egress floor |
| `packages/substrate-k8s/src/manifests.ts` | the sandbox Pod's lockdown |
| `packages/substrate-k8s/images/agent-tools.sh` | the pinned agent binaries |
| `packages/t3/lib/rules.mjs`, `packages/t3/lib/features.mjs` | what is stripped and replaced, and which rules may be left out |
| `packages/t3/lib/known-hosts.txt` | hosts upstream's source may name without failing the update |
| `packages/t3/lib/native-assets.json`, `packages/t3/lib/known-device-tools.txt` | prebuilt files and device tool versions the app may install |
| `packages/t3/lib/overrides.json`, `packages/t3/lib/known-resolutions.txt` | security overrides, and non-registry dependency sources |
| `packages/t3/lib/pnpm.mjs` | the pinned pnpm and its digests |

For a T3 rule change, include the output of `blacksand t3 check` against the pinned
release, and say which upstream commit moved the code.

## Before you open a pull request

Once per clone:

```sh
npm ci                                # TypeScript and fast-check, for the type check and tests: pinned, no install scripts
git config core.hooksPath .githooks   # the pre-push hook below
```

The hook takes a few seconds. It runs the type check, the fast tests, and shellcheck on
the shell scripts the push changes. `git push --no-verify` skips it once. To run the
same checks by hand:

```sh
npm run typecheck    # tsc --noEmit, for src/ and tools/, then packages/t3's TypeScript tests
npm test             # the fast tier: under 10 s
npm run test:deep    # signed histories, installer runs, real timeouts, property sweeps
```

A test file named `*.deep.test.*` is in the deep tier. Every other `*.test.*` file is
in the fast tier. [tools/test.ts](tools/test.ts) says what belongs where. CI runs both.

Property tests use fast-check, in `fuzz-*.ts` and `*-property.test.ts` files. They run
a fixed seed in the fast tier and a fresh one in the deep tier. A failure prints the
seed and the command that replays it ([tools/fuzz.ts](tools/fuzz.ts)).

Changes under `packages/t3/bin/`, `packages/t3/lib/` or `packages/t3/test/stripped/`
also need a full build. Either run
`BLACKSAND_T3_UNISOLATED_BUILD=1 blacksand t3 check --build` in a checkout that isn't
an install, or let the `build.yml` workflow run.
[Testing](packages/t3/docs/security/testing.md) describes the suite.

Changes to the Kubernetes sandbox also need its deep tests on a real cluster.
`packages/substrate-k8s/test/journey.deep.test.ts` lists the environment it needs.

- One change per pull request. A commit message describes the behaviour, not the
  process that led to it.
- Keep claims in docs precise. Say what a control does and what it doesn't.
- Add or update the test that would fail without your change.
- Never commit personal data, hostnames, tokens or keys. Use the placeholders the docs
  use, such as `t3b-host`, `agent-claude` and `<owner>`.
