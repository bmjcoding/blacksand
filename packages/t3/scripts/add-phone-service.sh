#!/usr/bin/env bash
# Lets your phone reach one agent account's T3 Blackout server over Tailscale,
# with no relay (docs/remote-access/phone.md). Run on the always-on host, with sudo,
# from the admin account, after scripts/add-agent-account.sh made the account:
#
#   sudo scripts/add-phone-service.sh agent-claude                  # install, or put back
#   sudo scripts/add-phone-service.sh agent-claude --pair           # a one-time pairing code
#   sudo scripts/add-phone-service.sh agent-claude --remove
#   scripts/add-phone-service.sh --print-policy [--https-port 443]  # the Tailscale grant (no sudo)
#
# What it sets up:
#   - A launchd job, dev.t3blackout.phone.<account>, that runs the account's
#     server at boot, logged in or not, as that account, on 127.0.0.1:<port>
#     only (scripts/phone-server.sh, installed root-owned). The desktop's SSH
#     connection to the account finds that server and shares it: the same threads
#     on the desktop and the phone. An update restarts it on the new build.
#   - Tailscale Serve, configured here by the admin (never by the agent account,
#     which gets no Tailscale rights): https://<host>.<tailnet>.ts.net[:port] →
#     http://127.0.0.1:<port>. Tailnet-only: it refuses to touch a node with
#     Funnel on, and never replaces another Serve mapping. Tailscale's policy
#     decides which devices reach it (--print-policy); the server still requires
#     its own pairing, and --pair makes a one-time code that expires in minutes.
#
# Options:
#   --port N          the server's loopback port (default: 4773, or the next free
#                     one; never 3773-3972, where SSH connections start servers)
#   --https-port N    the tailnet HTTPS port Serve listens on (default 443; give each
#                     account its own, e.g. 8443 for a second one)
#   --no-serve        leave Tailscale Serve alone (configure it later with the
#                     command this prints)
#   --pair            print a one-time pairing link and code for the phone
#   --ttl 5m          how long that code stays valid (1m to 60m; default 5m)
#   --remove          stop and remove the job, and this account's Serve mapping
#   --print-policy    print the Tailscale policy grant and tests for the phone
#   --host-tag T, --desktop-tag T, --phone-tag T
#                     tag names for --print-policy (default: the guide's
#                     tag:t3b-host, tag:t3b-desktop, tag:t3b-phone)

set -euo pipefail

APP="/Applications/T3 Blackout.app"
ELECTRON="$APP/Contents/MacOS/T3 Blackout"
ASAR="$APP/Contents/Resources/app.asar"
SERVER="$ASAR/apps/server/dist/bin.mjs"
AGENT_GROUP=t3blackout-agents
HELPER_DIR=/usr/local/libexec/t3blackout
WRAPPER=$HELPER_DIR/phone-server
LABEL_PREFIX=dev.t3blackout.phone
PLIST_DIR=/Library/LaunchDaemons
FIRST_PORT=4773
# Where the desktop's SSH connections pick a port (upstream's DEFAULT_REMOTE_PORT
# and REMOTE_PORT_SCAN_WINDOW): a fixed port there could be taken while the job
# restarts.
SSH_PORTS_FROM=3773
SSH_PORTS_TO=3972
HOST_TAG=tag:t3b-host
DESKTOP_TAG=tag:t3b-desktop
PHONE_TAG=tag:t3b-phone

# Output, launchd jobs, tag names, and Tailscale: tailnet_name,
# forwarding_problem and atomic Serve changes, all through tailscaled's LocalAPI
# with deadlines (shared with scripts/enable-screen-sharing.sh).
# shellcheck source=scripts/host-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host-common.sh"

# From /: the folder sudo was run in (your clone, in your home) is one the account can't open.
as_user() {
  local user="$1"
  shift
  (cd / && sudo -u "$user" -H -- "$@")
}
home_of() { dscl . -read "/Users/$1" NFSHomeDirectory | awk '{print $2}'; }
label_of() { echo "$LABEL_PREFIX.$1"; }
plist_of() { echo "$PLIST_DIR/$(label_of "$1").plist"; }

