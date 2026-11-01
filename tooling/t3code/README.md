# blacksand-t3

blacksand-t3 builds [T3 Code](https://github.com/pingdotgg/t3code) from upstream
source, with its telemetry, stock auto-updater and other calls home removed. Each
machine checks the release this repository pins, then builds it itself.

Coding agents can also run in separate macOS accounts on an always-on host. The
desktop app reaches them over SSH.

## What it protects against

- Every build removes T3 Code's usage reporting and its calls to T3's services.
- A new third-party dependency version waits 3 days before a build uses it. A vetted
  security fix can skip the wait.
- A machine takes repository changes only when the owner's SSH key signed them.
- The CI evaluator's key can sign one kind of change: moving a pin forward to a real
  upstream release. Every machine checks each of those moves again.
- Upstream's build scripts run in an unprivileged account.
- On a host, agents run in standard accounts. Each account logs in over SSH with one
  key.

It doesn't protect against:

- what the agents reach on the network;
- flaws in upstream's code, which it doesn't audit;
- a machine whose admin account is compromised.

The [threat model](docs/security/threat-model.md) has the full picture.

## What it removes, and what still connects out

Removed from every build:

- PostHog analytics and OpenTelemetry export
- T3 Connect, its Clerk sign-in and its relay
- the model-manifest and LiteLLM pricing fetches
- checks for new `t3` releases on npm, Google favicon lookups, and the GitHub star check
- the Electron auto-updater and downloads of upstream's prebuilt app and server
  (each update is a local rebuild instead)
- upstream's background service (`t3 up`), and text that sends you to stock T3

What still connects out:

- the agent CLIs, to their own providers
- automatic provider CLI version checks, which go to the npm registry (Muse uses
  Meta's release channel). They're on by default; turn them off in **Settings →
  Maintenance → Provider update checks**.
- the server, when it fetches GitHub images for a chat
- updates: GitHub, the npm registry, Electron's prebuilt runtime, and the advisory
  and release-list services the checks read
- device tools, when you turn device support on; EAS Simulator video (Expo's cloud),
  if you use it; and the pages you open in the preview browser

The [privacy page](docs/security/privacy.md) says how each of these is enforced, and
how to check it yourself.

## Platforms and roles

| Role | `install.sh` | macOS | Linux |
|---|---|---|---|
| Desktop: the app you work in | `--role ui` (default) | Yes | Yes (x64 and arm64; Arch/Omarchy, Ubuntu/Debian, Fedora/RHEL) |
| Always-on host: agent accounts reached over SSH | `--role host` | Yes | Not yet |
| Desktop with a standby agent account | `--role both` | Yes | Not yet |

[Roles and platforms](docs/getting-started/roles.md) explains each role, and lists
what Linux would need for the others.

## Quick start

Check the [prerequisites](docs/getting-started/prerequisites.md) first. Git must be
2.55.0 or later before you clone. Then:

```sh
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
```

Before running any script, [put the clone at the full commit SHA you trust](docs/install/clone.md#put-it-at-the-commit-you-trust).
Then run `tooling/t3code/install.sh`. For a desktop plus an always-on host, follow
[the worked example](docs/getting-started/example-desktop-and-host.md).

## If the app won't start

The app's startup error links here.

- **Go back one build:** `blacksand t3 rollback`.
- **Rebuild the release you're on:** quit the app, then run
  `blacksand t3 update --force`.
- The last update's log is `tooling/t3code/state/blacksand-t3.log` in your clone.

[Troubleshooting](docs/troubleshooting.md) covers more cases.

## Documentation

Start with the [documentation map](docs/README.md). To report a vulnerability, see
[SECURITY.md](../../SECURITY.md). To contribute, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

MIT ([LICENSE](../../LICENSE)). T3 Code is MIT-licensed by T3 Tools Inc.
([NOTICE](../../NOTICE)).
