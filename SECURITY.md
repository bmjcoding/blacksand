# Security policy

## Reporting a vulnerability

Report it privately through GitHub. Open this repository's **Security** tab, then
choose **Report a vulnerability**. Please don't open a public issue, pull request or
discussion for a vulnerability.

Blacksand has one maintainer. You can expect:

- an acknowledgement within 7 days;
- an assessment once the maintainer reproduces the report, with a planned fix or an
  explanation;
- a GitHub security advisory for each confirmed issue, crediting you if you want that;
- coordinated disclosure. We'll agree on a date before anything is made public.

There's no bug bounty.

## Scope

Everything in this repository is in scope:

- the `blacksand` command and its commit trust checks (`src/`, `.allowed_signers`);
- the Kubernetes sandbox: its proxy, manifests, node egress floor and run records
  (`packages/substrate-k8s/`);
- Blacksand T3:
  - the strip rules and the files they inject (`packages/t3/lib/rules.mjs`,
    `packages/t3/lib/files/`);
  - the build, verification and install pipeline (`packages/t3/bin/`,
    `packages/t3/lib/`);
  - self-update and the pin trust rules (`packages/t3/lib/selfupdate.mjs`);
  - the setup scripts (`packages/t3/install.sh`, `packages/t3/scripts/`);
- the CI workflows and their scripts (`.github/`);
- instructions in a README or `docs/` folder that would weaken a machine's security if
  followed as written.

Examples of what to report:

- a way for a sandboxed agent to reach a host its run didn't allow, or to read a
  credential it wasn't given;
- a way for an agent account, a LAN peer or a tailnet peer to gain access or deny
  service;
- a way for the evaluator's key, a compromised upstream release or a compromised npm
  package to get past the checks;
- a call home that survives T3's strip rules and the build's checks.

Out of scope:

- T3 Code itself, when Blacksand T3's changes didn't cause the issue. Report it to
  [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
- Third-party software: agent-sandbox, gVisor, Kubernetes, the agent CLIs, Tailscale,
  macOS, Homebrew, npm packages and the rest. Report it to that project.
- The limits each package documents. For T3, that's the non-goals and accepted limits
  in its [threat model](packages/t3/docs/security/threat-model.md#non-goals), such as
  network enforcement at runtime, root or the admin account on a host, and power loss
  in the documented windows. For the Kubernetes sandbox, it's the list under
  [What it protects against](packages/substrate-k8s/README.md#what-it-protects-against)
  that starts "It doesn't protect against".

## What to include

- the commit (`git rev-parse HEAD`) and the platform: macOS or Linux version, and CPU;
- for T3, the role (`ui`, `host` or `both`) and the setup steps that matter;
- for the Kubernetes sandbox, the cluster: k3s or EKS version, and gVisor version;
- what an attacker needs before the attack: which account, which network, which key;
- steps to reproduce, and what you expected instead;
- logs with secrets, hostnames, user names and home paths removed.

## Supported versions

Only `main` is supported. Fixes land there as signed commits. There are no release
branches. Machines running Blacksand T3 follow `main` through
[self-update](packages/t3/docs/updates/self-update.md).

## Security documentation

- [Threat model](packages/t3/docs/security/threat-model.md) for T3
- [What the Kubernetes sandbox protects against](packages/substrate-k8s/README.md#what-it-protects-against)
- [Privacy](packages/t3/docs/security/privacy.md)
- [Supply chain](packages/t3/docs/security/supply-chain.md)
- [Keys and incidents](packages/t3/docs/security/keys-and-incidents.md)
- [Host hardening and the CIS Benchmark](packages/t3/docs/security/hardening-cis.md)
- [Testing](packages/t3/docs/security/testing.md)