# ----------------------------------------------------------------- policy --

# The grant and tests to add to the tailnet policy file: the phone's tag may
# open this one HTTPS port on the host, and nothing else; nothing else may open
# it. Merge them into the policy (section 2.1 of the guide); with a second
# account, add its port to the same grant.
print_policy() {
  local port="$1" deny=() candidate
  # What the phone's tag must not reach on the host; never the port it may (a
  # test that accepts and denies one port would be refused by the console).
  for candidate in 22 2222 "$FIRST_PORT" 5900; do [[ "$candidate" == "$port" ]] || deny+=("\"$HOST_TAG:$candidate\""); done
  deny+=("\"$DESKTOP_TAG:22\"" "\"$DESKTOP_TAG:$port\"")
  cat <<EOF
{
  // T3 Blackout phone access (scripts/add-phone-service.sh): tag the phone
  // $PHONE_TAG in the admin console (Machines → … → Edit ACL tags).
  "tagOwners": {
    "$PHONE_TAG": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["$PHONE_TAG"], "dst": ["$HOST_TAG"], "ip": ["tcp:$port"] }
  ],
  "tests": [
    { "src": "$PHONE_TAG", "proto": "tcp", "accept": ["$HOST_TAG:$port"], "deny": [$(IFS=,; echo "${deny[*]}" | sed 's/,/, /g')] },
    { "src": "$PHONE_TAG", "proto": "udp", "deny": ["$HOST_TAG:$port", "$HOST_TAG:5900"] },
    { "src": "$DESKTOP_TAG", "proto": "tcp", "deny": ["$HOST_TAG:$port"] },
    { "src": "$HOST_TAG", "deny": ["$PHONE_TAG:22", "$PHONE_TAG:$port"] }
  ]
}
EOF
}

# --------------------------------------------------------------- tailscale --

# Tailscale Serve takes its port on this Mac's tailnet addresses inside
# tailscaled, ahead of the kernel: an HTTPS mapping on 22 would swallow the
# desktop's SSH to this Mac. Why HTTPS port $1 mustn't be Serve's, or nothing:
# SSH's 22, the standby lane's 2222, Screen Sharing's 5900 and Remote
# Management's 3283, and (with "listening") any port something other than
# tailscaled listens on here.
https_port_problem() {
  local port="$1" lines
  # Canonical decimal before anything reads it as a number: Tailscale decodes 022
  # as 22, and bash's arithmetic would take it as octal.
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && ((port <= 65535)) || { echo "$port isn't a port (1 to 65535, written without leading zeros)"; return 0; }
  case "$port" in
    22) echo "22 is SSH's: Serve on it would take the desktop's SSH to this Mac"; return 0 ;;
    2222) echo "2222 is the standby lane's SSH"; return 0 ;;
    5900) echo "5900 is Screen Sharing's (scripts/enable-screen-sharing.sh)"; return 0 ;;
    3283) echo "3283 is Remote Management's"; return 0 ;;
  esac
  if [[ "${2:-}" == listening ]]; then
    lines="$({ lsof +c 0 -nP -iTCP:"$port" -sTCP:LISTEN -F cn 2>/dev/null || true; } |
      awk '/^c/ { command = substr($0, 2) } /^n/ { print command, substr($0, 2) }' | grep -v '^tailscaled ' || true)"
    [[ -z "$lines" ]] || { echo "$(head -n 1 <<<"$lines" | awk '{print $1 " listens on " $2}'): Serve on $port would take it over on the tailnet"; return 0; }
  fi
  return 1
}

https_url() {
  local dns="$1" port="$2"
  if [[ "$port" == 443 ]]; then echo "https://$dns"; else echo "https://$dns:$port"; fi
}

