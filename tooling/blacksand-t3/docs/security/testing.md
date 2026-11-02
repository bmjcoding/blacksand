# Testing

> **Applies to:** the repository. The suite runs on macOS and Linux (CI: Ubuntu 24.04).

## Run it

```sh
npm ci              # once: the pinned dev dependencies, no install scripts
npm test            # the fast tier, a few seconds
npm run test:deep   # the deep tier: signed histories, installer runs, property sweeps
```

The suite needs Node 24 or later and git 2.55.0 or later. The deep tier takes about a
minute on a recent Mac. [CONTRIBUTING.md](../../../../CONTRIBUTING.md) says what
belongs in each tier. The suite works in throwaway folders, repositories and SSH keys,
with local fakes for npm, GitHub, OSV and tailscaled. It doesn't touch your clone,
`~/.ssh`, `~/.blacksand/t3` or the installed app. CI runs it on every push and pull
request (`ci.yml`), and again before each evaluation (`evaluate.yml`).

Five tests run only if you opt in:

| Variable | What the test then does |
|---|---|
| `BLACKSAND_T3_TEST_ELECTRON=<Electron binary>` | runs a real Electron app: an agent's frame reaches nothing over WebRTC, and device video arrives only through the WebRTC window |
| `BLACKSAND_T3_REAL_PNPM=<pinned pnpm>` (two tests) | checks the real pinned binary, and that a project asking for another pnpm still runs it |
| `BLACKSAND_T3_TEST_PACKED_APP=<T3 Code (blacksand).app>` | runs the phone service's supervisor, the SSH runner sharing its server, an update, and shutdown, against a real packed build |
| `BLACKSAND_T3_PNPM_DIGESTS_ONLINE=1` | downloads the four pinned pnpm tarballs, and checks `PNPM_BINARY_SHA256` against them |

The tests in `tooling/blacksand-t3/test/stripped/` run inside a stripped upstream checkout,
in upstream's own Vitest and Playwright setup. `build.yml` runs them after each build
(`node ci/stripped-tests.mjs build/work`, from `tooling/blacksand-t3`). They cover the
injected files: the CSP in each place it's applied, the WebRTC window, provider and
ACP Registry release ages, device tools, release links, update requests, the SSH
runner, the CLI's routes, and the interface settings.

## How it's organised

Files are named by behaviour, with a prefix for the area:

| Prefix | Covers |
|---|---|
| `agent-accounts`, `ssh-runner`, `shared-dir` | agent account isolation, SSH settings and the source filter; the runner agent accounts start servers through; the folder they share with the updater |
| `screen-sharing-*`, `phone-*`, `tailscale-serve` | Screen Sharing's checks and commands; the phone service; atomic Serve changes against a fake tailscaled LocalAPI |
| `install`, `install-config`, `build-tools`, `update-lock` | `install.sh`, the build account, root's build tools and their lock, the update lock |
| `self-update`, `commit-trust`, `pin-trust`, `git-isolation`, `github-token` | commit and pin trust, fresh-clone verification, git configuration isolation, token handling |
| `dependency-*`, `device-tool*`, `native-assets`, `pinned-pnpm`, `advisories`, `trust-*` | dependency identity and age, local sources, device tool closures, native archives, the pnpm pin, advisory sources, the fast lane, the parsers trust decisions rest on |
| `build-*`, `strip-rules`, `app-*`, `privacy-text` | the strip engine and rules, the tripwire, the smoke test, the staged install guard, WebRTC, stock guidance, app activation and rollback |
| `pipeline-*`, `alerts-*` | CI's evaluator, `pin-check`, inventories and stage records; the alert job's GitHub issues |
| `cli-state`, `scheduled-jobs` | rollback and recovery from the CLI; launchd and systemd jobs |

The tests source shell scripts to call their functions, and stub system commands
such as `launchctl`, `dscl`, `lsof` and `sudo` over a scratch folder. Where a real
program decides the outcome, the tests use that program. Apple's sshd evaluates the
generated drop-in, real git and SSH keys sign and verify commits, and a scratch sshd
takes a real login.

## Kinds of tests

- **Unit and behaviour tests.** These make up most of the suite. Each file's header
  says what behaviour it pins, and why.
- **Property tests.** They use fixed seeds, so a failure names its seed.
  - `alerts-property` runs random sequences of hourly alert runs, with failures
    injected, against an oracle that has its own model of what the owner was told.
    `T3B_PROPERTY_SEEDS=<n>` runs more seeds, and `T3B_PROPERTY_SEED=<n>` reruns one.
  - `commit-trust` checks random signer changes, signers and batch splits. Hourly
    self-update and a fresh clone's walk must agree with a model of the trust rule.
- **Positive controls.** Where a test proves that something is refused, a control
  shows that the test would catch the case if the refusal were missing. For example,
  unstripped upstream trips the tripwire, and upstream's runner lines lose the race
  the rule fixes.
- **Mutation testing.** This was done by hand while the security-relevant areas were
  written. Each time, a deliberate defect went into the code under test, and the suite
  had to fail. The repository has no mutation tool, so CI can't reproduce these
  results.

## What was exercised natively

In fresh macOS 27.2 VMs on Apple silicon, with a real packed build and ad-hoc signing
in place of the owner's certificate:

- `install.sh --role host` and `--role ui`, end to end, including build-tool
  contention, interruption and repair;
- the build tools' lock policy: an agent account was denied;
- agent accounts, the default source filter and `--allow-from` (a LAN address with a
  valid key was refused), and 24 concurrent SSH launches sharing one server;
- the phone service: install, boot with nobody logged in, sharing with SSH, updates,
  crashes, a slow start, and pairing and session checks against the real server;
- Screen Sharing: install, the port-holding jobs (96 bind attempts by an agent
  account, all refused), sign-in by the admin only, the check's responses to five rule
  changes, `--off`, `--uninstall`, and no LAN reach across ordinary reboots. Killing
  the check while it loads Screen Sharing, then rebooting, gave about 2 s of LAN reach,
  a documented limit. During swaps, an agent did capture port 15900. The checks
  detected it and refused transitions. This shows detection and an availability
  limit, but the jobs don't hold the port without interruption. Real Serve forwarding
  and existing-session teardown weren't tested;
- fresh-clone trust on synthetic histories: refusing evaluator self-promotion,
  signer rotation, shallow clones, a clock ahead, and rollback of the verification
  record.

Linux's desktop role ran in containers (Ubuntu 24.04, Rocky 9, Fedora 44, Arch).

## What only real hardware or credentials can verify

- the owner's Apple Development certificate: importing it, signing with it, and an
  unattended app replacement under that identity;
- Keychain access without prompts after an update;
- a real tailnet: Serve forwards, policy grants and tests, HTTPS certificates, and
  routing from LAN peers;
- Screen Sharing with a picture (VM screens stayed black), and System Settings' real
  switches;
- a real phone: pairing, revocation and the stock app;
- FileVault unlock over SSH after a restart;
- provider sign-in and agent turns, in an agent account, from the desktop UI;
- Android Emulators (no nested virtualization in macOS VMs), physical devices, and
  multi-account device video over Tailscale;
- on Linux: opening the app, the systemd timer firing, Ubuntu's AppArmor profile, and
  RHEL's `subscription-manager` step.

The [worked example's verification rows](../getting-started/example-desktop-and-host.md#verification)
check these on your own machines.
