# The build account

> **Applies to:** every role, macOS and Linux. Code: `install.sh` (`setup_builder`),
> `lib/builder.mjs`, `lib/pnpm.mjs`, `lib/install-config.mjs`. Tests:
> `test/install.test.mjs`, `test/build-builder.test.mjs`, `test/build-tools.test.mjs`,
> `test/install-config.test.mjs`.

Every build runs upstream's build scripts, and the install scripts of the
dependencies the desktop build needs. That's code you haven't read, running
unattended. So `install.sh` creates an unprivileged account, `_t3blackout`. The
fetch, build and smoke test run as it.

- **Where its files live:** `/private/var/t3blackout-build` on macOS, and
  `/var/lib/t3blackout-build` on Linux. That holds the upstream mirror, the build
  checkout and its own pnpm store. On macOS, that folder is mode 700 with one ACL
  entry letting you list and pass through it, so no other account (agent accounts
  included) can open it. On Linux it's 755, because Linux has no agent accounts.
- **What it can't read:** `install.sh` makes your home private (`chmod go-rwx`) if the
  build account could read it. So it can't read your home folder, SSH keys or
  credentials. Each build starts in `/` (your clone is in a folder it can't open),
  with a private `TMPDIR`.
- **Its tools:** the pinned pnpm, and the Vite+ home upstream's build runs pnpm from,
  live in root-owned `/Library/Application Support/t3blackout/tools` (Linux:
  `/usr/local/libexec/t3blackout/tools`). The build account can run them but not
  change them. Every directory up the path must be root's, with no ACL that grants
  more. A build checks the binary's SHA-256 before every pnpm run
  ([pnpm pin](../updates/pnpm-pin.md)).
- **How it's started:** through one sudo rule, `<you> ALL=(_t3blackout) NOPASSWD:
  ALL`. The rule works in one direction only: you can act as the build account, and
  it can't act as you or as root.
- **What it hands back:** an unsigned app. You scan it again, sign it and install it.

## The tools' lock

`tools.lock`, beside the tools, keeps installs and builds apart. `install.sh` holds it
exclusively while it replaces the tools, and a build holds it shared while it uses
them.

- On macOS it's `root:admin`, mode 640, with one ACL entry letting the build account
  read it. So only root, admins and the build account can open it. Agent accounts
  (standard accounts) can't, so they can't hold it to stall updates. Both sides check
  that exact policy, and `install.sh` stops if a symlink or anything but a regular
  file is at its path. On Linux it's root's, mode 644.
- Each side waits for the other, then gives up naming the lock: an install up to 2
  hours, a build 30 minutes. That limits the waiter, not the holder.
  `sudo lsof "/Library/Application Support/t3blackout/tools.lock"` shows who holds it.
- An install that was killed part-way leaves its stage and the tools it moved aside.
  The next `install.sh` puts the old tools back or finishes, before anything else.
  Killed between its two renames, it leaves no tools in place. Builds (and the hourly
  update) then fail saying to rerun `./install.sh`, which restores them.

## Required by default

If sudo is missing or doesn't authorize you, `install.sh` stops before any upstream
code runs. `./install.sh --unisolated-build` builds as you instead, and upstream's
scripts then run with your files and credentials. That choice is saved in
`state/install.json`, and the `builds:` line in `bin/t3blackout status` shows it.

An install saved without it never builds as you. If its build account goes missing,
update, check, poll, smoke and evaluate refuse, and say to rerun `./install.sh`. A
checkout that isn't an install (CI, development) builds as you only with
`T3BLACKOUT_UNISOLATED_BUILD=1`. A clone with installed builds but no
`state/install.json` is refused even then.

## What it doesn't protect

The app itself still runs as you. This guards the build, not what upstream's code
does at runtime. Code running as the build account can still read what that account
holds, including a GitHub token handed to it (which should have no permissions).