# The HTTPS port: --https-port's; else the one Serve already maps to this
# account's server (a rerun keeps it); else 443, if nothing else listens there.
https_port_for() {
  local found why
  if ((!HTTPS_PORT_GIVEN)); then
    found="$(serve_port_of web "http://127.0.0.1:$PORT")" || die "couldn't read Tailscale Serve's configuration from tailscaled ($TS_SOCKET, ${TS_TIMEOUT}s)"
    if [[ -n $found ]]; then HTTPS_PORT="$found"; return 0; fi
  fi
  if why="$(https_port_problem "$HTTPS_PORT" listening)"; then die "HTTPS port $HTTPS_PORT: $why; pick another with --https-port"; fi
}

# Serve for this account: https://<this Mac's name>[:port] → its server. Added when
# the port is free, left when it's already this account's, refused otherwise.
configure_serve() {
  local dns problem target="http://127.0.0.1:$PORT"
  if ! tailscaled_up || ! dns="$(tailnet_name https)"; then
    warn "Tailscale Serve is not configured; when Tailscale is ready, rerun this script. The server runs on 127.0.0.1:$PORT for the desktop meanwhile."
    return 0
  fi
  # Checked before the install too; again here, just before the write.
  if problem="$(forwarding_problem)"; then die "$problem. Not adding the Serve mapping; the server runs on 127.0.0.1:$PORT for the desktop only."; fi
  # A rerun keeps the port this account already has.
  https_port_for
  serve_add web "$dns:$HTTPS_PORT" "$target"
  SERVE_URL="$(https_url "$dns" "$HTTPS_PORT")"
  say "Tailscale Serve: $SERVE_URL → $target (tailnet only)"
}

# This account's Serve mappings removed, on whatever HTTPS port, and nothing
# left that may reach its server's port, read back (serve_remove); or a die
# that leaves the job and its plist: while a handler may still forward to the
# server's port, that port mustn't be freed, and the plist is the only record
# of it. So without tailscaled answering, removal stops here.
remove_serve() {
  tailscaled_up || die "tailscaled isn't running, so whether Tailscale Serve still forwards to $NAME's server (127.0.0.1:$PORT) can't be checked; nothing was removed: start it, then rerun"
  serve_remove "" "$PORT"
}

# --------------------------------------------------------------------- job --

render_plist() {
  local shell
  shell="$(dscl . -read "/Users/$NAME" UserShell 2>/dev/null | awk '{print $2}')"
  [[ -n "$shell" ]] || shell=/bin/zsh
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(label_of "$NAME")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$WRAPPER</string>
    <string>$PORT</string>
  </array>
  <key>UserName</key>
  <string>$NAME</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>InitGroups</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME_DIR</string>
    <key>USER</key>
    <string>$NAME</string>
    <key>LOGNAME</key>
    <string>$NAME</string>
    <key>SHELL</key>
    <string>$shell</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME_DIR</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
EOF
}

# The loopback port every other phone job uses, one per line.
ports_in_use() {
  local plist
  for plist in "$PLIST_DIR/$LABEL_PREFIX".*.plist; do
    [[ -f "$plist" && "$plist" != "$(plist_of "$NAME")" ]] || continue
    /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$plist" 2>/dev/null || true
  done
}

port_problem() {
  local port="$1"
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && ((port >= 1024 && port <= 65535)) || { echo "$port isn't a port from 1024 to 65535 (written without leading zeros)"; return 0; }
  if ((port >= SSH_PORTS_FROM && port <= SSH_PORTS_TO)); then
    echo "$port is in $SSH_PORTS_FROM-$SSH_PORTS_TO, where SSH connections start servers"
    return 0
  fi
  if ports_in_use | grep -qx "$port"; then
    echo "another account's phone job uses $port"
    return 0
  fi
  return 1
}

