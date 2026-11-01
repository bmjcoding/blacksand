# Commands

> **Applies to:** every role, macOS and Linux (`signing`: macOS only).

Run a command from the clone: `blacksand` is the script at its top (`./blacksand t3 status`).
Uppercase arguments (`SHA`, `FILE`, `DIR`,
`TAG_OR_SHA`, `name@version`) are values to replace. Run only the command you need;
this is a reference, not a block to paste.

| Command | Purpose |
|---|---|
| `blacksand t3 update` | build the pinned release on your track, then strip, build, verify, smoke-test and install it |
| `blacksand t3 update --force` | rebuild even when nothing moved |
| `blacksand t3 update --channel nightly` | a given track: nightly, preview or stable (refused unless `pin.json` pins it) |
| `blacksand t3 update --channel stable --allow-downgrade` | switch to a track whose release is older than the one installed (otherwise the installed one is kept) |
| `blacksand t3 update --channel stable --unpinned` | a track `pin.json` doesn't pin: its newest release at least 48 hours old, without the evaluator's gates |
| `blacksand t3 update --ref TAG_OR_SHA` | build anything you name (not verified against the pin) |
| `blacksand t3 update --expect-sha SHA` | build only if the approved release is still SHA (the app's download) |
| `blacksand t3 poll` | is there a newer release? (takes a newer signed pin first) |
| `blacksand t3 poll --offline` | the same, from local state only (the app's automatic checks) |
| `blacksand t3 check` | dry-run the rules against the pinned release (`--ref`: any), with no build |
| `blacksand t3 check --build` | also build, scan and smoke-test it, without installing |
| `blacksand t3 drift` | open what upstream changed under the features a build left out |
| `blacksand t3 preview` | try the waiting build in a sandboxed window (`--installed`: the build you run) |
| `blacksand t3 review` | gather the waiting build's report and upstream commits for an agent |
| `blacksand t3 smoke` | rerun the zero-egress smoke test on the last build |
| `blacksand t3 launch` | open the app, installing a waiting build first if this clone's commit made it |
| `blacksand t3 status` | installed build, pin and its gates, schedule, role, build account, signing |
| `blacksand t3 rollback` | swap back to the previously installed build |
| `blacksand t3 schedule` | hourly (the default) |
| `blacksand t3 schedule --day monday --hour 4` | weekly at 4:00 (or `--day daily`) |
| `blacksand t3 unschedule` | no scheduled updates |
| `blacksand t3 configure --role host` | save the role (`ui`, `host` or `both`) and install locations; `install.sh` runs it |
| `blacksand t3 signing status` | macOS: the signing identity. Also `signing adopt`, `signing import`, `signing init`, each with `--vault V` |
| `blacksand t3 device-tool-lock --tool name@version` | resolve, check and keep a reviewed device tool's lockfile in `pin.json` |

`configure --role` saves the role. Run `schedule` afterwards, or rerun `install.sh`,
to move the scheduled job too. `apply` is what the app runs to install a staged build
once it has quit.

CI runs these ([evaluator](updates/evaluator.md)):

| Command | Purpose |
|---|---|
| `blacksand t3 evaluate --channel nightly --build --write --report FILE --resolved DIR` | pick and pin the newest release that passes (`--stage-from DIR` reuses an earlier run's stage records) |
| `blacksand t3 pin-check` | every tag `pin.json` names still points at its commit upstream |
| `blacksand t3 pin-check --channel nightly --candidate FILE --resolved DIR --result FILE` | re-derive a candidate's gates before signing |
| `blacksand t3 advisories --channel nightly --resolved DIR --out FILE` | advisories against the pin on `main` |
| `blacksand t3 releases --channel nightly` | upstream releases newer than `main`'s pin (`--out FILE` writes them too) |

## Host scripts (macOS)

| Script | Purpose |
|---|---|
| `sudo tooling/t3code/scripts/add-agent-account.sh NAME [--loopback-only] [--tailnet-only \| --allow-from ADDRESSES \| --allow-lan] [--key FILE]` | create or repair an agent account ([agent accounts](accounts/agent-accounts.md)) |
| `/usr/local/libexec/blacksand/set-claude-token` | as an agent account: store a Claude Code token ([providers](accounts/providers.md)) |
| `sudo tooling/t3code/scripts/add-phone-service.sh NAME [--pair \| --remove]` | the phone service ([phone](remote-access/phone.md)) |
| `sudo tooling/t3code/scripts/enable-screen-sharing.sh [--status \| --off \| --on \| --no-serve \| --uninstall]` | Screen Sharing ([Screen Sharing](remote-access/screen-sharing.md)) |

`tooling/t3code/scripts/host-common.sh` and `tooling/t3code/scripts/phone-server.sh` are helpers those scripts use;
you don't run them yourself.

## Files and locations

| Path | What |
|---|---|
| `state/` in the clone | mode 700: the log (`blacksand-t3.log`), install records, the update lock, `install.json`, and on macOS the signing keychain |
| `~/.blacksand/t3` | the app's and each server's data; never upstream's `~/.t3` |
| `~/.blacksand/t3/bin/t3` | every command writes it, so agents and the app can run this clone's CLI by a fixed path. It's written through a rename, so a link already there is replaced, never written through |
| `/Applications/Blacksand T3.app` (macOS) | the app, when you're an admin; else `~/Applications` |
| `~/.local/share/blacksand/t3/app` (Linux) | the app |
| `/private/var/blacksand-build`, `/var/lib/blacksand-build` | the build account's home ([build account](building/build-account.md)) |
| `/Users/Shared/blacksand` (macOS) | the update-request folder and the published pricing table, shared with agent accounts |

| Variable | Effect |
|---|---|
| `BLACKSAND_T3_UPDATE_DAY`, `BLACKSAND_T3_UPDATE_HOUR` | `install.sh`'s schedule (`hourly`, `daily` or a weekday) |
| `BLACKSAND_T3_VAULT` | `install.sh`'s 1Password vault for the signing certificate (default `Personal`) |
| `BLACKSAND_T3_HOME`, `BLACKSAND_T3_APPS`, `BLACKSAND_T3_UPDATE_REQUESTS`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME` | install locations ([desktop](install/desktop.md#changing-role-or-locations)) |
| `BLACKSAND_T3_MIN_AGE_DAYS` | the dependency age gate (default 3) |
| `BLACKSAND_T3_SOAK_HOURS` | the soak for unpinned tracks (default 48) |
| `BLACKSAND_T3_UNISOLATED_BUILD=1` | let a checkout that isn't an install build as you (CI, development) |
| `BLACKSAND_T3_GITHUB_TOKEN` | a GitHub token for the advisory API (CI) |
