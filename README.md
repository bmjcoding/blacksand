# Blacksand

The secure ground your AI agents run on.

Run any agent on your laptop, an always-on host or Kubernetes. Blacksand decides what
it can touch, lends it credentials one task at a time, and keeps the evidence of
everything it did.

## Install

Every release is built by GitHub Actions from a signed commit, and published on
[GitHub Releases](https://github.com/bmjcoding/blacksand/releases) as a native binary
per platform, each with a SHA-256 digest and a build attestation.

### npm (recommended)

```sh
npm install -g blacksand
```

### Homebrew (macOS, Linux)

```sh
brew install bmjcoding/tap/blacksand
```

### Direct download

Take your platform's binary from the latest release, then check it came from this
repository's CI before running it:

```sh
gh attestation verify blacksand-darwin-arm64 --repo bmjcoding/blacksand
```

### From source

Requires Node.js 24 or later.

```sh
git clone https://github.com/bmjcoding/blacksand.git
cd blacksand
./blacksand verify
```

## Quick start

```sh
blacksand init
blacksand run claude "fix the failing test"
```

## How it works

- **Sealed off.** Each agent runs in its own sandbox, with nothing of yours inside it.
- **Reach on request.** Its only way out is a proxy that allows what this task was
  granted, and records every connection it tries.
- **Borrowed credentials.** Model keys and access tokens stay with Blacksand. The agent
  gets short-lived, scoped stand-ins for one task.
- **Evidence.** Every run leaves a sealed record of what ran, where, under which
  policy, and what changed.
- **Signed configuration.** Your machines change only when your key signed the change,
  and they check that themselves.

## Documentation

Guides are in [docs](docs/README.md). Blacksand is one repository: each package in
[packages](packages) has its own README.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability, and the
[threat model](docs/security/threat-model.md) for what Blacksand does and doesn't
protect against.

## License

MIT ([LICENSE](LICENSE)).
