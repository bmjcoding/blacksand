<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/blacksand-lockup-glow.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/blacksand-lockup-light.svg">
    <img src="docs/assets/blacksand-lockup-light.svg" alt="Blacksand" width="300">
  </picture>
</p>

<h3 align="center">The secure ground your AI agents run on.</h3>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/badge-alpha-dark.svg">
    <img src="docs/assets/badge-alpha-light.svg" alt="Alpha" height="20" align="absmiddle">
  </picture>
  &nbsp;&nbsp;
  <a href="#quick-start">Quick start</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/security/threat-model.md">Threat model</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/README.md">Docs</a>
</p>

Blacksand runs AI agents in disposable sandboxes, so they reach only what you allow and never
hold your keys. It works with Claude Code, Codex, or your own agents.

## How it works

- **A fresh sandbox for every run.** Each run starts in a new, isolated sandbox with an empty
  workspace and only the files you give it, and it's torn down when the run ends.
- **One way out.** The sandbox's only route out is a proxy that reaches just the hosts you
  allowed for that run. The proxy logs every request, including the ones it refuses.
- **Credentials stay outside.** The proxy adds your key to each model request it allows,
  limits which models the agent may call, and caps how many requests it makes. The agent
  holds only a token for its own proxy, which expires with the run.
- **A record of every run.** What ran, where, under which policy, and what changed. Failed
  and cancelled runs get one too.
- **Signed commits.** Machines update only to commits signed by the owner's key, checked
  locally, so access to the GitHub account alone can't change them.

## Install

You need Node.js 24 or later and git. Run Blacksand as your own user; it refuses root.

```sh
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
./blacksand verify
```

`verify` checks that every commit in the clone is signed by a listed key, and that the files
on disk match the latest commit. Blacksand doesn't apply configuration yet, so for now it
always ends with `not verified` (exit 4). That's expected.

## Quick start

Blacksand runs sandboxes in pluggable environments. The first is Kubernetes, on a single k3s
node: prepare it with the [setup guide](substrates/kubernetes/README.md#setup), then:

```sh
./blacksand k8s setup
./blacksand k8s run --repo ~/code/project --prompt-file task.md \
  --agent claude \
  --route anthropic=https://api.anthropic.com@anthropic-key \
  --tools-image blacksand.local/agent-tools@sha256:… \
  --out runs/first-task
```

When the run ends, you get the agent's changes as a patch, and the run's record.

<sub>MIT licensed. To report a vulnerability, see [SECURITY.md](SECURITY.md).</sub>
