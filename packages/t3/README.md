# Blacksand T3

Blacksand T3 builds [T3 Code](https://github.com/pingdotgg/t3code) from upstream
source with its telemetry, stock auto-updater and other calls home removed. Each
machine rebuilds the release this repository pins, after checking that release
itself. Optionally, coding agents run in separate macOS accounts on an always-on
host, which the desktop app reaches over SSH.

## What it protects against

It stops T3 Code from sending usage data or contacting T3's services. It holds back
new third-party dependency versions for 3 days, unless a version is a vetted security
fix. A machine takes repository changes only when the owner's SSH key
signed them. The CI evaluator's key may sign pin moves, but only forward ones to
real upstream releases, and every machine checks those again. Upstream's build
scripts run in an unprivileged account. On a host, agents run in standard
accounts that log in over SSH with one key only. It doesn't limit what the agents
reach on the network, audit upstream's code, or protect a machine whose admin
account is compromised. The full picture is in the
[threat model](docs/security/threat-model.md).

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

How each of these is enforced and checked, and how to check it yourself:
[privacy](docs/security/privacy.md).

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
Then run `packages/t3/install.sh`. For a desktop plus an always-on host, follow
[the worked example](docs/getting-started/example-desktop-and-host.md).

## If the app won't start

The app's startup error links here.

- **Go back one build:** `blacksand t3 rollback`.
- **Rebuild the release you're on:** quit the app, then run
  `blacksand t3 update --force`.
- The last update's log is `packages/t3/state/blacksand-t3.log` in your clone.

More in [troubleshooting](docs/troubleshooting.md).

## Documentation

Start with the [documentation map](docs/README.md). To report a vulnerability, see
[SECURITY.md](../../SECURITY.md). To contribute, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

MIT ([LICENSE](../../LICENSE)). T3 Code is MIT-licensed by T3 Tools Inc.
([NOTICE](../../NOTICE)).
