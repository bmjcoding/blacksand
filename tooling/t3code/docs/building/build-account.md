# The build account

> **Applies to:** every role, macOS and Linux. Code: `install.sh` (`setup_builder`),
> `tooling/t3code/lib/builder.mjs`, `tooling/t3code/lib/pnpm.mjs`,
> `tooling/t3code/lib/install-config.mjs`. Tests:
> `tooling/t3code/test/install.deep.test.mjs`, `tooling/t3code/test/build-builder.test.mjs`,
> `tooling/t3code/test/build-tools.deep.test.mjs`, `tooling/t3code/test/install-config.test.mjs`.

Every build runs upstream's build scripts and the install scripts of the dependencies
the desktop build needs. You haven't read that code, and it runs unattended. So
`install.sh` creates an unprivileged account, `_blacksand-build`. The fetch, the build
and the smoke test run as that account.

- **Its files.** They live in `/private/var/blacksand-build` on macOS and in
  `/var/lib/blacksand-build` on Linux. That folder holds the upstream mirror, the
  build checkout and the account's own pnpm store. On macOS the folder is mode 700,
  with one ACL entry that lets you list it and pass through it. No other account can
  open it, agent accounts included. On Linux it's mode 755, because Linux has no agent
  accounts.
- **What it can't read.** If the build account could read your home, `install.sh`
  makes your home private (`chmod go-rwx`). So the account can't read your home
  folder, SSH keys or credentials. Each build starts in `/`, with a private `TMPDIR`.
  Your clone is in a folder the account can't open.
- **Its tools.** The pinned pnpm, and the Vite+ home that upstream's build runs pnpm
  from, live in the root-owned folder `/Library/Application Support/blacksand/tools`.
  On Linux that folder is `/usr/local/libexec/blacksand/tools`. The build account can
  run the tools but can't change them. Every directory up the path must belong to
  root, with no ACL that grants more access. A build checks the pnpm binary's SHA-256
  before every pnpm run ([pnpm pin](../updates/pnpm-pin.md)).
- **How it starts.** You start it through one sudo rule,
  `<you> ALL=(_blacksand-build) NOPASSWD: ALL`. The rule works in one direction only.
  You can act as the build account, but it can't act as you or as root.
- **What it hands back.** The build account hands back an unsigned app. You scan it
  again, sign it and install it.

## The tools' lock

`tools.lock`, beside the tools, keeps installs and builds apart. `install.sh` holds it
exclusively while it replaces the tools. A build holds it shared while it uses them.

- On macOS the lock is `root:admin`, mode 640, with one ACL entry that lets the build
  account read it. So only root, admins and the build account can open it. Agent
  accounts are standard accounts and can't open it, so they can't hold it to stall
  updates. Both sides check that exact policy. `install.sh` stops if a symlink, or
  anything other than a regular file, is at the lock's path. On Linux the lock belongs
  to root, mode 644.
- Each side waits for the other, then gives up with an error that names the lock. An
  install waits up to 2 hours, and a build waits up to 30 minutes. The limit applies
  to the waiter, not the holder.
  `sudo lsof "/Library/Application Support/blacksand/tools.lock"` shows who holds it.
- An install killed part-way leaves its stage and the tools it moved aside. Before it
  does anything else, the next `install.sh` puts the old tools back or finishes the
  replacement. An install killed between its two renames leaves no tools in place.
  Builds and the hourly update then fail with a message to rerun
  `tooling/t3code/install.sh`, which restores the tools.

## Required by default

If sudo is missing or doesn't authorize you, `install.sh` stops before any upstream
code runs. `tooling/t3code/install.sh --unisolated-build` builds as you instead, and
upstream's scripts then run with your files and credentials. `install.sh` saves that
choice in `state/install.json`, and the `builds:` line in `blacksand t3 status` shows
it.

An install saved without that flag never builds as you. If its build account goes
missing, update, check, poll, smoke and evaluate all refuse to run, and they say to
rerun `tooling/t3code/install.sh`. A checkout that isn't an install, such as CI or a
development checkout, builds as you only with `BLACKSAND_T3_UNISOLATED_BUILD=1`. Even
with that set, a clone that has installed builds but no `state/install.json` is
refused.

## What it doesn't protect

The app itself still runs as you. The build account guards the build, not what
upstream's code does at runtime. Code running as the build account can still read
what that account holds. That includes any GitHub token handed to it, and that token
should have no permissions.
