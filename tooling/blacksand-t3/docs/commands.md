# Commands

> **Applies to:** every role, macOS and Linux. `signing` is macOS only.

Run each command from the clone. `blacksand` is the script at the clone's top, so you
type `./blacksand t3 status`, for example. Uppercase arguments (`SHA`, `FILE`, `DIR`,
`TAG_OR_SHA`, `name@version`) are values to replace. Run only the command you need.
This page is a reference, not a block to paste.

| Command | Purpose |
|---|---|
| `blacksand t3 update` | build the pinned release on your track, then strip, build, verify, smoke-test and install it |
| `blacksand t3 update --force` | rebuild even when nothing changed |
| `blacksand t3 update --channel nightly` | build a given track: nightly, preview or stable. It refuses a track that `pin.json` doesn't pin |
| `blacksand t3 update --channel stable --allow-downgrade` | switch to a track whose release is older than the one installed. Without this flag, it keeps the installed one |
| `blacksand t3 update --channel stable --unpinned` | build a track that `pin.json` doesn't pin. It takes the track's newest release that is at least 48 hours old, without the evaluator's gates |
| `blacksand t3 update --ref TAG_OR_SHA` | build any tag or commit you name, without checking it against the pin |
| `blacksand t3 update --expect-sha SHA` | build only if the approved release is still SHA. The app's download runs this |
| `blacksand t3 poll` | take any newer signed pin, then check whether there's a newer release |
| `blacksand t3 poll --offline` | the same check, from local state only. The app's automatic checks run this |
| `blacksand t3 check` | dry-run the rules against the pinned release, or any release with `--ref`, without building |
| `blacksand t3 check --build` | also build, scan and smoke-test it, without installing |
| `blacksand t3 drift` | open what upstream changed under the features a build left out |
| `blacksand t3 preview` | try the waiting build in a sandboxed window. With `--installed`, try the build you run |
| `blacksand t3 review` | gather the waiting build's report and upstream commits for an agent |
| `blacksand t3 smoke` | rerun the zero-egress smoke test on the last build |
| `blacksand t3 launch` | open the app, first installing a waiting build if this clone's commit made it |
| `blacksand t3 status` | show the installed build, the pin and its gates, the schedule, the role, the build account and signing |
| `blacksand t3 rollback` | swap back to the previously installed build |
| `blacksand t3 schedule` | schedule updates hourly, the default |
| `blacksand t3 schedule --day monday --hour 4` | schedule them weekly at 4:00, or daily with `--day daily` |
| `blacksand t3 unschedule` | turn off scheduled updates |
| `blacksand t3 configure --role host` | save the role (`ui`, `host` or `both`) and install locations. `install.sh` runs it |
| `blacksand t3 signing status` | show the signing identity (macOS). `signing adopt`, `signing import` and `signing init` also exist, each with `--vault V` |
| `blacksand t3 device-tool-lock --tool name@version` | resolve and check a reviewed device tool's lockfile, and keep it in `pin.json` |

`configure --role` saves the role. To move the scheduled job too, run `schedule`
afterwards, or rerun `install.sh`. The app runs `apply` to install a staged build once
the app has quit.

CI runs these ([evaluator](updates/evaluator.md)):

| Command | Purpose |
|---|---|
| `blacksand t3 evaluate --channel nightly --build --write --report FILE --resolved DIR` | pick and pin the newest release that passes. `--stage-from DIR` reuses an earlier run's stage records |
| `blacksand t3 pin-check` | check that every tag `pin.json` names still points at its commit upstream |
| `blacksand t3 pin-check --channel nightly --candidate FILE --resolved DIR --result FILE` | re-derive a candidate's gates before signing |
| `blacksand t3 advisories --channel nightly --resolved DIR --out FILE` | check advisories against the pin on `main` |
| `blacksand t3 releases --channel nightly` | list upstream releases newer than `main`'s pin. `--out FILE` also writes them to a file |

## Host scripts (macOS)

| Script | Purpose |
|---|---|
| `sudo tooling/blacksand-t3/scripts/add-agent-account.sh NAME [--loopback-only] [--tailnet-only \| --allow-from ADDRESSES \| --allow-lan] [--key FILE]` | create or repair an agent account ([agent accounts](accounts/agent-accounts.md)) |
| `/usr/local/libexec/blacksand/set-claude-token` | store a Claude Code token, run as an agent account ([providers](accounts/providers.md)) |
| `sudo tooling/blacksand-t3/scripts/add-phone-service.sh NAME [--pair \| --remove]` | set up, pair or remove the phone service ([phone](remote-access/phone.md)) |
| `sudo tooling/blacksand-t3/scripts/enable-screen-sharing.sh [--status \| --off \| --on \| --no-serve \| --uninstall]` | set up and control Screen Sharing ([Screen Sharing](remote-access/screen-sharing.md)) |

Those scripts use `tooling/blacksand-t3/scripts/host-common.sh` and
`tooling/blacksand-t3/scripts/phone-server.sh` as helpers. You don't run the helpers
yourself.

## Files and locations

| Path | What |
|---|---|
| `state/` in the clone | mode 700: the log (`blacksand-t3.log`), install records, the update lock, `install.json`, and on macOS the signing keychain |
| `~/.blacksand/t3` | the app's and each server's data. blacksand-t3 never uses upstream's `~/.t3` |
| `~/.blacksand/t3/bin/t3` | every command writes it, so agents and the app can run this clone's CLI by a fixed path. A command writes it with a rename, so it replaces a link already there instead of writing through it |
| `/Applications/T3 Code (blacksand).app` (macOS) | the app, when you're an admin. Otherwise it's in `~/Applications` |
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
| `BLACKSAND_T3_UNISOLATED_BUILD=1` | let a checkout that isn't an install build as you, for CI and development |
| `BLACKSAND_T3_GITHUB_TOKEN` | a GitHub token for the advisory API (CI) |
