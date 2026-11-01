# blacksand-t3: run only the Blacksand build installed on this host, never a
# downloaded release.
# (Injected into a TypeScript template literal: keep \${ and \\n escaped, and
# no backslash at a line's end.)
T3B_ELECTRON=""
T3B_SERVER=""
T3B_ASAR=""
for T3B_APP in "\${BLACKSAND_T3_APP:-}" "/Applications/T3 Code (blacksand).app" "$HOME/Applications/T3 Code (blacksand).app"; do
  if [ -n "$T3B_APP" ] && [ -x "$T3B_APP/Contents/MacOS/T3 Code (blacksand)" ]; then
    T3B_ELECTRON="$T3B_APP/Contents/MacOS/T3 Code (blacksand)"
    T3B_ASAR="$T3B_APP/Contents/Resources/app.asar"
    break
  fi
done
T3B_LINUX_APP="\${XDG_DATA_HOME:-$HOME/.local/share}/blacksand/t3/app"
if [ -z "$T3B_ELECTRON" ] && [ -x "$T3B_LINUX_APP/t3code" ]; then
  T3B_APP="$T3B_LINUX_APP"
  T3B_ELECTRON="$T3B_LINUX_APP/t3code"
  T3B_ASAR="$T3B_LINUX_APP/resources/app.asar"
fi
if [ -z "$T3B_ELECTRON" ]; then
  printf 'blacksand-t3 is not installed on this host. Run install.sh --role host there first.\\n' >&2
  exit 1
fi
T3B_SERVER="$T3B_ASAR/apps/server/dist/bin.mjs"
T3B_HOME="$HOME/.blacksand/t3"
umask 077

# File metadata from stat(1), whose flags differ (BSD on macOS, GNU elsewhere),
# never parsed out of ls. A build's identity: its app.asar's device, inode, mtime
# and size, which every install of a new build changes.
case "$(uname -s)" in
  Darwin)
    t3b_mode() { stat -f '%Lp' "$1"; }
    t3b_uid() { stat -f '%u' "$1"; }
    t3b_build() { stat -f '%d:%i:%m:%z' "$1"; }
    t3b_drop_acl() { chmod -N "$1"; }
    ;;
  *)
    t3b_mode() { stat -c '%a' "$1"; }
    t3b_uid() { stat -c '%u' "$1"; }
    t3b_build() { stat -c '%d:%i:%Y:%s' "$1"; }
    t3b_drop_acl() { if command -v setfacl >/dev/null 2>&1; then setfacl -b "$1"; fi; }
    ;;
