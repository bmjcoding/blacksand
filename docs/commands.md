# Commands

> **Applies to:** every role, macOS and Linux (`signing`: macOS only).

Run a command from the clone. Uppercase arguments (`SHA`, `FILE`, `DIR`,
`TAG_OR_SHA`, `name@version`) are values to replace. Run only the command you need;
this is a reference, not a block to paste.

| Command | Purpose |
|---|---|
| `bin/t3blackout update` | build the pinned release on your track, then strip, build, verify, smoke-test and install it |
| `bin/t3blackout update --force` | rebuild even when nothing moved |
| `bin/t3blackout update --channel nightly` | a given track: nightly, preview or stable (refused unless `pin.json` pins it) |
| `bin/t3blackout update --channel stable --allow-downgrade` | switch to a track whose release is older than the one installed (otherwise the installed one is kept) |
| `bin/t3blackout update --channel stable --unpinned` | a track `pin.json` doesn't pin: its newest release at least 48 hours old, without the evaluator's gates |
| `bin/t3blackout update --ref TAG_OR_SHA` | build anything you name (not verified against the pin) |
| `bin/t3blackout update --expect-sha SHA` | build only if the approved release is still SHA (the app's download) |
| `bin/t3blackout poll` | is there a newer release? (takes a newer signed pin first) |
| `bin/t3blackout poll --offline` | the same, from local state only (the app's automatic checks) |
| `bin/t3blackout check` | dry-run the rules against the pinned release (`--ref`: any), with no build |
| `bin/t3blackout check --build` | also build, scan and smoke-test it, without installing |
| `bin/t3blackout drift` | open what upstream changed under the features a build left out |
| `bin/t3blackout preview` | try the waiting build in a sandboxed window (`--installed`: the build you run) |
| `bin/t3blackout review` | gather the waiting build's report and upstream commits for an agent |
| `bin/t3blackout smoke` | rerun the zero-egress smoke test on the last build |
| `bin/t3blackout launch` | open the app, installing a waiting build first if this clone's commit made it |
| `bin/t3blackout status` | installed build, pin and its gates, schedule, role, build account, signing |
| `bin/t3blackout rollback` | swap back to the previously installed build |
| `bin/t3blackout schedule` | hourly (the default) |
| `bin/t3blackout schedule --day monday --hour 4` | weekly at 4:00 (or `--day daily`) |
| `bin/t3blackout unschedule` | no scheduled updates |
| `bin/t3blackout configure --role host` | save the role (`ui`, `host` or `both`) and install locations; `install.sh` runs it |
| `bin/t3blackout signing status` | macOS: the signing identity. Also `signing adopt`, `signing import`, `signing init`, each with `--vault V` |
| `bin/t3blackout device-tool-lock --tool name@version` | resolve, check and keep a reviewed device tool's lockfile in `pin.json` |

`configure --role` saves the role. Run `schedule` afterwards, or rerun `install.sh`,
to move the scheduled job too. `apply` is what the app runs to install a staged build
once it has quit.

CI runs these ([evaluator](updates/evaluator.md)):

| Command | Purpose |
|---|---|
| `bin/t3blackout evaluate --channel nightly --build --write --report FILE --resolved DIR` | pick and pin the newest release that passes (`--stage-from DIR` reuses an earlier run's stage records) |
| `bin/t3blackout pin-check` | every tag `pin.json` names still points at its commit upstream |
| `bin/t3blackout pin-check --channel nightly --candidate FILE --resolved DIR --result FILE` | re-derive a candidate's gates before signing |
| `bin/t3blackout advisories --channel nightly --resolved DIR --out FILE` | advisories against the pin on `main` |
| `bin/t3blackout releases --channel nightly` | upstream releases newer than `main`'s pin (`--out FILE` writes them too) |

## Host scripts (macOS)

| Script | Purpose |
|---|---|
| `sudo scripts/add-agent-account.sh NAME [--loopback-only] [--tailnet-only \| --allow-from ADDRESSES \| --allow-lan] [--key FILE]` | create or repair an agent account ([agent accounts](accounts/agent-accounts.md)) |
| `/usr/local/libexec/t3blackout/set-claude-token` | as an agent account: store a Claude Code token ([providers](accounts/providers.md)) |
| `sudo scripts/add-phone-service.sh NAME [--pair \| --remove]` | the phone service ([phone](remote-access/phone.md)) |
| `sudo scripts/enable-screen-sharing.sh [--status \| --off \| --on \| --no-serve \| --uninstall]` | Screen Sharing ([Screen Sharing](remote-access/screen-sharing.md)) |

`scripts/host-common.sh` and `scripts/phone-server.sh` are helpers those scripts use;
you don't run them yourself.

## Files and locations

| Path | What |
|---|---|
| `state/` in the clone | mode 700: the log (`t3blackout.log`), install records, the update lock, `install.json`, and on macOS the signing keychain |
| `~/.t3blackout` | the app's and each server's data; never upstream's `~/.t3` |
| `~/.t3blackout/bin/t3blackout` | every command writes it, so agents and the app can run this clone's CLI by a fixed path. It's written through a rename, so a link already there is replaced, never written through |
| `/Applications/T3 Blackout.app` (macOS) | the app, when you're an admin; else `~/Applications` |
| `~/.local/share/t3blackout/app` (Linux) | the app |
| `/private/var/t3blackout-build`, `/var/lib/t3blackout-build` | the build account's home ([build account](building/build-account.md)) |
| `/Users/Shared/t3blackout` (macOS) | the update-request folder and the published pricing table, shared with agent accounts |

| Variable | Effect |
|---|---|
| `T3BLACKOUT_UPDATE_DAY`, `T3BLACKOUT_UPDATE_HOUR` | `install.sh`'s schedule (`hourly`, `daily` or a weekday) |
| `T3BLACKOUT_VAULT` | `install.sh`'s 1Password vault for the signing certificate (default `Personal`) |
| `T3BLACKOUT_HOME`, `T3BLACKOUT_APPS`, `T3BLACKOUT_UPDATE_REQUESTS`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME` | install locations ([desktop](install/desktop.md#changing-role-or-locations)) |
| `T3BLACKOUT_MIN_AGE_DAYS` | the dependency age gate (default 3) |
| `T3BLACKOUT_SOAK_HOURS` | the soak for unpinned tracks (default 48) |
| `T3BLACKOUT_UNISOLATED_BUILD=1` | let a checkout that isn't an install build as you (CI, development) |
| `T3BLACKOUT_GITHUB_TOKEN` | a GitHub token for the advisory API (CI) |
