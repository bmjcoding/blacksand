# Blacksand

The secure ground your AI agents run on.

Blacksand runs each AI agent in its own sandbox. The agent can reach only the hosts you
allow. Your credentials stay outside the sandbox. Every run leaves an audit trail.

Use it with agent CLIs such as Claude Code and Codex, or with agents you build yourself.
They can use any hosted or open-weight model. An agent can work on one task in a fresh
sandbox, or keep its workspace from one session to the next. Run it on your computer, on
other machines you own, or in the cloud.

## Install

Blacksand is one executable. It runs on macOS with Apple silicon, and on Linux (x64 and
arm64).

### npm (recommended)

```sh
npm install -g @blacksand/cli
```

The command it installs is `blacksand`.

### Homebrew (macOS, Linux)

```sh
brew install bmjcoding/tap/blacksand
```

### Direct download

Download the archive for your platform from the latest
[release](https://github.com/bmjcoding/blacksand/releases). Before you unpack it,
check that this repository's release workflow built it:

```sh
gh attestation verify blacksand-darwin-arm64.tar.gz --repo bmjcoding/blacksand
tar -xzf blacksand-darwin-arm64.tar.gz
```

Then move `blacksand` to a folder on your `PATH`.

### From source

You need Node.js 24 or later and git.

```sh
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
./blacksand verify
```

`verify` checks that a trusted key signed every commit in the clone. It also checks that
the files on disk match the latest commit.

## Quick start

```sh
cd your-project
blacksand init
blacksand run claude "fix the failing test"
```

`blacksand init` sets up Blacksand on this machine. `blacksand run` starts Claude Code
in a new sandbox, on the repository in the current folder. When the run ends, you get
the agent's changes as a patch, and the run's record.

## How it works

- **One sandbox per agent.** The sandbox starts with an empty workspace and the files
  you give it. Each run gets a new one.
- **One way out.** The sandbox's only network route is a proxy. The proxy connects the
  agent to the hosts you allowed for that run. It logs every connection the agent
  tries, including the ones it refuses.
- **Credentials stay with the proxy.** The proxy adds your credential to each model
  request it allows. It also limits which models the agent may call, and how many
  requests it may make. The agent holds only a token for its own proxy, and the token
  expires with the run.
- **An audit trail for every run.** Each run writes a record of what ran, where, under
  which policy, and what changed. Failed and cancelled runs get one too.
- **Signed configuration.** Blacksand applies configuration only from commits signed by
  a key you trust. It checks each signature itself, so access to the GitHub account
  alone can't change your machines.

## Documentation

Each package in [`packages/`](packages) has its own README. Guides are in
[`docs/`](docs/README.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
