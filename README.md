<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/blacksand-lockup-glow.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/blacksand-lockup-light.svg">
    <img src="docs/assets/blacksand-lockup-light.svg" alt="Blacksand" width="300">
  </picture>
</p>

<p align="center"><strong>The secure ground your AI agents run on.</strong></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/badge-alpha-dark.svg">
    <img src="docs/assets/badge-alpha-light.svg" alt="Alpha" height="20">
  </picture>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/security/threat-model.md">Threat model</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="SECURITY.md">Report a vulnerability</a>
</p>

Blacksand runs every AI agent in a disposable sandbox. The agent reaches only the hosts you
allow, never holds your credentials, and every run leaves a record. Use it with Claude Code,
Codex, or agents you build yourself.

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
- **Signed updates.** Machines take changes only from commits signed by a key you trust,
  checked locally, so access to the GitHub account alone can't change them.

## Install

You need Node.js 24 or later and git.

```sh
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
./blacksand verify
```

`verify` checks the commit signatures in your clone, and that the files on disk match the
latest commit.

## Quick start

The first substrate runs agents on a Kubernetes node:

```sh
./blacksand k8s setup
./blacksand k8s run --repo ~/code/project --prompt-file task.md \
  --agent claude \
  --route anthropic=https://api.anthropic.com@anthropic-key \
  --tools-image blacksand.local/agent-tools@sha256:… \
  --out runs/first-task
```

When the run ends, you get the agent's changes as a patch, and the run's record. Setting up a
machine for the first time? The [Kubernetes guide](substrates/kubernetes/README.md) walks
through it.

<sub>MIT licensed. To report a vulnerability, see [SECURITY.md](SECURITY.md).</sub>
