#!/bin/sh
# Blacksand T3: one agent account's long-running server, for the phone
# (tooling/t3code/docs/remote-access/phone.md). scripts/add-phone-service.sh installs a root-owned
# copy as /usr/local/libexec/blacksand/phone-server and a launchd job that runs
# it as the account, at boot, logged in or not:
#
#   phone-server <port>
#
# It runs the installed app's server the way the desktop's SSH runner does
# (lib/files/ssh-runner-blacksand.sh): 127.0.0.1:<port>, the account's
# ~/.blacksand/t3, its server.env. A desktop connecting over SSH finds it there and
# shares it, so the phone and the desktop see the same threads. Tailscale Serve
# (configured by the admin, never this account) is what the phone reaches.
#
# It keeps the files the SSH runner reads: a record per server in
# ~/.blacksand/t3/ssh-servers/<pid>, which a connection uses to stop a server whose
# build was replaced, and its own state in ~/.blacksand/t3/ssh-servers/daemon,
# which a connection waits on instead of starting a second server. When an
# update replaces the app, it restarts the server on the new build within
# seconds (a turn in progress stops, as when the app quits).
#
# Output goes to ~/.blacksand/t3/phone/server.log (and server.log.1: about 5 MB
# each, rotated as it runs), readable by this account only: the server prints
# a one-time pairing link there each time it starts.

set -u
umask 077

PORT="${1:-}"
case "$PORT" in
  "" | 0* | *[!0-9]*) echo "usage: phone-server <port> (decimal, no leading zeros)" >&2; exit 64 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "phone-server: port $PORT is outside 1024-65535" >&2
  exit 64
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "phone-server runs as an agent account, never as root" >&2
  exit 64
fi

# Before the log is open, problems go to the system log (log show --predicate 'senderImagePath ENDSWITH "logger"').
early() {
  logger -t dev.blacksand.phone "$(id -un): $*" 2>/dev/null || true
  echo "phone-server: $*" >&2
  # A setup problem doesn't fix itself: once a minute, not every 10 s.
  sleep 60
  exit 1
}

T3B_USER="$(id -un)"
# Owned by this account (test -O isn't POSIX).
t3b_mine() { [ "$(stat -f '%u' "$1" 2>/dev/null)" = "$(id -u)" ]; }
# The job sets HOME (/Users/<account>); it must be this account's own folder.
[ -n "${HOME:-}" ] && [ -d "$HOME" ] && [ ! -L "$HOME" ] && t3b_mine "$HOME" ||
  early "HOME is ${HOME:-unset}, not a folder $T3B_USER owns"
T3B_HOME="$HOME/.blacksand/t3"
T3B_LOGDIR="$T3B_HOME/phone"
T3B_LOG="$T3B_LOGDIR/server.log"
T3B_SERVERS="$T3B_HOME/ssh-servers"
for T3B_DIR in "$HOME/.blacksand" "$T3B_HOME" "$T3B_LOGDIR" "$T3B_SERVERS"; do
  [ ! -L "$T3B_DIR" ] || early "$T3B_DIR is a symlink"
  mkdir -p "$T3B_DIR" && chmod 700 "$T3B_DIR" || early "can't make $T3B_DIR"
done
# The log. What this supervisor and its servers print goes through a pipe to a
# writer that appends it line by line, reopening the file for each, and keeps at
# most two files of about 5 MB (BLACKSAND_T3_PHONE_LOG_MAX bytes): server.log,
# then server.log.1. So a rotation takes effect at once, however long a server
# runs, and every file is created under this script's umask 077.
T3B_LOG_MAX="${BLACKSAND_T3_PHONE_LOG_MAX:-5000000}"
case "$T3B_LOG_MAX" in
  "" | *[!0-9]*) T3B_LOG_MAX=5000000 ;;
esac
T3B_PIPE="$T3B_LOGDIR/.log.pipe"
for T3B_FILE in "$T3B_LOG" "$T3B_LOG.1" "$T3B_PIPE"; do
  [ ! -L "$T3B_FILE" ] || early "$T3B_FILE is a symlink"