# The server's port. An installed job keeps its own: its plist is the only
# record of the port Serve may forward to (remove reads it), so a different one
# is refused before anything changes, never put in its place. Moving it is
# --remove, then an install on the new port.
choose_port() {
  local port old=""
  if [[ -f "$(plist_of "$NAME")" ]]; then
    old="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$(plist_of "$NAME")" 2>/dev/null)" && [[ "$old" =~ ^[1-9][0-9]{3,4}$ ]] ||
      die "can't read $NAME's server port from $(plist_of "$NAME"); nothing was changed"
    [[ -z "$PORT" || "$PORT" == "$old" ]] ||
      die "$NAME's phone service runs on port $old: remove the service first (sudo $0 $NAME --remove), then add it on the new port. Nothing was changed."
    if port="$(port_problem "$old")"; then die "$NAME's phone service's port: $port; remove the service first (sudo $0 $NAME --remove), then add it again. Nothing was changed."; fi
    PORT="$old"
    return 0
  fi
  if [[ -n "$PORT" ]]; then
    if port="$(port_problem "$PORT")"; then die "--port: $port"; fi
    return 0
  fi
  for ((port = FIRST_PORT; port < FIRST_PORT + 100; port++)); do
    # Free: no rule against it, and nobody listening (listener_on prints nothing then).
    if ! port_problem "$port" >/dev/null && [[ -z "$(listener_on "$port")" ]]; then
      PORT="$port"
      return 0
    fi
  done
  die "no free port from $FIRST_PORT; pass --port"
}

# Who listens on TCP $1, as "user address" lines; nothing (status 0) when no one
# does yet: lsof's status 1 for that isn't a failure here.
listener_on() {
  { lsof -nP -iTCP:"$1" -sTCP:LISTEN -F Ln 2>/dev/null || true; } | awk '/^L/ {user = substr($0, 2)} /^n/ {print user, substr($0, 2)}' | sort -u
}

# A server this account runs holds its ~/.t3blackout; the job's couldn't start
# beside it. Its desktop connection reconnects to the job's.
stop_ssh_servers() {
  local pids pid i stopped=0
  pids="$(pgrep -U "$NAME" -f 'app\.asar/apps/server/dist/bin\.mjs serve' || true)"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
    stopped=$((stopped + 1))
  done
  ((stopped)) || return 0
  for i in $(seq 1 50); do
    pgrep -U "$NAME" -f 'app\.asar/apps/server/dist/bin\.mjs serve' >/dev/null || break
    [[ $i == 50 ]] || sleep 0.2
  done
  for pid in $(pgrep -U "$NAME" -f 'app\.asar/apps/server/dist/bin\.mjs serve' || true); do kill -9 "$pid" 2>/dev/null || true; done
  say "Stopped $stopped server(s) $NAME was running (a desktop's SSH connection reconnects to the new one)"
}

install_wrapper() {
  local here dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for dir in "${HELPER_DIR%/*/*}" "${HELPER_DIR%/*}" "$HELPER_DIR"; do
    [[ -d $dir ]] || install -d -o root -g wheel -m 755 "$dir"
  done
  install -o root -g wheel -m 755 "$here/phone-server.sh" "$WRAPPER"
}

install_job() {
  local label out
  label="$(label_of "$NAME")"
  write_plist "$(plist_of "$NAME")" render_plist
  # A rerun: the old job must be gone from launchd before the new one loads.
  out="$(job_unload "$label")" || die "$out"
  stop_ssh_servers
  out="$(job_load "$label" "$(plist_of "$NAME")")" || die "$out"
}

# Up to 90 s for the server (a first start migrates its database): listening as
# the account, and on 127.0.0.1 only.
verify_listener() {
  local i listeners line
  for i in $(seq 1 90); do
    listeners="$(listener_on "$PORT")"
    [[ -n "$listeners" ]] && break
    [[ $i == 90 ]] || sleep 1
  done
  [[ -n "$listeners" ]] || die "nothing listens on port $PORT after 90 s; see $HOME_DIR/.t3blackout/phone/server.log (sudo -u $NAME tail -n 50 …)"
  while IFS= read -r line; do
    [[ "$line" == "$NAME 127.0.0.1:$PORT" ]] ||
      die "port $PORT has a listener that isn't $NAME's on 127.0.0.1 only ($line); stop the job: sudo launchctl bootout system/$(label_of "$NAME")"
  done <<<"$listeners"
  say "$NAME's server listens on 127.0.0.1:$PORT (launchd job $(label_of "$NAME"))"
}

