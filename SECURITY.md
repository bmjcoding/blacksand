# Security policy

## Reporting a vulnerability

Report privately through GitHub: this repository's **Security** tab → **Report a
vulnerability**. Please don't open a public issue, pull request or discussion for
a vulnerability.

T3 Blackout has one maintainer. You can expect:

- an acknowledgement within 7 days;
- an assessment, and a planned fix or an explanation, once the report is
  reproduced;
- a GitHub security advisory for confirmed issues, crediting you if you want that;
- coordinated disclosure. We'll agree a date before anything is made public.

There's no bug bounty.

## Scope

In scope: the code and configuration in this repository.

- the strip rules and the files they inject (`packages/t3/lib/rules.mjs`, `packages/t3/lib/files/`)
- the build, verification and install pipeline (`packages/t3/bin/`, `packages/t3/lib/`)
- self-update and the commit and pin trust rules (`packages/t3/lib/selfupdate.mjs`, `.allowed_signers`)
- the CI workflows and their scripts (`.github/`)
- the setup scripts (`install.sh`, `packages/t3/scripts/`)
- instructions in `docs/` that, followed as written, would weaken a machine's
  security

Examples: a way for an agent account, a LAN peer or a tailnet peer to gain access
or deny service; a way for the evaluator's key, a compromised upstream release or a
compromised npm package to get past the checks; a call home that survives the
strip rules and the build's checks.

Out of scope (report these upstream):

- T3 Code itself, where the issue isn't caused by T3 Blackout's changes:
  [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- the agent CLIs, Tailscale, macOS, Homebrew, npm packages and other third-party
  software
- the non-goals and accepted limits in the
  [threat model](docs/security/threat-model.md#non-goals) (for example: runtime
  network enforcement, root or the admin account on a host, power loss in the
  documented windows)

## What to include

- the commit (`git rev-parse HEAD`) and platform (macOS or Linux version, CPU)
- the role (`ui`, `host` or `both`) and the setup steps that matter
- what an attacker needs before the attack (which account, which network, which key)
- steps to reproduce, and what you expected instead
- logs with secrets, hostnames, user names and home paths removed

## Supported versions

Only `main`. Every machine follows `main` through
[self-update](docs/updates/self-update.md). Fixes ship as signed commits there;
there are no release branches.

## Security documentation

- [Threat model](docs/security/threat-model.md)
- [Privacy](docs/security/privacy.md)
- [Supply chain](docs/security/supply-chain.md)
- [Keys and incidents](docs/security/keys-and-incidents.md)
- [Host hardening and the CIS Benchmark](docs/security/hardening-cis.md)
- [Testing](docs/security/testing.md)