done
rm -f "$T3B_PIPE"
mkfifo -m 600 "$T3B_PIPE" || early "can't make $T3B_PIPE"
t3b_log_writer() {
  T3B_BYTES="$(stat -f '%z' "$T3B_LOG" 2>/dev/null || echo 0)"
  while IFS= read -r T3B_LINE || [ -n "$T3B_LINE" ]; do
    if [ "$T3B_BYTES" -ge "$T3B_LOG_MAX" ]; then
      mv -f "$T3B_LOG" "$T3B_LOG.1" 2>/dev/null || true
      T3B_BYTES=0
    fi
    printf '%s\n' "$T3B_LINE" >>"$T3B_LOG"
    T3B_BYTES=$((T3B_BYTES + ${#T3B_LINE} + 1))
  done
}
t3b_log_writer <"$T3B_PIPE" >/dev/null 2>&1 &
exec >"$T3B_PIPE" 2>&1 </dev/null
# Both ends are open now; nothing else needs its name.
rm -f "$T3B_PIPE"
chmod 600 "$T3B_LOG" "$T3B_LOG.1" 2>/dev/null || true
say() { printf '%s phone-server: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Only the app the admin installed; BLACKSAND_T3_APP is for the tests (launchd's
# job sets no such variable, and this account can't edit the job).
T3B_APP="${BLACKSAND_T3_APP:-/Applications/T3 Code (blacksand).app}"
T3B_ELECTRON="$T3B_APP/Contents/MacOS/T3 Code (blacksand)"
T3B_ASAR="$T3B_APP/Contents/Resources/app.asar"
T3B_SERVER="$T3B_ASAR/apps/server/dist/bin.mjs"
T3B_ENV_FILE="$T3B_HOME/server.env"
T3B_RUNTIME="$T3B_HOME/userdata/server-runtime.json"
# What ps shows for the server, and what its record names (as the SSH runner writes them).
T3B_EXPECTED="$T3B_ELECTRON $T3B_SERVER serve --host 127.0.0.1 --port $PORT --base-dir $T3B_HOME"
# The server's exit status when another server already holds this home
# (upstream's SERVER_EXIT_CODE_STATE_DIR_OWNED).
T3B_OWNED=78

# The same metadata as the SSH runner reads, from BSD stat and ps.
t3b_build() { stat -f '%d:%i:%m:%z' "$T3B_ASAR" 2>/dev/null || true; }
t3b_started() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | awk '{ $1 = $1; print }'; }
t3b_args() { LC_ALL=C ps -ww -o args= -p "$1" 2>/dev/null; }
t3b_alive() {
  case "$(ps -o stat= -p "$1" 2>/dev/null || true)" in
    "" | *Z*) return 1 ;;
  esac
}
t3b_private() {
  case "$(stat -f '%Lp' "$1" 2>/dev/null)" in
    *00) return 0 ;;
    *) return 1 ;;
  esac
}

T3B_SELF_STARTED="$(t3b_started $$)"
T3B_SELF_ARGS="$(t3b_args $$)"
T3B_CHILD=""
T3B_CHILD_BUILD=""
# This supervisor's state for the SSH runner (t3b_daemon_settled), written whole.
t3b_state() {
  printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$$" "$T3B_SELF_STARTED" "$T3B_SELF_ARGS" "$1" "$T3B_CHILD" "$T3B_CHILD_BUILD" >"$T3B_SERVERS/.daemon.$$" &&
    mv -f "$T3B_SERVERS/.daemon.$$" "$T3B_SERVERS/daemon"
}

# The token file the SSH runner sources, under its rules: yours alone, no ACL entries.
t3b_env_ok() {
  [ -e "$T3B_ENV_FILE" ] || [ -L "$T3B_ENV_FILE" ] || return 0
  [ ! -L "$T3B_ENV_FILE" ] && [ -f "$T3B_ENV_FILE" ] && t3b_mine "$T3B_ENV_FILE" && t3b_mine "$T3B_HOME" &&
    chmod -N "$T3B_HOME" && chmod -N "$T3B_ENV_FILE" && t3b_private "$T3B_HOME" && t3b_private "$T3B_ENV_FILE"
}

# The pricing table the updater publishes, as the SSH runner copies it: only
# from the account that installed the app, in a folder no one else can write.
t3b_copy_rates() {
  T3B_SHARED_RATES="/Users/Shared/blacksand/usage-model-rates.json"
  T3B_SHARED_DIR="${T3B_SHARED_RATES%/*}"
  T3B_RATES="$T3B_HOME/userdata/usage-model-rates.json"
  T3B_OWNER="$(stat -f '%u' "$T3B_APP" 2>/dev/null || echo none)"
  [ -f "$T3B_SHARED_RATES" ] && [ ! -L "$T3B_SHARED_RATES" ] && [ ! -L "$T3B_SHARED_DIR" ] || return 0
  [ "$(stat -f '%u' "$T3B_SHARED_RATES")" = "$T3B_OWNER" ] && [ "$(stat -f '%u' "$T3B_SHARED_DIR")" = "$T3B_OWNER" ] || return 0
  case "$(stat -f '%Lp' "$T3B_SHARED_DIR")" in
    *[2367]? | *[2367]) return 0 ;;
  esac
  cmp -s "$T3B_SHARED_RATES" "$T3B_RATES" && return 0
  mkdir -p "$T3B_HOME/userdata" && cp "$T3B_SHARED_RATES" "$T3B_RATES.$$" && mv -f "$T3B_RATES.$$" "$T3B_RATES" || rm -f "$T3B_RATES.$$"
}

# SIGTERM, 12 s to exit (launchd allows the job 20), then SIGKILL.
t3b_stop_child() {
  [ -n "$T3B_CHILD" ] || return 0
  kill "$T3B_CHILD" 2>/dev/null || true
  T3B_WAIT=0
  while t3b_alive "$T3B_CHILD" && [ "$T3B_WAIT" -lt 60 ]; do
    T3B_WAIT=$((T3B_WAIT + 1))
    sleep 0.2
  done
  if t3b_alive "$T3B_CHILD"; then kill -s KILL "$T3B_CHILD" 2>/dev/null || true; fi
}