esac
# No permission bits for group or others.
t3b_private() {
  case "$(t3b_mode "$1" 2>/dev/null)" in
    *00) return 0 ;;
    *) return 1 ;;
  esac
}
T3B_BUILD="$(t3b_build "$T3B_ASAR" 2>/dev/null || true)"
# Every server started here has a record of its own, $T3B_SERVERS/<pid>, written
# by the runner before the exec that makes its pid the server: the start time,
# the build, the server's exact command line and the runner's own. The exec
# keeps the pid and start time, so the record names one process throughout:
# the runner while it starts the server (its own command line), then the server.
# Another start, failed or not, never touches it, and it names that process
# only while a live one with that pid has that start time and one of those
# command lines, so a reused pid is never taken for it.
T3B_SERVERS="$T3B_HOME/ssh-servers"
# Start time and command line as ps shows them; C locale, since a later check
# may come from a session with another LANG.
t3b_started() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | awk '{ $1 = $1; print }'; }
t3b_args() { LC_ALL=C ps -ww -o args= -p "$1" 2>/dev/null; }
# Running, and not a zombie. From ps, not kill -0: that also succeeds for a
# zombie, and fails for a live process this account may not signal.
t3b_alive() {
  case "$(ps -o stat= -p "$1" 2>/dev/null || true)" in
    "" | *Z*) return 1 ;;
  esac
}
# Whether pid $1 is still the process a record describes: $2 its start time,
# and its command line either $3 (the server) or $4 (the runner starting it;
# empty in a record from before runners wrote it).
t3b_is_server() {
  [ -n "$2" ] && [ -n "$3" ] && t3b_alive "$1" && [ "$(t3b_started "$1")" = "$2" ] || return 1
  T3B_NOW_ARGS="$(t3b_args "$1" || true)"
  [ "$T3B_NOW_ARGS" = "$3" ] || { [ -n "$4" ] && [ "$T3B_NOW_ARGS" = "$4" ]; }
}
# Stops it: SIGTERM, up to 5 s to exit, then SIGKILL and 2 s more. Succeeds
# only once it's gone; a signal goes only to the recorded process.
t3b_stop() {
  kill "$1" 2>/dev/null || true
  T3B_WAIT=0
  while t3b_alive "$1" && [ "$T3B_WAIT" -lt 50 ]; do
    T3B_WAIT=$((T3B_WAIT + 1))
    sleep 0.1
  done
  t3b_is_server "$1" "$2" "$3" "$4" || return 0
  kill -s KILL "$1" 2>/dev/null || true
  T3B_WAIT=0
  while t3b_alive "$1" && [ "$T3B_WAIT" -lt 20 ]; do
    T3B_WAIT=$((T3B_WAIT + 1))
    sleep 0.1
  done
  ! t3b_is_server "$1" "$2" "$3" "$4"
}
# A server launchd keeps running for this account, for the phone
# (scripts/add-phone-service.sh, scripts/phone-server.sh). Its supervisor
# records its servers here like this runner does, and writes $T3B_DAEMON: its
# own pid, start time and command line, its state (starting, running, or
# blocked: another server holds this home) and its server's pid and build.
T3B_DAEMON="$T3B_SERVERS/daemon"
# Whether a connection has nothing to wait for: no live supervisor, one that's
# locked out, or one whose server runs the installed build.
t3b_daemon_settled() {
  [ -f "$T3B_DAEMON" ] || return 0
  T3B_D_PID=""
  T3B_D_STARTED=""
  T3B_D_ARGS=""
  T3B_D_STATE=""
  T3B_D_SERVER=""
  T3B_D_BUILD=""
  { IFS= read -r T3B_D_PID && IFS= read -r T3B_D_STARTED && IFS= read -r T3B_D_ARGS && IFS= read -r T3B_D_STATE && IFS= read -r T3B_D_SERVER && IFS= read -r T3B_D_BUILD; } <"$T3B_DAEMON" || true
  case "$T3B_D_PID" in
    "" | *[!0-9]*) return 0 ;;
  esac
  t3b_is_server "$T3B_D_PID" "$T3B_D_STARTED" "$T3B_D_ARGS" "" || return 0
  [ "$T3B_D_STATE" != blocked ] || return 0
  [ "$T3B_D_STATE" = running ] && [ "$T3B_D_BUILD" = "$T3B_BUILD" ] || return 1
  case "$T3B_D_SERVER" in
    "" | *[!0-9]*) return 1 ;;
  esac
  t3b_alive "$T3B_D_SERVER"
}