# ----------------------------------------------------------------- pairing --

pair() {
  local dns url found
  [[ -f "$(plist_of "$NAME")" ]] || die "$NAME has no phone job yet: sudo $0 $NAME"
  PORT="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$(plist_of "$NAME")")"
  tailscaled_up || die "tailscaled isn't running here ($TS_SOCKET)"
  dns="$(tailnet_name https)" || die "Tailscale isn't ready for HTTPS (above)"
  found="$(serve_port_of web "http://127.0.0.1:$PORT")" || die "couldn't read Tailscale Serve's configuration from tailscaled ($TS_SOCKET, ${TS_TIMEOUT}s)"
  [[ -n $found ]] || die "Tailscale Serve doesn't reach $NAME's server; rerun without --pair"
  url="$(https_url "$dns" "$found")"
  say "One-time pairing for $NAME, valid $TTL. On the phone: Add environment → Address ${url#https://}, then the code below (or open the link)."
  # As the account, with nothing of yours in its environment. The code goes to
  # this terminal only: not to a file, a log or a command line.
  as_user "$NAME" /usr/bin/env -i HOME="$HOME_DIR" USER="$NAME" LOGNAME="$NAME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    ELECTRON_RUN_AS_NODE=1 T3CODE_HOME="$HOME_DIR/.t3blackout" \
    "$ELECTRON" "$SERVER" auth pairing create --base-dir "$HOME_DIR/.t3blackout" --ttl "$TTL" --label phone --base-url "$url"
  cat <<EOF

Sessions it creates: Settings → Sharing & access → Authorized clients (in the
desktop, on this environment) lists and revokes them. A lost phone: revoke it
there, and remove the device in Tailscale's admin console.
EOF
}

# Serve's mapping first, read back, while the plist still names the port it goes
# to; only then the job and its plist. A failure on the way leaves the plist,
# and a rerun finishes the job.
remove() {
  local label others out
  label="$(label_of "$NAME")"
  if [[ -f "$(plist_of "$NAME")" ]]; then
    PORT="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$(plist_of "$NAME")" 2>/dev/null)" && [[ "$PORT" =~ ^[1-9][0-9]{3,4}$ ]] ||
      die "can't read $NAME's server port from $(plist_of "$NAME"); nothing was removed"
    remove_serve
  fi
  out="$(job_unload "$label")" || die "$out"
  rm -f "$(plist_of "$NAME")"
  others="$(find "$PLIST_DIR" -maxdepth 1 -name "$LABEL_PREFIX.*.plist" | head -n 1)"
  [[ -n "$others" ]] || rm -f "$WRAPPER"
  say "Removed $NAME's phone job; the desktop starts its server again over SSH when it connects"
}

# Why the installed app can't run the server, or nothing. app.asar is a packed
# archive, a regular file: only Electron reads the server entry inside it, so
# that's asked of the app itself, as the account, with a clean environment.
app_problem() {
  local out
  [[ -x "$ELECTRON" && -f "$ASAR" && ! -L "$ASAR" ]] || { echo "$APP is missing; run ./install.sh --role host first"; return 0; }
  out="$(as_user "$NAME" /usr/bin/env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 \
    "$ELECTRON" -e 'require("fs").statSync(process.argv[1]).isFile() || process.exit(3)' "$SERVER" 2>&1)" ||
    { echo "$APP has no server inside $ASAR ($out); reinstall it: ./install.sh --role host"; return 0; }
  return 1
}

# Before anything changes, when Serve is to be set ($1: 1 for --no-serve): no
# Serve mapping while the local network could reach Serve's listeners, so
# nothing else either; and a given --https-port nothing else listens on.
preflight_serve() {
  local why
  (($1)) && return 0
  if why="$(forwarding_problem)"; then
    die "$why. Turn off what turned it on (System Settings → General → Sharing → Internet Sharing, or VM software), then rerun; or pass --no-serve for the desktop only. Nothing was changed."
  fi
  if ((HTTPS_PORT_GIVEN)) && why="$(https_port_problem "$HTTPS_PORT" listening)"; then die "--https-port $HTTPS_PORT: $why. Nothing was changed."; fi
}