t3b_shutdown() {
  say "stopping (launchd)"
  t3b_stop_child
  [ -z "$T3B_CHILD" ] || rm -f "$T3B_SERVERS/$T3B_CHILD"
  rm -f "$T3B_SERVERS/daemon"
  exit 0
}
trap t3b_shutdown TERM INT HUP

t3b_start() {
  T3B_CHILD_BUILD="$(t3b_build)"
  (
    if [ -e "$T3B_ENV_FILE" ]; then
      set -a
      # shellcheck disable=SC1090 # the account's own token file, checked by t3b_env_ok
      . "$T3B_ENV_FILE"
      set +a
    fi
    ELECTRON_RUN_AS_NODE=1 T3CODE_HOME="$T3B_HOME" T3CODE_NO_BROWSER=1
    export ELECTRON_RUN_AS_NODE T3CODE_HOME T3CODE_NO_BROWSER
    exec "$T3B_ELECTRON" "$T3B_SERVER" serve --host 127.0.0.1 --port "$PORT" --base-dir "$T3B_HOME"
  ) &
  T3B_CHILD=$!
  t3b_state starting
  # Its record, once the exec has made the child the server (up to 10 s).
  T3B_WAIT=0
  while [ "$(t3b_args "$T3B_CHILD")" != "$T3B_EXPECTED" ] && t3b_alive "$T3B_CHILD" && [ "$T3B_WAIT" -lt 100 ]; do
    T3B_WAIT=$((T3B_WAIT + 1))
    sleep 0.1
  done
  if [ "$(t3b_args "$T3B_CHILD")" = "$T3B_EXPECTED" ]; then
    printf '%s\n%s\n%s\n\n' "$(t3b_started "$T3B_CHILD")" "$T3B_CHILD_BUILD" "$T3B_EXPECTED" >"$T3B_SERVERS/.$T3B_CHILD" &&
      mv -f "$T3B_SERVERS/.$T3B_CHILD" "$T3B_SERVERS/$T3B_CHILD"
  elif t3b_alive "$T3B_CHILD"; then
    say "the server's command line isn't what was started ($(t3b_args "$T3B_CHILD")); it has no record"
  fi
}

say "starting for $T3B_USER on 127.0.0.1:$PORT"
T3B_QUICK_EXITS=0
while :; do
  T3B_WAIT=0
  # The app's archive itself: a packed app.asar is a regular file, and only
  # Electron reads the server inside it (a broken one exits, and shows in the log).
  while [ ! -x "$T3B_ELECTRON" ] || { [ ! -f "$T3B_ASAR" ] && [ ! -d "$T3B_ASAR" ]; } || [ -z "$(t3b_build)" ]; do
    # An update swapping the app, or none installed yet.
    [ "$T3B_WAIT" -ne 30 ] || say "waiting for $T3B_APP"
    T3B_WAIT=$((T3B_WAIT + 1))
    sleep 2
  done
  t3b_env_ok || early "$T3B_ENV_FILE must belong to $T3B_USER and be readable only by it (chmod 700 $T3B_HOME; chmod 600 $T3B_ENV_FILE)"
  t3b_copy_rates
  T3B_SINCE="$(date +%s)"
  t3b_start
  T3B_REPLACED=0
  T3B_READY=0
  while t3b_alive "$T3B_CHILD"; do
    if [ "$T3B_READY" -eq 0 ] && grep -q "\"pid\":$T3B_CHILD," "$T3B_RUNTIME" 2>/dev/null; then
      T3B_READY=1
      t3b_state running
      say "server $T3B_CHILD is ready"
    fi
    T3B_NOW="$(t3b_build)"
    if [ -n "$T3B_NOW" ] && [ "$T3B_NOW" != "$T3B_CHILD_BUILD" ]; then
      say "a new build is installed; restarting the server on it"
      T3B_REPLACED=1
      t3b_stop_child
      break
    fi
    sleep 2
  done
  wait "$T3B_CHILD"
  T3B_STATUS=$?
  rm -f "$T3B_SERVERS/$T3B_CHILD"
  T3B_CHILD=""
  if [ "$T3B_REPLACED" -eq 1 ] || [ "$(t3b_build)" != "$T3B_CHILD_BUILD" ]; then
    # Replaced (here, or by an SSH connection that found it stale): the new build now.
    T3B_QUICK_EXITS=0
    continue
  fi
  if [ "$T3B_STATUS" -eq "$T3B_OWNED" ]; then
    t3b_state blocked
    say "another server holds $T3B_HOME (one a desktop started over SSH before this job); trying again in 30 s"
    sleep 30
    continue
  fi
  if [ $(($(date +%s) - T3B_SINCE)) -lt 30 ]; then T3B_QUICK_EXITS=$((T3B_QUICK_EXITS + 1)); else T3B_QUICK_EXITS=0; fi
  if [ "$T3B_QUICK_EXITS" -ge 5 ]; then
    say "the server exited (status $T3B_STATUS) five times within 30 s of starting; leaving it to launchd"
    rm -f "$T3B_SERVERS/daemon"
    exit 1
  fi
  say "the server exited (status $T3B_STATUS); starting it again"
  sleep 2
done