case "\${1:-}" in
  __blacksand-stop-stale-server)
    # The SSH launch script runs this before it decides whether to reuse a running
    # server (rule ssh/runner-installed-blacksand-only). Every server recorded here
    # that still runs a build this host has since replaced stops, so the
    # connection starts the installed build instead of reusing an old one. A
    # record goes once its server is gone; one that won't stop keeps its record
    # and fails the connection, so it's never reused. A runner still starting
    # its server counts as that server: its record stays, and if its build was
    # replaced it's stopped like one.
    T3B_FAILED=0
    for T3B_RECORD in "$T3B_SERVERS"/*; do
      T3B_PID="\${T3B_RECORD##*/}"
      case "$T3B_PID" in
        "" | *[!0-9]*) continue ;;
      esac
      [ -f "$T3B_RECORD" ] || continue
      T3B_REC_STARTED=""
      T3B_REC_BUILD=""
      T3B_REC_ARGS=""
      T3B_REC_RUNNER=""
      { IFS= read -r T3B_REC_STARTED && IFS= read -r T3B_REC_BUILD && IFS= read -r T3B_REC_ARGS && IFS= read -r T3B_REC_RUNNER; } <"$T3B_RECORD" || true
      if ! t3b_is_server "$T3B_PID" "$T3B_REC_STARTED" "$T3B_REC_ARGS" "$T3B_REC_RUNNER"; then
        rm -f "$T3B_RECORD"
      elif [ "$T3B_REC_BUILD" != "$T3B_BUILD" ]; then
        if t3b_stop "$T3B_PID" "$T3B_REC_STARTED" "$T3B_REC_ARGS" "$T3B_REC_RUNNER"; then
          rm -f "$T3B_RECORD"
        else
          printf 'blacksand-t3 server %s still runs a build this host has replaced and did not stop; stop it (kill -9 %s) and connect again.\\n' "$T3B_PID" "$T3B_PID" >&2
          T3B_FAILED=1
        fi
      fi
    done
    # A launchd-run server (above) comes back by itself on the installed build,
    # once it's stopped here or its supervisor sees the new build. Up to 90 s by
    # the clock (BLACKSAND_T3_DAEMON_WAIT seconds) for it, so this connection finds
    # and shares it instead of starting a second server, which would then lock
    # it out of this home. A supervisor still not ready by then fails the
    # connection, to be retried: starting a server beside it would race it.
    T3B_DAEMON_WAIT="\${BLACKSAND_T3_DAEMON_WAIT:-90}"
    case "$T3B_DAEMON_WAIT" in
      "" | *[!0-9]*) T3B_DAEMON_WAIT=90 ;;
    esac
    T3B_DEADLINE=$(($(date +%s) + T3B_DAEMON_WAIT))
    while ! t3b_daemon_settled; do
      if [ "$(date +%s)" -ge "$T3B_DEADLINE" ]; then
        printf 'The blacksand-t3 server launchd runs for this account (scripts/add-phone-service.sh) is still starting; connect again in a minute. Its log: %s/phone/server.log\\n' "$T3B_HOME" >&2
        exit 75
      fi
      sleep 0.2
    done
    exit "$T3B_FAILED"
    ;;
  serve)
    mkdir -p "$T3B_SERVERS"
    # exec below keeps this pid, so the record is the server's, and names this
    # runner until then. Written whole (a hidden temporary, then renamed), so
    # the check never reads half of one.
    T3B_RECORD="$T3B_SERVERS/$$"
    printf '%s\\n%s\\n%s\\n%s\\n' "$(t3b_started "$$")" "$T3B_BUILD" "$T3B_ELECTRON $T3B_SERVER $*" "$(t3b_args "$$")" >"$T3B_SERVERS/.$$" && mv -f "$T3B_SERVERS/.$$" "$T3B_RECORD"
    # The pricing table: servers here can't fetch it (rule server/litellm-rates-off),
    # so copy the one the host's updater published, if the account that installed
    # this app wrote it, in a folder no other account can write.
    T3B_SHARED_RATES="$(dirname "\${BLACKSAND_T3_UPDATE_REQUESTS:-/Users/Shared/blacksand/update-requests}")/usage-model-rates.json"
    T3B_RATES="$T3B_HOME/userdata/usage-model-rates.json"
    T3B_OWNER="$(t3b_uid "$T3B_APP" 2>/dev/null || echo none)"
    if [ -f "$T3B_SHARED_RATES" ] && [ ! -L "$T3B_SHARED_RATES" ] && [ ! -L "$(dirname "$T3B_SHARED_RATES")" ] &&
      [ "$(t3b_uid "$T3B_SHARED_RATES" 2>/dev/null)" = "$T3B_OWNER" ] &&
      [ "$(t3b_uid "$(dirname "$T3B_SHARED_RATES")" 2>/dev/null)" = "$T3B_OWNER" ]; then
      case "$(t3b_mode "$(dirname "$T3B_SHARED_RATES")" 2>/dev/null)" in
        *[2367]? | *[2367]) ;;
        *)
          if ! cmp -s "$T3B_SHARED_RATES" "$T3B_RATES"; then
            mkdir -p "$T3B_HOME/userdata" && cp "$T3B_SHARED_RATES" "$T3B_RATES.$$" && mv -f "$T3B_RATES.$$" "$T3B_RATES" || rm -f "$T3B_RATES.$$"
          fi
          ;;
      esac
    fi
    ;;
esac

T3B_ENV_FILE="$T3B_HOME/server.env"
if [ -e "$T3B_ENV_FILE" ] || [ -L "$T3B_ENV_FILE" ]; then
  # Provider tokens (CLAUDE_CODE_OAUTH_TOKEN, ...) for SSH sessions, which can't
  # unlock the login Keychain. Sourced as shell, so it and its folder must be
  # yours alone: no other owner, no permission bits for anyone else, and no ACL
  # entries (mode bits don't show those; they're removed here).
  if [ -L "$T3B_ENV_FILE" ] || [ ! -f "$T3B_ENV_FILE" ] || [ -L "$HOME/.blacksand" ] || [ -L "$T3B_HOME" ] || [ ! -O "$T3B_ENV_FILE" ] || [ ! -O "$T3B_HOME" ] ||
    ! t3b_drop_acl "$T3B_HOME" || ! t3b_drop_acl "$T3B_ENV_FILE" || ! t3b_private "$T3B_HOME" || ! t3b_private "$T3B_ENV_FILE"; then
    printf '%s must belong to you and be readable only by you (chmod 700 %s; chmod 600 %s).\\n' "$T3B_ENV_FILE" "$T3B_HOME" "$T3B_ENV_FILE" >&2
    exit 1
  fi
  set -a
  . "$T3B_ENV_FILE"
  set +a
fi
export ELECTRON_RUN_AS_NODE=1
export T3CODE_HOME="$T3B_HOME"
# The host may be a build ahead of or behind this desktop ($T3_ARCHIVE_VERSION)
# while the machines follow pin.json at their own pace; the client's protocol
# check (orchestrationProtocolVersion) refuses only versions that can't talk.
exec "$T3B_ELECTRON" "$T3B_SERVER" "$@"
