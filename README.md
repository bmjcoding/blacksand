# Blacksand

Blacksand is a hardened, self-updating home for coding agents. One repository and
one command, `blacksand`, describe what each machine runs: the desktop app you work
in, the accounts and sandboxes agents run in, and what those are allowed to reach.
A machine takes a change only when the owner's SSH key signed it, and checks that
for itself before acting.

It's pre-release. What works today and what's still being built are listed under
[Status](#status).

## Packages

| Package | What it is |
|---|---|
| [`packages/t3`](packages/t3#readme) | **Blacksand T3**: [T3 Code](https://github.com/pingdotgg/t3code) built from upstream source with its telemetry, stock auto-updater and other calls home removed. Each machine rebuilds the release this repository pins, after checking that release itself. |
| [`packages/substrate-k8s`](packages/substrate-k8s#readme) | **Coding agents in per-run Kubernetes sandboxes**: Claude Code or Codex runs one task in a fresh gVisor sandbox with no provider key and no direct network. Its only way out is a per-run proxy that holds the key, allows only the run's granted model operation and models, and records every connection. You get the patch and a sealed run record. |

## The `blacksand` command

```sh
./blacksand status     # what this machine runs, and what discovery sees on it
./blacksand plan       # the steps that would bring this machine to its config (applies nothing)
./blacksand verify     # this clone's signed history and files, and the machine against what was applied
./blacksand t3 …       # the T3 package: update, check, drift, preview, rollback, evaluate
./blacksand k8s …      # coding-agent runs in Kubernetes sandboxes
```

`blacksand help <command>` gives each command's usage. Exit codes: 0 passed,
1 drift, 2 usage, 3 held, 4 refused.

## How changes are trusted

- **Signed history.** Every commit is signed with SSH. `.allowed_signers` lists the
  keys, and each commit is judged by the list in its first parent, so adding a
  signer takes a commit an existing signer made.
- **Bounded automation.** The CI evaluator has its own key. A commit it signs may
  only move `pin.json` forward to a real upstream release, and every machine checks
  that again before taking it.
- **Checked before acting.** `blacksand verify` walks the history itself and
  compares the working tree with the commit it verified. It refuses anything else
  rather than guessing.
- **Simple over clever.** It has zero runtime dependencies: Node runs the
  TypeScript directly, and development tools are pinned with their integrity hashes.

More in [SECURITY.md](SECURITY.md) and the [threat model](docs/security/threat-model.md).

## Status

| Area | Today | Planned |
|---|---|---|
| Blacksand T3 desktop app, macOS and Linux | installs with `packages/t3/install.sh`; updates through `blacksand t3` | installed by `blacksand apply` |
| Always-on agent host | macOS, with setup scripts | `blacksand apply` replaces the scripts; Linux hosts |
| `status`, `plan`, `verify` | read-only, on macOS and Linux | `apply`, with a journal and receipts |
| Kubernetes sandboxes | k3s on one node | EKS |

## Getting started

Check the [prerequisites](docs/getting-started/prerequisites.md), then clone and put
the clone at the commit you trust ([how](docs/install/clone.md#put-it-at-the-commit-you-trust)):

```sh
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
```

- **The desktop app:** [Blacksand T3](packages/t3#readme). The [documentation map](docs/README.md)
  covers installing it, hosts, remote access and updates.
- **Sandboxed agent runs:** [substrate-k8s](packages/substrate-k8s#readme).

## Contributing and security

To report a vulnerability, see [SECURITY.md](SECURITY.md). To contribute, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT ([LICENSE](LICENSE)). T3 Code is MIT-licensed by T3 Tools Inc. ([NOTICE](NOTICE)).