# --------------------------------------------------------------------- main --

main() {
  local mode=install no_serve=0 why
  NAME=""
  PORT=""
  HTTPS_PORT=443
  HTTPS_PORT_GIVEN=0
  TTL=5m
  SERVE_URL=""
  while (($#)); do
    case "$1" in
      --port) PORT="${2:-}"; shift 2 ;;
      --https-port) HTTPS_PORT="${2:-}"; HTTPS_PORT_GIVEN=1; shift 2 ;;
      --no-serve) no_serve=1; shift ;;
      --pair) mode=pair; shift ;;
      --ttl) TTL="${2:-}"; shift 2 ;;
      --remove) mode=remove; shift ;;
      --print-policy) mode=policy; shift ;;
      --host-tag) HOST_TAG="${2:-}"; shift 2 ;;
      --desktop-tag) DESKTOP_TAG="${2:-}"; shift 2 ;;
      --phone-tag) PHONE_TAG="${2:-}"; shift 2 ;;
      -*) die "unknown option $1" ;;
      *) [[ -z "$NAME" ]] || die "one account at a time"; NAME="$1"; shift ;;
    esac
  done
  if why="$(https_port_problem "$HTTPS_PORT")"; then die "--https-port $HTTPS_PORT: $why"; fi
  check_tags "$HOST_TAG" "$DESKTOP_TAG" "$PHONE_TAG"
  if [[ "$mode" == policy ]]; then
    print_policy "$HTTPS_PORT"
    return 0
  fi

  [[ "$(uname -s)" == Darwin ]] || die "macOS only"
  [[ $EUID -eq 0 ]] || die "run with sudo: sudo $0 $*"
  [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] || die "run with sudo from your admin account, not as root"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "usage: sudo $0 <agent account> [--port N] [--https-port N] [--no-serve | --pair [--ttl 5m] | --remove]"
  [[ "$TTL" =~ ^([1-9]|[1-5][0-9]|60)m$ ]] || die "--ttl: 1m to 60m"
  if [[ "$mode" == remove ]]; then
    remove
    return 0
  fi
  id "$NAME" >/dev/null 2>&1 || die "no account $NAME; make it with scripts/add-agent-account.sh first"
  dseditgroup -o checkmember -m "$NAME" "$AGENT_GROUP" >/dev/null 2>&1 || die "$NAME isn't in $AGENT_GROUP; only agent accounts (scripts/add-agent-account.sh) get a phone job"
  if dseditgroup -o checkmember -m "$NAME" admin >/dev/null 2>&1; then die "$NAME is an admin"; fi
  HOME_DIR="$(home_of "$NAME")"
  [[ "$HOME_DIR" == "/Users/$NAME" && -d "$HOME_DIR" && ! -L "$HOME_DIR" && "$(stat -f '%u' "$HOME_DIR")" == "$(id -u "$NAME")" ]] ||
    die "$NAME's home isn't /Users/$NAME owned by it; rerun scripts/add-agent-account.sh $NAME"
  if why="$(app_problem)"; then die "$why"; fi
  if [[ "$mode" == pair ]]; then
    pair
    return 0
  fi

  preflight_serve "$no_serve"
  choose_port
  install_wrapper
  install_job
  verify_listener
  if ((no_serve)); then
    say "Tailscale Serve left alone (--no-serve); when you want it: sudo tailscale serve --bg --https=$HTTPS_PORT http://127.0.0.1:$PORT"
  else
    configure_serve
  fi
  cat <<EOF

Done. Next:
  1. Tailscale policy (admin console → Access controls): merge in
       scripts/add-phone-service.sh --print-policy --https-port $HTTPS_PORT
     and tag the phone ${PHONE_TAG} (Machines → … → Edit ACL tags). Funnel stays off.
  2. Pair the phone: sudo $0 $NAME --pair${SERVE_URL:+   (address ${SERVE_URL#https://})}
     or, in the desktop on this environment: Settings → Sharing & access → Create link.
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
